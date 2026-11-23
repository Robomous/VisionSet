/**
 * Where the selected box's handles land on screen, for an overlay to draw.
 *
 * The same `screenOf` the hit test measures against, so a handle is drawn where
 * a press finds it. Anything behind the eye is left out; the ring is split into
 * the runs that stay in front of it.
 */

import { cuboidAxes, headingOfYaw, type CuboidFace } from "../cuboid";
import { fromForwardLeftUp, type ScanFrame } from "../frame";
import { screenOf } from "../ray";
import { add, scale } from "../vector";
import type { Cuboid3DGeometry, Point, Point3D } from "../../types";
import { faceHandles, handleFaces, handleTarget, yawRing, type Scene3D } from "./scene";

export interface ScanHandleLayout {
  readonly id: string;
  readonly handles: readonly { readonly face: CuboidFace; readonly point: Point }[];
  /** Screen polylines tracing the yaw ring. */
  readonly ring: readonly (readonly Point[])[];
  /** The bottom face's corners in turn; empty when any is behind the eye. */
  readonly footprint: readonly Point[];
  /** Where the box's heading crosses the yaw ring: a press there turns it. */
  readonly heading: Point | null;
}

const RING_STEPS = 64;

/** `null` unless exactly one box is selected. */
export function scanHandleLayout(scene: Scene3D): ScanHandleLayout | null {
  const target = handleTarget(scene);
  if (target === null) return null;
  const { camera, frame, viewport } = scene;
  const handles = faceHandles(target.geometry, frame, handleFaces(scene.view)).flatMap(({ face, point }) => {
    const onScreen = screenOf(camera, frame, viewport, point);
    return onScreen === null ? [] : [{ face, point: onScreen }];
  });

  const ring = yawRing(target.geometry, frame);
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (let step = 0; step <= RING_STEPS; step += 1) {
    const angle = (2 * Math.PI * step) / RING_STEPS;
    const offset = fromForwardLeftUp(frame, [ring.radius * Math.cos(angle), ring.radius * Math.sin(angle), 0]);
    const onScreen = screenOf(camera, frame, viewport, add(ring.center, offset));
    if (onScreen === null) {
      if (run.length > 1) runs.push(run);
      run = [];
    } else {
      run.push(onScreen);
    }
  }
  if (run.length > 1) runs.push(run);

  const footprint = footprintCorners(target.geometry, frame).map((corner) => screenOf(camera, frame, viewport, corner));
  const heading = screenOf(camera, frame, viewport, add(ring.center, scale(headingOfYaw(target.geometry.yaw, frame), ring.radius)));
  return {
    id: target.id,
    handles,
    ring: runs,
    footprint: footprint.every((corner): corner is Point => corner !== null) ? footprint : [],
    heading,
  };
}

function footprintCorners(geometry: Cuboid3DGeometry, frame: ScanFrame): Point3D[] {
  const [along, across, up] = cuboidAxes(geometry, frame);
  const [length, width, height] = geometry.size;
  const bottom = add(geometry.center, scale(up, -height / 2));
  return [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ].map(([a, b]) => add(bottom, add(scale(along, (a * length) / 2), scale(across, (b * width) / 2))));
}
