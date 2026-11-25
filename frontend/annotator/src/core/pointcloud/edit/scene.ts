/**
 * What the scan editor can point at: the selected polyline's vertices or the
 * selected box's camera-facing face handles and yaw ring, then any polyline's segments, then
 * any box's body. Pure; the adapter hands over the camera and the
 * viewport it draws with, and the same two place the handles on screen.
 */

import { eyeOf, viewBasis, type OrbitCamera } from "../camera";
import { cuboidAxes, faceCenter, faceSpec, CUBOID_FACES, type CuboidFace } from "../cuboid";
import { heightOf, type ScanFrame } from "../frame";
import {
  closestOnAxis,
  metresPerPixel,
  rayCuboidHit,
  rayGroundHit,
  screenOf,
  screenRay,
  type Ray,
  type ScanViewport,
} from "../ray";
import { add, dot, scale, subtract } from "../vector";
import type { Selection } from "../../state/selection";
import {
  isCuboidScanAnnotation,
  isPolylineScanAnnotation,
  type Cuboid3DGeometry,
  type Point,
  type Point3D,
  type Polyline3DGeometry,
} from "../../types";
import type { ScanDocument } from "./scanDocument";

/**
 * Which view a screen point was read through. The top-down view looks straight
 * down the up axis, so it offers only the four side faces (top and bottom sit on
 * the body's centre there) and reads no height.
 */
export type ScanViewKind = "perspective" | "top-down";

export interface Scene3D {
  /**
   * The committed document wherever a press is read (the machine, `hitTest3D`),
   * so a drag measures against what is stored. The handle overlay takes the
   * store's `rendered` instead, so its handles follow a staged drag.
   */
  readonly document: ScanDocument;
  readonly selection: Selection;
  readonly frame: ScanFrame;
  readonly camera: OrbitCamera;
  readonly viewport: ScanViewport;
  /** Absent means `perspective`. */
  readonly view?: ScanViewKind;
}

const ALL_FACES: readonly CuboidFace[] = CUBOID_FACES.map(({ face }) => face);
export const LEVEL_FACES: readonly CuboidFace[] = ["front", "back", "left", "right"];

/**
 * Whether a face's outward normal points towards the eye: towards the eye's
 * position for a perspective camera, against the view direction for an
 * orthographic one. Only the box's own body is considered, never other boxes
 * or the points.
 */
export function facesCamera(geometry: Cuboid3DGeometry, frame: ScanFrame, camera: OrbitCamera, face: CuboidFace): boolean {
  const { axis, sign } = faceSpec(face);
  const normal = scale(cuboidAxes(geometry, frame)[axis], sign);
  const towardEye =
    camera.projection === "orthographic"
      ? scale(viewBasis(camera, frame).forward, -1)
      : subtract(eyeOf(camera, frame), faceCenter(geometry, frame, face));
  return dot(normal, towardEye) > 0;
}

/**
 * The faces a view offers handles for, drawn and hit alike. The perspective view
 * offers those facing the camera; the top-down view looks along the four side
 * faces edge-on and offers all four.
 */
export function handleFaces(
  scene: Pick<Scene3D, "camera" | "frame" | "view">,
  geometry: Cuboid3DGeometry,
): readonly CuboidFace[] {
  if (scene.view === "top-down") return LEVEL_FACES;
  return ALL_FACES.filter((face) => facesCamera(geometry, scene.frame, scene.camera, face));
}

/** How near, in screen pixels, a pointer must come to a handle or the ring. */
export interface HitTolerances3D {
  readonly handlePx: number;
  readonly ringPx: number;
}

export const DEFAULT_HIT_TOLERANCES_3D: HitTolerances3D = { handlePx: 8, ringPx: 6 };

export type Hit3D =
  | { readonly kind: "face"; readonly id: string; readonly face: CuboidFace }
  | { readonly kind: "yaw-ring"; readonly id: string; readonly point: Point3D }
  | { readonly kind: "body"; readonly id: string; readonly point: Point3D }
  | { readonly kind: "vertex"; readonly id: string; readonly index: number }
  | { readonly kind: "segment"; readonly id: string; readonly segment: number; readonly point: Point3D };

export interface YawRing {
  /** The centre of the box's bottom face; the ring lies level through it. */
  readonly center: Point3D;
  readonly radius: number;
  /** The ring's level along the frame's up axis. */
  readonly level: number;
}

/** The ring a yaw drag grabs: level with the box's bottom, clear of its footprint. */
export function yawRing(geometry: Cuboid3DGeometry, frame: ScanFrame): YawRing {
  const center = faceCenter(geometry, frame, "bottom");
  const diagonal = Math.hypot(geometry.size[0], geometry.size[1]);
  return { center, radius: diagonal / 2 + Math.max(0.3, diagonal * 0.1), level: heightOf(frame, center) };
}

/** The face handles, each at its face's centre; all six unless `faces` names fewer. */
export function faceHandles(
  geometry: Cuboid3DGeometry,
  frame: ScanFrame,
  faces: readonly CuboidFace[] = ALL_FACES,
): readonly { readonly face: CuboidFace; readonly point: Point3D }[] {
  return faces.map((face) => ({ face, point: faceCenter(geometry, frame, face) }));
}

/** The one box whose handles are live: the selection's, when it is exactly one box. */
export function handleTarget(scene: Scene3D): { readonly id: string; readonly geometry: Cuboid3DGeometry } | null {
  if (scene.selection.size !== 1) return null;
  const [id] = scene.selection;
  const annotation = scene.document.annotations.get(id);
  return annotation === undefined || !isCuboidScanAnnotation(annotation) ? null : { id, geometry: annotation.geometry };
}

/** The one polyline whose vertices are live: the selection's, when it is exactly one polyline. */
export function vertexTarget(scene: Scene3D): { readonly id: string; readonly geometry: Polyline3DGeometry } | null {
  if (scene.selection.size !== 1) return null;
  const [id] = scene.selection;
  const annotation = scene.document.annotations.get(id);
  return annotation === undefined || !isPolylineScanAnnotation(annotation) ? null : { id, geometry: annotation.geometry };
}

/** What lies under a screen point: the selected label's handles, then any polyline's segment, then the nearest box body. */
export function hitTest3D(
  scene: Scene3D,
  point: Point,
  tolerances: HitTolerances3D = DEFAULT_HIT_TOLERANCES_3D,
): Hit3D | null {
  const { camera, frame, viewport } = scene;
  const ray = screenRay(camera, frame, viewport, point);
  const pixelsTo = (at: Point3D): number => {
    const onScreen = screenOf(camera, frame, viewport, at);
    return onScreen === null ? Infinity : Math.hypot(onScreen[0] - point[0], onScreen[1] - point[1]);
  };

  const line = vertexTarget(scene);
  if (line !== null) {
    let vertex: { index: number; distance: number } | null = null;
    for (const [index, at] of line.geometry.points.entries()) {
      const distance = pixelsTo(at);
      if (distance <= tolerances.handlePx && (vertex === null || distance < vertex.distance)) vertex = { index, distance };
    }
    if (vertex !== null) return { kind: "vertex", id: line.id, index: vertex.index };
  }

  const target = handleTarget(scene);

  if (target !== null) {
    let nearest: { face: CuboidFace; distance: number } | null = null;
    for (const handle of faceHandles(target.geometry, frame, handleFaces(scene, target.geometry))) {
      const onScreen = screenOf(camera, frame, viewport, handle.point);
      if (onScreen === null) continue;
      const distance = Math.hypot(onScreen[0] - point[0], onScreen[1] - point[1]);
      if (distance <= tolerances.handlePx && (nearest === null || distance < nearest.distance)) {
        nearest = { face: handle.face, distance };
      }
    }
    if (nearest !== null) return { kind: "face", id: target.id, face: nearest.face };

    const ring = yawRing(target.geometry, frame);
    const onRing = rayGroundHit(ray, frame, ring.level);
    if (onRing !== null) {
      const offset = subtract(onRing, ring.center);
      const off = Math.abs(Math.hypot(offset[0], offset[1], offset[2]) - ring.radius);
      if (off <= tolerances.ringPx * metresPerPixel(camera, frame, viewport, onRing)) {
        return { kind: "yaw-ring", id: target.id, point: onRing };
      }
    }
  }

  let nearestSegment: { id: string; segment: number; point: Point3D; distance: number } | null = null;
  for (const annotation of scene.document.annotations.values()) {
    if (!isPolylineScanAnnotation(annotation)) continue;
    const { points } = annotation.geometry;
    for (let segment = 0; segment < points.length - 1; segment++) {
      const on = closestOnSegment(ray, points[segment]!, points[segment + 1]!);
      if (on === null) continue;
      const distance = pixelsTo(on);
      if (distance <= tolerances.handlePx && (nearestSegment === null || distance < nearestSegment.distance)) {
        nearestSegment = { id: annotation.id, segment, point: on, distance };
      }
    }
  }
  if (nearestSegment !== null) {
    return { kind: "segment", id: nearestSegment.id, segment: nearestSegment.segment, point: nearestSegment.point };
  }

  let body: { id: string; point: Point3D; distance: number } | null = null;
  for (const annotation of scene.document.annotations.values()) {
    if (!isCuboidScanAnnotation(annotation)) continue;
    const hit = rayCuboidHit(ray, annotation.geometry, frame);
    if (hit !== null && (body === null || hit.distance <= body.distance)) {
      body = { id: annotation.id, point: hit.point, distance: hit.distance };
    }
  }
  return body === null ? null : { kind: "body", id: body.id, point: body.point };
}

/** The point of segment `a`–`b` nearest the ray, or `null` for a zero-length segment or one parallel to the ray. */
function closestOnSegment(ray: Ray, a: Point3D, b: Point3D): Point3D | null {
  const ab = subtract(b, a);
  const length = Math.sqrt(dot(ab, ab));
  if (length === 0) return null;
  const axis = scale(ab, 1 / length);
  const along = closestOnAxis(ray, a, axis);
  return along === null ? null : add(a, scale(axis, Math.min(length, Math.max(0, along))));
}
