import { describe, expect, it } from "vitest";

import { canonicalRanges, expectedFrames, gridBounds, gridTimestamps, type TimeRange } from "./index";

const range = (startSeconds: number, endSeconds: number): TimeRange => ({ startSeconds, endSeconds });

describe("canonicalRanges", () => {
  it("clamps ends to duration and drops what the clamp emptied", () => {
    expect(canonicalRanges([range(8, 12)], 10)).toEqual([range(8, 10)]);
    expect(canonicalRanges([range(10, 12)], 10)).toEqual([]);
  });

  it("sorts by start", () => {
    expect(canonicalRanges([range(5, 6), range(1, 2)], 10)).toEqual([range(1, 2), range(5, 6)]);
  });

  it("merges overlapping ranges", () => {
    expect(canonicalRanges([range(0, 3), range(2, 5)], 10)).toEqual([range(0, 5)]);
  });

  it("merges adjacent (touching) ranges", () => {
    expect(canonicalRanges([range(0, 3), range(3, 5)], 10)).toEqual([range(0, 5)]);
  });

  it("canonicalizes a whole-clip cover to the empty selection", () => {
    expect(canonicalRanges([range(0, 10)], 10)).toEqual([]);
    expect(canonicalRanges([range(0, 4), range(4, 10)], 10)).toEqual([]);
  });

  it("leaves a genuinely partial selection non-empty", () => {
    expect(canonicalRanges([range(0, 9.999)], 10)).toEqual([range(0, 9.999)]);
  });
});

describe("gridBounds", () => {
  it("is [ceil(start*fps), ceil(end*fps)) per range", () => {
    expect(gridBounds([range(0, 1), range(2, 2.5)], 10)).toEqual([
      [0, 10],
      [20, 25],
    ]);
  });

  it("rounds a fractional bound up", () => {
    expect(gridBounds([range(0.1, 0.9)], 10)).toEqual([[1, 9]]);
  });
});

describe("expectedFrames", () => {
  it("is the whole-clip grid count for an empty selection", () => {
    expect(expectedFrames([], 10, 5)).toBe(50);
  });

  it("catches the fractional-product off-by-one a floor estimate misses", () => {
    // duration*fps = 2.5: floor would give 2, but the grid includes t = 0 and
    // holds indices 0, 1, 2 (t = 0, 0.4, 0.8), so the true count is 3.
    expect(expectedFrames([], 1, 2.5)).toBe(3);
  });

  it("sums per-range span widths for a non-empty selection", () => {
    expect(expectedFrames([range(0, 1), range(2, 2.5)], 10, 10)).toBe(15);
  });
});

describe("gridTimestamps", () => {
  it("is lazy — a huge grid does not require materializing an array up front", () => {
    const iterator = gridTimestamps([], 1_000_000, 1)[Symbol.iterator]();
    expect(iterator.next()).toEqual({ value: 0, done: false });
    expect(iterator.next()).toEqual({ value: 1, done: false });
  });

  it("yields i/fps ascending for the whole clip", () => {
    expect([...gridTimestamps([], 1, 4)]).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it("yields ascending timestamps across multiple ranges in order", () => {
    expect([...gridTimestamps([range(0, 0.2), range(2, 2.2)], 10, 10)]).toEqual([0, 0.1, 2, 2.1]);
  });

  it("agrees with expectedFrames on how many timestamps exist", () => {
    const cases: [TimeRange[], number, number][] = [
      [[], 10, 5],
      [[], 1, 2.5],
      [[range(0, 1), range(2, 2.5)], 10, 10],
      [[range(0.1, 0.9)], 10, 10],
      [[range(0, 3), range(3, 5)], 10, 7],
    ];
    for (const [ranges, durationSeconds, fps] of cases) {
      const canonical = canonicalRanges(ranges, durationSeconds);
      expect([...gridTimestamps(canonical, durationSeconds, fps)].length).toBe(
        expectedFrames(canonical, durationSeconds, fps),
      );
    }
  });
});
