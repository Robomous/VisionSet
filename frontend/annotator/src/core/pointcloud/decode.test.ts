import { describe, expect, it } from "vitest";

import type { Point3D } from "../types";
import { homeCamera } from "./camera";
import { PointBufferError, boundsOf, decodePoints } from "./decode";

function buffer(
  points: readonly (readonly [number, number, number])[],
  options: {
    intensity?: readonly number[];
    rgb?: readonly number[];
    origin?: readonly [number, number, number];
    magic?: string;
    version?: number;
    flags?: number;
    extra?: number;
  } = {},
): ArrayBuffer {
  const count = points.length;
  const hasIntensity = options.intensity !== undefined;
  const hasRgb = options.rgb !== undefined;
  const hasOrigin = options.origin !== undefined;
  const flags = options.flags ?? (hasIntensity ? 1 : 0) | (hasRgb ? 2 : 0) | (hasOrigin ? 4 : 0);
  const bytes =
    16 +
    (hasOrigin ? 24 : 0) +
    count * 12 +
    (hasIntensity ? count * 4 : 0) +
    (hasRgb ? count * 3 : 0) +
    (options.extra ?? 0);
  const out = new ArrayBuffer(bytes);
  const view = new DataView(out);
  const magic = options.magic ?? "VSPC";
  for (let i = 0; i < 4; i += 1) view.setUint8(i, magic.charCodeAt(i));
  view.setUint32(4, options.version ?? 1, true);
  view.setUint32(8, count, true);
  view.setUint32(12, flags, true);
  let at = 16;
  for (const value of options.origin ?? []) {
    view.setFloat64(at, value, true);
    at += 8;
  }
  for (const point of points) {
    for (const value of point) {
      view.setFloat32(at, value, true);
      at += 4;
    }
  }
  for (const value of options.intensity ?? []) {
    view.setFloat32(at, value, true);
    at += 4;
  }
  for (const value of options.rgb ?? []) {
    view.setUint8(at, value);
    at += 1;
  }
  return out;
}

describe("decodePoints", () => {
  it("reads positions alone", () => {
    const sample = decodePoints(buffer([[1, 2, 3], [-4, 5.5, 6]]));
    expect(sample.count).toBe(2);
    expect([...sample.positions]).toEqual([1, 2, 3, -4, 5.5, 6]);
    expect(sample.intensity).toBeNull();
    expect(sample.rgb).toBeNull();
    expect(sample.origin).toEqual([0, 0, 0]);
  });

  it("reads the origin before the positions, which stay relative to it", () => {
    const origin = [512_364, 4_123_447, 0] as const;
    const sample = decodePoints(buffer([[-18.25, 9.5, 12.5], [0.125, -0.5, 13]], { origin, intensity: [1, 2] }));
    expect(sample.origin).toEqual(origin);
    expect([...sample.positions]).toEqual([-18.25, 9.5, 12.5, 0.125, -0.5, 13]);
    expect([...(sample.intensity ?? [])]).toEqual([1, 2]);
    expect(sample.origin[1] + sample.positions[1]).toBe(4_123_456.5);
  });

  it("reads intensity and rgb in that order", () => {
    const sample = decodePoints(
      buffer([[0, 0, 0], [1, 1, 1]], { intensity: [0.25, 0.75], rgb: [255, 0, 10, 1, 2, 3] }),
    );
    expect([...(sample.intensity ?? [])]).toEqual([0.25, 0.75]);
    expect([...(sample.rgb ?? [])]).toEqual([255, 0, 10, 1, 2, 3]);
  });

  it("reads rgb without intensity", () => {
    const sample = decodePoints(buffer([[0, 0, 0]], { rgb: [9, 8, 7] }));
    expect(sample.intensity).toBeNull();
    expect([...(sample.rgb ?? [])]).toEqual([9, 8, 7]);
  });

  it("reads an empty scan", () => {
    expect(decodePoints(buffer([])).count).toBe(0);
  });

  it.each([
    ["a short header", new ArrayBuffer(8), /16-byte header/],
    ["another magic", buffer([[0, 0, 0]], { magic: "PCD1" }), /magic/],
    ["another version", buffer([[0, 0, 0]], { version: 2 }), /version 2/],
    ["an unknown flag", buffer([[0, 0, 0]], { flags: 8 }), /flags 8/],
    ["an origin flag with no origin behind it", buffer([[0, 0, 0]], { flags: 4 }), /is 52 bytes, got 28/],
    ["a non-finite origin", buffer([[0, 0, 0]], { origin: [Number.NaN, 0, 0] }), /origin/],
    ["trailing bytes", buffer([[0, 0, 0]], { extra: 1 }), /got 29/],
    ["a flag with no section behind it", buffer([[0, 0, 0]], { flags: 1 }), /is 32 bytes, got 28/],
  ])("refuses %s", (_, input, message) => {
    expect(() => decodePoints(input)).toThrow(PointBufferError);
    expect(() => decodePoints(input)).toThrow(message);
  });
});

describe("boundsOf", () => {
  it("is the box around every point", () => {
    expect(boundsOf(new Float32Array([1, -2, 3, -1, 4, 0.5]), [0, 0, 0])).toEqual({
      minimum: [-1, -2, 0.5],
      maximum: [1, 4, 3],
    });
  });

  it("is in the scan's frame, so a georeferenced scan is framed where it is", () => {
    const origin: Point3D = [512_364, 4_123_447, 30];
    const positions = new Float32Array([-20, -10, -1, 20, 10, 3]);
    const bounds = boundsOf(positions, origin);
    expect(bounds).toEqual({
      minimum: [origin[0] - 20, origin[1] - 10, origin[2] - 1],
      maximum: [origin[0] + 20, origin[1] + 10, origin[2] + 3],
    });
    const camera = homeCamera(bounds ?? { minimum: [0, 0, 0], maximum: [0, 0, 0] });
    expect(camera.target).toEqual([origin[0], origin[1], origin[2] + 1]);
    expect(Math.hypot(...camera.target)).toBeGreaterThan(1e6);
  });

  it("is null for no points", () => {
    expect(boundsOf(new Float32Array(), [0, 0, 0])).toBeNull();
  });
});
