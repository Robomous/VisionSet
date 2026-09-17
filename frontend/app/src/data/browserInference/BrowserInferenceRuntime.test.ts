import { describe, expect, it, vi } from "vitest";
import type { SuggestionRequest } from "@visionset/ui-core";
import { createOssBrowserInferenceRuntime } from "./BrowserInferenceRuntime.js";
import { EFFICIENT_SAM_TI_REVISION } from "./manifest.js";

function fakeDeps(overrides?: {
  acquire?: () => Promise<{ encoder: Uint8Array; decoder: Uint8Array }>;
  ready?: () => Promise<never[]>;
  supported?: () => boolean;
}) {
  const prepareImage = vi.fn(async () => ({ width: 4, height: 4 }));
  const dispose = vi.fn();
  const createRuntime = vi.fn(() => ({
    ready: overrides?.ready ?? (async () => []),
    prepareImage,
    suggest: async () => ({ width: 4, height: 4, mask: new Uint8Array(16).fill(1), confidence: 1 }),
    dispose,
  }));
  const acquire = vi.fn(overrides?.acquire ?? (async () => ({ encoder: new Uint8Array(1), decoder: new Uint8Array(1) })));
  return { acquire, createRuntime, supported: overrides?.supported ?? ((): boolean => true), prepareImage, dispose };
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

  it("offers no acquisition at all where no runtime could exist", async () => {
    // A download that can only end in `unsupported-runtime` is worse than no control:
    // the port's rule is that a host which cannot honour a control does not offer it.
    const deps = fakeDeps({ supported: () => false });
    const runtime = createOssBrowserInferenceRuntime(deps);
    expect(runtime.listAcquisitions?.()).toEqual([]);
    expect(await runtime.listTargets()).toEqual([]);
    expect(deps.acquire).not.toHaveBeenCalled();
  });

  describe("readiness is the ORT session's, not the constructor's", () => {
    it("leaves the model unacquired and retryable when ready() rejects, and disposes it", async () => {
      // `createRuntime` returns before the worker has loaded a graph. Setting "ready" on
      // it alone lists a target whose every click then refuses — and a listed target hides
      // the Download control, so the acquisition UI's own retry path is gone too.
      const deps = fakeDeps({ ready: () => Promise.reject(new Error("graph load failed")) });
      const runtime = createOssBrowserInferenceRuntime(deps);

      await expect(runtime.listAcquisitions?.()[0]!.acquire()).rejects.toThrow("graph load failed");

      expect(await runtime.listTargets()).toEqual([]);
      expect(runtime.listAcquisitions?.()).toHaveLength(1);
      // The worker behind the failed runtime is let go rather than left running.
      expect(deps.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("one encode per asset survives composition", () => {
    it("hands out the same executor on every executorFor call", async () => {
      const runtime = createOssBrowserInferenceRuntime(fakeDeps());
      await runtime.listAcquisitions?.()[0]!.acquire();
      expect(runtime.executorFor("efficient-sam-ti")).toBe(runtime.executorFor("efficient-sam-ti"));
    });

    it("encodes once across two separately obtained executors", async () => {
      // The behavioural half, and the one that matters: the embedding cache lives inside
      // the executor closure, so a fresh executor per call throws it away. `AnnotationPage`
      // calls `executorFor` during render and re-renders on every click, which made each
      // refinement click a full encoder pass. Two `executorFor` results, two asks, one
      // `prepareImage` — that is the design's "one encode per asset, N decodes per N
      // refinements", proved where the composition actually happens.
      const deps = fakeDeps();
      const runtime = createOssBrowserInferenceRuntime(deps);
      await runtime.listAcquisitions?.()[0]!.acquire();

      const rgb = new Uint8Array(4 * 4 * 3);
      runtime.setActiveAsset?.({
        assetId: "a1",
        width: 4,
        height: 4,
        readRgb: () => ({ width: 4, height: 4, rgb }),
      });

      const request: SuggestionRequest = {
        projectId: "p1",
        assetId: "a1",
        positive: [[1, 1]],
        negative: [],
        allowedGeometries: ["polygon"],
        adjustments: { tolerance: 2 },
      };

      await runtime.executorFor("efficient-sam-ti").suggest(request);
      await runtime.executorFor("efficient-sam-ti").suggest(request);

      expect(deps.prepareImage).toHaveBeenCalledTimes(1);
    });
  });
});
