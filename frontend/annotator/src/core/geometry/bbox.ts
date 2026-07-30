/**
 * The box as a value: what it contains, where its eight grips sit, and the two
 * transforms a pointer can apply to it.
 *
 * v1's resize algorithm is here almost line for line — clamp the pointer, assign
 * the dragged edge or edges, push the *anchored* edge out to the minimum size,
 * normalize so a drag past the anchor re-anchors instead of going negative — with
 * one step appended. The two things that changed are stated below, because both
 * are behaviour and neither should read as a transcription slip.
 *
 * ## The transforms are absolute, not incremental
 *
 * v1 kept `interaction.last` on its React state, computed `dx = point.x - last.x`,
 * applied it to the *current* geometry and reset `last`. That shape is unusable
 * here: #39's `AnnotatorStore.stage` re-projects the **committed** document on
 * every pointer-move, so an accumulating transform would either drift or double.
 * Both functions therefore take a destination — the caller derives it from the
 * geometry the gesture began on, and re-applying the same call is a fixpoint.
 *
 * It was also lossy in v1 on its own terms: a delta that got clamped is silently
 * swallowed, so dragging a box into a corner and back out did not return it to
 * where it started. The maths did not change; only who holds the origin.
 *
 * ## The minimum-size push may not leave the frame
 *
 * v1's last step before normalizing was, for a box narrower than `minSize`, to
 * push the anchored edge away from the dragged one. On a box at `x: 0, width: 2`
 * with the `w` grip dragged left, that is `left = right - 3 = -1` — a negative
 * coordinate on an annotation the kernel would then be asked to store. #41's
 * acceptance criterion forbids it outright, so `slideIntoBounds` follows: the
 * interval slides back inside, rather than being squeezed. It is a no-op wherever
 * v1 was already correct, because the pointer was clamped and the anchor came from
 * an in-bounds start box, so the interval was already inside.
 *
 * Where the two rules genuinely collide — an asset narrower than
 * `MIN_BBOX_SIZE` — **bounds win and the minimum yields**. The criterion is
 * unconditional; a minimum size is a nicety.
 *
 * ## What is deliberately not here
 *
 * No creation threshold. v1 refused a drawn box with `width > 3` *strictly*, a
 * subtly different test from the `< 3` it used while resizing; the drawing tool
 * (#43) owns that one and should choose it knowingly rather than inherit it.
 */

import type { BboxGeometry, Point } from "../types";
import { clamp } from "./clamp";
import { clampPoint, type Bounds } from "./primitives";

/**
 * The eight grips a selected box shows, clockwise from the top-left.
 *
 * The array is the source and the union is read off it, the rule `GEOMETRY_TYPES`
 * set. The order is also the tie-break: `nearestHandle` walks it, so a box too
 * small to separate its grips still answers the same one every time.
 */
export const BBOX_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

/** One of the eight resize grips. Read off the array, so the two cannot disagree. */
export type BboxHandle = (typeof BBOX_HANDLES)[number];

/**
 * The smallest box a resize will produce, in asset pixels. v1's `minSize`.
 *
 * Bounds outrank it: on an asset narrower than this, `resizeBbox` yields.
 */
export const MIN_BBOX_SIZE = 3;

/** Which edge or edges each grip drives. Derives v1's two membership lists. */
const HANDLE_DRIVES: Readonly<
  Record<
    BboxHandle,
    {
      readonly x: "left" | "right" | null;
      readonly y: "top" | "bottom" | null;
    }
  >
> = {
  nw: { x: "left", y: "top" },
  n: { x: null, y: "top" },
  ne: { x: "right", y: "top" },
  e: { x: "right", y: null },
  se: { x: "right", y: "bottom" },
  s: { x: null, y: "bottom" },
  sw: { x: "left", y: "bottom" },
  w: { x: "left", y: null },
};

/**
 * An interval slid — not squeezed — back inside `[0, limit]`.
 *
 * Sliding is what keeps the length the min-size push just established. Only when
 * the interval is longer than the frame does it lose any, and that is the case
 * where bounds outrank the minimum.
 *
 * It is written as "take the length, then place it" rather than as "shift both ends
 * by the same delta", and the reason is arithmetic rather than taste: `lo + (limit -
 * hi)` rounds to about `-1e-16` when the interval very nearly fills the frame, which
 * is a negative coordinate on a stored annotation. #41's property test found it on
 * four of six seeds. Deriving the start through `clamp(…, 0, …)` makes `0` a literal
 * bound instead of the result of a subtraction, so the criterion holds exactly. The
 * length may still move by an ulp, which is why the minimum size is the invariant
 * carrying the float slack and the bounds are the one that does not.
 */
function slideIntoBounds(lo: number, hi: number, limit: number): readonly [number, number] {
  const length = Math.min(hi - lo, limit);
  const start = clamp(lo, 0, limit - length);
  return [start, Math.min(start + length, limit)];
}

/** The box's edges as `[left, right, top, bottom]`, in order however it was stored. */
function edgesOf(bbox: BboxGeometry): readonly [number, number, number, number] {
  return [
    Math.min(bbox.x, bbox.x + bbox.width),
    Math.max(bbox.x, bbox.x + bbox.width),
    Math.min(bbox.y, bbox.y + bbox.height),
    Math.max(bbox.y, bbox.y + bbox.height),
  ];
}

/**
 * A box from two opposite corners in either order — the drag-out constructor, and
 * the reason a drawing tool never has to think about which way the pointer went.
 * v1's `normalizeBbox`.
 */
export function normalizeBbox(start: Point, end: Point): BboxGeometry {
  return {
    type: "bbox",
    x: Math.min(start[0], end[0]),
    y: Math.min(start[1], end[1]),
    width: Math.abs(end[0] - start[0]),
    height: Math.abs(end[1] - start[1]),
  };
}

/**
 * Is the point inside the box, edges included?
 *
 * Exact — no tolerance, no zoom, no stroke width; `geometryContains` adds the
 * forgiving outline test on top. Inclusive on the edge, which is otherwise a coin
 * flip, and it reads the edges through `min`/`max` so a negative width off the
 * wire is not a box nothing can ever click.
 */
export function bboxContains(bbox: BboxGeometry, point: Point): boolean {
  const [left, right, top, bottom] = edgesOf(bbox);
  return (
    point[0] >= left && point[0] <= right && point[1] >= top && point[1] <= bottom
  );
}

/**
 * The four corners as a ring — nw, ne, se, sw — which is what an outline hit test
 * walks and what a renderer draws.
 */
export function bboxCorners(
  bbox: BboxGeometry,
): readonly [Point, Point, Point, Point] {
  const [left, right, top, bottom] = edgesOf(bbox);
  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];
}

/**
 * Where each of the eight grips sits for this box. A renderer maps `BBOX_HANDLES`
 * over it; `nearestHandle` measures against it.
 */
export function bboxHandlePositions(
  bbox: BboxGeometry,
): Readonly<Record<BboxHandle, Point>> {
  const [left, right, top, bottom] = edgesOf(bbox);
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;
  return {
    nw: [left, top],
    n: [midX, top],
    ne: [right, top],
    e: [right, midY],
    se: [right, bottom],
    s: [midX, bottom],
    sw: [left, bottom],
    w: [left, midY],
  };
}

/**
 * The box with its top-left corner at `origin`, clamped so the whole of it stays
 * in `bounds`.
 *
 * `origin` is a destination, not a delta: a tool computes it from the box the
 * gesture began on, never from the box this returned last. A box wider than its
 * asset pins to `0` rather than shrinking — a move does not resize, and pinning is
 * what v1's own `moveBbox` did.
 */
export function moveBbox(
  bbox: BboxGeometry,
  origin: Point,
  bounds: Bounds,
): BboxGeometry {
  const width = Math.abs(bbox.width);
  const height = Math.abs(bbox.height);
  return {
    type: "bbox",
    x: clamp(origin[0], 0, Math.max(0, bounds.width - width)),
    y: clamp(origin[1], 0, Math.max(0, bounds.height - height)),
    width,
    height,
  };
}

/**
 * `start` resized by dragging `handle` to `point`.
 *
 * Absolute in `start`, which is the box the gesture began on and not the previous
 * pointer-move's answer. Four steps, in v1's order: clamp the pointer into the
 * frame, move the edge or edges this grip drives, push the *anchored* edge out if
 * the box came out below `MIN_BBOX_SIZE`, then slide the result back inside the
 * frame — the fourth being #41's addition, and the reason a hard drag into an edge
 * can no longer produce a negative coordinate.
 *
 * A drag past the anchor re-anchors rather than producing a negative size, because
 * the edges are read back through `min`/`max` at the end.
 */
export function resizeBbox(
  start: BboxGeometry,
  handle: BboxHandle,
  point: Point,
  bounds: Bounds,
): BboxGeometry {
  const [startLeft, startRight, startTop, startBottom] = edgesOf(start);
  const [px, py] = clampPoint(point, bounds);
  const drives = HANDLE_DRIVES[handle];

  let left = drives.x === "left" ? px : startLeft;
  let right = drives.x === "right" ? px : startRight;
  let top = drives.y === "top" ? py : startTop;
  let bottom = drives.y === "bottom" ? py : startBottom;

  // The minimum, but never wider than the asset it has to fit inside.
  const minWidth = Math.min(MIN_BBOX_SIZE, bounds.width);
  const minHeight = Math.min(MIN_BBOX_SIZE, bounds.height);

  if (Math.abs(right - left) < minWidth) {
    if (drives.x === "left") left = right - minWidth;
    else right = left + minWidth;
  }
  if (Math.abs(bottom - top) < minHeight) {
    if (drives.y === "top") top = bottom - minHeight;
    else bottom = top + minHeight;
  }

  const [inLeft, inRight] = slideIntoBounds(
    Math.min(left, right),
    Math.max(left, right),
    bounds.width,
  );
  const [inTop, inBottom] = slideIntoBounds(
    Math.min(top, bottom),
    Math.max(top, bottom),
    bounds.height,
  );

  return {
    type: "bbox",
    x: inLeft,
    y: inTop,
    width: inRight - inLeft,
    height: inBottom - inTop,
  };
}
