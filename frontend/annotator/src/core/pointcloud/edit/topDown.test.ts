import { describe, expect, it } from "vitest";

import { NO_MODIFIERS } from "../../interaction/events";
import { selectOnly } from "../../state/selection";
import { AnnotatorStore } from "../../state/store";
import type { Cuboid3DGeometry, Point, Point3D } from "../../types";
import { topDownCamera } from "../camera";
import { cuboidAxes, faceCenter, faceSpec, headingOfYaw, MIN_CUBOID_SIZE } from "../cuboid";
import { fromForwardLeftUp, type ScanFrame } from "../frame";
import { add, scale } from "../vector";
import { contextOf, pixelOf, scanBox, scanDocumentOf } from "./_scan";
import { SCAN_IDLE, scanTransition, type ScanContext, type ScanEvent, type ScanState, type ScanTransition } from "./machine";
import { scanHandleLayout } from "./overlay";
import { runScanEffects } from "./runScanEffects";
import { hitTest3D, LEVEL_FACES, yawRing } from "./scene";
import type { ScanDocument } from "./scanDocument";

const FRAMES: readonly ScanFrame[] = ["lidar_flu", "camera_rdf", "lidar_rfu"];
const YAWS = [0, 0.7, -2.4];

const down = (point: Point): ScanEvent => ({ type: "pointer-down", point, button: "primary", modifiers: NO_MODIFIERS });
const move = (point: Point): ScanEvent => ({ type: "pointer-move", point });
const up = (point: Point): ScanEvent => ({ type: "pointer-up", point, button: "primary", modifiers: NO_MODIFIERS });

function staged(turn: ScanTransition): Cuboid3DGeometry {
  const effect = turn.effects.find((one) => one.kind === "stage");
  if (effect?.kind !== "stage") throw new Error(`no stage among ${JSON.stringify(turn.effects)}`);
  return effect.geometry;
}

function boxIn(frame: ScanFrame, yaw: number) {
  return scanBox("car-1", { center: fromForwardLeftUp(frame, [1, -0.5, 1.5]), size: [5, 3, 3], yaw });
}

function topDownOf(document: ScanDocument, frame: ScanFrame, extra: Parameters<typeof contextOf>[1] = {}): ScanContext {
  return contextOf(document, { frame, camera: topDownCamera([0, 0, 0], 30), view: "top-down", ...extra });
}

describe("the top-down camera", () => {
  for (const frame of FRAMES) {
    it(`reads forward up the screen and left to the left (${frame})`, () => {
      const context = topDownOf(scanDocumentOf(), frame);
      const [cx, cy] = pixelOf(context, [0, 0, 0]);
      const [fx, fy] = pixelOf(context, fromForwardLeftUp(frame, [5, 0, 0]));
      const [lx, ly] = pixelOf(context, fromForwardLeftUp(frame, [0, 5, 0]));
      expect(cy - fy).toBeGreaterThan(50);
      expect(Math.abs(fx - cx)).toBeLessThan(0.5);
      expect(cx - lx).toBeGreaterThan(50);
      expect(Math.abs(ly - cy)).toBeLessThan(2);
    });
  }
});

describe("the top-down handles", () => {
  it("offers only the four side faces, and the box's centre moves it", () => {
    const box = boxIn("lidar_flu", 0.7);
    const scene = topDownOf(scanDocumentOf(box), "lidar_flu", { selection: selectOnly("car-1") });
    const layout = scanHandleLayout(scene);
    expect(layout?.handles.map((one) => one.face)).toEqual(LEVEL_FACES);
    for (const handle of layout?.handles ?? []) {
      expect(hitTest3D(scene, handle.point)).toEqual({ kind: "face", id: "car-1", face: handle.face });
    }
    const centre = pixelOf(scene, box.geometry.center);
    expect(hitTest3D(scene, centre)).toMatchObject({ kind: "body", id: "car-1" });
  });

  it("the perspective view keeps all six", () => {
    const scene = contextOf(scanDocumentOf(boxIn("lidar_flu", 0)), { selection: selectOnly("car-1") });
    expect(scanHandleLayout(scene)?.handles).toHaveLength(6);
  });

  for (const frame of FRAMES) {
    it(`outlines the footprint and puts the yaw handle on the heading (${frame})`, () => {
      for (const yaw of YAWS) {
        const box = boxIn(frame, yaw);
        const scene = topDownOf(scanDocumentOf(box), frame, { selection: selectOnly("car-1") });
        const layout = scanHandleLayout(scene);
        expect(layout?.footprint).toHaveLength(4);
        const ring = yawRing(box.geometry, frame);
        const [cx, cy] = pixelOf(scene, ring.center);
        const [hx, hy] = layout?.heading ?? [NaN, NaN];
        // Measured on screen, counter-clockwise from up: the stored yaw, near enough at the pinned pitch.
        const onScreen = Math.atan2(-(hx - cx), -(hy - cy));
        expect(Math.abs(Math.atan2(Math.sin(onScreen - yaw), Math.cos(onScreen - yaw)))).toBeLessThan(0.03);
        expect(hitTest3D(scene, [hx, hy])).toMatchObject({ kind: "yaw-ring", id: "car-1" });
      }
    });
  }
});

describe("editing from the top-down view, in every frame", () => {
  for (const frame of FRAMES) {
    for (const yaw of YAWS) {
      for (const face of LEVEL_FACES) {
        it(`pulling ${face} away from the box on screen grows it, and pushing it in shrinks it (${frame}, yaw ${yaw})`, () => {
          const box = boxIn(frame, yaw);
          const context = topDownOf(scanDocumentOf(box), frame, { selection: selectOnly("car-1") });
          const { axis } = faceSpec(face);
          const handle = pixelOf(context, faceCenter(box.geometry, frame, face));
          const centre = pixelOf(context, box.geometry.center);
          const span = Math.hypot(handle[0] - centre[0], handle[1] - centre[1]);
          const out: Point = [(handle[0] - centre[0]) / span, (handle[1] - centre[1]) / span];

          const pressed = scanTransition(SCAN_IDLE, down(handle), context);
          expect(pressed.state).toMatchObject({ type: "resizing", face });
          const grown = staged(scanTransition(pressed.state, move([handle[0] + out[0] * 30, handle[1] + out[1] * 30]), context));
          const shrunk = staged(scanTransition(pressed.state, move([handle[0] - out[0] * 10, handle[1] - out[1] * 10]), context));
          expect(grown.size[axis]).toBeGreaterThan(box.geometry.size[axis] + 0.5);
          expect(shrunk.size[axis]).toBeLessThan(box.geometry.size[axis] - 0.1);
          expect(grown.yaw).toBe(yaw);
        });

        it(`a pull to a point lands ${face} on it (${frame}, yaw ${yaw})`, () => {
          const box = boxIn(frame, yaw);
          const context = topDownOf(scanDocumentOf(box), frame, { selection: selectOnly("car-1") });
          const { axis, sign } = faceSpec(face);
          const grabbed = faceCenter(box.geometry, frame, face);
          const outward = scale(cuboidAxes(box.geometry, frame)[axis], sign);
          const pressed = scanTransition(SCAN_IDLE, down(pixelOf(context, grabbed)), context);
          const pulled = staged(scanTransition(pressed.state, move(pixelOf(context, add(grabbed, scale(outward, 1.5)))), context));
          expect(pulled.size[axis]).toBeCloseTo(box.geometry.size[axis] + 1.5, 3);
        });
      }

      it(`dragging the yaw handle counter-clockwise on screen turns the box by the angle swept (${frame}, yaw ${yaw})`, () => {
        const box = boxIn(frame, yaw);
        const context = topDownOf(scanDocumentOf(box), frame, { selection: selectOnly("car-1") });
        const ring = yawRing(box.geometry, frame);
        const onRing = (angle: number): Point3D => add(ring.center, scale(headingOfYaw(angle, frame), ring.radius));
        const pressed = scanTransition(SCAN_IDLE, down(pixelOf(context, onRing(yaw))), context);
        expect(pressed.state.type).toBe("rotating");
        const turned = staged(scanTransition(pressed.state, move(pixelOf(context, onRing(yaw + 0.5))), context));
        expect(Math.atan2(Math.sin(turned.yaw - yaw), Math.cos(turned.yaw - yaw))).toBeCloseTo(0.5, 6);

        const [cx, cy] = pixelOf(context, ring.center);
        const [ax, ay] = pixelOf(context, onRing(yaw));
        const [bx, by] = pixelOf(context, onRing(yaw + 0.5));
        // Screen y runs down, so a counter-clockwise sweep has a negative cross product.
        expect((ax - cx) * (by - cy) - (ay - cy) * (bx - cx)).toBeLessThan(0);
        expect(turned.center).toEqual(box.geometry.center);
      });
    }
  }
});

describe("drawing across the two views", () => {
  for (const frame of FRAMES) {
    it(`a footprint drawn top-down keeps its height there, and the perspective view lifts it (${frame})`, () => {
      const store = new AnnotatorStore<ScanDocument>(scanDocumentOf());
      const tool = { kind: "cuboid", labelClass: "car" } as const;
      const top = (): ScanContext => topDownOf(store.document, frame, { tool, selection: store.selection });
      const perspective = (): ScanContext => contextOf(store.document, { tool, frame, selection: store.selection });
      const turn = (state: ScanState, event: ScanEvent, context: ScanContext): ScanState => {
        const next = scanTransition(state, event, context);
        runScanEffects(store, next.effects);
        return next.state;
      };

      let state = turn(SCAN_IDLE, down(pixelOf(top(), fromForwardLeftUp(frame, [2, 1, 0]))), top());
      state = turn(state, move(pixelOf(top(), fromForwardLeftUp(frame, [6, -1, 0]))), top());
      state = turn(state, up(pixelOf(top(), fromForwardLeftUp(frame, [6, -1, 0]))), top());
      expect(state).toMatchObject({ type: "drawing-height", height: MIN_CUBOID_SIZE });
      state = turn(state, move([10, 10]), top());
      expect(state).toMatchObject({ type: "drawing-height", height: MIN_CUBOID_SIZE });

      const base = fromForwardLeftUp(frame, [4, 0, 0]);
      state = turn(state, move(pixelOf(perspective(), add(base, fromForwardLeftUp(frame, [0, 0, 1.8])))), perspective());
      expect(state.type === "drawing-height" ? state.height : 0).toBeCloseTo(1.8, 3);
      state = turn(state, down([400, 300]), top());
      expect(state).toEqual(SCAN_IDLE);
      const [drawn] = store.document.annotations.values();
      expect(drawn?.geometry.size[0]).toBeCloseTo(4, 3);
      expect(drawn?.geometry.size[1]).toBeCloseTo(2, 3);
      expect(drawn?.geometry.size[2]).toBeCloseTo(1.8, 3);
    });
  }
});
