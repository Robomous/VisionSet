/**
 * What the pointer is in the middle of: seven states, reconciled against v1's
 * nine and addressed by id rather than by array index.
 *
 * v1 modelled this well and then kept it inside a 1413-line React component,
 * where the union was one `useState` among a dozen and half of what belonged in
 * it lived in a parent hook instead. Moving it here is the whole of #42; the
 * reconciliation below is the part that is a decision rather than a transcription.
 *
 * ## v1's nine, and what became of each
 *
 * | v1 variant | here | why |
 * | --- | --- | --- |
 * | `null` | `idle` | A variant, not an absence — see below. |
 * | `drawing-bbox {start, current}` | `drawing-bbox`, plus `labelClass` | |
 * | *(none — a parent hook's `Point[]`)* | `drawing-polygon` | Promoted into the union. |
 * | `moving-bbox {index, last}` | `moving` | `index` → `id`; `last` → `startGeometry`. |
 * | `moving-polygon {index, last, captured}` | `moving` | Folded; `captured` was DOM. |
 * | `moving-polygon-vertex {index, vertexIndex}` | `moving-vertex` | `vertexIndex` stays. |
 * | `resizing-bbox {index, handle, startBbox}` | `resizing` | v1 got this one right. |
 * | `moving-keypoint` | — | `keypoints` has no `Geometry` variant. |
 * | `moving-polyline`, `moving-polyline-vertex` | — | Nor does `polyline`. |
 * | `panning-canvas {intent, …}` | `pressing-empty` | Split; the pan half left core. |
 *
 * ## `idle` is a variant, not `null`
 *
 * v1's state was `InteractionState | null`, which meant every read was
 * `interaction?.type === …` and "idle" was unnameable in a `switch`. As a
 * variant it becomes a key like any other, and that is what lets `machine.ts`
 * type its table as a **total** mapped type over `InteractionState["type"]`: a
 * state added to this union without a row there is a compile error at the table,
 * not a case somebody forgot.
 *
 * ## Identity is an id, and `vertexIndex` is not identity
 *
 * Every v1 variant naming an annotation carried `index: number` — the epic's
 * "original sin", and the reason a deletion mid-drag silently retargeted the
 * drag onto whichever annotation had slid into that slot. Each is a `string` id
 * here. `vertexIndex` legitimately stays positional: a vertex *is* its position
 * within a polygon, and there is nothing else to name it by.
 *
 * ## Every drag carries the geometry it began on
 *
 * v1 kept `last: Point` and accumulated deltas. That shape is not merely
 * unnecessary here, it is wrong: `AnnotatorStore.stage` re-projects the
 * **committed** document on every pointer-move, and `moveBbox`/`resizeBbox`/
 * `translatePolygon`/`movePolygonVertex` are all absolute in a start geometry.
 * Holding `startGeometry` is what makes a pointer-move idempotent, so a dropped
 * or doubled move cannot drift and a gesture that returns to where it began
 * returns the shape to where it began.
 *
 * It is also what makes the staleness guard in `machine.ts` possible: comparing
 * `startGeometry.type` against what the document holds now is how an undo landing
 * mid-drag is noticed instead of throwing out of a pointer handler.
 *
 * ## `captured` was DOM, and dies
 *
 * v1's `moving-polygon` and `moving-polyline` carried `captured: boolean`,
 * tracking whether `svg.setPointerCapture` had been called yet — deferred,
 * because acquiring capture on pointer-down suppresses the native `dblclick`.
 * Pointer capture is the adapter's (#47). Nothing here knows the pointer has an
 * id, let alone that it can be captured.
 *
 * ## There is no `panning`, and #47 owes a contract for it
 *
 * Four of v1's five `panning-canvas` fields were `startClientX/Y` and
 * `startScrollLeft/Top` — viewport coordinates and DOM scroll state — and its
 * pointer-move wrote `scrollLeft` straight to a node. Pan and zoom belong to the
 * adapter by #47's own issue body, and `tolerance.ts` is the only module in
 * `src/core/` allowed to name a zoom. A `panning` marker carrying nothing would
 * exist solely so an adapter could suppress hit-testing during a pan, which it
 * achieves by **not forwarding the events**.
 *
 * So the contract, stated here because it is the one thing an adapter could get
 * wrong invisibly: *while panning or pinching, the adapter does not forward
 * pointer events to the machine; if a gesture was in flight when the pan began,
 * it sends `pointer-cancel` first.*
 *
 * The other half of v1's ninth variant does survive. Its
 * `intent: "tentative-deselect"` deferred the click-to-deselect to pointer-up so
 * that a *drag* starting on empty canvas did not deselect, and that is
 * `pressing-empty`. Deselecting on pointer-down instead would be a visible
 * regression the moment #47 maps left-drag on empty canvas to a pan.
 *
 * ## There is no `selecting` either
 *
 * The issue's list names a marquee. v1 has none, no M4 issue asks for one, and
 * building one here would be inventing a feature inside a chassis task. It is
 * named rather than omitted: it would be `pressing-empty` grown a `current:
 * Point` and a `select` effect over everything the rectangle intersects, and the
 * state it grows from is already here.
 *
 * ## A press on a shape is a drag immediately, and needs no threshold
 *
 * `pressing-empty` is the only state that resolves click-versus-drag, because it
 * is the only one where the two mean different things. A press on a shape enters
 * `moving` at once: nothing is written until a pointer-move stages something, and
 * a press-and-release with no move commits a preview that never existed, which
 * `AnnotatorStore.commit` answers `false` to and does not record.
 */

import type { BboxHandle } from "../geometry/bbox";
import type { BboxGeometry, Point, PolygonGeometry } from "../types";

/** Every shape a drag can be moving. A tag has no coordinates to move. */
export type MovableGeometry = BboxGeometry | PolygonGeometry;

/** What the pointer is in the middle of. Seven variants; `idle` is one of them. */
export type InteractionState =
  /** Nothing in flight. The state a cancel of any kind reaches. */
  | { readonly type: "idle" }
  /**
   * The pointer went down on empty canvas and has not come up. Resolves on
   * release: a short press clears the selection, a long one was a drag (a pan,
   * as far as the adapter is concerned) and leaves it alone.
   */
  | { readonly type: "pressing-empty"; readonly startPoint: Point }
  /**
   * A box being dragged out. `start` and `current` are the rubber band, and they
   * are *state* rather than an effect: no annotation exists yet, so there is
   * nothing in the document to stage a preview of.
   *
   * `labelClass` is captured at the press so that a class hotkey arriving
   * mid-drag cannot retarget the shape being drawn.
   */
  | {
      readonly type: "drawing-bbox";
      readonly labelClass: string;
      readonly start: Point;
      readonly current: Point;
    }
  /**
   * A polygon being built click by click. `points` is v1's pending buffer, which
   * lived outside its union and caused the Escape-precedence bug `machine.ts`
   * describes; `cursor` is the rubber-band endpoint, `null` before the pointer
   * has moved.
   */
  | {
      readonly type: "drawing-polygon";
      readonly labelClass: string;
      readonly points: readonly Point[];
      readonly cursor: Point | null;
    }
  /** A whole shape being dragged. Both geometries, one variant. */
  | {
      readonly type: "moving";
      readonly id: string;
      readonly startGeometry: MovableGeometry;
      readonly startPoint: Point;
    }
  /** A box being resized by one of its eight grips. */
  | {
      readonly type: "resizing";
      readonly id: string;
      readonly handle: BboxHandle;
      readonly startGeometry: BboxGeometry;
    }
  /** One polygon vertex being dragged. The only edit that changes a shape. */
  | {
      readonly type: "moving-vertex";
      readonly id: string;
      readonly vertexIndex: number;
      readonly startGeometry: PolygonGeometry;
    };

/** Every state's discriminant, read off the union by `machine.ts`'s table. */
export type InteractionStateType = InteractionState["type"];

/**
 * Nothing in flight. Shared, and safe to share because the state is immutable —
 * the same reasoning as `EMPTY_SELECTION`.
 *
 * `machine.ts` returns this exact object from every cancel, so a test asserting
 * `toBe(IDLE)` is asserting that the machine reached idle and not merely that it
 * built something idle-shaped.
 */
export const IDLE: InteractionState = { type: "idle" };
