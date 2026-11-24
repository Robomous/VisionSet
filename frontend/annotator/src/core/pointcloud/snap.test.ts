import { describe, expect, it } from "vitest";

import { mulberry32, SEEDS } from "../_random";
import type { Point, Point3D } from "../types";
import { eyeOf, topDownCamera, viewBasis, type OrbitCamera } from "./camera";
import type { PointSample } from "./decode";
import { heightOf, type ScanFrame } from "./frame";
import { screenOf } from "./ray";
import { SNAP_NEAR_EQUAL_PX, SNAP_TOLERANCE_PX, snapHeight } from "./snap";
import { add, dot, scale, subtract } from "./vector";

const VIEWPORT = { width: 800, height: 600 };
const CAMERA: OrbitCamera = { yaw: Math.PI, pitch: 0.6, distance: 30, target: [0, 0, 0] };
const TOP_DOWN = topDownCamera([0, 0, 0], 30);

function sampleOf(points: readonly Point3D[], origin: Point3D = [0, 0, 0]): PointSample {
  const positions = new Float32Array(points.length * 3);
  points.forEach((point, i) => positions.set(subtract(point, origin), i * 3));
  return { count: points.length, positions, origin, intensity: null, rgb: null };
}

function pixel(camera: OrbitCamera, frame: ScanFrame, point: Point3D): Point {
  const at = screenOf(camera, frame, VIEWPORT, point);
  if (at === null) throw new Error("behind the camera");
  return at;
}

/** Every point projected, the same rule applied: the reference the grid must agree with. */
function bruteForce(
  sample: PointSample,
  frame: ScanFrame,
  camera: OrbitCamera,
  pointer: Point,
  tolerance = SNAP_TOLERANCE_PX,
): number | null {
  const eye = eyeOf(camera, frame);
  const { forward } = viewBasis(camera, frame);
  const found: { distance: number; depth: number; height: number }[] = [];
  for (let i = 0; i < sample.count; i += 1) {
    const point = add(sample.origin, [sample.positions[i * 3], sample.positions[i * 3 + 1], sample.positions[i * 3 + 2]]);
    const at = screenOf(camera, frame, VIEWPORT, point);
    if (at === null) continue;
    const distance = Math.hypot(at[0] - pointer[0], at[1] - pointer[1]);
    if (distance <= tolerance) found.push({ distance, depth: dot(subtract(point, eye), forward), height: heightOf(frame, point) });
  }
  if (found.length === 0) return null;
  const nearest = Math.min(...found.map((one) => one.distance));
  const near = found.filter((one) => one.distance <= nearest + SNAP_NEAR_EQUAL_PX);
  return near.reduce((best, one) => (one.depth < best.depth ? one : best)).height;
}

describe("snapHeight", () => {
  it("takes the height of the point under the pointer", () => {
    const sample = sampleOf([
      [0, 0, 1.5],
      [6, 4, 0.2],
      [-6, -4, 3],
    ]);
    expect(snapHeight(sample, "lidar_flu", CAMERA, VIEWPORT, pixel(CAMERA, "lidar_flu", [6, 4, 0.2]))).toBeCloseTo(0.2, 5);
    const [x, y] = pixel(CAMERA, "lidar_flu", [0, 0, 1.5]);
    expect(snapHeight(sample, "lidar_flu", CAMERA, VIEWPORT, [x + 4, y - 3])).toBeCloseTo(1.5, 5);
  });

  it("picks the nearest on screen when the others are clearly farther", () => {
    const at = pixel(CAMERA, "lidar_flu", [0, 0, 0]);
    const sample = sampleOf([
      [0, 0, 0],
      [0.25, 0, 0.6],
    ]);
    const other = pixel(CAMERA, "lidar_flu", [0.25, 0, 0.6]);
    expect(Math.hypot(other[0] - at[0], other[1] - at[1])).toBeGreaterThan(SNAP_NEAR_EQUAL_PX);
    expect(snapHeight(sample, "lidar_flu", CAMERA, VIEWPORT, at)).toBeCloseTo(0, 5);
  });

  it("prefers the point nearest the eye among candidates about as near on screen", () => {
    const eye = eyeOf(CAMERA, "lidar_flu");
    const through = (distance: number): Point3D => add(eye, scale(subtract([0, 0, 0], eye), distance));
    const front = through(0.6);
    const behind = through(1.3);
    const sample = sampleOf([behind, front]);
    const height = snapHeight(sample, "lidar_flu", CAMERA, VIEWPORT, pixel(CAMERA, "lidar_flu", [0, 0, 0]));
    expect(height).toBeCloseTo(heightOf("lidar_flu", front), 4);
  });

  it("returns null when no point is within the tolerance, so the caller keeps the ground plane", () => {
    const sample = sampleOf([[0, 0, 1]]);
    const at = pixel(CAMERA, "lidar_flu", [0, 0, 1]);
    expect(snapHeight(sample, "lidar_flu", CAMERA, VIEWPORT, [at[0] + 12, at[1]])).toBeNull();
    expect(snapHeight(sampleOf([]), "lidar_flu", CAMERA, VIEWPORT, at)).toBeNull();
  });

  it("holds the tolerance's edge", () => {
    const sample = sampleOf([[0, 0, 1]]);
    const at = pixel(CAMERA, "lidar_flu", [0, 0, 1]);
    expect(snapHeight(sample, "lidar_flu", CAMERA, VIEWPORT, [at[0] + 9.99, at[1]])).toBeCloseTo(1, 5);
    expect(snapHeight(sample, "lidar_flu", CAMERA, VIEWPORT, [at[0] + 10.01, at[1]])).toBeNull();
    expect(snapHeight(sample, "lidar_flu", CAMERA, VIEWPORT, [at[0] + 4, at[1]], 3)).toBeNull();
  });

  it("takes the topmost point of a column in the top-down view", () => {
    const sample = sampleOf([
      [2, 1, 0],
      [2, 1, 2.5],
      [2, 1, 1],
      [-3, 0, 4],
    ]);
    expect(snapHeight(sample, "lidar_flu", TOP_DOWN, VIEWPORT, pixel(TOP_DOWN, "lidar_flu", [2, 1, 0]))).toBeCloseTo(2.5, 5);
  });

  it("reads a sample far from its frame's zero through its origin", () => {
    const origin: Point3D = [512_000.25, 4_100_000.5, 120];
    const target: Point3D = [origin[0] + 1, origin[1] - 2, origin[2]];
    const camera: OrbitCamera = { ...CAMERA, target };
    const surface: Point3D = [origin[0] + 3, origin[1] + 1, origin[2] + 0.75];
    const sample = sampleOf([surface, [origin[0] - 5, origin[1], origin[2]]], origin);
    expect(snapHeight(sample, "lidar_flu", camera, VIEWPORT, pixel(camera, "lidar_flu", surface))).toBeCloseTo(120.75, 3);
    const top = topDownCamera(target, 30);
    expect(snapHeight(sample, "lidar_flu", top, VIEWPORT, pixel(top, "lidar_flu", surface))).toBeCloseTo(120.75, 3);
  });

  it("reads height along a frame whose up is negative y", () => {
    const surface: Point3D = [1, -1.25, 4];
    const sample = sampleOf([surface, [0, 0, 0]]);
    const height = snapHeight(sample, "camera_rdf", CAMERA, VIEWPORT, pixel(CAMERA, "camera_rdf", surface));
    expect(height).toBeCloseTo(1.25, 5);
  });

  for (const seed of SEEDS) {
    it(`agrees with projecting every point (seed ${seed})`, () => {
      const random = mulberry32(seed);
      const frames: readonly ScanFrame[] = ["lidar_flu", "camera_rdf", "lidar_rfu"];
      for (let trial = 0; trial < 12; trial += 1) {
        const frame = frames[trial % 3];
        const points: Point3D[] = [];
        for (let i = 0; i < 400; i += 1) {
          points.push([(random() - 0.5) * 40, (random() - 0.5) * 40, (random() - 0.5) * 40]);
        }
        const origin: Point3D = trial % 2 === 0 ? [0, 0, 0] : [1000 * random(), 1000 * random(), 10 * random()];
        const sample = sampleOf(points.map((point) => add(point, origin)), origin);
        const camera: OrbitCamera =
          trial % 4 === 3
            ? topDownCamera(origin, 20 + random() * 40)
            : {
                yaw: (random() * 2 - 1) * Math.PI,
                pitch: random() * 1.4,
                distance: 20 + random() * 50,
                target: add(origin, [(random() - 0.5) * 10, (random() - 0.5) * 10, (random() - 0.5) * 4]),
              };
        for (let probe = 0; probe < 25; probe += 1) {
          const pointer: Point = [random() * VIEWPORT.width, random() * VIEWPORT.height];
          const expected = bruteForce(sample, frame, camera, pointer);
          const actual = snapHeight(sample, frame, camera, VIEWPORT, pointer);
          if (expected === null) expect(actual).toBeNull();
          else expect(actual).toBeCloseTo(expected, 3);
        }
      }
    });
  }

  it("answers a pointer over half a million points well inside a frame", () => {
    const random = mulberry32(SEEDS[0]);
    const count = 500_000;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const x = (random() - 0.5) * 120;
      const y = (random() - 0.5) * 120;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = 0.05 * x + (random() < 0.1 ? random() * 3 : 0);
    }
    const sample: PointSample = { count, positions, origin: [0, 0, 0], intensity: null, rgb: null };
    const views: readonly OrbitCamera[] = [
      { yaw: Math.PI, pitch: 0.5, distance: 60, target: [0, 0, 0] },
      { yaw: 0.3, pitch: 0.12, distance: 40, target: [0, 0, 0] },
      topDownCamera([0, 0, 0], 60),
    ];
    snapHeight(sample, "lidar_flu", views[0], VIEWPORT, [400, 300]);
    const queries = 300;
    const started = performance.now();
    for (let q = 0; q < queries; q += 1) {
      snapHeight(sample, "lidar_flu", views[q % views.length], VIEWPORT, [random() * VIEWPORT.width, random() * VIEWPORT.height]);
    }
    const perQuery = (performance.now() - started) / queries;
    expect(perQuery).toBeLessThan(16);
  });
});
