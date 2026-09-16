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

import { EFFICIENT_SAM_TI as EFFICIENT_SAM_TI_INTERNAL } from "./models/efficientSam.js";

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

export type {
  PixelImage,
  PointPrompt,
  PreparedImage,
  PromptableSegmentationRuntime,
  RawSegmentation,
} from "./models/promptable.js";

/**
 * The public slice of `EFFICIENT_SAM_TI`: `maxPoints`, because a caller sizing a prompt
 * UI needs to know how many points the model takes, and `candidates`, because a caller
 * may reasonably want to know the model offers a best-of-N. Everything else on the full
 * constant — `imageSize`, `positiveLabel`, `paddingLabel`, `maskThreshold` — is this
 * model's internal encoding, not this package's business to publish; see the design's
 * §7, which names `paddingLabel` specifically.
 */
export const EFFICIENT_SAM_TI = Object.freeze({
  maxPoints: EFFICIENT_SAM_TI_INTERNAL.maxPoints,
  candidates: EFFICIENT_SAM_TI_INTERNAL.candidates,
});
