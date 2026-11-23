import { describe, expect, it } from "vitest";

import { mulberry32, SEEDS } from "../_random";
import type { Cuboid3DGeometry, Point3D } from "../types";
import { projectToNdc, topDownCamera, viewProjection, type OrbitCamera } from "./camera";
import { fromForwardLeftUp, heightOf, type ScanFrame } from "./frame";
import {
  closestOnAxis,
  metresPerPixel,
  ndcRay,
  ndcToScreen,
  pointOnRay,
  rayCuboidHit,
  rayGroundHit,
  screenOf,
  screenRay,
  screenToNdc,
  type Ray,
} from "./ray";
import { add, cross, dot, subtract } from "./vector";

const FRAMES: readonly ScanFrame[] = ["lidar_flu", "camera_rdf", "lidar_rfu"];
const VIEWPORT = { width: 800, height: 600 };

function distanceToRay(ray: Ray, point: Point3D): number {
  const offset = subtract(point, ray.origin);
  const [x, y, z] = cross(offset, ray.direction);
  return Math.hypot(x, y, z);
}

function randomCamera(random: () => number): OrbitCamera {
  return {
    yaw: (random() * 2 - 1) * Math.PI,
    pitch: random() * 1.5,
    distance: 5 + random() * 40,
    target: [(random() - 0.5) * 20, (random() - 0.5) * 20, (random() - 0.5) * 4],
  };
}

describe("unprojection", () => {
  for (const seed of SEEDS) {
    it(`every point viewProjection sends to an NDC lies on that NDC's ray (seed ${seed})`, () => {
      const random = mulberry32(seed);
      let checked = 0;
      for (let trial = 0; trial < 40; trial += 1) {
        const frame = FRAMES[trial % 3];
        const camera = randomCamera(random);
        const aspect = 0.5 + random() * 2;
        const point: Point3D = [
          camera.target[0] + (random() - 0.5) * 10,
          camera.target[1] + (random() - 0.5) * 10,
          camera.target[2] + (random() - 0.5) * 10,
        ];
        const ndc = projectToNdc(viewProjection(camera, frame, aspect, 30), point);
        if (ndc === null) continue;
        const ray = ndcRay(camera, frame, aspect, [ndc[0], ndc[1]]);
        const range = Math.hypot(...subtract(point, ray.origin));
        expect(distanceToRay(ray, point) / range).toBeLessThan(1e-5);
        expect(dot(subtract(point, ray.origin), ray.direction)).toBeGreaterThan(0);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(20);
    });
  }

  it("screenOf is projectToNdc read in pixels, and screenRay passes back through it", () => {
    const random = mulberry32(7);
    for (const frame of FRAMES) {
      const camera = randomCamera(random);
      const point: Point3D = [camera.target[0] + 1, camera.target[1] - 2, camera.target[2] + 0.5];
      const pixel = screenOf(camera, frame, VIEWPORT, point);
      const ndc = projectToNdc(viewProjection(camera, frame, VIEWPORT.width / VIEWPORT.height, 30), point);
      expect(pixel).not.toBeNull();
      expect(ndc).not.toBeNull();
      if (pixel === null || ndc === null) return;
      const [x, y] = ndcToScreen([ndc[0], ndc[1]], VIEWPORT);
      expect(pixel[0]).toBeCloseTo(x, 2);
      expect(pixel[1]).toBeCloseTo(y, 2);
      expect(distanceToRay(screenRay(camera, frame, VIEWPORT, pixel), point)).toBeLessThan(1e-6);
    }
  });

  it("screen and NDC convert both ways, y pointing down on screen and up in NDC", () => {
    expect(screenToNdc([0, 0], VIEWPORT)).toEqual([-1, 1]);
    expect(screenToNdc([800, 600], VIEWPORT)).toEqual([1, -1]);
    expect(ndcToScreen(screenToNdc([123, 456], VIEWPORT), VIEWPORT)).toEqual([123, 456]);
  });

  it("the screen centre looks at the target", () => {
    const camera: OrbitCamera = { yaw: 1, pitch: 0.6, distance: 12, target: [3, 4, 5] };
    const ray = screenRay(camera, "lidar_flu", VIEWPORT, [400, 300]);
    expect(distanceToRay(ray, camera.target)).toBeLessThan(1e-9);
  });

  it("a point behind the eye has no screen position", () => {
    const camera: OrbitCamera = { yaw: 0, pitch: 0, distance: 10, target: [0, 0, 0] };
    expect(screenOf(camera, "lidar_flu", VIEWPORT, [20, 0, 0])).toBeNull();
  });
});

describe("rayGroundHit", () => {
  for (const frame of FRAMES) {
    it(`meets the level plane along ${frame}'s up axis`, () => {
      const camera: OrbitCamera = { yaw: 0.3, pitch: 0.8, distance: 15, target: [1, 1, 1] };
      const hit = rayGroundHit(screenRay(camera, frame, VIEWPORT, [250, 420]), frame, -1.5);
      expect(hit).not.toBeNull();
      expect(heightOf(frame, hit as Point3D)).toBeCloseTo(-1.5, 9);
    });
  }

  it("misses a plane the ray runs parallel to or away from", () => {
    const level: Ray = { origin: [0, 0, 1], direction: [1, 0, 0] };
    const rising: Ray = { origin: [0, 0, 1], direction: [0, 0, 1] };
    expect(rayGroundHit(level, "lidar_flu", 0)).toBeNull();
    expect(rayGroundHit(rising, "lidar_flu", 0)).toBeNull();
  });
});

describe("closestOnAxis", () => {
  it("reads where a ray passes an axis line", () => {
    const ray: Ray = { origin: [5, -10, 2], direction: [0, 1, 0] };
    expect(closestOnAxis(ray, [0, 0, 0], [0, 0, 1])).toBeCloseTo(2, 12);
    expect(closestOnAxis(ray, [0, 0, 0], [1, 0, 0])).toBeCloseTo(5, 12);
  });

  it("is null for a ray parallel to the axis", () => {
    expect(closestOnAxis({ origin: [1, 1, 1], direction: [0, 0, 1] }, [0, 0, 0], [0, 0, 1])).toBeNull();
  });
});

describe("rayCuboidHit", () => {
  const box: Cuboid3DGeometry = { type: "cuboid_3d", center: [10, 0, 1], size: [4, 2, 2], yaw: 0 };

  it("enters through the face it meets first", () => {
    const hit = rayCuboidHit({ origin: [0, 0, 1], direction: [1, 0, 0] }, box, "lidar_flu");
    expect(hit?.face).toBe("back");
    expect(hit?.distance).toBeCloseTo(8, 12);
    const above = rayCuboidHit({ origin: [10, 0, 10], direction: [0, 0, -1] }, box, "lidar_flu");
    expect(above?.face).toBe("top");
    const side = rayCuboidHit({ origin: [10, 5, 1], direction: [0, -1, 0] }, box, "lidar_flu");
    expect(side?.face).toBe("left");
  });

  it("follows the yaw: a quarter turn puts the front face on +y in lidar_flu", () => {
    const turned = { ...box, yaw: Math.PI / 2 };
    const hit = rayCuboidHit({ origin: [10, 10, 1], direction: [0, -1, 0] }, turned, "lidar_flu");
    expect(hit?.face).toBe("front");
    expect(hit?.distance).toBeCloseTo(8, 9);
  });

  it("misses beside the box and behind the eye", () => {
    expect(rayCuboidHit({ origin: [0, 5, 1], direction: [1, 0, 0] }, box, "lidar_flu")).toBeNull();
    expect(rayCuboidHit({ origin: [20, 0, 1], direction: [1, 0, 0] }, box, "lidar_flu")).toBeNull();
  });

  it("from inside, answers the exit face", () => {
    const hit = rayCuboidHit({ origin: [10, 0, 1], direction: [1, 0, 0] }, box, "lidar_flu");
    expect(hit?.face).toBe("front");
    expect(hit?.point[0]).toBeCloseTo(12, 12);
  });

  it("the point it reports is on the ray", () => {
    const ray: Ray = { origin: [0, 0.3, 1.2], direction: [1, 0, 0] };
    const hit = rayCuboidHit(ray, box, "lidar_flu");
    expect(hit).not.toBeNull();
    expect(pointOnRay(ray, hit?.distance ?? 0)).toEqual(hit?.point);
  });
});

describe("an orthographic camera", () => {
  const ortho = (random: () => number): OrbitCamera => ({ ...randomCamera(random), projection: "orthographic" });

  for (const seed of SEEDS) {
    it(`sends every point to the NDC whose ray passes through it, from in front (seed ${seed})`, () => {
      const random = mulberry32(seed);
      for (let trial = 0; trial < 40; trial += 1) {
        const frame = FRAMES[trial % 3];
        const camera = ortho(random);
        const aspect = 0.5 + random() * 2;
        const point: Point3D = [
          camera.target[0] + (random() - 0.5) * 10,
          camera.target[1] + (random() - 0.5) * 10,
          camera.target[2] + (random() - 0.5) * 10,
        ];
        const ndc = projectToNdc(viewProjection(camera, frame, aspect, 30), point);
        expect(ndc).not.toBeNull();
        if (ndc === null) return;
        const ray = ndcRay(camera, frame, aspect, [ndc[0], ndc[1]]);
        expect(distanceToRay(ray, point)).toBeLessThan(1e-4);
        expect(dot(subtract(point, ray.origin), ray.direction)).toBeGreaterThan(0);
        const viewport = { width: 600 * aspect, height: 600 };
        const pixel = screenOf(camera, frame, viewport, point);
        const [x, y] = ndcToScreen([ndc[0], ndc[1]], viewport);
        expect(pixel?.[0]).toBeCloseTo(x, 2);
        expect(pixel?.[1]).toBeCloseTo(y, 2);
      }
    });
  }

  for (const frame of FRAMES) {
    it(`draws a level edge the same length at every height, as the perspective view does not (${frame})`, () => {
      const top = topDownCamera([0, 0, 0], 12);
      const perspective: OrbitCamera = { ...top, projection: "perspective" };
      const edge = fromForwardLeftUp(frame, [4, 0, 0]);
      const lengthAt = (camera: OrbitCamera, height: number): number => {
        const start = fromForwardLeftUp(frame, [-2, 1, height]);
        const a = screenOf(camera, frame, VIEWPORT, start);
        const b = screenOf(camera, frame, VIEWPORT, add(start, edge));
        if (a === null || b === null) throw new Error("off camera");
        return Math.hypot(b[0] - a[0], b[1] - a[1]);
      };
      expect(lengthAt(top, 2) / lengthAt(top, -1)).toBeCloseTo(1, 9);
      expect(lengthAt(perspective, 2) / lengthAt(perspective, -1)).toBeGreaterThan(1.2);
      expect(metresPerPixel(top, frame, VIEWPORT, [0, 0, 0])).toBe(metresPerPixel(top, frame, VIEWPORT, edge));
    });
  }

  for (const frame of FRAMES) {
    it(`top-down, draws a box's top over its footprint (${frame})`, () => {
      const camera = topDownCamera([0, 0, 0], 10);
      const viewport = { width: 400, height: 800 };
      for (const [f, l] of [[1, 1], [-2, 0.5], [0.3, -1.2]] as const) {
        const bottom = screenOf(camera, frame, viewport, fromForwardLeftUp(frame, [f, l, -1]));
        const top = screenOf(camera, frame, viewport, fromForwardLeftUp(frame, [f, l, 2]));
        if (bottom === null || top === null) throw new Error("off camera");
        expect(Math.hypot(top[0] - bottom[0], top[1] - bottom[1])).toBeLessThan(0.5);
      }
    });
  }

  it("meets the ground under a point drawn above its own eye", () => {
    const camera = topDownCamera([0, 0, 0], 1);
    const above: Point3D = [0.2, 0.1, 5];
    const pixel = screenOf(camera, "lidar_flu", VIEWPORT, above);
    expect(pixel).not.toBeNull();
    const ray = screenRay(camera, "lidar_flu", VIEWPORT, pixel ?? [0, 0]);
    expect(dot(subtract(above, ray.origin), ray.direction)).toBeGreaterThan(0);
    expect(rayGroundHit(ray, "lidar_flu", 0)).not.toBeNull();
  });
});
