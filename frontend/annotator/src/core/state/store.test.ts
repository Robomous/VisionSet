/**
 * The store: one subscription over the document, its history, the selection and
 * the drag that has not happened yet.
 *
 * Acceptance criterion 3 of #39 — no document mutation during a simulated drag
 * until release — is the "a drag writes nothing until release" block, and it is
 * asserted by reference (`toBe`) rather than by value: the claim is that the
 * committed document *is the same object*, not merely that it looks the same.
 */

import { describe, expect, it } from "vitest";

import { annotation, documentOf } from "./_sample";
import {
  addAnnotationCommand,
  removeAnnotationsCommand,
  replaceAnnotationCommand,
} from "./commands";
import {
  annotationById,
  annotationsInDrawOrder,
  replaceAnnotation,
  type AnnotationDocument,
} from "./document";
import { selectedAnnotations, selectionOf } from "./selection";
import { AnnotatorStore } from "./store";

const idsOf = (document: AnnotationDocument): readonly string[] =>
  annotationsInDrawOrder(document).map((a) => a.id);

/** Where the sample annotation's box sits — what a drag moves. */
function xOf(document: AnnotationDocument, id: string): number {
  const found = annotationById(document, id);
  if (found?.geometry.type !== "bbox") throw new Error(`no bbox ${id}`);
  return found.geometry.x;
}

/** A drag step: the document as it would be with `a` moved to `x`. */
const movedTo =
  (x: number) =>
  (document: AnnotationDocument): AnnotationDocument =>
    replaceAnnotation(document, annotation("a", x));

describe("reading the store", () => {
  it("starts on the document it was given, with nothing picked or staged", () => {
    const document = documentOf("a", "b");
    const store = new AnnotatorStore(document);

    expect(store.document).toBe(document);
    expect(store.rendered).toBe(document);
    expect(store.preview).toBeNull();
    expect(store.selection.size).toBe(0);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
  });

  it("accepts a selection to start from", () => {
    const store = new AnnotatorStore(documentOf("a", "b"), selectionOf(["b"]));
    expect([...store.selection]).toEqual(["b"]);
  });

  it("hands back the same snapshot object while nothing changes", () => {
    // Load-bearing rather than an optimization. React's `useSyncExternalStore`
    // — #47's adapter — calls this on every render and compares with `Object.is`,
    // so a store building a fresh object per call re-renders forever.
    const store = new AnnotatorStore(documentOf("a"));
    const first = store.getSnapshot();

    expect(store.getSnapshot()).toBe(first);
    expect(store.document).toBe(first.document);

    store.execute(addAnnotationCommand(annotation("b")));
    const second = store.getSnapshot();
    expect(second).not.toBe(first);
    expect(store.getSnapshot()).toBe(second);
  });

  it("leaves the old snapshot describing the old state", () => {
    // It is a value, not a view. A subscriber that kept one is holding history,
    // not a stale pointer into the present.
    const store = new AnnotatorStore(documentOf("a"));
    const before = store.getSnapshot();

    store.execute(addAnnotationCommand(annotation("b")));
    expect(idsOf(before.document)).toEqual(["a"]);
    expect(idsOf(store.document)).toEqual(["a", "b"]);
  });
});

describe("subscribing", () => {
  it("tells everyone about every kind of change", () => {
    const store = new AnnotatorStore(documentOf("a"));
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });

    store.execute(addAnnotationCommand(annotation("b")));
    expect(heard).toBe(1);
    store.undo();
    expect(heard).toBe(2);
    store.redo();
    expect(heard).toBe(3);
    store.select(selectionOf(["a"]));
    expect(heard).toBe(4);
    store.stage(movedTo(5));
    expect(heard).toBe(5);
    store.commit("move sign");
    expect(heard).toBe(6);
    store.stage(movedTo(9));
    store.discard();
    expect(heard).toBe(8);
  });

  it("stops when the returned function is called", () => {
    const store = new AnnotatorStore(documentOf("a"));
    let heard = 0;
    const stop = store.subscribe(() => {
      heard += 1;
    });

    store.execute(addAnnotationCommand(annotation("b")));
    stop();
    store.execute(addAnnotationCommand(annotation("c")));
    expect(heard).toBe(1);
  });

  it("says nothing when nothing changed", () => {
    const store = new AnnotatorStore(documentOf("a"));
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });

    store.undo();
    store.redo();
    store.discard();
    store.select(store.selection);
    store.execute(removeAnnotationsCommand([]));
    expect(heard).toBe(0);
  });

  it("lets a listener unsubscribe from inside a notification", () => {
    // The set is copied before it is walked, so a listener removing itself —
    // or anyone else — cannot make the loop skip a neighbour.
    const store = new AnnotatorStore(documentOf("a"));
    const heard: string[] = [];
    const stopFirst = store.subscribe(() => {
      heard.push("first");
      stopFirst();
    });
    store.subscribe(() => heard.push("second"));

    store.execute(addAnnotationCommand(annotation("b")));
    store.execute(addAnnotationCommand(annotation("c")));
    expect(heard).toEqual(["first", "second", "second"]);
  });

  it("runs every listener even when one throws, and does not swallow it", () => {
    // The kernel's event bus logs and carries on. Core has no logger — `console`
    // is not nameable inside src/core/ — so the failures come back as one
    // AggregateError once everyone has had their turn. Silence would be worse.
    const store = new AnnotatorStore(documentOf("a"));
    const heard: string[] = [];
    store.subscribe(() => {
      heard.push("first");
      throw new Error("first blew up");
    });
    store.subscribe(() => heard.push("second"));

    let caught: unknown;
    try {
      store.execute(addAnnotationCommand(annotation("b")));
    } catch (error) {
      caught = error;
    }

    expect(heard).toEqual(["first", "second"]);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(1);
    // The state moved regardless: the subscriber failed, not the command.
    expect(idsOf(store.document)).toEqual(["a", "b"]);
  });
});

describe("the selection is here, and still not in the history", () => {
  it("changes without adding anything to undo", () => {
    const store = new AnnotatorStore(documentOf("a", "b"));
    store.select(selectionOf(["a", "b"]));

    expect([...store.selection].sort()).toEqual(["a", "b"]);
    expect(store.canUndo).toBe(false);
  });

  it("gets a deleted annotation back when the delete is undone", () => {
    // #40's behaviour, now through the real store: nothing prunes, because
    // `selectedAnnotations` resolves ids against whatever document is current.
    const store = new AnnotatorStore(documentOf("a", "b"), selectionOf(["a", "b"]));
    const picked = () => selectedAnnotations(store.document, store.selection).map((x) => x.id);

    store.execute(removeAnnotationsCommand(["a"]));
    expect(picked()).toEqual(["b"]);

    store.undo();
    expect(picked()).toEqual(["a", "b"]);
  });
});

describe("a drag writes nothing until release", () => {
  it("moves what is rendered and leaves the document exactly where it was", () => {
    // Acceptance criterion 3. Ten pointer-moves, and the committed document is
    // the same object at the end as at the start — which is what kills v1's
    // write-and-re-render on every pointer-move.
    const store = new AnnotatorStore(documentOf("a", "b"));
    const before = store.document;

    for (let x = 1; x <= 10; x += 1) {
      store.stage(movedTo(x));
    }

    expect(store.document).toBe(before);
    expect(store.canUndo).toBe(false);
    expect(xOf(store.document, "a")).toBe(0);
    expect(xOf(store.rendered, "a")).toBe(10);
    expect(store.preview).toBe(store.rendered);
  });

  it("projects from the committed document, so moves cannot stack", () => {
    // Each stage re-projects from where the gesture began. A projection applied
    // to the previous preview would accumulate, and a doubled or dropped
    // pointer-move would silently change the result.
    const store = new AnnotatorStore(documentOf("a"));
    store.stage(movedTo(5));
    store.stage(movedTo(5));
    store.stage(movedTo(5));
    expect(xOf(store.rendered, "a")).toBe(5);
  });

  it("commits exactly one entry on release", () => {
    const store = new AnnotatorStore(documentOf("a"));
    const before = store.document;
    for (let x = 1; x <= 5; x += 1) store.stage(movedTo(x));

    expect(store.commit("move sign")).toBe(true);
    expect(store.preview).toBeNull();
    expect(xOf(store.document, "a")).toBe(5);
    expect(store.canUndo).toBe(true);

    store.undo();
    expect(store.document).toBe(before);
    expect(store.canUndo).toBe(false);
  });

  it("throws the drag away on discard", () => {
    const store = new AnnotatorStore(documentOf("a"));
    const before = store.document;
    store.stage(movedTo(7));

    expect(store.discard()).toBe(true);
    expect(store.document).toBe(before);
    expect(store.rendered).toBe(before);
    expect(store.preview).toBeNull();
    expect(store.canUndo).toBe(false);
  });

  it("records nothing for a gesture that ended where it started", () => {
    const store = new AnnotatorStore(documentOf("a"));
    store.stage((document) => document);

    expect(store.commit("move sign")).toBe(false);
    expect(store.canUndo).toBe(false);
  });

  it("commits nothing when there is no drag in flight", () => {
    const store = new AnnotatorStore(documentOf("a"));
    expect(store.commit("move sign")).toBe(false);
    expect(store.discard()).toBe(false);
    expect(store.canUndo).toBe(false);
  });

  it("drops the drag when the document moves under it", () => {
    // A preview is a projection *of the committed document*. Once that document
    // moves — a command, an undo, a redo — the preview describes nothing, so
    // holding it would paint a shape computed against a state that is gone.
    const store = new AnnotatorStore(documentOf("a"));
    store.execute(replaceAnnotationCommand(annotation("a", 1)));

    store.stage(movedTo(50));
    store.undo();
    expect(store.preview).toBeNull();
    expect(store.rendered).toBe(store.document);

    store.stage(movedTo(60));
    store.redo();
    expect(store.preview).toBeNull();

    store.stage(movedTo(70));
    store.execute(addAnnotationCommand(annotation("b")));
    expect(store.preview).toBeNull();
    expect(idsOf(store.document)).toEqual(["a", "b"]);
  });
});
