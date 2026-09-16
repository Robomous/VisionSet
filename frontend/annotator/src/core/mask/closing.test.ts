import { describe, expect, it } from "vitest";

import { closingRadius, filled } from "./closing";
import { bboxFrom, maskOf, runs } from "./runs";
import type { Run } from "./runs";

const lit = (mask: { width: number; mask: Uint8Array }): number =>
  mask.mask.reduce((total: number, byte) => total + (byte === 0 ? 0 : 1), 0);

/** A solid square with a one-row bite `depth` pixels deep, cut in from the right. */
const notched = (depth: number, size = 64) => {
  const runsOf: Run[] = [];
  for (let y = 0; y < size; y += 1) {
    if (y === Math.floor(size / 2) && depth > 0) runsOf.push([y, 0, size - depth - 1]);
    else runsOf.push([y, 0, size - 1]);
  }
  return maskOf(size, size, runsOf);
};

/**
 * A 64x64 square with an 8x8 bite out of its right edge.
 *
 * Wide in *both* directions, which is what makes it a bay rather than a notch:
 * a one-row bite closes at radius 1 however deep it is, because the dimension
 * the close has to bridge is its height.
 */
const bayed = () => {
  const runsOf: Run[] = [];
  for (let y = 0; y < 64; y += 1) {
    if (y >= 28 && y < 36) runsOf.push([y, 0, 55]);
    else runsOf.push([y, 0, 63]);
  }
  return maskOf(64, 64, runsOf);
};

/**
 * A 64x64 square with a 2-px notch, inside an 80x80 canvas.
 *
 * Framed so background survives the close: `notched(2)` is the whole canvas but
 * for two pixels, and closing it leaves nothing unlit at all.
 */
const framedNotch = () => {
  const runsOf: Run[] = [];
  for (let y = 8; y < 72; y += 1) {
    if (y === 40) runsOf.push([y, 8, 69]);
    else runsOf.push([y, 8, 71]);
  }
  return maskOf(80, 80, runsOf);
};

/** A 64x64 square with a centred square hole `hole` pixels on a side. */
const holed = (hole: number, size = 64) => {
  const low = Math.floor(size / 2) - Math.floor(hole / 2);
  const runsOf: Run[] = [];
  for (let y = 0; y < size; y += 1) {
    if (y >= low && y < low + hole) {
      runsOf.push([y, 0, low - 1], [y, low + hole, size - 1]);
    } else {
      runsOf.push([y, 0, size - 1]);
    }
  }
  return maskOf(size, size, runsOf);
};

/** A `size`x`size` solid square, placed at the origin of a `canvas`x`canvas` frame. */
const solidSquareIn = (canvas: number, size: number) =>
  maskOf(canvas, canvas, Array.from({ length: size }, (_, y): Run => [y, 0, size - 1]));

describe("closingRadius", () => {
  it("scales with the piece's own area, not the frame", () => {
    expect(closingRadius(solidSquareIn(64, 64))).toBe(closingRadius(solidSquareIn(200, 64)));
    expect(closingRadius(notched(0, 200))).toBeGreaterThan(closingRadius(notched(0, 64)));
  });

  it("reaches nothing at all on a piece too small to have artefacts", () => {
    expect(closingRadius(maskOf(8, 8, [[3, 3, 4]]))).toBe(0);
  });

  it("stops at the cap however large the piece", () => {
    expect(
      closingRadius(maskOf(800, 800, Array.from({ length: 800 }, (_, y): Run => [y, 0, 799]))),
    ).toBe(6);
  });

  it("truncates rather than rounding, as Python's int() does", () => {
    // 14400 lit pixels -> sqrt(28.8) / 2 = 2.6832..., which truncates to 2 and
    // would round to 3. This is the assertion that catches a Math.round port.
    expect(
      closingRadius(maskOf(120, 120, Array.from({ length: 120 }, (_, y): Run => [y, 0, 119]))),
    ).toBe(2);
  });
});

describe("filled", () => {
  it("hands back the very same mask when the reach works out at nothing", () => {
    const small = maskOf(8, 8, [[3, 3, 4]]);
    expect(filled(small)).toBe(small);
  });

  it("hands back the very same mask when the close changes nothing", () => {
    const clean = notched(0);
    expect(filled(clean)).toBe(clean);
  });

  it("closes a notch narrower than the reach", () => {
    const narrow = notched(2);
    const after = filled(narrow);
    expect(after).not.toBe(narrow);
    expect(lit(after)).toBeGreaterThan(lit(narrow));
  });

  it("leaves a bay wider than the reach alone", () => {
    const wide = bayed();
    expect(filled(wide)).toBe(wide);
  });

  it("closes a one-row bite however deep it is, because its height is the gap", () => {
    const deep = notched(40);
    expect(filled(deep)).not.toBe(deep);
  });

  it("fills a small enclosed hole", () => {
    const withHole = holed(2);
    expect(lit(withHole)).toBe(64 * 64 - 4);
    expect(lit(filled(withHole))).toBe(64 * 64);
  });

  it("never moves the extent", () => {
    for (const mask of [notched(2), notched(5), holed(2)]) {
      expect(bboxFrom(filled(mask))).toEqual(bboxFrom(mask));
    }
  });

  it("keeps the mask's own dimensions", () => {
    const after = filled(notched(2));
    expect(after.width).toBe(64);
    expect(after.height).toBe(64);
    expect(after.mask.length).toBe(64 * 64);
  });

  it("answers only 0 and 1", () => {
    expect(new Set(filled(framedNotch()).mask)).toEqual(new Set([0, 1]));
  });

  it("leaves runs it did not need to touch exactly where they were", () => {
    const after = filled(notched(2));
    expect(runs(after)[0]).toEqual([0, 0, 63]);
  });
});
