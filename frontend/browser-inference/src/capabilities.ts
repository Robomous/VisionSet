import { InferenceRuntimeError } from "./errors.js";

/**
 * What the host environment declares about itself.
 *
 * A record that is passed rather than a singleton that is consulted: every branch
 * below is reachable from a Node test by constructing one, and there is no
 * module-level cached value left to be wrong after the environment changes.
 * `readEnvironment()` in the browser adapter is the only thing that fills it in.
 *
 * `hasWebGpu` means **`navigator.gpu` is present**, and nothing beyond that. It does
 * not mean an adapter can be acquired, that a device will be granted, that a given
 * operator is implemented, or that any model will run. Detection answers what
 * mechanisms appear available; whether a graph runs is answered by running it. The
 * distinction is not pedantry — over-reading this flag is how a "run on this device"
 * control gets offered to a user whose browser then cannot honour it.
 */
export interface RuntimeEnvironment {
  readonly hasWorker: boolean;
  readonly hasWebAssembly: boolean;
  readonly hasWebGpu: boolean;
  readonly crossOriginIsolated: boolean;
  readonly hardwareConcurrency: number;
}

/** What those facts mean for this runtime, before any policy is applied. */
export interface RuntimeCapabilities {
  /** Whether a runtime can exist here at all: a worker to host ORT, and WebAssembly to run it. */
  readonly supported: boolean;
  /** Whether WebGPU is *declared*, with the caveat on `RuntimeEnvironment.hasWebGpu`. */
  readonly webgpu: boolean;
  /** 1 unless the document is cross-origin isolated; see `capabilitiesOf`. */
  readonly wasmThreads: number;
}

export type ExecutionPolicy = "prefer-webgpu" | "require-webgpu" | "wasm-only";

export type ExecutionProvider = "webgpu" | "wasm";

/**
 * Threads beyond the first need `SharedArrayBuffer`, which needs cross-origin
 * isolation, which needs COOP/COEP headers this project does not set. Single-threaded
 * WASM is slower and it works, so the whole accommodation is this one expression
 * rather than a change to how the application is served. The cap at four is because
 * ORT's own scaling flattens well before a large machine's core count, and every
 * extra thread is another WASM heap.
 */
export function capabilitiesOf(env: RuntimeEnvironment): RuntimeCapabilities {
  return {
    supported: env.hasWorker && env.hasWebAssembly,
    webgpu: env.hasWebGpu,
    wasmThreads: env.crossOriginIsolated ? Math.max(1, Math.min(env.hardwareConcurrency, 4)) : 1,
  };
}

/**
 * Turn a policy and a set of capabilities into the provider list ORT is configured with.
 *
 * `prefer-webgpu` names WebGPU only where WebGPU is declared. Listing a provider the
 * environment does not have would push the refusal down into ORT's session creation,
 * where it arrives as a message about a backend rather than as a capability answer.
 *
 * `require-webgpu` and `wasm-only` are not conveniences. Under `prefer-webgpu` ORT may
 * place any individual operator on CPU, so no run under it can claim WebGPU executed
 * anything; `require-webgpu` is the only configuration under which that claim is
 * checkable, and `wasm-only` the only one that gives the same answer on every machine.
 *
 * @throws InferenceRuntimeError `unsupported-runtime` when no runtime can exist here,
 * `webgpu-unavailable` when `require-webgpu` meets an environment that declares none.
 */
export function executionProvidersFor(
  policy: ExecutionPolicy,
  capabilities: RuntimeCapabilities,
): readonly ExecutionProvider[] {
  if (!capabilities.supported) throw new InferenceRuntimeError("unsupported-runtime");
  switch (policy) {
    case "wasm-only":
      return ["wasm"];
    case "require-webgpu":
      if (!capabilities.webgpu) throw new InferenceRuntimeError("webgpu-unavailable");
      return ["webgpu"];
    case "prefer-webgpu":
      return capabilities.webgpu ? ["webgpu", "wasm"] : ["wasm"];
  }
}
