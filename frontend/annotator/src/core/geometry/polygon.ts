/**
 * The polygon as a value: what it contains, and the four edits a pointer can make
 * to it.
 *
 * Almost none of this could be copied. v1's polygon work lived inside
 * `AnnotationCanvas.tsx`'s pointer handlers, and the one thing it did have as a
 * function — `findNearestEdgeIndex` — is a hit test and lives in `hitTest.ts`.
 * `polygonContains` had no v1 counterpart at all: an SVG `<polygon>` element did
 * the browser's own hit testing, which is exactly the capability a headless engine
 * does not have.
 *
 * ## A move is rigid, and v1's was not
 *
 * v1 clamped **each vertex independently** (`AnnotationCanvas.tsx:648`), so
 * dragging a polygon against an image edge piled its vertices onto that edge and
 * flattened the shape — permanently, since pointer-up committed whatever was
 * there. The relative positions of the vertices are the data the user drew, and a
 * move is by definition the transform that does not change them, so
 * `translatePolygon` clamps the *translation* instead: it moves the polygon's own
 * bounding box the way `moveBbox` moves a box, and every vertex takes the same
 * offset.
 *
 * That makes polygon move consistent with v1's own bbox move, which already
 * clamped the origin rather than the corners. The consequence, stated: a polygon
 * wider than its asset pins at 0 and cannot move on that axis, rather than
 * deforming — the same call `moveBbox` makes, for the same reason.
 *
 * ## Falling below three points is not this module's decision
 *
 * v1 deleted the **whole annotation** when a triangle's vertex was removed, in
 * four separate copies of the same `if (pts.length <= 3)`, each inside a pointer
 * handler. `removePolygonVertex` answers `null` instead and leaves the choice to
 * the tool.
 *
 * **#44 made that call, and it is not v1's**: the delete is refused, and the polygon
 * stays a triangle. A gesture that escalates from "remove this vertex" to "remove
 * the shape" at a boundary nobody can see is a surprise, and the remedy for deleting
 * a polygon is already explicit elsewhere. The argument in full, including the
 * ctrl-click double-fire it also avoids, is in `machine.ts`'s `deleteVertex`. This
 * paragraph previously predicted the opposite and is corrected rather than removed,
 * because the prediction is why the `null` is here at all.
 *
 * ## What is deliberately not here
 *
 * `insertPolygonVertex` takes no `bounds`. The new vertex is a convex combination
 * of two existing ones, so it provably cannot leave a frame those two are already
 * inside; `noUnusedParameters` turns adding one "for symmetry" into a compile
 * error, and this paragraph is why nobody should.
 *
 * It also refuses nothing. v1 bailed out of an edge insert when the click was
 * within 6 px of an existing vertex — that is a tool's reading of a double-click,
 * built on `nearestVertex` — #42's `nearestInsertion` is where it lives — and
 * not a fact about polygons.
 *
 * There is no self-intersection check and no winding rule. `polygonContains` is
 * even-odd, which is what SVG's default `fill-rule` draws, so what a user clicks
 * matches what a user sees.
 */

import type {
  BboxGeometry,
  PolygonGeometry,
  PolylineGeometry,
  Point,
} from "../types";
import { clamp } from "./clamp";
import { clampPoint, closestPointOnSegment, type Bounds } from "./primitives";

/** The fewest points a polygon may carry. Below it there is no polygon left. */
export const MIN_POLYGON_POINTS = 3;

/** The index a polygon edit was given, checked against the points it actually has. */
function requireIndex(polygon: PolygonGeometry, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= polygon.points.length) {
    throw new RangeError(
      `polygon vertex ${index} is out of range — this polygon has ${polygon.points.length}`,
    );
  }
}

/**
 * Is the point inside the polygon?
 *
 * Even-odd ray casting, matching SVG's default `fill-rule`, so a self-intersecting
 * shape's holes read the same way they are drawn. Fewer than three points is never
 * inside — declared rather than left to fall out of the loop, because such a
 * polygon is loadable (`parseGeometry` imposes no arity rule) and its answer should
 * not be an accident. `geometryContains` is what still lets a user click one.
 */
export function polygonContains(polygon: PolygonGeometry, point: Point): boolean {
  const points = polygon.points;
  if (points.length < MIN_POLYGON_POINTS) return false;

  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    // The straddle test is what makes the division safe: a horizontal edge has
    // yi === yj, and then both sides of the comparison are equal, so it is false
    // and the divide is never reached.
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The axis-aligned box that exactly contains the polygon — what a rigid move
 * clamps, and what a renderer measures a label against.
 *
 * An empty polygon answers a 0×0 box at the origin. It has no extent to report and
 * throwing would make the one honest caller — a move, which then translates
 * nothing — into a special case.
 */
export function polygonBbox(polygon: PolygonGeometry | PolylineGeometry): BboxGeometry {
  if (polygon.points.length === 0) {
    return { type: "bbox", x: 0, y: 0, width: 0, height: 0 };
  }
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const [x, y] of polygon.points) {
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return { type: "bbox", x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Every vertex moved by one offset, so the polygon's own bounding box lands at
 * `origin`, clamped to keep the whole shape inside `bounds`.
 *
 * Rigid: every pairwise distance survives. `origin` is a destination, not a delta —
 * a tool derives it from the polygon the gesture began on. A polygon wider than its
 * asset pins to 0 on that axis rather than deforming.
 */
export function translatePolygon(
  polygon: PolygonGeometry,
  origin: Point,
  bounds: Bounds,
): PolygonGeometry {
  const extent = polygonBbox(polygon);
  const targetX = clamp(origin[0], 0, Math.max(0, bounds.width - extent.width));
  const targetY = clamp(origin[1], 0, Math.max(0, bounds.height - extent.height));
  const dx = targetX - extent.x;
  const dy = targetY - extent.y;
  return {
    type: "polygon",
    points: polygon.points.map(([x, y]): Point => [x + dx, y + dy]),
  };
}

/**
 * Vertex `index` moved to `point`, clamped into `bounds`. Every other vertex is
 * untouched — this is the one edit that is allowed to change the shape.
 */
export function movePolygonVertex(
  polygon: PolygonGeometry,
  index: number,
  point: Point,
  bounds: Bounds,
): PolygonGeometry {
  requireIndex(polygon, index);
  const moved = clampPoint(point, bounds);
  return {
    type: "polygon",
    points: polygon.points.map((vertex, at) => (at === index ? moved : vertex)),
  };
}

/**
 * A vertex inserted after vertex `index`, at the point of edge `index → index + 1`
 * closest to `point`.
 *
 * Edge `length - 1` is the closing edge, so inserting on it appends. The new vertex
 * is the perpendicular projection, which is why it needs no bounds; an edge whose
 * two ends coincide yields a duplicate of them, which is allowed — refusing would
 * invent a rule the wire format does not have.
 */
export function insertPolygonVertex(
  polygon: PolygonGeometry,
  index: number,
  point: Point,
): PolygonGeometry {
  requireIndex(polygon, index);
  const points = polygon.points;
  const from = points[index];
  const to = points[(index + 1) % points.length];
  const inserted = closestPointOnSegment(point, from, to);
  return {
    type: "polygon",
    points: [...points.slice(0, index + 1), inserted, ...points.slice(index + 1)],
  };
}

/**
 * Vertex `index` dropped, or `null` when the polygon is already at
 * `MIN_POLYGON_POINTS` and there is nothing left to drop it from.
 *
 * `null` means "this polygon cannot survive the edit" and nothing more. What to do
 * about that was #44's call, and #44 answered *nothing happens* — see `deleteVertex`
 * in `machine.ts`, and the section above.
 */
export function removePolygonVertex(
  polygon: PolygonGeometry,
  index: number,
): PolygonGeometry | null {
  requireIndex(polygon, index);
  if (polygon.points.length <= MIN_POLYGON_POINTS) return null;
  return {
    type: "polygon",
    points: polygon.points.filter((_, at) => at !== index),
  };
}
