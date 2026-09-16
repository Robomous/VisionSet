/**
 * `@visionset/browser-inference` — the core surface.
 *
 * Everything here is framework-free, browser-free and importable in Node: types, the
 * error contract, and the capability interpretation that decides which execution
 * providers a policy asks ORT for. The runtime itself is obtained from
 * `@visionset/browser-inference/browser`, which is the only half that may touch a
 * browser global or ONNX Runtime.
 *
 * What is deliberately absent: `InferenceSession`, `Tensor`, `GPUDevice`, ORT's `env`,
 * the WASM filenames, the worker URL and the message protocol. A consumer chooses a
 * policy and runs a graph; everything ORT knows about itself stays behind the worker.
 */

export type {
  ExecutionPolicy,
  ExecutionProvider,
  RuntimeCapabilities,
  RuntimeEnvironment,
} from "./capabilities.js";
export { capabilitiesOf, executionProvidersFor } from "./capabilities.js";

export type { InferenceRuntimeErrorCode } from "./errors.js";
export { InferenceRuntimeError, isInferenceRuntimeError } from "./errors.js";

export type { GraphId, RunInputs, RunOutputs, TensorLike } from "./protocol.js";

export type { BrowserInferenceRuntime, InferenceRuntimeOptions } from "./client.js";
