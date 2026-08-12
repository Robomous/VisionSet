/**
 * Douglas-Peucker over a traced contour, and the vertex density a person picks.
 *
 * ## Why this exists twice
 *
 * The kernel produces the shape that is finally written; this produces the shape
 * on screen while somebody is still deciding. Asking the server for each step of
 * a three-position control would put a network round trip and a model decode
 * between a keypress and the picture, for an answer that needs neither: the
 * response already carries the contour, and reducing it is arithmetic.
 *
 * So the two implementations have to agree, and `tests/fixtures/simplification.json`
 * is what makes that a fact rather than a hope — golden contours the Python
 * produced, with the exact output expected at each step.
 * `simplify.test.ts` reads it, `tests/inference/test_simplification_fixture.py`
 * keeps it current, and neither half shares a toolchain with the other.
 *
 * **Exact equality is achievable and is what the gate asserts.** Both languages
 * hold IEEE-754 doubles, `Math.sqrt` and Python's `** 0.5` are the same
 * correctly-rounded operation, and every expression below is in the same order
 * as the Python it mirrors. Keeping that order is not style: the algorithm's
 * output is decided by comparisons, so a re-association that moves a value by
 * one unit in the last place can move a vertex.
 *
 * ## Why a contour is the input rather than a mask
 *
 * A mask is a megapixel of booleans and turning one into a boundary needs the
 * segmenter's output, which this package has no way to reach — it has no HTTP
 * and never will. The contour is the seam: everything before it happens once, on
 * the server, and everything after it has to give the same answer in both
 * places.
 *
 * The contour arriving here is already reduced at {@link MINIMUM_TOLERANCE},
 * because Douglas-Peucker is not nested — reducing at half a pixel and then at
 * five does not give what reducing once at five gives — so both sides start from
 * the same points or they can never be held to the same answer.
 */

import type { Point } from "../types";

/** How much of an outline survives. The wire's `detail`, and the same three names. */
export type Detail = "coarse" | "balanced" | "fine";

/** Coarsest first, so `[` and `]` move the same direction the list reads. */
export const DETAIL_STEPS = ["coarse", "balanced", "fine"] as const satisfies readonly Detail[];

/**
 * What each step means, as a fraction of the region's bounding diagonal.
 *
 * Relative rather than absolute, which is the whole reason one setting works at
 * every scale: three pixels is nothing on a car and is the whole of a bottle cap.
 * The numbers are the kernel's, and the fixture asserts they still are.
 */
export const EPSILON = {
  coarse: 0.025,
  balanced: 0.01,
  fine: 0.004,
} as const satisfies Record<Detail, number>;

/** No tolerance below half a pixel, however small the region. */
export const MINIMUM_TOLERANCE = 0.5;

/** The domain's floor for a polygon: fewer than three points is a line. */
const MINIMUM_POLYGON_POINTS = 3;

/** Perpendicular distance, degenerating to plain distance on a zero-length segment. */
function distanceToSegment(point: Point, start: Point, end: Point): number {
  const [px, py] = point;
  const [sx, sy] = start;
  const [ex, ey] = end;
  const dx = ex - sx;
  const dy = ey - sy;
  if (dx === 0 && dy === 0) return Math.sqrt((px - sx) ** 2 + (py - sy) ** 2);
  return Math.abs(dy * px - dx * py + ex * sy - ey * sx) / Math.sqrt(dx * dx + dy * dy);
}

/**
 * Douglas-Peucker over an open polyline.
 *
 * Iterative rather than recursive, for the kernel's reason: a traced boundary is
 * thousands of points long and the recursive spelling is depth-unbounded on
 * exactly the input it is given here.
 */
export function simplified(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 3) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const pending: Array<[number, number]> = [[0, points.length - 1]];
  while (pending.length > 0) {
    const [first, last] = pending.pop()!;
    if (last <= first + 1) continue;
    let worst = first;
    let distance = -1;
    for (let index = first + 1; index < last; index += 1) {
      const found = distanceToSegment(points[index]!, points[first]!, points[last]!);
      if (found > distance) {
        worst = index;
        distance = found;
      }
    }
    if (distance > tolerance) {
      keep[worst] = true;
      pending.push([first, worst]);
      pending.push([worst, last]);
    }
  }
  return points.filter((_, index) => keep[index]!);
}

/** The pixel tolerance a step means for a region of this size. */
export function toleranceFor(points: readonly Point[], detail: Detail): number {
  if (points.length === 0) return MINIMUM_TOLERANCE;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const diagonal = Math.sqrt(
    (Math.max(...xs) - Math.min(...xs)) ** 2 + (Math.max(...ys) - Math.min(...ys)) ** 2,
  );
  return Math.max(MINIMUM_TOLERANCE, EPSILON[detail] * diagonal);
}

/**
 * Drop the vertices Douglas-Peucker only kept because it was told to.
 *
 * The algorithm pins the first and last point of what it is given, and what it is
 * given here is a ring cut open at an arbitrary pixel — so the final vertex is
 * pinned for a reason that stops being true the moment the ring closes, and it
 * lands one pixel from the first. Judged by the same tolerance as everything
 * else rather than by exact equality: the artifact is a near-duplicate, so
 * comparing the first point to the last never fires on the case that motivates it.
 */
function closed(kept: Point[], tolerance: number): Point[] {
  let ring = kept;
  while (ring.length > MINIMUM_POLYGON_POINTS) {
    if (distanceToSegment(ring[ring.length - 1]!, ring[ring.length - 2]!, ring[0]!) > tolerance) {
      return ring;
    }
    ring = ring.slice(0, -1);
  }
  return ring;
}

/**
 * That contour at the requested vertex density, or `null` where no polygon can be
 * made — an empty contour, or one too thin to have three distinct corners.
 *
 * `null` rather than an empty array, because "there is no shape here" and "the
 * shape has no vertices" are different facts and only the first one happens.
 */
export function polygonAt(points: readonly Point[], detail: Detail): Point[] | null {
  if (points.length < MINIMUM_POLYGON_POINTS) return null;
  const tolerance = toleranceFor(points, detail);
  const kept = closed(simplified(points, tolerance), tolerance);
  if (kept.length < MINIMUM_POLYGON_POINTS) return null;
  return kept;
}

/**
 * The next step in a direction, stopping at each end rather than wrapping.
 *
 * Stopping is deliberate: `[` and `]` are held down, and a control that wrapped
 * would take somebody from the coarsest straight to the finest without their
 * having asked for anything in between.
 */
export function steppedDetail(detail: Detail, direction: -1 | 1): Detail {
  const at = DETAIL_STEPS.indexOf(detail);
  const next = Math.min(DETAIL_STEPS.length - 1, Math.max(0, at + direction));
  return DETAIL_STEPS[next]!;
}
