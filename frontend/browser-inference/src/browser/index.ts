/**
 * `@visionset/browser-inference/browser` — the half that may touch a browser.
 *
 * Everything here is deliberately behind a function call. Importing this module starts
 * no worker, reads no global and probes no adapter; `createInferenceRuntime()` is the
 * only thing that does any of it. A consumer that imports the package to name a type in
 * a Node build gets nothing but declarations, and the core entry (`.`) cannot reach a
 * browser global at all.
 */
import {
  capabilitiesOf,
  executionProvidersFor,
  type RuntimeEnvironment,
} from "../capabilities.js";
import { createRuntimeClient, type BrowserInferenceRuntime, type InferenceRuntimeOptions } from "../client.js";
import { InferenceRuntimeError } from "../errors.js";
import type { WorkerChannel } from "../protocol.js";

/**
 * Read what this environment declares about itself, once, at the moment of asking.
 *
 * Every value is taken defensively: `navigator` exists in a worker and in a document
 * but not in Node, `crossOriginIsolated` is absent in older engines, and
 * `hardwareConcurrency` is allowed to be missing. A `typeof` guard on each is cheaper
 * than a try/catch around a snapshot that is wrong as a whole if any one part fails.
 */
export function readEnvironment(): RuntimeEnvironment {
  const gpu = typeof navigator === "undefined" ? undefined : (navigator as Navigator).gpu;
  return {
    hasWorker: typeof Worker === "function",
    hasWebAssembly: typeof WebAssembly === "object",
    // Presence of `navigator.gpu`, and nothing more — see `RuntimeEnvironment`.
    hasWebGpu: gpu !== undefined && gpu !== null,
    crossOriginIsolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false,
    hardwareConcurrency:
      typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
        ? navigator.hardwareConcurrency
        : 1,
  };
}

/** Whether a runtime can exist here at all. Safe to call anywhere, including Node. */
export function browserSupports(): boolean {
  return capabilitiesOf(readEnvironment()).supported;
}

/**
 * Bridge a real `Worker` to the DOM-free channel the client drives.
 *
 * This wrapper is the whole reason core needs no DOM lib: `MessageEvent` and
 * `ErrorEvent` are narrowed to `unknown` here, on the one side of the boundary that is
 * already allowed to know what they are.
 */
function channelOver(worker: Worker): WorkerChannel {
  return {
    worker,
    onMessage(handler) {
      worker.addEventListener("message", (event: MessageEvent) => {
        handler(event.data);
      });
    },
    onError(handler) {
      worker.addEventListener("error", (event: ErrorEvent) => {
        handler(event);
      });
    },
  };
}

/**
 * Start a persistent inference worker.
 *
 * Throws `InferenceRuntimeError("unsupported-runtime")` before constructing anything
 * when the environment cannot host one, and `"webgpu-unavailable"` when the policy
 * demands WebGPU and none is declared. Both are raised synchronously: a caller that
 * cannot have a runtime should find out at the call that asked for one, not at the
 * first operation.
 *
 * The worker URL is resolved against this module's own location, so the built
 * `dist/browser/index.js` finds its sibling `dist/browser/worker.js`. Never a `blob:`
 * or `data:` URL, and never a string of source — a host's content-security policy must
 * not be the thing that breaks import.
 */
export function createInferenceRuntime(
  options: InferenceRuntimeOptions = {},
): BrowserInferenceRuntime {
  const capabilities = capabilitiesOf(readEnvironment());
  const providers = executionProvidersFor(options.policy ?? "prefer-webgpu", capabilities);

  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  } catch (error) {
    throw new InferenceRuntimeError("worker-initialization-failed", undefined, { cause: error });
  }

  return createRuntimeClient(channelOver(worker), {
    providers,
    wasmThreads: capabilities.wasmThreads,
    assetBaseUrl: options.assetBaseUrl,
  });
}
