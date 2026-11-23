/**
 * The scan editor's effects, applied to an `AnnotatorStore<ScanDocument>` in
 * order. `stage` resolves the label against whatever is committed now and swaps
 * only its geometry, so an attribute edited mid-drag is not clobbered; a
 * geometry of the other kind than the label's stages nothing.
 */

import { documentCommand } from "../../state/commands";
import type { AnnotatorStore } from "../../state/store";
import {
  isCuboidScanAnnotation,
  isPolylineScanAnnotation,
  type Cuboid3DGeometry,
  type Polyline3DGeometry,
  type ScanAnnotation,
} from "../../types";
import type { ScanEffect } from "./machine";
import {
  addScanAnnotation,
  removeScanAnnotations,
  replaceScanAnnotation,
  type ScanDocument,
} from "./scanDocument";

export function runScanEffects(store: AnnotatorStore<ScanDocument>, effects: readonly ScanEffect[]): void {
  for (const effect of effects) {
    switch (effect.kind) {
      case "select":
        store.select(effect.selection);
        break;
      case "stage":
        store.stage((document) => {
          const annotation = document.annotations.get(effect.id);
          const staged = annotation === undefined ? null : withGeometry(annotation, effect.geometry);
          return staged === null ? document : replaceScanAnnotation(document, staged);
        });
        break;
      case "commit":
        store.commit(effect.label);
        break;
      case "discard":
        store.discard();
        break;
      case "add":
        store.execute(documentCommand<ScanDocument>(effect.label, (document) => addScanAnnotation(document, effect.annotation)));
        break;
      case "remove":
        store.execute(documentCommand<ScanDocument>(effect.label, (document) => removeScanAnnotations(document, effect.ids)));
        break;
      default:
        unreachable(effect);
    }
  }
}

function withGeometry(
  annotation: ScanAnnotation,
  geometry: Cuboid3DGeometry | Polyline3DGeometry,
): ScanAnnotation | null {
  if (geometry.type === "cuboid_3d") return isCuboidScanAnnotation(annotation) ? { ...annotation, geometry } : null;
  return isPolylineScanAnnotation(annotation) ? { ...annotation, geometry } : null;
}

function unreachable(value: never): never {
  throw new Error(`Expected code to be unreachable: ${JSON.stringify(value)}`);
}
