import { describe, expect, it } from "vitest";

import type { PointSample } from "./decode";
import {
  HEIGHT_RAMP,
  INTENSITY_RAMP,
  colorModeAvailable,
  defaultColorMode,
  pointColors,
  rampAt,
  robustRange,
} from "./ramp";

function sample(positions: number[], extra: Partial<PointSample> = {}): PointSample {
  return {
    count: positions.length / 3,
    positions: new Float32Array(positions),
    intensity: null,
    rgb: null,
    ...extra,
  };
}

function colorAt(colors: Uint8Array, i: number): number[] {
  return [...colors.slice(i * 3, i * 3 + 3)];
}

describe("rampAt", () => {
  it("is the end stops at 0 and 1, and clamps beyond", () => {
    expect(rampAt(HEIGHT_RAMP, 0)).toEqual(HEIGHT_RAMP[0]);
    expect(rampAt(HEIGHT_RAMP, 1)).toEqual(HEIGHT_RAMP[4]);
    expect(rampAt(HEIGHT_RAMP, -3)).toEqual(HEIGHT_RAMP[0]);
    expect(rampAt(HEIGHT_RAMP, 7)).toEqual(HEIGHT_RAMP[4]);
    expect(rampAt(HEIGHT_RAMP, Number.NaN)).toEqual(HEIGHT_RAMP[0]);
  });

  it("interpolates between stops", () => {
    expect(rampAt(INTENSITY_RAMP, 0.5)).toEqual([164, 164, 172]);
  });
});

describe("robustRange", () => {
  it("ignores a stray value at either end", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i / 999);
    values[0] = -1e6;
    values[999] = 1e6;
    const [low, high] = robustRange(values.length, (i) => values[i]);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
  });

  it("is [0, 0] for nothing", () => {
    expect(robustRange(0, () => 1)).toEqual([0, 0]);
  });
});

describe("pointColors", () => {
  const column = Array.from({ length: 101 }, (_, i) => i);

  it("colours lidar_flu by z, low to high", () => {
    const colors = pointColors(sample(column.flatMap((z) => [0, 0, z])), "height", "lidar_flu");
    expect(colorAt(colors, 0)).toEqual([...HEIGHT_RAMP[0]]);
    expect(colorAt(colors, 100)).toEqual([...HEIGHT_RAMP[4]]);
  });

  it("colours camera_rdf by -y: the lowest y is the highest point", () => {
    const colors = pointColors(sample(column.flatMap((y) => [0, y, 0])), "height", "camera_rdf");
    expect(colorAt(colors, 0)).toEqual([...HEIGHT_RAMP[4]]);
    expect(colorAt(colors, 100)).toEqual([...HEIGHT_RAMP[0]]);
  });

  it("colours by intensity when there is one", () => {
    const scan = sample([0, 0, 0, 0, 0, 0], { intensity: new Float32Array([0, 255]) });
    const colors = pointColors(scan, "intensity", "lidar_flu");
    expect(colorAt(colors, 0)).toEqual([...INTENSITY_RAMP[0]]);
    expect(colorAt(colors, 1)).toEqual([...INTENSITY_RAMP[1]]);
  });

  it("copies the scan's own colours", () => {
    const scan = sample([0, 0, 0, 1, 1, 1], { rgb: new Uint8Array([1, 2, 3, 4, 5, 6]) });
    expect([...pointColors(scan, "rgb", "lidar_flu")]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("falls back to height for a mode the scan cannot answer", () => {
    const scan = sample([0, 0, 0, 0, 0, 1]);
    expect([...pointColors(scan, "intensity", "lidar_flu")]).toEqual([
      ...pointColors(scan, "height", "lidar_flu"),
    ]);
  });

  it("paints a flat scan the ramp's middle", () => {
    const colors = pointColors(sample([0, 0, 2, 1, 1, 2]), "height", "lidar_flu");
    expect(colorAt(colors, 0)).toEqual([...rampAt(HEIGHT_RAMP, 0.5)]);
  });
});

describe("colour modes", () => {
  it("offers intensity and rgb only when the scan carries them", () => {
    const bare = sample([0, 0, 0]);
    expect(colorModeAvailable(bare, "height")).toBe(true);
    expect(colorModeAvailable(bare, "intensity")).toBe(false);
    expect(colorModeAvailable(bare, "rgb")).toBe(false);
    expect(defaultColorMode(bare)).toBe("height");
    const coloured = sample([0, 0, 0], { rgb: new Uint8Array(3), intensity: new Float32Array(1) });
    expect(colorModeAvailable(coloured, "intensity")).toBe(true);
    expect(defaultColorMode(coloured)).toBe("rgb");
  });
});
