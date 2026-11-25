/**
 * Vertex edits on a scan's `polyline_3d`, pure and returning new geometry.
 *
 * A declared `visibility` stays aligned with the points; an inserted vertex is
 * `UNLABELED`, since nobody has judged it. Nothing here clamps: a scan point has no bounds the way a pixel does.
 */

import { VERTEX_VISIBILITY, type Point3D, type Polyline3DGeometry } from "../types";

/** The kernel refuses a path with fewer vertices, and one whose vertices are all the same point. */
export const MIN_POLYLINE_VERTICES = 2;

export function isDrawablePolyline(points: readonly Point3D[]): boolean {
  if (points.length < MIN_POLYLINE_VERTICES) return false;
  const [x, y, z] = points[0]!;
  return points.some((p) => p[0] !== x || p[1] !== y || p[2] !== z);
}

export function movePolylineVertex(g: Polyline3DGeometry, index: number, to: Point3D): Polyline3DGeometry {
  requireVertex(g, index);
  return { ...g, points: g.points.map((p, i) => (i === index ? to : p)) };
}

/** Insert `at` between vertex `segment` and `segment + 1`. */
export function insertPolylineVertex(g: Polyline3DGeometry, segment: number, at: Point3D): Polyline3DGeometry {
  if (!Number.isInteger(segment) || segment < 0 || segment >= g.points.length - 1) {
    throw new RangeError(`no segment ${segment} on a polyline of ${g.points.length} vertices`);
  }
  return {
    ...g,
    points: insertAt(g.points, segment + 1, at),
    visibility: g.visibility && insertAt(g.visibility, segment + 1, VERTEX_VISIBILITY.UNLABELED),
  };
}

/** `null` when the removal would leave fewer than `MIN_POLYLINE_VERTICES`. */
export function removePolylineVertex(g: Polyline3DGeometry, index: number): Polyline3DGeometry | null {
  requireVertex(g, index);
  if (g.points.length <= MIN_POLYLINE_VERTICES) return null;
  const keep = (_: unknown, i: number): boolean => i !== index;
  return { ...g, points: g.points.filter(keep), visibility: g.visibility?.filter(keep) };
}

function insertAt<T>(items: readonly T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index)];
}

function requireVertex(g: Polyline3DGeometry, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= g.points.length) {
    throw new RangeError(`no vertex ${index} on a polyline of ${g.points.length} vertices`);
  }
}
