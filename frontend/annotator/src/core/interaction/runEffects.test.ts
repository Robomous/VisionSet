/**
 * The interpreter: seven effect kinds, the order they apply in, and what happens
 * when a subscriber throws in the middle.
 *
 * The last one is the reason this file exists rather than being folded into
 * `gestures.test.ts`. `AnnotatorStore.changed` runs every listener and then
 * raises one `AggregateError`, and **every** store mutator goes through it — so
 * a runner written as a plain loop would abort on the first bad subscriber and
 * leave the rest of a turn's effects unapplied, while the caller has already
 * adopted the machine's new state. The two would then disagree for the rest of
 * the session. Asserting "having applied every effect" is asserting that they
 * cannot.
 */

import { describe, expect, it } from "vitest";

import { documentOf, annotation } from "../state/_sample";
import { AnnotatorStore } from "../state/store";
import { selectOnly } from "../state/selection";
import { runEffects } from "./runEffects";
import type { Effect } from "./effects";

describe("what each effect asks the store for", () => {
  it("picks ids without touching the history", () => {
    const store = new AnnotatorStore(documentOf("a", "b"));
    runEffects(store, [{ kind: "select", selection: selectOnly("b") }]);
    expect([...store.selection]).toEqual(["b"]);
    expect(store.canUndo).toBe(false);
  });

  it("previews a geometry, leaving the committed document alone", () => {
    const store = new AnnotatorStore(documentOf("a"));
    const committed = store.document;
    runEffects(store, [
      { kind: "stage", id: "a", geometry: { type: "bbox", x: 50, y: 0, width: 10, height: 10 } },
    ]);
    expect(store.document).toBe(committed);
    expect(store.preview).toBe(store.rendered);
    expect(store.rendered.annotations.get("a")?.geometry).toEqual({
      type: "bbox",
      x: 50,
      y: 0,
      width: 10,
      height: 10,
    });
  });

  it("resolves the annotation inside the projection, not at effect time", () => {
    const store = new AnnotatorStore(documentOf("a"));
    // The projection runs against whatever is committed when the store calls it,
    // which is what makes a drag idempotent per pointer-move.
    runEffects(store, [
      { kind: "stage", id: "a", geometry: { type: "bbox", x: 50, y: 0, width: 10, height: 10 } },
    ]);
    runEffects(store, [
      { kind: "stage", id: "a", geometry: { type: "bbox", x: 90, y: 0, width: 10, height: 10 } },
    ]);
    expect(store.rendered.annotations.get("a")?.geometry).toEqual({
      type: "bbox",
      x: 90,
      y: 0,
      width: 10,
      height: 10,
    });
  });

  it("stages nothing rather than throwing when the id has gone", () => {
    const store = new AnnotatorStore(documentOf("a"));
    const committed = store.document;
    // `replaceAnnotation` refuses an unknown id, and this projection runs inside
    // a pointer handler — the window between a turn and its effects is exactly
    // where an undo can land.
    expect(() =>
      runEffects(store, [
        { kind: "stage", id: "gone", geometry: { type: "bbox", x: 1, y: 1, width: 1, height: 1 } },
      ]),
    ).not.toThrow();
    expect(store.rendered).toBe(committed);
  });

  it("turns a preview into one entry on commit, and drops it on discard", () => {
    const store = new AnnotatorStore(documentOf("a"));
    const staged: Effect = {
      kind: "stage",
      id: "a",
      geometry: { type: "bbox", x: 50, y: 0, width: 10, height: 10 },
    };
    runEffects(store, [staged, { kind: "commit", label: "move sign" }]);
    expect(store.getSnapshot().undoLabel).toBe("move sign");

    const committed = store.document;
    runEffects(store, [staged, { kind: "discard" }]);
    expect(store.document).toBe(committed);
    expect(store.preview).toBeNull();
  });

  it("records nothing for a commit with no preview behind it", () => {
    const store = new AnnotatorStore(documentOf("a"));
    runEffects(store, [{ kind: "commit", label: "move sign" }]);
    expect(store.canUndo).toBe(false);
  });

  it("adds, replaces and removes as one history entry each", () => {
    const store = new AnnotatorStore(documentOf("a"));
    runEffects(store, [{ kind: "add", annotation: annotation("b", 40) }]);
    expect(store.document.annotations.has("b")).toBe(true);

    runEffects(store, [{ kind: "replace", annotation: annotation("b", 99) }]);
    expect(store.document.annotations.get("b")?.geometry).toEqual({
      type: "bbox",
      x: 99,
      y: 0,
      width: 10,
      height: 10,
    });

    runEffects(store, [{ kind: "remove", ids: ["b"] }]);
    expect(store.document.annotations.has("b")).toBe(false);

    store.undo();
    store.undo();
    store.undo();
    expect(store.canUndo).toBe(false);
  });
});

describe("the order a turn's effects apply in", () => {
  it("adds before it picks, so the selection resolves against a document holding it", () => {
    const store = new AnnotatorStore(documentOf("a"));
    const drawn = annotation("new", 40);
    runEffects(store, [
      { kind: "add", annotation: drawn },
      { kind: "select", selection: selectOnly("new") },
    ]);
    expect(store.document.annotations.has("new")).toBe(true);
    expect([...store.selection]).toEqual(["new"]);
  });

  it("loses a preview staged behind a log verb, which is why no turn lists one", () => {
    const store = new AnnotatorStore(documentOf("a"));
    // `AnnotatorStore.execute` drops the preview first — a preview is a
    // projection of the committed document, so once that moves it describes
    // nothing. Stated here so the ordering rule has a witness rather than a
    // paragraph.
    runEffects(store, [
      { kind: "add", annotation: annotation("b", 40) },
      { kind: "stage", id: "a", geometry: { type: "bbox", x: 5, y: 0, width: 10, height: 10 } },
      { kind: "add", annotation: annotation("c", 60) },
    ]);
    expect(store.preview).toBeNull();
  });
});

describe("a subscriber that throws", () => {
  it("does not stop the rest of the turn, and comes back as one AggregateError", () => {
    const store = new AnnotatorStore(documentOf("a"));
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
      throw new Error(`listener ${heard}`);
    });

    let raised: unknown = null;
    try {
      runEffects(store, [
        { kind: "add", annotation: annotation("b", 40) },
        { kind: "select", selection: selectOnly("b") },
      ]);
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(AggregateError);
    expect((raised as AggregateError).errors).toHaveLength(2);
    // Both effects landed. A plain loop would have stopped after the first.
    expect(store.document.annotations.has("b")).toBe(true);
    expect([...store.selection]).toEqual(["b"]);
  });

  it("says nothing when every effect went through", () => {
    const store = new AnnotatorStore(documentOf("a"));
    expect(() => runEffects(store, [{ kind: "discard" }])).not.toThrow();
  });
});
