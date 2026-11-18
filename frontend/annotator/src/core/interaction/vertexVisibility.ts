/**
 * Marking a polyline vertex occluded: a panel edit, like a tag, with no canvas
 * gesture and no machine state. A host calls `store.execute(...)` with what this
 * returns, so the edit is one undo step.
 *
 * `null` means there is nothing to execute — no such annotation, not a polyline,
 * or already in that state. An identity command still drops a staged preview, so
 * a caller must not execute one.
 */

import { isVertexOccluded, setPolylineVertexOccluded } from "../geometry/polygon";
import type { Command } from "../state/commandLog";
import { replaceAnnotationCommand } from "../state/commands";
import { annotationById, type AnnotationDocument } from "../state/document";

export function setVertexOccludedCommand(
  document: AnnotationDocument,
  annotationId: string,
  index: number,
  occluded: boolean,
): Command | null {
  const annotation = annotationById(document, annotationId);
  if (annotation === undefined || annotation.geometry.type !== "polyline") return null;
  if (isVertexOccluded(annotation.geometry, index) === occluded) return null;
  return replaceAnnotationCommand({
    ...annotation,
    geometry: setPolylineVertexOccluded(annotation.geometry, index, occluded),
  });
}
