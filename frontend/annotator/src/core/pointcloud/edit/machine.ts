/**
 * The scan editor's interaction machine: draw a cuboid (its length dragged on
 * the ground, which also sets its yaw, then its width, then its height), move
 * it, push a face, turn its yaw; draw a polyline on the ground click by click,
 * drag, insert or remove its vertices.
 *
 * The 2D machine's discipline, not its code: a turn is pure, the state is data,
 * and what it asks of the store is a closed list of plain-data effects, so a
 * test reads a transition as the exact geometry it stages. A drag stages a
 * projection of the committed box and commits once on pointer-up; Escape
 * discards it. A draft being drawn lives in the state, never in the document,
 * and enters the document as one `add`.
 *
 * Orbiting is the adapter's: only a primary press reaches this machine. Each
 * event's context names the view it came through, so two views can share one
 * state: a box's height is never read through the top-down one.
 */

import type { IdFactory } from "../../ids";
import type { Modifiers, PointerButton } from "../../interaction/events";
import { isToggleModifier } from "../../interaction/events";
import {
  EMPTY_SELECTION,
  selectOnly,
  toggleSelection,
  type Selection,
} from "../../state/selection";
import {
  isCuboidScanAnnotation,
  isPolylineScanAnnotation,
  type Annotation,
  type AttributeValue,
  type Cuboid3DGeometry,
  type Point,
  type Point3D,
  type Polyline3DGeometry,
  type ScanAnnotation,
} from "../../types";
import {
  cuboidAxes,
  faceCenter,
  faceSpec,
  MIN_CUBOID_SIZE,
  resizeCuboidFace,
  wrapYaw,
  yawOfHeading,
  type CuboidFace,
} from "../cuboid";
import type { PointSample } from "../decode";
import { fromForwardLeftUp, heightOf } from "../frame";
import { insertPolylineVertex, isDrawablePolyline, movePolylineVertex, removePolylineVertex } from "../polyline";
import { closestOnAxis, rayGroundHit, screenRay } from "../ray";
import { snapHeight } from "../snap";
import { add, dot, subtract } from "../vector";
import { hitTest3D, yawRing, type Hit3D, type HitTolerances3D, type Scene3D } from "./scene";
import type { ScanDocument } from "./scanDocument";

export type ScanTool =
  | { readonly kind: "select" }
  | { readonly kind: "cuboid"; readonly labelClass: string }
  | { readonly kind: "polyline"; readonly labelClass: string };

export interface ScanContext extends Scene3D {
  readonly tool: ScanTool;
  /** The level a new box's footprint is drawn on, along the frame's up axis. */
  readonly groundHeight: number;
  /** The loaded points, whose height a polyline vertex takes where one is near the pointer. */
  readonly points?: PointSample | null;
  readonly tolerances: HitTolerances3D;
  /** Called once per drawn box, never inside a projection. */
  readonly mint: IdFactory;
}

export type ScanEvent =
  | {
      readonly type: "pointer-down";
      readonly point: Point;
      readonly button: PointerButton;
      readonly modifiers: Modifiers;
    }
  | { readonly type: "pointer-move"; readonly point: Point }
  | {
      readonly type: "pointer-up";
      readonly point: Point;
      readonly button: PointerButton;
      readonly modifiers: Modifiers;
    }
  | { readonly type: "pointer-cancel" }
  | { readonly type: "cancel" }
  | { readonly type: "commit" }
  | { readonly type: "delete-selected" };

export type ScanState =
  | { readonly type: "idle" }
  | {
      readonly type: "drawing-footprint";
      readonly labelClass: string;
      readonly anchor: Point3D;
      readonly corner: Point3D;
    }
  | {
      readonly type: "drawing-width";
      readonly labelClass: string;
      /** Where the length edge starts, on the ground. */
      readonly anchor: Point3D;
      readonly length: number;
      readonly yaw: number;
      /** The pointer's signed distance from the length edge, along the box's left axis. */
      readonly offset: number;
    }
  | {
      readonly type: "drawing-height";
      readonly labelClass: string;
      /** The footprint's centre, on the ground. */
      readonly base: Point3D;
      readonly length: number;
      readonly width: number;
      readonly yaw: number;
      readonly height: number;
    }
  | {
      readonly type: "moving";
      readonly id: string;
      readonly origin: Cuboid3DGeometry;
      readonly grab: Point3D;
      readonly level: number;
    }
  | {
      readonly type: "resizing";
      readonly id: string;
      readonly origin: Cuboid3DGeometry;
      readonly face: CuboidFace;
      readonly start: number;
    }
  | {
      readonly type: "rotating";
      readonly id: string;
      readonly origin: Cuboid3DGeometry;
      readonly start: number;
      readonly level: number;
    }
  | {
      readonly type: "drawing-polyline";
      readonly labelClass: string;
      readonly points: readonly Point3D[];
      readonly cursor: Point3D | null;
    }
  | {
      readonly type: "moving-vertex";
      readonly id: string;
      readonly origin: Polyline3DGeometry;
      readonly index: number;
      readonly level: number;
    };

export type ScanStateType = ScanState["type"];

export const SCAN_IDLE: ScanState = { type: "idle" };

export type ScanEffect =
  | { readonly kind: "select"; readonly selection: Selection }
  | { readonly kind: "stage"; readonly id: string; readonly geometry: Cuboid3DGeometry | Polyline3DGeometry }
  | { readonly kind: "commit"; readonly label: string }
  | { readonly kind: "discard" }
  | { readonly kind: "add"; readonly label: string; readonly annotation: ScanAnnotation }
  | { readonly kind: "remove"; readonly label: string; readonly ids: readonly string[] };

export interface ScanTransition {
  readonly state: ScanState;
  readonly effects: readonly ScanEffect[];
}

const NOTHING: readonly ScanEffect[] = [];

function to(state: ScanState, ...effects: readonly ScanEffect[]): ScanTransition {
  return { state, effects: effects.length === 0 ? NOTHING : effects };
}

/** One turn. Pure but for `context.mint`, which a deterministic factory makes deterministic. */
export function scanTransition(state: ScanState, event: ScanEvent, context: ScanContext): ScanTransition {
  switch (state.type) {
    case "idle":
      return fromIdle(event, context);
    case "drawing-footprint":
      return fromFootprint(state, event, context);
    case "drawing-width":
      return fromWidth(state, event, context);
    case "drawing-height":
      return fromHeight(state, event, context);
    case "drawing-polyline":
      return fromPolyline(state, event, context);
    case "moving":
    case "resizing":
    case "rotating":
    case "moving-vertex":
      return fromDrag(state, event, context);
    default:
      return unreachable(state);
  }
}

/** The box being drawn, for a renderer to preview; `null` when nothing is. */
export function draftCuboid(state: ScanState, context: Pick<ScanContext, "frame">): Cuboid3DGeometry | null {
  switch (state.type) {
    case "drawing-footprint": {
      const edge = lengthEdgeOf(state.anchor, state.corner, context.frame);
      const base = widthBase(state.anchor, edge, 0, context.frame);
      return standing(base, Math.max(MIN_CUBOID_SIZE, edge.length), MIN_CUBOID_SIZE, edge.yaw, MIN_CUBOID_SIZE, context.frame);
    }
    case "drawing-width": {
      const base = widthBase(state.anchor, state, state.offset, context.frame);
      return standing(base, state.length, widthOf(state.offset), state.yaw, MIN_CUBOID_SIZE, context.frame);
    }
    case "drawing-height":
      return standing(state.base, state.length, state.width, state.yaw, state.height, context.frame);
    case "idle":
    case "moving":
    case "resizing":
    case "rotating":
    case "drawing-polyline":
    case "moving-vertex":
      return null;
    default:
      return unreachable(state);
  }
}

/** The polyline being drawn, its clicked vertices then the cursor, for a renderer to preview; `null` when nothing is. */
export function draftPolyline(state: ScanState): Polyline3DGeometry | null {
  if (state.type !== "drawing-polyline") return null;
  const last = state.points[state.points.length - 1]!;
  const points = state.cursor === null || samePoint(state.cursor, last) ? state.points : [...state.points, state.cursor];
  return { type: "polyline_3d", points, visibility: undefined };
}

function fromIdle(event: ScanEvent, context: ScanContext): ScanTransition {
  if (event.type === "delete-selected") {
    const ids = [...context.selection].filter((id) => context.document.annotations.has(id));
    return ids.length === 0 ? to(SCAN_IDLE) : to(SCAN_IDLE, { kind: "remove", label: "delete", ids });
  }
  if (event.type !== "pointer-down" || event.button !== "primary") return to(SCAN_IDLE);
  const { tool, frame } = context;
  const ray = screenRay(context.camera, frame, context.viewport, event.point);

  if (tool.kind === "cuboid") {
    const anchor = rayGroundHit(ray, frame, context.groundHeight);
    if (anchor === null) return to(SCAN_IDLE);
    return to({ type: "drawing-footprint", labelClass: tool.labelClass, anchor, corner: anchor });
  }
  if (tool.kind === "polyline") {
    const first = vertexUnder(event.point, context, context.groundHeight);
    if (first === null) return to(SCAN_IDLE);
    return to({ type: "drawing-polyline", labelClass: tool.labelClass, points: [first], cursor: first });
  }

  const hit = hitTest3D(context, event.point, context.tolerances);
  if (hit === null) {
    return context.selection.size === 0 ? to(SCAN_IDLE) : to(SCAN_IDLE, select(EMPTY_SELECTION));
  }
  const annotation = context.document.annotations.get(hit.id);
  if (annotation !== undefined && isPolylineScanAnnotation(annotation)) {
    return pressPolyline(annotation.id, annotation.label_class, annotation.geometry, hit, event, context);
  }
  if (annotation === undefined || !isCuboidScanAnnotation(annotation)) return to(SCAN_IDLE);
  const origin = annotation.geometry;

  switch (hit.kind) {
    case "face": {
      const { axis } = faceSpec(hit.face);
      const start = closestOnAxis(ray, faceCenter(origin, frame, hit.face), cuboidAxes(origin, frame)[axis]);
      if (start === null) return to(SCAN_IDLE);
      return to({ type: "resizing", id: hit.id, origin, face: hit.face, start });
    }
    case "yaw-ring": {
      const ring = yawRing(origin, frame);
      return to({
        type: "rotating",
        id: hit.id,
        origin,
        start: yawOfHeading(subtract(hit.point, ring.center), frame),
        level: ring.level,
      });
    }
    case "body": {
      if (isToggleModifier(event.modifiers)) {
        return to(SCAN_IDLE, select(toggleSelection(context.selection, hit.id)));
      }
      const moving: ScanState = {
        type: "moving",
        id: hit.id,
        origin,
        grab: hit.point,
        level: heightOf(frame, hit.point),
      };
      const already = context.selection.size === 1 && context.selection.has(hit.id);
      return already ? to(moving) : to(moving, select(selectOnly(hit.id)));
    }
    case "vertex":
    case "segment":
      return to(SCAN_IDLE);
    default:
      return unreachable(hit);
  }
}

function pressPolyline(
  id: string,
  labelClass: string,
  origin: Polyline3DGeometry,
  hit: Hit3D,
  { point, modifiers }: { readonly point: Point; readonly modifiers: Modifiers },
  context: ScanContext,
): ScanTransition {
  const { frame } = context;
  switch (hit.kind) {
    case "vertex": {
      if (modifiers.alt) {
        const removed = removePolylineVertex(origin, hit.index);
        if (removed === null || !isDrawablePolyline(removed.points)) return to(SCAN_IDLE);
        return to(SCAN_IDLE, { kind: "stage", id, geometry: removed }, { kind: "commit", label: `remove vertex of ${labelClass}` });
      }
      const level = heightOf(frame, origin.points[hit.index]!);
      return to({ type: "moving-vertex", id, origin, index: hit.index, level });
    }
    case "segment": {
      if (modifiers.alt) return to(SCAN_IDLE);
      if (isToggleModifier(modifiers)) return to(SCAN_IDLE, select(toggleSelection(context.selection, id)));
      const already = context.selection.size === 1 && context.selection.has(id);
      if (!already) return to(SCAN_IDLE, select(selectOnly(id)));
      const at = surfaceUnder(point, context) ?? hit.point;
      const inserted = insertPolylineVertex(origin, hit.segment, at);
      const moving: ScanState = {
        type: "moving-vertex",
        id,
        origin: inserted,
        index: hit.segment + 1,
        level: heightOf(frame, at),
      };
      return to(moving, { kind: "stage", id, geometry: inserted });
    }
    default:
      return to(SCAN_IDLE);
  }
}

function fromPolyline(
  state: Extract<ScanState, { type: "drawing-polyline" }>,
  event: ScanEvent,
  context: ScanContext,
): ScanTransition {
  switch (event.type) {
    case "pointer-move":
      return to({ ...state, cursor: vertexUnder(event.point, context, context.groundHeight) });
    case "pointer-down": {
      if (event.button !== "primary") return to(state);
      const next = vertexUnder(event.point, context, context.groundHeight);
      const last = state.points[state.points.length - 1]!;
      if (next === null || samePoint(next, last)) return to(state);
      return to({ ...state, points: [...state.points, next], cursor: next });
    }
    case "commit": {
      if (!isDrawablePolyline(state.points)) return to(state);
      const geometry: Polyline3DGeometry = { type: "polyline_3d", points: state.points, visibility: undefined };
      const annotation = newScanAnnotation(context.document, state.labelClass, geometry, context.mint);
      return to(
        SCAN_IDLE,
        { kind: "add", label: `draw ${state.labelClass}`, annotation },
        select(selectOnly(annotation.id)),
      );
    }
    case "cancel":
      return to(SCAN_IDLE);
    default:
      return to(state);
  }
}

function fromFootprint(
  state: Extract<ScanState, { type: "drawing-footprint" }>,
  event: ScanEvent,
  context: ScanContext,
): ScanTransition {
  switch (event.type) {
    case "pointer-move": {
      const corner = groundUnder(event.point, context);
      return corner === null ? to(state) : to({ ...state, corner });
    }
    case "pointer-up": {
      const corner = groundUnder(event.point, context) ?? state.corner;
      const { length, yaw } = lengthEdgeOf(state.anchor, corner, context.frame);
      if (length < MIN_CUBOID_SIZE) return to(SCAN_IDLE);
      return to({ type: "drawing-width", labelClass: state.labelClass, anchor: state.anchor, length, yaw, offset: 0 });
    }
    case "pointer-cancel":
    case "cancel":
      return to(SCAN_IDLE);
    default:
      return to(state);
  }
}

function fromWidth(
  state: Extract<ScanState, { type: "drawing-width" }>,
  event: ScanEvent,
  context: ScanContext,
): ScanTransition {
  switch (event.type) {
    case "pointer-move": {
      const at = groundUnder(event.point, context);
      return at === null ? to(state) : to({ ...state, offset: dot(subtract(at, state.anchor), leftOfYaw(state.yaw, context.frame)) });
    }
    case "pointer-down":
      return event.button === "primary" ? toHeight(state, context) : to(state);
    case "commit":
      return toHeight(state, context);
    case "cancel":
      return to(SCAN_IDLE);
    default:
      return to(state);
  }
}

function toHeight(state: Extract<ScanState, { type: "drawing-width" }>, context: ScanContext): ScanTransition {
  return to({
    type: "drawing-height",
    labelClass: state.labelClass,
    base: widthBase(state.anchor, state, state.offset, context.frame),
    length: state.length,
    width: widthOf(state.offset),
    yaw: state.yaw,
    height: MIN_CUBOID_SIZE,
  });
}

function fromHeight(
  state: Extract<ScanState, { type: "drawing-height" }>,
  event: ScanEvent,
  context: ScanContext,
): ScanTransition {
  switch (event.type) {
    case "pointer-move": {
      if (context.view === "top-down") return to(state);
      const ray = screenRay(context.camera, context.frame, context.viewport, event.point);
      const up = fromForwardLeftUp(context.frame, [0, 0, 1]);
      const along = closestOnAxis(ray, state.base, up);
      return along === null ? to(state) : to({ ...state, height: Math.max(MIN_CUBOID_SIZE, along) });
    }
    case "pointer-down":
      return event.button === "primary" ? finishDraw(state, context) : to(state);
    case "commit":
      return finishDraw(state, context);
    case "cancel":
      return to(SCAN_IDLE);
    default:
      return to(state);
  }
}

function finishDraw(
  state: Extract<ScanState, { type: "drawing-height" }>,
  context: ScanContext,
): ScanTransition {
  const geometry = standing(state.base, state.length, state.width, state.yaw, state.height, context.frame);
  const annotation = newScanAnnotation(context.document, state.labelClass, geometry, context.mint);
  return to(
    SCAN_IDLE,
    { kind: "add", label: `draw ${state.labelClass}`, annotation },
    select(selectOnly(annotation.id)),
  );
}

type Drag = Extract<ScanState, { type: "moving" | "resizing" | "rotating" | "moving-vertex" }>;

function fromDrag(state: Drag, event: ScanEvent, context: ScanContext): ScanTransition {
  const annotation = context.document.annotations.get(state.id);
  if (annotation === undefined) return to(SCAN_IDLE, { kind: "discard" });
  switch (event.type) {
    case "pointer-move": {
      const geometry = dragged(state, event.point, context);
      return geometry === null ? to(state) : to(state, { kind: "stage", id: state.id, geometry });
    }
    case "pointer-up":
      return to(SCAN_IDLE, { kind: "commit", label: `${verbOf(state, annotation)} ${annotation.label_class}` });
    case "pointer-cancel":
    case "cancel":
      return to(SCAN_IDLE, { kind: "discard" });
    default:
      return to(state);
  }
}

const VERB: Readonly<Record<Drag["type"], string>> = {
  moving: "move",
  resizing: "resize",
  rotating: "rotate",
  "moving-vertex": "move vertex of",
};

/** A vertex drag that started on a segment carries one vertex more than the committed polyline: an insert. */
function verbOf(state: Drag, annotation: ScanAnnotation): string {
  const inserting =
    state.type === "moving-vertex" &&
    isPolylineScanAnnotation(annotation) &&
    annotation.geometry.points.length < state.origin.points.length;
  return inserting ? "insert vertex of" : VERB[state.type];
}

function dragged(state: Drag, point: Point, context: ScanContext): Cuboid3DGeometry | Polyline3DGeometry | null {
  const { frame } = context;
  const ray = screenRay(context.camera, frame, context.viewport, point);
  if (state.type === "moving-vertex") {
    const at = vertexUnder(point, context, state.level);
    if (at === null) return null;
    const moved = movePolylineVertex(state.origin, state.index, at);
    return isDrawablePolyline(moved.points) ? moved : null;
  }
  const { origin } = state;
  switch (state.type) {
    case "moving": {
      const at = rayGroundHit(ray, frame, state.level);
      return at === null ? null : { ...origin, center: add(origin.center, subtract(at, state.grab)) };
    }
    case "resizing": {
      const { axis, sign } = faceSpec(state.face);
      const along = closestOnAxis(ray, faceCenter(origin, frame, state.face), cuboidAxes(origin, frame)[axis]);
      return along === null ? null : resizeCuboidFace(origin, frame, state.face, sign * (along - state.start));
    }
    case "rotating": {
      const at = rayGroundHit(ray, frame, state.level);
      if (at === null) return null;
      const turn = yawOfHeading(subtract(at, yawRing(origin, frame).center), frame) - state.start;
      return { ...origin, yaw: wrapYaw(origin.yaw + turn) };
    }
    default:
      return unreachable(state);
  }
}

/** Under the pointer at the height of the scan point it is on; `null` when no point is near enough. */
function surfaceUnder(point: Point, context: ScanContext): Point3D | null {
  const { points, frame, camera, viewport } = context;
  if (points === undefined || points === null) return null;
  const height = snapHeight(points, frame, camera, viewport, point);
  return height === null ? null : rayGroundHit(screenRay(camera, frame, viewport, point), frame, height);
}

/** Where a polyline vertex goes under the pointer: on the scan's surface there, else on the level `fallback`. */
function vertexUnder(point: Point, context: ScanContext, fallback: number): Point3D | null {
  return (
    surfaceUnder(point, context) ??
    rayGroundHit(screenRay(context.camera, context.frame, context.viewport, point), context.frame, fallback)
  );
}

function groundUnder(point: Point, context: ScanContext): Point3D | null {
  return rayGroundHit(screenRay(context.camera, context.frame, context.viewport, point), context.frame, context.groundHeight);
}

/**
 * The footprint drag's level length and heading: the box's length runs from
 * `anchor` to `end`. A drag shorter than `MIN_CUBOID_SIZE` has no reliable
 * direction and reads as yaw 0, and a drag along forward within the pixel
 * round trip's rounding stays exactly 0.
 */
function lengthEdgeOf(
  anchor: Point3D,
  end: Point3D,
  frame: ScanContext["frame"],
): { readonly length: number; readonly yaw: number } {
  const edge = subtract(end, anchor);
  const forward = dot(edge, fromForwardLeftUp(frame, [1, 0, 0]));
  const left = dot(edge, fromForwardLeftUp(frame, [0, 1, 0]));
  const length = Math.hypot(forward, left);
  const yaw = length < MIN_CUBOID_SIZE ? 0 : Math.atan2(left, forward);
  return { length, yaw: Math.abs(yaw) < YAW_ROUNDING ? 0 : yaw };
}

const YAW_ROUNDING = 1e-9;

function leftOfYaw(yaw: number, frame: ScanContext["frame"]): Point3D {
  return fromForwardLeftUp(frame, [-Math.sin(yaw), Math.cos(yaw), 0]);
}

function widthOf(offset: number): number {
  return Math.max(MIN_CUBOID_SIZE, Math.abs(offset));
}

/** The footprint's centre: halfway along the length edge, and halfway out to the pointer's side of it. */
function widthBase(
  anchor: Point3D,
  edge: { readonly length: number; readonly yaw: number },
  offset: number,
  frame: ScanContext["frame"],
): Point3D {
  const side = (offset < 0 ? -1 : 1) * widthOf(offset);
  return add(anchor, fromForwardLeftUp(frame, [
    (Math.cos(edge.yaw) * edge.length - Math.sin(edge.yaw) * side) / 2,
    (Math.sin(edge.yaw) * edge.length + Math.cos(edge.yaw) * side) / 2,
    0,
  ]));
}

/** A box turned to `yaw` whose bottom face is centred on `base`. */
function standing(
  base: Point3D,
  length: number,
  width: number,
  yaw: number,
  height: number,
  frame: ScanContext["frame"],
): Cuboid3DGeometry {
  return {
    type: "cuboid_3d",
    center: add(base, fromForwardLeftUp(frame, [0, 0, height / 2])),
    size: [length, width, height],
    yaw,
  };
}

function newScanAnnotation<G extends ScanAnnotation["geometry"]>(
  document: ScanDocument,
  labelClass: string,
  geometry: G,
  mint: IdFactory,
): Omit<Annotation, "geometry"> & { readonly geometry: G } {
  const attributes: Record<string, AttributeValue> = {};
  const declared = document.schema.classes.find((one) => one.name === labelClass);
  for (const attribute of declared?.attributes ?? []) {
    if (attribute.default !== null) attributes[attribute.name] = attribute.default;
  }
  return {
    id: mint(),
    asset_id: document.asset.id,
    label_class: labelClass,
    schema_version: document.schema.version,
    geometry,
    attributes,
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

function samePoint(a: Point3D, b: Point3D): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function select(selection: Selection): ScanEffect {
  return { kind: "select", selection };
}

function unreachable(value: never): never {
  throw new Error(`Expected code to be unreachable: ${JSON.stringify(value)}`);
}
