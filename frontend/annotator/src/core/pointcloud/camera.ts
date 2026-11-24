/**
 * An orbit camera about a target, in a scan's declared frame.
 *
 * `yaw` turns about the frame's up axis, counter-clockwise seen from above, with
 * `0` putting the eye on the forward axis; `pitch` lifts the eye towards up.
 * Both declared frames are right-handed, so a look-at with the frame's own up
 * never mirrors the scan. Matrices are column-major, as WebGL reads them.
 */

import type { Point3D } from "../types";
import type { PointBounds } from "./decode";
import { fromForwardLeftUp, heightOf, type ScanFrame } from "./frame";
import { robustRange } from "./ramp";
import { cross, dot, normalize, subtract } from "./vector";

export interface OrbitCamera {
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
  readonly target: Point3D;
  /**
   * Absent means `perspective`. An `orthographic` camera shows at every depth
   * the span a perspective one at the same distance shows at its target, so
   * zoom and pan read the same in both.
   */
  readonly projection?: "perspective" | "orthographic";
}

const NO_ORIGIN: Point3D = [0, 0, 0];

export const FIELD_OF_VIEW = Math.PI / 4;
export const MAX_PITCH = (89 * Math.PI) / 180;
/** The eye never drops below the target along the declared up, so the scan is not seen from underneath. */
export const MIN_PITCH = 0;
export const HOME_PITCH = (35 * Math.PI) / 180;
const MIN_DISTANCE_RATIO = 0.01;
const MAX_DISTANCE_RATIO = 20;

/** Half the bounds' diagonal; a single spot still gets a unit radius to look at. */
export function sceneRadius(bounds: PointBounds): number {
  const { minimum, maximum } = bounds;
  const radius = Math.hypot(maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]) / 2;
  return Number.isFinite(radius) && radius > 0 ? radius : 1;
}

/**
 * The box the opening view frames: each axis cut to its 2nd–98th percentile, so
 * a few far returns do not shrink the scan to a speck. `null` for no points.
 */
export function framingBounds(positions: Float32Array, origin: Point3D = NO_ORIGIN): PointBounds | null {
  const count = Math.floor(positions.length / 3);
  if (count === 0) return null;
  const ranges = [0, 1, 2].map((axis) => robustRange(count, (i) => positions[i * 3 + axis]));
  return {
    minimum: [ranges[0][0] + origin[0], ranges[1][0] + origin[1], ranges[2][0] + origin[2]],
    maximum: [ranges[0][1] + origin[0], ranges[1][1] + origin[1], ranges[2][1] + origin[2]],
  };
}

/**
 * The level a new box stands on: the scan's low robust height along the
 * declared up, so a few returns under the road do not sink it. `0` for no points.
 */
export function groundHeight(positions: Float32Array, frame: ScanFrame, origin: Point3D = NO_ORIGIN): number {
  const count = Math.floor(positions.length / 3);
  if (count === 0) return 0;
  const low = robustRange(count, (i) =>
    heightOf(frame, [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]),
  )[0];
  return low + heightOf(frame, origin);
}

/** From behind the forward axis and above, far enough to hold `bounds`. */
export function homeCamera(bounds: PointBounds): OrbitCamera {
  const { minimum, maximum } = bounds;
  return {
    yaw: Math.PI,
    pitch: HOME_PITCH,
    distance: (sceneRadius(bounds) / Math.sin(FIELD_OF_VIEW / 2)) * 1.05,
    target: [
      (minimum[0] + maximum[0]) / 2,
      (minimum[1] + maximum[1]) / 2,
      (minimum[2] + maximum[2]) / 2,
    ],
  };
}

/**
 * A milliradian short of straight down: `viewBasis` needs the eye off the up
 * axis to name a screen right, and the orbit's own limit leaves a box's top a
 * visible few pixels off its footprint when zoomed in.
 */
export const TOP_DOWN_PITCH = Math.PI / 2 - 1e-3;

/**
 * The top-down view's camera: from behind forward, so forward reads up the
 * screen and left reads left. Orthographic, because a perspective one this
 * close draws a box's top visibly larger than its footprint.
 */
export function topDownCamera(target: Point3D, distance: number): OrbitCamera {
  return { yaw: Math.PI, pitch: TOP_DOWN_PITCH, distance, target, projection: "orthographic" };
}

/** Half the view's height at the target, in metres; an orthographic view's at every depth. */
export function viewHalfHeight(camera: OrbitCamera): number {
  return camera.distance * Math.tan(FIELD_OF_VIEW / 2);
}

export function orbit(camera: OrbitCamera, deltaYaw: number, deltaPitch: number): OrbitCamera {
  return {
    ...camera,
    yaw: wrapAngle(camera.yaw + deltaYaw),
    pitch: Math.min(MAX_PITCH, Math.max(MIN_PITCH, camera.pitch + deltaPitch)),
  };
}

/** `factor` below 1 moves closer; held between 1% and 20× the scene's radius. */
export function zoom(camera: OrbitCamera, factor: number, radius: number): OrbitCamera {
  const distance = Math.min(
    radius * MAX_DISTANCE_RATIO,
    Math.max(radius * MIN_DISTANCE_RATIO, camera.distance * factor),
  );
  return { ...camera, distance };
}

/** Slide the target so the scene follows a drag of `dx, dy` pixels on a `heightPx`-tall view. */
export function pan(
  camera: OrbitCamera,
  frame: ScanFrame,
  dx: number,
  dy: number,
  heightPx: number,
): OrbitCamera {
  if (!(heightPx > 0)) return camera;
  const { right, up } = viewBasis(camera, frame);
  const perPixel = (2 * camera.distance * Math.tan(FIELD_OF_VIEW / 2)) / heightPx;
  const [tx, ty, tz] = camera.target;
  return {
    ...camera,
    target: [
      tx + (-dx * right[0] + dy * up[0]) * perPixel,
      ty + (-dx * right[1] + dy * up[1]) * perPixel,
      tz + (-dx * right[2] + dy * up[2]) * perPixel,
    ],
  };
}

export function eyeOf(camera: OrbitCamera, frame: ScanFrame): Point3D {
  const { yaw, pitch, distance, target } = camera;
  const [x, y, z] = fromForwardLeftUp(frame, [
    distance * Math.cos(pitch) * Math.cos(yaw),
    distance * Math.cos(pitch) * Math.sin(yaw),
    distance * Math.sin(pitch),
  ]);
  return [target[0] + x, target[1] + y, target[2] + z];
}

/** The camera's screen axes and view direction, in frame coordinates. */
export function viewBasis(
  camera: OrbitCamera,
  frame: ScanFrame,
): { readonly forward: Point3D; readonly right: Point3D; readonly up: Point3D } {
  const eye = eyeOf(camera, frame);
  const forward = normalize(subtract(camera.target, eye));
  const right = normalize(cross(forward, fromForwardLeftUp(frame, [0, 0, 1])));
  return { forward, right, up: cross(right, forward) };
}

export function lookAt(camera: OrbitCamera, frame: ScanFrame): Float32Array {
  const eye = eyeOf(camera, frame);
  const { forward: f, right: s, up: u } = viewBasis(camera, frame);
  // prettier-ignore
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot(s, eye), -dot(u, eye), dot(f, eye), 1,
  ]);
}

export function perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov / 2);
  const range = near - far;
  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / range, -1,
    0, 0, (2 * far * near) / range, 0,
  ]);
}

export function orthographic(halfWidth: number, halfHeight: number, near: number, far: number): Float32Array {
  const depth = far - near;
  // prettier-ignore
  return new Float32Array([
    1 / halfWidth, 0, 0, 0,
    0, 1 / halfHeight, 0, 0,
    0, 0, -2 / depth, 0,
    0, 0, -(far + near) / depth, 1,
  ]);
}

export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * Projection × view, with depth planes wide enough for the scene from anywhere the camera can be.
 *
 * With an `origin`, the matrix takes coordinates relative to it: the camera is
 * moved by `-origin` in doubles before anything is rounded to float32, so a
 * scan far from its frame's zero still draws without jitter.
 */
export function viewProjection(
  camera: OrbitCamera,
  frame: ScanFrame,
  aspect: number,
  radius: number,
  origin: Point3D = NO_ORIGIN,
): Float32Array {
  const local = { ...camera, target: subtract(camera.target, origin) };
  const far = (local.distance + 2 * radius) * 2;
  const ratio = aspect > 0 ? aspect : 1;
  if (local.projection === "orthographic") {
    // The near plane sits as far behind the eye as the far one ahead, so nothing above a close eye is cut.
    const half = viewHalfHeight(local);
    return multiply(orthographic(half * ratio, half, -far, far), lookAt(local, frame));
  }
  return multiply(perspective(FIELD_OF_VIEW, ratio, far / 10_000, far), lookAt(local, frame));
}

/** Where a frame point lands, in normalized device coordinates; `null` behind the eye. */
export function projectToNdc(matrix: Float32Array, [x, y, z]: Point3D): Point3D | null {
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const clipZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (!(clipW > 0)) return null;
  return [clipX / clipW, clipY / clipW, clipZ / clipW];
}

/** `angle` turned into `(-π, π]`. */
export function wrapAngle(angle: number): number {
  const turn = 2 * Math.PI;
  const wrapped = ((((angle + Math.PI) % turn) + turn) % turn) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}
