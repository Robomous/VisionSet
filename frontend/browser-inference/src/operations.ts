import type { ExecutionProvider } from "./capabilities.js";
import { InferenceRuntimeError } from "./errors.js";
import type {
  FromWorker,
  OperationId,
  ToWorker,
  WorkerChannel,
  WorkerSuccess,
} from "./protocol.js";

/** The resolved form of `InferenceRuntimeOptions`, as the worker is configured with it. */
export interface RuntimeConfiguration {
  readonly providers: readonly ExecutionProvider[];
  readonly wasmThreads: number;
  readonly assetBaseUrl?: string;
}

interface PendingOperation {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: InferenceRuntimeError) => void;
  /** Releases the abort listener, for the one operation that has one. */
  readonly detach: () => void;
}

/**
 * The value a success reply carries, chosen by the reply's own kind rather than by
 * the request waiting for it. That is what lets one pending-table entry serve all
 * four operations, and it is why there is no "the worker answered the wrong shape"
 * branch to get wrong: the id already decided who the answer belongs to.
 */
function valueOf(reply: WorkerSuccess): unknown {
  switch (reply.kind) {
    case "ready":
      return reply.providers;
    case "loaded":
      return reply.graphId;
    case "result":
      return reply.outputs;
    case "disposed":
      return undefined;
    case "model-loaded":
      return undefined;
    case "prepared":
      return { generation: reply.generation, width: reply.width, height: reply.height };
    case "segmentation":
      return { width: reply.width, height: reply.height, mask: reply.mask, confidence: reply.confidence };
    default: {
      // A compiler-checked catch-all: adding a `FromWorker` success kind without a
      // matching case here is a type error at this line, not a silent `undefined` a
      // caller's promise resolves with. `noImplicitReturns` does not cover a `switch`
      // whose cases already return on every reachable path, which is why this exists.
      const unreachable: never = reply;
      return unreachable;
    }
  }
}

/**
 * Narrow an arbitrary worker message to a reply. A message that is not one is
 * indistinguishable from a reply to an unknown operation, and is dropped the same way.
 */
function replyOf(message: unknown): FromWorker | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as Partial<FromWorker>;
  if (typeof candidate.id !== "number" || typeof candidate.kind !== "string") return undefined;
  return candidate as FromWorker;
}

function errorOf(reply: Extract<FromWorker, { kind: "error" }>): InferenceRuntimeError {
  return new InferenceRuntimeError(reply.code, reply.message, { cause: reply.detail });
}

/** The options a `request` call may carry, named once so the two spellings cannot drift. */
export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly transfer?: readonly unknown[];
}

/**
 * The correlation and lifecycle core a facade drives to expose a set of operations.
 *
 * `request` is every operation a facade offers, generalised: it mints an id, tracks
 * the promise it settles, posts the message the caller builds from that id, and wires
 * an optional `AbortSignal` the same way regardless of which operation it belongs to.
 * A facade's job is only to say which `ToWorker` message a call becomes and which
 * reply field is its answer — `valueOf` already does the latter.
 */
export interface OperationCore {
  readonly ready: Promise<readonly ExecutionProvider[]>;
  request<T>(build: (id: OperationId) => ToWorker, options?: RequestOptions): Promise<T>;
  /** Rejects every outstanding operation, releases the worker, and is idempotent. */
  dispose(): void;
}

/**
 * Drive a configured worker: mint operation ids, correlate replies, and settle every
 * promise exactly once.
 *
 * The whole safety argument is one rule — **a reply whose id is not in the pending
 * table is dropped silently**. Cancellation, late replies and post-dispose traffic are
 * not three separate guards; they are three situations in which the id has already
 * been removed, and the rule handles all of them without knowing which one it is in.
 *
 * Internal. A facade (`createRuntimeClient`, and later a model-layer facade) is what a
 * host actually obtains a runtime from; this only carries the machinery they share.
 */
export function createOperationCore(
  channel: WorkerChannel,
  configuration: RuntimeConfiguration,
): OperationCore {
  const pending = new Map<OperationId, PendingOperation>();
  let nextOperationId: OperationId = 1;
  let disposed = false;
  /**
   * Set once, by a failure the worker cannot come back from: a channel-level crash, or
   * a `configure` operation answering with an error. From that moment every later
   * request rejects with this same error and posts nothing — a fatal worker is not
   * retried or silently recreated, because automatic recovery is not part of this
   * phase. `ready` is not among them: it answers what initialization decided, and a
   * runtime that configured successfully before crashing still resolves it.
   */
  let terminalError: InferenceRuntimeError | null = null;
  let workerStopped = false;

  function post(message: ToWorker, transfer?: readonly unknown[]): void {
    channel.worker.postMessage(message, transfer);
  }

  function settleAll(error: InferenceRuntimeError): void {
    const outstanding = [...pending.values()];
    pending.clear();
    for (const operation of outstanding) {
      operation.detach();
      operation.reject(error);
    }
  }

  /**
   * One worker, stopped once. Three paths reach a stopped worker — disposal, a channel
   * crash and a configuration failure — and any two of them can happen in either order,
   * so the guard lives here rather than being argued about at each call site.
   */
  function stopWorker(): void {
    if (workerStopped) return;
    workerStopped = true;
    channel.worker.terminate();
  }

  /**
   * Move the runtime into its terminal state: every operation still pending rejects
   * with `error`, and the worker is stopped. Idempotent, because both a channel crash
   * and a configuration failure can each try to call this once. A runtime the caller
   * already disposed stays disposed: it has nothing pending and no worker left, and
   * relabelling its refusals after the fact would only confuse whoever ended it.
   */
  function terminate(error: InferenceRuntimeError): void {
    if (terminalError !== null || disposed) return;
    terminalError = error;
    settleAll(error);
    stopWorker();
  }

  function request<T>(build: (id: OperationId) => ToWorker, options?: RequestOptions): Promise<T> {
    if (terminalError !== null) return Promise.reject(terminalError);
    if (disposed) return Promise.reject(new InferenceRuntimeError("disposed"));
    const signal = options?.signal;
    // An already-aborted signal posts nothing at all: there is no operation for the
    // worker to hear about, and minting an id for one would only be work to undo.
    if (signal?.aborted === true) return Promise.reject(new InferenceRuntimeError("cancelled"));

    const id = nextOperationId++;
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        // `delete` is the same routing rule seen from the other side: if the id is
        // gone the operation already settled, and there is nothing to cancel.
        if (!pending.delete(id)) return;
        reject(new InferenceRuntimeError("cancelled"));
        // The caller is settled now, before the worker has heard anything. ORT
        // offers no way to interrupt a `session.run` that has started, so this asks
        // the worker to drop a queued operation or discard a running one's result.
        // It does not stop compute, and nothing here should be read as claiming it does.
        post({ kind: "cancel", id });
      };
      signal?.addEventListener("abort", abort, { once: true });
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        detach: () => signal?.removeEventListener("abort", abort),
      });
      post(build(id), options?.transfer);
    });
  }

  // Initialization is an operation like any other: it is posted here, its `ready`
  // reply routes through the same table, and a configuration failure arrives as an
  // ordinary `error`. The rejection is marked handled so that a worker that never
  // starts does not surface as an unhandled rejection for a caller who never asked
  // about readiness; `ready` hands out the same promise, rejection intact.
  const configureId: OperationId = nextOperationId++;
  const readyOperation = new Promise<readonly ExecutionProvider[]>((resolve, reject) => {
    pending.set(configureId, {
      resolve: resolve as (value: unknown) => void,
      reject,
      detach: () => {},
    });
    post({
      kind: "configure",
      id: configureId,
      providers: configuration.providers,
      wasmThreads: configuration.wasmThreads,
      assetBaseUrl: configuration.assetBaseUrl,
    });
  });
  void readyOperation.catch(() => {});

  channel.onMessage((message) => {
    const reply = replyOf(message);
    if (reply === undefined) return;
    const operation = pending.get(reply.id);
    if (operation === undefined) return;
    pending.delete(reply.id);
    operation.detach();
    if (reply.kind === "error") {
      const error = errorOf(reply);
      operation.reject(error);
      // `configure` failing means this worker can never accept a graph. An ordinary
      // per-operation error would leave `ready` rejected but the runtime otherwise
      // alive, which is exactly the zombie state this phase must not produce.
      if (reply.id === configureId) terminate(error);
      return;
    }
    operation.resolve(valueOf(reply));
  });

  channel.onError((error) => {
    // Unlike a `configure` error reply, this carries no operation id — the worker
    // itself failed, not one message to it — so every caller, present and future,
    // hears about it the same way.
    terminate(new InferenceRuntimeError("worker-crashed", undefined, { cause: error }));
  });

  return {
    ready: readyOperation,
    request,
    dispose() {
      if (disposed) return;
      disposed = true;
      // A worker already in its terminal state has nothing pending to settle, nothing
      // left to ask to shut down cleanly, and nothing left to stop — `terminate()` did
      // all three. `stopWorker()` is what keeps that true rather than a comment.
      if (terminalError === null) {
        settleAll(new InferenceRuntimeError("disposed"));
        // The worker is asked to release its sessions before it is stopped, but
        // `terminate()` on the worker is what guarantees the stop, so the release is
        // best-effort and the `disposed` reply — if it is ever sent — is dropped by the
        // routing rule, because this id is deliberately never entered in the pending table.
        post({ kind: "shutdown", id: nextOperationId++ });
      }
      stopWorker();
    },
  };
}
