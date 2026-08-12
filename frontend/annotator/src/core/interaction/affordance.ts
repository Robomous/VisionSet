/**
 * What the pointer would do here, and what it would do it to.
 *
 * `resolveTarget` answers "what is under this point"; a renderer needs two more
 * things from that answer — the cursor to show, and which grip to paint hot — and
 * neither is a fact about the document. This is that layer, and it is one pure
 * function so that the cursor and the press cannot disagree.
 *
 * ## A CSS cursor keyword is vocabulary, not a DOM API
 *
 * `Cursor` is a union of the `cursor` values this engine can mean. They are
 * strings; nothing here touches a node, and the module compiles under
 * `tsconfig.core.json` with `lib: ["ES2022"]` and `types: []` like every other
 * file in `core/`. The alternative considered was an abstract union — `"grab"`,
 * `"resize-diagonal"` — that an adapter maps one-for-one onto these very names,
 * which is a second spelling of one fact and a table somebody has to keep in step.
 * `LabelClass.color` is already a plain string in `types.ts` for the same reason.
 * An adapter that wants different keywords is free to map away from these; what it
 * must not do is decide *which* affordance applies, because that decision has to
 * match the transition table.
 *
 * ## It mirrors the table's precedence, or the cursor lies
 *
 * `IDLE_ROW`'s `pointer-down` checks `tool !== "select"` **before** it looks at any
 * target. So while a drawing tool is active, a press always starts a new shape —
 * the grips on a selected box are unreachable, however exactly the pointer sits on
 * one. A hover query that resolved a target first would light that grip up and
 * offer a resize cursor for a gesture that cannot happen. In a drawing tool the
 * answer is therefore `crosshair` and `NO_TARGET`, whatever is under the pointer,
 * and `affordance.test.ts` pins it with the pointer parked on a selected box's `nw`
 * grip.
 *
 * The same rule read forwards, because the polygon row has a second meaning for a
 * press: *while a polygon session is open*, a press inside the ring around the first
 * vertex closes the shape instead of extending it, so the cursor there is `pointer`
 * rather than `crosshair`. Both facts come from one function — the row and this
 * module call `polygonCloseAttempt`, neither re-derives it — which is the mechanical
 * version of "the cursor and the press cannot disagree". A hover during
 * `drawing-bbox` has no such second meaning and stays unconditional.
 *
 * ## During a drag the grip stays hot, even when the pointer leaves it
 *
 * A resize drag is bound to the grip it began on. Re-hit-testing under the pointer
 * mid-drag would drop the highlight the moment the pointer outran the box, which is
 * exactly when a user most wants to see what they are holding. So a drag answers
 * from its own state rather than from the point, and the point argument is read by
 * exactly one of the seven states — `idle`. The other six answer from what they
 * already hold, or from nothing.
 *
 * ## The scene here is built from `rendered`; the machine's is `document`
 *
 * `InteractionContext.document` is deliberately the **committed** document — a
 * transition must never resolve against a preview. This function is the opposite:
 * an adapter passes a `Scene` over `store.rendered`, because a hover has to hit-test
 * the pixels that are actually on screen, and mid-drag those are the preview's. The
 * asymmetry is small and load-bearing, and the adapter is the caller that has to get
 * it right.
 */

import { bboxHandlePositions } from "../geometry/bbox";
import type { BboxHandle } from "../geometry/bbox";
import { polygonCloseAttempt, topmostAnnotationAt } from "../geometry/hitTest";
import { clampPoint } from "../geometry/primitives";
import { annotationById, annotationsInDrawOrder } from "../state/document";
import type { Point } from "../types";
import type { InteractionState } from "./state";
import { NO_TARGET, resolveTarget } from "./target";
import type { Scene, Target } from "./target";
import type { Tool } from "./tool";

/**
 * The cursors this engine can ask for.
 *
 * Eight, and each is earned by a branch below. `pointer` is earned by the polygon
 * close: inside the ring around a half-drawn polygon's first vertex a press
 * **closes the shape**, where a press one pixel outside it places another vertex.
 * Two different gestures a millimetre apart, and the only warning a user can get is
 * the cursor.
 *
 * `grabbing` is out: nothing here distinguishes holding a body from hovering one,
 * and inventing that distinction is how a vocabulary grows entries nobody uses.
 */
export type Cursor =
  | "default"
  | "crosshair"
  | "pointer"
  | "move"
  | "nwse-resize"
  | "nesw-resize"
  | "ns-resize"
  | "ew-resize";

/**
 * The cursor each grip shows, which is the one piece of v1's bbox rendering worth
 * porting verbatim.
 *
 * Total over `BboxHandle`, so a ninth grip cannot be added without answering this.
 * Opposite grips share a cursor because they drive the same axis pair.
 */
export const HANDLE_CURSORS: Readonly<Record<BboxHandle, Cursor>> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

/** What the pointer would do here, and to what. */
export interface Affordance {
  /** What the pointer should look like. */
  readonly cursor: Cursor;
  /**
   * What a press would act on — the grip or shape to paint hot — or `NO_TARGET`.
   *
   * During a drag this is what the gesture is *holding*, not what is under the
   * pointer. It is a `Target` rather than a bare id so a renderer can tell a grip
   * from a body without a second lookup, and it carries the grip's own position so
   * a highlight can be drawn without recomputing `bboxHandlePositions`.
   */
  readonly hot: Target;
}

function unreachable(value: never): never {
  throw new Error(`affordanceAt: unhandled state ${JSON.stringify(value)}`);
}

/** The grip a resize drag is holding, positioned as the scene currently draws it. */
function heldHandle(scene: Scene, id: string, handle: BboxHandle): Target {
  const annotation = annotationById(scene.document, id);
  if (annotation === undefined || annotation.geometry.type !== "bbox") return NO_TARGET;
  return { kind: "handle", id, handle, point: bboxHandlePositions(annotation.geometry)[handle] };
}

/** The vertex a vertex drag is holding. */
function heldVertex(scene: Scene, id: string, index: number): Target {
  const annotation = annotationById(scene.document, id);
  if (
    annotation === undefined ||
    (annotation.geometry.type !== "polygon" && annotation.geometry.type !== "polyline")
  ) {
    return NO_TARGET;
  }
  const point = annotation.geometry.points[index];
  if (point === undefined) return NO_TARGET;
  return { kind: "vertex", id, index, point };
}

/** The shape a move drag is holding. */
function heldBody(scene: Scene, id: string): Target {
  if (annotationById(scene.document, id) === undefined) return NO_TARGET;
  return { kind: "body", id };
}

/**
 * Mid-session: is the pointer over the first vertex, where a press would close?
 *
 * The point is clamped exactly as `DRAWING_POLYGON_ROW` clamps it, through the same
 * `clampPoint(…, asset)`. That is not defensive tidying: the row measures the ring
 * from where the vertex *would land*, so for a first vertex sitting on the asset's
 * own edge an unclamped comparison here would put the cursor and the press on
 * different sides of the ring — the one disagreement this whole module exists to
 * make impossible.
 *
 * `hot` stays `NO_TARGET`. A `Target` names an annotation by id and a pending
 * polygon has none; a renderer wanting to ring the vertex reads `state.points[0]`,
 * which it must already have in order to draw the rubber band at all.
 *
 * `too-few` shows `crosshair`, not `pointer`. The press there does nothing, and a
 * cursor promising a close that will not happen is the same lie in the other
 * direction.
 */
function drawingPolygon(
  state: Extract<InteractionState, { type: "drawing-polygon" }>,
  scene: Scene,
  point: Point,
): Affordance {
  const at = clampPoint(point, scene.document.asset);
  const attempt = polygonCloseAttempt(state.points, at, scene.tolerances.closePolygon);
  return { cursor: attempt === "closes" ? "pointer" : "crosshair", hot: NO_TARGET };
}

/** What a press at this point would do, with no gesture in flight. */
function hovering(scene: Scene, tool: Tool, point: Point): Affordance {
  // The tool check comes first here because it comes first in `IDLE_ROW`.
  if (tool !== "select") return { cursor: "crosshair", hot: NO_TARGET };

  const target = resolveTarget(scene, point);
  switch (target.kind) {
    case "handle":
      return { cursor: HANDLE_CURSORS[target.handle], hot: target };
    case "vertex":
    case "body":
    case "edge":
      // `edge` is grouped with `body` because `IDLE_ROW` groups them.
      //
      // `default`, reversing an earlier `move` (#567): a press here *selects*,
      // and only becomes a move if the pointer travels — so `move` advertised the
      // rarer outcome. `hot` is unchanged, so the shape still highlights, and a
      // drag in flight still answers `move` below.
      return { cursor: "default", hot: target };
    case "empty":
      return { cursor: "default", hot: NO_TARGET };
  }
}

/**
 * The cursor and hot target for this pointer position, in this state.
 *
 * `scene` is built from what is **rendered** — see the note above. `tool` is
 * `toolFor(document, activeClass)`, the same derivation the machine's context
 * carries, so the two cannot disagree about which mode this is.
 */
export function affordanceAt(
  state: InteractionState,
  scene: Scene,
  tool: Tool,
  point: Point,
): Affordance {
  switch (state.type) {
    case "idle":
      return hovering(scene, tool, point);
    case "pressing-empty":
      // Nothing, rather than what idle would show. The button is already down on
      // empty canvas, and `PRESSING_EMPTY_ROW` has no `pointer-down` — so for the
      // whole of this gesture no grip and no shape is reachable, however exactly
      // the pointer comes to rest on one. Answering `hovering` here would light a
      // grip that cannot be taken, which is the same lie as offering one in a
      // drawing tool. A marquee — which `state.ts` names as what this state grows
      // into — would give it something of its own to show.
      return { cursor: "default", hot: NO_TARGET };
    case "drawing-bbox":
      return { cursor: "crosshair", hot: NO_TARGET };
    case "drawing-polygon":
      return drawingPolygon(state, scene, point);
    case "drawing-polyline":
      // `crosshair` throughout, and there is no `pointer` case to earn: a path has
      // no close ring, so every press mid-session means the same thing — another
      // vertex. The polygon's two-gestures-a-millimetre-apart problem, which is
      // what bought `pointer` its place in the vocabulary, simply does not arise.
      return { cursor: "crosshair", hot: NO_TARGET };
    case "moving":
      return { cursor: "move", hot: heldBody(scene, state.id) };
    case "moving-vertex":
      return { cursor: "move", hot: heldVertex(scene, state.id, state.vertexIndex) };
    case "resizing":
      return { cursor: HANDLE_CURSORS[state.handle], hot: heldHandle(scene, state.id, state.handle) };
    default:
      return unreachable(state);
  }
}

/**
 * The affordance a **viewer** answers, where selection is the only gesture.
 *
 * The cursor is `default` everywhere: a read-only page never shows a resize
 * keyword, because no such gesture exists. What survives is the hot body, so
 * hovering still says *this is the shape a press would pick*.
 *
 * The editor now answers `default` over a shape too (#567); what still separates
 * the modes is below — a viewer resolves no grip and no vertex at all.
 *
 * It deliberately does not call `resolveTarget`: that resolver offers grips and
 * vertices on the selected shape, and a viewer draws none (the same mirror as
 * `AnnotationShape` — a target that cannot be painted must not be resolvable).
 * Instead it answers from `topmostAnnotationAt` with the body tolerance — the
 * **same rule the viewer's press uses**, so the highlight and the selection
 * cannot disagree, which is this module's whole contract restated for the mode.
 */
export function viewerAffordanceAt(scene: Scene, point: Point): Affordance {
  const id = viewerPressTarget(scene, point);
  return id === null
    ? { cursor: "default", hot: NO_TARGET }
    : { cursor: "default", hot: { kind: "body", id } };
}

/**
 * What a viewer's press selects: the topmost shape under the point, or nothing.
 *
 * One function for the press and the hover above — and it is also the rule the
 * right-click menu already resolves with, so every pointer gesture a viewer has
 * agrees about what is "under" a point.
 */
export function viewerPressTarget(scene: Scene, point: Point): string | null {
  const hit = topmostAnnotationAt(
    annotationsInDrawOrder(scene.document),
    point,
    scene.tolerances.shape,
  );
  return hit === null ? null : hit.id;
}
