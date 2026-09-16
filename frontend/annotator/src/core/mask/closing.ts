/**
 * Step 2 — close the small gaps in a piece, wherever they are.
 *
 * A morphological close: grow the shape, then shrink it back by the same amount.
 * Anything narrower than the reach is bridged on the way out and not re-opened
 * on the way back, and everything wider is left exactly as it was.
 *
 * ## Why bitsets, and why `BigInt`
 *
 * The two passes are whole-row shifts and ORs. Written as nested loops over
 * pixels they would be a step per pixel per radius step, on the path somebody is
 * waiting on after a click. `BigInt` rather than a number mask because a mask
 * wider than 32 pixels would silently lose its top bits — and because Python's
 * `int` and JavaScript's `BigInt` are the same arbitrary-precision
 * two's-complement under `&`, `|`, `~`, `<<` and `>>`, which is what lets this
 * be a port rather than a rewrite.
 */

import type { BinaryMask } from "./binaryMask";
import { runs } from "./runs";

/** The largest gap closed, as a share of the piece's own lit area. */
export const CLOSING_REACH = 0.002;

/** However large the piece, the reach stops here. */
export const MAXIMUM_CLOSING_RADIUS = 6;

/** The mask as one integer per row, offset by `pad` on every side. */
export function bits(mask: BinaryMask, pad: number): { rows: bigint[]; width: number } {
  const width = mask.width + 2 * pad;
  const rows = new Array<bigint>(mask.height + 2 * pad).fill(0n);
  for (const [y, first, last] of runs(mask)) {
    const span = (1n << BigInt(last - first + 1)) - 1n;
    rows[y + pad] = rows[y + pad]! | (span << BigInt(first + pad));
  }
  return { rows, width };
}

function joined(rows: readonly bigint[]): bigint {
  let all = 0n;
  for (const row of rows) all |= row;
  return all;
}

function met(rows: readonly bigint[]): bigint {
  let all = rows[0]!;
  for (let index = 1; index < rows.length; index += 1) all &= rows[index]!;
  return all;
}

/** Every lit pixel spread by `radius` in each direction — a square dilation. */
function grown(rows: readonly bigint[], radius: number, width: number): bigint[] {
  const frame = (1n << BigInt(width)) - 1n;
  const across: bigint[] = [];
  for (const row of rows) {
    let spread = row;
    for (let step = 1; step <= radius; step += 1) {
      const shift = BigInt(step);
      spread |= (row << shift) | (row >> shift);
    }
    across.push(spread & frame);
  }
  const height = rows.length;
  const out: bigint[] = [];
  for (let y = 0; y < height; y += 1) {
    out.push(joined(across.slice(Math.max(0, y - radius), Math.min(height, y + radius + 1))));
  }
  return out;
}

/**
 * The dual: a pixel survives only with its whole square neighbourhood lit.
 *
 * Outside the frame counts as unlit, which the shifts give for free — bits move
 * off the end and zeros arrive — and which is right here because the frame was
 * padded wide enough that nothing real sits against its edge.
 */
function shrunk(rows: readonly bigint[], radius: number, width: number): bigint[] {
  const frame = (1n << BigInt(width)) - 1n;
  const across: bigint[] = [];
  for (const row of rows) {
    let kept = row;
    for (let step = 1; step <= radius; step += 1) {
      const shift = BigInt(step);
      kept &= (row << shift) & (row >> shift) & frame;
    }
    across.push(kept & frame);
  }
  const height = rows.length;
  const out: bigint[] = [];
  for (let y = 0; y < height; y += 1) {
    out.push(
      radius <= y && y < height - radius
        ? met(across.slice(Math.max(0, y - radius), Math.min(height, y + radius + 1)))
        : 0n,
    );
  }
  return out;
}

/**
 * How far to reach, for a piece of this size.
 *
 * A hole of area `a` needs a reach of about `sqrt(a) / 2` to be bridged, so the
 * radius comes from the piece's own lit area rather than from a pixel count.
 * Truncated — `Math.trunc` mirrors Python's `int()` — so the smallest shapes get
 * no closing at all rather than one that would swallow a feature. That
 * truncation is also what absorbs the one-ulp difference between `Math.sqrt`
 * and Python's `** 0.5`: it never survives to change the truncated result.
 */
export function closingRadius(mask: BinaryMask): number {
  let alight = 0;
  for (const [, first, last] of runs(mask)) alight += last - first + 1;
  return Math.min(Math.trunc(Math.sqrt(alight * CLOSING_REACH) / 2), MAXIMUM_CLOSING_RADIUS);
}

/**
 * The piece with its narrow gaps closed.
 *
 * Returns the mask unchanged — the same object — when the reach works out at
 * nothing or the shape has no gap that narrow, which is the common case and
 * saves rebuilding a grid to say so.
 *
 * A close only ever adds pixels whose whole neighbourhood was already reachable,
 * so it cannot push an edge outward and the extent does not move. That is why
 * the box branch skips this step entirely.
 */
export function filled(mask: BinaryMask): BinaryMask {
  const radius = closingRadius(mask);
  if (radius < 1) return mask;
  const { rows: before, width } = bits(mask, radius);
  const after = shrunk(grown(before, radius, width), radius, width);
  if (after.every((row, index) => row === before[index])) return mask;

  const data = new Uint8Array(mask.width * mask.height);
  for (let y = 0; y < mask.height; y += 1) {
    // One binary rendering per row rather than a shift per pixel: reading bit
    // `x` out of a wide BigInt costs the whole word, and a 4K row is 3840 of
    // them. This is Python's `format(word, "0Nb")[::-1]` without the reversal.
    const text = after[y + radius]!.toString(2);
    const top = text.length - 1;
    const base = y * mask.width;
    for (let x = 0; x < mask.width; x += 1) {
      const at = top - (x + radius);
      data[base + x] = at >= 0 && text.charCodeAt(at) === 49 ? 1 : 0;
    }
  }
  return { width: mask.width, height: mask.height, mask: data };
}
