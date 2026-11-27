/**
 * Rotated rectangles: the canonical form the kernel stores, the corners, and the
 * transforms a drag asks for.
 *
 * Every transform here is absolute in a start geometry, like `bbox.ts`'s, so a
 * pointer-move is idempotent. The drag transforms answer raw values; the machine
 * canonicalizes the one it commits, so a handle never jumps sides mid-gesture.
 */

import type { BboxGeometry, ObbGeometry, Point } from "../types";
import { MIN_BBOX_SIZE, type BboxHandle } from "./bbox";
import { clamp } from "./clamp";
import type { Bounds } from "./primitives";

const HALF_PI = Math.PI / 2;

/** The side each grip drives, as signs along the width (`u`) and height (`v`) axes. */
const HANDLE_SIGNS: Readonly<Record<BboxHandle, readonly [number, number]>> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

function reduced(angle: number, period: number): number {
  let r = angle - period * Math.round(angle / period);
  if (r >= period / 2) r -= period;
  if (r < -period / 2) r += period;
  return r + 0;
}

/**
 * The kernel's canonical spelling: `width >= height`, the angle in `[-π/2, π/2)`,
 * a square's in `[-π/4, π/4)`, and never `-0`. Idempotent on a canonical value.
 */
export function canonicalObb(geometry: ObbGeometry): ObbGeometry {
  let { width, height, angle } = geometry;
  if (width < height) {
    [width, height] = [height, width];
    angle += HALF_PI;
  }
  angle = reduced(angle, Math.PI);
  if (width === height) angle = reduced(angle, HALF_PI);
  return { type: "obb", cx: geometry.cx, cy: geometry.cy, width, height, angle };
}

/** Whether the kernel would store it: every value finite, both sides positive. */
export function isValidObb(geometry: ObbGeometry): boolean {
  const { cx, cy, width, height, angle } = geometry;
  return (
    [cx, cy, width, height, angle].every(Number.isFinite) && width > 0 && height > 0
  );
}

/** The width axis `u` and the height axis `v`, unit vectors in asset pixels (y down). */
export function obbAxes(angle: number): { readonly u: Point; readonly v: Point } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { u: [cos, sin], v: [-sin, cos] };
}

function at(geometry: ObbGeometry, along: number, across: number): Point {
  const { u, v } = obbAxes(geometry.angle);
  return [
    geometry.cx + along * u[0] + across * v[0],
    geometry.cy + along * u[1] + across * v[1],
  ];
}

/** `p` in the box's own frame: distance along `u` and along `v` from the centre. */
function local(geometry: ObbGeometry, point: Point): readonly [number, number] {
  const { u, v } = obbAxes(geometry.angle);
  const dx = point[0] - geometry.cx;
  const dy = point[1] - geometry.cy;
  return [dx * u[0] + dy * u[1], dx * v[0] + dy * v[1]];
}

/**
 * The four corners, `c ∓ (w/2)u ∓ (h/2)v` in the wire's ring order: at angle 0,
 * top-left, top-right, bottom-right, bottom-left, as `bboxCorners`.
 */
export function obbCorners(geometry: ObbGeometry): readonly [Point, Point, Point, Point] {
  const w = geometry.width / 2;
  const h = geometry.height / 2;
  return [at(geometry, -w, -h), at(geometry, w, -h), at(geometry, w, h), at(geometry, -w, h)];
}

/** The smallest axis-aligned box holding it. */
export function obbExtent(geometry: ObbGeometry): BboxGeometry {
  const corners = obbCorners(geometry);
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { type: "bbox", x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function obbContains(geometry: ObbGeometry, point: Point): boolean {
  const [along, across] = local(geometry, point);
  return Math.abs(along) <= geometry.width / 2 && Math.abs(across) <= geometry.height / 2;
}

/** The eight grips, named in the box's own frame: `n` is the side `-v` points to. */
export function obbHandlePositions(geometry: ObbGeometry): Readonly<Record<BboxHandle, Point>> {
  const w = geometry.width / 2;
  const h = geometry.height / 2;
  const positions = {} as Record<BboxHandle, Point>;
  for (const [handle, [su, sv]] of Object.entries(HANDLE_SIGNS) as [BboxHandle, readonly [number, number]][]) {
    positions[handle] = at(geometry, su * w, sv * h);
  }
  return positions;
}

/**
 * The side whose outward normal points most nearly up the screen, as signs along
 * `u` and `v`. Read off the drawn rectangle rather than the stored spelling, so
 * the rotation grip stays above the box whichever of its equivalent angles the
 * canonical form chose. Ties go to the first in `-v, +u, +v, -u`.
 */
function uppermostSide(geometry: ObbGeometry): readonly [number, number] {
  const { u, v } = obbAxes(geometry.angle);
  const sides: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  let best = sides[0];
  let bestY = Infinity;
  for (const side of sides) {
    const y = side[0] * u[1] + side[1] * v[1];
    if (y < bestY - 1e-9) {
      best = side;
      bestY = y;
    }
  }
  return best;
}

/** The middle of the box's uppermost side, where the rotation grip's stem starts. */
export function obbRotateBase(geometry: ObbGeometry): Point {
  const [su, sv] = uppermostSide(geometry);
  return at(geometry, (su * geometry.width) / 2, (sv * geometry.height) / 2);
}

/** The rotation grip: `offset` asset pixels beyond the middle of the uppermost side. */
export function obbRotateHandle(geometry: ObbGeometry, offset: number): Point {
  const [su, sv] = uppermostSide(geometry);
  return at(geometry, su * (geometry.width / 2 + offset), sv * (geometry.height / 2 + offset));
}

/** The screen direction a grip pushes, in radians, for picking a resize cursor. */
export function obbHandleDirection(geometry: ObbGeometry, handle: BboxHandle): number {
  const [su, sv] = HANDLE_SIGNS[handle];
  const { u, v } = obbAxes(geometry.angle);
  return Math.atan2(su * u[1] + sv * v[1], su * u[0] + sv * v[0]);
}

/** A box dragged out on screen, as a rotated box at angle 0, canonical. */
export function obbFromBox(box: BboxGeometry): ObbGeometry {
  return canonicalObb({
    type: "obb",
    cx: box.x + box.width / 2,
    cy: box.y + box.height / 2,
    width: box.width,
    height: box.height,
    angle: 0,
  });
}

/** The box with its centre at `centre`, kept inside the asset so it stays on it. */
export function moveObb(geometry: ObbGeometry, centre: Point, bounds: Bounds): ObbGeometry {
  return {
    ...geometry,
    cx: clamp(centre[0], 0, bounds.width),
    cy: clamp(centre[1], 0, bounds.height),
  };
}

/**
 * The box with one grip at `point`, the opposite side or corner held still, in the
 * box's own frame. Dragging a grip across its opposite side flips the box rather
 * than inverting it, and no side falls below `MIN_BBOX_SIZE`.
 *
 * The pointer is not clamped to the asset: a turned box's grip may legally sit
 * outside it, and clamping would snap that grip to the edge on the first move.
 * The centre is kept on the asset instead, as `moveObb` keeps it.
 */
export function resizeObb(
  start: ObbGeometry,
  handle: BboxHandle,
  point: Point,
  bounds: Bounds,
): ObbGeometry {
  const [su, sv] = HANDLE_SIGNS[handle];
  const [along, across] = local(start, point);
  let left = su < 0 ? along : -start.width / 2;
  let right = su > 0 ? along : start.width / 2;
  let top = sv < 0 ? across : -start.height / 2;
  let bottom = sv > 0 ? across : start.height / 2;

  if (Math.abs(right - left) < MIN_BBOX_SIZE) {
    if (su < 0) left = right - MIN_BBOX_SIZE;
    else right = left + MIN_BBOX_SIZE;
  }
  if (Math.abs(bottom - top) < MIN_BBOX_SIZE) {
    if (sv < 0) top = bottom - MIN_BBOX_SIZE;
    else bottom = top + MIN_BBOX_SIZE;
  }

  const [cx, cy] = at(start, (left + right) / 2, (top + bottom) / 2);
  return {
    type: "obb",
    cx: clamp(cx, 0, bounds.width),
    cy: clamp(cy, 0, bounds.height),
    width: Math.abs(right - left),
    height: Math.abs(bottom - top),
    angle: start.angle,
  };
}

/** The box turned about its centre by the angle the pointer swept from `from` to `to`. */
export function rotateObb(start: ObbGeometry, from: Point, to: Point): ObbGeometry {
  const swept =
    Math.atan2(to[1] - start.cy, to[0] - start.cx) -
    Math.atan2(from[1] - start.cy, from[0] - start.cx);
  return { ...start, angle: start.angle + swept };
}
