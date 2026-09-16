import { describe, expect, it } from "vitest";

import { maskOf } from "./runs";
import type { Run } from "./runs";
import { shapesFromMask } from "./shapes";

/** 25 px on the left, 16 px on the right, far apart. */
const islands = () => {
  const lit: Run[] = [];
  for (let y = 2; y < 7; y += 1) lit.push([y, 1, 5]);
  for (let y = 3; y < 7; y += 1) lit.push([y, 14, 17]);
  return maskOf(24, 12, lit);
};

const square = (size: number, at: number) =>
  maskOf(size + at * 2, size + at * 2, Array.from({ length: size }, (_, y): Run => [y + at, at, at + size - 1]));

describe("shapesFromMask", () => {
  it("prefers a polygon wherever the class admits one", () => {
    const shaped = shapesFromMask(square(12, 4), { allowed: ["bbox", "polygon"] });
    expect(shaped[0]!.geometry.type).toBe("polygon");
  });

  it("does not let the caller's ordering decide the kind", () => {
    const one = shapesFromMask(square(12, 4), { allowed: ["bbox", "polygon"] });
    const other = shapesFromMask(square(12, 4), { allowed: ["polygon", "bbox"] });
    expect(one).toEqual(other);
  });

  it("gives a box where that is all the class holds", () => {
    const shaped = shapesFromMask(square(12, 4), { allowed: ["bbox"] });
    expect(shaped[0]!.geometry).toEqual({ type: "bbox", x: 4, y: 4, width: 12, height: 12 });
  });

  it("offers nothing to a class admitting neither kind", () => {
    expect(shapesFromMask(square(12, 4), { allowed: ["polyline", "keypoints"] })).toEqual([]);
  });

  it("carries the contour a polygon was reduced from, and nothing for a box", () => {
    const polygon = shapesFromMask(square(12, 4), { allowed: ["polygon"] });
    expect(polygon[0]!.contour.length).toBeGreaterThan(0);
    const box = shapesFromMask(square(12, 4), { allowed: ["bbox"] });
    expect(box[0]!.contour).toEqual([]);
  });

  it("unions every surviving piece for a box and traces only one for a polygon", () => {
    const box = shapesFromMask(islands(), { allowed: ["bbox"], at: [[3, 4]] });
    expect(box[0]!.geometry).toEqual({ type: "bbox", x: 1, y: 2, width: 17, height: 5 });
    const polygon = shapesFromMask(islands(), { allowed: ["polygon"], at: [[3, 4]] });
    const xs = (polygon[0]!.geometry as { points: readonly (readonly number[])[] }).points.map((p) => p[0]!);
    expect(Math.max(...xs)).toBeLessThan(14);
  });

  it("does not move a box when the tolerance moves", () => {
    const shapes = [0.25, 0.5, 1, 2, 4, 8, 16].map((tolerance) =>
      shapesFromMask(islands(), { allowed: ["bbox"], tolerance, at: [[3, 4]] }),
    );
    for (const shaped of shapes) expect(shaped).toEqual(shapes[0]);
  });

  it("proposes nothing for a mask with nothing in it", () => {
    expect(shapesFromMask(maskOf(8, 8, []), { allowed: ["polygon"] })).toEqual([]);
    expect(shapesFromMask(maskOf(8, 8, []), { allowed: ["bbox"] })).toEqual([]);
  });

  it("refuses a piece too thin to have three distinct corners at a coarse tolerance", () => {
    // 16 wide and one tall. The length matters: a 36-wide strip still keeps a
    // vertex at this tolerance, because its cut-open ring deviates further from
    // the closing chord than 16 px. Verified against the real Python.
    const thin = maskOf(20, 8, [[3, 2, 17]]);
    expect(shapesFromMask(thin, { allowed: ["polygon"], tolerance: 16 })).toEqual([]);
  });

  it("rejects a mask whose byte count does not match width times height", () => {
    const malformed = { width: 4, height: 4, mask: new Uint8Array(8) };
    expect(() => shapesFromMask(malformed, { allowed: ["bbox", "polygon"] })).toThrow(Error);
  });

  it("still answers normally for a well-formed mask", () => {
    const shaped = shapesFromMask(square(12, 4), { allowed: ["bbox", "polygon"] });
    expect(shaped[0]!.geometry.type).toBe("polygon");
  });
});
