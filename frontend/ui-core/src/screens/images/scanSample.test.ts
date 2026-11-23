/**
 * The scan preview's arithmetic: which densities a scan offers, and what each
 * costs on the wire. The levels are the control's whole vocabulary, so a level
 * that would change nothing — past the scan's own count — must not exist.
 */

import { describe, expect, it } from "vitest";

import { bytesPerPoint, densityLevels, formatBytes, shareOf } from "./scanSample";

describe("densityLevels", () => {
  it("offers 1/16, 1/8, 1/4, 1/2 and all of a scan, at two significant figures", () => {
    expect(densityLevels(27_400)).toEqual([1_700, 3_400, 6_900, 14_000, 27_400]);
  });

  it("never offers a level past the scan's own count, nor one under the route's 1,000", () => {
    expect(densityLevels(3_000)).toEqual([1_000, 1_500, 3_000]);
    expect(densityLevels(800)).toEqual([1_000]);
  });

  it("stops at the route's ceiling for a scan larger than it", () => {
    const levels = densityLevels(5_000_000);
    expect(levels.at(-1)).toBe(2_000_000);
    expect(levels).toEqual([130_000, 250_000, 500_000, 1_000_000, 2_000_000]);
  });
});

describe("what a density costs", () => {
  it("counts xyz always, then intensity and colour only when the scan records them", () => {
    expect(bytesPerPoint(["x", "y", "z"])).toBe(12);
    expect(bytesPerPoint(["x", "y", "z", "intensity"])).toBe(16);
    expect(bytesPerPoint(["x", "y", "z", "intensity", "r", "g", "b"])).toBe(19);
  });

  it("says it in KB under a megabyte and MB above", () => {
    expect(formatBytes(27_400 * 16)).toBe("438 KB");
    expect(formatBytes(2_000_000 * 16)).toBe("32 MB");
    expect(formatBytes(500_000 * 16)).toBe("8.0 MB");
  });

  it("names a density by the share of the scan it keeps", () => {
    expect(shareOf(3_400, 27_400)).toBe("1 in 8");
    expect(shareOf(27_400, 27_400)).toBe("all");
  });
});
