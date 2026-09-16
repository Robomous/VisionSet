/**
 * Every way this runtime can fail, and no more.
 *
 * The union is closed because a caller switches on it. There is deliberately no
 * `wasm-unavailable`: a browser without WebAssembly is `unsupported-runtime`, and
 * two codes for one state would be a contract lying about how many things can go
 * wrong. A code is added when a failure that callers must distinguish becomes
 * possible, not in anticipation of one.
 */
export type InferenceRuntimeErrorCode =
  | "unsupported-runtime"
  | "worker-initialization-failed"
  | "webgpu-unavailable"
  | "graph-load-failed"
  | "runtime-execution-failed"
  | "cancelled"
  | "disposed";

/**
 * One sentence per code, so a caller that only logs `error.message` still gets
 * something true. A caller that wants to branch reads `code`.
 */
const DEFAULT_MESSAGE: Readonly<Record<InferenceRuntimeErrorCode, string>> = {
  "unsupported-runtime":
    "This environment provides no Worker or no WebAssembly, so no inference runtime can exist here.",
  "worker-initialization-failed": "The inference worker could not be started or configured.",
  "webgpu-unavailable": "WebGPU was required, but this environment declares none.",
  "graph-load-failed": "The graph could not be loaded.",
  "runtime-execution-failed": "The graph could not be run.",
  cancelled: "The operation was cancelled by its caller.",
  disposed: "The runtime was disposed while this operation was outstanding.",
};

/**
 * The single error type this package raises.
 *
 * `code` is the contract and `cause` is the diagnostics. When the failure happened
 * inside ONNX Runtime, its own exception text travels as `cause` and is never
 * promoted to being the contract — a caller switches on `code`, a developer reads
 * `cause`. Codes cross the worker boundary as strings, because an `Error` does not
 * structured-clone usefully, and are rebuilt here on the main thread, so a caller
 * cannot tell which side of the boundary failed. That is the point.
 */
/**
 * The mark `isInferenceRuntimeError` looks for, taken from the global symbol registry
 * rather than created fresh.
 *
 * `instanceof` is wrong here, and it is wrong for a packaging reason rather than a
 * stylistic one. This package publishes two entry points and bundles each one whole, so
 * a consumer importing `createInferenceRuntime` from `./browser` and
 * `isInferenceRuntimeError` from `.` holds **two copies of this class**, and an error
 * thrown by one is not an instance of the other. Measured, not theorised: the browser
 * suite's cancellation test failed exactly this way. `Symbol.for` returns the same
 * symbol to every copy, so the check survives the split.
 */
const BRAND = Symbol.for("@visionset/browser-inference.InferenceRuntimeError");

export class InferenceRuntimeError extends Error {
  readonly code: InferenceRuntimeErrorCode;

  constructor(
    code: InferenceRuntimeErrorCode,
    message?: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message ?? DEFAULT_MESSAGE[code], options);
    this.name = "InferenceRuntimeError";
    this.code = code;
    // Defined rather than assigned, so it is non-enumerable and stays out of anything
    // that walks the error's own keys.
    Object.defineProperty(this, BRAND, { value: true });
  }
}

export function isInferenceRuntimeError(value: unknown): value is InferenceRuntimeError {
  return (
    typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true
  );
}
