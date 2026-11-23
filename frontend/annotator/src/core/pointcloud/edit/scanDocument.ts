/**
 * The scan editor's document: a scan, its schema, and the cuboids and polylines on it.
 *
 * A sibling of `AnnotationDocument`, not a widening of it. The image document,
 * its tools and every dispatch over `Geometry` stay 2D; this one holds only
 * `cuboid_3d` and `polyline_3d`, in the scan's declared frame, and shares the generic pieces —
 * `CommandLog`, `AnnotatorStore`, `Selection` — rather than re-implementing them.
 * It keeps the same invariants and refusals: ids are the only handle, the order
 * is the draw order, and every operation returns a new document.
 *
 * Everything else a scan carries — a whole-scan tag — stays out
 * of it, and `planScanSave` leaves those out of its comparison in turn.
 */

import { isScanFrame, type ScanFrame } from "../frame";
import {
  isScanAnnotation,
  type AnnotationSchema,
  type AssetDescriptor,
  type ScanAnnotation,
} from "../../types";
import { DocumentError } from "../../state/document";
import { parseAnnotations, parseAssetDescriptor, parseSchema } from "../../wire";

export interface ScanDocument {
  readonly asset: AssetDescriptor;
  readonly schema: AnnotationSchema;
  readonly annotations: ReadonlyMap<string, ScanAnnotation>;
}

/**
 * Whether a scan's labels can be edited, and in which frame. A source that
 * declares no frame is drawn as `lidar_flu` by the viewer while the kernel
 * refuses every 3D write on it (`CALIBRATION_MISSING`), so editing is off there.
 */
export type ScanEditability =
  | { readonly editable: true; readonly frame: ScanFrame }
  | { readonly editable: false; readonly reason: "not-a-scan" | "frame-undeclared" };

export function scanEditability(asset: AssetDescriptor, declaredFrame: unknown): ScanEditability {
  if (asset.modality !== "point_cloud") return { editable: false, reason: "not-a-scan" };
  if (!isScanFrame(declaredFrame)) return { editable: false, reason: "frame-undeclared" };
  return { editable: true, frame: declaredFrame };
}

function requireOwnAsset(asset: AssetDescriptor, annotation: ScanAnnotation, what: string): void {
  if (annotation.asset_id !== asset.id) {
    throw new DocumentError(
      `cannot ${what} annotation ${annotation.id}: it belongs to asset ` +
        `${annotation.asset_id}, and this document holds ${asset.id}`,
    );
  }
}

export function createScanDocument(
  asset: AssetDescriptor,
  schema: AnnotationSchema,
  annotations: Iterable<ScanAnnotation> = [],
): ScanDocument {
  if (asset.modality !== "point_cloud") {
    throw new DocumentError(`asset ${asset.id} is not a scan, so it has no scan document`);
  }
  const byId = new Map<string, ScanAnnotation>();
  for (const annotation of annotations) {
    requireOwnAsset(asset, annotation, "load");
    if (byId.has(annotation.id)) {
      throw new DocumentError(`two annotations share the id ${annotation.id}`);
    }
    byId.set(annotation.id, annotation);
  }
  return { asset, schema, annotations: byId };
}

/** The scan document from the three responses, every other label parsed and left out. */
export function scanDocumentFromWire(payload: {
  readonly asset: unknown;
  readonly schema: unknown;
  readonly annotations: unknown;
}): ScanDocument {
  return createScanDocument(
    parseAssetDescriptor(payload.asset),
    parseSchema(payload.schema),
    parseAnnotations(payload.annotations).filter(isScanAnnotation),
  );
}

export function addScanAnnotation(document: ScanDocument, annotation: ScanAnnotation): ScanDocument {
  requireOwnAsset(document.asset, annotation, "add");
  if (document.annotations.has(annotation.id)) {
    throw new DocumentError(`annotation ${annotation.id} is already in this document`);
  }
  const byId = new Map(document.annotations);
  byId.set(annotation.id, annotation);
  return { ...document, annotations: byId };
}

/** Replace one annotation whole, keeping its place in the draw order. Never creates. */
export function replaceScanAnnotation(document: ScanDocument, annotation: ScanAnnotation): ScanDocument {
  requireOwnAsset(document.asset, annotation, "replace");
  if (!document.annotations.has(annotation.id)) {
    throw new DocumentError(`no annotation ${annotation.id} in this document`);
  }
  const byId = new Map(document.annotations);
  byId.set(annotation.id, annotation);
  return { ...document, annotations: byId };
}

/** Remove annotations by id, all or nothing. */
export function removeScanAnnotations(document: ScanDocument, ids: Iterable<string>): ScanDocument {
  const wanted = new Set(ids);
  const missing = [...wanted].filter((id) => !document.annotations.has(id));
  if (missing.length > 0) {
    throw new DocumentError(`no annotation ${missing.join(", ")} in this document, so nothing was removed`);
  }
  if (wanted.size === 0) return document;
  const byId = new Map(document.annotations);
  for (const id of wanted) byId.delete(id);
  return { ...document, annotations: byId };
}
