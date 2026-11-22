/**
 * A scan cuboid's own axes, and the bridge between its stored yaw and a heading.
 *
 * On a scan, `yaw` turns the heading about the declared frame's up axis,
 * counter-clockwise from forward towards left: `scanCuboidCorners` draws that
 * box, and everything here is its inverse, so an edit writes back exactly the
 * convention the viewer read. Nothing is re-expressed in another frame.
 */

import type { Cuboid3DGeometry, Point3D } from "../types";
import { wrapAngle } from "./camera";
import { fromForwardLeftUp, type ScanFrame } from "./frame";
import { add, dot, scale, subtract } from "./vector";

export type CuboidFace = "front" | "back" | "left" | "right" | "top" | "bottom";

/**
 * Each face as an axis of `cuboidAxes` (heading, left, up) and a side. `size` is
 * indexed the same way: length, width, height.
 */
export const CUBOID_FACES: readonly {
  readonly face: CuboidFace;
  readonly axis: 0 | 1 | 2;
  readonly sign: 1 | -1;
}[] = [
  { face: "front", axis: 0, sign: 1 },
  { face: "back", axis: 0, sign: -1 },
  { face: "left", axis: 1, sign: 1 },
  { face: "right", axis: 1, sign: -1 },
  { face: "top", axis: 2, sign: 1 },
  { face: "bottom", axis: 2, sign: -1 },
];

/** The smallest extent an edit leaves on any axis, in metres; the kernel refuses zero. */
export const MIN_CUBOID_SIZE = 0.05;

export function faceSpec(face: CuboidFace): (typeof CUBOID_FACES)[number] {
  const spec = CUBOID_FACES.find((one) => one.face === face);
  if (spec === undefined) throw new RangeError(`unknown face ${face}`);
  return spec;
}

/** The unit heading at `yaw`: `cos(yaw)·forward + sin(yaw)·left`. */
export function headingOfYaw(yaw: number, frame: ScanFrame): Point3D {
  return fromForwardLeftUp(frame, [Math.cos(yaw), Math.sin(yaw), 0]);
}

/** The yaw whose heading points along `direction`'s level part, in `(-π, π]`. */
export function yawOfHeading(direction: Point3D, frame: ScanFrame): number {
  const forward = dot(direction, fromForwardLeftUp(frame, [1, 0, 0]));
  const left = dot(direction, fromForwardLeftUp(frame, [0, 1, 0]));
  return Math.atan2(left, forward);
}

/**
 * A yaw the kernel accepts. One already in `[-π, π]` is kept exactly, so an
 * untouched `-π` is not rewritten as `π` and does not read as an edit.
 */
export function wrapYaw(yaw: number): number {
  return yaw >= -Math.PI && yaw <= Math.PI ? yaw : wrapAngle(yaw);
}

/** The box's unit axes in frame coordinates: heading, left of heading, up. */
export function cuboidAxes(
  geometry: Cuboid3DGeometry,
  frame: ScanFrame,
): readonly [Point3D, Point3D, Point3D] {
  const cos = Math.cos(geometry.yaw);
  const sin = Math.sin(geometry.yaw);
  return [
    fromForwardLeftUp(frame, [cos, sin, 0]),
    fromForwardLeftUp(frame, [-sin, cos, 0]),
    fromForwardLeftUp(frame, [0, 0, 1]),
  ];
}

export function faceCenter(geometry: Cuboid3DGeometry, frame: ScanFrame, face: CuboidFace): Point3D {
  const { axis, sign } = faceSpec(face);
  return add(geometry.center, scale(cuboidAxes(geometry, frame)[axis], (sign * geometry.size[axis]) / 2));
}

/**
 * The box `scanCuboidCorners` drew these eight corners from: its inverse.
 * Corner 1 differs from corner 0 along the heading, 2 across it, 4 along up.
 */
export function cuboidFromScanCorners(corners: readonly Point3D[], frame: ScanFrame): Cuboid3DGeometry {
  if (corners.length !== 8) throw new RangeError(`a cuboid has 8 corners, not ${corners.length}`);
  const center = scale(corners.reduce<Point3D>((sum, corner) => add(sum, corner), [0, 0, 0]), 1 / 8);
  const along = subtract(corners[1], corners[0]);
  const length = (v: Point3D) => Math.hypot(v[0], v[1], v[2]);
  return {
    type: "cuboid_3d",
    center,
    size: [length(along), length(subtract(corners[2], corners[0])), length(subtract(corners[4], corners[0]))],
    yaw: yawOfHeading(along, frame),
  };
}

/**
 * The box with one face pushed `delta` metres outwards along its normal, the
 * opposite face held still. The extent never falls below `MIN_CUBOID_SIZE`.
 */
export function resizeCuboidFace(
  geometry: Cuboid3DGeometry,
  frame: ScanFrame,
  face: CuboidFace,
  delta: number,
): Cuboid3DGeometry {
  const { axis, sign } = faceSpec(face);
  const before = geometry.size[axis];
  const after = Math.max(MIN_CUBOID_SIZE, before + delta);
  const size = [...geometry.size] as [number, number, number];
  size[axis] = after;
  return {
    ...geometry,
    center: add(geometry.center, scale(cuboidAxes(geometry, frame)[axis], (sign * (after - before)) / 2)),
    size,
  };
}
