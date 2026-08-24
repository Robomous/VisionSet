/**
 * The TypeScript half of the mirrored range arithmetic.
 *
 * The kernel's own tests prove the same formulas against a real extraction;
 * these pin the mirror, fractional boundaries included, so the two spellings
 * cannot drift apart silently.
 */

import { describe, expect, it } from "vitest";

import { clock, expectedFrames, mergedRanges, selectedSeconds } from "./clipRanges";

function r(start: number, end: number): { start_seconds: number; end_seconds: number } {
  return { start_seconds: start, end_seconds: end };
}

describe("mergedRanges", () => {
  it("sorts, merges overlaps and touches, and clamps to the clip", () => {
    expect(mergedRanges([r(1.2, 1.8), r(0.2, 1.5)], 2)).toEqual([r(0.2, 1.8)]);
    expect(mergedRanges([r(0, 1), r(1, 1.5)], 2)).toEqual([r(0, 1.5)]);
    expect(mergedRanges([r(1, 9), r(5, 6)], 2)).toEqual([r(1, 2)]);
  });

  it("collapses a full cover to the empty selection, the one whole-clip spelling", () => {
    expect(mergedRanges([r(0, 2)], 2)).toEqual([]);
    expect(mergedRanges([r(0, 1), r(0.5, 7)], 2)).toEqual([]);
  });

  it("drops what the clamp emptied", () => {
    expect(mergedRanges([r(5, 6)], 2)).toEqual([]);
  });
});

describe("expectedFrames", () => {
  it("includes the frame at zero — ceil, not the old floor", () => {
    // floor(47.7 × 1) was 47; extraction emits grid points 0 through 47 — 48.
    expect(expectedFrames([], 47.7, 1)).toBe(48);
    expect(expectedFrames([], 2, 10)).toBe(20);
  });

  it("counts half-open grid points per range", () => {
    expect(expectedFrames([r(0.55, 1.25)], 2, 10)).toBe(7);
    expect(expectedFrames([r(0.5, 1.5)], 2, 5)).toBe(5);
  });

  it("counts a boundary grid point exactly once", () => {
    expect(expectedFrames([r(0, 1), r(1, 2)], 2, 5)).toBe(expectedFrames([], 2, 5));
  });
});

describe("selectedSeconds", () => {
  it("sums a merged selection and answers the whole clip for the empty one", () => {
    expect(selectedSeconds([r(0.5, 1.5), r(1.8, 2)], 2)).toBeCloseTo(1.2);
    expect(selectedSeconds([], 2)).toBe(2);
  });
});

describe("clock", () => {
  it("speaks m:ss, keeping tenths only when they exist", () => {
    expect(clock(75)).toBe("1:15");
    expect(clock(7.5)).toBe("0:07.5");
    expect(clock(0)).toBe("0:00");
    expect(clock(59.96)).toBe("1:00");
  });
});
