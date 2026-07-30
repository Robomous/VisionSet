/**
 * The polygon. Two of these are about behaviour v1 got wrong — the flattening
 * against a frame edge, and who decides that a triangle cannot lose a vertex —
 * and are named so a reader knows they are choices rather than transcriptions.
 */

import { describe, expect, it } from "vitest";

import type { PolygonGeometry, Point } from "../types";
import {
  MIN_POLYGON_POINTS,
  insertPolygonVertex,
  movePolygonVertex,
  polygonBbox,
  polygonContains,
  removePolygonVertex,
  translatePolygon,
} from "./polygon";
import type { Bounds } from "./primitives";

const FRAME: Bounds = { width: 640, height: 480 };

function polygon(...points: readonly Point[]): PolygonGeometry {
  return { type: "polygon", points };
}

/** A 100×100 square with its corner at (100, 100). */
const SQUARE = polygon([100, 100], [200, 100], [200, 200], [100, 200]);

/** Every vertex's offset from the first — what a rigid move must preserve. */
function shapeOf(value: PolygonGeometry): readonly Point[] {
  const [ox, oy] = value.points[0];
  return value.points.map(([x, y]): Point => [x - ox, y - oy]);
}

describe("what a polygon contains", () => {
  it("holds a point inside a convex shape and not one outside", () => {
    expect(polygonContains(SQUARE, [150, 150])).toBe(true);
    expect(polygonContains(SQUARE, [50, 150])).toBe(false);
    expect(polygonContains(SQUARE, [250, 150])).toBe(false);
    expect(polygonContains(SQUARE, [150, 50])).toBe(false);
    expect(polygonContains(SQUARE, [150, 250])).toBe(false);
  });

  it("leaves the notch of a concave shape outside", () => {
    // An L. A bounding-box test would call the notch inside, which is the whole
    // reason a real ray cast is needed rather than polygonBbox + bboxContains.
    const ell = polygon([0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]);
    expect(polygonContains(ell, [20, 20])).toBe(true);
    expect(polygonContains(ell, [20, 80])).toBe(true);
    expect(polygonContains(ell, [80, 20])).toBe(true);
    expect(polygonContains(ell, [80, 80])).toBe(false);
  });

  it("reads a doubled-back shape's middle as a hole, the way SVG paints it", () => {
    // A 100-square whose path returns to the origin and traces a second, smaller
    // square in the same direction. Even-odd — SVG's default fill-rule — makes the
    // inner square a hole; a nonzero winding rule would fill it. So what a user
    // clicks agrees with what a user sees.
    const holed = polygon(
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
      [0, 0],
      [25, 25],
      [75, 25],
      [75, 75],
      [25, 75],
    );
    expect(polygonContains(holed, [10, 50])).toBe(true);
    expect(polygonContains(holed, [50, 50])).toBe(false);
  });

  it("is never inside a polygon of fewer than three points", () => {
    // Both are loadable: parseGeometry imposes no arity rule.
    expect(polygonContains(polygon(), [0, 0])).toBe(false);
    expect(polygonContains(polygon([5, 5]), [5, 5])).toBe(false);
    expect(polygonContains(polygon([0, 0], [10, 10]), [5, 5])).toBe(false);
  });

  it("does not divide by zero on a horizontal edge", () => {
    // Every edge of this one is axis-aligned, so two of the four have yi === yj.
    // That makes both sides of the straddle test equal, the comparison false and
    // the divide unreachable — the guard is the only reason there is no NaN here,
    // and an interior point still answers cleanly.
    const flat = polygon([0, 0], [100, 0], [100, 50], [0, 50]);
    expect(polygonContains(flat, [50, 25])).toBe(true);
    expect(polygonContains(flat, [50, 60])).toBe(false);
    expect(polygonContains(flat, [-1, 25])).toBe(false);
  });

  it("is half-open on the outline, which is why a hit test adds a tolerance", () => {
    // A ray cast has to pick a side for a point exactly on the boundary, and the
    // `>` straddle test picks the low one: the top and left edges read as inside,
    // the bottom and right as outside. Deterministic, so it is written down rather
    // than left to be rediscovered — and it is why selecting a shape goes through
    // `geometryContains`, which is forgiving by a tolerance in both directions.
    const flat = polygon([0, 0], [100, 0], [100, 50], [0, 50]);
    expect(polygonContains(flat, [50, 0])).toBe(true);
    expect(polygonContains(flat, [0, 25])).toBe(true);
    expect(polygonContains(flat, [50, 50])).toBe(false);
    expect(polygonContains(flat, [100, 25])).toBe(false);
  });
});

describe("the box around a polygon", () => {
  it("is the extent of its vertices", () => {
    expect(polygonBbox(SQUARE)).toEqual({
      type: "bbox",
      x: 100,
      y: 100,
      width: 100,
      height: 100,
    });
  });

  it("collapses to a point for a single vertex", () => {
    expect(polygonBbox(polygon([7, 9]))).toEqual({
      type: "bbox",
      x: 7,
      y: 9,
      width: 0,
      height: 0,
    });
  });

  it("answers a zero box at the origin for no vertices at all", () => {
    expect(polygonBbox(polygon())).toEqual({
      type: "bbox",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("moving a polygon moves it rigidly", () => {
  it("puts its box where it was asked to", () => {
    expect(translatePolygon(SQUARE, [0, 0], FRAME)).toEqual(
      polygon([0, 0], [100, 0], [100, 100], [0, 100]),
    );
  });

  it("stops at each frame edge rather than hanging over it", () => {
    for (const origin of [
      [-999, 100],
      [100, -999],
      [9999, 100],
      [100, 9999],
    ] as const) {
      const moved = translatePolygon(SQUARE, origin, FRAME);
      const extent = polygonBbox(moved);
      expect(extent.x).toBeGreaterThanOrEqual(0);
      expect(extent.y).toBeGreaterThanOrEqual(0);
      expect(extent.x + extent.width).toBeLessThanOrEqual(FRAME.width);
      expect(extent.y + extent.height).toBeLessThanOrEqual(FRAME.height);
    }
  });

  it("keeps its shape against the frame edge, which v1 did not", () => {
    // v1 clamped each vertex on its own, so this drag piled all four onto x = 0
    // and the square became a line — irreversibly, since pointer-up committed it.
    const moved = translatePolygon(SQUARE, [-9999, -9999], FRAME);
    expect(moved).toEqual(polygon([0, 0], [100, 0], [100, 100], [0, 100]));
    expect(shapeOf(moved)).toEqual(shapeOf(SQUARE));
  });

  it("preserves every pairwise offset wherever it lands", () => {
    for (const origin of [
      [-999, -999],
      [9999, 9999],
      [0, 0],
      [321, 123],
    ] as const) {
      expect(shapeOf(translatePolygon(SQUARE, origin, FRAME))).toEqual(
        shapeOf(SQUARE),
      );
    }
  });

  it("pins a polygon wider than its asset rather than deforming it", () => {
    const huge = polygon([0, 0], [900, 0], [900, 900]);
    expect(translatePolygon(huge, [500, 500], FRAME)).toEqual(huge);
  });

  it("is a fixpoint, so a re-projected drag cannot drift", () => {
    const once = translatePolygon(SQUARE, [9999, 9999], FRAME);
    expect(translatePolygon(once, [9999, 9999], FRAME)).toEqual(once);
  });

  it("translates nothing when there is nothing to translate", () => {
    expect(translatePolygon(polygon(), [50, 50], FRAME)).toEqual(polygon());
  });
});

describe("editing vertices", () => {
  it("moves the one it was given and leaves the rest", () => {
    expect(movePolygonVertex(SQUARE, 2, [300, 400], FRAME)).toEqual(
      polygon([100, 100], [200, 100], [300, 400], [100, 200]),
    );
  });

  it("clamps a vertex dragged off the image into the frame", () => {
    expect(movePolygonVertex(SQUARE, 0, [-50, 9999], FRAME)).toEqual(
      polygon([0, FRAME.height], [200, 100], [200, 200], [100, 200]),
    );
  });

  it("inserts on the edge closest to where it was told, in order", () => {
    // Edge 0 runs (100,100) → (200,100); the projection of (150, 130) is (150,100).
    expect(insertPolygonVertex(SQUARE, 0, [150, 130])).toEqual(
      polygon([100, 100], [150, 100], [200, 100], [200, 200], [100, 200]),
    );
  });

  it("appends when the edge is the closing one", () => {
    // Edge 3 runs (100,200) → (100,100), the implicit closing edge.
    expect(insertPolygonVertex(SQUARE, 3, [60, 150])).toEqual(
      polygon([100, 100], [200, 100], [200, 200], [100, 200], [100, 150]),
    );
  });

  it("lands the new vertex on the segment even when the point is past its end", () => {
    expect(insertPolygonVertex(SQUARE, 0, [9999, 9999]).points[1]).toEqual([200, 100]);
  });

  it("duplicates a vertex when the edge has no length", () => {
    // Allowed rather than refused: the wire format permits a repeated point, so
    // inventing a rule here would refuse data the kernel accepts.
    const pinched = polygon([0, 0], [50, 0], [50, 0], [0, 50]);
    expect(insertPolygonVertex(pinched, 1, [40, 40]).points).toEqual([
      [0, 0],
      [50, 0],
      [50, 0],
      [50, 0],
      [0, 50],
    ]);
  });

  it("adds exactly one point and keeps the originals in order", () => {
    const grown = insertPolygonVertex(SQUARE, 1, [220, 150]);
    expect(grown.points).toHaveLength(SQUARE.points.length + 1);
    expect(grown.points.filter((_, at) => at !== 2)).toEqual(SQUARE.points);
  });

  it("removes exactly one point", () => {
    const five = insertPolygonVertex(SQUARE, 0, [150, 130]);
    expect(removePolygonVertex(five, 1)).toEqual(SQUARE);
  });

  it("answers null at the minimum rather than deleting the annotation itself", () => {
    // v1 removed the whole annotation here, in four copies, from inside a pointer
    // handler. That is #45's call: one command, one undo step, one place to tell
    // the user.
    const triangle = polygon([0, 0], [10, 0], [0, 10]);
    expect(triangle.points).toHaveLength(MIN_POLYGON_POINTS);
    expect(removePolygonVertex(triangle, 0)).toBeNull();
    expect(removePolygonVertex(triangle, 2)).toBeNull();
  });

  it("refuses an index it does not have", () => {
    expect(() => movePolygonVertex(SQUARE, 4, [0, 0], FRAME)).toThrow(RangeError);
    expect(() => movePolygonVertex(SQUARE, -1, [0, 0], FRAME)).toThrow(RangeError);
    expect(() => insertPolygonVertex(SQUARE, 9, [0, 0])).toThrow(RangeError);
    expect(() => removePolygonVertex(SQUARE, 9)).toThrow(RangeError);
    expect(() => movePolygonVertex(polygon(), 0, [0, 0], FRAME)).toThrow(RangeError);
    expect(() => movePolygonVertex(SQUARE, 1.5, [0, 0], FRAME)).toThrow(RangeError);
  });

  it("never mutates the polygon it was given", () => {
    const before = JSON.stringify(SQUARE);
    movePolygonVertex(SQUARE, 0, [1, 1], FRAME);
    insertPolygonVertex(SQUARE, 0, [150, 130]);
    removePolygonVertex(SQUARE, 0);
    translatePolygon(SQUARE, [0, 0], FRAME);
    expect(JSON.stringify(SQUARE)).toBe(before);
  });
});
