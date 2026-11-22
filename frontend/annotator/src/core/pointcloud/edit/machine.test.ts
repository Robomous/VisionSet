import { describe, expect, it } from "vitest";

import { mulberry32, SEEDS } from "../../_random";
import { NO_MODIFIERS } from "../../interaction/events";
import { EMPTY_SELECTION, selectOnly } from "../../state/selection";
import { AnnotatorStore } from "../../state/store";
import type { Cuboid3DGeometry, Point, Point3D } from "../../types";
import { faceCenter, headingOfYaw, MIN_CUBOID_SIZE } from "../cuboid";
import { contextOf, pixelOf, scanBox, scanDocumentOf } from "./_scan";
import {
  draftCuboid,
  SCAN_IDLE,
  scanTransition,
  type ScanContext,
  type ScanEvent,
  type ScanState,
  type ScanTransition,
} from "./machine";
import { runScanEffects } from "./runScanEffects";
import { yawRing } from "./scene";
import type { ScanDocument } from "./scanDocument";

const down = (point: Point): ScanEvent => ({ type: "pointer-down", point, button: "primary", modifiers: NO_MODIFIERS });
const move = (point: Point): ScanEvent => ({ type: "pointer-move", point });
const up = (point: Point): ScanEvent => ({ type: "pointer-up", point, button: "primary", modifiers: NO_MODIFIERS });

function expectClose(actual: readonly number[], expected: readonly number[], digits = 6): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], digits));
}

function staged(turn: ScanTransition): Cuboid3DGeometry {
  const effect = turn.effects.find((one) => one.kind === "stage");
  if (effect?.kind !== "stage") throw new Error(`no stage among ${JSON.stringify(turn.effects)}`);
  return effect.geometry;
}

/** Feed events through the machine and a real store, as an adapter would. */
function drive(store: AnnotatorStore<ScanDocument>, context: () => ScanContext, events: readonly ScanEvent[], from: ScanState = SCAN_IDLE): ScanState {
  let state = from;
  for (const event of events) {
    const turn = scanTransition(state, event, context());
    runScanEffects(store, turn.effects);
    state = turn.state;
  }
  return state;
}

describe("drawing a cuboid", () => {
  const context = contextOf(scanDocumentOf(), { tool: { kind: "cuboid", labelClass: "car" } });

  it("drags a footprint on the ground, lifts a height, and adds one human box", () => {
    const anchor = pixelOf(context, [2, -1, 0]);
    const corner = pixelOf(context, [6, 1, 0]);
    let state = scanTransition(SCAN_IDLE, down(anchor), context).state;
    expect(state.type).toBe("drawing-footprint");
    state = scanTransition(state, move(corner), context).state;
    expectClose(draftCuboid(state, context)?.size ?? [], [4, 2, MIN_CUBOID_SIZE]);
    state = scanTransition(state, up(corner), context).state;
    expect(state).toMatchObject({ type: "drawing-height", length: expect.closeTo(4, 6), width: expect.closeTo(2, 6) });

    state = scanTransition(state, move(pixelOf(context, [4, 0, 1.5])), context).state;
    const draft = draftCuboid(state, context);
    expectClose(draft?.center ?? [], [4, 0, 0.75]);
    expectClose(draft?.size ?? [], [4, 2, 1.5]);

    const finished = scanTransition(state, down(pixelOf(context, [4, 0, 1.5])), context);
    expect(finished.state).toBe(SCAN_IDLE);
    const [add, select] = finished.effects;
    expect(add.kind).toBe("add");
    if (add.kind !== "add") return;
    expect(add.label).toBe("draw car");
    expect(add.annotation).toMatchObject({
      id: "drawn-1",
      asset_id: "scan-1",
      label_class: "car",
      schema_version: 3,
      attributes: { parked: false },
      provenance: "human",
      model_ref: null,
      confidence: null,
    });
    expect(add.annotation.geometry.yaw).toBe(0);
    expectClose(add.annotation.geometry.center, [4, 0, 0.75]);
    expect(select).toEqual({ kind: "select", selection: selectOnly("drawn-1") });
  });

  it("Enter finishes a height as a click does; Escape draws nothing", () => {
    const height: ScanState = { type: "drawing-height", labelClass: "car", base: [0, 0, 0], length: 2, width: 1, height: 1 };
    expect(scanTransition(height, { type: "commit" }, context).effects[0].kind).toBe("add");
    expect(scanTransition(height, { type: "cancel" }, context)).toEqual({ state: SCAN_IDLE, effects: [] });
  });

  it("a click without a drag is no footprint", () => {
    const at = pixelOf(context, [1, 1, 0]);
    const pressed = scanTransition(SCAN_IDLE, down(at), context).state;
    expect(scanTransition(pressed, up(at), context)).toEqual({ state: SCAN_IDLE, effects: [] });
  });

  it("a press on the sky starts nothing", () => {
    const level = contextOf(scanDocumentOf(), {
      tool: { kind: "cuboid", labelClass: "car" },
      camera: { yaw: 0, pitch: 0, distance: 10, target: [0, 0, 1] },
    });
    expect(scanTransition(SCAN_IDLE, down([400, 10]), level).state).toBe(SCAN_IDLE);
  });

  it("only a primary press draws: orbit belongs to the adapter", () => {
    const secondary: ScanEvent = { type: "pointer-down", point: [400, 300], button: "secondary", modifiers: NO_MODIFIERS };
    expect(scanTransition(SCAN_IDLE, secondary, context).state).toBe(SCAN_IDLE);
  });
});

describe("editing a cuboid", () => {
  const box = scanBox("car-1");
  const selected = contextOf(scanDocumentOf(box), { selection: selectOnly("car-1") });

  it("a press on a body selects it and a drag moves it level, committed once", () => {
    const context = contextOf(scanDocumentOf(box));
    const pressed = scanTransition(SCAN_IDLE, down(pixelOf(context, [0.5, 0.2, 2])), context);
    expect(pressed.state.type).toBe("moving");
    expect(pressed.effects).toEqual([{ kind: "select", selection: selectOnly("car-1") }]);
    const dragged = scanTransition(pressed.state, move(pixelOf(context, [3.5, 1.2, 2])), context);
    expectClose(staged(dragged).center, [3, 1, 1]);
    expect(staged(dragged).size).toEqual(box.geometry.size);
    expect(scanTransition(dragged.state, up([0, 0]), context).effects).toEqual([{ kind: "commit", label: "move car" }]);
  });

  it("a face handle resizes along its normal with the opposite face held", () => {
    const front = faceCenter(box.geometry, "lidar_flu", "front");
    const pressed = scanTransition(SCAN_IDLE, down(pixelOf(selected, front)), selected);
    expect(pressed.state).toMatchObject({ type: "resizing", face: "front" });
    const pulled = staged(scanTransition(pressed.state, move(pixelOf(selected, [front[0] + 1, front[1], front[2]])), selected));
    expectClose(pulled.size, [5, 2, 2]);
    expectClose(pulled.center, [0.5, 0, 1]);
  });

  it("the top handle sets the height and never inverts the box", () => {
    const top = faceCenter(box.geometry, "lidar_flu", "top");
    const pressed = scanTransition(SCAN_IDLE, down(pixelOf(selected, top)), selected);
    expect(pressed.state).toMatchObject({ type: "resizing", face: "top" });
    const crushed = staged(scanTransition(pressed.state, move(pixelOf(selected, [0, 0, -5])), selected));
    expect(crushed.size[2]).toBe(MIN_CUBOID_SIZE);
    expectClose([crushed.center[2]], [MIN_CUBOID_SIZE / 2]);
  });

  it("the yaw ring turns the box about up by the angle swept", () => {
    const ring = yawRing(box.geometry, "lidar_flu");
    const onRing = (angle: number): Point3D => [ring.radius * Math.cos(angle), ring.radius * Math.sin(angle), 0];
    const pressed = scanTransition(SCAN_IDLE, down(pixelOf(selected, onRing(Math.PI / 4))), selected);
    expect(pressed.state.type).toBe("rotating");
    const turned = staged(scanTransition(pressed.state, move(pixelOf(selected, onRing(Math.PI / 4 + 0.5))), selected));
    expect(turned.yaw).toBeCloseTo(0.5, 6);
    expect(turned.center).toEqual(box.geometry.center);
  });

  it("a turn past π wraps into [-π, π]", () => {
    const near = scanBox("car-1", { yaw: 3 });
    const context = contextOf(scanDocumentOf(near), { selection: selectOnly("car-1") });
    const ring = yawRing(near.geometry, "lidar_flu");
    const rotating: ScanState = { type: "rotating", id: "car-1", origin: near.geometry, start: 0, level: ring.level };
    const target: Point3D = [ring.radius * Math.cos(0.5), ring.radius * Math.sin(0.5), 0];
    const turned = staged(scanTransition(rotating, move(pixelOf(context, target)), context));
    expect(turned.yaw).toBeCloseTo(3.5 - 2 * Math.PI, 6);
  });

  it("Escape and a lost pointer discard the drag", () => {
    const moving: ScanState = { type: "moving", id: "car-1", origin: box.geometry, grab: [0, 0, 2], level: 2 };
    for (const event of [{ type: "cancel" }, { type: "pointer-cancel" }] as const) {
      expect(scanTransition(moving, event, selected)).toEqual({ state: SCAN_IDLE, effects: [{ kind: "discard" }] });
    }
  });

  it("a drag whose box was undone away ends rather than staging a ghost", () => {
    const moving: ScanState = { type: "moving", id: "car-1", origin: box.geometry, grab: [0, 0, 2], level: 2 };
    const gone = contextOf(scanDocumentOf());
    expect(scanTransition(moving, move([400, 300]), gone)).toEqual({ state: SCAN_IDLE, effects: [{ kind: "discard" }] });
  });

  it("a press on open ground clears the selection; a toggle-press toggles without moving", () => {
    expect(scanTransition(SCAN_IDLE, down(pixelOf(selected, [-9, 9, 0])), selected).effects).toEqual([
      { kind: "select", selection: EMPTY_SELECTION },
    ]);
    const toggle: ScanEvent = {
      type: "pointer-down",
      point: pixelOf(selected, [0.5, 0.2, 2]),
      button: "primary",
      modifiers: { ...NO_MODIFIERS, ctrl: true },
    };
    const turn = scanTransition(SCAN_IDLE, toggle, contextOf(scanDocumentOf(box)));
    expect(turn).toEqual({ state: SCAN_IDLE, effects: [{ kind: "select", selection: selectOnly("car-1") }] });
  });

  it("delete-selected removes the selected boxes the document still holds", () => {
    expect(scanTransition(SCAN_IDLE, { type: "delete-selected" }, selected).effects).toEqual([
      { kind: "remove", label: "delete", ids: ["car-1"] },
    ]);
    expect(scanTransition(SCAN_IDLE, { type: "delete-selected" }, contextOf(scanDocumentOf(box))).effects).toEqual([]);
  });
});

describe("through the store", () => {
  it("a draw is one undo step, and a drag writes nothing until pointer-up", () => {
    const store = new AnnotatorStore<ScanDocument>(scanDocumentOf());
    let tool: ScanContext["tool"] = { kind: "cuboid", labelClass: "car" };
    const context = () => contextOf(store.document, { selection: store.selection, tool });
    const c = context();
    drive(store, context, [
      down(pixelOf(c, [0, 0, 0])),
      move(pixelOf(c, [4, 2, 0])),
      up(pixelOf(c, [4, 2, 0])),
      move(pixelOf(c, [2, 1, 1.5])),
      down(pixelOf(c, [2, 1, 1.5])),
    ]);
    const [drawn] = store.document.annotations.values();
    expect(drawn.provenance).toBe("human");
    expect(store.selection).toEqual(selectOnly(drawn.id));

    tool = { kind: "select" };
    const moving = drive(store, context, [down(pixelOf(c, [3.2, 1.5, 1.5])), move(pixelOf(c, [6.2, 1.5, 1.5]))]);
    expect(moving.type).toBe("moving");
    expect(store.preview?.annotations.get(drawn.id)?.geometry.center[0]).toBeCloseTo(5, 6);
    expect(store.document.annotations.get(drawn.id)?.geometry.center[0]).toBeCloseTo(2, 6);
    drive(store, context, [up([0, 0])], moving);
    expect(store.document.annotations.get(drawn.id)?.geometry.center[0]).toBeCloseTo(5, 6);

    expect(store.undo()).toBe(true);
    expect(store.document.annotations.get(drawn.id)?.geometry.center[0]).toBeCloseTo(2, 6);
    expect(store.undo()).toBe(true);
    expect(store.document.annotations.size).toBe(0);
    expect(store.redo()).toBe(true);
    expect(store.document.annotations.get(drawn.id)).toEqual(drawn);
  });

  it("an edit keeps the stored provenance, so an imported box stays an import", () => {
    const store = new AnnotatorStore<ScanDocument>(scanDocumentOf(scanBox("car-1")));
    const context = () => contextOf(store.document, { selection: store.selection });
    const c = context();
    drive(store, context, [down(pixelOf(c, [0, 0, 2])), move(pixelOf(c, [1, 0, 2])), up([0, 0])]);
    const edited = store.document.annotations.get("car-1");
    expect(edited?.geometry.center[0]).toBeCloseTo(1, 6);
    expect(edited?.provenance).toBe("import");
  });

  for (const seed of SEEDS) {
    it(`random drags keep every box valid, and unwinding them restores the start (seed ${seed})`, () => {
      const random = mulberry32(seed);
      const start = scanDocumentOf(scanBox("a"), scanBox("b", { center: [8, -4, 1], yaw: -2.5 }));
      const store = new AnnotatorStore<ScanDocument>(start);
      const context = () => contextOf(store.document, { selection: store.selection });
      const somewhere = (): Point => [100 + random() * 600, 80 + random() * 440];
      let committed = 0;

      for (let step = 0; step < 25; step += 1) {
        const ids = [...store.document.annotations.keys()];
        const id = ids[Math.floor(random() * ids.length)];
        const geometry = store.document.annotations.get(id)?.geometry;
        if (geometry === undefined) continue;
        store.select(selectOnly(id));
        const c = context();
        const pick = random();
        const target: Point3D =
          pick < 0.4
            ? faceCenter(geometry, "lidar_flu", (["front", "back", "left", "right", "top"] as const)[Math.floor(random() * 5)])
            : pick < 0.7
              ? (() => {
                  const ring = yawRing(geometry, "lidar_flu");
                  const heading = headingOfYaw(geometry.yaw + Math.PI / 4, "lidar_flu");
                  return [ring.center[0] + heading[0] * ring.radius, ring.center[1] + heading[1] * ring.radius, ring.level];
                })()
              : geometry.center;
        const before = store.document;
        const state = drive(store, context, [down(pixelOf(c, target)), move(somewhere()), move(somewhere())]);
        drive(store, context, [random() < 0.2 ? { type: "cancel" } : up([0, 0])], state);
        if (store.document !== before) committed += 1;

        for (const annotation of store.document.annotations.values()) {
          const { center, size, yaw } = annotation.geometry;
          expect([...center, ...size, yaw].every(Number.isFinite)).toBe(true);
          expect(Math.min(...size)).toBeGreaterThanOrEqual(MIN_CUBOID_SIZE);
          expect(Math.abs(yaw)).toBeLessThanOrEqual(Math.PI);
        }
      }

      expect(committed).toBeGreaterThan(5);
      while (store.undo()) {
        /* unwind */
      }
      expect(store.document).toBe(start);
    });
  }
});
