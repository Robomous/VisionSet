/**
 * Step 1 — which pieces of a mask are worth turning into shapes.
 *
 * Union-find over *runs* rather than a flood fill over pixels, and the ordering
 * at the end is the whole difference between the two geometries: a polygon
 * takes the head of this list because a click asks about one object, and a
 * box takes the union of all of it because a mask arriving in several pieces
 * is nearly always one object seen around an occlusion.
 */

import type { Point } from "../types";
import { pythonRound, type BinaryMask, type Piece } from "./binaryMask";
import { runs, type Run } from "./runs";

/**
 * How big a piece has to be, against the biggest one, to survive the noise
 * filter. Relative to the largest piece rather than to the frame, so it means
 * the same thing on a mask covering everything and a mask covering a corner.
 */
export const MINIMUM_FRAGMENT_SHARE = 0.05;

/** Do two runs on neighbouring rows touch, counting diagonals? */
function adjacent(one: Run, other: Run): boolean {
  return one[1] <= other[2] + 1 && other[1] <= one[2] + 1;
}

/** One label per run: which piece it belongs to, 8-connected. */
function labelled(found: readonly Run[]): number[] {
  const parent = found.map((_, index) => index);
  const root = (index: number): number => {
    let at = index;
    while (parent[at] !== at) {
      parent[at] = parent[parent[at]!]!;
      at = parent[at]!;
    }
    return at;
  };
  const join = (left: number, right: number): void => {
    const one = root(left);
    const other = root(right);
    // The earlier run wins, so a label is always its piece's first run.
    if (one !== other) parent[Math.max(one, other)] = Math.min(one, other);
  };

  const rows = new Map<number, number[]>();
  found.forEach((run, index) => {
    const here = rows.get(run[0]);
    if (here) here.push(index);
    else rows.set(run[0], [index]);
  });
  for (const [y, here] of rows) {
    const above = rows.get(y - 1);
    if (!above) continue;
    let mine = 0;
    let prior = 0;
    while (mine < here.length && prior < above.length) {
      const ours = found[here[mine]!]!;
      const theirs = found[above[prior]!]!;
      if (adjacent(ours, theirs)) join(here[mine]!, above[prior]!);
      if (ours[2] < theirs[2]) mine += 1;
      else prior += 1;
    }
  }
  return found.map((_, index) => root(index));
}

/** Squared distance from a point to a run, which is a horizontal segment of pixels. */
function squaredGap(point: Point, run: Run): number {
  const [x, y] = point;
  const [row, first, last] = run;
  const across = Math.max(0, first - x, x - last);
  return across * across + (row - y) * (row - y);
}

/** Lit pixels per label, summed off the runs rather than counted. */
function areas(found: readonly Run[], labels: readonly number[]): Map<number, number> {
  const size = new Map<number, number>();
  found.forEach((run, index) => {
    const label = labels[index]!;
    size.set(label, (size.get(label) ?? 0) + run[2] - run[1] + 1);
  });
  return size;
}

/**
 * The label of the piece the prompt asks about.
 *
 * A point inside a piece picks that piece; several points inside several pieces
 * pick the largest of them, and two of the same size pick the lowest label —
 * the piece whose earliest run comes first, which is the `(-size, label)` order
 * applied to the rest of the list below. A point inside none of them picks the
 * piece nearest the point. Without any point the topmost-leftmost piece wins.
 * Negatives never select: they say what the shape is not, and a piece is chosen
 * before its shape is known.
 */
function pointedAt(
  found: readonly Run[],
  labels: readonly number[],
  size: ReadonlyMap<number, number>,
  at: readonly Point[],
): number {
  if (at.length === 0) return labels[0]!;

  const under = new Set<number>();
  for (const point of at) {
    const x = pythonRound(point[0]);
    const y = pythonRound(point[1]);
    found.forEach((run, index) => {
      if (run[0] === y && run[1] <= x && x <= run[2]) under.add(labels[index]!);
    });
  }
  if (under.size > 0) {
    let best = -1;
    for (const label of under) {
      if (best < 0) {
        best = label;
        continue;
      }
      const ours = size.get(label)!;
      const theirs = size.get(best)!;
      if (ours > theirs || (ours === theirs && label < best)) best = label;
    }
    return best;
  }

  let nearest = 0;
  let closest = Infinity;
  found.forEach((run, index) => {
    let ours = Infinity;
    for (const point of at) {
      const found_ = squaredGap(point, run);
      if (found_ < ours) ours = found_;
    }
    if (ours < closest) {
      closest = ours;
      nearest = index;
    }
  });
  return labels[nearest]!;
}

/** That label's runs, painted into a mask the size of their own extent. */
function cropped(label: number, found: readonly Run[], labels: readonly number[]): Piece {
  const mine = found.filter((_, index) => labels[index] === label);
  const top = mine[0]![0];
  const bottom = mine[mine.length - 1]![0];
  let left = Infinity;
  let right = -Infinity;
  for (const [, first, last] of mine) {
    if (first < left) left = first;
    if (last > right) right = last;
  }
  const width = right - left + 1;
  const height = bottom - top + 1;
  const data = new Uint8Array(width * height);
  for (const [row, first, last] of mine) {
    const base = (row - top) * width;
    for (let x = first - left; x <= last - left; x += 1) data[base + x] = 1;
  }
  return { x: left, y: top, mask: { width, height, mask: data } };
}

/**
 * The pieces of the mask worth turning into shapes.
 *
 * Everything below {@link MINIMUM_FRAGMENT_SHARE} of the largest piece is
 * dropped as noise, first and unconditionally. What survives is ordered with the
 * piece the prompt points at at the head and the rest biggest-first behind it,
 * ties by the lowest label, so the answer is stable for a given mask.
 *
 * An empty mask answers with no pieces, which is an ordinary answer and not an
 * error — the click landed on sky.
 */
export function components(mask: BinaryMask, at: readonly Point[] = []): Piece[] {
  const found = runs(mask);
  if (found.length === 0) return [];
  const labels = labelled(found);
  const size = areas(found, labels);

  let largest = 0;
  for (const area of size.values()) if (area > largest) largest = area;
  const floor = largest * MINIMUM_FRAGMENT_SHARE;

  const survived = new Set<number>();
  for (const [label, area] of size) if (area >= floor) survived.add(label);

  const keptRuns: Run[] = [];
  const keptLabels: number[] = [];
  found.forEach((run, index) => {
    if (survived.has(labels[index]!)) {
      keptRuns.push(run);
      keptLabels.push(labels[index]!);
    }
  });

  const first = pointedAt(keptRuns, keptLabels, size, at);
  const rest = [...survived]
    .filter((label) => label !== first)
    .sort((one, other) => size.get(other)! - size.get(one)! || one - other);
  return [first, ...rest].map((label) => cropped(label, found, labels));
}
