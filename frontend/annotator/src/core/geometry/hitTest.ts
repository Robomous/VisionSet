/**
 * What did the user mean by that point? — the only module here that takes a
 * tolerance, and the only one that sees an `Annotation`.
 *
 * Nothing in this file changes a shape; everything in `bbox.ts` and `polygon.ts`
 * does. That is the cut, and it is why #41's clamping criterion applies to no
 * function below.
 *
 * ## Tolerances arrive in asset pixels
 *
 * Every `tolerance` parameter here is measured in the asset's own pixels, the same
 * frame as the geometry and the point. Turning a grab radius a person can see into
 * that number is one call to `tolerance.ts`'s `toleranceInAssetPixels`, made by the
 * adapter once per zoom change. Passing a zoom in here instead would carry a
 * viewport into five signatures that have none.
 *
 * ## This is where v1 had the least to port
 *
 * v1's only hit-testing *function* was `findNearestEdgeIndex`, which `nearestEdge`
 * is — closed-only, since `polyline` is not a geometry an annotation can carry
 * (#73). Everything else was the browser's: a resize grip was a real SVG `<circle>`
 * with its own `onPointerDown`, and picking a shape was `<polygon>`'s own hit
 * testing plus React event bubbling. A headless engine has neither, so
 * `nearestHandle`, `geometryContains` and `topmostAnnotationAt` are new.
 *
 * One consequence of that is a choice worth naming: v1 drew corner grips at r=5 and
 * edge-midpoint grips at r=4, so its corners were very slightly easier to grab.
 * That was a drawing decision made in a renderer, and a one-pixel difference in
 * grab radius is not a behaviour, so `nearestHandle` takes a single tolerance for
 * all eight.
 *
 * ## What is deliberately not here
 *
 * No document-shaped overload. `topmostAnnotationAt` takes the array so that
 * `geometry/` imports nothing from `state/` and stays a leaf — and so that a caller
 * can hand it a subset, which #42 wants when it tests the selected annotations'
 * grips before testing anything's body — `interaction/target.ts` is that caller.
 * A convenience taking an
 * `AnnotationDocument` would cost that for one line at the call site.
 */

import type { Annotation, BboxGeometry, Geometry, Point } from "../types";
import {
  BBOX_HANDLES,
  bboxContains,
  bboxCorners,
  bboxHandlePositions,
  type BboxHandle,
} from "./bbox";
import { MIN_POLYGON_POINTS, polygonContains } from "./polygon";
import { closestPointOnSegment, distance } from "./primitives";

/** A vertex found near a point. `point` is the vertex itself. */
export interface VertexHit {
  readonly index: number;
  readonly point: Point;
  readonly distance: number;
}

/**
 * An edge found near a point. `index` is the edge's **start** vertex — so the
 * closing edge of an n-point polygon is `n - 1` — and `point` is the projection
 * onto it, which is where a new vertex would go.
 */
export interface EdgeHit {
  readonly index: number;
  readonly point: Point;
  readonly distance: number;
}

/** A resize grip found near a point. `point` is where the grip sits. */
export interface HandleHit {
  readonly handle: BboxHandle;
  readonly point: Point;
  readonly distance: number;
}

/**
 * The vertex nearest `point` within `tolerance`, or `null`.
 *
 * Strictly-nearest wins and a tie goes to the lower index — v1's `d < minDist`.
 * It takes a bare point list rather than a polygon so that #44's half-drawn one,
 * which is not a `PolygonGeometry` yet, can be tested with the same function.
 *
 * That prediction landed one function over. #44 does test a half-drawn buffer, but
 * against a vertex it can already name — the first — so it is `polygonCloseAttempt`
 * below, calling `distance` directly. Searching a list for a vertex you have the
 * index of is a slower way to get the same answer.
 */
export function nearestVertex(
  points: readonly Point[],
  point: Point,
  tolerance: number,
): VertexHit | null {
  let best: VertexHit | null = null;
  for (let index = 0; index < points.length; index += 1) {
    const vertex = points[index];
    const away = distance(point, vertex);
    if (away <= tolerance && (best === null || away < best.distance)) {
      best = { index, point: vertex, distance: away };
    }
  }
  return best;
}

/**
 * What a press inside the ring around a half-drawn polygon's **first** vertex
 * means. v1's `dist(point, pendingPolygon[0]) <= 10`, split into its two cases.
 *
 * - `closes` — inside the ring, and the buffer has enough points to be a polygon.
 * - `too-few` — inside the ring, and it does not. The press is still a close
 *   *attempt*: the user is aiming at the first vertex, and the only honest answers
 *   are to close or to do nothing. Appending is neither, and it is what v1 did —
 *   stacking a near-duplicate of vertex 0 onto a two-point buffer.
 * - `no` — outside the ring; the press means something else.
 *
 * The middle case is why this returns three answers rather than a boolean. It is
 * what makes *"a press inside the close ring never appends a vertex"* a rule with a
 * name, instead of a shape that falls out of the order two `if`s happen to sit in.
 *
 * One function because two callers ask: the transition table decides what the press
 * does, and `affordanceAt` decides what the cursor promises. #43's rule — those two
 * must not be able to disagree — and the reason the affordance layer mirrors
 * `IDLE_ROW` rather than re-deriving it.
 *
 * `tolerance` is `Tolerances.closePolygon`, in asset pixels like every other
 * tolerance here.
 */
export type CloseAttempt = "closes" | "too-few" | "no";

export function polygonCloseAttempt(
  points: readonly Point[],
  point: Point,
  tolerance: number,
): CloseAttempt {
  const first = points[0];
  // An empty buffer has no first vertex to aim at. Unreachable through the machine,
  // which never leaves `drawing-polygon` holding nothing, and answered rather than
  // indexed into because this is exported from the package root.
  if (first === undefined) return "no";
  if (distance(point, first) > tolerance) return "no";
  return points.length >= MIN_POLYGON_POINTS ? "closes" : "too-few";
}

/**
 * The edge nearest `point` within `tolerance`, or `null`. v1's
 * `findNearestEdgeIndex`, with the polyline branch dropped.
 *
 * The list is treated as closed, so a point near the implicit closing edge answers
 * `points.length - 1`. An edge whose ends coincide contributes a finite distance to
 * that shared point rather than a `NaN`, which is what keeps a polygon carrying a
 * duplicated vertex testable.
 */
export function nearestEdge(
  points: readonly Point[],
  point: Point,
  tolerance: number,
): EdgeHit | null {
  let best: EdgeHit | null = null;
  for (let index = 0; index < points.length; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % points.length];
    const on = closestPointOnSegment(point, from, to);
    const away = distance(point, on);
    if (away <= tolerance && (best === null || away < best.distance)) {
      best = { index, point: on, distance: away };
    }
  }
  return best;
}

/**
 * The resize grip nearest `point` within `tolerance`, or `null`.
 *
 * One tolerance for all eight. `BBOX_HANDLES`' order is the tie-break, so a box too
 * small to separate its grips still answers the same one every time instead of
 * whichever the iteration happened to reach.
 */
export function nearestHandle(
  bbox: BboxGeometry,
  point: Point,
  tolerance: number,
): HandleHit | null {
  const positions = bboxHandlePositions(bbox);
  let best: HandleHit | null = null;
  for (const handle of BBOX_HANDLES) {
    const at = positions[handle];
    const away = distance(point, at);
    if (away <= tolerance && (best === null || away < best.distance)) {
      best = { handle, point: at, distance: away };
    }
  }
  return best;
}

/**
 * Is this geometry under the point — inside it, or within `tolerance` of its
 * outline?
 *
 * The outline clause is not a nicety. `parseGeometry` validates only that the
 * numbers are finite, so a zero-area box and a two-point polygon both load from the
 * wire, and an inside-only test would make them unclickable — which are exactly the
 * shapes a user needs to reach in order to delete them. It also softens the
 * half-open boundary a ray cast necessarily has.
 *
 * A `classification_tag` is never under the pointer: it has no coordinates, so
 * selecting one is a class-list interaction and not a canvas one.
 */
export function geometryContains(
  geometry: Geometry,
  point: Point,
  tolerance: number,
): boolean {
  if (geometry.type === "classification_tag") return false;
  if (geometry.type === "bbox") {
    if (bboxContains(geometry, point)) return true;
    return nearestEdge(bboxCorners(geometry), point, tolerance) !== null;
  }
  if (polygonContains(geometry, point)) return true;
  if (geometry.points.length === 1) {
    return distance(point, geometry.points[0]) <= tolerance;
  }
  return nearestEdge(geometry.points, point, tolerance) !== null;
}

/**
 * The topmost annotation under the point, or `null`.
 *
 * Hand it `annotationsInDrawOrder(document)`. It walks that **backwards**, because
 * the last painted is the one on top and the top one is what a click means — the
 * contract `document.ts` states from the other side.
 */
export function topmostAnnotationAt(
  inDrawOrder: readonly Annotation[],
  point: Point,
  tolerance: number,
): Annotation | null {
  for (let index = inDrawOrder.length - 1; index >= 0; index -= 1) {
    const annotation = inDrawOrder[index];
    if (geometryContains(annotation.geometry, point, tolerance)) return annotation;
  }
  return null;
}
