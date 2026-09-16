import { describe, expect, it } from "vitest";

import { components } from "./components";
import { maskOf } from "./runs";
import type { Run } from "./runs";

/** A 1-px speck in the topmost row and a 36-px object below-left. */
const speckled = () => {
  const lit: Run[] = [[0, 9, 9]];
  for (let y = 3; y < 9; y += 1) lit.push([y, 1, 6]);
  return maskOf(10, 10, lit);
};

/** 25 px on the left, 16 px on the right, far apart. */
const islands = () => {
  const lit: Run[] = [];
  for (let y = 2; y < 7; y += 1) lit.push([y, 1, 5]);
  for (let y = 3; y < 7; y += 1) lit.push([y, 14, 17]);
  return maskOf(24, 12, lit);
};

/** Two five-pixel components rooted at run indices 3 and 8 — the tie case. */
const tied = () => {
  const lit: Run[] = [];
  for (const x of [0, 4, 8, 12, 16, 20, 24]) lit.push([0, x, x]);
  lit.push([1, 0, 0], [1, 2, 2]);
  for (const y of [1, 2, 3, 4]) lit.push([y, 12, 12]);
  for (const y of [2, 3, 4, 5]) lit.push([y, 2, 2]);
  return maskOf(30, 7, lit);
};

describe("components", () => {
  it("has nothing to say about an empty mask", () => {
    expect(components(maskOf(8, 8, []))).toEqual([]);
  });

  it("drops a speck before anything else looks at the mask", () => {
    const pieces = components(speckled());
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.x).toBe(1);
    expect(pieces[0]!.y).toBe(3);
  });

  it("leads with the piece under the click, not the topmost-leftmost one", () => {
    expect(components(speckled(), [[3, 5]])[0]!.x).toBe(1);
  });

  it("leads with the pointed piece even when it is not the biggest", () => {
    expect(components(islands(), [[15, 4]])[0]!.x).toBe(14);
  });

  it("falls back to the nearest piece for a click that is inside none", () => {
    expect(components(islands(), [[20, 4]])[0]!.x).toBe(14);
  });

  it("prefers the largest of the pieces several points land in", () => {
    expect(
      components(islands(), [
        [15, 4],
        [3, 4],
      ])[0]!.x,
    ).toBe(1);
  });

  it("settles an equal-area tie by reading order, whichever way the points arrive", () => {
    expect(components(tied(), [[12, 2], [2, 3]])[0]!.x).toBe(12);
    expect(components(tied(), [[2, 3], [12, 2]])[0]!.x).toBe(12);
  });

  it("returns every survivor biggest-first behind the pointed one", () => {
    const pieces = components(islands(), [[15, 4]]);
    expect(pieces.map((piece) => piece.x)).toEqual([14, 1]);
  });

  it("joins pixels that touch only at a corner", () => {
    const diagonal = maskOf(4, 4, [
      [1, 1, 1],
      [2, 2, 2],
    ]);
    expect(components(diagonal)).toHaveLength(1);
  });

  it("selects the component Python's rounding points at, not Math.round's", () => {
    // A single half-pixel click cannot tell the two roundings apart: the two
    // candidate pixels are either one run or 8-connected, so they share a
    // component, and a rounding that lands on nothing falls back to the piece
    // the click is nearly inside anyway. It takes a *second* point, so that the
    // largest-wins rule has something to choose between.
    //
    // A is 12 px across rows 1-2; B is 4 px, well away. The first point sits at
    // y = 2.5: Python's half-to-even reads row 2, which is A, so `under` holds
    // both and the larger wins. Math.round reads row 3, which is empty, so
    // `under` holds only B and the answer is B.
    const two = maskOf(12, 8, [
      [1, 0, 5],
      [2, 0, 5],
      [1, 8, 9],
      [2, 8, 9],
    ]);
    expect(components(two, [[2, 2.5], [8, 1]])[0]!.x).toBe(0);
  });
});
