/**
 * A scan's 3D labels as line segments in the scan's own frame. No calibration
 * takes part: a label on a scan is already in the axes its source declares.
 */

import { CUBOID_EDGES } from "../geometry/projection";
import type { Cuboid3DGeometry, Point3D, StoredAnnotation } from "../types";
import { cuboidCorners3D } from "./cuboid";
import type { ScanFrame } from "./frame";

export interface ScanLabel {
  readonly id: string;
  readonly labelClass: string;
  /** `x, y, z` per vertex, two vertices a segment, for `gl.LINES`, in doubles. */
  readonly segments: Float64Array;
}

export function cuboidSegments(geometry: Cuboid3DGeometry, frame: ScanFrame): Float64Array {
  const corners = cuboidCorners3D(geometry, frame);
  const out = new Float64Array(CUBOID_EDGES.length * 6);
  CUBOID_EDGES.forEach(([from, to], edge) => {
    out.set(corners[from], edge * 6);
    out.set(corners[to], edge * 6 + 3);
  });
  return out;
}

export function polylineSegments(points: readonly Point3D[]): Float64Array {
  const out = new Float64Array(Math.max(0, points.length - 1) * 6);
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
    let segments: Float64Array;
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

/** Scan-frame segments moved by `-origin` in doubles, then rounded for the GPU. */
export function segmentsRelativeTo(segments: ArrayLike<number>, origin: Point3D): Float32Array {
  const out = new Float32Array(segments.length);
  for (let i = 0; i < segments.length; i += 1) out[i] = segments[i] - origin[i % 3];
  return out;
}
