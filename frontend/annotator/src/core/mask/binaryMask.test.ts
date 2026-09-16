import { describe, expect, it } from "vitest";

import { pythonRound } from "./binaryMask";

describe("pythonRound", () => {
  it("rounds a half to the even neighbour, as Python does", () => {
    expect(pythonRound(0.5)).toBe(0);
    expect(pythonRound(1.5)).toBe(2);
    expect(pythonRound(2.5)).toBe(2);
    expect(pythonRound(3.5)).toBe(4);
  });

  it("disagrees with Math.round on exactly the halves that decide a component", () => {
    for (const half of [0.5, 2.5, 4.5, 6.5]) {
      expect(pythonRound(half)).not.toBe(Math.round(half));
    }
  });

  it("rounds a negative half to even too, and never to -0", () => {
    expect(pythonRound(-0.5)).toBe(0);
    expect(Object.is(pythonRound(-0.5), -0)).toBe(false);
    expect(pythonRound(-1.5)).toBe(-2);
    expect(pythonRound(-2.5)).toBe(-2);
  });

  it("rounds anything that is not a half to the nearest whole number", () => {
    expect(pythonRound(0.4)).toBe(0);
    expect(pythonRound(0.6)).toBe(1);
    expect(pythonRound(-0.4)).toBe(0);
    expect(pythonRound(-0.6)).toBe(-1);
    expect(pythonRound(7)).toBe(7);
  });
});
