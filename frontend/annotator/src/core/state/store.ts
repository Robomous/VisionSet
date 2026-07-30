/**
 * The store: the document, its history, the selection beside it, and the drag
 * that has not happened yet — behind one subscription.
 *
 * Framework-free by construction, not by convention: this file is inside
 * `src/core/`, so it may not import React and may not name a browser global. What
 * it exposes is the shape a renderer needs and no more — `subscribe` returning an
 * unsubscribe, and `getSnapshot` returning a value whose **identity** changes only
 * when something changed.
 *
 * ## The staging area, and why a drag writes nothing
 *
 * v1 re-rendered on every pointer-move because every pointer-move wrote to the
 * document. Here a drag calls `stage`, which holds a **preview** document outside
 * the log; `rendered` is what a canvas paints and follows the pointer, while
 * `document` — the committed truth — is untouched and `canUndo` does not move.
 * Pointer-up calls `commit`, which turns the preview into exactly one entry.
 * Escape calls `discard`, which turns it into none.
 *
 * A projection is always applied to the **committed** document, never to the
 * previous preview. A drag is therefore idempotent per pointer-move: the tool
 * re-projects from where the gesture began instead of accumulating deltas, so a
 * dropped or a doubled move cannot drift.
 *
 * It follows that any log operation drops the preview first. A preview is a
 * projection *of the committed document*, so once that document moves the preview
 * describes nothing.
 *
 * ## Selection is here, and it is still not in the log
 *
 * #40 put the selection beside the document rather than inside it. "Beside" means
 * inside the same subscribable container — a renderer painting shapes and their
 * handles wants one subscription, not two — and it still means outside the
 * history: `select` notifies subscribers and leaves `canUndo` exactly where it
 * was. Undoing a delete restores the annotation to the selection for free, because
 * `selectedAnnotations` resolves ids against whatever document is current.
 *
 * ## The snapshot's identity is load-bearing
 *
 * React's `useSyncExternalStore` — what #47's adapter will use — calls
 * `getSnapshot` on every render and compares the result with `Object.is`. A store
 * that built a fresh object per call would re-render forever. So the snapshot is
 * cached and rebuilt only after something has actually changed. Designed in one
 * task before the adapter exists, and pinned by a test, because the failure mode
 * is an infinite loop in somebody else's component.
 */

import { CommandLog } from "./commandLog";
import type { Command } from "./commandLog";
import { documentCommand } from "./commands";
import type { AnnotationDocument } from "./document";
import { EMPTY_SELECTION } from "./selection";
import type { Selection } from "./selection";

/** Everything a renderer reads, in one value with one identity. */
export interface StoreSnapshot {
  /** The committed document. What a save would send. */
  readonly document: AnnotationDocument;
  /** The drag in flight, or `null`. Never in the history. */
  readonly preview: AnnotationDocument | null;
  /** `preview ?? document` — what a canvas paints. */
  readonly rendered: AnnotationDocument;
  /** The picked ids. Beside the document, never in the history. */
  readonly selection: Selection;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
}

/** A transient view of the committed document — what a drag renders as. */
export type Projection = (document: AnnotationDocument) => AnnotationDocument;

/** The engine's state container. One per open asset. */
export class AnnotatorStore {
  private readonly log: CommandLog;
  private readonly listeners = new Set<() => void>();
  private staged: AnnotationDocument | null = null;
  private picked: Selection;
  private snapshot: StoreSnapshot | null = null;

  constructor(document: AnnotationDocument, selection: Selection = EMPTY_SELECTION) {
    this.log = new CommandLog(document);
    this.picked = selection;
  }

  /**
   * Everything, in one value. Stable while nothing changes — see the note above.
   */
  getSnapshot(): StoreSnapshot {
    if (this.snapshot === null) {
      const document = this.log.document;
      this.snapshot = {
        document,
        preview: this.staged,
        rendered: this.staged ?? document,
        selection: this.picked,
        canUndo: this.log.canUndo,
        canRedo: this.log.canRedo,
        undoLabel: this.log.undoLabel,
        redoLabel: this.log.redoLabel,
      };
    }
    return this.snapshot;
  }

  /** The committed document. */
  get document(): AnnotationDocument {
    return this.getSnapshot().document;
  }

  /** What a canvas paints: the drag in flight if there is one, else the document. */
  get rendered(): AnnotationDocument {
    return this.getSnapshot().rendered;
  }

  /** The drag in flight, or `null`. */
  get preview(): AnnotationDocument | null {
    return this.getSnapshot().preview;
  }

  /** The picked ids. */
  get selection(): Selection {
    return this.getSnapshot().selection;
  }

  get canUndo(): boolean {
    return this.getSnapshot().canUndo;
  }

  get canRedo(): boolean {
    return this.getSnapshot().canRedo;
  }

  /**
   * Listen for any change. Returns the unsubscribe.
   *
   * The listener takes no arguments and is handed nothing: it reads
   * `getSnapshot()` when it wants to, which is the contract
   * `useSyncExternalStore` expects and the one that keeps a slow subscriber from
   * holding a stale value it was pushed.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Run a command and record it. Drops any drag in flight first.
   *
   * Subscribers hear nothing when a command changed nothing and there was no
   * drag to drop — the same rule that keeps such a command out of the history.
   */
  execute(command: Command): void {
    const had = this.staged !== null;
    this.staged = null;
    const before = this.log.document;
    const after = this.log.execute(command);
    if (after !== before || had) this.changed();
  }

  /** Step back one command. `false` if there was nothing to undo. */
  undo(): boolean {
    return this.travel(() => this.log.undo());
  }

  /** Step forward one command. `false` if there was nothing to redo. */
  redo(): boolean {
    return this.travel(() => this.log.redo());
  }

  /**
   * Pick a set of ids. Notifies, and never touches the history.
   *
   * Takes a whole `Selection` rather than offering add/remove/toggle methods:
   * `selection.ts` already has those as pure functions, and a second spelling
   * living on the store would be free to disagree with them.
   */
  select(selection: Selection): void {
    if (selection === this.picked) return;
    this.picked = selection;
    this.changed();
  }

  /**
   * Show what the document *would* look like, without committing anything.
   *
   * `project` receives the committed document every time, not the previous
   * preview. Calling it again replaces the preview; it never stacks.
   */
  stage(project: Projection): void {
    const next = project(this.log.document);
    if (next === this.staged) return;
    this.staged = next;
    this.changed();
  }

  /**
   * Turn the drag in flight into one history entry. Pointer-up.
   *
   * Returns whether an entry was recorded: a gesture that ended where it started
   * produced the document it began from, and `CommandLog.execute` does not record
   * a command that changed nothing.
   */
  commit(label: string): boolean {
    const staged = this.staged;
    if (staged === null) return false;
    this.staged = null;
    const before = this.log.document;
    // The projection already ran, against this very document. The command is
    // the answer it produced — and since `apply` is called exactly once, a
    // constant function is an honest command rather than a shortcut.
    const after = this.log.execute(documentCommand(label, () => staged));
    this.changed();
    return after !== before;
  }

  /** Drop the drag in flight. Escape. `false` if there was none. */
  discard(): boolean {
    if (this.staged === null) return false;
    this.staged = null;
    this.changed();
    return true;
  }

  private travel(move: () => boolean): boolean {
    const had = this.staged !== null;
    this.staged = null;
    const moved = move();
    if (moved || had) this.changed();
    return moved;
  }

  /**
   * Invalidate the snapshot and tell everyone.
   *
   * Every listener runs even if an earlier one threw, and nothing is swallowed:
   * the failures come back as one `AggregateError` once they have all had their
   * turn. That is the kernel `InProcessEventBus`'s log-and-continue posture
   * adapted to a layer that **has no logger** — `console` is not nameable inside
   * `src/core/` — and in a browser a silently dropped exception is worse than a
   * loud one.
   *
   * The listener set is copied first, so subscribing or unsubscribing from inside
   * a listener is safe.
   */
  private changed(): void {
    this.snapshot = null;
    const failures: unknown[] = [];
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} annotator store subscriber(s) threw`,
      );
    }
  }
}
