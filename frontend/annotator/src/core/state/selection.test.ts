/**
 * Selection, and acceptance criterion 1 of #40: it survives undo/redo.
 *
 * The undo/redo block drives the **real** `CommandLog` rather than simulating
 * one, because the claim is about how the two pieces sit together: commands
 * transform documents, selection is never in the snapshot, and resolution happens
 * on read. A test that swapped documents by hand would prove the shape of this
 * file and nothing about the pairing.
 *
 * #39 has since replaced the ad-hoc closures this file used to carry with the
 * real store and the real commands. Every assertion below is the one it inherited.
 */

import { describe, expect, it } from "vitest";

import { annotation, documentOf } from "./_sample";
import {
  addAnnotationCommand,
  removeAnnotationsCommand,
  replaceAnnotationCommand,
} from "./commands";
import {
  annotationsInDrawOrder,
  removeAnnotations,
  replaceAnnotation,
} from "./document";
import { AnnotatorStore } from "./store";
import {
  EMPTY_SELECTION,
  clearSelection,
  compactSelection,
  deselect,
  isSelected,
  selectAll,
  selectAlso,
  selectOnly,
  selectedAnnotations,
  selectedCount,
  selectionOf,
  toggleSelection,
} from "./selection";

describe("picking things", () => {
  it("starts empty", () => {
    expect(EMPTY_SELECTION.size).toBe(0);
    expect(selectedAnnotations(documentOf("a"), EMPTY_SELECTION)).toEqual([]);
  });

  it("replaces on a plain click and adds on a shift-click", () => {
    expect([...selectOnly("a")]).toEqual(["a"]);
    expect([...selectAlso(selectOnly("a"), "b")].sort()).toEqual(["a", "b"]);
    expect([...selectOnly("b")]).toEqual(["b"]);
  });

  it("toggles one id without touching the others", () => {
    const both = selectionOf(["a", "b"]);
    expect([...toggleSelection(both, "a")]).toEqual(["b"]);
    expect([...toggleSelection(toggleSelection(both, "a"), "a")].sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("deselects, clears and selects everything", () => {
    const document = documentOf("a", "b", "c");
    expect([...deselect(selectionOf(["a", "b"]), "a")]).toEqual(["b"]);
    expect(clearSelection().size).toBe(0);
    expect([...selectAll(document)].sort()).toEqual(["a", "b", "c"]);
  });

  it("never mutates the selection it was given", () => {
    const before = selectionOf(["a"]);
    selectAlso(before, "b");
    deselect(before, "a");
    toggleSelection(before, "c");
    expect([...before]).toEqual(["a"]);
  });

  it("resolves to annotations in draw order, not selection order", () => {
    // Every consumer — handles on a canvas, a list in a panel — wants the
    // document's order, and a set does not have one to offer anyway.
    const document = documentOf("c", "a", "b");
    const picked = selectedAnnotations(document, selectionOf(["b", "c"]));
    expect(picked.map((a) => a.id)).toEqual(["c", "b"]);
  });
});

describe("selection is not document state", () => {
  it("keys on ids, so it cannot notice the order annotations arrived in", () => {
    const one = documentOf("a", "b", "c");
    const other = documentOf("c", "b", "a");
    const selection = selectionOf(["a", "c"]);
    expect(new Set(selectedAnnotations(one, selection).map((a) => a.id))).toEqual(
      new Set(selectedAnnotations(other, selection).map((a) => a.id)),
    );
  });

  it("is unmoved by an edit to a selected annotation", () => {
    const before = documentOf("a", "b");
    const selection = selectionOf(["a"]);
    const after = replaceAnnotation(before, annotation("a", 99));
    expect(selectedAnnotations(after, selection).map((a) => a.id)).toEqual(["a"]);
    expect(selectedAnnotations(after, selection)[0].geometry).toEqual(
      annotation("a", 99).geometry,
    );
  });

  it("distinguishes 'picked' from 'still there'", () => {
    // `isSelected` answers what a toggle needs; `selectedAnnotations` answers what
    // exists. Collapsing the two is what would force an eager prune.
    const document = removeAnnotations(documentOf("a", "b"), ["a"]);
    const selection = selectionOf(["a"]);
    expect(isSelected(selection, "a")).toBe(true);
    expect(selectedAnnotations(document, selection)).toEqual([]);
    expect(selectedCount(document, selection)).toBe(0);
  });
});

describe("across undo and redo", () => {
  it("survives an edit, its undo and its redo untouched", () => {
    const store = new AnnotatorStore(documentOf("a", "b", "c"), selectionOf(["a", "c"]));
    const picked = () =>
      selectedAnnotations(store.document, store.selection).map((a) => a.id);

    expect(picked()).toEqual(["a", "c"]);
    store.execute(replaceAnnotationCommand(annotation("a", 50)));
    expect(picked()).toEqual(["a", "c"]);
    expect(store.undo()).toBe(true);
    expect(picked()).toEqual(["a", "c"]);
    expect(store.redo()).toBe(true);
    expect(picked()).toEqual(["a", "c"]);
  });

  it("restores a deleted annotation to the selection with no bookkeeping", () => {
    // The whole reason resolution happens on read. The id never left the set, so
    // undoing the delete makes it resolve again — and nothing anywhere had to
    // coordinate a prune with the command log to achieve it.
    const store = new AnnotatorStore(documentOf("a", "b"), selectionOf(["a", "b"]));
    const picked = () =>
      selectedAnnotations(store.document, store.selection).map((a) => a.id);

    store.execute(removeAnnotationsCommand(["a"]));
    expect(picked()).toEqual(["b"]);

    expect(store.undo()).toBe(true);
    expect(picked()).toEqual(["a", "b"]);

    expect(store.redo()).toBe(true);
    expect(picked()).toEqual(["b"]);
  });

  it("survives a long run of commands and a full unwind", () => {
    // #39's property test in miniature, from the selection's side: whatever the
    // log does to the document, the selection at the end is the selection at the
    // start, because it was never in the log.
    const store = new AnnotatorStore(documentOf("a", "b"), selectionOf(["a", "b"]));
    const picked = () =>
      selectedAnnotations(store.document, store.selection).map((a) => a.id);

    store.execute(addAnnotationCommand(annotation("c")));
    store.execute(removeAnnotationsCommand(["b"]));
    store.execute(replaceAnnotationCommand(annotation("a", 5)));
    expect(picked()).toEqual(["a"]);

    while (store.undo()) {
      /* unwind everything */
    }
    expect(annotationsInDrawOrder(store.document).map((a) => a.id)).toEqual(["a", "b"]);
    expect(picked()).toEqual(["a", "b"]);
  });

  it("does not put a selection change into the log", () => {
    // Selection is not a command. If it were, Ctrl+Z after a click would undo the
    // click and the log would fill with entries for looking at things.
    const store = new AnnotatorStore(documentOf("a", "b"), selectionOf(["a"]));
    store.select(selectAlso(store.selection, "b"));

    expect(store.canUndo).toBe(false);
    expect([...store.selection].sort()).toEqual(["a", "b"]);
  });
});

describe("compacting, which is optional because it is lossy", () => {
  it("drops ids the document no longer holds", () => {
    const document = removeAnnotations(documentOf("a", "b"), ["a"]);
    expect([...compactSelection(selectionOf(["a", "b"]), document)]).toEqual(["b"]);
  });

  it("is what makes undo stop restoring a selection", () => {
    // Stated as a test so the trade-off is not discovered by surprise: compacting
    // after a delete is exactly what forfeits the previous block's behaviour.
    const store = new AnnotatorStore(documentOf("a", "b"), selectionOf(["a", "b"]));

    store.execute(removeAnnotationsCommand(["a"]));
    store.select(compactSelection(store.selection, store.document));
    store.undo();

    expect(annotationsInDrawOrder(store.document).map((a) => a.id)).toEqual(["a", "b"]);
    expect(selectedAnnotations(store.document, store.selection).map((a) => a.id)).toEqual([
      "b",
    ]);
  });

  it("leaves a selection the document fully holds alone", () => {
    const document = documentOf("a", "b");
    expect([...compactSelection(selectionOf(["a", "b"]), document)].sort()).toEqual([
      "a",
      "b",
    ]);
  });
});
