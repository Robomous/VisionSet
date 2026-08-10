/**
 * What a turn asks the store to do: seven verbs, as data.
 *
 * ## Data, not closures — and testability is the whole argument
 *
 * The obvious design is `{ kind: "stage", project: Projection }` and
 * `{ kind: "execute", command: Command }`, because that is the currency
 * `AnnotatorStore` already takes. It is the wrong call.
 *
 * The transition table has to be *exercised by tests*. With a closure, the only
 * assertion a table row can make about a
 * pointer-move is `typeof effects[0].project === "function"` — which is worth
 * nothing — or "run the closure against a document and inspect the result",
 * which drags a store into every test that was supposed to be about a
 * transition. With data the row *is* the table:
 *
 * ```ts
 * expect(effects).toEqual([
 *   { kind: "stage", id: "a", geometry: { type: "bbox", x: 40, y: 12, width: 30, height: 20 } },
 * ]);
 * ```
 *
 * That is also what lets a scripted event sequence assert exact geometry for a
 * draw, a move or a resize — with no store, no
 * document round-trip and no adapter. And the geometry maths runs *inside* the
 * pure transition, where a test is looking at it, rather than later inside the
 * store where none is.
 *
 * Two more consequences worth naming. The machine's authority over the document
 * becomes a closed, reviewable list of seven verbs, where a closure-carrying
 * effect would grant it arbitrary document rewriting. And the cost, stated: a
 * runner is now mandatory (`runEffects.ts`), and this union has to grow when a
 * tool needs a verb it does not have. The second is a feature.
 *
 * ## `stage` carries a geometry, not an annotation
 *
 * `AnnotatorStore.stage` hands its projection the **committed** document every
 * time, which is what makes a drag idempotent per pointer-move. So the runner
 * resolves the annotation against whatever is committed *now* and swaps only its
 * geometry. Handing `stage` a whole pre-built annotation would freeze the other
 * eight fields at gesture start and quietly clobber, say, an attribute edited
 * from a panel while the drag was in flight.
 *
 * ## Ordering
 *
 * Effects apply in the order they are listed, and two rules constrain what a
 * turn may list. `add` comes before `select`, because a selection is resolved
 * against a document that has to hold the annotation. And nothing is ever staged
 * *after* a log verb in the same turn: `execute`, `commit`, `undo` and `redo`
 * all drop the preview first, so a `stage` behind one would be discarded or
 * would describe a document that no longer exists. `runEffects.test.ts` pins
 * both.
 */

import type { Selection } from "../state/selection";
import type { Annotation, Geometry } from "../types";

/** One instruction from a turn to the store. */
export type Effect =
  /** Pick these ids. Never in the history — `AnnotatorStore.select`. */
  | { readonly kind: "select"; readonly selection: Selection }
  /**
   * Preview this annotation with this geometry. The drag in flight; writes
   * nothing to the document and does not move `canUndo`.
   */
  | { readonly kind: "stage"; readonly id: string; readonly geometry: Geometry }
  /** Turn the preview into exactly one history entry. Pointer-up. */
  | { readonly kind: "commit"; readonly label: string }
  /** Drop the preview. A cancel, and the revert v1 could not do. */
  | { readonly kind: "discard" }
  /** Add a new annotation as one history entry. A finished draw. */
  | { readonly kind: "add"; readonly annotation: Annotation }
  /** Replace one whole as one history entry. A vertex inserted or removed. */
  | { readonly kind: "replace"; readonly annotation: Annotation }
  /** Remove annotations as one history entry. All or nothing. */
  | { readonly kind: "remove"; readonly ids: readonly string[] };

/** Every effect's discriminant, read off the union. */
export type EffectKind = Effect["kind"];

/** A turn that asked for nothing. Shared; the array is frozen by `readonly`. */
export const NO_EFFECTS: readonly Effect[] = [];
