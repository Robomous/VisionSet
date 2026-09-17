import { describe, expect, it, vi } from "vitest";
import type { PromptableSegmentationRuntime } from "@visionset/browser-inference";
import { ApiError } from "@visionset/ui-core";
import type { BrowserSuggestionAssetSource, SuggestionRequest } from "@visionset/ui-core";

import { createBrowserSuggestionExecutor } from "./BrowserSuggestionExecutor.js";

function requestFor(assetId: string, overrides?: Partial<SuggestionRequest>): SuggestionRequest {
  return {
    projectId: "p1",
    assetId,
    positive: [[10, 10]],
    negative: [],
    allowedGeometries: ["polygon"],
    adjustments: { tolerance: 2 },
    ...overrides,
  };
}

function sourceFor(assetId: string, rgb = new Uint8Array(3 * 4 * 4)): BrowserSuggestionAssetSource {
  return { assetId, width: 4, height: 4, readRgb: () => ({ width: 4, height: 4, rgb }) };
}

/**
 * A runtime whose two interesting methods the caller supplies.
 *
 * `ready`/`dispose` are stubbed rather than cast away, so a signature change on the
 * port breaks these tests instead of being hidden behind an `any`.
 */
function runtimeWith(parts: Partial<PromptableSegmentationRuntime>): PromptableSegmentationRuntime {
  return {
    ready: async () => [],
    prepareImage: async () => ({ width: 4, height: 4 }),
    suggest: async () => ({ width: 4, height: 4, mask: new Uint8Array(16), confidence: 0 }),
    dispose: () => undefined,
    ...parts,
  };
}

describe("createBrowserSuggestionExecutor", () => {
  it("refuses a negative-point request before touching the model", async () => {
    const prepareImage = vi.fn();
    const suggest = vi.fn();
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => sourceFor("a1"),
    });
    const request = requestFor("a1", { negative: [[1, 1]] });
    await expect(executor.suggest(request)).rejects.toBeInstanceOf(ApiError);
    await expect(executor.suggest(request)).rejects.toMatchObject({
      code: "BROWSER_NEGATIVE_POINTS_UNSUPPORTED",
    });
    expect(prepareImage).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
  });

  it("refuses when the active source's assetId does not match the request", async () => {
    const prepareImage = vi.fn();
    const suggest = vi.fn();
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => sourceFor("a1"),
    });
    await expect(executor.suggest(requestFor("a2"))).rejects.toThrow();
    expect(prepareImage).not.toHaveBeenCalled();
  });

  it("refuses when there is no active source at all", async () => {
    const prepareImage = vi.fn();
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage }),
      getActiveSource: () => null,
    });
    await expect(executor.suggest(requestFor("a1"))).rejects.toThrow();
    expect(prepareImage).not.toHaveBeenCalled();
  });

  it("prepares the image once for N refinements on the same source", async () => {
    const source = sourceFor("a1");
    const prepareImage = vi.fn().mockResolvedValue({ width: 4, height: 4 });
    const suggest = vi
      .fn()
      .mockResolvedValue({ width: 4, height: 4, mask: new Uint8Array(16), confidence: 0.8 });
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => source,
    });
    await executor.suggest(requestFor("a1"));
    await executor.suggest(
      requestFor("a1", {
        positive: [
          [10, 10],
          [12, 12],
        ],
      }),
    );
    expect(prepareImage).toHaveBeenCalledTimes(1);
    expect(suggest).toHaveBeenCalledTimes(2);
  });

  it("prepares each source separately, even for the same assetId", async () => {
    const prepareImage = vi.fn().mockResolvedValue({ width: 4, height: 4 });
    const suggest = vi
      .fn()
      .mockResolvedValue({ width: 4, height: 4, mask: new Uint8Array(16), confidence: 0.8 });
    let source = sourceFor("a1");
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => source,
    });
    await executor.suggest(requestFor("a1"));
    source = sourceFor("a1");
    await executor.suggest(requestFor("a1"));
    expect(prepareImage).toHaveBeenCalledTimes(2);
  });

  it("retries the encode after a failed prepareImage instead of replaying the rejection", async () => {
    const source = sourceFor("a1");
    const prepareImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("the encoder gave out"))
      .mockResolvedValue({ width: 4, height: 4 });
    const suggest = vi
      .fn()
      .mockResolvedValue({ width: 4, height: 4, mask: new Uint8Array(16).fill(1), confidence: 0.6 });
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => source,
    });

    await expect(executor.suggest(requestFor("a1"))).rejects.toThrow("the encoder gave out");
    expect(prepareImage).toHaveBeenCalledTimes(1);
    expect(suggest).not.toHaveBeenCalled();

    // The same still-active source, so a cached rejection would answer this without a second
    // encode. It gets a fresh one, and the click succeeds.
    const out = await executor.suggest(requestFor("a1"));
    expect(prepareImage).toHaveBeenCalledTimes(2);
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(out.confidence).toBe(0.6);

    // ...and the retry's embedding is cached in its turn: a third click re-decodes only.
    await executor.suggest(requestFor("a1"));
    expect(prepareImage).toHaveBeenCalledTimes(2);
    expect(suggest).toHaveBeenCalledTimes(2);
  });

  it("never lets a stale in-flight prepareImage answer for a source that changed underneath it", async () => {
    let resolvePrepare!: (value: { width: number; height: number }) => void;
    const prepareImage = vi
      .fn()
      .mockReturnValue(new Promise<{ width: number; height: number }>((resolve) => (resolvePrepare = resolve)));
    const suggest = vi.fn();
    let active: BrowserSuggestionAssetSource | null = sourceFor("a1");
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => active,
    });

    const pending = executor.suggest(requestFor("a1"));
    expect(prepareImage).toHaveBeenCalledTimes(1);
    active = sourceFor("b1"); // asset switch while prepareImage(a1) is still in flight
    resolvePrepare({ width: 4, height: 4 });

    await expect(pending).rejects.toThrow();
    expect(suggest).not.toHaveBeenCalled();
  });

  it("never lets a stale in-flight suggest paint onto a source that changed underneath it", async () => {
    let resolveSuggest!: (value: {
      width: number;
      height: number;
      mask: Uint8Array;
      confidence: number;
    }) => void;
    const prepareImage = vi.fn().mockResolvedValue({ width: 4, height: 4 });
    const suggest = vi.fn().mockReturnValue(
      new Promise<{ width: number; height: number; mask: Uint8Array; confidence: number }>(
        (resolve) => (resolveSuggest = resolve),
      ),
    );
    let active: BrowserSuggestionAssetSource | null = sourceFor("a1");
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => active,
    });

    const pending = executor.suggest(requestFor("a1"));
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    active = sourceFor("b1"); // asset switch while suggest(a1) is still in flight
    resolveSuggest({ width: 4, height: 4, mask: new Uint8Array(16).fill(1), confidence: 0.9 });

    await expect(pending).rejects.toThrow();
  });

  it("builds a SuggestionOut matching the authoritative shape: model_ref, confidence, regions, applied.tolerance, parameters", async () => {
    const source = sourceFor("a1");
    const prepareImage = vi.fn().mockResolvedValue({ width: 4, height: 4 });
    const mask = new Uint8Array(16).fill(1);
    const suggest = vi.fn().mockResolvedValue({ width: 4, height: 4, mask, confidence: 0.75 });
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => source,
    });

    const out = await executor.suggest(
      requestFor("a1", { allowedGeometries: ["polygon"], adjustments: { tolerance: 3 } }),
    );

    expect(out.model_ref).toBe("efficient-sam-ti@rev");
    expect(out.confidence).toBe(0.75);
    expect(out.applied).toEqual({ tolerance: 3 });
    expect(out.parameters).toEqual(["tolerance"]);
    expect(Array.isArray(out.regions)).toBe(true);
    expect(out.regions.length).toBeGreaterThan(0);
    for (const region of out.regions) {
      expect(region.geometry).toMatchObject({ type: "polygon" });
      expect(Array.isArray(region.contour)).toBe(true);
    }
    expect(out).not.toHaveProperty("regions.0.confidence");
  });

  it("passes the request's positive points and tolerance through to the geometry step", async () => {
    const source = sourceFor("a1");
    const mask = new Uint8Array(16).fill(1);
    const suggest = vi.fn().mockResolvedValue({ width: 4, height: 4, mask, confidence: 0.5 });
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({
        prepareImage: vi.fn().mockResolvedValue({ width: 4, height: 4 }),
        suggest,
      }),
      getActiveSource: () => source,
    });

    await executor.suggest(requestFor("a1", { positive: [[1, 1]] }));

    expect(suggest).toHaveBeenCalledWith(
      { width: 4, height: 4 },
      { positive: [[1, 1]], negative: [] },
    );
  });

  it("parameters is empty when polygon is not among the allowed geometries", async () => {
    const source = sourceFor("a1");
    const prepareImage = vi.fn().mockResolvedValue({ width: 4, height: 4 });
    const suggest = vi
      .fn()
      .mockResolvedValue({ width: 4, height: 4, mask: new Uint8Array(16).fill(1), confidence: 0.5 });
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => source,
    });
    const out = await executor.suggest(requestFor("a1", { allowedGeometries: ["bbox"] }));
    expect(out.parameters).toEqual([]);
  });

  it("reads the source's pixels for the encode", async () => {
    const rgb = new Uint8Array(3 * 4 * 4).fill(7);
    const source = sourceFor("a1", rgb);
    const prepareImage = vi.fn().mockResolvedValue({ width: 4, height: 4 });
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({
        prepareImage,
        suggest: vi
          .fn()
          .mockResolvedValue({ width: 4, height: 4, mask: new Uint8Array(16), confidence: 0.1 }),
      }),
      getActiveSource: () => source,
    });

    await executor.suggest(requestFor("a1"));

    expect(prepareImage).toHaveBeenCalledWith({ width: 4, height: 4, rgb });
  });
});
