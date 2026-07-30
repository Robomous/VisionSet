/**
 * The four primitives, and the one claim about `Bounds` a reader should not have
 * to take on faith: that an `AssetDescriptor` is already a frame.
 */

import { describe, expect, it } from "vitest";

import { ASSET } from "../state/_sample";
import {
  clampPoint,
  closestPointOnSegment,
  distance,
  type Bounds,
} from "./primitives";

describe("measuring between points", () => {
  it("is zero at a point and symmetric", () => {
    expect(distance([3, 4], [3, 4])).toBe(0);
    expect(distance([0, 0], [3, 4])).toBe(5);
    expect(distance([3, 4], [0, 0])).toBe(5);
  });

  it("projects onto a segment", () => {
    expect(closestPointOnSegment([5, 9], [0, 0], [10, 0])).toEqual([5, 0]);
  });

  it("stops at the ends rather than running down the infinite line", () => {
    expect(closestPointOnSegment([-40, 3], [0, 0], [10, 0])).toEqual([0, 0]);
    expect(closestPointOnSegment([40, 3], [0, 0], [10, 0])).toEqual([10, 0]);
  });

  it("returns the start when the segment has no length", () => {
    // A polygon carrying a duplicated vertex. Without the guard this divides by
    // zero and every downstream distance is NaN.
    const answer = closestPointOnSegment([7, 7], [2, 2], [2, 2]);
    expect(answer).toEqual([2, 2]);
    expect(distance([7, 7], answer)).toBeGreaterThan(0);
  });
});

describe("a point pushed back inside the frame", () => {
  const frame: Bounds = { width: 100, height: 50 };

  it("passes an inside point through", () => {
    expect(clampPoint([40, 20], frame)).toEqual([40, 20]);
  });

  it("clamps at each of the four corners", () => {
    expect(clampPoint([-1, -1], frame)).toEqual([0, 0]);
    expect(clampPoint([999, -1], frame)).toEqual([100, 0]);
    expect(clampPoint([-1, 999], frame)).toEqual([0, 50]);
    expect(clampPoint([999, 999], frame)).toEqual([100, 50]);
  });

  it("keeps the edges themselves, which are inside", () => {
    expect(clampPoint([0, 0], frame)).toEqual([0, 0]);
    expect(clampPoint([100, 50], frame)).toEqual([100, 50]);
  });
});

describe("a frame is a width and a height", () => {
  it("accepts an asset descriptor without conversion", () => {
    // The assignment is the assertion: if `AssetDescriptor` ever stopped
    // satisfying `Bounds`, this line would not compile. `pnpm lint` runs the
    // typecheck, so the claim is enforced rather than decorative.
    const frame: Bounds = ASSET;
    expect(clampPoint([999, 999], frame)).toEqual([ASSET.width, ASSET.height]);
  });
});
