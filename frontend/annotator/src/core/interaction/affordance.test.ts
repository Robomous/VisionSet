/**
 * The cursor and the hot target — #43's second deliverable, "which handle is hot".
 *
 * Two claims are worth the file. The first is that the affordance agrees with the
 * transition table: in a drawing tool a press starts a new shape whatever it lands
 * on, so a cursor offering a resize grip there would be promising a gesture the
 * table refuses. The second is that a drag answers from its own state, not from
 * the point — a resize keeps its grip lit when the pointer outruns the box, which
 * is exactly when a user needs to see what they are holding.
 *
 * Both are tested against `transition` itself rather than against a restatement of
 * it, so the two cannot drift: the precedence test asserts the press *does* start a
 * drawing, in the same `it` that asserts the cursor said it would.
 */

import { describe, expect, it } from "vitest";

import { BBOX_HANDLES, bboxHandlePositions } from "../geometry/bbox";
import type { BboxHandle } from "../geometry/bbox";
import { assetTolerances } from "../geometry/tolerance";
import { annotationById, removeAnnotations } from "../state/document";
import { EMPTY_SELECTION, selectOnly } from "../state/selection";
import type { Selection } from "../state/selection";
import type { Point } from "../types";
import {
  BOX_BODY,
  BOX_ID,
  BOX_NW,
  EMPTY_POINT,
  POLY_BODY,
  World,
  POLY_ID,
  POLY_VERTEX,
  down,
  sceneDocument,
  worldIn,
} from "./_scene";
import { HANDLE_CURSORS, affordanceAt } from "./affordance";
import type { Cursor } from "./affordance";
import { transition } from "./machine";
import { IDLE } from "./state";
import type { InteractionState } from "./state";
import { NO_TARGET } from "./target";
import type { Scene } from "./target";
import type { Tool } from "./tool";

/** Every cursor, so a new one cannot arrive without a test naming it. */
const KNOWN_CURSORS: Record<Cursor, true> = {
  default: true,
  crosshair: true,
  pointer: true,
  move: true,
  "nwse-resize": true,
  "nesw-resize": true,
  "ns-resize": true,
  "ew-resize": true,
};

function toolOf(type: "drawing-bbox" | "drawing-polygon"): Tool {
  return type === "drawing-bbox" ? "bbox" : "polygon";
}

/** The scene an adapter passes mid-session: what is rendered, and how near counts. */
function sceneOfWorld(world: World): Scene {
  return {
    document: world.store.rendered,
    selection: world.store.selection,
    tolerances: world.tolerances,
  };
}

/**
 * A live polygon session holding `points`, reached by walking rather than built.
 *
 * Three points is the smallest buffer that can close, which is what makes the
 * `closes`/`too-few` pair testable from one helper.
 */
function drawing(...points: readonly Point[]): World {
  const world = new World();
  world.activeClass = "lane";
  world.send(...points.map((point) => down(point)));
  return world;
}

const PENDING: readonly Point[] = [
  [200, 200],
  [260, 200],
  [260, 260],
];

function scene(selection: Selection = EMPTY_SELECTION): Scene {
  return { document: sceneDocument(), selection, tolerances: assetTolerances(1) };
}

/** The scene an adapter passes while the box is picked — the only way grips resolve. */
function withBoxPicked(): Scene {
  return scene(selectOnly(BOX_ID));
}

function at(
  state: InteractionState,
  point: Point,
  tool: Tool = "select",
  where: Scene = withBoxPicked(),
) {
  return affordanceAt(state, where, tool, point);
}

/** Where the scene's box draws its grips — the points a hover has to land on. */
const GRIP_POSITIONS = bboxHandlePositions({
  type: "bbox",
  x: 100,
  y: 100,
  width: 80,
  height: 60,
});

describe("hovering, with nothing in flight", () => {
  it("offers each grip its own axis pair", () => {
    for (const handle of BBOX_HANDLES) {
      const answer = at(IDLE, GRIP_POSITIONS[handle]);
      expect(answer.cursor, handle).toBe(HANDLE_CURSORS[handle]);
      expect(answer.hot, handle).toEqual({
        kind: "handle",
        id: BOX_ID,
        handle,
        point: GRIP_POSITIONS[handle],
      });
    }
  });

  it("offers a move over a body, and names the body it would move", () => {
    expect(at(IDLE, BOX_BODY)).toEqual({
      cursor: "move",
      hot: { kind: "body", id: BOX_ID },
    });
  });

  it("offers a move over a vertex of the picked polygon", () => {
    const answer = at(IDLE, POLY_VERTEX, "select", scene(selectOnly(POLY_ID)));
    expect(answer.cursor).toBe("move");
    expect(answer.hot).toEqual({ kind: "vertex", id: POLY_ID, index: 0, point: POLY_VERTEX });
  });

  it("offers a move over an edge, because a press on one starts a move", () => {
    // `IDLE_ROW` groups edge with body — `if (kind === "body" || kind === "edge")
    // return pressOnShape(...)`. Showing `default` here would be the drawing-tool
    // lie inverted: under-promising, and still a disagreement with the table. The
    // press is asserted in the same test so the two cannot drift apart.
    // Seven pixels outside the polygon's top edge: past the 4-px shape tolerance
    // that would make it a body hit, inside the 15-px edge band.
    const point: Point = [350, 293];
    const where = scene(selectOnly(POLY_ID));
    const answer = affordanceAt(IDLE, where, "select", point);
    expect(answer.cursor).toBe("move");
    expect(answer.hot.kind).toBe("edge");

    const pressed = transition(IDLE, down(point), {
      document: where.document,
      selection: where.selection,
      tool: "select",
      tolerances: where.tolerances,
      labelClass: null,
      mint: () => "n1",
    });
    expect(pressed.state.type).toBe("moving");
  });

  it("offers nothing over empty canvas", () => {
    expect(at(IDLE, EMPTY_POINT)).toEqual({ cursor: "default", hot: NO_TARGET });
  });

  it("will not show a grip on a box nobody picked", () => {
    // `resolveTarget` ranks grips for selected boxes only, and the body underneath
    // is what a press would actually take.
    const answer = at(IDLE, BOX_NW, "select", scene());
    expect(answer.cursor).toBe("move");
    expect(answer.hot).toEqual({ kind: "body", id: BOX_ID });
  });

  it("shows nothing at all while a press on empty canvas is in flight", () => {
    // The button is already down on empty canvas, and `PRESSING_EMPTY_ROW` has no
    // `pointer-down` — so for the whole of that gesture no grip and no shape is
    // reachable, however exactly the pointer comes to rest on one. Asserted as a
    // literal rather than against `at(IDLE, ...)`, which would move with any
    // regression in `hovering` and prove nothing.
    const pressing: InteractionState = { type: "pressing-empty", startPoint: EMPTY_POINT };
    expect(at(pressing, BOX_NW)).toEqual({ cursor: "default", hot: NO_TARGET });
    expect(at(pressing, BOX_BODY)).toEqual({ cursor: "default", hot: NO_TARGET });
  });
});

describe("a drawing tool outranks every grip, and the cursor has to say so", () => {
  it("shows a crosshair on the picked box's own nw grip", () => {
    // The claim in one `it`: the cursor promises a drawing, and the table delivers
    // one. `IDLE_ROW` checks the tool before it resolves any target, so a hover
    // query that resolved first would light this grip and offer nwse-resize for a
    // gesture that cannot happen.
    const where = withBoxPicked();
    expect(affordanceAt(IDLE, where, "bbox", BOX_NW)).toEqual({
      cursor: "crosshair",
      hot: NO_TARGET,
    });

    const answer = transition(IDLE, down(BOX_NW), {
      document: where.document,
      selection: where.selection,
      tool: "bbox",
      tolerances: where.tolerances,
      labelClass: "sign",
      mint: () => "n1",
    });
    expect(answer.state.type).toBe("drawing-bbox");
  });

  it("shows a crosshair over a body and over empty canvas alike", () => {
    for (const point of [BOX_BODY, POLY_BODY, EMPTY_POINT] as const) {
      expect(affordanceAt(IDLE, withBoxPicked(), "polygon", point), `${point}`).toEqual({
        cursor: "crosshair",
        hot: NO_TARGET,
      });
    }
  });

  it("keeps the crosshair while a shape is being drawn", () => {
    for (const type of ["drawing-bbox", "drawing-polygon"] as const) {
      const world = worldIn(type);
      const answer = affordanceAt(world.state, sceneOfWorld(world), toolOf(type), BOX_NW);
      expect(answer, type).toEqual({ cursor: "crosshair", hot: NO_TARGET });
    }
  });
});

describe("mid-session, the cursor says whether this click would close the polygon", () => {
  it("offers a pointer over the first vertex, and the press does close there", () => {
    const world = drawing(...PENDING);
    const where = sceneOfWorld(world);
    expect(affordanceAt(world.state, where, "polygon", PENDING[0])).toEqual({
      cursor: "pointer",
      hot: NO_TARGET,
    });
    // Asserted in the same `it` as the cursor that predicted it — #43's rule, and
    // the only thing that stops the two drifting apart.
    world.dispatch(down(PENDING[0]));
    expect(world.state).toBe(IDLE);
    expect(world.minted).toBe(1);
  });

  it("keeps the crosshair over the last vertex, which is not the one that closes", () => {
    const world = drawing(...PENDING);
    const answer = affordanceAt(world.state, sceneOfWorld(world), "polygon", PENDING[2]);
    expect(answer).toEqual({ cursor: "crosshair", hot: NO_TARGET });
  });

  it("keeps the crosshair just outside the ring", () => {
    const world = drawing(...PENDING);
    // 11 asset px at zoom 1, one past CLOSE_POLYGON_TOLERANCE_PX.
    const outside: Point = [PENDING[0][0] + 11, PENDING[0][1]];
    expect(affordanceAt(world.state, sceneOfWorld(world), "polygon", outside).cursor).toBe(
      "crosshair",
    );
  });

  it("shows no pointer while the session is too short to close, and the press agrees", () => {
    const world = drawing(PENDING[0], PENDING[1]);
    const where = sceneOfWorld(world);
    // `too-few`: the press there does nothing at all, so promising a close would be
    // #43's `default`-over-an-`edge` mistake pointed the other way.
    expect(affordanceAt(world.state, where, "polygon", PENDING[0]).cursor).toBe("crosshair");
    const before = world.state;
    world.dispatch(down(PENDING[0]));
    expect(world.state).toBe(before);
    expect(world.minted).toBe(0);
  });

  it("measures the ring from where the vertex landed, not from where the pointer is", () => {
    // The first vertex was clamped onto the asset's left edge; the pointer is
    // outside the image. An unclamped comparison here puts the cursor and the press
    // on opposite sides of the ring — the one disagreement this module forbids.
    const world = drawing([-40, 200], [260, 200], [260, 260]);
    const where = sceneOfWorld(world);
    const outsideTheImage: Point = [-40, 200];
    expect(affordanceAt(world.state, where, "polygon", outsideTheImage)).toEqual({
      cursor: "pointer",
      hot: NO_TARGET,
    });
    world.dispatch(down(outsideTheImage));
    expect(world.state).toBe(IDLE);
    expect(world.minted).toBe(1);
  });
});

describe("a drag answers from what it is holding, not from where the pointer is", () => {
  it("keeps the grip hot when the pointer has left the box entirely", () => {
    const world = worldIn("resizing");
    const where: Scene = {
      document: world.store.rendered,
      selection: world.store.selection,
      tolerances: world.tolerances,
    };
    const held = world.state as Extract<InteractionState, { type: "resizing" }>;
    const answer = affordanceAt(world.state, where, "select", EMPTY_POINT);

    expect(answer.cursor).toBe(HANDLE_CURSORS[held.handle]);
    expect(answer.hot.kind).toBe("handle");
    if (answer.hot.kind !== "handle") throw new Error("unreachable");
    expect(answer.hot.handle).toBe(held.handle);
    expect(answer.hot.id).toBe(held.id);
  });

  it("positions the held grip where the shape is drawn now, not where it began", () => {
    // The scene is built from `rendered`, so mid-drag the grip follows the preview.
    // Reading `startGeometry` instead would leave the highlight behind at the
    // gesture's origin, which looks like a rendering bug and is a frame bug.
    const world = worldIn("resizing");
    world.dispatch({ type: "pointer-move", point: [40, 40] });
    const held = world.state as Extract<InteractionState, { type: "resizing" }>;
    const rendered = annotationById(world.store.rendered, held.id);
    if (rendered === undefined || rendered.geometry.type !== "bbox") {
      throw new Error("the scene lost the box being resized");
    }
    // The route pressed the nw grip and this drag took it to [40, 40], so both the
    // preview and the grip's position are fully determined. Asserted as a literal:
    // deriving the expectation from `store.rendered` — the very thing the
    // implementation reads — would pass for a `startGeometry`-based implementation
    // too, the moment staging stopped producing a preview at all.
    expect(rendered.geometry).toEqual({ type: "bbox", x: 40, y: 40, width: 140, height: 120 });
    const answer = affordanceAt(
      world.state,
      { document: world.store.rendered, selection: world.store.selection, tolerances: world.tolerances },
      "select",
      EMPTY_POINT,
    );
    if (answer.hot.kind !== "handle") throw new Error("unreachable");
    expect(held.handle).toBe("nw");
    expect(answer.hot.point).toEqual([40, 40]);
    // And not where the gesture began, which is what a `startGeometry` read gives.
    expect(bboxHandlePositions(held.startGeometry).nw).toEqual([100, 100]);
  });

  it("offers a move for a shape drag and names the shape", () => {
    const world = worldIn("moving");
    const answer = affordanceAt(
      world.state,
      { document: world.store.rendered, selection: world.store.selection, tolerances: world.tolerances },
      "select",
      EMPTY_POINT,
    );
    expect(answer.cursor).toBe("move");
    expect(answer.hot.kind).toBe("body");
  });

  it("offers a move for a vertex drag and names the vertex", () => {
    const world = worldIn("moving-vertex");
    const answer = affordanceAt(
      world.state,
      { document: world.store.rendered, selection: world.store.selection, tolerances: world.tolerances },
      "select",
      EMPTY_POINT,
    );
    expect(answer.cursor).toBe("move");
    expect(answer.hot.kind).toBe("vertex");
  });

  it("keeps the cursor but drops the target when the shape is deleted under it", () => {
    // Reachable: #46 binds Delete, and the machine's own staleness guard answers
    // the next pointer-move by abandoning. Until that event arrives a renderer is
    // still asking what to draw, and a lookup that threw would take the frame with
    // it.
    const world = worldIn("resizing");
    const held = world.state as Extract<InteractionState, { type: "resizing" }>;
    const answer = affordanceAt(
      world.state,
      {
        document: removeAnnotations(sceneDocument(), [held.id]),
        selection: EMPTY_SELECTION,
        tolerances: world.tolerances,
      },
      "select",
      EMPTY_POINT,
    );
    expect(answer.cursor).toBe(HANDLE_CURSORS[held.handle]);
    expect(answer.hot).toBe(NO_TARGET);
  });
});

describe("the cursor table", () => {
  it("gives every grip a resize cursor and never one of the other three", () => {
    // `KNOWN_CURSORS` above is the totality gate and it is a compile-time one — a
    // lookup into it can only ever be `true`, so asserting on one proves nothing.
    // The runtime claim worth making is narrower: a grip resizes, so a table entry
    // reading `move` or `crosshair` is wrong however well-typed it is.
    const handles: readonly BboxHandle[] = BBOX_HANDLES;
    for (const handle of handles) {
      expect(HANDLE_CURSORS[handle], handle).toMatch(/-resize$/);
    }
  });

  it("uses all four resize cursors, so the table cannot collapse to one", () => {
    // Eight grips, four axis pairs. A table that answered `nwse-resize` for
    // everything would satisfy every other test in this describe.
    expect(new Set(Object.values(HANDLE_CURSORS)).size).toBe(4);
  });

  it("can actually produce every cursor the union declares", () => {
    // The union is vocabulary, and vocabulary nobody speaks is dead weight that
    // reads as capability. Every member has to come out of a real call: the four
    // resize keywords from the grips, `move` from a body, `crosshair` from a
    // drawing tool, `default` from empty canvas, `pointer` from the first vertex of
    // a polygon long enough to close.
    const closeable = drawing(...PENDING);
    const produced = new Set<Cursor>([
      ...BBOX_HANDLES.map((handle) => at(IDLE, GRIP_POSITIONS[handle]).cursor),
      at(IDLE, BOX_BODY).cursor,
      at(IDLE, EMPTY_POINT, "bbox").cursor,
      at(IDLE, EMPTY_POINT).cursor,
      affordanceAt(closeable.state, sceneOfWorld(closeable), "polygon", PENDING[0]).cursor,
    ]);
    expect(produced).toEqual(new Set(Object.keys(KNOWN_CURSORS)));
  });

  it("gives opposite grips the same cursor, because they drive the same axes", () => {
    expect(HANDLE_CURSORS.nw).toBe(HANDLE_CURSORS.se);
    expect(HANDLE_CURSORS.ne).toBe(HANDLE_CURSORS.sw);
    expect(HANDLE_CURSORS.n).toBe(HANDLE_CURSORS.s);
    expect(HANDLE_CURSORS.e).toBe(HANDLE_CURSORS.w);
  });

  it("keeps v1's four keywords, which is the one part of its bbox rendering to port", () => {
    expect(HANDLE_CURSORS).toEqual({
      nw: "nwse-resize",
      n: "ns-resize",
      ne: "nesw-resize",
      e: "ew-resize",
      se: "nwse-resize",
      s: "ns-resize",
      sw: "nesw-resize",
      w: "ew-resize",
    });
  });
});
