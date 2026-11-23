import { describe, expect, it } from "vitest";

import type { Point3D, Polyline3DGeometry } from "../types";
import {
  MIN_POLYLINE_VERTICES,
  insertPolylineVertex,
  isDrawablePolyline,
  movePolylineVertex,
  nearestSegment,
  removePolylineVertex,
} from "./polyline";

const A: Point3D = [0, 0, 0];
const B: Point3D = [10, 0, 0];
const C: Point3D = [10, 10, 0];

function line(...points: Point3D[]): Polyline3DGeometry {
  return { type: "polyline_3d", points, visibility: undefined };
}

describe("polyline vertex functions", () => {
  it("move changes only the indexed vertex", () => {
    const before = line(A, B, C);
    expect(movePolylineVertex(before, 1, [5, 5, 0]).points).toEqual([A, [5, 5, 0], C]);
    expect(before.points).toEqual([A, B, C]);
  });

  it("insert puts the point after the segment's start and keeps the order", () => {
    expect(insertPolylineVertex(line(A, B, C), 1, [10, 5, 0]).points).toEqual([A, B, [10, 5, 0], C]);
    expect(insertPolylineVertex(line(A, B), 0, [5, 0, 0]).points).toEqual([A, [5, 0, 0], B]);
  });

  it("remove drops one vertex, and refuses to leave fewer than two", () => {
    expect(MIN_POLYLINE_VERTICES).toBe(2);
    expect(removePolylineVertex(line(A, B, C), 1)?.points).toEqual([A, C]);
    expect(removePolylineVertex(line(A, B), 0)).toBeNull();
  });

  it("refuses a vertex or a segment the polyline does not have", () => {
    expect(() => removePolylineVertex(line(A, B, C), -1)).toThrow(RangeError);
    expect(() => removePolylineVertex(line(A, B, C), 3)).toThrow(RangeError);
    expect(() => movePolylineVertex(line(A, B), 2, C)).toThrow(RangeError);
    expect(() => insertPolylineVertex(line(A, B, C), 2, C)).toThrow(RangeError);
  });

  it("keeps a declared visibility aligned with the points", () => {
    const seen: Polyline3DGeometry = { ...line(A, B, C), visibility: [2, 1, 2] };
    expect(insertPolylineVertex(seen, 0, [5, 0, 0]).visibility).toEqual([2, 2, 1, 2]);
    expect(removePolylineVertex(seen, 1)?.visibility).toEqual([2, 2]);
    expect(movePolylineVertex(seen, 0, [1, 0, 0]).visibility).toEqual([2, 1, 2]);
  });

  it("drawable needs two vertices that are not all the same point", () => {
    expect(isDrawablePolyline([A])).toBe(false);
    expect(isDrawablePolyline([A, [0, 0, 0]])).toBe(false);
    expect(isDrawablePolyline([A, B])).toBe(true);
    expect(isDrawablePolyline([A, A, B])).toBe(true);
  });

  it("nearestSegment projects onto the closest segment, clamped to its ends", () => {
    expect(nearestSegment([A, B, C], [5, 2, 0])).toEqual({ segment: 0, point: [5, 0, 0], distance: 2 });
    expect(nearestSegment([A, B, C], [13, 6, 0])).toEqual({ segment: 1, point: [10, 6, 0], distance: 3 });
    expect(nearestSegment([A, B], [-3, 4, 0])).toEqual({ segment: 0, point: A, distance: 5 });
    expect(nearestSegment([A], [1, 1, 1])).toBeNull();
  });

  it("nearestSegment keeps the first of two equally close segments", () => {
    expect(nearestSegment([A, B, C], [12, -2, 0])?.segment).toBe(0);
    expect(nearestSegment([A, B, C], [10, 0, 0])?.segment).toBe(0);
  });

  it("nearestSegment survives a zero-length segment", () => {
    expect(nearestSegment([A, A], [0, 3, 4])).toEqual({ segment: 0, point: A, distance: 5 });
  });
});
