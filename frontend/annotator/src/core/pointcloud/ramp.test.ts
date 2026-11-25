import { describe, expect, it } from "vitest";

import type { PointSample } from "./decode";
import {
  HEIGHT_RAMP,
  INTENSITY_RAMP,
  RAMPS,
  colorModeAvailable,
  defaultColorMode,
  pointColors,
  rampAt,
  rampRange,
  robustRange,
} from "./ramp";

function sample(positions: number[], extra: Partial<PointSample> = {}): PointSample {
  return {
    count: positions.length / 3,
    positions: new Float32Array(positions),
    origin: [0, 0, 0],
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
    expect(rampAt(INTENSITY_RAMP, 0.5)).toEqual([100, 100, 112]);
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

  it("colours lidar_rfu by z, low to high", () => {
    const colors = pointColors(sample(column.flatMap((z) => [0, 0, z])), "height", "lidar_rfu");
    expect(colorAt(colors, 0)).toEqual([...HEIGHT_RAMP[0]]);
    expect(colorAt(colors, 100)).toEqual([...HEIGHT_RAMP[4]]);
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

describe("pointColors theme", () => {
  const column = Array.from({ length: 101 }, (_, i) => i);
  const height = sample(column.flatMap((z) => [0, 0, z]));
  const lit = sample([0, 0, 0, 1, 0, 0], { intensity: new Float32Array([0, 1]) });

  it("is light unless told otherwise", () => {
    expect([...pointColors(height, "height", "lidar_flu")]).toEqual([...pointColors(height, "height", "lidar_flu", "light")]);
    expect([...pointColors(lit, "intensity", "lidar_flu")]).toEqual([...pointColors(lit, "intensity", "lidar_flu", "light")]);
  });

  it("draws height on each theme's own ramp ends", () => {
    for (const theme of ["light", "dark"] as const) {
      const colors = pointColors(height, "height", "lidar_flu", theme);
      expect(colorAt(colors, 0)).toEqual([...RAMPS[theme].height[0]]);
      expect(colorAt(colors, 100)).toEqual([...RAMPS[theme].height.at(-1)!]);
    }
  });

  it("draws intensity on each theme's own ramp ends", () => {
    for (const theme of ["light", "dark"] as const) {
      const colors = pointColors(lit, "intensity", "lidar_flu", theme);
      expect(colorAt(colors, 0)).toEqual([...RAMPS[theme].intensity[0]]);
      expect(colorAt(colors, 1)).toEqual([...RAMPS[theme].intensity[1]]);
    }
  });

  it("keeps the two themes apart, one sample's range cache notwithstanding", () => {
    const light = pointColors(height, "height", "lidar_flu", "light");
    const dark = pointColors(height, "height", "lidar_flu", "dark");
    expect([...light]).not.toEqual([...dark]);
    expect([...pointColors(height, "height", "lidar_flu", "light")]).toEqual([...light]);
  });

  it("leaves recorded colour alone on both themes", () => {
    const scan = sample([0, 0, 0, 1, 1, 1], { rgb: new Uint8Array([1, 2, 3, 4, 5, 6]) });
    expect([...pointColors(scan, "rgb", "lidar_flu", "dark")]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("rampRange", () => {
  const positions: number[] = [];
  for (let i = 0; i < 6_000; i += 1) positions.push(i % 7, -((i * 0.37) % 11), (i % 13) * 0.25);
  const origin = [512_364.5, 4_123_447.25, 30.125] as const;

  it("is the span pointColors stretched, heights read in the scan's frame", () => {
    const one = sample(positions, { origin: [...origin] });
    pointColors(one, "height", "camera_rdf");
    const [low, high] = robustRange(one.count, (i) => -(one.positions[i * 3 + 1]! + origin[1]));
    expect(rampRange(one, "height", "camera_rdf")).toEqual([low, high]);
    const [zLow, zHigh] = robustRange(one.count, (i) => one.positions[i * 3 + 2]! + origin[2]);
    expect(rampRange(one, "height", "lidar_flu")).toEqual([zLow, zHigh]);
  });

  it("is the intensity percentiles, and nothing for recorded colour, a missing channel or no points", () => {
    const intensity = new Float32Array(positions.length / 3).map((_, i) => (i * 13) % 100);
    const lit = sample(positions, { intensity });
    expect(rampRange(lit, "intensity", "lidar_flu")).toEqual(robustRange(lit.count, (i) => intensity[i]!));
    expect(rampRange(lit, "rgb", "lidar_flu")).toBeNull();
    expect(rampRange(sample(positions), "intensity", "lidar_flu")).toBeNull();
    expect(rampRange(sample([]), "height", "lidar_flu")).toBeNull();
  });
});
