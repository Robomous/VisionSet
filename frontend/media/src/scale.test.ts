import { describe, expect, it } from "vitest";

import { scaledDimension } from "./index";

describe("scaledDimension", () => {
  it("matches the pinned kernel fixture (25 x 50% -> 13)", () => {
    expect(scaledDimension(25, 50)).toBe(13);
    expect(scaledDimension(1920, 50)).toBe(960);
    expect(scaledDimension(640, 100)).toBe(640);
  });

  it("floors at one rather than rounding a small percent to zero", () => {
    // A naive Math.round(native * percent / 100) gives 0 here; the spec's
    // floor-at-one rule is what a plain round-and-divide would silently miss.
    expect(scaledDimension(1, 1)).toBe(1);
    expect(Math.round((1 * 1) / 100)).toBe(0);
  });

  it("rounds an exact tie up, unlike Python's half-even round()", () => {
    // native*percent/100 = 2.5 exactly. Python's round(2.5) is 2 (banker's
    // rounding, ties to even) — the wrong answer this integer formula avoids
    // by construction, never calling either language's native round.
    expect(scaledDimension(5, 50)).toBe(3);
  });
});
