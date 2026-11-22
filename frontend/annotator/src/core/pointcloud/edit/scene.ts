/**
 * What the scan editor can point at: the selected box's face handles and yaw
 * ring, then any box's body. Pure; the adapter hands over the camera and the
 * viewport it draws with, and the same two place the handles on screen.
 */

import type { OrbitCamera } from "../camera";
import { faceCenter, CUBOID_FACES, type CuboidFace } from "../cuboid";
import { heightOf, type ScanFrame } from "../frame";
import { metresPerPixel, rayCuboidHit, rayGroundHit, screenOf, screenRay, type ScanViewport } from "../ray";
import { subtract } from "../vector";
import type { Selection } from "../../state/selection";
import type { Cuboid3DGeometry, Point, Point3D } from "../../types";
import type { ScanDocument } from "./scanDocument";

/**
 * Which view a screen point was read through. The top-down view looks straight
 * down the up axis, so it offers only the four side faces (top and bottom sit on
 * the body's centre there) and reads no height.
 */
export type ScanViewKind = "perspective" | "top-down";

export interface Scene3D {
  /** The committed document, never the store's `rendered`. */
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

/** The faces a view offers handles for. */
export function handleFaces(view: ScanViewKind = "perspective"): readonly CuboidFace[] {
  return view === "top-down" ? LEVEL_FACES : ALL_FACES;
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
  | { readonly kind: "body"; readonly id: string; readonly point: Point3D };

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
  return annotation === undefined ? null : { id, geometry: annotation.geometry };
}

/** What lies under a screen point: a handle of the selected box first, then the nearest body. */
export function hitTest3D(
  scene: Scene3D,
  point: Point,
  tolerances: HitTolerances3D = DEFAULT_HIT_TOLERANCES_3D,
): Hit3D | null {
  const { camera, frame, viewport } = scene;
  const ray = screenRay(camera, frame, viewport, point);
  const target = handleTarget(scene);

  if (target !== null) {
    let nearest: { face: CuboidFace; distance: number } | null = null;
    for (const handle of faceHandles(target.geometry, frame, handleFaces(scene.view))) {
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

  let body: { id: string; point: Point3D; distance: number } | null = null;
  for (const annotation of scene.document.annotations.values()) {
    const hit = rayCuboidHit(ray, annotation.geometry, frame);
    if (hit !== null && (body === null || hit.distance <= body.distance)) {
      body = { id: annotation.id, point: hit.point, distance: hit.distance };
    }
  }
  return body === null ? null : { kind: "body", id: body.id, point: body.point };
}
