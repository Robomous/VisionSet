import { describe, expect, it, vi } from "vitest";
import type { PromptableSegmentationRuntime } from "@visionset/browser-inference";
import { ApiError } from "@visionset/ui-core";
import type { BrowserSuggestionAssetSource, SuggestionRequest } from "@visionset/ui-core";

import { createBrowserSuggestionExecutor } from "./BrowserSuggestionExecutor.js";

interface Extent {
  readonly width: number;
  readonly height: number;
}

const SMALL: Extent = { width: 4, height: 4 };

/** `[1, 1]`, so the prompt lands genuinely *inside* even the smallest fixture mask. */
function requestFor(assetId: string, overrides?: Partial<SuggestionRequest>): SuggestionRequest {
  return {
    projectId: "p1",
    assetId,
    positive: [[1, 1]],
    negative: [],
    allowedGeometries: ["polygon"],
    adjustments: { tolerance: 2 },
    ...overrides,
  };
}

function sourceFor(
  assetId: string,
  extent: Extent = SMALL,
  rgb = new Uint8Array(extent.width * extent.height * 3),
): BrowserSuggestionAssetSource {
  return { assetId, ...extent, readRgb: () => ({ ...extent, rgb }) };
}

/** What the runtime answers with: a mask over `extent`, plus a confidence. */
function segmentationOf(extent: Extent, mask: Uint8Array, confidence: number) {
  return { ...extent, mask, confidence };
}

function solid(extent: Extent): Uint8Array {
  return new Uint8Array(extent.width * extent.height).fill(1);
}

function litRect(mask: Uint8Array, extent: Extent, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) mask[y * extent.width + x] = 1;
  }
}

/** The polygon's own points, after asserting the geometry really is one. */
function polygonPoints(geometry: unknown): readonly (readonly number[])[] {
  const shape = geometry as {
    readonly type?: unknown;
    readonly points?: readonly (readonly number[])[];
  };
  expect(shape.type).toBe("polygon");
  expect(shape.points).toBeDefined();
  return shape.points ?? [];
}

function xRangeOf(points: readonly (readonly number[])[]): { readonly min: number; readonly max: number } {
  const xs = points.map((point) => point[0] ?? NaN);
  return { min: Math.min(...xs), max: Math.max(...xs) };
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
    suggest: async () => segmentationOf(SMALL, solid(SMALL), 0),
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
      .mockResolvedValue(segmentationOf(SMALL, solid(SMALL), 0.8));
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => source,
    });
    await executor.suggest(requestFor("a1"));
    await executor.suggest(
      requestFor("a1", {
        positive: [
          [1, 1],
          [2, 2],
        ],
      }),
    );
    expect(prepareImage).toHaveBeenCalledTimes(1);
    expect(suggest).toHaveBeenCalledTimes(2);
  });

  it("re-prepares a source whose embedding a later source superseded", async () => {
    const first = sourceFor("a1");
    const second = sourceFor("b1");
    const prepareImage = vi.fn().mockResolvedValue({ width: 4, height: 4 });
    const suggest = vi.fn().mockResolvedValue(segmentationOf(SMALL, solid(SMALL), 0.4));
    let active = first;
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => active,
    });

    await executor.suggest(requestFor("a1"));
    expect(prepareImage).toHaveBeenCalledTimes(1);

    // Preparing another image invalidates the first handle inside the runtime.
    active = second;
    await executor.suggest(requestFor("b1"));
    expect(prepareImage).toHaveBeenCalledTimes(2);

    // Back to the *same object* as the first time. A per-source cache would hit here and hand
    // the runtime a handle it has already invalidated, forever. It gets a fresh encode.
    active = first;
    const out = await executor.suggest(requestFor("a1"));
    expect(prepareImage).toHaveBeenCalledTimes(3);
    expect(out.confidence).toBe(0.4);

    // Still one encode per source, though: a refinement click on the live source re-decodes only.
    await executor.suggest(requestFor("a1", { positive: [[2, 2]] }));
    expect(prepareImage).toHaveBeenCalledTimes(3);
    expect(suggest).toHaveBeenCalledTimes(4);
  });

  it("prepares each source separately, even for the same assetId", async () => {
    const prepareImage = vi.fn().mockResolvedValue({ width: 4, height: 4 });
    const suggest = vi
      .fn()
      .mockResolvedValue(segmentationOf(SMALL, solid(SMALL), 0.8));
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
      .mockResolvedValue(segmentationOf(SMALL, solid(SMALL), 0.6));
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

  it("does not let a failed encode evict a newer source's good embedding", async () => {
    let rejectFirst!: (error: Error) => void;
    const prepareImage = vi
      .fn()
      .mockReturnValueOnce(new Promise<{ width: number; height: number }>((_, reject) => (rejectFirst = reject)))
      .mockResolvedValue({ width: 4, height: 4 });
    const suggest = vi.fn().mockResolvedValue(segmentationOf(SMALL, solid(SMALL), 0.3));
    const first = sourceFor("a1");
    const second = sourceFor("b1");
    let active = first;
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => active,
    });

    const pending = executor.suggest(requestFor("a1")); // encode for A, left in flight
    active = second;
    await executor.suggest(requestFor("b1")); // encode for B, which succeeds and takes the slot
    expect(prepareImage).toHaveBeenCalledTimes(2);

    rejectFirst(new Error("the first encode gave out"));
    await expect(pending).rejects.toThrow("the first encode gave out");

    // A's failure must clear only *its own* slot, and B has since taken it. Re-encoding B here
    // would be a needless second encode of an image the runtime is already holding.
    await executor.suggest(requestFor("b1"));
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
    resolveSuggest(segmentationOf(SMALL, solid(SMALL), 0.9));

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

  it("hands the model the request's prompt verbatim, with no coordinate conversion", async () => {
    const source = sourceFor("a1");
    const suggest = vi.fn().mockResolvedValue(segmentationOf(SMALL, solid(SMALL), 0.5));
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({
        prepareImage: vi.fn().mockResolvedValue({ width: 4, height: 4 }),
        suggest,
      }),
      getActiveSource: () => source,
    });

    await executor.suggest(requestFor("a1", { positive: [[1, 1]] }));

    // Tuples straight through — not `{x, y}` objects, and not re-scaled to the model's frame.
    expect(suggest).toHaveBeenCalledWith(
      { width: 4, height: 4 },
      { positive: [[1, 1]], negative: [] },
    );
  });

  /**
   * The prompt reaching the *model* is not the same claim as the prompt reaching the
   * *geometry* step, and a solid mask cannot tell the two apart — every `at` selects the one
   * component and every tolerance simplifies a rectangle identically. These two use fixtures
   * that can actually discriminate.
   */
  it("derives the geometry from the mask component the prompt points at", async () => {
    const extent: Extent = { width: 8, height: 8 };
    const mask = new Uint8Array(extent.width * extent.height);
    litRect(mask, extent, 1, 1, 2, 2); // one square, top-left
    litRect(mask, extent, 5, 5, 2, 2); // a second, disjoint, exactly the same area
    const source = sourceFor("a1", extent);
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({
        prepareImage: vi.fn().mockResolvedValue(extent),
        suggest: vi.fn().mockResolvedValue(segmentationOf(extent, mask, 0.5)),
      }),
      getActiveSource: () => source,
    });

    const geometryAt = async (point: readonly [number, number]) => {
      const out = await executor.suggest(
        requestFor("a1", { positive: [point], adjustments: { tolerance: 1 } }),
      );
      expect(out.regions).toHaveLength(1);
      return polygonPoints(out.regions[0]?.geometry);
    };

    const nearOrigin = xRangeOf(await geometryAt([1, 1]));
    const farCorner = xRangeOf(await geometryAt([6, 6]));

    // Equal-area components, so "the largest piece" cannot discriminate them: the answers can
    // only differ if `at` is what selected the piece. They are disjoint along x.
    expect(nearOrigin.max).toBeLessThan(farCorner.min);
    expect(nearOrigin.min).toBeGreaterThanOrEqual(1);
    expect(nearOrigin.max).toBeLessThanOrEqual(3);
    expect(farCorner.min).toBeGreaterThanOrEqual(5);
    expect(farCorner.max).toBeLessThanOrEqual(7);
  });

  it("simplifies the outline more aggressively at a coarser tolerance", async () => {
    const extent: Extent = { width: 24, height: 24 };
    const mask = new Uint8Array(extent.width * extent.height);
    const centre = 11.5;
    for (let y = 0; y < extent.height; y += 1) {
      for (let x = 0; x < extent.width; x += 1) {
        // A rough disc: a stair-stepped boundary with far more vertices than a rectangle's,
        // which is what gives Douglas-Peucker something to actually remove.
        if (Math.hypot(x - centre, y - centre) <= 9.3) mask[y * extent.width + x] = 1;
      }
    }
    const source = sourceFor("a1", extent);
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({
        prepareImage: vi.fn().mockResolvedValue(extent),
        suggest: vi.fn().mockResolvedValue(segmentationOf(extent, mask, 0.5)),
      }),
      getActiveSource: () => source,
    });

    const answerAt = async (tolerance: number) => {
      const out = await executor.suggest(
        requestFor("a1", { positive: [[11, 11]], adjustments: { tolerance } }),
      );
      expect(out.applied).toEqual({ tolerance });
      const region = out.regions[0];
      expect(region).toBeDefined();
      return { points: polygonPoints(region?.geometry), contour: region?.contour ?? [] };
    };

    const fine = await answerAt(1); // the default
    const coarse = await answerAt(16); // MAXIMUM_TOLERANCE

    // 11 points against 3, on this fixture. Asserted as the relation rather than the two
    // numbers: the counts belong to the annotator's simplifier, which is pinned to the
    // server's Python by its own fixture, not by this test.
    expect(fine.points.length).toBeGreaterThan(coarse.points.length);
    expect(coarse.points.length).toBeGreaterThanOrEqual(3);
    // The *unsimplified* outline is identical either way, so what differs is the tolerance
    // doing work downstream of the mask, not a different mask or a different component.
    expect(fine.contour).toEqual(coarse.contour);
    expect(fine.contour.length).toBeGreaterThan(fine.points.length);
  });

  it("parameters is empty when polygon is not among the allowed geometries", async () => {
    const source = sourceFor("a1");
    const prepareImage = vi.fn().mockResolvedValue({ width: 4, height: 4 });
    const suggest = vi
      .fn()
      .mockResolvedValue(segmentationOf(SMALL, solid(SMALL), 0.5));
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({ prepareImage, suggest }),
      getActiveSource: () => source,
    });
    const out = await executor.suggest(requestFor("a1", { allowedGeometries: ["bbox"] }));
    expect(out.parameters).toEqual([]);
  });

  it("reads the source's pixels for the encode", async () => {
    const rgb = new Uint8Array(SMALL.width * SMALL.height * 3).fill(7);
    const source = sourceFor("a1", SMALL, rgb);
    const prepareImage = vi.fn().mockResolvedValue({ width: 4, height: 4 });
    const executor = createBrowserSuggestionExecutor({
      modelRef: "efficient-sam-ti@rev",
      runtime: runtimeWith({
        prepareImage,
        suggest: vi
          .fn()
          .mockResolvedValue(segmentationOf(SMALL, solid(SMALL), 0.1)),
      }),
      getActiveSource: () => source,
    });

    await executor.suggest(requestFor("a1"));

    expect(prepareImage).toHaveBeenCalledWith({ width: 4, height: 4, rgb });
  });
});
