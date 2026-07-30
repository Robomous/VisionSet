/**
 * The table: what each of the seven states does with each of the eight events,
 * and what it asks the store for.
 *
 * `transition(state, event, context)` is a two-key lookup into `TRANSITIONS`
 * with one default — **no entry means the state is handed back unchanged, by
 * identity, with no effects.** That default is what makes "the table is the
 * whole of what happens" an assertion a test can make with `toBe`, and it is why
 * the rows below list only the squares that do something.
 *
 * ## The table is exported, and the tests read it
 *
 * `machine.test.ts` sweeps `TRANSITIONS` rather than restating it — the rule
 * `tests/kernel/test_batch_service.py` set for `BATCH_TRANSITIONS`: *"stated this
 * way rather than as a list of allowed pairs, so the test cannot drift from the
 * table — it reads it."* The outer mapped type is **total** over
 * `InteractionState["type"]`, so a state added to the union without a row here
 * is a compile error at the table, which is stronger than a runtime sweep and
 * arrives earlier.
 *
 * ## Why there is a context
 *
 * The issue's literal shape is `(state, event) -> [state, effects]`. Taking a
 * context is the one deviation, and it buys a single owner for the priority
 * order in `target.ts`: without it the caller would have to resolve "what is
 * under the pointer" first, which puts that order in #43 *and* in #47, free to
 * disagree.
 *
 * `mint` is in the context rather than reached for as a module global, so the
 * function stays pure with respect to its arguments and a test injects a counter
 * and gets a deterministic id — the pattern `core/ids.ts` describes. It is called
 * once per drawn annotation, at the moment the gesture finishes, never inside a
 * projection: `CommandLog.execute` runs `apply` exactly once ever, so the id is
 * never re-minted on redo either.
 *
 * `document` is the **committed** document, never `AnnotatorStore.rendered`.
 * Handing the machine the preview would make each pointer-move compute from the
 * last one, which is precisely the accumulating shape #41's absolute transforms
 * were built to avoid.
 *
 * ## The staleness guards
 *
 * `undo`, `redo` and delete-the-selection are deliberately not events (see
 * `events.ts`), so a host calls `store.undo()` straight through while a drag is
 * live — `Ctrl+Z` mid-drag is a real thing a user does. `AnnotatorStore` drops
 * the preview when that happens, but the machine would still be in `moving`, and
 * the next pointer-move would ask `replaceAnnotation` for an id the document no
 * longer holds, which throws `DocumentError` **out of a pointer handler**.
 *
 * So every drag state checks, before anything else: the annotation is still
 * there, its geometry is still the kind the gesture began on, and (for a vertex)
 * the vertex still exists. Any of those failing is a cancel — `idle`, plus a
 * `discard` that is harmless when there was nothing staged.
 *
 * ## A pointer-move that changes nothing asks for a discard, not a stage
 *
 * `AnnotatorStore.stage` builds a fresh `Map` every call, so a drag that ends
 * exactly where it began would commit a document that is value-equal and
 * reference-*un*equal — and `CommandLog.execute` compares by identity, so it
 * would record an undo step that visibly does nothing. One row prevents it.
 *
 * ## v1's Escape-precedence bug is unrepresentable here
 *
 * v1's Escape handler read: if the pending polygon is non-empty, clear it and
 * `return` — never reaching `setInteraction(null)`. A pending polygon plus an
 * in-flight interaction therefore left the interaction alive, and it was
 * reachable (a tool switch did not clear the pending buffer). With
 * `drawing-polygon` promoted into the union there is exactly one state at a time
 * and one cancel rule per state; there is no precedence to get wrong. Worth
 * saying out loud precisely because a fix that removes a possibility leaves
 * nothing to see.
 *
 * ## Cancel, per state
 *
 * | state | `cancel` | `pointer-cancel` | `tool-changed` |
 * | --- | --- | --- | --- |
 * | `idle` | clears the selection | — | — |
 * | `pressing-empty` | idle; selection untouched | same | same |
 * | `drawing-bbox` | idle; the rubber band goes | same | same |
 * | `drawing-polygon` | idle; **every** pending point dropped | **stays** | idle; dropped |
 * | `moving` / `resizing` / `moving-vertex` | idle + `discard` | same | same |
 *
 * Two rows are decisions.
 *
 * **`pointer-cancel` does not discard a drawing polygon.** Everywhere else it is
 * a synonym for `cancel`; here it is not, and the asymmetry is deliberate.
 * `pointer-cancel` means a *drag* was interrupted — capture lost, a window blur,
 * the adapter starting a pan — and a click-by-click polygon session is not a
 * drag. Wiping twelve placed vertices because the user alt-tabbed would be
 * indefensible.
 *
 * **`tool-changed` drops the pending points**, diverging from v1, which cleared
 * its pending buffers only when switching *to* select. So a half-drawn polygon
 * survived a switch to the bbox tool, where no gesture could add to it or close
 * it — a buffer outliving the tool that can reach it. Not ported.
 *
 * ## Closing a polygon, three ways
 *
 * A press on the first vertex, a double-click, or `commit` (#46 binds Enter). All
 * three go through `closeSession`, all three are gated at `MIN_POLYGON_POINTS`, and
 * all three produce exactly one `add` — so a session of any length is one undo step
 * whichever way it ended.
 *
 * Only the first is v1's. **v1 has no double-click close for polygons at all** —
 * that is its *polyline* gesture, driven by a hand-rolled 350 ms timer against a
 * `polylineLastClickTimeRef`. #73 put `polyline` out of scope, so the gesture is
 * unclaimed here, it is the idiom every other polygon tool uses, and #44's issue
 * body asks for it by name. It arrives as a real `double-click` event because
 * `events.ts` makes the adapter own that recognition, which is also what retires
 * v1's timer.
 *
 * ## A press while drawing: four rules, and the order is the rule
 *
 * 1. **Secondary** takes back the last pending vertex; taking back the only one
 *    returns to `idle`.
 * 2. **Inside the close ring** — `polygonCloseAttempt` — closes, or does nothing
 *    when there are too few points. Never appends.
 * 3. **On the vertex just placed** — within `tolerances.vertex` — is that vertex
 *    again. Never appends.
 * 4. Otherwise, a new vertex.
 *
 * ## Why the duplicate rule is load-bearing, and not hygiene
 *
 * Rule 3 reads like tidiness and is not: it is what makes rule-2-by-double-click
 * produce the polygon the user drew. An adapter delivers a `pointer-down` for
 * *each* click of a double-click before the `double-click` itself arrives, so
 * without rule 3 every double-click close would stack a duplicate vertex on top of
 * the one the first click had just placed. v1 never hit this because v1 had no
 * double-click close.
 *
 * It is also why the rule is a *tolerance* rather than an equality. Two clicks at
 * "the same place" differ by a pixel or two of hand tremor, so `===` would catch
 * almost none of them; `tolerances.vertex` is the same distance that decides
 * whether a press means an existing vertex, asked one layer earlier.
 *
 * What this does **not** do is refuse a degenerate polygon. Three collinear points,
 * or a sliver, still stores: the wire format accepts it, `polygonContains` answers
 * honestly about it, and rule 3 already guarantees every vertex is a visible
 * distance from its neighbour. There is no fourth screen-pixel constant here for
 * the reason `tolerance.ts`'s table gives — a number is worth adding when it answers
 * a question nobody else is answering, and this one has no question left.
 *
 * ## And the one thing v1 structurally could not do
 *
 * v1 wrote every pointer-move straight through to the shared annotations array,
 * so Escape from `moving-bbox`, `moving-polygon`, `resizing-bbox` or any vertex
 * drag returned to idle and **left the geometry wherever the drag had dragged
 * it**. There was nothing to revert to: the original was gone by the second
 * pointer-move. Only `drawing-bbox` genuinely discarded, and only because its
 * commit was deferred to pointer-up.
 *
 * Because #39's store stages instead, `discard` drops a preview that was only
 * ever a projection of an untouched committed document. **Escape now reverts a
 * drag to exactly where the gesture began, and `canUndo` never moved during
 * it.** `gestures.test.ts` pins it by reference rather than by value.
 */

import { isDrawnBox, moveBbox, normalizeBbox, resizeBbox } from "../geometry/bbox";
import {
  MIN_POLYGON_POINTS,
  insertPolygonVertex,
  movePolygonVertex,
  polygonBbox,
  removePolygonVertex,
  translatePolygon,
} from "../geometry/polygon";
import { polygonCloseAttempt } from "../geometry/hitTest";
import { clampPoint, distance } from "../geometry/primitives";
import type { Tolerances } from "../geometry/tolerance";
import type { IdFactory } from "../ids";
import { annotationById } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import { clearSelection, selectAlso, selectOnly, toggleSelection } from "../state/selection";
import type { Selection } from "../state/selection";
import type { Annotation, Geometry, Point } from "../types";
import { draftAnnotation } from "./draft";
import { NO_EFFECTS } from "./effects";
import type { Effect } from "./effects";
import { isToggleModifier } from "./events";
import type { InteractionEvent, InteractionEventType } from "./events";
import { IDLE } from "./state";
import type { InteractionState, InteractionStateType, MovableGeometry } from "./state";
import { nearestInsertion, resolveTarget } from "./target";
import type { Scene } from "./target";
import type { Tool } from "./tool";

/** Everything a transition needs that is not the state or the event. */
export interface InteractionContext {
  /** The **committed** document. Never the store's `rendered`. */
  readonly document: AnnotationDocument;
  readonly selection: Selection;
  /** Derived from the active class by `toolFor`, never stored. */
  readonly tool: Tool;
  /**
   * In the asset's own pixels. The adapter builds one per zoom change with
   * `assetTolerances`; the machine never names a viewport scale.
   */
  readonly tolerances: Tolerances;
  /** The class a drawing gesture will carry. `null` in select mode. */
  readonly labelClass: string | null;
  /** The id port. Called once per drawn annotation; never inside a projection. */
  readonly mint: IdFactory;
}

/** What a turn produced: the next state, and what to ask the store for. */
export interface Transition {
  readonly state: InteractionState;
  readonly effects: readonly Effect[];
}

/** One square of the table: a state, the event that arrived, and the context. */
export interface Turn<
  S extends InteractionState = InteractionState,
  E extends InteractionEvent = InteractionEvent,
> {
  readonly state: S;
  readonly event: E;
  readonly context: InteractionContext;
}

/** A handler narrowed to the one state and the one event its square holds. */
type Handler<K extends InteractionStateType, T extends InteractionEventType> = (
  turn: Turn<
    Extract<InteractionState, { type: K }>,
    Extract<InteractionEvent, { type: T }>
  >,
) => Transition;

/** One state's row. Partial: most squares are silent, and silence is the default. */
type Row<K extends InteractionStateType> = {
  readonly [T in InteractionEventType]?: Handler<K, T>;
};

/** A row with both narrowings erased — what the lookup in `transition` can see. */
type ErasedRow = Partial<Record<InteractionEventType, (turn: Turn) => Transition>>;

function stay(turn: Turn): Transition {
  return { state: turn.state, effects: NO_EFFECTS };
}

function idle(...effects: readonly Effect[]): Transition {
  return { state: IDLE, effects: effects.length === 0 ? NO_EFFECTS : effects };
}

function sceneOf(context: InteractionContext): Scene {
  return {
    document: context.document,
    selection: context.selection,
    tolerances: context.tolerances,
  };
}

/** The point, pushed inside the asset — where a *stored* coordinate comes from. */
function inFrame(context: InteractionContext, point: Point): Point {
  return clampPoint(point, context.document.asset);
}

/** Value equality for the two geometries a drag can produce. */
function geometryEquals(a: Geometry, b: Geometry): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "bbox" && b.type === "bbox") {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }
  if (a.type === "polygon" && b.type === "polygon") {
    return (
      a.points.length === b.points.length &&
      a.points.every((point, at) => point[0] === b.points[at][0] && point[1] === b.points[at][1])
    );
  }
  return true;
}

/**
 * The annotation a drag is holding, if it is still there and still the shape the
 * gesture began on. `null` is the cancel signal — see the staleness note above.
 */
function stillThere(
  context: InteractionContext,
  id: string,
  startGeometry: Geometry,
): Annotation | null {
  const annotation = annotationById(context.document, id);
  if (annotation === undefined) return null;
  if (annotation.geometry.type !== startGeometry.type) return null;
  return annotation;
}

/** Where a `moving` gesture has pushed the shape's top-left corner. */
function draggedOrigin(
  startGeometry: MovableGeometry,
  startPoint: Point,
  point: Point,
): Point {
  const extent = startGeometry.type === "bbox" ? startGeometry : polygonBbox(startGeometry);
  return [
    extent.x + (point[0] - startPoint[0]),
    extent.y + (point[1] - startPoint[1]),
  ];
}

/**
 * The one place a drag's answer becomes an effect.
 *
 * Staging a geometry equal to the committed one would leave a preview behind
 * that a `commit` then turns into a history entry changing nothing — see the
 * note above. Discarding instead is also what makes a gesture that wanders and
 * comes back leave `canUndo` where it found it.
 */
function stageOrDiscard(current: Annotation, next: Geometry): Transition["effects"] {
  if (geometryEquals(next, current.geometry)) return [{ kind: "discard" }];
  return [{ kind: "stage", id: current.id, geometry: next }];
}

/** A drag's three cancel rows, and the answer to a guard that failed. */
function abandonDrag(): Transition {
  return idle({ kind: "discard" });
}

/** Pointer-up on a drag: one history entry, or nothing if nothing moved. */
function commitDrag(context: InteractionContext, id: string, verb: string): Transition {
  const annotation = annotationById(context.document, id);
  const what = annotation === undefined ? "annotation" : annotation.label_class;
  return idle({ kind: "commit", label: `${verb} ${what}` });
}

/** A finished drawing gesture: one annotation, added and picked. */
function finishDrawing(
  context: InteractionContext,
  labelClass: string,
  geometry: Geometry,
): Transition {
  const drawn = draftAnnotation(context.document, labelClass, geometry, context.mint);
  // `add` before `select`: a selection is resolved against a document that has
  // to hold the annotation by the time anybody reads it.
  return idle({ kind: "add", annotation: drawn }, { kind: "select", selection: selectOnly(drawn.id) });
}

/** A press that picked a shape, with the two multi-select modifiers v1 had. */
function pressOnShape(turn: Turn<InteractionState, Extract<InteractionEvent, { type: "pointer-down" }>>, id: string): Transition {
  const { context, event } = turn;
  if (isToggleModifier(event.modifiers)) {
    return { state: IDLE, effects: [{ kind: "select", selection: toggleSelection(context.selection, id) }] };
  }
  if (event.modifiers.shift) {
    return { state: IDLE, effects: [{ kind: "select", selection: selectAlso(context.selection, id) }] };
  }
  const annotation = annotationById(context.document, id);
  if (annotation === undefined || annotation.geometry.type === "classification_tag") {
    return { state: IDLE, effects: [{ kind: "select", selection: selectOnly(id) }] };
  }
  return {
    state: {
      type: "moving",
      id,
      startGeometry: annotation.geometry,
      startPoint: event.point,
    },
    effects: [{ kind: "select", selection: selectOnly(id) }],
  };
}

/**
 * v1's vertex delete — right-click or ctrl-click.
 *
 * `removePolygonVertex` answers `null` at `MIN_POLYGON_POINTS`, and **#44's answer
 * to that is to do nothing.** v1 deleted the whole annotation, and `polygon.ts`
 * left the call here on the grounds that it is a document decision. The call, made:
 *
 * A gesture whose scope escalates from "remove this vertex" to "remove the whole
 * shape" at a boundary the user cannot see is a surprise, and a triangle does not
 * look different enough from a quadrilateral to be a warning. Undo would make it
 * *recoverable* — which v1's could not — but recoverable is not the same as
 * predictable, and the remedy for deleting a polygon already exists and is explicit:
 * select it and press Delete (#46).
 *
 * It also removes a failure mode #47 would otherwise inherit. On macOS a ctrl-click
 * is the native secondary click, so both spellings of this gesture fire from one
 * press — v1's own bug. Two no-ops are a no-op; two `remove`s are a `DocumentError`
 * out of `removeAnnotations`' all-or-nothing refusal, raised from a pointer handler.
 *
 * The silence is the cost, and it is stated rather than hidden: core has no channel
 * to say "not this one". M5's panel is where that sentence can be shown.
 */
function deleteVertex(context: InteractionContext, id: string, index: number): Transition {
  const annotation = annotationById(context.document, id);
  if (annotation === undefined || annotation.geometry.type !== "polygon") return idle();
  const next = removePolygonVertex(annotation.geometry, index);
  if (next === null) return idle();
  return idle({ kind: "replace", annotation: { ...annotation, geometry: next } });
}

const IDLE_ROW: Row<"idle"> = {
  "pointer-down": (turn) => {
    const { context, event } = turn;
    const target = resolveTarget(sceneOf(context), event.point);

    if (event.button !== "primary") {
      // v1's right-click on a vertex deletes it. Its right-click *anywhere else*
      // started a pan, which is the adapter's now — so the rest is silent here.
      if (event.button === "secondary" && target.kind === "vertex") {
        return deleteVertex(context, target.id, target.index);
      }
      return stay(turn);
    }

    if (context.tool !== "select") {
      // A drawing tool needs a class to draw with; `toolFor` cannot return a
      // drawing tool without one, so this is unreachable and stated anyway.
      if (context.labelClass === null) return stay(turn);
      const at = inFrame(context, event.point);
      const cleared: readonly Effect[] = [{ kind: "select", selection: clearSelection() }];
      if (context.tool === "bbox") {
        return {
          state: { type: "drawing-bbox", labelClass: context.labelClass, start: at, current: at },
          effects: cleared,
        };
      }
      return {
        state: { type: "drawing-polygon", labelClass: context.labelClass, points: [at], cursor: at },
        effects: cleared,
      };
    }

    if (target.kind === "handle") {
      const annotation = annotationById(context.document, target.id);
      if (annotation === undefined || annotation.geometry.type !== "bbox") return stay(turn);
      return {
        state: { type: "resizing", id: target.id, handle: target.handle, startGeometry: annotation.geometry },
        effects: NO_EFFECTS,
      };
    }

    if (target.kind === "vertex") {
      if (isToggleModifier(event.modifiers)) {
        return deleteVertex(context, target.id, target.index);
      }
      const annotation = annotationById(context.document, target.id);
      if (annotation === undefined || annotation.geometry.type !== "polygon") return stay(turn);
      return {
        state: {
          type: "moving-vertex",
          id: target.id,
          vertexIndex: target.index,
          startGeometry: annotation.geometry,
        },
        effects: NO_EFFECTS,
      };
    }

    if (target.kind === "body" || target.kind === "edge") {
      return pressOnShape(turn, target.id);
    }

    return { state: { type: "pressing-empty", startPoint: event.point }, effects: NO_EFFECTS };
  },

  "double-click": (turn) => {
    const { context, event } = turn;
    if (context.tool !== "select") return stay(turn);
    const insertion = nearestInsertion(sceneOf(context), event.point);
    if (insertion === null) return stay(turn);
    const annotation = annotationById(context.document, insertion.id);
    if (annotation === undefined || annotation.geometry.type !== "polygon") return stay(turn);
    const next = insertPolygonVertex(annotation.geometry, insertion.index, insertion.point);
    return {
      state: IDLE,
      effects: [
        { kind: "replace", annotation: { ...annotation, geometry: next } },
        // A vertex nobody can see is not an edit a user can undo by hand: an
        // unselected polygon draws no vertices.
        { kind: "select", selection: selectOnly(annotation.id) },
      ],
    };
  },

  cancel: (turn) => {
    if (turn.context.selection.size === 0) return stay(turn);
    return { state: IDLE, effects: [{ kind: "select", selection: clearSelection() }] };
  },
};

const PRESSING_EMPTY_ROW: Row<"pressing-empty"> = {
  "pointer-up": (turn) => {
    const { context, event, state } = turn;
    // v1 measured start-to-release, so a press that wandered far and came back
    // still counts as a click. Ported as it stands; a latched "did it move"
    // flag would be one more field and a divergence nobody asked for.
    const travelled =
      Math.abs(event.point[0] - state.startPoint[0]) +
      Math.abs(event.point[1] - state.startPoint[1]);
    if (travelled >= context.tolerances.click) return idle();
    if (context.selection.size === 0) return idle();
    return idle({ kind: "select", selection: clearSelection() });
  },
  cancel: () => idle(),
  "pointer-cancel": () => idle(),
  "tool-changed": () => idle(),
};

const DRAWING_BBOX_ROW: Row<"drawing-bbox"> = {
  "pointer-move": (turn) => ({
    state: { ...turn.state, current: inFrame(turn.context, turn.event.point) },
    effects: NO_EFFECTS,
  }),
  "pointer-up": (turn) => {
    if (turn.event.button !== "primary") return stay(turn);
    const end = inFrame(turn.context, turn.event.point);
    const box = normalizeBbox(turn.state.start, end);
    // A click in a drawing tool is not an annotation. Nothing is added and
    // nothing is selected — and the selection the press cleared stays cleared,
    // which is right rather than merely v1's: the click did land on empty canvas.
    // The threshold itself is `tolerance.ts`'s, chosen on a screen and converted
    // once; `bbox.ts` sets out why it is not `MIN_BBOX_SIZE`.
    if (!isDrawnBox(box, turn.context.tolerances.minDraw, turn.context.document.asset)) {
      return idle();
    }
    return finishDrawing(turn.context, turn.state.labelClass, box);
  },
  cancel: () => idle(),
  "pointer-cancel": () => idle(),
  "tool-changed": () => idle(),
};

/**
 * A drawing session ends, if it has enough points to end with.
 *
 * Shared by `commit` (Enter) and `double-click` so the two cannot come to differ
 * about the arity gate — one of them silently accepting a two-point polygon is the
 * kind of divergence that only shows up in exported data.
 *
 * Below `MIN_POLYGON_POINTS` the session **stays alive**. There is nothing to
 * discard (a pending polygon has written nothing) and dropping the user's placed
 * vertices because they reached for the wrong key would be a punishment for a typo.
 * Escape is how a session is abandoned, and it is one key away.
 */
function closeSession(turn: Turn<Extract<InteractionState, { type: "drawing-polygon" }>>): Transition {
  if (turn.state.points.length < MIN_POLYGON_POINTS) return stay(turn);
  return finishDrawing(turn.context, turn.state.labelClass, {
    type: "polygon",
    points: turn.state.points,
  });
}

/** The vertex a press would be re-placing, if it landed on the one just placed. */
function repeatsLastVertex(
  state: Extract<InteractionState, { type: "drawing-polygon" }>,
  at: Point,
  tolerance: number,
): boolean {
  const last = state.points[state.points.length - 1];
  return last !== undefined && distance(at, last) <= tolerance;
}

const DRAWING_POLYGON_ROW: Row<"drawing-polygon"> = {
  /**
   * Four rules, and the order is the whole of it — see "a press while drawing"
   * in the module header.
   */
  "pointer-down": (turn) => {
    const { context, event, state } = turn;

    if (event.button !== "primary") {
      // v1's right-click-to-take-back, which was its only undo of any kind while
      // drawing. Emptying the buffer returns to `idle` rather than leaving a
      // `drawing-polygon` holding nothing: `points[0]` is what the close ring and
      // the affordance are measured from, and a state where that is `undefined` is
      // one every reader would have to guard. The tool has not changed, so the next
      // press starts a fresh session — which is also what Escape from a one-point
      // session does, and the two agreeing is not an accident.
      if (event.button !== "secondary") return stay(turn);
      if (state.points.length <= 1) return idle();
      return {
        state: { ...state, points: state.points.slice(0, -1) },
        effects: NO_EFFECTS,
      };
    }

    const at = inFrame(context, event.point);

    // Aiming at the first vertex is a close attempt whether or not it can be
    // honoured, and neither answer appends. `too-few` is silent: refusing loudly
    // would need a channel core does not have, and the vertices are all still there.
    const attempt = polygonCloseAttempt(state.points, at, context.tolerances.closePolygon);
    if (attempt === "closes") return closeSession(turn);
    if (attempt === "too-few") return stay(turn);

    // The press that lands on the vertex it just placed is that vertex again, not a
    // second one. See "why the duplicate rule is load-bearing" in the header.
    if (repeatsLastVertex(state, at, context.tolerances.vertex)) {
      return { state: { ...state, cursor: at }, effects: NO_EFFECTS };
    }

    return {
      state: { ...state, points: [...state.points, at], cursor: at },
      effects: NO_EFFECTS,
    };
  },
  "pointer-move": (turn) => ({
    // Clamped, so the rubber band ends where the vertex would actually land
    // rather than where the pointer is. Outside the asset those differ.
    state: { ...turn.state, cursor: inFrame(turn.context, turn.event.point) },
    effects: NO_EFFECTS,
  }),
  "double-click": (turn) => closeSession(turn),
  commit: (turn) => closeSession(turn),
  cancel: () => idle(),
  "tool-changed": () => idle(),
  // `pointer-cancel` is deliberately absent — see the cancel table above.
};

const MOVING_ROW: Row<"moving"> = {
  "pointer-move": (turn) => {
    const { context, event, state } = turn;
    const current = stillThere(context, state.id, state.startGeometry);
    if (current === null) return abandonDrag();
    const origin = draggedOrigin(state.startGeometry, state.startPoint, event.point);
    const next =
      state.startGeometry.type === "bbox"
        ? moveBbox(state.startGeometry, origin, context.document.asset)
        : translatePolygon(state.startGeometry, origin, context.document.asset);
    return { state, effects: stageOrDiscard(current, next) };
  },
  "pointer-up": (turn) => {
    if (turn.event.button !== "primary") return stay(turn);
    if (stillThere(turn.context, turn.state.id, turn.state.startGeometry) === null) {
      return abandonDrag();
    }
    return commitDrag(turn.context, turn.state.id, "move");
  },
  cancel: () => abandonDrag(),
  "pointer-cancel": () => abandonDrag(),
  "tool-changed": () => abandonDrag(),
};

const RESIZING_ROW: Row<"resizing"> = {
  "pointer-move": (turn) => {
    const { context, event, state } = turn;
    const current = stillThere(context, state.id, state.startGeometry);
    if (current === null) return abandonDrag();
    const next = resizeBbox(state.startGeometry, state.handle, event.point, context.document.asset);
    return { state, effects: stageOrDiscard(current, next) };
  },
  "pointer-up": (turn) => {
    if (turn.event.button !== "primary") return stay(turn);
    if (stillThere(turn.context, turn.state.id, turn.state.startGeometry) === null) {
      return abandonDrag();
    }
    return commitDrag(turn.context, turn.state.id, "resize");
  },
  cancel: () => abandonDrag(),
  "pointer-cancel": () => abandonDrag(),
  "tool-changed": () => abandonDrag(),
};

const MOVING_VERTEX_ROW: Row<"moving-vertex"> = {
  "pointer-move": (turn) => {
    const { context, event, state } = turn;
    const current = stillThere(context, state.id, state.startGeometry);
    // The third guard: an undo that removed a vertex leaves an index this
    // gesture is still holding, and `movePolygonVertex` throws a `RangeError`
    // on it — out of a pointer handler, which is the whole point.
    if (current === null || state.vertexIndex >= state.startGeometry.points.length) {
      return abandonDrag();
    }
    const next = movePolygonVertex(
      state.startGeometry,
      state.vertexIndex,
      event.point,
      context.document.asset,
    );
    return { state, effects: stageOrDiscard(current, next) };
  },
  "pointer-up": (turn) => {
    if (turn.event.button !== "primary") return stay(turn);
    if (stillThere(turn.context, turn.state.id, turn.state.startGeometry) === null) {
      return abandonDrag();
    }
    return commitDrag(turn.context, turn.state.id, "edit");
  },
  cancel: () => abandonDrag(),
  "pointer-cancel": () => abandonDrag(),
  "tool-changed": () => abandonDrag(),
};

/**
 * Every state's row. Total over `InteractionState["type"]` — a new state without
 * an entry here does not compile.
 */
export const TRANSITIONS: { readonly [K in InteractionStateType]: Row<K> } = {
  idle: IDLE_ROW,
  "pressing-empty": PRESSING_EMPTY_ROW,
  "drawing-bbox": DRAWING_BBOX_ROW,
  "drawing-polygon": DRAWING_POLYGON_ROW,
  moving: MOVING_ROW,
  resizing: RESIZING_ROW,
  "moving-vertex": MOVING_VERTEX_ROW,
};

/**
 * One turn of the machine. Pure: same state, same event, same context, same
 * answer — with the single exception of a minted id, which is the injected
 * `context.mint`'s doing and is deterministic for a deterministic factory.
 *
 * The cast is the one place the two narrowings are erased. TypeScript cannot
 * correlate `TRANSITIONS[state.type]` with `row[event.type]` — the two lookups
 * are independent as far as it is concerned — and every handler was written
 * under the narrowed `Row<K>` type, which is where the safety actually comes
 * from. One cast, in one function, rather than a per-handler `as` at seven rows.
 */
export function transition(
  state: InteractionState,
  event: InteractionEvent,
  context: InteractionContext,
): Transition {
  const row = TRANSITIONS[state.type] as ErasedRow;
  const handler = row[event.type];
  if (handler === undefined) return { state, effects: NO_EFFECTS };
  return handler({ state, event, context });
}
