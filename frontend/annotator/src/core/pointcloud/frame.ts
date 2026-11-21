/**
 * The axis conventions a scan's source can declare, mirroring the kernel's
 * `ScanFrame`. A scan is drawn in exactly these axes: the viewer orbits about
 * the declared up axis and never re-expresses a coordinate.
 */

import type { Point3D } from "../types";

export type ScanFrame = "lidar_flu" | "camera_rdf";

/** One frame axis as `[index over (x, y, z), sign]`. */
export type FrameAxis = readonly [0 | 1 | 2, 1 | -1];

export interface FrameAxes {
  readonly forward: FrameAxis;
  readonly left: FrameAxis;
  readonly up: FrameAxis;
}

export const SCAN_FRAME_AXES: Readonly<Record<ScanFrame, FrameAxes>> = {
  lidar_flu: { forward: [0, 1], left: [1, 1], up: [2, 1] },
  camera_rdf: { forward: [2, 1], left: [0, -1], up: [1, -1] },
};

export function isScanFrame(value: unknown): value is ScanFrame {
  return value === "lidar_flu" || value === "camera_rdf";
}

/** A vector given as `[forward, left, up]`, in the frame's own coordinates. */
export function fromForwardLeftUp(frame: ScanFrame, [f, l, u]: Point3D): Point3D {
  const { forward, left, up } = SCAN_FRAME_AXES[frame];
  const out = [0, 0, 0];
  out[forward[0]] += forward[1] * f;
  out[left[0]] += left[1] * l;
  out[up[0]] += up[1] * u;
  return [out[0], out[1], out[2]];
}

/** How far up `point` is, along the frame's up axis. */
export function heightOf(frame: ScanFrame, point: Point3D): number {
  const [index, sign] = SCAN_FRAME_AXES[frame].up;
  return sign * point[index];
}
