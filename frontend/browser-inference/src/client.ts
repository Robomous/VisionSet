import type { ExecutionPolicy, ExecutionProvider } from "./capabilities.js";
import { InferenceRuntimeError } from "./errors.js";
import type {
  FromWorker,
  GraphId,
  OperationId,
  RunInputs,
  RunOutputs,
  ToWorker,
  WorkerChannel,
  WorkerSuccess,
} from "./protocol.js";

/** What a host chooses when it asks for a runtime. Everything else is derived. */
export interface InferenceRuntimeOptions {
  /** Defaults to `"prefer-webgpu"`. */
  readonly policy?: ExecutionPolicy;
  /**
   * Where the ONNX Runtime WASM artifacts are served from. The package ships them
   * beside the built worker and the worker resolves that location itself, so this is
   * only for a host that would rather serve them from its own origin or a CDN.
   */
  readonly assetBaseUrl?: string;
}

/** The resolved form of `InferenceRuntimeOptions`, as the worker is configured with it. */
export interface RuntimeConfiguration {
  readonly providers: readonly ExecutionProvider[];
  readonly wasmThreads: number;
  readonly assetBaseUrl?: string;
}

/**
 * A worker that has been started and will stay started.
 *
 * One worker per handle, living from creation to `dispose()`, carrying every graph
 * loaded in that span. An ORT session costs hundreds of milliseconds to create and
 * holds compiled kernels, and the interactions this exists for re-run one graph
 * against state a previous run produced — so a worker per operation, which is right
 * for video import in `@visionset/media`, would throw all of that away on every call.
 */
export interface BrowserInferenceRuntime {
  /** The providers ORT was configured with, once the worker has confirmed them. */
  ready(): Promise<readonly ExecutionProvider[]>;
  /**
   * Hand the worker a serialized ONNX graph and keep the session it creates.
   *
   * The bytes are transferred, not copied — a model is megabytes, and cloning that on
   * every load is a real cost — so `bytes` is detached and unusable afterwards.
   */
  loadGraph(bytes: Uint8Array): Promise<GraphId>;
  run(
    graphId: GraphId,
    inputs: RunInputs,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RunOutputs>;
  /** Rejects every outstanding operation, releases the worker, and is idempotent. */
  dispose(): void;
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

/**
 * Drive a configured worker: mint operation ids, correlate replies, and settle every
 * promise exactly once.
 *
 * The whole safety argument is one rule — **a reply whose id is not in the pending
 * table is dropped silently**. Cancellation, late replies and post-dispose traffic are
 * not three separate guards; they are three situations in which the id has already
 * been removed, and the rule handles all of them without knowing which one it is in.
 *
 * Internal. A host obtains a runtime from `createInferenceRuntime()` in the browser
 * adapter, which is the only place that knows how to build a real channel.
 */
export function createRuntimeClient(
  channel: WorkerChannel,
  configuration: RuntimeConfiguration,
): BrowserInferenceRuntime {
  const pending = new Map<OperationId, PendingOperation>();
  let nextOperationId: OperationId = 1;
  let disposed = false;
  /**
   * Set once, by a failure the worker cannot come back from: a channel-level crash, or
   * a `configure` operation answering with an error. From that moment every later call
   * rejects with this same error and posts nothing — a fatal worker is not retried or
   * silently recreated, because automatic recovery is not part of this phase.
   */
  let terminalError: InferenceRuntimeError | null = null;

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
   * Move the runtime into its terminal state: every operation still pending rejects
   * with `error`, and the worker is stopped. Idempotent, because both a channel crash
   * and a configuration failure can each try to call this once.
   */
  function terminate(error: InferenceRuntimeError): void {
    if (terminalError !== null) return;
    terminalError = error;
    settleAll(error);
    channel.worker.terminate();
  }

  function send<T>(request: (id: OperationId) => void): Promise<T> {
    const id = nextOperationId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, detach: () => {} });
      request(id);
    });
  }

  // Initialization is an operation like any other: it is posted here, its `ready`
  // reply routes through the same table, and a configuration failure arrives as an
  // ordinary `error`. The rejection is marked handled so that a worker that never
  // starts does not surface as an unhandled rejection for a caller who never asked
  // about readiness; `ready()` hands out the same promise, rejection intact.
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
      // per-operation error would leave `ready()` rejected but the runtime otherwise
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
    ready: () => readyOperation,

    loadGraph(bytes) {
      if (terminalError !== null) return Promise.reject(terminalError);
      if (disposed) return Promise.reject(new InferenceRuntimeError("disposed"));
      return send<GraphId>((id) => {
        post({ kind: "load-graph", id, bytes }, [bytes.buffer]);
      });
    },

    run(graphId, inputs, options) {
      if (terminalError !== null) return Promise.reject(terminalError);
      if (disposed) return Promise.reject(new InferenceRuntimeError("disposed"));
      const signal = options?.signal;
      // An already-aborted signal posts nothing at all: there is no operation for the
      // worker to hear about, and minting an id for one would only be work to undo.
      if (signal?.aborted === true) return Promise.reject(new InferenceRuntimeError("cancelled"));

      const id = nextOperationId++;
      return new Promise<RunOutputs>((resolve, reject) => {
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
        // Inputs are cloned rather than transferred: a caller may well run the same
        // tensor against two graphs, and silently detaching their buffers would make
        // the second call fail in a place that has nothing to do with the cause.
        post({ kind: "run", id, graphId, inputs });
      });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // A worker already in its terminal state has nothing pending to settle and
      // nothing left to ask to shut down cleanly — `terminate()` already did both.
      if (terminalError === null) {
        settleAll(new InferenceRuntimeError("disposed"));
        // The worker is asked to release its sessions before it is stopped, but
        // `terminate()` is what guarantees the stop, so the release is best-effort and
        // the `disposed` reply — if it is ever sent — is dropped by the routing rule,
        // because this id is deliberately never entered in the pending table.
        post({ kind: "shutdown", id: nextOperationId++ });
      }
      channel.worker.terminate();
    },
  };
}
