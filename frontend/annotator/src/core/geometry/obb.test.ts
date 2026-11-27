import { describe, expect, it } from "vitest";

import type { ObbGeometry, Point } from "../types";
import { geometryContains, nearestHandle } from "./hitTest";
import {
  canonicalObb,
  isValidObb,
  moveObb,
  obbCorners,
  obbExtent,
  obbFromBox,
  obbHandlePositions,
  obbRotateBase,
  obbRotateHandle,
  resizeObb,
  rotateObb,
} from "./obb";

function obb(cx: number, cy: number, width: number, height: number, angle: number): ObbGeometry {
  return { type: "obb", cx, cy, width, height, angle };
}

function expectPoint(actual: Point, expected: Point): void {
  expect(actual[0]).toBeCloseTo(expected[0], 9);
  expect(actual[1]).toBeCloseTo(expected[1], 9);
}

const BOUNDS = { width: 640, height: 480 };

describe("the canonical form", () => {
  it("swaps a box taller than wide and turns it a quarter", () => {
    const canonical = canonicalObb(obb(10, 20, 4, 8, 0));
    expect(canonical.width).toBe(8);
    expect(canonical.height).toBe(4);
    expect(canonical.angle).toBeCloseTo(-Math.PI / 2, 12);
  });

  it("reduces the angle modulo π into [-π/2, π/2)", () => {
    expect(canonicalObb(obb(0, 0, 8, 4, Math.PI / 2)).angle).toBeCloseTo(-Math.PI / 2, 12);
    expect(canonicalObb(obb(0, 0, 8, 4, -Math.PI / 2)).angle).toBe(-Math.PI / 2);
    expect(canonicalObb(obb(0, 0, 8, 4, Math.PI + 0.25)).angle).toBeCloseTo(0.25, 12);
    expect(canonicalObb(obb(0, 0, 8, 4, -3 * Math.PI + 0.25)).angle).toBeCloseTo(0.25, 12);
    expect(canonicalObb(obb(0, 0, 8, 4, 2.0)).angle).toBeCloseTo(2.0 - Math.PI, 12);
  });

  it("reduces a square's angle modulo π/2 into [-π/4, π/4)", () => {
    expect(canonicalObb(obb(0, 0, 5, 5, Math.PI / 3)).angle).toBeCloseTo(Math.PI / 3 - Math.PI / 2, 12);
    expect(canonicalObb(obb(0, 0, 5, 5, Math.PI / 4)).angle).toBeCloseTo(-Math.PI / 4, 12);
  });

  it("never stores a negative zero", () => {
    expect(Object.is(canonicalObb(obb(0, 0, 8, 4, -0)).angle, 0)).toBe(true);
    expect(Object.is(canonicalObb(obb(0, 0, 8, 4, -Math.PI)).angle, 0)).toBe(true);
  });

  it("is a fixed point on a canonical value", () => {
    for (const angle of [-Math.PI / 2, -1, -0.3, 0, 0.3, 1, Math.PI / 2 - 1e-9]) {
      const once = canonicalObb(obb(3, 4, 9, 2, angle));
      expect(canonicalObb(once)).toEqual(once);
      expect(once.angle).toBe(angle);
    }
  });

  it("draws the same rectangle it was given", () => {
    const raw = obb(50, 60, 10, 30, 2.4);
    const canonical = canonicalObb(raw);
    const sorted = (corners: readonly Point[]) =>
      [...corners].map(([x, y]) => [x.toFixed(9), y.toFixed(9)].join()).sort();
    expect(sorted(obbCorners(canonical))).toEqual(sorted(obbCorners(raw)));
  });
});

describe("validity", () => {
  it("refuses nonfinite values and a side that is not positive", () => {
    expect(isValidObb(obb(1, 1, 4, 2, 0))).toBe(true);
    expect(isValidObb(obb(1, 1, 0, 2, 0))).toBe(false);
    expect(isValidObb(obb(1, 1, 4, -2, 0))).toBe(false);
    expect(isValidObb(obb(Number.NaN, 1, 4, 2, 0))).toBe(false);
    expect(isValidObb(obb(1, 1, 4, 2, Number.POSITIVE_INFINITY))).toBe(false);
  });
});

describe("corners", () => {
  it("are a bbox's ring at angle 0", () => {
    expect(obbCorners(obb(50, 40, 20, 10, 0))).toEqual([
      [40, 35],
      [60, 35],
      [60, 45],
      [40, 45],
    ]);
  });

  it("turn clockwise on screen for a positive angle", () => {
    const [first, second, third, fourth] = obbCorners(obb(0, 0, 20, 10, Math.PI / 2));
    // The width axis points down the screen, the height axis to the left.
    expectPoint(first, [5, -10]);
    expectPoint(second, [5, 10]);
    expectPoint(third, [-5, 10]);
    expectPoint(fourth, [-5, -10]);
  });

  it("bound the enclosing box", () => {
    const extent = obbExtent(obb(0, 0, 20, 10, Math.PI / 2));
    expect(extent.x).toBeCloseTo(-5, 12);
    expect(extent.y).toBeCloseTo(-10, 12);
    expect(extent.width).toBeCloseTo(10, 12);
    expect(extent.height).toBeCloseTo(20, 12);
  });
});

describe("hit testing", () => {
  const turned = obb(100, 100, 40, 10, Math.PI / 4);

  it("contains what is inside the turned rectangle and not its enclosing box", () => {
    expect(geometryContains(turned, [110, 110], 0)).toBe(true);
    // Inside the enclosing box, outside the rectangle.
    expect(geometryContains(turned, [110, 90], 0)).toBe(false);
    expect(geometryContains(turned, [110, 90], 20)).toBe(true);
  });

  it("finds a grip where the turned box draws it", () => {
    const grips = obbHandlePositions(turned);
    expect(nearestHandle(turned, grips.se, 1)?.handle).toBe("se");
    expect(nearestHandle(turned, grips.n, 1)?.handle).toBe("n");
  });

  it("puts the rotation grip beyond the n side", () => {
    expectPoint(obbRotateHandle(obb(50, 50, 20, 10, 0), 24), [50, 21]);
  });

  it("keeps the rotation grip above the box whichever equivalent angle is stored", () => {
    // A tall box, stored width-first at -π/2: its `n` side faces left, its `+u` side up.
    expectPoint(obbRotateHandle(obb(50, 50, 20, 10, -Math.PI / 2), 24), [50, 16]);
    expectPoint(obbRotateBase(obb(50, 50, 20, 10, -Math.PI / 2)), [50, 40]);
    // The same rectangle spelled a half turn round: still above it.
    expectPoint(obbRotateHandle(obb(50, 50, 20, 10, Math.PI), 24), [50, 21]);
    for (const angle of [-1.5, -0.9, -0.3, 0.3, 0.9, 1.5]) {
      const box = obb(50, 50, 20, 10, angle);
      const top = Math.min(...obbCorners(box).map(([, y]) => y));
      expect(obbRotateHandle(box, 24)[1], String(angle)).toBeLessThan(top);
    }
  });
});

describe("drawing", () => {
  it("takes a dragged-out box at angle 0, canonical", () => {
    expect(obbFromBox({ type: "bbox", x: 10, y: 20, width: 30, height: 10 })).toEqual(
      obb(25, 25, 30, 10, 0),
    );
    const tall = obbFromBox({ type: "bbox", x: 10, y: 20, width: 10, height: 30 });
    expect(tall).toMatchObject({ cx: 15, cy: 35, width: 30, height: 10 });
    expect(tall.angle).toBeCloseTo(-Math.PI / 2, 12);
  });
});

describe("moving", () => {
  it("translates the centre and keeps the centre on the asset", () => {
    const start = obb(100, 100, 40, 10, 0.3);
    expect(moveObb(start, [120, 90], BOUNDS)).toEqual({ ...start, cx: 120, cy: 90 });
    expect(moveObb(start, [-20, 900], BOUNDS)).toEqual({ ...start, cx: 0, cy: 480 });
  });
});

describe("resizing in the box's own frame", () => {
  it("holds the opposite side still at angle 0, like a bbox", () => {
    expect(resizeObb(obb(100, 100, 40, 20, 0), "e", [140, 300], BOUNDS)).toEqual(
      obb(110, 100, 60, 20, 0),
    );
    expect(resizeObb(obb(100, 100, 40, 20, 0), "nw", [70, 80], BOUNDS)).toEqual(
      obb(95, 95, 50, 30, 0),
    );
  });

  it("drags a grip along the turned axis and holds the opposite corner", () => {
    const start = obb(100, 100, 40, 20, Math.PI / 2);
    const anchor = obbCorners(start)[0];
    const resized = resizeObb(start, "se", [80, 140], BOUNDS);
    expect(resized.angle).toBe(Math.PI / 2);
    expect(resized.width).toBeCloseTo(60, 9);
    expect(resized.height).toBeCloseTo(30, 9);
    expectPoint(obbCorners(resized)[0], anchor);
  });

  it("flips rather than inverts across the opposite side, and keeps the minimum", () => {
    const flipped = resizeObb(obb(100, 100, 40, 20, 0), "e", [60, 100], BOUNDS);
    expect(flipped).toEqual(obb(70, 100, 20, 20, 0));
    const pinched = resizeObb(obb(100, 100, 40, 20, 0), "e", [80, 100], BOUNDS);
    expect(pinched.width).toBe(3);
  });

  it("follows a grip that already sits outside the asset rather than snapping it to the edge", () => {
    // The `w` grip is at x = -15, left of the image; one pixel further left is one pixel wider.
    expect(resizeObb(obb(5, 100, 40, 20, 0), "w", [-16, 100], BOUNDS)).toEqual(obb(4.5, 100, 41, 20, 0));
  });

  it("keeps the resized box's centre on the asset", () => {
    expect(resizeObb(obb(10, 100, 40, 20, 0), "e", [-60, 100], BOUNDS).cx).toBe(0);
  });
});

describe("rotating", () => {
  it("turns by the angle the pointer swept about the centre, size untouched", () => {
    const start = obb(100, 100, 40, 20, 0.1);
    const turned = rotateObb(start, [100, 50], [150, 100]);
    expect(turned.angle).toBeCloseTo(0.1 + Math.PI / 2, 12);
    expect(turned).toMatchObject({ cx: 100, cy: 100, width: 40, height: 20 });
  });
});
