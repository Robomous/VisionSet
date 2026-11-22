/**
 * Screen to scan: the inverse of `viewProjection`, and the three things a ray is
 * asked to meet — the ground, an axis, a cuboid.
 *
 * Screen points are CSS pixels from the viewport's top-left, the space a pointer
 * event reports. Every result is in the scan's declared frame.
 */

import type { Cuboid3DGeometry, Point, Point3D } from "../types";
import { eyeOf, FIELD_OF_VIEW, viewBasis, viewHalfHeight, type OrbitCamera } from "./camera";
import { cuboidAxes, CUBOID_FACES, type CuboidFace } from "./cuboid";
import { SCAN_FRAME_AXES, type ScanFrame } from "./frame";
import { add, dot, normalize, scale, subtract } from "./vector";

export interface Ray {
  readonly origin: Point3D;
  /** Unit length. */
  readonly direction: Point3D;
}

export interface ScanViewport {
  readonly width: number;
  readonly height: number;
}

const PARALLEL = 1e-9;
/**
 * How far behind the view plane an orthographic ray starts, in metres: beyond
 * any scan, so it meets everything the view draws, above a close eye included.
 */
const ORTHOGRAPHIC_STANDOFF = 10_000;

/** A screen point as normalized device coordinates, `y` up. */
export function screenToNdc([x, y]: Point, viewport: ScanViewport): readonly [number, number] {
  return [(2 * x) / viewport.width - 1, 1 - (2 * y) / viewport.height];
}

/** An NDC point as a screen point; the inverse of `screenToNdc`. */
export function ndcToScreen([x, y]: readonly [number, number], viewport: ScanViewport): Point {
  return [((x + 1) / 2) * viewport.width, ((1 - y) / 2) * viewport.height];
}

/**
 * The ray from the eye through an NDC point: every frame point `projectToNdc`
 * sends to `ndc` under `viewProjection(camera, frame, aspect, …)` lies on it.
 */
export function ndcRay(
  camera: OrbitCamera,
  frame: ScanFrame,
  aspect: number,
  [x, y]: readonly [number, number],
): Ray {
  const { forward, right, up } = viewBasis(camera, frame);
  const ratio = aspect > 0 ? aspect : 1;
  if (camera.projection === "orthographic") {
    const half = viewHalfHeight(camera);
    const onPlane = add(eyeOf(camera, frame), add(scale(right, x * half * ratio), scale(up, y * half)));
    return { origin: add(onPlane, scale(forward, -ORTHOGRAPHIC_STANDOFF)), direction: forward };
  }
  const tangent = Math.tan(FIELD_OF_VIEW / 2);
  const across = x * tangent * ratio;
  const along = y * tangent;
  return {
    origin: eyeOf(camera, frame),
    direction: normalize(add(forward, add(scale(right, across), scale(up, along)))),
  };
}

/** The ray under a screen point. */
export function screenRay(camera: OrbitCamera, frame: ScanFrame, viewport: ScanViewport, point: Point): Ray {
  return ndcRay(camera, frame, viewport.width / viewport.height, screenToNdc(point, viewport));
}

/**
 * Where a frame point lands on screen, or `null` behind a perspective eye: the
 * x and y `projectToNdc` gives under `viewProjection`, read in pixels.
 */
export function screenOf(camera: OrbitCamera, frame: ScanFrame, viewport: ScanViewport, point: Point3D): Point | null {
  const { forward, right, up } = viewBasis(camera, frame);
  const offset = subtract(point, eyeOf(camera, frame));
  const aspect = viewport.width / viewport.height;
  if (camera.projection === "orthographic") {
    const half = viewHalfHeight(camera);
    return ndcToScreen([dot(offset, right) / (half * (aspect > 0 ? aspect : 1)), dot(offset, up) / half], viewport);
  }
  const depth = dot(offset, forward);
  if (!(depth > 0)) return null;
  const tangent = Math.tan(FIELD_OF_VIEW / 2);
  return ndcToScreen(
    [dot(offset, right) / (depth * tangent * (aspect > 0 ? aspect : 1)), dot(offset, up) / (depth * tangent)],
    viewport,
  );
}

/** How many metres one screen pixel spans at `point`'s depth; `Infinity` behind a perspective eye. */
export function metresPerPixel(camera: OrbitCamera, frame: ScanFrame, viewport: ScanViewport, point: Point3D): number {
  if (camera.projection === "orthographic") return (2 * viewHalfHeight(camera)) / viewport.height;
  const depth = dot(subtract(point, eyeOf(camera, frame)), viewBasis(camera, frame).forward);
  if (!(depth > 0)) return Infinity;
  return (2 * depth * Math.tan(FIELD_OF_VIEW / 2)) / viewport.height;
}

export function pointOnRay(ray: Ray, distance: number): Point3D {
  return add(ray.origin, scale(ray.direction, distance));
}

/**
 * Where the ray meets the level plane `height` up the frame's up axis, or
 * `null` when it runs parallel to it or meets it behind the eye.
 */
export function rayGroundHit(ray: Ray, frame: ScanFrame, height: number): Point3D | null {
  const [index, sign] = SCAN_FRAME_AXES[frame].up;
  const rate = sign * ray.direction[index];
  if (Math.abs(rate) < PARALLEL) return null;
  const distance = (height - sign * ray.origin[index]) / rate;
  return distance > 0 ? pointOnRay(ray, distance) : null;
}

/**
 * The parameter `s` of the point on the line `origin + s·axis` nearest the ray,
 * or `null` when the two are parallel. `axis` is unit length. A drag along a
 * box's axis reads its pointer this way.
 */
export function closestOnAxis(ray: Ray, origin: Point3D, axis: Point3D): number | null {
  const offset = subtract(origin, ray.origin);
  const b = dot(axis, ray.direction);
  const denominator = 1 - b * b;
  if (denominator < PARALLEL) return null;
  return (b * dot(ray.direction, offset) - dot(axis, offset)) / denominator;
}

export interface CuboidHit {
  readonly distance: number;
  readonly point: Point3D;
  readonly face: CuboidFace;
}

/**
 * Where the ray first meets an oriented cuboid, and through which face; `null`
 * when it misses or the box is behind the eye. From inside, the exit face.
 */
export function rayCuboidHit(ray: Ray, geometry: Cuboid3DGeometry, frame: ScanFrame): CuboidHit | null {
  const axes = cuboidAxes(geometry, frame);
  const offset = subtract(ray.origin, geometry.center);
  let near = -Infinity;
  let far = Infinity;
  let nearFace: CuboidFace | null = null;
  let farFace: CuboidFace | null = null;
  for (let axis = 0; axis < 3; axis += 1) {
    const half = geometry.size[axis] / 2;
    const start = dot(offset, axes[axis]);
    const rate = dot(ray.direction, axes[axis]);
    if (Math.abs(rate) < PARALLEL) {
      if (Math.abs(start) > half) return null;
      continue;
    }
    const enter = (-half - start) / rate;
    const leave = (half - start) / rate;
    const [low, high] = enter < leave ? [enter, leave] : [leave, enter];
    const entering = faceOf(axis, rate > 0 ? -1 : 1);
    const leaving = faceOf(axis, rate > 0 ? 1 : -1);
    if (low > near) {
      near = low;
      nearFace = entering;
    }
    if (high < far) {
      far = high;
      farFace = leaving;
    }
    if (near > far) return null;
  }
  if (far <= 0) return null;
  const [distance, face] = near > 0 ? [near, nearFace] : [far, farFace];
  if (face === null) return null;
  return { distance, point: pointOnRay(ray, distance), face };
}

function faceOf(axis: number, sign: 1 | -1): CuboidFace {
  const face = CUBOID_FACES.find((one) => one.axis === axis && one.sign === sign);
  if (face === undefined) throw new RangeError(`no face on axis ${axis}`);
  return face.face;
}
