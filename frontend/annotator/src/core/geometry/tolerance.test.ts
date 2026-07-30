/**
 * The frame conversion, and the one test that states what v1 got backwards: the
 * apparent grab radius is supposed to be the same at every zoom.
 */

import { describe, expect, it } from "vitest";

import {
  CLOSE_POLYGON_TOLERANCE_PX,
  EDGE_TOLERANCE_PX,
  HANDLE_TOLERANCE_PX,
  SHAPE_TOLERANCE_PX,
  VERTEX_TOLERANCE_PX,
  toleranceInAssetPixels,
} from "./tolerance";

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
});
