import { describe, expect, it } from "vitest";

import { mulberry32, SEEDS } from "../_random";
import type { Cuboid3DGeometry, Point3D } from "../types";
import {
  cuboidFromScanCorners,
  faceCenter,
  headingOfYaw,
  MIN_CUBOID_SIZE,
  resizeCuboidFace,
  wrapYaw,
  yawOfHeading,
} from "./cuboid";
import type { ScanFrame } from "./frame";
import { scanCuboidCorners } from "./labels";
import { subtract } from "./vector";

const FRAMES: readonly ScanFrame[] = ["lidar_flu", "camera_rdf", "lidar_rfu"];

function expectClose(actual: Point3D, expected: Point3D, digits = 9): void {
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], digits));
}

function randomBox(random: () => number): Cuboid3DGeometry {
  return {
    type: "cuboid_3d",
    center: [(random() - 0.5) * 50, (random() - 0.5) * 50, (random() - 0.5) * 5],
    size: [0.5 + random() * 5, 0.5 + random() * 3, 0.5 + random() * 3],
    yaw: (random() * 2 - 1) * Math.PI,
  };
}

describe("the yaw bridge", () => {
  for (const seed of SEEDS) {
    it(`cuboidFromScanCorners inverts scanCuboidCorners in every frame (seed ${seed})`, () => {
      const random = mulberry32(seed);
      for (let trial = 0; trial < 30; trial += 1) {
        const frame = FRAMES[trial % 3];
        const box = randomBox(random);
        const back = cuboidFromScanCorners(scanCuboidCorners(box, frame), frame);
        expectClose(back.center, box.center);
        expectClose(back.size, box.size);
        expect(Math.cos(back.yaw - box.yaw)).toBeCloseTo(1, 9);
        expect(Math.abs(back.yaw)).toBeLessThanOrEqual(Math.PI);
      }
    });
  }

  for (const frame of FRAMES) {
    it(`the heading at yaw points at the front face scanCuboidCorners draws (${frame})`, () => {
      const box: Cuboid3DGeometry = { type: "cuboid_3d", center: [1, 2, 3], size: [4, 2, 1], yaw: 0.7 };
      const corners = scanCuboidCorners(box, frame);
      const front = corners.filter((_, i) => (i & 1) === 1);
      const middle = front.reduce<Point3D>((sum, c) => [sum[0] + c[0] / 4, sum[1] + c[1] / 4, sum[2] + c[2] / 4], [0, 0, 0]);
      const heading = headingOfYaw(box.yaw, frame);
      expectClose(subtract(middle, box.center), [heading[0] * 2, heading[1] * 2, heading[2] * 2]);
      expectClose(faceCenter(box, frame, "front"), middle);
      expect(yawOfHeading(heading, frame)).toBeCloseTo(box.yaw, 12);
    });
  }

  it("wrapYaw keeps a yaw already in [-π, π] exactly, -π included, and wraps the rest", () => {
    expect(wrapYaw(-Math.PI)).toBe(-Math.PI);
    expect(wrapYaw(Math.PI)).toBe(Math.PI);
    expect(wrapYaw(0.25)).toBe(0.25);
    expect(wrapYaw(Math.PI + 0.5)).toBeCloseTo(-Math.PI + 0.5, 12);
    expect(wrapYaw(-Math.PI - 0.5)).toBeCloseTo(Math.PI - 0.5, 12);
    expect(wrapYaw(7 * Math.PI)).toBeCloseTo(Math.PI, 12);
  });
});

describe("resizeCuboidFace", () => {
  const box: Cuboid3DGeometry = { type: "cuboid_3d", center: [0, 0, 1], size: [4, 2, 2], yaw: 0.4 };

  for (const face of ["front", "back", "left", "right", "top", "bottom"] as const) {
    const opposite = { front: "back", back: "front", left: "right", right: "left", top: "bottom", bottom: "top" } as const;
    it(`pushing ${face} out holds ${opposite[face]} still`, () => {
      const grown = resizeCuboidFace(box, "lidar_rfu", face, 1.5);
      expectClose(faceCenter(grown, "lidar_rfu", opposite[face]), faceCenter(box, "lidar_rfu", opposite[face]));
      const moved = subtract(faceCenter(grown, "lidar_rfu", face), faceCenter(box, "lidar_rfu", face));
      expect(Math.hypot(...moved)).toBeCloseTo(1.5, 9);
    });
  }

  it("never shrinks an extent below the minimum", () => {
    const crushed = resizeCuboidFace(box, "lidar_flu", "top", -10);
    expect(crushed.size).toEqual([4, 2, MIN_CUBOID_SIZE]);
    expectClose(faceCenter(crushed, "lidar_flu", "bottom"), faceCenter(box, "lidar_flu", "bottom"));
  });
});
