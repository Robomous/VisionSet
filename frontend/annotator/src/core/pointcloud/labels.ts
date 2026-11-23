/**
 * A scan's 3D labels as line segments in the scan's own frame. No calibration
 * takes part: a label on a scan is already in the axes its source declares.
 */

import { CUBOID_EDGES, cuboidCorners } from "../geometry/projection";
import type { Cuboid3DGeometry, Point3D, StoredAnnotation } from "../types";
import { fromForwardLeftUp, type ScanFrame } from "./frame";

export interface ScanLabel {
  readonly id: string;
  readonly labelClass: string;
  /** `x, y, z` per vertex, two vertices a segment, for `gl.LINES`. */
  readonly segments: Float32Array;
}

/**
 * A scan cuboid's eight corners: `length` along the heading
 * `cos(yaw)·forward + sin(yaw)·left`, `width` across it, `height` along up.
 *
 * `cuboidCorners` builds the image convention, a box about +y with heading
 * `(cos yaw, 0, −sin yaw)`; read as `(forward, left, up) = (x, −z, −y)` that is
 * exactly this box, with corner `i` still differing from its neighbours by one
 * bit, so `CUBOID_EDGES` joins these corners too.
 */
export function scanCuboidCorners(geometry: Cuboid3DGeometry, frame: ScanFrame): readonly Point3D[] {
  const [cx, cy, cz] = geometry.center;
  return cuboidCorners({ ...geometry, center: [0, 0, 0] }).map(([x, y, z]) => {
    const [dx, dy, dz] = fromForwardLeftUp(frame, [x, -z, -y]);
    return [cx + dx, cy + dy, cz + dz] as const;
  });
}

export function cuboidSegments(geometry: Cuboid3DGeometry, frame: ScanFrame): Float32Array {
  const corners = scanCuboidCorners(geometry, frame);
  const out = new Float32Array(CUBOID_EDGES.length * 6);
  CUBOID_EDGES.forEach(([from, to], edge) => {
    out.set(corners[from], edge * 6);
    out.set(corners[to], edge * 6 + 3);
  });
  return out;
}

export function polylineSegments(points: readonly Point3D[]): Float32Array {
  const out = new Float32Array(Math.max(0, points.length - 1) * 6);
  for (let at = 0; at + 1 < points.length; at += 1) {
    out.set(points[at], at * 6);
    out.set(points[at + 1], at * 6 + 3);
  }
  return out;
}

/** Every 3D label among `annotations`, as segments; every other geometry is left out. */
export function scanLabels(annotations: readonly StoredAnnotation[], frame: ScanFrame): readonly ScanLabel[] {
  const labels: ScanLabel[] = [];
  for (const annotation of annotations) {
    const { geometry } = annotation;
    let segments: Float32Array;
    if (geometry.type === "cuboid_3d") {
      segments = cuboidSegments(geometry, frame);
    } else if (geometry.type === "polyline_3d" && geometry.points.length >= 2) {
      segments = polylineSegments(geometry.points);
    } else {
      continue;
    }
    labels.push({ id: annotation.id, labelClass: annotation.label_class, segments });
  }
  return labels;
}
