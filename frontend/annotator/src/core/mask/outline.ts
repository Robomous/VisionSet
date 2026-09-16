/**
 * Step 3 — the canonical boundary: traced along the pixels' edges, smoothed
 * once, reduced once at the floor.
 *
 * The reduction is part of the definition rather than an optimisation:
 * Douglas-Peucker is not nested — reducing at a quarter pixel and then at five
 * does not give what reducing once at five gives — so the editor and the kernel
 * can only be proved to agree if both start from the same points.
 */

import { MINIMUM_TOLERANCE, simplified } from "../geometry/simplify";
import type { Point } from "../types";
import type { BinaryMask } from "./binaryMask";
import { bits } from "./closing";
import { runs } from "./runs";

type Corner = readonly [number, number];

/** The indices of a non-negative integer's set bits, lowest first. */
function* setBits(value: bigint): Generator<number> {
  if (value <= 0n) return;
  const text = value.toString(2);
  const top = text.length - 1;
  for (let index = top; index >= 0; index -= 1) {
    if (text.charCodeAt(index) === 49) yield top - index;
  }
}

/**
 * Which way out of a corner that has more than one, left turn first.
 *
 * A corner with two ways out is where two lit pixels touch only diagonally. The
 * left turn crosses onto the other pixel and keeps the 8-connected piece one
 * ring; the right turn would close round the first pixel alone and cut the piece
 * in two, which is not what `components` said the piece was.
 */
function turned(options: Corner[], at: Corner, heading: Corner): Corner {
  const left: Corner = [heading[1], -heading[0]];
  const right: Corner = [-heading[1], heading[0]];
  for (const wanted of [left, heading, right]) {
    for (let index = 0; index < options.length; index += 1) {
      const candidate = options[index]!;
      if (candidate[0] - at[0] === wanted[0] && candidate[1] - at[1] === wanted[1]) {
        return options.splice(index, 1)[0]!;
      }
    }
  }
  throw new Error("a corner's ways out are its own edges");
}

/**
 * The boundary of the piece this mask holds, along the pixels' edges.
 *
 * Vertices sit at pixel corners, so a lone lit pixel comes back as its unit
 * square. Clockwise, starting at the top-left corner of the topmost-leftmost lit
 * pixel — a corner with exactly one way in and one way out, which is what lets
 * the walk stop on reaching it again.
 *
 * Only boundary pixels are ever visited, so the walk is linear in the perimeter
 * rather than in the area. Holes have rings of their own and it never reaches
 * them.
 */
export function outline(mask: BinaryMask): Point[] {
  const found = runs(mask);
  if (found.length === 0) return [];
  const { rows } = bits(mask, 0);
  const height = rows.length;
  const stride = mask.width + 2;
  const edges = new Map<number, Corner[]>();
  const add = (sx: number, sy: number, ex: number, ey: number): void => {
    const at = sy * stride + sx;
    const here = edges.get(at);
    if (here) here.push([ex, ey]);
    else edges.set(at, [[ex, ey]]);
  };

  for (let y = 0; y < height; y += 1) {
    const row = rows[y]!;
    if (row === 0n) continue;
    const above = y > 0 ? rows[y - 1]! : 0n;
    const below = y + 1 < height ? rows[y + 1]! : 0n;
    for (const x of setBits(row & ~above)) add(x, y, x + 1, y);
    for (const x of setBits(row & ~(row >> 1n))) add(x + 1, y, x + 1, y + 1);
    for (const x of setBits(row & ~below)) add(x + 1, y + 1, x, y + 1);
    for (const x of setBits(row & ~(row << 1n))) add(x, y + 1, x, y);
  }

  const start: Corner = [found[0]![1], found[0]![0]];
  const ring: Corner[] = [start];
  let current = start;
  let heading: Corner = [1, 0];
  for (;;) {
    const options = edges.get(current[1] * stride + current[0]);
    if (options === undefined || options.length === 0) {
      throw new Error("the outline walk left the piece it started in");
    }
    const following = options.length === 1 ? options.pop()! : turned(options, current, heading);
    heading = [following[0] - current[0], following[1] - current[1]];
    if (following[0] === start[0] && following[1] === start[1]) break;
    ring.push(following);
    current = following;
  }
  return ring.map(([x, y]): Point => [x, y]);
}

/**
 * One pass of corner cutting over a closed ring.
 *
 * Every edge is replaced by the two points a quarter and three quarters of the
 * way along it. On the unit-edge ring {@link outline} produces, that turns a
 * staircase into a straight or gently curved line while moving no corner by more
 * than half a pixel. Run on a ring whose straight runs had already been merged
 * it would round the real corners of a rectangle, which is why it comes before
 * any reduction.
 */
export function smoothed(ring: readonly Point[]): Point[] {
  if (ring.length < 3) return [...ring];
  const out: Point[] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const [px, py] = ring[index]!;
    const [qx, qy] = ring[(index + 1) % ring.length]!;
    out.push([0.75 * px + 0.25 * qx, 0.75 * py + 0.25 * qy]);
    out.push([0.25 * px + 0.75 * qx, 0.25 * py + 0.75 * qy]);
  }
  return out;
}

/** The canonical boundary: traced, smoothed, reduced once at the floor. */
export function contour(mask: BinaryMask): Point[] {
  return simplified(smoothed(outline(mask)), MINIMUM_TOLERANCE);
}
