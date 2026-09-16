import { describe, expect, it } from "vitest";

import { MINIMUM_TOLERANCE, simplified } from "../geometry/simplify";
import { contour, outline, smoothed } from "./outline";
import { maskOf } from "./runs";
import type { Run } from "./runs";

const square = (size: number, at = 0) =>
  maskOf(size + at * 2, size + at * 2, Array.from({ length: size }, (_, y): Run => [y + at, at, at + size - 1]));

describe("outline", () => {
  it("is the pixels' edges, not their centres", () => {
    expect(outline(maskOf(3, 3, [[1, 1, 1]]))).toEqual([
      [1, 1],
      [2, 1],
      [2, 2],
      [1, 2],
    ]);
  });

  it("walks a rectangle's four corners clockwise from its top-left", () => {
    expect(outline(square(3))).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 1],
      [3, 2],
      [3, 3],
      [2, 3],
      [1, 3],
      [0, 3],
      [0, 2],
      [0, 1],
    ]);
  });

  it("makes one ring of two pixels touching only at a corner", () => {
    // Eight corners with only seven distinct: the shared corner (2,2) is
    // visited twice, which is precisely what the left-turn-first rule produces
    // — it crosses onto the second pixel rather than closing round the first.
    // Asserting the sequence pins that rule; asserting distinctness would be
    // false, and asserting a length would not tell the two turns apart.
    expect(outline(maskOf(4, 4, [
      [1, 1, 1],
      [2, 2, 2],
    ]))).toEqual([
      [1, 1],
      [2, 1],
      [2, 2],
      [3, 2],
      [3, 3],
      [2, 3],
      [2, 2],
      [1, 2],
    ]);
  });

  it("never reaches an enclosed hole", () => {
    const withHole = maskOf(5, 5, [
      [1, 1, 3],
      [2, 1, 1],
      [2, 3, 3],
      [3, 1, 3],
    ]);
    expect(outline(withHole)).toEqual(outline(maskOf(5, 5, [
      [1, 1, 3],
      [2, 1, 3],
      [3, 1, 3],
    ])));
  });

  it("has nothing to say about an empty mask", () => {
    expect(outline(maskOf(4, 4, []))).toEqual([]);
  });
});

describe("smoothed", () => {
  it("cuts every corner at a quarter and three quarters of its edges", () => {
    expect(smoothed([
      [0, 0],
      [2, 0],
      [0, 2],
    ])).toEqual([
      [0.5, 0],
      [1.5, 0],
      [1.5, 0.5],
      [0.5, 1.5],
      [0, 1.5],
      [0, 0.5],
    ]);
  });

  it("leaves anything shorter than a ring alone, as a copy", () => {
    const pair: [number, number][] = [
      [0, 0],
      [1, 1],
    ];
    expect(smoothed(pair)).toEqual(pair);
    expect(smoothed(pair)).not.toBe(pair);
  });

  it("never leaves the ring it was given", () => {
    const ring = outline(square(6));
    for (const [x, y] of smoothed(ring)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(6);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(6);
    }
  });
});

describe("contour", () => {
  it("is the smoothed trace reduced once at the floor", () => {
    const mask = square(12);
    expect(contour(mask)).toEqual(simplified(smoothed(outline(mask)), MINIMUM_TOLERANCE));
  });

  it("turns a staircase into one straight edge", () => {
    const stair = maskOf(8, 8, [
      [1, 1, 1],
      [2, 1, 2],
      [3, 1, 3],
      [4, 1, 4],
    ]);
    expect(contour(stair).length).toBeLessThan(outline(stair).length);
  });

  it("has nothing to say about an empty mask", () => {
    expect(contour(maskOf(4, 4, []))).toEqual([]);
  });
});
