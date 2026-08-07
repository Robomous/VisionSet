/**
 * The interpreter: what each action does to a real store, a real host and the
 * machine.
 *
 * A real `AnnotatorStore` rather than a double, because three of the claims here
 * are about the store's own behaviour — that an identity command still drops a
 * staged preview, that `selectAll` on an empty document would notify for nothing,
 * and that a subscriber's `AggregateError` comes back out. A double would let
 * every one of them pass while being wrong.
 *
 * Two tests are the reason this file is worth its length, and neither reads as a
 * happy path: **draw, undo, Delete** must not throw, because `selection.ts` keeps
 * stale ids on purpose and `removeAnnotations` refuses them; and **Delete with
 * nothing selected must not drop a drag in flight**, because `store.execute`
 * clears the preview whether or not the command changed anything.
 */

import { describe, expect, it, vi } from "vitest";

import { createClipboard } from "../interaction/clipboard";
import type { Clipboard } from "../interaction/clipboard";
import { tagsFor } from "../interaction/tags";
import { addAnnotationCommand } from "../state/commands";
import { annotationsInDrawOrder } from "../state/document";
import { EMPTY_SELECTION, selectOnly, selectionOf } from "../state/selection";
import {
  A_BOX,
  A_TAG,
  EMPTY_SCHEMA,
  annotationOf,
  counter,
  paletteStore,
  recordingHost,
} from "./_palette";
import { RESET_ZOOM } from "./actions";
import type { Action } from "./actions";
import { runAction } from "./runAction";
import type { ActionContext } from "./runAction";
import type { AnnotatorStore } from "../state/store";
import type { RecordingHost } from "./_palette";

const BOX = annotationOf("a1", "sign", A_BOX);
const OTHER = annotationOf("a2", "sign", A_BOX);

/**
 * A context over a store and a host, with a counting mint and a fresh clipboard.
 *
 * The offset is **10 asset pixels** and stated rather than derived: this file is
 * about what an action does, and `assetTolerances` would put a zoom into every
 * assertion for no gain. `tolerance.test.ts` owns the conversion.
 */
function contextOver(
  store: AnnotatorStore,
  host: RecordingHost = recordingHost(),
  clipboard: Clipboard = createClipboard(),
): ActionContext & { host: RecordingHost; clipboard: Clipboard } {
  return { store, host, mint: counter(), clipboard, pasteOffset: OFFSET };
}

/** The paste displacement every assertion below is written against. */
const OFFSET = 10;

const NOTHING_SENT = { changed: false, events: [] };

describe("send", () => {
  it("hands the intent back for the machine and touches the store not at all", () => {
    const store = paletteStore([BOX]);
    const cancel: Action = { kind: "send", event: { type: "cancel" } };
    expect(runAction(cancel, contextOver(store))).toEqual({
      changed: true,
      events: [{ type: "cancel" }],
    });
    expect(store.canUndo).toBe(false);
    expect(store.selection).toBe(EMPTY_SELECTION);
  });

  it("carries commit the same way", () => {
    const store = paletteStore();
    expect(runAction({ kind: "send", event: { type: "commit" } }, contextOver(store)))
      .toEqual({ changed: true, events: [{ type: "commit" }] });
  });
});

describe("undo and redo", () => {
  it("report nothing done on an empty history", () => {
    const store = paletteStore([BOX]);
    expect(runAction({ kind: "undo" }, contextOver(store))).toEqual(NOTHING_SENT);
    expect(runAction({ kind: "redo" }, contextOver(store))).toEqual(NOTHING_SENT);
  });

  it("step the log and send the machine nothing", () => {
    const store = paletteStore();
    store.execute(addAnnotationCommand(BOX));
    expect(runAction({ kind: "undo" }, contextOver(store))).toEqual({
      changed: true,
      events: [],
    });
    expect(annotationsInDrawOrder(store.document)).toEqual([]);
    expect(runAction({ kind: "redo" }, contextOver(store))).toEqual({
      changed: true,
      events: [],
    });
    expect(annotationsInDrawOrder(store.document)).toEqual([BOX]);
  });
});

describe("delete-selection", () => {
  it("removes the selected annotations as one entry", () => {
    const store = paletteStore([BOX, OTHER]);
    store.select(selectOnly(BOX.id));
    expect(runAction({ kind: "delete-selection" }, contextOver(store))).toEqual({
      changed: true,
      events: [],
    });
    expect(annotationsInDrawOrder(store.document)).toEqual([OTHER]);
    expect(store.getSnapshot().undoLabel).toBe("delete 1 annotation");
  });

  it("does not throw when the selection holds an id the document lost — draw, undo, Delete", () => {
    const store = paletteStore();
    store.execute(addAnnotationCommand(BOX));
    store.select(selectOnly(BOX.id));
    store.undo();
    expect(store.selection.has(BOX.id)).toBe(true);
    expect(() =>
      runAction({ kind: "delete-selection" }, contextOver(store)),
    ).not.toThrow();
    expect(runAction({ kind: "delete-selection" }, contextOver(store))).toEqual(
      NOTHING_SENT,
    );
  });

  it("deletes only the ids that still resolve, and ignores the rest", () => {
    const store = paletteStore([BOX]);
    store.select(selectionOf([BOX.id, "gone"]));
    expect(runAction({ kind: "delete-selection" }, contextOver(store)).changed).toBe(true);
    expect(annotationsInDrawOrder(store.document)).toEqual([]);
  });

  it("does not drop a drag in flight when nothing is selected", () => {
    const store = paletteStore([BOX]);
    store.stage((document) => document);
    expect(store.preview).not.toBeNull();
    expect(runAction({ kind: "delete-selection" }, contextOver(store))).toEqual(
      NOTHING_SENT,
    );
    expect(store.preview).not.toBeNull();
  });
});

describe("select-all", () => {
  it("picks everything and leaves the history where it was", () => {
    const store = paletteStore([BOX, OTHER]);
    expect(runAction({ kind: "select-all" }, contextOver(store))).toEqual({
      changed: true,
      events: [],
    });
    expect([...store.selection].sort()).toEqual([BOX.id, OTHER.id]);
    expect(store.canUndo).toBe(false);
  });

  it("notifies nobody on an empty document, because a fresh empty Set is still a change", () => {
    const store = paletteStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(runAction({ kind: "select-all" }, contextOver(store))).toEqual(NOTHING_SENT);
    expect(listener).not.toHaveBeenCalled();
    expect(store.selection).toBe(EMPTY_SELECTION);
  });
});

describe("copy-selection", () => {
  it("puts the resolved selection on the clipboard and changes no document", () => {
    const store = paletteStore([BOX, OTHER]);
    store.select(selectOnly(BOX.id));
    const context = contextOver(store);
    expect(runAction({ kind: "copy-selection" }, context)).toEqual({
      changed: true,
      events: [],
    });
    expect(context.clipboard.read()).toEqual([
      { label_class: "sign", geometry: A_BOX, attributes: {} },
    ]);
    expect(store.canUndo).toBe(false);
    expect(annotationsInDrawOrder(store.document)).toHaveLength(2);
  });

  it("resolves through the document, so a stale id copies nothing at all", () => {
    // The `delete-selection` guard, from the other side: `selection.ts` keeps ids
    // the document no longer holds, on purpose, and reading the raw set here
    // would put an annotation that does not exist onto the clipboard.
    const store = paletteStore();
    store.select(selectOnly("never-existed"));
    const context = contextOver(store);
    expect(runAction({ kind: "copy-selection" }, context)).toEqual(NOTHING_SENT);
    expect(context.clipboard.read()).toEqual([]);
  });

  it("leaves an existing clipboard alone when nothing is selected", () => {
    // Not "copies nothing", which would be the same program: overwriting with an
    // empty list would make a stray `mod+c` on empty canvas silently discard what
    // was copied on the previous frame, and a clipboard is the one piece of state
    // a user cannot see.
    const held = [{ label_class: "sign", geometry: A_BOX, attributes: {} }];
    const clipboard = createClipboard(held);
    const store = paletteStore([BOX]);
    expect(
      runAction({ kind: "copy-selection" }, contextOver(store, recordingHost(), clipboard)),
    ).toEqual(NOTHING_SENT);
    expect(clipboard.read()).toEqual(held);
  });
});

describe("paste", () => {
  /** A clipboard holding one `sign` box at `A_BOX`. */
  function loaded(): Clipboard {
    return createClipboard([{ label_class: "sign", geometry: A_BOX, attributes: {} }]);
  }

  it("adds the copy offset, selects it, and records exactly one history entry", () => {
    const store = paletteStore([BOX]);
    const context = contextOver(store, recordingHost(), loaded());
    expect(runAction({ kind: "paste" }, context)).toEqual({ changed: true, events: [] });

    const drawn = annotationsInDrawOrder(store.document);
    expect(drawn).toHaveLength(2);
    const copy = drawn[1];
    expect(copy.geometry).toEqual({ type: "bbox", x: 20, y: 30, width: 30, height: 40 });
    expect(copy.id).not.toBe(BOX.id);
    expect(copy.label_class).toBe("sign");
    // Selected, so the very next thing a user does is drag it somewhere.
    expect([...store.selection]).toEqual([copy.id]);
    // One entry for the whole paste, and one undo takes all of it back.
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(annotationsInDrawOrder(store.document)).toHaveLength(1);
    expect(store.canUndo).toBe(false);
  });

  it("is one entry however many annotations it pastes", () => {
    const store = paletteStore();
    const clipboard = createClipboard([
      { label_class: "sign", geometry: A_BOX, attributes: {} },
      {
        label_class: "sign",
        geometry: { type: "bbox", x: 200, y: 200, width: 10, height: 10 },
        attributes: {},
      },
    ]);
    runAction({ kind: "paste" }, contextOver(store, recordingHost(), clipboard));
    expect(annotationsInDrawOrder(store.document)).toHaveLength(2);
    store.undo();
    expect(annotationsInDrawOrder(store.document)).toHaveLength(0);
  });

  it("cascades a repeated paste rather than stacking copies on one spot", () => {
    const store = paletteStore([BOX]);
    const context = contextOver(store, recordingHost(), loaded());
    runAction({ kind: "paste" }, context);
    runAction({ kind: "paste" }, context);
    const drawn = annotationsInDrawOrder(store.document);
    expect(drawn.map((one) => (one.geometry.type === "bbox" ? one.geometry.x : -1))).toEqual([
      10, 20, 30,
    ]);
  });

  it("does nothing at all with an empty clipboard", () => {
    const store = paletteStore([BOX]);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(runAction({ kind: "paste" }, contextOver(store))).toEqual(NOTHING_SENT);
    expect(listener).not.toHaveBeenCalled();
  });

  it("executes nothing when every entry is a tag the asset already carries", () => {
    // `tags.ts`'s invariant, and the reason it matters here: the kernel now
    // refuses a duplicate outright (#121), so a paste that looked like it worked
    // would refuse the whole save minutes later, blaming an index.
    const tag = annotationOf("t1", "weather", A_TAG);
    const store = paletteStore([tag]);
    const clipboard = createClipboard([
      { label_class: "weather", geometry: A_TAG, attributes: {} },
    ]);
    expect(
      runAction({ kind: "paste" }, contextOver(store, recordingHost(), clipboard)),
    ).toEqual(NOTHING_SENT);
    expect(tagsFor(store.document, "weather")).toHaveLength(1);
    expect(store.canUndo).toBe(false);
  });
});

describe("activate-class", () => {
  it("sends tool-changed when the derived tool moved", () => {
    const context = contextOver(paletteStore(), recordingHost(null));
    expect(
      runAction({ kind: "activate-class", labelClass: "sign" }, context),
    ).toEqual({ changed: true, events: [{ type: "tool-changed" }] });
    expect(context.host.activated).toEqual(["sign"]);
    expect(context.host.activeClass).toBe("sign");
  });

  it("does NOT send tool-changed when one bbox class replaces another", () => {
    const context = contextOver(paletteStore(), recordingHost("sign"));
    expect(runAction({ kind: "activate-class", labelClass: "stop" }, context)).toEqual({
      changed: true,
      events: [],
    });
    expect(context.host.activated).toEqual(["stop"]);
  });

  it("sends tool-changed when bbox gives way to polygon", () => {
    const context = contextOver(paletteStore(), recordingHost("sign"));
    expect(runAction({ kind: "activate-class", labelClass: "lane" }, context)).toEqual({
      changed: true,
      events: [{ type: "tool-changed" }],
    });
  });

  it("puts null into select mode, and never refuses it", () => {
    const context = contextOver(
      paletteStore([], EMPTY_SCHEMA),
      recordingHost("whatever"),
    );
    expect(runAction({ kind: "activate-class", labelClass: null }, context).changed).toBe(
      true,
    );
    expect(context.host.activeClass).toBeNull();
  });

  it("refuses a class the schema does not declare, rather than manufacturing an orphan", () => {
    const context = contextOver(paletteStore(), recordingHost("sign"));
    expect(runAction({ kind: "activate-class", labelClass: "unicorn" }, context)).toEqual(
      NOTHING_SENT,
    );
    expect(context.host.activated).toEqual([]);
    expect(context.host.activeClass).toBe("sign");
  });

  it("activates a class no annotation can carry, leaving the palette to explain", () => {
    const context = contextOver(paletteStore(), recordingHost(null));
    expect(runAction({ kind: "activate-class", labelClass: "pose" }, context)).toEqual({
      changed: true,
      events: [],
    });
    expect(context.host.activeClass).toBe("pose");
  });
});

describe("toggle-tag", () => {
  const TOGGLE: Action = { kind: "toggle-tag", labelClass: "weather" };

  it("tags the asset, and tells the machine nothing", () => {
    const store = paletteStore();
    expect(runAction(TOGGLE, contextOver(store))).toEqual({ changed: true, events: [] });
    expect(tagsFor(store.document, "weather")).toHaveLength(1);
    expect(store.getSnapshot().undoLabel).toBe("tag weather");
  });

  it("never touches the active class, so a tag hotkey cannot cancel a drawing", () => {
    const context = contextOver(paletteStore(), recordingHost("lane"));
    runAction(TOGGLE, context);
    expect(context.host.activated).toEqual([]);
    expect(context.host.activeClass).toBe("lane");
  });

  it("pressed twice, returns to untagged in two history entries", () => {
    const store = paletteStore();
    const context = contextOver(store);
    runAction(TOGGLE, context);
    runAction(TOGGLE, context);
    expect(tagsFor(store.document, "weather")).toEqual([]);
    expect(store.getSnapshot().undoLabel).toBe("untag weather");
    store.undo();
    expect(tagsFor(store.document, "weather")).toHaveLength(1);
  });

  it("refuses a class that is not tagged and not taggable", () => {
    const store = paletteStore();
    expect(
      runAction({ kind: "toggle-tag", labelClass: "sign" }, contextOver(store)),
    ).toEqual(NOTHING_SENT);
    expect(store.canUndo).toBe(false);
  });

  it("still clears an orphan tag the schema no longer sanctions", () => {
    const orphan = annotationOf("t1", "sign", { type: "classification_tag" });
    const store = paletteStore([orphan]);
    expect(
      runAction({ kind: "toggle-tag", labelClass: "sign" }, contextOver(store)).changed,
    ).toBe(true);
    expect(tagsFor(store.document, "sign")).toEqual([]);
  });
});

describe("host", () => {
  it("passes the name through and reports what the host answered", () => {
    const yes = contextOver(paletteStore(), recordingHost(null, () => true));
    expect(runAction({ kind: "host", name: RESET_ZOOM }, yes)).toEqual({
      changed: true,
      events: [],
    });
    expect(yes.host.ran).toEqual([RESET_ZOOM]);

    const no = contextOver(paletteStore(), recordingHost(null, () => false));
    expect(runAction({ kind: "host", name: "toggle-help" }, no)).toEqual(NOTHING_SENT);
    expect(no.host.ran).toEqual(["toggle-help"]);
  });
});

describe("what it does not catch", () => {
  it("lets a subscriber's AggregateError out, the way runEffects does", () => {
    const store = paletteStore([BOX]);
    store.subscribe(() => {
      throw new Error("a renderer threw");
    });
    expect(() => runAction({ kind: "select-all" }, contextOver(store))).toThrow(
      AggregateError,
    );
  });

  it("refuses an action kind it has no case for", () => {
    const bogus = { kind: "nudge" } as unknown as Action;
    expect(() => runAction(bogus, contextOver(paletteStore()))).toThrow(TypeError);
  });
});
