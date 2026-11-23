/** Test harness for the scan editor: a scan, a schema, a camera that looks down on it. */

import { EMPTY_SELECTION, type Selection } from "../../state/selection";
import {
  isCuboidScanAnnotation,
  type AnnotationSchema,
  type AssetDescriptor,
  type Cuboid3DGeometry,
  type CuboidScanAnnotation,
  type Point,
  type Point3D,
  type ScanAnnotation,
} from "../../types";
import type { OrbitCamera } from "../camera";
import type { ScanFrame } from "../frame";
import { screenOf } from "../ray";
import type { ScanContext, ScanTool } from "./machine";
import { DEFAULT_HIT_TOLERANCES_3D, type ScanViewKind } from "./scene";
import { createScanDocument, type ScanDocument } from "./scanDocument";

export const SCAN: AssetDescriptor = { id: "scan-1", width: 0, height: 0, modality: "point_cloud" };

export const SCAN_SCHEMA: AnnotationSchema = {
  project_id: "project-1",
  version: 3,
  classes: [
    {
      name: "car",
      geometries: ["cuboid_3d"],
      color: null,
      attributes: [{ name: "parked", kind: "boolean", required: false, options: null, default: false }],
    },
  ],
  description: null,
  created_at: null,
  provenance: null,
};

export const LOOKING_DOWN: OrbitCamera = { yaw: Math.PI, pitch: 1.2, distance: 30, target: [0, 0, 0] };

export const VIEW = { width: 800, height: 600 };

export function scanBox(id: string, geometry: Partial<Cuboid3DGeometry> = {}): CuboidScanAnnotation {
  return {
    id,
    asset_id: SCAN.id,
    label_class: "car",
    schema_version: 3,
    geometry: { type: "cuboid_3d", center: [0, 0, 1], size: [4, 2, 2], yaw: 0, ...geometry },
    attributes: {},
    provenance: "import",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

export function cuboidOf(annotation: ScanAnnotation | undefined): CuboidScanAnnotation {
  if (annotation === undefined || !isCuboidScanAnnotation(annotation)) throw new Error("not a cuboid");
  return annotation;
}

export function scanDocumentOf(...boxes: ScanAnnotation[]): ScanDocument {
  return createScanDocument(SCAN, SCAN_SCHEMA, boxes);
}

export function contextOf(
  document: ScanDocument,
  overrides: { selection?: Selection; tool?: ScanTool; frame?: ScanFrame; camera?: OrbitCamera; view?: ScanViewKind } = {},
): ScanContext {
  let minted = 0;
  return {
    document,
    selection: overrides.selection ?? EMPTY_SELECTION,
    frame: overrides.frame ?? "lidar_flu",
    camera: overrides.camera ?? LOOKING_DOWN,
    viewport: VIEW,
    tool: overrides.tool ?? { kind: "select" },
    groundHeight: 0,
    tolerances: DEFAULT_HIT_TOLERANCES_3D,
    mint: () => `drawn-${(minted += 1)}`,
    ...(overrides.view === undefined ? {} : { view: overrides.view }),
  };
}

/** Where a frame point lands on the test view; throws when it is off-camera. */
export function pixelOf(context: ScanContext, point: Point3D): Point {
  const pixel = screenOf(context.camera, context.frame, context.viewport, point);
  if (pixel === null) throw new Error(`point ${point.join(", ")} is behind the test camera`);
  return pixel;
}
