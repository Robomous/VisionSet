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

describe("contract: Python index(True)/index(False) asymmetry", () => {
  // runs() uses index(True) to find start (advances while byte !== 1) and
  // index(False) to find end (advances while byte !== 0). This asymmetry
  // means out-of-contract bytes (e.g. 255) are treated differently: they
  // never start a run, but they extend a run. spans() uses index(True) for
  // both directions, so it only counts 1 as lit. These tests pin that
  // distinction — without them, the next reader will "simplify" back.

  it("runs(): 255 inside a run extends the run", () => {
    const mask = { width: 5, height: 1, mask: new Uint8Array([0, 1, 255, 1, 0]) };
    expect(runs(mask)).toEqual([[0, 1, 3]]);
  });

  it("runs(): 255 alone never starts a run", () => {
    const mask = { width: 2, height: 1, mask: new Uint8Array([255, 0]) };
    expect(runs(mask)).toEqual([]);
  });

  it("runs(): run extends through 255 to row end", () => {
    const mask = { width: 3, height: 1, mask: new Uint8Array([1, 1, 255]) };
    expect(runs(mask)).toEqual([[0, 0, 2]]);
  });

  it("spans(): stops at the last actual 1, ignoring trailing 255", () => {
    const mask = { width: 3, height: 1, mask: new Uint8Array([1, 1, 255]) };
    expect(spans(mask)).toEqual([[0, 0, 1]]);
  });

  it("spans(): 255 alone is not a row", () => {
    const mask = { width: 2, height: 1, mask: new Uint8Array([255, 0]) };
    expect(spans(mask)).toEqual([]);
  });
});
