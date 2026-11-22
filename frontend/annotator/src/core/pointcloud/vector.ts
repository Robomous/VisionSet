/** Three-vector arithmetic over `Point3D`, shared by the camera, the ray maths and the scan editor. */

import type { Point3D } from "../types";

export function add(a: Point3D, b: Point3D): Point3D {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function subtract(a: Point3D, b: Point3D): Point3D {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(v: Point3D, factor: number): Point3D {
  return [v[0] * factor, v[1] * factor, v[2] * factor];
}

export function cross(a: Point3D, b: Point3D): Point3D {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Point3D, b: Point3D): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function normalize(v: Point3D): Point3D {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
}
