/**
 * The scan editor's effects, applied to an `AnnotatorStore<ScanDocument>` in
 * order. `stage` resolves the box against whatever is committed now and swaps
 * only its geometry, so an attribute edited mid-drag is not clobbered.
 */

import { documentCommand } from "../../state/commands";
import type { AnnotatorStore } from "../../state/store";
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
          return annotation === undefined
            ? document
            : replaceScanAnnotation(document, { ...annotation, geometry: effect.geometry });
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

function unreachable(value: never): never {
  throw new Error(`Expected code to be unreachable: ${JSON.stringify(value)}`);
}
