/**
 * A mask read as runs rather than pixels.
 *
 * Runs are what make every step after this one affordable on the interactive
 * path: a megapixel mask of one clean object is a few hundred runs, and the
 * loops below go round once per colour change in a row rather than once per
 * pixel. This is the authoritative Python's own choice, kept — see
 * `src/visionset/inference/masks.py`.
 */

import type { BinaryMask } from "./binaryMask";
import type { BboxGeometry } from "../types";

/** One maximal run of lit pixels: `[row, first, last]`, inclusive at both ends. */
export type Run = readonly [y: number, first: number, last: number];

/** Paint lit runs into a mask — the fixture's representation, and the tests'. */
export function maskOf(width: number, height: number, lit: readonly Run[]): BinaryMask {
  const data = new Uint8Array(width * height);
  for (const [y, first, last] of lit) {
    const base = y * width;
    for (let x = first; x <= last; x += 1) data[base + x] = 1;
  }
  return { width, height, mask: data };
}

/** Every maximal run of lit pixels, in reading order. */
export function runs(mask: BinaryMask): Run[] {
  const found: Run[] = [];
  const { width, height } = mask;
  const data = mask.mask;
  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    let at = 0;
    while (at < width) {
      let first = at;
      while (first < width && data[base + first] !== 1) first += 1;
      if (first === width) break;
      let cursor = first;
      while (cursor < width && data[base + cursor] !== 0) cursor += 1;
      const last = cursor - 1;
      found.push([y, first, last]);
      // +2 rather than +1: the pixel that ended the run is known unlit.
      at = last + 2;
    }
  }
  return found;
}

/** `[row, first, last]` for every row holding anything — the row's whole extent. */
export function spans(mask: BinaryMask): Run[] {
  const found: Run[] = [];
  const { width, height } = mask;
  const data = mask.mask;
  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    let first = -1;
    for (let x = 0; x < width; x += 1) {
      if (data[base + x] === 1) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let x = width - 1; x > first; x -= 1) {
      if (data[base + x] === 1) {
        last = x;
        break;
      }
    }
    found.push([y, first, last]);
  }
  return found;
}

/**
 * The mask's extent, or `null` if it holds nothing.
 *
 * `null` rather than a throw: an empty mask is an ordinary answer from a model
 * asked about an empty patch of sky, and the caller turns it into "no
 * suggestion". The box is the pixels' outer edge, so a single lit pixel is one
 * wide and one tall rather than zero.
 */
export function bboxFrom(mask: BinaryMask): BboxGeometry | null {
  const rows = spans(mask);
  if (rows.length === 0) return null;
  const top = rows[0]![0];
  const bottom = rows[rows.length - 1]![0];
  let left = Infinity;
  let right = -Infinity;
  for (const [, first, last] of rows) {
    if (first < left) left = first;
    if (last > right) right = last;
  }
  return { type: "bbox", x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
