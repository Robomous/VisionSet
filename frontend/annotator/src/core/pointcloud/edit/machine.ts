/**
 * The scan editor's interaction machine: draw a cuboid (footprint on the ground,
 * then height), move it, push a face, turn its yaw.
 *
 * The 2D machine's discipline, not its code: a turn is pure, the state is data,
 * and what it asks of the store is a closed list of plain-data effects, so a
 * test reads a transition as the exact geometry it stages. A drag stages a
 * projection of the committed box and commits once on pointer-up; Escape
 * discards it. A draft being drawn lives in the state, never in the document,
 * and enters the document as one `add`.
 *
 * Orbiting is the adapter's: only a primary press reaches this machine.
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
import type { AttributeValue, Cuboid3DGeometry, Point, Point3D, ScanAnnotation } from "../../types";
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
import { fromForwardLeftUp, heightOf } from "../frame";
import { closestOnAxis, rayGroundHit, screenRay } from "../ray";
import { add, dot, scale, subtract } from "../vector";
import { hitTest3D, yawRing, type HitTolerances3D, type Scene3D } from "./scene";
import type { ScanDocument } from "./scanDocument";

export type ScanTool =
  | { readonly kind: "select" }
  | { readonly kind: "cuboid"; readonly labelClass: string };

export interface ScanContext extends Scene3D {
  readonly tool: ScanTool;
  /** The level a new box's footprint is drawn on, along the frame's up axis. */
  readonly groundHeight: number;
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
      readonly type: "drawing-height";
      readonly labelClass: string;
      /** The footprint's centre, on the ground. */
      readonly base: Point3D;
      readonly length: number;
      readonly width: number;
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
    };

export type ScanStateType = ScanState["type"];

export const SCAN_IDLE: ScanState = { type: "idle" };

export type ScanEffect =
  | { readonly kind: "select"; readonly selection: Selection }
  | { readonly kind: "stage"; readonly id: string; readonly geometry: Cuboid3DGeometry }
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
    case "drawing-height":
      return fromHeight(state, event, context);
    case "moving":
    case "resizing":
    case "rotating":
      return fromDrag(state, event, context);
    default:
      return unreachable(state);
  }
}

/** The box being drawn, for a renderer to preview; `null` when nothing is. */
export function draftCuboid(state: ScanState, context: Pick<ScanContext, "frame">): Cuboid3DGeometry | null {
  switch (state.type) {
    case "drawing-footprint": {
      const footprint = footprintOf(state.anchor, state.corner, context.frame);
      return standing(footprint.base, footprint.length, footprint.width, MIN_CUBOID_SIZE, context.frame);
    }
    case "drawing-height":
      return standing(state.base, state.length, state.width, state.height, context.frame);
    case "idle":
    case "moving":
    case "resizing":
    case "rotating":
      return null;
    default:
      return unreachable(state);
  }
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

  const hit = hitTest3D(context, event.point, context.tolerances);
  if (hit === null) {
    return context.selection.size === 0 ? to(SCAN_IDLE) : to(SCAN_IDLE, select(EMPTY_SELECTION));
  }
  const annotation = context.document.annotations.get(hit.id);
  if (annotation === undefined) return to(SCAN_IDLE);
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
    default:
      return unreachable(hit);
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
      const { base, length, width } = footprintOf(state.anchor, corner, context.frame);
      if (length < MIN_CUBOID_SIZE || width < MIN_CUBOID_SIZE) return to(SCAN_IDLE);
      return to({
        type: "drawing-height",
        labelClass: state.labelClass,
        base,
        length,
        width,
        height: MIN_CUBOID_SIZE,
      });
    }
    case "pointer-cancel":
    case "cancel":
      return to(SCAN_IDLE);
    default:
      return to(state);
  }
}

function fromHeight(
  state: Extract<ScanState, { type: "drawing-height" }>,
  event: ScanEvent,
  context: ScanContext,
): ScanTransition {
  switch (event.type) {
    case "pointer-move": {
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
  const geometry = standing(state.base, state.length, state.width, state.height, context.frame);
  const annotation = newScanAnnotation(context.document, state.labelClass, geometry, context.mint);
  return to(
    SCAN_IDLE,
    { kind: "add", label: `draw ${state.labelClass}`, annotation },
    select(selectOnly(annotation.id)),
  );
}

type Drag = Extract<ScanState, { type: "moving" | "resizing" | "rotating" }>;

function fromDrag(state: Drag, event: ScanEvent, context: ScanContext): ScanTransition {
  const annotation = context.document.annotations.get(state.id);
  if (annotation === undefined) return to(SCAN_IDLE, { kind: "discard" });
  switch (event.type) {
    case "pointer-move": {
      const geometry = dragged(state, event.point, context);
      return geometry === null ? to(state) : to(state, { kind: "stage", id: state.id, geometry });
    }
    case "pointer-up":
      return to(SCAN_IDLE, { kind: "commit", label: `${VERB[state.type]} ${annotation.label_class}` });
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
};

function dragged(state: Drag, point: Point, context: ScanContext): Cuboid3DGeometry | null {
  const { frame } = context;
  const ray = screenRay(context.camera, frame, context.viewport, point);
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

function groundUnder(point: Point, context: ScanContext): Point3D | null {
  return rayGroundHit(screenRay(context.camera, context.frame, context.viewport, point), context.frame, context.groundHeight);
}

function footprintOf(
  anchor: Point3D,
  corner: Point3D,
  frame: ScanContext["frame"],
): { readonly base: Point3D; readonly length: number; readonly width: number } {
  const diagonal = subtract(corner, anchor);
  return {
    base: add(anchor, scale(diagonal, 0.5)),
    length: Math.abs(dot(diagonal, fromForwardLeftUp(frame, [1, 0, 0]))),
    width: Math.abs(dot(diagonal, fromForwardLeftUp(frame, [0, 1, 0]))),
  };
}

/** A yaw-0 box whose bottom face is centred on `base`. */
function standing(
  base: Point3D,
  length: number,
  width: number,
  height: number,
  frame: ScanContext["frame"],
): Cuboid3DGeometry {
  return {
    type: "cuboid_3d",
    center: add(base, fromForwardLeftUp(frame, [0, 0, height / 2])),
    size: [length, width, height],
    yaw: 0,
  };
}

function newScanAnnotation(
  document: ScanDocument,
  labelClass: string,
  geometry: Cuboid3DGeometry,
  mint: IdFactory,
): ScanAnnotation {
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

function select(selection: Selection): ScanEffect {
  return { kind: "select", selection };
}

function unreachable(value: never): never {
  throw new Error(`Expected code to be unreachable: ${JSON.stringify(value)}`);
}
