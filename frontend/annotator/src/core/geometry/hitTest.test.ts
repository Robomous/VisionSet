/**
 * What a click means. The tie-breaks and the degeneracies get deterministic cases
 * here rather than a property test: the only oracle available for a hit test is a
 * brute-force recomputation near-identical to the implementation, which would
 * assert that the code equals itself.
 */

import { describe, expect, it } from "vitest";

import type { Annotation, BboxGeometry, Geometry, Point } from "../types";
import { BBOX_HANDLES } from "./bbox";
import {
  geometryContains,
  nearestEdge,
  nearestHandle,
  nearestVertex,
  topmostAnnotationAt,
} from "./hitTest";

/** A 100-square at the origin, as a point list. */
const SQUARE: readonly Point[] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

function bbox(
  x: number,
  y: number,
  width: number,
  height: number,
): BboxGeometry {
  return { type: "bbox", x, y, width, height };
}

function annotationOf(id: string, geometry: Geometry): Annotation {
  return {
    id,
    asset_id: "asset-1",
    label_class: "sign",
    schema_version: 1,
    geometry,
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
  };
}

describe("finding the vertex under the pointer", () => {
  it("answers the nearest one and where it sits", () => {
    expect(nearestVertex(SQUARE, [98, 3], 6)).toEqual({
      index: 1,
      point: [100, 0],
      distance: Math.sqrt(4 + 9),
    });
  });

  it("answers nothing beyond the tolerance", () => {
    expect(nearestVertex(SQUARE, [50, 50], 6)).toBeNull();
    expect(nearestVertex(SQUARE, [107, 0], 6)).toBeNull();
  });

  it("counts a point exactly at the tolerance as a hit", () => {
    expect(nearestVertex(SQUARE, [106, 0], 6)?.index).toBe(1);
  });

  it("gives a tie to the lower index", () => {
    // Equidistant from vertex 0 and vertex 1. v1's `d < minDist` keeps the first.
    expect(nearestVertex(SQUARE, [50, 0], 60)?.index).toBe(0);
  });

  it("answers nothing for an empty list", () => {
    expect(nearestVertex([], [0, 0], 999)).toBeNull();
  });
});

describe("finding the edge under the pointer", () => {
  it("answers the edge's start vertex and the projection onto it", () => {
    expect(nearestEdge(SQUARE, [50, 3], 6)).toEqual({
      index: 0,
      point: [50, 0],
      distance: 3,
    });
  });

  it("numbers the closing edge last", () => {
    // The implicit edge from the final vertex back to the first.
    expect(nearestEdge(SQUARE, [3, 50], 6)?.index).toBe(3);
  });

  it("answers nothing beyond the tolerance", () => {
    expect(nearestEdge(SQUARE, [50, 50], 6)).toBeNull();
  });

  it("survives an edge whose ends coincide", () => {
    // A duplicated vertex. Without closestPointOnSegment's zero-length guard this
    // divides by zero and every distance downstream is NaN.
    const pinched: readonly Point[] = [
      [0, 0],
      [50, 0],
      [50, 0],
      [0, 50],
    ];
    const hit = nearestEdge(pinched, [52, 2], 6);
    expect(hit).not.toBeNull();
    expect(Number.isNaN(hit?.distance)).toBe(false);
  });

  it("treats a single point as one zero-length edge", () => {
    expect(nearestEdge([[7, 7]], [8, 8], 6)).toEqual({
      index: 0,
      point: [7, 7],
      distance: Math.sqrt(2),
    });
  });

  it("gives two coincident edges to the lower index", () => {
    // Two points closed is the same segment twice, forward and back.
    expect(nearestEdge([[0, 0], [100, 0]], [50, 1], 6)?.index).toBe(0);
  });

  it("answers nothing for an empty list", () => {
    expect(nearestEdge([], [0, 0], 999)).toBeNull();
  });
});

describe("finding the handle under the pointer", () => {
  const box = bbox(100, 200, 40, 80);

  it("answers each of the eight from its own position", () => {
    const expected: Readonly<Record<string, Point>> = {
      nw: [100, 200],
      n: [120, 200],
      ne: [140, 200],
      e: [140, 240],
      se: [140, 280],
      s: [120, 280],
      sw: [100, 280],
      w: [100, 240],
    };
    for (const handle of BBOX_HANDLES) {
      const at = expected[handle];
      const hit = nearestHandle(box, [at[0] + 1, at[1]], 6);
      expect(hit?.handle).toBe(handle);
      expect(hit?.point).toEqual(at);
    }
  });

  it("answers nothing beyond the tolerance", () => {
    expect(nearestHandle(box, [120, 240], 6)).toBeNull();
  });

  it("answers deterministically when a tiny box's handles overlap", () => {
    // All eight collapse onto one point, so every distance ties. BBOX_HANDLES'
    // order decides, which is why that order is documented as the tie-break.
    expect(nearestHandle(bbox(9, 9, 0, 0), [9, 9], 6)?.handle).toBe("nw");
  });
});

describe("what a click means", () => {
  it("picks a box by its inside", () => {
    expect(geometryContains(bbox(0, 0, 100, 100), [50, 50], 4)).toBe(true);
  });

  it("picks a box by its outline when the click missed the inside", () => {
    expect(geometryContains(bbox(0, 0, 100, 100), [-3, 50], 4)).toBe(true);
    expect(geometryContains(bbox(0, 0, 100, 100), [-5, 50], 4)).toBe(false);
  });

  it("picks a box with no area, because that is the one you need to delete", () => {
    // Reachable off the wire, and unclickable under an inside-only test.
    expect(geometryContains(bbox(50, 50, 0, 0), [52, 50], 4)).toBe(true);
  });

  it("picks a polygon by its inside and by its outline", () => {
    const shape: Geometry = { type: "polygon", points: SQUARE };
    expect(geometryContains(shape, [50, 50], 4)).toBe(true);
    expect(geometryContains(shape, [50, 103], 4)).toBe(true);
    expect(geometryContains(shape, [50, 110], 4)).toBe(false);
  });

  it("picks a polygon too small to have an inside", () => {
    // Two points and one point both load; neither can ever be "inside".
    expect(
      geometryContains({ type: "polygon", points: [[0, 0], [100, 0]] }, [50, 2], 4),
    ).toBe(true);
    expect(
      geometryContains({ type: "polygon", points: [[10, 10]] }, [12, 10], 4),
    ).toBe(true);
    expect(
      geometryContains({ type: "polygon", points: [[10, 10]] }, [20, 10], 4),
    ).toBe(false);
  });

  it("finds nothing in a polygon with no points at all", () => {
    expect(geometryContains({ type: "polygon", points: [] }, [0, 0], 4)).toBe(false);
  });

  it("never picks a classification tag", () => {
    // It has no coordinates, so selecting one is a class-list interaction.
    expect(geometryContains({ type: "classification_tag" }, [0, 0], 9999)).toBe(false);
  });
});

describe("picking the topmost annotation", () => {
  const under = annotationOf("under", bbox(0, 0, 100, 100));
  const over = annotationOf("over", bbox(50, 50, 100, 100));
  const drawOrder = [under, over] as const;

  it("prefers the one painted last where they overlap", () => {
    expect(topmostAnnotationAt(drawOrder, [75, 75], 4)?.id).toBe("over");
  });

  it("still finds the lower one where the upper is not", () => {
    expect(topmostAnnotationAt(drawOrder, [10, 10], 4)?.id).toBe("under");
  });

  it("answers nothing over empty canvas", () => {
    expect(topmostAnnotationAt(drawOrder, [400, 400], 4)).toBeNull();
    expect(topmostAnnotationAt([], [0, 0], 4)).toBeNull();
  });

  it("skips a classification tag sitting on top of everything", () => {
    const tagged = [under, annotationOf("tag", { type: "classification_tag" })];
    expect(topmostAnnotationAt(tagged, [10, 10], 4)?.id).toBe("under");
  });
});
