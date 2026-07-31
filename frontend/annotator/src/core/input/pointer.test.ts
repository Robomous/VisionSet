/**
 * The two pointer guards.
 *
 * Small, and every case is one somebody's hardware or arithmetic produces: a
 * mouse with side buttons, and a transform that divided by a zero-width element
 * before its layout settled.
 */

import { describe, expect, it } from "vitest";

import { pointerButton, pointerPoint } from "./pointer";

describe("pointerButton", () => {
  it("names the three the engine knows", () => {
    expect(pointerButton(0)).toBe("primary");
    expect(pointerButton(1)).toBe("auxiliary");
    expect(pointerButton(2)).toBe("secondary");
  });

  it("refuses a side button rather than pretending it is one of those", () => {
    expect(pointerButton(3)).toBeNull();
    expect(pointerButton(4)).toBeNull();
  });

  it("refuses anything that is not one of the three numbers", () => {
    for (const button of [-1, 1.5, 99, Number.NaN]) {
      expect(pointerButton(button)).toBeNull();
    }
  });
});

describe("pointerPoint", () => {
  it("hands back the pair for finite numbers", () => {
    expect(pointerPoint(12, 34)).toEqual([12, 34]);
  });

  it("refuses a non-finite value in either coordinate", () => {
    expect(pointerPoint(Number.NaN, 34)).toBeNull();
    expect(pointerPoint(12, Number.NaN)).toBeNull();
    expect(pointerPoint(Number.POSITIVE_INFINITY, 0)).toBeNull();
    expect(pointerPoint(0, Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it("does not clamp — machine.ts clamps per state, and a second clamp would move the hit test", () => {
    expect(pointerPoint(-3.5, 1e6)).toEqual([-3.5, 1e6]);
  });

  it("does not round — a drag keeps the sub-pixel precision the geometry was written for", () => {
    expect(pointerPoint(0.25, 0.75)).toEqual([0.25, 0.75]);
  });
});
