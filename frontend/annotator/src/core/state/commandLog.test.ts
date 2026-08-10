/**
 * The history, driven over real documents.
 *
 * Grouped commands undo atomically — the "a group is one step" block. The redo
 * block holds the trap the whole design
 * exists to close: `apply` runs exactly once, so a command that mints an id
 * cannot mint a different one on the way back.
 */

import { describe, expect, it } from "vitest";

import { annotation, documentOf } from "./_sample";
import { CommandLog, type Command } from "./commandLog";
import {
  addAnnotationCommand,
  composeCommands,
  documentCommand,
  removeAnnotationsCommand,
  replaceAnnotationCommand,
} from "./commands";
import { annotationsInDrawOrder, type AnnotationDocument } from "./document";

const idsOf = (document: AnnotationDocument): readonly string[] =>
  annotationsInDrawOrder(document).map((a) => a.id);

describe("executing, undoing and redoing", () => {
  it("starts with a document and no history", () => {
    const log = new CommandLog(documentOf("a"));
    expect(idsOf(log.document)).toEqual(["a"]);
    expect(log.canUndo).toBe(false);
    expect(log.canRedo).toBe(false);
    expect(log.undoLabel).toBeNull();
    expect(log.redoLabel).toBeNull();
    expect(log.undo()).toBe(false);
    expect(log.redo()).toBe(false);
  });

  it("walks the document forward and back", () => {
    const log = new CommandLog(documentOf("a"));
    log.execute(addAnnotationCommand(annotation("b")));
    expect(idsOf(log.document)).toEqual(["a", "b"]);

    expect(log.undo()).toBe(true);
    expect(idsOf(log.document)).toEqual(["a"]);
    expect(log.redo()).toBe(true);
    expect(idsOf(log.document)).toEqual(["a", "b"]);
  });

  it("undoing a delete restores the annotation to its place in the draw order", () => {
    // The case that decided the design. An inverting delete would have to know
    // the position it is putting back, because `addAnnotation` appends — so the
    // annotation would return on top of everything instead of between its
    // neighbours, and an editor whose undo changes z-order fights its user.
    const log = new CommandLog(documentOf("a", "b", "c"));
    log.execute(removeAnnotationsCommand(["b"]));
    expect(idsOf(log.document)).toEqual(["a", "c"]);

    log.undo();
    expect(idsOf(log.document)).toEqual(["a", "b", "c"]);
  });

  it("reports what undo and redo would do, for a menu item", () => {
    const log = new CommandLog(documentOf("a"));
    log.execute(addAnnotationCommand(annotation("b")));
    expect(log.undoLabel).toBe("add sign");
    expect(log.redoLabel).toBeNull();

    log.undo();
    expect(log.undoLabel).toBeNull();
    expect(log.redoLabel).toBe("add sign");
  });

  it("counts the steps available in each direction", () => {
    const log = new CommandLog(documentOf());
    log.execute(addAnnotationCommand(annotation("a")));
    log.execute(addAnnotationCommand(annotation("b")));
    expect([log.undoDepth, log.redoDepth]).toEqual([2, 0]);

    log.undo();
    expect([log.undoDepth, log.redoDepth]).toEqual([1, 1]);
  });

  it("drops the redo tail when a new command arrives", () => {
    const log = new CommandLog(documentOf());
    log.execute(addAnnotationCommand(annotation("a")));
    log.undo();
    expect(log.canRedo).toBe(true);

    log.execute(addAnnotationCommand(annotation("b")));
    expect(log.canRedo).toBe(false);
    expect(log.redoDepth).toBe(0);
    expect(idsOf(log.document)).toEqual(["b"]);
  });
});

describe("redo replays a snapshot and never re-runs the command", () => {
  it("gives back the same annotation, id and all", () => {
    // The scaffold this replaces called `execute()` again on redo. A create
    // command mints a uuid, so redo would have produced a *different*
    // annotation — leaving the selection pointing at one that no longer exists,
    // and a host's local-id correlation holding a key nothing matches.
    let minted = 0;
    let applications = 0;
    const draw: Command = documentCommand("draw sign", (document) => {
      applications += 1;
      minted += 1;
      return addAnnotationCommand(annotation(`drawn-${minted}`)).apply(document);
    });

    const log = new CommandLog(documentOf());
    log.execute(draw);
    expect(idsOf(log.document)).toEqual(["drawn-1"]);

    log.undo();
    log.redo();
    expect(idsOf(log.document)).toEqual(["drawn-1"]);
    expect(applications).toBe(1);
    expect(minted).toBe(1);
  });
});

describe("a group is one step", () => {
  it("records one entry however many commands are in it", () => {
    const log = new CommandLog(documentOf("a"));
    log.execute(
      composeCommands("draw three", [
        addAnnotationCommand(annotation("b")),
        addAnnotationCommand(annotation("c")),
        addAnnotationCommand(annotation("d")),
      ]),
    );
    expect(idsOf(log.document)).toEqual(["a", "b", "c", "d"]);
    expect(log.undoDepth).toBe(1);
    expect(log.undoLabel).toBe("draw three");
  });

  it("undoes atomically — all of it, in one step", () => {
    const log = new CommandLog(documentOf("a", "b"));
    log.execute(
      composeCommands("replace the lot", [
        removeAnnotationsCommand(["a", "b"]),
        addAnnotationCommand(annotation("c")),
      ]),
    );
    expect(idsOf(log.document)).toEqual(["c"]);

    expect(log.undo()).toBe(true);
    expect(idsOf(log.document)).toEqual(["a", "b"]);
    expect(log.canUndo).toBe(false);
  });

  it("threads the document through its members, so one may build on the last", () => {
    const log = new CommandLog(documentOf());
    log.execute(
      composeCommands("add then move", [
        addAnnotationCommand(annotation("a", 0)),
        replaceAnnotationCommand(annotation("a", 99)),
      ]),
    );
    expect(annotationsInDrawOrder(log.document)[0].geometry).toEqual(
      annotation("a", 99).geometry,
    );
  });

  it("leaves the document and the log untouched when a member throws", () => {
    // Exception safety is free here: `execute` assigns and appends only after
    // `apply` has returned, so a half-applied group cannot exist.
    const log = new CommandLog(documentOf("a"));
    const before = log.document;

    expect(() =>
      log.execute(
        composeCommands("half a group", [
          addAnnotationCommand(annotation("b")),
          removeAnnotationsCommand(["nobody"]),
        ]),
      ),
    ).toThrow(/nobody/);

    expect(log.document).toBe(before);
    expect(log.canUndo).toBe(false);
    expect(log.undoDepth).toBe(0);
  });
});

describe("a command that changed nothing is not history", () => {
  it("is not recorded", () => {
    // An undo step that visibly does nothing is the worst thing a history can
    // hold. `removeAnnotations([])` returns the document it was given, which is
    // how this case arises without anybody writing a deliberate no-op.
    const log = new CommandLog(documentOf("a"));
    const before = log.document;

    expect(log.execute(removeAnnotationsCommand([]))).toBe(before);
    expect(log.canUndo).toBe(false);
    expect(log.undoDepth).toBe(0);
  });

  it("does not disturb a redo tail either", () => {
    const log = new CommandLog(documentOf("a"));
    log.execute(addAnnotationCommand(annotation("b")));
    log.undo();

    log.execute(composeCommands("nothing at all", []));
    expect(log.canRedo).toBe(true);
    expect(log.redoLabel).toBe("add sign");
  });
});
