import { describe, expect, it } from "vitest";

import {
  capabilitiesOf,
  executionProvidersFor,
  type RuntimeEnvironment,
} from "./capabilities.js";
import { isInferenceRuntimeError } from "./errors.js";

/** A browser that can do everything, so each test only has to say how it differs. */
function environment(overrides: Partial<RuntimeEnvironment> = {}): RuntimeEnvironment {
  return {
    hasWorker: true,
    hasWebAssembly: true,
    hasWebGpu: true,
    crossOriginIsolated: true,
    hardwareConcurrency: 8,
    ...overrides,
  };
}

describe("capabilitiesOf", () => {
  it("refuses an environment with no WebAssembly", () => {
    expect(capabilitiesOf(environment({ hasWebAssembly: false })).supported).toBe(false);
  });

  it("refuses an environment with no Worker", () => {
    expect(capabilitiesOf(environment({ hasWorker: false })).supported).toBe(false);
  });

  it("supports an environment with both", () => {
    expect(capabilitiesOf(environment()).supported).toBe(true);
  });

  it("reports declared WebGPU", () => {
    expect(capabilitiesOf(environment({ hasWebGpu: true })).webgpu).toBe(true);
    expect(capabilitiesOf(environment({ hasWebGpu: false })).webgpu).toBe(false);
  });

  it("runs WASM single-threaded without cross-origin isolation", () => {
    const capabilities = capabilitiesOf(
      environment({ crossOriginIsolated: false, hardwareConcurrency: 16 }),
    );
    expect(capabilities.wasmThreads).toBe(1);
  });

  it("caps WASM threads at four on a large isolated machine", () => {
    const capabilities = capabilitiesOf(
      environment({ crossOriginIsolated: true, hardwareConcurrency: 16 }),
    );
    expect(capabilities.wasmThreads).toBe(4);
  });

  it("uses the core count when it is below the cap", () => {
    const capabilities = capabilitiesOf(
      environment({ crossOriginIsolated: true, hardwareConcurrency: 2 }),
    );
    expect(capabilities.wasmThreads).toBe(2);
  });

  it("never reports fewer than one thread", () => {
    const capabilities = capabilitiesOf(
      environment({ crossOriginIsolated: true, hardwareConcurrency: 0 }),
    );
    expect(capabilities.wasmThreads).toBe(1);
  });
});

describe("executionProvidersFor", () => {
  const webgpuCapable = capabilitiesOf(environment({ hasWebGpu: true }));
  const wasmOnlyCapable = capabilitiesOf(environment({ hasWebGpu: false }));

  it("gives each policy its own provider list", () => {
    expect(executionProvidersFor("prefer-webgpu", webgpuCapable)).toEqual(["webgpu", "wasm"]);
    expect(executionProvidersFor("require-webgpu", webgpuCapable)).toEqual(["webgpu"]);
    expect(executionProvidersFor("wasm-only", webgpuCapable)).toEqual(["wasm"]);
  });

  it("drops WebGPU from the preferred list when none is declared", () => {
    expect(executionProvidersFor("prefer-webgpu", wasmOnlyCapable)).toEqual(["wasm"]);
  });

  it("refuses require-webgpu without WebGPU", () => {
    try {
      executionProvidersFor("require-webgpu", wasmOnlyCapable);
      expect.unreachable("require-webgpu must not resolve without declared WebGPU");
    } catch (error) {
      expect(isInferenceRuntimeError(error) && error.code).toBe("webgpu-unavailable");
    }
  });

  it("refuses every policy on an environment no runtime can exist in", () => {
    const unsupported = capabilitiesOf(environment({ hasWebAssembly: false }));
    for (const policy of ["prefer-webgpu", "require-webgpu", "wasm-only"] as const) {
      try {
        executionProvidersFor(policy, unsupported);
        expect.unreachable(`${policy} must not resolve on an unsupported environment`);
      } catch (error) {
        expect(isInferenceRuntimeError(error) && error.code).toBe("unsupported-runtime");
      }
    }
  });
});
