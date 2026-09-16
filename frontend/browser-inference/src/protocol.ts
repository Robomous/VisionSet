import type { ExecutionProvider } from "./capabilities.js";
import type { InferenceRuntimeErrorCode } from "./errors.js";

/**
 * Correlates one worker request with its one reply, and nothing else.
 *
 * Deliberately not the annotator's suggestion serial. This number protects *routing* —
 * that a promise settles with its own answer — and lives for a single request. A
 * suggestion serial protects *editor state* — that a stale answer cannot overwrite a
 * newer one on screen — and lives for an editing session. A correctly routed answer can
 * still be stale on screen, because the user clicked again while it was in flight and
 * the runtime has no idea. Neither identity implies the other, so neither replaces it.
 */
export type OperationId = number;

/**
 * A handle to a graph the worker has loaded and kept.
 *
 * A string where an `OperationId` is a number, so the two identities cannot be
 * silently transposed at a call site that has both in scope.
 */
export type GraphId = string;

/**
 * The minimum tensor shape that is not ORT's `Tensor`.
 *
 * Structural on purpose: a caller builds one from a plain object and never constructs
 * an ONNX Runtime value, which is what keeps ORT behind the worker. Float32 only,
 * because it is the only dtype this package produces; widening it is a question to
 * answer when there is a model that needs it.
 */
export interface TensorLike {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

export type RunInputs = Readonly<Record<string, TensorLike>>;

export type RunOutputs = Readonly<Record<string, TensorLike>>;

/**
 * Main thread to worker.
 *
 * `configure` carries an id and is answered by `ready`, so initialization is an
 * operation like any other and its failure is an `error` with a code rather than a
 * special case. `cancel` is the one message that is never answered: the caller has
 * already been settled by the time it is posted, so a reply would have nobody to
 * deliver to. Every other message has an id because the correlation table has to be
 * total — a message with no id could not be routed, so none exists.
 */
export type ToWorker =
  | {
      readonly kind: "configure";
      readonly id: OperationId;
      readonly providers: readonly ExecutionProvider[];
      readonly wasmThreads: number;
      /** Where the ORT WASM artifacts are served from; the worker's own default when absent. */
      readonly assetBaseUrl?: string;
    }
  | { readonly kind: "load-graph"; readonly id: OperationId; readonly bytes: Uint8Array }
  | {
      readonly kind: "run";
      readonly id: OperationId;
      readonly graphId: GraphId;
      readonly inputs: RunInputs;
    }
  | { readonly kind: "cancel"; readonly id: OperationId }
  | { readonly kind: "shutdown"; readonly id: OperationId };

/**
 * Worker to main thread. Every member names the request it answers; there is no
 * unsolicited message and no status channel.
 */
export type FromWorker =
  | {
      readonly kind: "ready";
      readonly id: OperationId;
      readonly providers: readonly ExecutionProvider[];
    }
  | { readonly kind: "loaded"; readonly id: OperationId; readonly graphId: GraphId }
  | { readonly kind: "result"; readonly id: OperationId; readonly outputs: RunOutputs }
  | {
      readonly kind: "error";
      readonly id: OperationId;
      readonly code: InferenceRuntimeErrorCode;
      readonly message: string;
      /** The underlying exception's text, carried to the caller as `cause`. */
      readonly detail?: string;
    }
  | { readonly kind: "disposed"; readonly id: OperationId };

/** The replies that carry an answer rather than a failure. */
export type WorkerSuccess = Exclude<FromWorker, { kind: "error" }>;

/**
 * The part of a `Worker` the client uses, and no more.
 *
 * Narrowed to this so core needs no DOM lib to drive a worker, and so the whole
 * correlation table can be exercised from Node against a controllable double.
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  terminate(): void;
}

/**
 * A worker plus the two callbacks it delivers on.
 *
 * Callbacks rather than an `EventTarget` because `MessageEvent` and `ErrorEvent` are
 * DOM types: narrowing them to `unknown` is the browser adapter's job, and doing it
 * at this seam is what keeps `WorkerLike` free of them.
 */
export interface WorkerChannel {
  readonly worker: WorkerLike;
  onMessage(handler: (message: unknown) => void): void;
  onError(handler: (error: unknown) => void): void;
}
