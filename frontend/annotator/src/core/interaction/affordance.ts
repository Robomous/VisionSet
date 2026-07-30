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
 * `Cursor` is a union of the seven `cursor` values this engine can mean. They are
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
 * answer is therefore `crosshair` and `NO_TARGET`, unconditionally, and
 * `affordance.test.ts` pins it with the pointer parked on a selected box's `nw`
 * grip.
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
 * asymmetry is small and load-bearing, and #47 is the caller that has to get it
 * right.
 */

import { bboxHandlePositions } from "../geometry/bbox";
import type { BboxHandle } from "../geometry/bbox";
import { annotationById } from "../state/document";
import type { Point } from "../types";
import type { InteractionState } from "./state";
import { NO_TARGET, resolveTarget } from "./target";
import type { Scene, Target } from "./target";
import type { Tool } from "./tool";

/**
 * The cursors this engine can ask for.
 *
 * Seven, and each is earned by a branch below. `grabbing` and `pointer` were left
 * out: nothing here distinguishes holding a body from hovering one, and inventing
 * that distinction in a chassis task is how a vocabulary grows entries nobody uses.
 */
export type Cursor =
  | "default"
  | "crosshair"
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
  if (annotation === undefined || annotation.geometry.type !== "polygon") return NO_TARGET;
  const point = annotation.geometry.points[index];
  if (point === undefined) return NO_TARGET;
  return { kind: "vertex", id, index, point };
}

/** The shape a move drag is holding. */
function heldBody(scene: Scene, id: string): Target {
  if (annotationById(scene.document, id) === undefined) return NO_TARGET;
  return { kind: "body", id };
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
      // `edge` is grouped with `body` because `IDLE_ROW` groups them:
      // `if (target.kind === "body" || target.kind === "edge") return pressOnShape(...)`.
      // A press in the 15-px band around a selected polygon picks it and starts a
      // move, so `move` is what the cursor owes. Showing `default` there would be
      // the drawing-tool lie inverted — under-promising rather than over — and
      // still a disagreement with the table. The double-click that inserts a
      // vertex is a second meaning for the same band, not the only one; a renderer
      // that wants to hint at it has the `edge` target in `hot`.
      return { cursor: "move", hot: target };
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
    case "drawing-polygon":
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
