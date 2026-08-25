/**
 * Douglas-Peucker over a traced contour, at the pixel tolerance a person picks.
 *
 * ## Why this exists twice
 *
 * The kernel produces the shape that is finally written; this produces the shape
 * on screen while somebody is still deciding. Asking the server for each step of
 * moving the tolerance would put a network round trip and a model decode
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
 * because Douglas-Peucker is not nested — reducing at a quarter pixel and then at
 * five does not give what reducing once at five gives — so both sides start from
 * the same points or they can never be held to the same answer.
 */

import type { Point } from "../types";

/** What a caller that says nothing gets: an outline within one pixel of the mask. */
export const DEFAULT_TOLERANCE = 1;

/** The finest setting, and the floor the kernel reduces the contour at. */
export const MINIMUM_TOLERANCE = 0.25;

/** The coarsest setting. Past this an outline stops describing the object. */
export const MAXIMUM_TOLERANCE = 16;

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

/**
 * Drop the one vertex Douglas-Peucker only kept because it was told to.
 *
 * The algorithm pins the first and last point of what it is given, and what it is
 * given here is a ring cut open at an arbitrary pixel. Cutting the ring open pins
 * exactly one vertex artificially, and it is a near-duplicate of the first point
 * (a fraction of a pixel away), so it is dropped when it sits within the
 * tolerance of the closing segment; a second drop would remove a real corner the
 * reduction chose to keep.
 */
function closed(kept: Point[], tolerance: number): Point[] {
  if (kept.length > MINIMUM_POLYGON_POINTS) {
    const last = kept[kept.length - 1]!;
    if (distanceToSegment(last, kept[kept.length - 2]!, kept[0]!) <= tolerance) {
      return kept.slice(0, -1);
    }
  }
  return kept;
}

/**
 * That contour within `tolerance` pixels, or `null` where no polygon can be
 * made — an empty contour, or one too thin to have three distinct corners.
 */
export function polygonAt(points: readonly Point[], tolerance: number): Point[] | null {
  if (points.length < MINIMUM_POLYGON_POINTS) return null;
  const kept = closed(simplified(points, tolerance), tolerance);
  if (kept.length < MINIMUM_POLYGON_POINTS) return null;
  return kept;
}

/**
 * The next stop on the doubling ladder: `-1` coarser (twice the tolerance), `+1`
 * finer (half of it), clamped to the range and stopping at each end rather than
 * wrapping — `[` and `]` are held down, and a control that wrapped would take
 * somebody from the coarsest straight to the finest.
 *
 * The ladder is the powers of two between the ends. A `tolerance` the slider
 * left between stops is taken to the nearest one first, so a bracket always
 * lands back on the ladder rather than walking off it from wherever the slider
 * happened to leave it.
 */
export function steppedTolerance(tolerance: number, direction: -1 | 1): number {
  const exponent = Math.round(Math.log2(tolerance)) + (direction === -1 ? 1 : -1);
  return Math.min(MAXIMUM_TOLERANCE, Math.max(MINIMUM_TOLERANCE, 2 ** exponent));
}
