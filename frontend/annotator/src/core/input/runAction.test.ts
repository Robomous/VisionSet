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

import { tagsFor } from "../interaction/tags";
import { addAnnotationCommand } from "../state/commands";
import { annotationsInDrawOrder } from "../state/document";
import { EMPTY_SELECTION, selectOnly, selectionOf } from "../state/selection";
import {
  A_BOX,
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

/** A context over a store and a host, with a counting mint. */
function contextOver(
  store: AnnotatorStore,
  host: RecordingHost = recordingHost(),
): ActionContext & { host: RecordingHost } {
  return { store, host, mint: counter() };
}

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
    expect(runAction({ kind: "activate-class", labelClass: "rail" }, context)).toEqual({
      changed: true,
      events: [],
    });
    expect(context.host.activeClass).toBe("rail");
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
