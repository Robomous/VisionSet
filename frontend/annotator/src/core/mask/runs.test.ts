import { describe, expect, it } from "vitest";

import { bboxFrom, maskOf, runs, spans } from "./runs";

describe("runs", () => {
  it("finds every maximal run in reading order", () => {
    const mask = maskOf(6, 3, [
      [0, 1, 2],
      [0, 4, 5],
      [2, 0, 0],
    ]);
    expect(runs(mask)).toEqual([
      [0, 1, 2],
      [0, 4, 5],
      [2, 0, 0],
    ]);
  });

  it("ends a run at the row's edge when the row ends lit", () => {
    expect(runs(maskOf(4, 1, [[0, 2, 3]]))).toEqual([[0, 2, 3]]);
  });

  it("has nothing to say about an empty mask", () => {
    expect(runs(maskOf(4, 4, []))).toEqual([]);
  });
});

describe("spans", () => {
  it("gives one entry per row, from its first lit pixel to its last", () => {
    const mask = maskOf(6, 2, [
      [0, 1, 1],
      [0, 4, 5],
      [1, 3, 3],
    ]);
    expect(spans(mask)).toEqual([
      [0, 1, 5],
      [1, 3, 3],
    ]);
  });
});

describe("bboxFrom", () => {
  it("is the pixels' outer edge, so one lit pixel is one unit across", () => {
    expect(bboxFrom(maskOf(5, 5, [[2, 3, 3]]))).toEqual({
      type: "bbox",
      x: 3,
      y: 2,
      width: 1,
      height: 1,
    });
  });

  it("spans every row it was given", () => {
    const mask = maskOf(10, 10, [
      [2, 1, 4],
      [3, 6, 8],
    ]);
    expect(bboxFrom(mask)).toEqual({ type: "bbox", x: 1, y: 2, width: 8, height: 2 });
  });

  it("answers nothing for an empty mask rather than raising", () => {
    expect(bboxFrom(maskOf(4, 4, []))).toBeNull();
  });
});
