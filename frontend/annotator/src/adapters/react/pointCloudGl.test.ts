import { describe, expect, it } from "vitest";

import { cssColorToRgb } from "./pointCloudGl";
import { classColor } from "./paint";

function expectRgb(actual: readonly number[], expected: readonly number[]): void {
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 3));
}

describe("cssColorToRgb", () => {
  it("reads both hex spellings", () => {
    expectRgb(cssColorToRgb("#38bdf8"), [0x38 / 255, 0xbd / 255, 0xf8 / 255]);
    expectRgb(cssColorToRgb("#f00"), [1, 0, 0]);
  });

  it("reads the hsl the class palette falls back to", () => {
    expectRgb(cssColorToRgb("hsl(120 100% 50%)"), [0, 1, 0]);
    expectRgb(cssColorToRgb("hsl(240, 100%, 25%)"), [0, 0, 0.5]);
    const fallback = classColor(undefined, "pedestrian");
    expect(fallback.startsWith("hsl(")).toBe(true);
    expect(cssColorToRgb(fallback)).not.toEqual([1, 1, 1]);
  });

  it("draws anything else white rather than not at all", () => {
    expect(cssColorToRgb("rebeccapurple")).toEqual([1, 1, 1]);
  });
});
