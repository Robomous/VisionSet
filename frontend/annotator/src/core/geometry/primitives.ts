/**
 * The vocabulary the rest of `geometry/` is written in: a frame, a distance, a
 * projection onto a segment, and a point pushed back inside a frame.
 *
 * Four exports, and every one of them is v1's — `dist` and
 * `closestPointOnSegment` come across unchanged from
 * `annotation-utils.ts`, and `clampPoint` is the pair of `clamp` calls v1 wrote
 * out at twenty-odd separate call sites. That is the whole of what could be
 * literally ported: the rest of v1's geometry lived inline inside a 1413-line React
 * component, in pointer handlers that read `svgRef.current`.
 *
 * ## Why `Bounds` and not `AssetDescriptor`
 *
 * A transform needs a width and a height. It cannot use an `id`, and a parameter
 * carrying something the function cannot use is an invitation to start using it.
 * `AssetDescriptor` satisfies this interface structurally, so `moveBbox(box,
 * origin, document.asset)` compiles with no adapter and no per-pointer-move
 * object — the narrower precondition is free, which is why it is worth taking.
 * It is a *supertype*, not a second spelling of the wire, so it cannot drift: the
 * compiler re-proves the relation at every call site, and `primitives.test.ts`
 * pins it once for a reader.
 *
 * It also makes the property test honest. Sweeping the frames where the asset is
 * narrower than `MIN_BBOX_SIZE` means writing `{ width: 1, height: 1 }` a few
 * hundred times; minting a fake uuid alongside would put noise in front of the
 * reader on every line that is *about* a frame.
 *
 * ## What is deliberately not here
 *
 * No `distanceSquared`. It would be a second ordering in a different unit, which
 * is how a tolerance eventually gets compared against a square. The polygons here
 * are tens of vertices, not tens of thousands.
 *
 * No guard against a non-finite input. `clamp(NaN, 0, 10)` is `NaN` and stays
 * `NaN` all the way through. Catching it would cost a branch in every signature in
 * this directory to defend against something the input layer owns — a pointer
 * position is a number by the time it reaches here or the bug is upstream. Stated
 * rather than left as an oversight.
 */

import type { Point } from "../types";
import { clamp } from "./clamp";

/**
 * A rectangle of legal coordinate space, in the asset's own pixels, anchored at
 * the origin. An `AssetDescriptor` is one, structurally.
 */
export interface Bounds {
  readonly width: number;
  readonly height: number;
}

/** Euclidean distance between two points, in asset pixels. v1's `dist`. */
export function distance(a: Point, b: Point): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
}

/**
 * The point on the segment `a → b` closest to `p`.
 *
 * `t` is clamped to `[0, 1]`, so the answer is on the segment rather than on its
 * infinite line — that clamp is what makes an edge hit test measure the edge and
 * not the line through it. A zero-length segment answers `a`, which keeps a
 * polygon carrying a duplicated vertex from dividing by zero.
 */
export function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return a;
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared, 0, 1);
  return [a[0] + t * dx, a[1] + t * dy];
}

/**
 * `p` clamped into `[0, width] × [0, height]` — the one place a stray coordinate
 * enters the asset's frame, and the first step of every transform below.
 */
export function clampPoint(p: Point, bounds: Bounds): Point {
  return [clamp(p[0], 0, bounds.width), clamp(p[1], 0, bounds.height)];
}
