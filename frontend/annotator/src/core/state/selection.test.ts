/**
 * Selection, and acceptance criterion 1 of #40: it survives undo/redo.
 *
 * The undo/redo block drives the **real** `CommandLog` rather than simulating
 * one, because the claim is about how the two pieces sit together: commands
 * transform documents, selection is never in the snapshot, and resolution happens
 * on read. A test that swapped documents by hand would prove the shape of this
 * file and nothing about the pairing.
 *
 * `#39` will replace these ad-hoc closures with real commands. The behaviour
 * asserted here is what it has to keep.
 */

import { describe, expect, it } from "vitest";

import type { Annotation, AnnotationSchema, AssetDescriptor } from "../types";
import { CommandLog, type Command } from "./commandLog";
import {
  addAnnotation,
  annotationsInDrawOrder,
  createDocument,
  removeAnnotations,
  replaceAnnotation,
  type AnnotationDocument,
} from "./document";
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

const ASSET: AssetDescriptor = { id: "asset-1", width: 640, height: 480 };
const SCHEMA: AnnotationSchema = {
  project_id: "project-1",
  version: 1,
  classes: [{ name: "sign", geometry: "bbox", color: "#ff0000", attributes: [] }],
};

function annotation(id: string, x = 0): Annotation {
  return {
    id,
    asset_id: ASSET.id,
    label_class: "sign",
    schema_version: 1,
    geometry: { type: "bbox", x, y: 0, width: 10, height: 10 },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
  };
}

function documentOf(...ids: readonly string[]): AnnotationDocument {
  return createDocument(ASSET, SCHEMA, ids.map((id) => annotation(id)));
}

/**
 * A command over a document held in a closure — the smallest thing that makes
 * `CommandLog` operate on real state. #39 owns the real ones.
 */
function editing(
  hold: { document: AnnotationDocument },
  label: string,
  apply: (document: AnnotationDocument) => AnnotationDocument,
): Command {
  let before: AnnotationDocument;
  return {
    label,
    execute: () => {
      before = hold.document;
      hold.document = apply(hold.document);
    },
    undo: () => {
      hold.document = before;
    },
  };
}

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
    const hold = { document: documentOf("a", "b", "c") };
    const log = new CommandLog();
    const selection = selectionOf(["a", "c"]);
    const picked = () => selectedAnnotations(hold.document, selection).map((a) => a.id);

    expect(picked()).toEqual(["a", "c"]);
    log.execute(
      editing(hold, "move a", (document) => replaceAnnotation(document, annotation("a", 50))),
    );
    expect(picked()).toEqual(["a", "c"]);
    expect(log.undo()).toBe(true);
    expect(picked()).toEqual(["a", "c"]);
    expect(log.redo()).toBe(true);
    expect(picked()).toEqual(["a", "c"]);
  });

  it("restores a deleted annotation to the selection with no bookkeeping", () => {
    // The whole reason resolution happens on read. The id never left the set, so
    // undoing the delete makes it resolve again — and nothing anywhere had to
    // coordinate a prune with the command log to achieve it.
    const hold = { document: documentOf("a", "b") };
    const log = new CommandLog();
    const selection = selectionOf(["a", "b"]);
    const picked = () => selectedAnnotations(hold.document, selection).map((a) => a.id);

    log.execute(editing(hold, "delete a", (document) => removeAnnotations(document, ["a"])));
    expect(picked()).toEqual(["b"]);

    expect(log.undo()).toBe(true);
    expect(picked()).toEqual(["a", "b"]);

    expect(log.redo()).toBe(true);
    expect(picked()).toEqual(["b"]);
  });

  it("survives a long run of commands and a full unwind", () => {
    // #39's property test in miniature, from the selection's side: whatever the
    // log does to the document, the selection at the end is the selection at the
    // start, because it was never in the log.
    const hold = { document: documentOf("a", "b") };
    const log = new CommandLog();
    const selection = selectionOf(["a", "b"]);
    const picked = () => selectedAnnotations(hold.document, selection).map((a) => a.id);

    log.execute(editing(hold, "add c", (d) => addAnnotation(d, annotation("c"))));
    log.execute(editing(hold, "delete b", (d) => removeAnnotations(d, ["b"])));
    log.execute(editing(hold, "move a", (d) => replaceAnnotation(d, annotation("a", 5))));
    expect(picked()).toEqual(["a"]);

    while (log.undo()) {
      /* unwind everything */
    }
    expect(annotationsInDrawOrder(hold.document).map((a) => a.id)).toEqual(["a", "b"]);
    expect(picked()).toEqual(["a", "b"]);
  });

  it("does not put a selection change into the log", () => {
    // Selection is not a command. If it were, Ctrl+Z after a click would undo the
    // click and the log would fill with entries for looking at things.
    const log = new CommandLog();
    let selection = selectionOf(["a"]);
    selection = selectAlso(selection, "b");
    expect(log.canUndo).toBe(false);
    expect([...selection].sort()).toEqual(["a", "b"]);
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
    const hold = { document: documentOf("a", "b") };
    const log = new CommandLog();
    let selection = selectionOf(["a", "b"]);

    log.execute(editing(hold, "delete a", (d) => removeAnnotations(d, ["a"])));
    selection = compactSelection(selection, hold.document);
    log.undo();

    expect(annotationsInDrawOrder(hold.document).map((a) => a.id)).toEqual(["a", "b"]);
    expect(selectedAnnotations(hold.document, selection).map((a) => a.id)).toEqual(["b"]);
  });

  it("leaves a selection the document fully holds alone", () => {
    const document = documentOf("a", "b");
    expect([...compactSelection(selectionOf(["a", "b"]), document)].sort()).toEqual([
      "a",
      "b",
    ]);
  });
});
