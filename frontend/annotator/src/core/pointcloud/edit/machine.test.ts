import { describe, expect, it } from "vitest";

import { mulberry32, SEEDS } from "../../_random";
import { NO_MODIFIERS } from "../../interaction/events";
import { EMPTY_SELECTION, selectOnly } from "../../state/selection";
import { AnnotatorStore } from "../../state/store";
import type { Cuboid3DGeometry, Point, Point3D, Polyline3DGeometry } from "../../types";
import { topDownCamera, type OrbitCamera } from "../camera";
import { CUBOID_FACES, cuboidAxes, faceCenter, headingOfYaw, MIN_CUBOID_SIZE, type CuboidFace } from "../cuboid";
import type { PointSample } from "../decode";
import { fromForwardLeftUp, heightOf, type ScanFrame } from "../frame";
import { add, scale } from "../vector";
import { contextOf, cuboidOf, LOOKING_DOWN, pixelOf, polylineOf, scanBox, scanDocumentOf, scanLine } from "./_scan";
import {
  draftCuboid,
  draftPolyline,
  SCAN_IDLE,
  scanTransition,
  type ScanContext,
  type ScanEvent,
  type ScanState,
  type ScanTransition,
} from "./machine";
import { runScanEffects } from "./runScanEffects";
import { yawRing } from "./scene";
import { removeScanAnnotations, replaceScanAnnotation, type ScanDocument } from "./scanDocument";
import { documentCommand } from "../../state/commands";

const down = (point: Point): ScanEvent => ({ type: "pointer-down", point, button: "primary", modifiers: NO_MODIFIERS });
const move = (point: Point): ScanEvent => ({ type: "pointer-move", point });
const up = (point: Point): ScanEvent => ({ type: "pointer-up", point, button: "primary", modifiers: NO_MODIFIERS });

function expectClose(actual: readonly number[], expected: readonly number[], digits = 6): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], digits));
}

function stagedGeometry(turn: ScanTransition): Cuboid3DGeometry | Polyline3DGeometry {
  const effect = turn.effects.find((one) => one.kind === "stage");
  if (effect?.kind !== "stage") throw new Error(`no stage among ${JSON.stringify(turn.effects)}`);
  return effect.geometry;
}

function staged(turn: ScanTransition): Cuboid3DGeometry {
  const geometry = stagedGeometry(turn);
  if (geometry.type !== "cuboid_3d") throw new Error("staged a polyline");
  return geometry;
}

function stagedPolyline(turn: ScanTransition): Polyline3DGeometry {
  const geometry = stagedGeometry(turn);
  if (geometry.type !== "polyline_3d") throw new Error("staged a cuboid");
  return geometry;
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

  it("drags a length on the ground, sets a width, lifts a height, and adds one human box", () => {
    const anchor = pixelOf(context, [2, -1, 0]);
    const end = pixelOf(context, [6, -1, 0]);
    let state = scanTransition(SCAN_IDLE, down(anchor), context).state;
    expect(state.type).toBe("drawing-footprint");
    state = scanTransition(state, move(end), context).state;
    expectClose(draftCuboid(state, context)?.size ?? [], [4, MIN_CUBOID_SIZE, MIN_CUBOID_SIZE]);
    state = scanTransition(state, up(end), context).state;
    expect(state).toMatchObject({ type: "drawing-width", length: expect.closeTo(4, 6), yaw: 0 });

    state = scanTransition(state, move(pixelOf(context, [5, 1, 0])), context).state;
    expectClose(draftCuboid(state, context)?.size ?? [], [4, 2, MIN_CUBOID_SIZE]);
    expectClose(draftCuboid(state, context)?.center ?? [], [4, 0, MIN_CUBOID_SIZE / 2]);
    state = scanTransition(state, down(pixelOf(context, [5, 1, 0])), context).state;
    state = scanTransition(state, up(pixelOf(context, [5, 1, 0])), context).state;
    expect(state).toMatchObject({ type: "drawing-height", length: expect.closeTo(4, 6), width: expect.closeTo(2, 6), yaw: 0 });

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
    expect(cuboidOf(add.annotation).geometry.yaw).toBe(0);
    expectClose(cuboidOf(add.annotation).geometry.center, [4, 0, 0.75]);
    expect(select).toEqual({ kind: "select", selection: selectOnly("drawn-1") });
  });

  it("Enter finishes a height as a click does; Escape draws nothing", () => {
    const height: ScanState = { type: "drawing-height", labelClass: "car", base: [0, 0, 0], length: 2, width: 1, yaw: 0, height: 1, anchor: [-1, -0.5, 0], offset: 1 };
    expect(scanTransition(height, { type: "commit" }, context).effects[0].kind).toBe("add");
    expect(scanTransition(height, { type: "cancel" }, context)).toEqual({ state: SCAN_IDLE, effects: [] });
  });

  it("Enter sets a width as a click does; Escape draws nothing", () => {
    const width: ScanState = { type: "drawing-width", labelClass: "car", anchor: [0, 0, 0], length: 2, yaw: 0, offset: 1 };
    expect(scanTransition(width, { type: "commit" }, context).state).toMatchObject({ type: "drawing-height", width: 1 });
    expect(scanTransition(width, { type: "cancel" }, context)).toEqual({ state: SCAN_IDLE, effects: [] });
  });

  it("a click without a drag is no footprint", () => {
    const at = pixelOf(context, [1, 1, 0]);
    const pressed = scanTransition(SCAN_IDLE, down(at), context).state;
    expect(scanTransition(pressed, up(at), context)).toEqual({ state: SCAN_IDLE, effects: [] });
  });

  it("a drag shorter than the smallest extent draws nothing, and previews at yaw 0", () => {
    const anchor: Point3D = [1, 1, 0];
    const end: Point3D = [1 + MIN_CUBOID_SIZE * 0.4, 1 + MIN_CUBOID_SIZE * 0.4, 0];
    let state = scanTransition(SCAN_IDLE, down(pixelOf(context, anchor)), context).state;
    state = scanTransition(state, move(pixelOf(context, end)), context).state;
    expect(draftCuboid(state, context)?.yaw).toBe(0);
    expect(scanTransition(state, up(pixelOf(context, end)), context)).toEqual({ state: SCAN_IDLE, effects: [] });
  });

  describe("a new cuboid's yaw follows the length drag", () => {
    const FRAMES: readonly ScanFrame[] = ["lidar_flu", "camera_rdf", "lidar_rfu"];
    const THIRTY = Math.PI / 6;

    /** Drag the length from `anchor` along `[forward, left]`, set the width at `side` metres to its left, raise 1.5 m, finish. */
    function draw(frame: ScanFrame, anchor: readonly [number, number], drag: readonly [number, number], side: number): Cuboid3DGeometry {
      const context = contextOf(scanDocumentOf(), { tool: { kind: "cuboid", labelClass: "car" }, frame });
      const at = (f: number, l: number, u = 0) => pixelOf(context, fromForwardLeftUp(frame, [f, l, u]));
      const length = Math.hypot(drag[0], drag[1]);
      const [cos, sin] = [drag[0] / length, drag[1] / length];
      const end = [anchor[0] + drag[0], anchor[1] + drag[1]] as const;
      const widthAt = at(end[0] - sin * side, end[1] + cos * side);
      const middle = [anchor[0] + drag[0] / 2 - (sin * side) / 2, anchor[1] + drag[1] / 2 + (cos * side) / 2] as const;
      let state = scanTransition(SCAN_IDLE, down(at(...anchor)), context).state;
      for (const event of [move(at(...end)), up(at(...end)), move(widthAt), down(widthAt), up(widthAt), move(at(...middle, 1.5))]) {
        state = scanTransition(state, event, context).state;
      }
      const finished = scanTransition(state, down(at(...middle, 1.5)), context);
      const added = finished.effects.find((effect) => effect.kind === "add");
      if (added?.kind !== "add") throw new Error("no box drawn");
      return cuboidOf(added.annotation).geometry;
    }

    it("a drag at 30 degrees yields yaw 30 degrees, its length along the drag and the width across it", () => {
      const box = draw("lidar_flu", [1, -2], [4 * Math.cos(THIRTY), 4 * Math.sin(THIRTY)], 1.5);
      expect(box.yaw).toBeCloseTo(THIRTY, 6);
      expectClose(box.size, [4, 1.5, 1.5], 4);
      const middle: Point3D = [1 + 2 * Math.cos(THIRTY) - 0.75 * Math.sin(THIRTY), -2 + 2 * Math.sin(THIRTY) + 0.75 * Math.cos(THIRTY), 0.75];
      expectClose(box.center, middle, 4);
    });

    it("a drag along forward still yields yaw 0", () => {
      const box = draw("lidar_flu", [0, 0], [3, 0], 2);
      expect(box.yaw).toBe(0);
      expectClose(box.size, [3, 2, 1.5], 4);
    });

    it("a width set on the right of the length keeps every extent positive", () => {
      const box = draw("lidar_flu", [0, 0], [3, 0], -2);
      expectClose(box.size, [3, 2, 1.5], 4);
      expectClose(box.center, [1.5, -1, 0.75], 4);
    });

    for (const frame of FRAMES) {
      it(`in ${frame}, the box's length axis runs along the drag`, () => {
        const drag = [4 * Math.cos(THIRTY), 4 * Math.sin(THIRTY)] as const;
        const box = draw(frame, [1, -2], drag, 1.5);
        expect(box.yaw).toBeCloseTo(THIRTY, 6);
        expectClose(cuboidAxes(box, frame)[0], fromForwardLeftUp(frame, [Math.cos(THIRTY), Math.sin(THIRTY), 0]), 6);
        expectClose(headingOfYaw(box.yaw, frame), cuboidAxes(box, frame)[0], 6);
        expectClose(box.size, [4, 1.5, 1.5], 4);
      });
    }
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
    const back = faceCenter(box.geometry, "lidar_flu", "back");
    const pressed = scanTransition(SCAN_IDLE, down(pixelOf(selected, back)), selected);
    expect(pressed.state).toMatchObject({ type: "resizing", face: "back" });
    const pulled = staged(scanTransition(pressed.state, move(pixelOf(selected, [back[0] - 1, back[1], back[2]])), selected));
    expectClose(pulled.size, [5, 2, 2]);
    expectClose(pulled.center, [-0.5, 0, 1]);
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
    const rotating: ScanState = { type: "rotating", id: "car-1", origin: near.geometry, committed: near.geometry, start: 0, level: ring.level };
    const target: Point3D = [ring.radius * Math.cos(0.5), ring.radius * Math.sin(0.5), 0];
    const turned = staged(scanTransition(rotating, move(pixelOf(context, target)), context));
    expect(turned.yaw).toBeCloseTo(3.5 - 2 * Math.PI, 6);
  });

  it("Escape and a lost pointer discard the drag", () => {
    const moving: ScanState = { type: "moving", id: "car-1", origin: box.geometry, committed: box.geometry, grab: [0, 0, 2], level: 2 };
    for (const event of [{ type: "cancel" }, { type: "pointer-cancel" }] as const) {
      expect(scanTransition(moving, event, selected)).toEqual({ state: SCAN_IDLE, effects: [{ kind: "discard" }] });
    }
  });

  it("a drag whose box was undone away ends rather than staging a ghost", () => {
    const moving: ScanState = { type: "moving", id: "car-1", origin: box.geometry, committed: box.geometry, grab: [0, 0, 2], level: 2 };
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

describe("every face handle, in every frame", () => {
  const frames: readonly ScanFrame[] = ["lidar_flu", "camera_rdf", "lidar_rfu"];
  const turns = { front: 0, back: Math.PI, left: Math.PI / 2, right: -Math.PI / 2, top: 0.3, bottom: 0.3 } as const;

  /** A camera the face points towards: level-ish beside a side face, above the top, below the bottom. */
  function facing(geometry: Cuboid3DGeometry, frame: ScanFrame, face: CuboidFace): OrbitCamera {
    const below = face === "bottom" ? fromForwardLeftUp(frame, [0, 0, -20]) : [0, 0, 0] as const;
    return {
      yaw: geometry.yaw + turns[face],
      pitch: face === "top" ? 1.2 : face === "bottom" ? 0.3 : 0.5,
      distance: 30,
      target: add(geometry.center, below),
    };
  }
  const opposite = { front: "back", back: "front", left: "right", right: "left", top: "bottom", bottom: "top" } as const;

  for (const frame of frames) {
    for (const yaw of [0, 0.7, -2.4]) {
      for (const { face, axis, sign } of CUBOID_FACES) {
        for (const distance of [1.5, -0.5]) {
          const verb = distance > 0 ? "out" : "in";
          it(`dragging ${face} ${verb} by ${Math.abs(distance)} m moves only that face (${frame}, yaw ${yaw})`, () => {
            const box = scanBox("car-1", { center: fromForwardLeftUp(frame, [1, -0.5, 1.5]), size: [5, 3, 3], yaw });
            const context = contextOf(scanDocumentOf(box), { selection: selectOnly("car-1"), frame, camera: facing(box.geometry, frame, face) });
            const origin = box.geometry;
            const grabbed = faceCenter(origin, frame, face);
            const outward = scale(cuboidAxes(origin, frame)[axis], sign);

            const pressed = scanTransition(SCAN_IDLE, down(pixelOf(context, grabbed)), context);
            expect(pressed.state).toMatchObject({ type: "resizing", face });
            const pulled = staged(scanTransition(pressed.state, move(pixelOf(context, add(grabbed, scale(outward, distance)))), context));

            const size = [...origin.size];
            size[axis] += distance;
            expectClose(pulled.size, size, 4);
            expectClose(faceCenter(pulled, frame, opposite[face]), faceCenter(origin, frame, opposite[face]), 4);
            expectClose(faceCenter(pulled, frame, face), add(grabbed, scale(outward, distance)), 4);
            expect(pulled.yaw).toBe(yaw);
          });
        }
      }
    }
  }
});

describe("through the store", () => {
  it("a draw is one undo step, and a drag writes nothing until pointer-up", () => {
    const store = new AnnotatorStore<ScanDocument>(scanDocumentOf());
    let tool: ScanContext["tool"] = { kind: "cuboid", labelClass: "car" };
    const context = () => contextOf(store.document, { selection: store.selection, tool });
    const c = context();
    drive(store, context, [
      down(pixelOf(c, [0, 0, 0])),
      move(pixelOf(c, [4, 0, 0])),
      up(pixelOf(c, [4, 0, 0])),
      move(pixelOf(c, [4, 2, 0])),
      down(pixelOf(c, [4, 2, 0])),
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
    expect(cuboidOf(store.preview?.annotations.get(drawn.id)).geometry.center[0]).toBeCloseTo(5, 6);
    expect(cuboidOf(store.document.annotations.get(drawn.id)).geometry.center[0]).toBeCloseTo(2, 6);
    drive(store, context, [up([0, 0])], moving);
    expect(cuboidOf(store.document.annotations.get(drawn.id)).geometry.center[0]).toBeCloseTo(5, 6);

    expect(store.undo()).toBe(true);
    expect(cuboidOf(store.document.annotations.get(drawn.id)).geometry.center[0]).toBeCloseTo(2, 6);
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
    const edited = cuboidOf(store.document.annotations.get("car-1"));
    expect(edited.geometry.center[0]).toBeCloseTo(1, 6);
    expect(edited.provenance).toBe("import");
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
        const geometry = cuboidOf(store.document.annotations.get(id)).geometry;
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
          const { center, size, yaw } = cuboidOf(annotation).geometry;
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

describe("drawing a polyline", () => {
  const context = contextOf(scanDocumentOf(), { tool: { kind: "polyline", labelClass: "lane" } });

  it("draws a polyline over three clicks and commits on commit", () => {
    let state = scanTransition(SCAN_IDLE, down(pixelOf(context, [1, -1, 0])), context).state;
    expect(state.type).toBe("drawing-polyline");
    expect(draftPolyline(state)?.points).toHaveLength(1);
    state = scanTransition(state, move(pixelOf(context, [3, -1, 0])), context).state;
    expect(draftPolyline(state)?.points).toHaveLength(2);
    state = scanTransition(state, down(pixelOf(context, [3, -1, 0])), context).state;
    state = scanTransition(state, down(pixelOf(context, [5, 0, 0])), context).state;

    const finished = scanTransition(state, { type: "commit" }, context);
    expect(finished.state).toBe(SCAN_IDLE);
    const [add, select] = finished.effects;
    if (add?.kind !== "add") throw new Error("no add");
    expect(add.label).toBe("draw lane");
    expect(add.annotation).toMatchObject({
      id: "drawn-1",
      label_class: "lane",
      attributes: { dashed: true },
      provenance: "human",
      model_ref: null,
    });
    const geometry = polylineOf(add.annotation).geometry;
    expect(geometry.visibility).toBeUndefined();
    [[1, -1, 0], [3, -1, 0], [5, 0, 0]].forEach((p, i) => expectClose(geometry.points[i] ?? [], p));
    expect(select).toEqual({ kind: "select", selection: selectOnly("drawn-1") });
    expect(draftPolyline(finished.state)).toBeNull();
  });

  it("commit with one vertex is refused and keeps drafting", () => {
    const at = pixelOf(context, [1, 1, 0]);
    let state = scanTransition(SCAN_IDLE, down(at), context).state;
    state = scanTransition(state, down(at), context).state;
    expect(state).toMatchObject({ type: "drawing-polyline", points: [expect.anything()] });
    expect(scanTransition(state, { type: "commit" }, context)).toEqual({ state, effects: [] });
  });

  it("commit with two identical vertices is refused", () => {
    const state: ScanState = { type: "drawing-polyline", labelClass: "lane", points: [[1, 1, 0], [1, 1, 0]], cursor: null };
    expect(scanTransition(state, { type: "commit" }, context)).toEqual({ state, effects: [] });
  });

  it("cancel while drawing adds nothing", () => {
    const state: ScanState = { type: "drawing-polyline", labelClass: "lane", points: [[1, 1, 0], [2, 1, 0]], cursor: null };
    expect(scanTransition(state, { type: "cancel" }, context)).toEqual({ state: SCAN_IDLE, effects: [] });
  });
});

describe("editing a polyline", () => {
  const lane = scanLine("lane-1", [[-4, 6, 0], [0, 6, 0], [4, 6, 0]]);
  const selected = contextOf(scanDocumentOf(lane), { selection: selectOnly("lane-1") });
  const alt = (point: Point): ScanEvent => ({ type: "pointer-down", point, button: "primary", modifiers: { ...NO_MODIFIERS, alt: true } });

  it("dragging a vertex stages the moved polyline and commits once on pointer-up", () => {
    const raised = scanLine("lane-1", [[-4, 6, 1], [0, 6, 1], [4, 6, 1]]);
    const store = new AnnotatorStore<ScanDocument>(scanDocumentOf(raised));
    store.select(selectOnly("lane-1"));
    const context = () => contextOf(store.document, { selection: store.selection });
    const c = context();
    const pressed = scanTransition(SCAN_IDLE, down(pixelOf(c, [0, 6, 1])), c);
    expect(pressed).toEqual({ state: { type: "moving-vertex", id: "lane-1", origin: raised.geometry, committed: raised.geometry, index: 1, level: 1 }, effects: [] });
    const dragged = scanTransition(pressed.state, move(pixelOf(c, [1, 7, 1])), c);
    const points = stagedPolyline(dragged).points;
    expectClose(points[1] ?? [], [1, 7, 1]);
    expect([points[0], points[2]]).toEqual([[-4, 6, 1], [4, 6, 1]]);
    expect(scanTransition(dragged.state, up([0, 0]), c).effects).toEqual([{ kind: "commit", label: "move vertex of lane" }]);

    const moving = drive(store, context, [down(pixelOf(c, [0, 6, 1])), move(pixelOf(c, [1, 7, 1]))]);
    expectClose(polylineOf(store.preview?.annotations.get("lane-1")).geometry.points[1] ?? [], [1, 7, 1]);
    expect(polylineOf(store.document.annotations.get("lane-1")).geometry).toEqual(raised.geometry);
    drive(store, context, [up([0, 0])], moving);
    expectClose(polylineOf(store.document.annotations.get("lane-1")).geometry.points[1] ?? [], [1, 7, 1]);
    expect(store.undo()).toBe(true);
    expect(polylineOf(store.document.annotations.get("lane-1")).geometry).toEqual(raised.geometry);
  });

  it("escape while dragging a vertex discards", () => {
    const state: ScanState = { type: "moving-vertex", id: "lane-1", origin: lane.geometry, committed: lane.geometry, index: 1, level: 0 };
    expect(scanTransition(state, { type: "cancel" }, selected)).toEqual({ state: SCAN_IDLE, effects: [{ kind: "discard" }] });
  });

  it("a segment click on an unselected polyline selects it", () => {
    const context = contextOf(scanDocumentOf(lane));
    expect(scanTransition(SCAN_IDLE, down(pixelOf(context, [2, 6, 0])), context)).toEqual({
      state: SCAN_IDLE,
      effects: [{ kind: "select", selection: selectOnly("lane-1") }],
    });
  });

  it("a toggle-click on a segment toggles it in the selection", () => {
    const context = contextOf(scanDocumentOf(lane, scanBox("car-1")), { selection: selectOnly("car-1") });
    const toggle = (modifiers: Partial<typeof NO_MODIFIERS>): ScanEvent => ({
      type: "pointer-down",
      point: pixelOf(context, [2, 6, 0]),
      button: "primary",
      modifiers: { ...NO_MODIFIERS, ...modifiers },
    });
    expect(scanTransition(SCAN_IDLE, toggle({ ctrl: true }), context)).toEqual({
      state: SCAN_IDLE,
      effects: [{ kind: "select", selection: new Set(["car-1", "lane-1"]) }],
    });
    expect(scanTransition(SCAN_IDLE, toggle({ meta: true }), selected)).toEqual({
      state: SCAN_IDLE,
      effects: [{ kind: "select", selection: EMPTY_SELECTION }],
    });
  });

  it("a segment click on the selected polyline inserts and drags a vertex", () => {
    const pressed = scanTransition(SCAN_IDLE, down(pixelOf(selected, [2, 6, 0])), selected);
    expect(pressed.state).toMatchObject({ type: "moving-vertex", id: "lane-1", index: 2, level: expect.closeTo(0, 6) });
    const inserted = stagedPolyline(pressed).points;
    expect(inserted).toHaveLength(4);
    expectClose(inserted[2] ?? [], [2, 6, 0]);
    const dragged = stagedPolyline(scanTransition(pressed.state, move(pixelOf(selected, [2, 7, 0])), selected)).points;
    expect(dragged).toHaveLength(4);
    expectClose(dragged[2] ?? [], [2, 7, 0]);
    expect(scanTransition(pressed.state, up([0, 0]), selected).effects).toEqual([{ kind: "commit", label: "insert vertex of lane" }]);
  });

  it("alt-click removes a vertex", () => {
    const turn = scanTransition(SCAN_IDLE, alt(pixelOf(selected, [0, 6, 0])), selected);
    expect(turn.state).toBe(SCAN_IDLE);
    expect(stagedPolyline(turn).points).toEqual([[-4, 6, 0], [4, 6, 0]]);
    expect(turn.effects.at(-1)).toEqual({ kind: "commit", label: "remove vertex of lane" });
  });

  it("alt-click on a vertex of a two-vertex polyline does nothing", () => {
    const pair = contextOf(scanDocumentOf(scanLine("lane-2", [[-4, 6, 0], [4, 6, 0]])), { selection: selectOnly("lane-2") });
    expect(scanTransition(SCAN_IDLE, alt(pixelOf(pair, [-4, 6, 0])), pair)).toEqual({ state: SCAN_IDLE, effects: [] });
  });

  it("alt-click on a segment of the selected polyline does nothing", () => {
    expect(scanTransition(SCAN_IDLE, alt(pixelOf(selected, [2, 6, 0])), selected)).toEqual({ state: SCAN_IDLE, effects: [] });
  });

  it("alt-click that would leave every vertex in one place does nothing", () => {
    const folded = contextOf(scanDocumentOf(scanLine("lane-3", [[-4, 6, 0], [0, 6, 0], [-4, 6, 0]])), {
      selection: selectOnly("lane-3"),
    });
    expect(scanTransition(SCAN_IDLE, alt(pixelOf(folded, [0, 6, 0])), folded)).toEqual({ state: SCAN_IDLE, effects: [] });
  });

  it("dragging a vertex onto the only other one stages nothing, so the line stays drawable", () => {
    const target = pixelOf(selected, [-4, 7, 0]);
    const probe: ScanState = { type: "moving-vertex", id: "lane-1", origin: lane.geometry, committed: lane.geometry, index: 1, level: 0 };
    const landed = stagedPolyline(scanTransition(probe, move(target), selected)).points[1]!;
    const pair = scanLine("lane-1", [landed, [4, 6, 0]]);
    const context = contextOf(scanDocumentOf(pair), { selection: selectOnly("lane-1") });
    const state: ScanState = { type: "moving-vertex", id: "lane-1", origin: pair.geometry, committed: pair.geometry, index: 1, level: 0 };
    expect(scanTransition(state, move(target), context)).toEqual({ state, effects: [] });
  });
});

describe("snapping polyline vertices to the scan", () => {
  const rampHeight = (x: number): number => (x > 0 ? 0.3 * x : 0);
  const RAMP: PointSample = (() => {
    const points: number[] = [];
    for (let x = -10; x <= 10; x += 0.5) {
      for (let y = -10; y <= 20; y += 0.5) points.push(x, y, rampHeight(x));
    }
    return { count: points.length / 3, positions: new Float32Array(points), origin: [0, 0, 0], intensity: null, rgb: null };
  })();
  const onRamp: Point3D = [4, 2, 1.2];
  const drawing: ScanContext = {
    ...contextOf(scanDocumentOf(), { tool: { kind: "polyline", labelClass: "lane" } }),
    points: RAMP,
    groundHeight: -0.5,
  };

  function drafted(state: ScanState): Extract<ScanState, { type: "drawing-polyline" }> {
    if (state.type !== "drawing-polyline") throw new Error(`not drawing a polyline: ${state.type}`);
    return state;
  }

  it("places a vertex, and the cursor before it, at the height of the point under the pointer", () => {
    const first = drafted(scanTransition(SCAN_IDLE, down(pixelOf(drawing, onRamp)), drawing).state);
    expectClose(first.points[0] ?? [], onRamp, 4);
    const moved = drafted(scanTransition(first, move(pixelOf(drawing, [-4, 2, 0])), drawing).state);
    expectClose(moved.cursor ?? [], [-4, 2, 0], 4);
    const second = drafted(scanTransition(moved, down(pixelOf(drawing, [-4, 2, 0])), drawing).state);
    expectClose(second.points[1] ?? [], [-4, 2, 0], 4);
  });

  it("keeps the pointer's place and takes only the height", () => {
    const between = pixelOf(drawing, [4.25, 2.25, rampHeight(4.25)]);
    const vertex = drafted(scanTransition(SCAN_IDLE, down(between), drawing).state).points[0]!;
    const seen = pixelOf(drawing, vertex);
    expect(Math.hypot(seen[0] - between[0], seen[1] - between[1])).toBeLessThan(1e-6);
    expect(Math.abs(vertex[2] - rampHeight(4.25))).toBeLessThan(0.16);
  });

  it("falls back to the ground plane where no point is near the pointer, or no points are loaded", () => {
    const off = drafted(scanTransition(SCAN_IDLE, down(pixelOf(drawing, [-30, 0, -0.5])), drawing).state);
    expectClose(off.points[0] ?? [], [-30, 0, -0.5], 6);
    const bare = contextOf(scanDocumentOf(), { tool: { kind: "polyline", labelClass: "lane" } });
    expect(drafted(scanTransition(SCAN_IDLE, down(pixelOf(bare, onRamp)), bare).state).points[0]?.[2]).toBeCloseTo(0, 6);
  });

  it("snaps in the top-down view to the topmost point under the pointer", () => {
    const top: ScanContext = { ...drawing, camera: topDownCamera([0, 0, 0], 30), view: "top-down" };
    const state = drafted(scanTransition(SCAN_IDLE, down(pixelOf(top, [6, -3, 1.8])), top).state);
    expectClose(state.points[0] ?? [], [6, -3, 1.8], 4);
  });

  it("drags a vertex onto the surface under the pointer, and off it at its own level", () => {
    const lane = scanLine("lane-1", [[-4, 6, 0], [0, 6, 0.4], [4, 6, 1.2]]);
    const context: ScanContext = { ...contextOf(scanDocumentOf(lane), { selection: selectOnly("lane-1") }), points: RAMP };
    const pressed = scanTransition(SCAN_IDLE, down(pixelOf(context, [0, 6, 0.4])), context);
    expect(pressed.state).toMatchObject({ type: "moving-vertex", index: 1, level: 0.4 });
    const onto = stagedPolyline(scanTransition(pressed.state, move(pixelOf(context, onRamp)), context)).points[1];
    expectClose(onto ?? [], onRamp, 4);
    const off = stagedPolyline(scanTransition(pressed.state, move(pixelOf(context, [-30, 6, 0.4])), context)).points[1];
    expectClose(off ?? [], [-30, 6, 0.4], 6);
  });

  it("inserts a vertex on the surface under the pointer, not on the segment's level", () => {
    const lane = scanLine("lane-1", [[-4, 2, 0], [8, 2, 0]]);
    const context: ScanContext = { ...contextOf(scanDocumentOf(lane), { selection: selectOnly("lane-1") }), points: RAMP };
    const pointer = pixelOf(context, [5, 2, 0]);
    const pressed = scanTransition(SCAN_IDLE, down(pointer), context);
    const vertex = stagedPolyline(pressed).points[1]!;
    expect(vertex[2]).toBeGreaterThan(1);
    expect(Math.abs(vertex[2] - rampHeight(vertex[0]))).toBeLessThan(0.16);
    expect(pressed.state).toMatchObject({ type: "moving-vertex", index: 1, level: vertex[2] });
    const seen = pixelOf(context, vertex);
    expect(Math.hypot(seen[0] - pointer[0], seen[1] - pointer[1])).toBeLessThan(1e-6);
  });

  it("leaves a cuboid's footprint on the ground", () => {
    const boxes: ScanContext = { ...contextOf(scanDocumentOf(), { tool: { kind: "cuboid", labelClass: "car" } }), points: RAMP };
    const state = scanTransition(SCAN_IDLE, down(pixelOf(boxes, onRamp)), boxes).state;
    if (state.type !== "drawing-footprint") throw new Error("not drawing a footprint");
    expect(heightOf("lidar_flu", state.anchor)).toBeCloseTo(0, 6);
  });

  for (const origin of [[8192, -8192, 0], [512_000.25, 4_100_000.5, 120]] as const satisfies readonly Point3D[]) {
    it(`snaps a vertex placed or dragged on a scan whose origin is ${origin.join(", ")}`, () => {
      const far: PointSample = { ...RAMP, origin };
      const lane = scanLine("lane-1", [add(origin, [-4, 2, 0]), add(origin, [0, 2, 0])]);
      const cameras: readonly [OrbitCamera, ScanContext["view"]][] = [
        [{ ...LOOKING_DOWN, target: origin }, "perspective"],
        [topDownCamera(origin, 30), "top-down"],
      ];
      for (const [camera, view] of cameras) {
        const placing: ScanContext = {
          ...contextOf(scanDocumentOf(), { tool: { kind: "polyline", labelClass: "lane" }, camera }),
          ...(view === undefined ? {} : { view }),
          points: far,
          groundHeight: origin[2] - 0.5,
        };
        const target = add(origin, onRamp);
        const placed = drafted(scanTransition(SCAN_IDLE, down(pixelOf(placing, target)), placing).state).points[0]!;
        expectClose(placed, target, 3);

        const editing: ScanContext = {
          ...contextOf(scanDocumentOf(lane), { selection: selectOnly("lane-1"), camera }),
          ...(view === undefined ? {} : { view }),
          points: far,
        };
        const pressed = scanTransition(SCAN_IDLE, down(pixelOf(editing, add(origin, [0, 2, 0]))), editing);
        expect(pressed.state.type).toBe("moving-vertex");
        const dragged = stagedPolyline(scanTransition(pressed.state, move(pixelOf(editing, target)), editing)).points[1];
        expectClose(dragged ?? [], target, 3);
      }
    });
  }
});

describe("a press without a hover", () => {
  const context = contextOf(scanDocumentOf(), { tool: { kind: "cuboid", labelClass: "car" } });
  const footprint = (): ScanState => {
    let state = scanTransition(SCAN_IDLE, down(pixelOf(context, [2, -1, 0])), context).state;
    for (const event of [move(pixelOf(context, [6, -1, 0])), up(pixelOf(context, [6, -1, 0]))]) {
      state = scanTransition(state, event, context).state;
    }
    return state;
  };

  it("takes the width from where a tap lands, not from the last hover", () => {
    const height = scanTransition(footprint(), down(pixelOf(context, [5, 2, 0])), context).state;
    expect(height).toMatchObject({ type: "drawing-height", width: expect.closeTo(3, 6) });
  });

  it("takes the height from where a tap lands, and draws the box the taps describe", () => {
    let state = scanTransition(footprint(), down(pixelOf(context, [5, 2, 0])), context).state;
    state = scanTransition(state, up(pixelOf(context, [5, 2, 0])), context).state;
    const finished = scanTransition(state, down(pixelOf(context, [4, 0.5, 1.5])), context);
    const added = finished.effects.find((effect) => effect.kind === "add");
    if (added?.kind !== "add") throw new Error("no box drawn");
    expectClose(cuboidOf(added.annotation).geometry.size, [4, 3, 1.5], 4);
  });

  it("never reads a height through the top-down view", () => {
    const top: ScanContext = { ...context, camera: topDownCamera([0, 0, 0], 30), view: "top-down" };
    const height: ScanState = { type: "drawing-height", labelClass: "car", base: [4, 0, 0], length: 4, width: 2, yaw: 0, height: 1.2, anchor: [2, -1, 0], offset: 2 };
    const finished = scanTransition(height, down(pixelOf(top, [4, 0, 0])), top);
    const added = finished.effects.find((effect) => effect.kind === "add");
    if (added?.kind !== "add") throw new Error("no box drawn");
    expect(cuboidOf(added.annotation).geometry.size[2]).toBe(1.2);
  });
});

describe("a lost pointer between clicks", () => {
  it("keeps the width, the height and the polyline being drawn: no press is held between clicks", () => {
    const box = contextOf(scanDocumentOf(), { tool: { kind: "cuboid", labelClass: "car" } });
    const line = contextOf(scanDocumentOf(), { tool: { kind: "polyline", labelClass: "lane" } });
    const width: ScanState = { type: "drawing-width", labelClass: "car", anchor: [0, 0, 0], length: 2, yaw: 0, offset: 1 };
    const height: ScanState = { type: "drawing-height", labelClass: "car", base: [1, 0.5, 0], length: 2, width: 1, yaw: 0, height: 1, anchor: [0, 0, 0], offset: 1 };
    const polyline: ScanState = { type: "drawing-polyline", labelClass: "lane", points: [[1, 1, 0], [2, 1, 0]], cursor: null };
    expect(scanTransition(width, { type: "pointer-cancel" }, box)).toEqual({ state: width, effects: [] });
    expect(scanTransition(height, { type: "pointer-cancel" }, box)).toEqual({ state: height, effects: [] });
    expect(scanTransition(polyline, { type: "pointer-cancel" }, line)).toEqual({ state: polyline, effects: [] });
  });
});

describe("undo and redo", () => {
  const line = contextOf(scanDocumentOf(), { tool: { kind: "polyline", labelClass: "lane" } });
  const box = contextOf(scanDocumentOf(), { tool: { kind: "cuboid", labelClass: "car" } });

  it("while drawing a polyline, steps back one vertex at a time and leaves the history alone", () => {
    const store = new AnnotatorStore<ScanDocument>(scanDocumentOf(scanBox("car-1"), scanBox("car-2", { center: [9, 9, 1] })));
    store.select(selectOnly("car-2"));
    drive(store, () => contextOf(store.document, { selection: store.selection }), [{ type: "delete-selected" }]);
    const before = store.document;
    const context = () => ({ ...line, document: store.document });
    const at = (x: number): Point => pixelOf(line, [x, 1, 0]);
    let state = drive(store, context, [1, 2, 3, 4, 5].map((x) => down(at(x))));
    expect(state).toMatchObject({ type: "drawing-polyline", points: { length: 5 } });

    state = drive(store, context, [{ type: "undo" }], state);
    expect(state).toMatchObject({ type: "drawing-polyline", points: { length: 4 } });
    state = drive(store, context, [{ type: "undo" }, { type: "undo" }, { type: "undo" }], state);
    expect(state).toMatchObject({ type: "drawing-polyline", points: [expect.anything()] });
    expect(drive(store, context, [{ type: "undo" }], state)).toBe(SCAN_IDLE);
    expect(store.document).toBe(before);
    expect(store.document.annotations.has("car-2")).toBe(false);
  });

  it("while drawing a cuboid, steps the height back to the width and the width to nothing", () => {
    const width: ScanState = { type: "drawing-width", labelClass: "car", anchor: [0, 0, 0], length: 2, yaw: 0.3, offset: -1.5 };
    const height = scanTransition(width, { type: "commit" }, box).state;
    expect(scanTransition(height, { type: "undo" }, box)).toEqual({ state: width, effects: [] });
    expect(scanTransition(width, { type: "undo" }, box)).toEqual({ state: SCAN_IDLE, effects: [] });
    const footprint: ScanState = { type: "drawing-footprint", labelClass: "car", anchor: [0, 0, 0], corner: [1, 0, 0] };
    expect(scanTransition(footprint, { type: "undo" }, box)).toEqual({ state: SCAN_IDLE, effects: [] });
  });

  it("while drawing, a redo does nothing", () => {
    const polyline: ScanState = { type: "drawing-polyline", labelClass: "lane", points: [[1, 1, 0], [2, 1, 0]], cursor: null };
    const width: ScanState = { type: "drawing-width", labelClass: "car", anchor: [0, 0, 0], length: 2, yaw: 0, offset: 1 };
    expect(scanTransition(polyline, { type: "redo" }, line)).toEqual({ state: polyline, effects: [] });
    expect(scanTransition(width, { type: "redo" }, box)).toEqual({ state: width, effects: [] });
  });

  it("at rest, reaches the history", () => {
    expect(scanTransition(SCAN_IDLE, { type: "undo" }, box)).toEqual({ state: SCAN_IDLE, effects: [{ kind: "undo" }] });
    expect(scanTransition(SCAN_IDLE, { type: "redo" }, box)).toEqual({ state: SCAN_IDLE, effects: [{ kind: "redo" }] });
  });

  it("mid-drag, discards the drag and then undoes the step before it", () => {
    const store = new AnnotatorStore<ScanDocument>(scanDocumentOf(scanBox("car-1")));
    const context = () => contextOf(store.document, { selection: store.selection });
    const c = context();
    drive(store, context, [down(pixelOf(c, [0, 0, 2])), move(pixelOf(c, [3, 0, 2])), up([0, 0])]);
    expect(cuboidOf(store.document.annotations.get("car-1")).geometry.center[0]).toBeCloseTo(3, 6);

    const moving = drive(store, context, [down(pixelOf(c, [4, 0.5, 2])), move(pixelOf(c, [6, 0.5, 2]))]);
    expect(store.preview).not.toBeNull();
    expect(drive(store, context, [{ type: "undo" }], moving)).toBe(SCAN_IDLE);
    expect(store.preview).toBeNull();
    expect(cuboidOf(store.document.annotations.get("car-1")).geometry.center[0]).toBeCloseTo(0, 6);
    expect(store.canRedo).toBe(true);
  });

  it("a drag whose box was undone behind its back ends, and neither rewrites the box nor loses the redo", () => {
    const store = new AnnotatorStore<ScanDocument>(scanDocumentOf(scanBox("car-1")));
    const context = () => contextOf(store.document, { selection: store.selection });
    const c = context();
    drive(store, context, [down(pixelOf(c, [0, 0, 2])), move(pixelOf(c, [3, 0, 2])), up([0, 0])]);

    const pressed = drive(store, context, [down(pixelOf(c, [4, 0.5, 2]))]);
    expect(pressed.type).toBe("moving");
    expect(store.undo()).toBe(true);
    const ended = drive(store, context, [move(pixelOf(c, [5, 0.5, 2])), up([0, 0])], pressed);

    expect(ended).toBe(SCAN_IDLE);
    expect(cuboidOf(store.document.annotations.get("car-1")).geometry.center[0]).toBeCloseTo(0, 6);
    expect(store.canRedo).toBe(true);
  });

  it("a drag survives a change to another label, a selection change, and its own label re-stored by value", () => {
    const store = new AnnotatorStore<ScanDocument>(scanDocumentOf(scanBox("car-1"), scanBox("car-2", { center: [9, 9, 1] })));
    const context = () => contextOf(store.document, { selection: store.selection });
    const c = context();
    const pressed = drive(store, context, [down(pixelOf(c, [1, 0.5, 2])), move(pixelOf(c, [2, 0.5, 2]))]);
    expect(pressed.type).toBe("moving");

    store.execute(documentCommand<ScanDocument>("delete", (document) => removeScanAnnotations(document, ["car-2"])));
    store.select(EMPTY_SELECTION);
    store.execute(
      documentCommand<ScanDocument>("re-store", (document) => {
        const box = cuboidOf(document.annotations.get("car-1"));
        return replaceScanAnnotation(document, { ...box, geometry: structuredClone(box.geometry) });
      }),
    );
    const moving = drive(store, context, [move(pixelOf(c, [3, 0.5, 2]))], pressed);
    expect(moving.type).toBe("moving");
    drive(store, context, [up([0, 0])], moving);
    expect(cuboidOf(store.document.annotations.get("car-1")).geometry.center[0]).toBeCloseTo(2, 6);
  });

  it("a vertex drag whose polyline was undone behind its back ends too", () => {
    const lane = scanLine("lane-1", [[-4, 6, 0], [0, 6, 0], [4, 6, 0]]);
    const store = new AnnotatorStore<ScanDocument>(scanDocumentOf(lane));
    store.select(selectOnly("lane-1"));
    const context = () => contextOf(store.document, { selection: store.selection });
    const c = context();
    drive(store, context, [down(pixelOf(c, [0, 6, 0])), move(pixelOf(c, [0, 8, 0])), up([0, 0])]);

    const pressed = drive(store, context, [down(pixelOf(c, [0, 8, 0]))]);
    expect(pressed.type).toBe("moving-vertex");
    expect(store.undo()).toBe(true);
    drive(store, context, [move(pixelOf(c, [1, 9, 0])), up([0, 0])], pressed);
    expect(polylineOf(store.document.annotations.get("lane-1")).geometry).toEqual(lane.geometry);
    expect(store.canRedo).toBe(true);
  });
});
