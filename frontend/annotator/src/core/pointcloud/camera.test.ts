import { describe, expect, it } from "vitest";

import type { Point3D } from "../types";
import {
  MAX_PITCH,
  eyeOf,
  framingBounds,
  homeCamera,
  orbit,
  pan,
  projectToNdc,
  sceneRadius,
  viewProjection,
  zoom,
  type OrbitCamera,
} from "./camera";
import { SCAN_FRAME_AXES, fromForwardLeftUp, isScanFrame, type ScanFrame } from "./frame";

const FRAMES: readonly ScanFrame[] = ["lidar_flu", "camera_rdf", "lidar_rfu"];
const BOUNDS = { minimum: [-10, -10, -10] as Point3D, maximum: [10, 10, 10] as Point3D };

function expectClose(actual: Point3D, expected: Point3D): void {
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6));
}

function ndc(camera: OrbitCamera, frame: ScanFrame, point: Point3D): Point3D {
  const projected = projectToNdc(viewProjection(camera, frame, 1, sceneRadius(BOUNDS)), point);
  if (projected === null) throw new Error("behind the eye");
  return projected;
}

describe("the frame's axes", () => {
  it("names up as +z for lidar_flu and -y for camera_rdf", () => {
    expect(fromForwardLeftUp("lidar_flu", [0, 0, 1])).toEqual([0, 0, 1]);
    expect(fromForwardLeftUp("camera_rdf", [0, 0, 1])).toEqual([0, -1, 0]);
    expect(fromForwardLeftUp("camera_rdf", [1, 0, 0])).toEqual([0, 0, 1]);
    expect(fromForwardLeftUp("camera_rdf", [0, 1, 0])).toEqual([-1, 0, 0]);
  });

  it("names lidar_rfu as x right, y forward, z up", () => {
    expect(fromForwardLeftUp("lidar_rfu", [0, 0, 1])).toEqual([0, 0, 1]);
    expect(fromForwardLeftUp("lidar_rfu", [1, 0, 0])).toEqual([0, 1, 0]);
    expect(fromForwardLeftUp("lidar_rfu", [0, 1, 0])).toEqual([-1, 0, 0]);
  });

  it("covers every declared frame, and only those", () => {
    expect(Object.keys(SCAN_FRAME_AXES).sort()).toEqual([...FRAMES].sort());
    FRAMES.forEach((frame) => expect(isScanFrame(frame)).toBe(true));
    ["LIDAR_RFU", "radar", "toString", "constructor", null, 3].forEach((value) =>
      expect(isScanFrame(value)).toBe(false),
    );
  });

  it("is right-handed in every frame: forward × left = up", () => {
    FRAMES.forEach((frame) => {
      const [f, l, u] = [
        fromForwardLeftUp(frame, [1, 0, 0]),
        fromForwardLeftUp(frame, [0, 1, 0]),
        fromForwardLeftUp(frame, [0, 0, 1]),
      ];
      const cross = [f[1] * l[2] - f[2] * l[1], f[2] * l[0] - f[0] * l[2], f[0] * l[1] - f[1] * l[0]];
      expect(cross.map((value) => value + 0)).toEqual(u.map((value) => value + 0));
    });
  });
});

describe("homeCamera", () => {
  it("aims at the bounds' centre from behind and above", () => {
    const camera = homeCamera({ minimum: [0, -2, -1], maximum: [10, 2, 1] });
    expect(camera.target).toEqual([5, 0, 0]);
    expect(camera.yaw).toBeCloseTo(Math.PI);
    expect(camera.pitch).toBeGreaterThan(0);
    const eye = eyeOf(camera, "lidar_flu");
    expect(eye[0]).toBeLessThan(5);
    expect(eye[2]).toBeGreaterThan(0);
  });

  it("gives a single spot a unit radius", () => {
    expect(sceneRadius({ minimum: [1, 1, 1], maximum: [1, 1, 1] })).toBe(1);
  });
});

describe("framingBounds", () => {
  it("frames the body of the scan, not its stray returns", () => {
    const positions: number[] = [];
    for (let i = 0; i <= 100; i += 1) positions.push(i / 10, -i / 10, i / 100);
    positions.push(1e4, -1e4, 1e3);
    const bounds = framingBounds(new Float32Array(positions));
    expect(bounds?.maximum[0]).toBeLessThanOrEqual(10);
    expect(bounds?.minimum[1]).toBeGreaterThanOrEqual(-10);
    expect(bounds?.maximum[2]).toBeLessThanOrEqual(1);
  });

  it("is null for no points", () => {
    expect(framingBounds(new Float32Array())).toBeNull();
  });
});

describe.each(FRAMES)("the view in %s", (frame) => {
  const up = fromForwardLeftUp(frame, [0, 0, 5]);
  const left = fromForwardLeftUp(frame, [0, 5, 0]);
  const camera = homeCamera(BOUNDS);

  it("puts the target at the centre of the screen", () => {
    const [x, y] = ndc(camera, frame, [0, 0, 0]);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it("draws the frame's up axis up the screen", () => {
    const [x, y] = ndc(camera, frame, up);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeGreaterThan(0);
  });

  it("is not mirrored: looking forward, left is on the left", () => {
    const [x] = ndc(camera, frame, left);
    expect(x).toBeLessThan(0);
  });

  it("keeps the eye at its distance from the target", () => {
    const eye = eyeOf(camera, frame);
    expect(Math.hypot(...eye)).toBeCloseTo(camera.distance, 6);
  });

  it("orbits about up: a quarter turn puts the eye on the left axis", () => {
    const side = orbit({ ...camera, pitch: 0, yaw: 0 }, Math.PI / 2, 0);
    expectClose(eyeOf(side, frame), fromForwardLeftUp(frame, [0, camera.distance, 0]));
  });

  it("pans so the scene follows the drag", () => {
    const moved = pan(camera, frame, 100, 0, 500);
    const [x] = ndc(moved, frame, [0, 0, 0]);
    expect(x).toBeGreaterThan(0);
    const lifted = pan(camera, frame, 0, -100, 500);
    const [, y] = ndc(lifted, frame, [0, 0, 0]);
    expect(y).toBeGreaterThan(0);
  });
});

describe("orbit", () => {
  const camera = homeCamera(BOUNDS);

  it("holds the pitch short of the poles", () => {
    expect(orbit(camera, 0, 10).pitch).toBe(MAX_PITCH);
    expect(orbit(camera, 0, -10).pitch).toBe(-MAX_PITCH);
  });

  it("wraps the yaw into (-pi, pi]", () => {
    const turned = orbit({ ...camera, yaw: Math.PI }, Math.PI / 2, 0);
    expect(turned.yaw).toBeCloseTo(-Math.PI / 2);
    expect(orbit({ ...camera, yaw: 0 }, -Math.PI, 0).yaw).toBeCloseTo(Math.PI);
  });
});

describe("zoom", () => {
  const camera = { ...homeCamera(BOUNDS), distance: 10 };

  it("scales the distance", () => {
    expect(zoom(camera, 0.5, 10).distance).toBe(5);
  });

  it("is held between 1% and 20x the radius", () => {
    expect(zoom(camera, 1e-6, 10).distance).toBeCloseTo(0.1);
    expect(zoom(camera, 1e6, 10).distance).toBe(200);
  });
});

describe("pan", () => {
  it("does nothing on a view with no height", () => {
    const camera = homeCamera(BOUNDS);
    expect(pan(camera, "lidar_flu", 10, 10, 0)).toBe(camera);
  });
});
