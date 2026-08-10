/**
 * The history: an ordered list of document snapshots with a cursor in it.
 *
 * A command is **one-way**. It says how to get from a document to the next one
 * and nothing about how to get back, because the document is immutable and the
 * way back is already in hand — the document that was there before. So an entry
 * keeps `before` and `after`, and both undo and redo are pointer swaps.
 *
 * ## Why `apply` runs exactly once, ever
 *
 * The scaffold this replaces re-ran `execute()` on redo, which is wrong here: a
 * drawn annotation gets a client-minted uuid v4 from `../ids.ts`, so a
 * create-command that mints inside
 * its own body produces a **different** annotation on redo. The selection keys on
 * the first id and would be left pointing at an annotation that no longer exists,
 * and a host correlating local ids with `AnnotationCreate` payloads would hold a
 * key nothing matches. Redoing a snapshot cannot have that bug: there is nothing
 * to re-run.
 *
 * It also means a command may close over whatever it likes — an injected id
 * factory, a clock, the pointer position — without any of it having to be
 * reproducible.
 *
 * ## The rejected alternative, and the case that decides it
 *
 * A pair of `apply`/`invert` functions retains no document per entry. But
 * inverting a delete has to put the annotation back **in its place in the draw
 * order**, and `addAnnotation` appends. So an inverting delete would have to
 * capture the removed annotations *and* their positions — a partial snapshot, plus
 * a positional-insert operation the document does not have — in order to save one
 * pointer. Draw-order equality after a full unwind is asserted in the property
 * test precisely because it is the assertion that design would fail.
 *
 * ## What the snapshots cost
 *
 * Consecutive entries share a document (`entries[i].after === entries[i + 1].before`),
 * so N commands retain N + 1 of them. The annotations themselves are shared by
 * reference — only the `Map` spine is copied — so the cost is roughly N × (number
 * of annotations) pointer slots: a thousand commands over two hundred annotations
 * is a few megabytes, and it is bounded by the session.
 *
 * There is deliberately **no cap**, because nothing has asked for one. If it ever
 * bites, the remedies are a bound on the entry count (dropping the oldest, which
 * makes the oldest `before` unreachable and therefore collectable) or a persistent
 * map with structural sharing. Written down here so that stays a choice.
 */

import type { AnnotationDocument } from "./document";

/**
 * One step in the history: a label, and how to get the next document.
 *
 * `apply` must be pure with respect to the document — it returns a new one and
 * mutates nothing — but it is free to close over anything else, because the log
 * calls it once and remembers the answer.
 */
export interface Command {
  /** Human-readable, for a menu item and for a test. E.g. `"move sign"`. */
  readonly label: string;
  apply(document: AnnotationDocument): AnnotationDocument;
}

interface LogEntry {
  readonly label: string;
  readonly before: AnnotationDocument;
  readonly after: AnnotationDocument;
}

/** The document history, and the current document with it. */
export class CommandLog {
  private readonly entries: LogEntry[] = [];
  /** How many entries are applied. Everything past it is the redo tail. */
  private cursor = 0;
  private current: AnnotationDocument;

  constructor(document: AnnotationDocument) {
    this.current = document;
  }

  /** The document as of the cursor. */
  get document(): AnnotationDocument {
    return this.current;
  }

  /** How many undos are available. Also the cursor's position. */
  get undoDepth(): number {
    return this.cursor;
  }

  /** How many redos are available — the length of the tail past the cursor. */
  get redoDepth(): number {
    return this.entries.length - this.cursor;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length;
  }

  /** The label `undo()` would reverse, or `null`. For a menu item. */
  get undoLabel(): string | null {
    return this.canUndo ? this.entries[this.cursor - 1].label : null;
  }

  /** The label `redo()` would re-apply, or `null`. */
  get redoLabel(): string | null {
    return this.canRedo ? this.entries[this.cursor].label : null;
  }

  /**
   * Run a command, append it, and drop the redo tail. Returns the new document.
   *
   * **A command that returns the document it was given is not history.** Nothing
   * happened, so there is nothing to undo, and an undo step that visibly does
   * nothing is the worst thing a history can hold. `removeAnnotations` with an
   * empty id list is the case that reaches this in practice.
   *
   * If `apply` throws, neither the document nor the log has moved: the tail is
   * truncated only after it has returned.
   */
  execute(command: Command): AnnotationDocument {
    const before = this.current;
    const after = command.apply(before);
    if (after === before) {
      return before;
    }
    this.entries.length = this.cursor;
    this.entries.push({ label: command.label, before, after });
    this.cursor = this.entries.length;
    this.current = after;
    return after;
  }

  /** Step back one entry. `false` if there is nothing to undo. */
  undo(): boolean {
    if (!this.canUndo) return false;
    this.cursor -= 1;
    this.current = this.entries[this.cursor].before;
    return true;
  }

  /** Step forward one entry. `false` if there is nothing to redo. */
  redo(): boolean {
    if (!this.canRedo) return false;
    this.current = this.entries[this.cursor].after;
    this.cursor += 1;
    return true;
  }
}
