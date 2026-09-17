import { describe, expect, it, vi } from "vitest";
import { createOssBrowserInferenceRuntime } from "./BrowserInferenceRuntime.js";
import { EFFICIENT_SAM_TI_REVISION } from "./manifest.js";

function fakeDeps(overrides?: { acquire?: () => Promise<{ encoder: Uint8Array; decoder: Uint8Array }> }) {
  const createRuntime = vi.fn(() => ({
    ready: async () => [],
    prepareImage: async () => ({ width: 1, height: 1 }),
    suggest: async () => ({ width: 1, height: 1, mask: new Uint8Array(1), confidence: 1 }),
    dispose: () => {},
  }));
  const acquire = vi.fn(overrides?.acquire ?? (async () => ({ encoder: new Uint8Array(1), decoder: new Uint8Array(1) })));
  return { acquire, createRuntime };
}

describe("createOssBrowserInferenceRuntime", () => {
  it("lists no targets and one acquisition before acquiring", async () => {
    const deps = fakeDeps();
    const runtime = createOssBrowserInferenceRuntime(deps);
    expect(await runtime.listTargets()).toEqual([]);
    expect(runtime.listAcquisitions?.()).toHaveLength(1);
  });

  it("lists the target and no acquisitions after acquiring", async () => {
    const deps = fakeDeps();
    const runtime = createOssBrowserInferenceRuntime(deps);
    await runtime.listAcquisitions?.()[0]!.acquire();
    expect(await runtime.listTargets()).toHaveLength(1);
    expect(runtime.listAcquisitions?.()).toEqual([]);
    expect(deps.acquire).toHaveBeenCalledTimes(1);
    expect(deps.createRuntime).toHaveBeenCalledTimes(1);
  });

  it("leaves the model unacquired (retryable) when acquire() rejects", async () => {
    const deps = fakeDeps({ acquire: () => Promise.reject(new Error("network down")) });
    const runtime = createOssBrowserInferenceRuntime(deps);
    await expect(runtime.listAcquisitions?.()[0]!.acquire()).rejects.toThrow("network down");
    expect(await runtime.listTargets()).toEqual([]);
    expect(runtime.listAcquisitions?.()).toHaveLength(1);
  });

  it("dedupes a second acquire() call while the first is still in flight", async () => {
    let resolveAcquire!: (value: { encoder: Uint8Array; decoder: Uint8Array }) => void;
    const deps = fakeDeps({ acquire: () => new Promise((resolve) => (resolveAcquire = resolve)) });
    const runtime = createOssBrowserInferenceRuntime(deps);
    const first = runtime.listAcquisitions?.()[0]!.acquire();
    const second = runtime.listAcquisitions?.()[0]!.acquire();
    resolveAcquire({ encoder: new Uint8Array(1), decoder: new Uint8Array(1) });
    await Promise.all([first, second]);
    expect(deps.acquire).toHaveBeenCalledTimes(1);
  });

  it("carries the pinned revision in the acquired target's modelRef", async () => {
    const deps = fakeDeps();
    const runtime = createOssBrowserInferenceRuntime(deps);
    await runtime.listAcquisitions?.()[0]!.acquire();
    const targets = await runtime.listTargets();
    expect(targets[0]!.modelRef).toBe(`efficient-sam-ti@${EFFICIENT_SAM_TI_REVISION}`);
  });

  it("throws from executorFor before any acquisition has succeeded", () => {
    const runtime = createOssBrowserInferenceRuntime(fakeDeps());
    expect(() => runtime.executorFor("efficient-sam-ti")).toThrow();
  });
});
