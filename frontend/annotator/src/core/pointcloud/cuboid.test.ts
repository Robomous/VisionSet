import { describe, expect, it } from "vitest";

import { mulberry32, SEEDS } from "../_random";
import { cuboidCorners } from "../geometry/projection";
import type { Cuboid3DGeometry, Point3D } from "../types";
import {
  cuboidAxes,
  cuboidCorners3D,
  faceCenter,
  FOOTPRINT_CORNERS,
  headingOfYaw,
  MIN_CUBOID_SIZE,
  resizeCuboidFace,
  standingCuboid,
  upAxis,
  wrapYaw,
  yawOfHeading,
} from "./cuboid";
import { fromForwardLeftUp, heightOf, type ScanFrame } from "./frame";
import { add, dot, subtract } from "./vector";

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

describe("cuboidCorners3D", () => {
  const YAWS = [-Math.PI, -2, -0.7, 0, 0.3, Math.PI / 2, 2.5, Math.PI];

  for (const frame of FRAMES) {
    it(`is the image convention's box read as (forward, left, up) = (x, -z, -y) in ${frame}`, () => {
      const random = mulberry32(SEEDS[0]);
      for (const yaw of YAWS) {
        const box = { ...randomBox(random), yaw };
        const reference = cuboidCorners({ ...box, center: [0, 0, 0] }).map(([x, y, z]) =>
          add(box.center, fromForwardLeftUp(frame, [x, -z, -y])),
        );
        cuboidCorners3D(box, frame).forEach((corner, i) => expectClose(corner, reference[i]!, 12));
      }
    });
  }

  it("lists the bottom face round its edge", () => {
    const box: Cuboid3DGeometry = { type: "cuboid_3d", center: [1, 2, 3], size: [4, 2, 1], yaw: 0.7 };
    const corners = cuboidCorners3D(box, "camera_rdf");
    const footprint = FOOTPRINT_CORNERS.map((index) => corners[index]!);
    footprint.forEach((corner) => expect(heightOf("camera_rdf", corner)).toBeCloseTo(heightOf("camera_rdf", box.center) - 0.5, 12));
    const sides = footprint.map((corner, i) => Math.hypot(...subtract(footprint[(i + 1) % 4]!, corner)));
    sides.forEach((side, i) => expect(side).toBeCloseTo(i % 2 === 0 ? 2 : 4, 12));
  });
});

describe("standingCuboid", () => {
  for (const frame of FRAMES) {
    it(`stands the box on its base in ${frame}`, () => {
      const base: Point3D = [3, -1, 2];
      const box = standingCuboid(base, [4, 2, 1.5], 0.9, frame);
      expect(box.size).toEqual([4, 2, 1.5]);
      expect(box.yaw).toBe(0.9);
      expectClose(faceCenter(box, frame, "bottom"), base);
      expectClose(cuboidAxes(box, frame)[2], upAxis(frame));
      expect(dot(upAxis(frame), upAxis(frame))).toBe(1);
    });
  }
});

describe("the yaw bridge", () => {
  for (const frame of FRAMES) {
    it(`the heading at yaw points at the front face cuboidCorners3D draws (${frame})`, () => {
      const box: Cuboid3DGeometry = { type: "cuboid_3d", center: [1, 2, 3], size: [4, 2, 1], yaw: 0.7 };
      const corners = cuboidCorners3D(box, frame);
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
