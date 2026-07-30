/**
 * The frame conversion, and the one test that states what v1 got backwards: the
 * apparent grab radius is supposed to be the same at every zoom.
 */

import { describe, expect, it } from "vitest";

import {
  CLICK_SLOP_PX,
  CLOSE_POLYGON_TOLERANCE_PX,
  EDGE_TOLERANCE_PX,
  HANDLE_TOLERANCE_PX,
  SHAPE_TOLERANCE_PX,
  VERTEX_TOLERANCE_PX,
  assetTolerances,
  toleranceInAssetPixels,
} from "./tolerance";
import type { Tolerances } from "./tolerance";

describe("screen pixels become asset pixels once, at the boundary", () => {
  it("is the identity at a zoom of one", () => {
    expect(toleranceInAssetPixels(15, 1)).toBe(15);
  });

  it("shrinks the asset tolerance as the image is zoomed in", () => {
    expect(toleranceInAssetPixels(15, 2)).toBe(7.5);
  });

  it("grows it as the image is zoomed out", () => {
    expect(toleranceInAssetPixels(15, 0.5)).toBe(30);
  });

  it("holds the apparent grab radius constant across zoom, which v1 inverted", () => {
    // v1 compared an asset-pixel distance against a screen-pixel constant, so its
    // effective radius was `tolerance * zoom` — 4.5 screen px at 30% zoom, 30 at
    // 200%. Round-tripping through the zoom is the claim that this one does not.
    for (const zoom of [0.3, 0.5, 1, 2, 4] as const) {
      expect(toleranceInAssetPixels(EDGE_TOLERANCE_PX, zoom) * zoom).toBeCloseTo(
        EDGE_TOLERANCE_PX,
        10,
      );
    }
  });

  it("refuses a zoom of zero or less", () => {
    // v1 substituted 0.01 here, which turned a layout race into a hundredfold
    // tolerance and a click that selected something three shapes away.
    expect(() => toleranceInAssetPixels(15, 0)).toThrow(RangeError);
    expect(() => toleranceInAssetPixels(15, -1)).toThrow(RangeError);
  });

  it("refuses a zoom that is not a finite number", () => {
    expect(() => toleranceInAssetPixels(15, Number.NaN)).toThrow(RangeError);
    expect(() => toleranceInAssetPixels(15, Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });
});

describe("the tolerances themselves", () => {
  it("keeps v1's numbers where v1 had one", () => {
    expect(VERTEX_TOLERANCE_PX).toBe(6);
    expect(EDGE_TOLERANCE_PX).toBe(15);
    expect(CLOSE_POLYGON_TOLERANCE_PX).toBe(10);
  });

  it("keeps a handle no easier to grab than a vertex", () => {
    // Both are a grip a user aims at, so a difference between them would be a
    // behaviour nobody decided. v1 drew r=5 corners and r=4 midpoints and let the
    // browser hit-test the circles; that was a drawing decision, not this one.
    expect(HANDLE_TOLERANCE_PX).toBe(VERTEX_TOLERANCE_PX);
  });

  it("keeps a shape's outline the least greedy of them", () => {
    // A body hit is the fallback, so it must not out-compete a grip sitting on it.
    expect(SHAPE_TOLERANCE_PX).toBeLessThan(HANDLE_TOLERANCE_PX);
  });

  it("keeps v1's click slop, which is what tells a click from a pan", () => {
    expect(CLICK_SLOP_PX).toBe(3);
  });
});

describe("all six at once, which is the call an adapter actually makes", () => {
  /** Every field, so a constant added without a conversion fails to compile. */
  const SCREEN: Record<keyof Tolerances, number> = {
    handle: HANDLE_TOLERANCE_PX,
    vertex: VERTEX_TOLERANCE_PX,
    edge: EDGE_TOLERANCE_PX,
    closePolygon: CLOSE_POLYGON_TOLERANCE_PX,
    shape: SHAPE_TOLERANCE_PX,
    click: CLICK_SLOP_PX,
  };

  it("is the constants themselves at a zoom of one", () => {
    expect(assetTolerances(1)).toEqual(SCREEN);
  });

  it("converts every field, so none is left in the wrong unit", () => {
    // The failure a partial builder produces is a record whose fields are in two
    // different units — plausible field by field, and uniformly wrong.
    const converted = assetTolerances(2);
    for (const key of Object.keys(SCREEN) as readonly (keyof Tolerances)[]) {
      expect(converted[key], key).toBe(SCREEN[key] / 2);
    }
  });

  it("refuses a zoom the single conversion would refuse", () => {
    expect(() => assetTolerances(0)).toThrow(RangeError);
  });
});
