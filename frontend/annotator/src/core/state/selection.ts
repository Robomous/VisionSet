/**
 * What the user has picked out: a set of annotation ids, held **beside** the
 * document and never inside it.
 *
 * Two decisions make everything else here fall out, and both are about undo.
 *
 * ## 1. Selection is not document state
 *
 * Commands transform the document; undo restores one. If selection lived in the
 * document it would be in that snapshot, so `Ctrl+Z` after a click would undo the
 * click — and a command log would fill with entries for looking at things. The
 * kernel has no notion of selection either: it is session state, like scroll
 * position, and it belongs where the document is not.
 *
 * ## 2. It is filtered on READ, never pruned on write
 *
 * A `Selection` may hold an id the document no longer has, and nothing corrects
 * it. `selectedAnnotations` resolves ids against the document at the moment it is
 * asked, so:
 *
 * - deleting a selected annotation stops it being yielded, with no bookkeeping;
 * - **undoing that delete yields it again**, still selected, also with no
 *   bookkeeping.
 *
 * An eager prune would have to be undone in step with the command log — the
 * coordination this design does not have and does not need. The cost is a set
 * that can carry stale ids: bounded by the session, invisible to a user, and
 * never wrong, because a uuid v4 is not reused. `compactSelection` is there for a
 * host that wants the hygiene, and calling it is optional by design.
 *
 * Selection surviving *reordering* and *edits* is the same mechanism: it keys on
 * ids, so it cannot notice iteration order, and `replaceAnnotation` keeps an
 * annotation's id and its place.
 */

import { annotationsInDrawOrder } from "./document";
import type { AnnotationDocument } from "./document";
import type { Annotation } from "../types";

/** The ids the user has picked. Immutable; every operation returns a new one. */
export type Selection = ReadonlySet<string>;

/** Nothing selected. Shared, and safe to share because it is never mutated. */
export const EMPTY_SELECTION: Selection = new Set<string>();

/** A selection of exactly these ids, in no particular order. */
export function selectionOf(ids: Iterable<string>): Selection {
  return new Set(ids);
}

/** Replace the selection with one id — a plain click. */
export function selectOnly(id: string): Selection {
  return new Set([id]);
}

/** Add one id, keeping the rest — a shift-click. */
export function selectAlso(selection: Selection, id: string): Selection {
  const next = new Set(selection);
  next.add(id);
  return next;
}

/** Drop one id, keeping the rest. */
export function deselect(selection: Selection, id: string): Selection {
  const next = new Set(selection);
  next.delete(id);
  return next;
}

/** Add the id if absent, drop it if present — a ctrl-click. */
export function toggleSelection(selection: Selection, id: string): Selection {
  return selection.has(id) ? deselect(selection, id) : selectAlso(selection, id);
}

/** Select nothing. */
export function clearSelection(): Selection {
  return EMPTY_SELECTION;
}

/** Every annotation the document currently holds. */
export function selectAll(document: AnnotationDocument): Selection {
  return new Set(document.annotations.keys());
}

/**
 * Whether an id is picked — which does **not** mean the document still holds it.
 *
 * Ask `selectedAnnotations` for what actually exists. This one answers the
 * question a toggle needs, and the distinction is the point of decision 2 above.
 */
export function isSelected(selection: Selection, id: string): boolean {
  return selection.has(id);
}

/**
 * The selected annotations that exist right now, in draw order.
 *
 * The resolution step, and the reason nothing has to prune. Draw order rather
 * than selection order because every consumer — a renderer painting handles, a
 * panel listing labels — wants the document's order, and a set has none anyway.
 */
export function selectedAnnotations(
  document: AnnotationDocument,
  selection: Selection,
): readonly Annotation[] {
  return annotationsInDrawOrder(document).filter((annotation) =>
    selection.has(annotation.id),
  );
}

/** How many selected annotations exist right now. */
export function selectedCount(
  document: AnnotationDocument,
  selection: Selection,
): number {
  return selectedAnnotations(document, selection).length;
}

/**
 * Drop ids the document no longer holds. **Optional, and lossy.**
 *
 * Lossy because it is what makes undo stop restoring a selection: compact after a
 * delete and undoing the delete brings the annotation back unselected. Offered
 * for a host that would rather bound the set than keep that behaviour — for
 * instance when swapping to a different asset, where the old ids will never
 * return and holding them is pure leak.
 */
export function compactSelection(
  selection: Selection,
  document: AnnotationDocument,
): Selection {
  const next = new Set<string>();
  for (const id of selection) {
    if (document.annotations.has(id)) {
      next.add(id);
    }
  }
  return next;
}
