import type {
  AbortSignal as AbortLike,
  FileLike,
  FrameSink,
  MaterializedFrame,
  VideoImportProgress,
  VideoImportResult,
  VideoInspection,
  VideoMaterializer,
  VideoSelection,
} from "../index.js";
import { refusedInspection, type FromWorker, type ToWorker } from "./protocol.js";

/**
 * The primitives the decode pipeline is built on. Absent outside a secure context —
 * on `about:blank` every WebCodecs global is `undefined` — so this is a real
 * situation to refuse, not a theoretical one.
 */
function browserSupports(): boolean {
  return (
    typeof Worker === "function" &&
    typeof VideoDecoder === "function" &&
    typeof OffscreenCanvas === "function"
  );
}

/**
 * A real module artifact resolved relative to this file, never a `blob:` or `data:`
 * URL — a host's content-security policy must not be the thing that breaks import.
 * The `.js` extension names the built sibling, `dist/mediabunny/worker.js`.
 */
function spawn(): Worker {
  return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
}

/**
 * Run one request on a worker of its own and terminate it afterwards.
 *
 * Per call rather than per instance: it costs a worker start-up and removes request
 * multiplexing, a cancellation state machine and any chance of one import's messages
 * reaching another's handler.
 */
async function onWorker<T>(
  send: (worker: Worker, settle: Settle<T>) => ToWorker,
  handle: (message: FromWorker, worker: Worker, settle: Settle<T>) => void,
): Promise<T> {
  const worker = spawn();
  try {
    return await new Promise<T>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<FromWorker>) => {
        if (event.data.type === "error") {
          reject(new Error(event.data.message));
          return;
        }
        handle(event.data, worker, { resolve, reject });
      };
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage(send(worker, { resolve, reject }));
    });
  } finally {
    worker.terminate();
  }
}

interface Settle<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

/**
 * Notice an abort as soon as it happens when the signal is a real `AbortSignal`, and
 * otherwise at least at the moment of the call — core's structural `AbortSignal` only
 * promises `aborted`, so the listener is opportunistic.
 */
function onAbort(signal: AbortLike | undefined, run: () => void): () => void {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    run();
    return () => {};
  }
  const target = signal as Partial<AbortSignal>;
  if (typeof target.addEventListener !== "function") return () => {};
  target.addEventListener("abort", run, { once: true });
  return () => target.removeEventListener?.("abort", run);
}

/**
 * The one cast on this boundary. Core's `FileLike` is structural so that a browser
 * adapter can implement `VideoMaterializer` at all; what actually crosses to the
 * worker is always a real `File`, which is what structured clone and mediabunny need.
 */
function asFile(file: FileLike): File {
  return file as File;
}

/** Decodes in a module worker; nothing here touches a browser global at module scope. */
/**
 * What this adapter records as the provenance of every frame it draws.
 *
 * The version is pinned exactly in this package's `package.json` — mediabunny is
 * not a range — and the two are meant to move together: bumping the dependency
 * without bumping this would make every source registered afterwards name the
 * wrong decoder. Nothing else in the repository spells the string; the UI reads
 * `materializer.name`.
 */
export const MEDIABUNNY_MATERIALIZER = "mediabunny/1.56.1";

export class MediabunnyVideoMaterializer implements VideoMaterializer {
  readonly name = MEDIABUNNY_MATERIALIZER;

  /**
   * Rejects with `inspection aborted` whenever the signal fires, before the call or
   * during it. Reading a container is not instant — a long one is walked end to end
   * to time it — so a caller who picked the wrong file has to be able to back out.
   */
  async inspect(file: FileLike, signal?: AbortLike): Promise<VideoInspection> {
    if (!browserSupports()) return refusedInspection(file.name, "unsupported-browser");
    if (signal?.aborted === true) throw new Error("inspection aborted");
    let detach = () => {};
    try {
      return await onWorker<VideoInspection>(
        (_worker, settle) => {
          detach = onAbort(signal, () => settle.reject(new Error("inspection aborted")));
          return { type: "inspect", file: asFile(file) };
        },
        (message, _worker, settle) => {
          if (message.type === "inspection") settle.resolve(message.inspection);
        },
      );
    } finally {
      detach();
    }
  }

  /**
   * Resolves with what got through when the signal aborts — the caller owns the
   * signal, so a partial result is an answer rather than a silent success. That
   * holds however the abort lands: a sink whose transfer the same signal cancelled
   * rejects with an `AbortError`, and reporting the caller's own cancel back to
   * them as a failure would be a lie about what happened.
   *
   * `materialized` counts frames the sink *took*, not frames decoded. The worker
   * runs up to one chunk ahead of delivery and a cancel discards that lead, so the
   * count is kept here, where an `append` resolving is the proof.
   */
  async materialize(
    file: FileLike,
    selection: VideoSelection,
    sink: FrameSink,
    opts: { signal?: AbortLike; onProgress?(progress: VideoImportProgress): void } = {},
  ): Promise<VideoImportResult> {
    if (!browserSupports()) throw new Error("this browser has no WebCodecs video decoder");
    let detach = () => {};
    // A sink failure cancels rather than rejecting on the spot, so the worker still
    // runs its teardown; `done` is what turns the stored error into the rejection.
    let failure: { error: unknown } | null = null;
    let delivered = 0;
    let expected = 0;
    // `done` can arrive while an append is still in flight, because a cancelled
    // worker stops waiting for the ack. Settling waits for that append, so a sink
    // that fails at the very end is still what the caller hears about — except
    // after an abort, where waiting on a sink that ignored the signal would make
    // Cancel take as long as the upload it was pressed to stop.
    let taking: Promise<void> = Promise.resolve();

    // `async`, so a sink that throws synchronously lands here rather than escaping
    // the message handler — which would strand the worker on an ack that never comes.
    const take = async (frames: readonly MaterializedFrame[], worker: Worker): Promise<void> => {
      try {
        await sink.append(frames, opts.signal);
        delivered += frames.length;
        try {
          opts.onProgress?.({ materialized: delivered, expected });
        } catch {
          // Progress is advisory: a caller's reporting bug must not stop the import.
        }
        worker.postMessage({ type: "ack" });
      } catch (error) {
        if (opts.signal?.aborted !== true) failure = { error };
        worker.postMessage({ type: "cancel" });
      }
    };

    try {
      return await onWorker<VideoImportResult>(
        (worker) => {
          detach = onAbort(opts.signal, () => worker.postMessage({ type: "cancel" }));
          return { type: "materialize", file: asFile(file), selection };
        },
        (message, worker, settle) => {
          switch (message.type) {
            case "expected":
              expected = message.expected;
              return;
            case "chunk":
              // The ack is the back-pressure: no further decoding happens until the
              // sink has taken this chunk, so a slow sink stalls the worker rather
              // than filling its heap.
              taking = take(message.frames, worker);
              return;
            case "done": {
              const settled = (): void => {
                if (failure === null) {
                  settle.resolve({ materialized: delivered, expected, skipped: message.skipped });
                } else {
                  settle.reject((failure as { error: unknown }).error);
                }
              };
              if (opts.signal?.aborted === true) settled();
              else void taking.then(settled);
              return;
            }
            default:
              return;
          }
        },
      );
    } finally {
      detach();
    }
  }
}
