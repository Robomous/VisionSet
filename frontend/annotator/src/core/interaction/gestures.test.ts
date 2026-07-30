/**
 * Whole gestures, driven through the machine into a real `AnnotatorStore`.
 *
 * The other file sweeps squares; this one walks the sequences a user actually
 * performs and asserts what the document ends up holding. It uses a real store
 * rather than a spy for the reason `selection.test.ts` gives for its own
 * pairing: the claim is about how the pieces sit together, and a test that
 * applied effects by hand would prove the shape of the test.
 *
 * ## The three tests that exist to kill one bug
 *
 * `AnnotatorStore.stage` hands its projection the **committed** document every
 * time. A machine that kept a running `last: Point` and applied deltas — which
 * is exactly v1's shape — would drift the moment a pointer-move is dropped or
 * doubled. What makes that bug expensive is that the obvious tests miss it: a
 * single-move gesture passes, and so does "re-send the same move", because the
 * second identical move has a delta of zero.
 *
 * So: **there and back** (out to a far point and home again lands where it
 * started), **walked versus jumped** (thirty steps to P equals one step to P),
 * and a **dropped move** (every other sample lands in the same place). All three
 * are properties of an absolute transform and none of them is a property of an
 * accumulator.
 *
 * ## And the one v1 could not have
 *
 * "escape puts the box back" is asserted with `toBe` — by reference — because
 * the claim is that the committed document was never touched, not that an equal
 * one was rebuilt. v1 wrote every pointer-move straight into its annotations
 * array, so its Escape had nothing to restore; here the drag was only ever a
 * preview beside an untouched document.
 */

import { describe, expect, it } from "vitest";

import { removeAnnotationsCommand } from "../state/commands";
import { annotationById } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { BboxGeometry, PolygonGeometry } from "../types";
import {
  BOX_BODY,
  BOX_ID,
  BOX_NW,
  POLY_BODY,
  POLY_ID,
  POLY_VERTEX,
  World,
  down,
  move,
  up,
} from "./_scene";
import { IDLE } from "./state";

function boxIn(document: AnnotationDocument, id = BOX_ID): BboxGeometry {
  const geometry = annotationById(document, id)?.geometry;
  if (geometry?.type !== "bbox") throw new Error(`${id} is not a box`);
  return geometry;
}

function polygonIn(document: AnnotationDocument, id = POLY_ID): PolygonGeometry {
  const geometry = annotationById(document, id)?.geometry;
  if (geometry?.type !== "polygon") throw new Error(`${id} is not a polygon`);
  return geometry;
}

/** A world with the named annotation already picked, which grips require. */
function picked(id: typeof BOX_ID | typeof POLY_ID): World {
  const world = new World();
  const at = id === BOX_ID ? BOX_BODY : POLY_BODY;
  world.send(down(at), up(at));
  return world;
}

describe("drawing a box", () => {
  it("follows the pointer in the state and writes nothing until release", () => {
    const world = new World();
    world.activeClass = "sign";
    const committed = world.store.document;
    world.send(down([200, 200]), move([230, 220]), move([260, 250]));
    // The rubber band is the state, not a preview: there is no annotation in the
    // document yet, so there is nothing to project.
    expect(world.state).toEqual({
      type: "drawing-bbox",
      labelClass: "sign",
      start: [200, 200],
      current: [260, 250],
    });
    expect(world.store.document).toBe(committed);
    expect(world.store.preview).toBeNull();
    expect(world.store.canUndo).toBe(false);
  });

  it("commits one annotation, picked, with the box the drag described", () => {
    const world = new World();
    world.activeClass = "sign";
    world.send(down([200, 200]), move([260, 250]), up([260, 250]));
    expect(world.state).toBe(IDLE);
    expect(boxIn(world.store.document, "n1")).toEqual({
      type: "bbox",
      x: 200,
      y: 200,
      width: 60,
      height: 50,
    });
    expect(world.store.selection.has("n1")).toBe(true);
    expect(world.store.canUndo).toBe(true);
  });

  it("normalizes a drag that went up and to the left", () => {
    const world = new World();
    world.activeClass = "sign";
    world.send(down([260, 250]), up([200, 200]));
    expect(boxIn(world.store.document, "n1")).toEqual({
      type: "bbox",
      x: 200,
      y: 200,
      width: 60,
      height: 50,
    });
  });

  it("mints exactly one id however many moves the drag took", () => {
    const world = new World();
    world.activeClass = "sign";
    world.dispatch(down([200, 200]));
    for (let step = 1; step <= 10; step += 1) world.dispatch(move([200 + step * 5, 200 + step * 4]));
    world.dispatch(up([250, 240]));
    // A mint inside a projection would have run once per move, and the committed
    // annotation would carry an id no preview ever rendered under.
    expect(world.minted).toBe(1);
  });

  it("mints nothing at all for a draw that was escaped", () => {
    const world = new World();
    world.activeClass = "sign";
    const committed = world.store.document;
    world.send(down([200, 200]), move([260, 250]));
    world.dispatch({ type: "cancel" });
    expect(world.minted).toBe(0);
    expect(world.store.document).toBe(committed);
    expect(world.store.canUndo).toBe(false);
  });

  it("undoes back to the document it started from", () => {
    const world = new World();
    world.activeClass = "sign";
    const committed = world.store.document;
    world.send(down([200, 200]), move([260, 250]), up([260, 250]));
    world.store.undo();
    expect(world.store.document).toBe(committed);
  });

  it("keeps a box drawn out past the edge inside the asset", () => {
    const world = new World();
    world.activeClass = "sign";
    world.send(down([600, 460]), up([900, 900]));
    expect(boxIn(world.store.document, "n1")).toEqual({
      type: "bbox",
      x: 600,
      y: 460,
      width: 40,
      height: 20,
    });
  });
});

describe("moving a box", () => {
  it("stages what is rendered and leaves the document where it was", () => {
    const world = picked(BOX_ID);
    const committed = world.store.document;
    world.send(down(BOX_BODY), move([200, 200]));
    expect(boxIn(world.store.rendered)).toEqual({
      type: "bbox",
      x: 160,
      y: 170,
      width: 80,
      height: 60,
    });
    expect(world.store.document).toBe(committed);
    expect(world.store.canUndo).toBe(false);
  });

  it("returns the box to where it started when the pointer goes out and comes back", () => {
    const world = picked(BOX_ID);
    world.send(down(BOX_BODY), move([600, 460]), move([300, 300]), move(BOX_BODY));
    // The drift killer. An accumulator that clamped at the far edge would have
    // swallowed the excess and come home short.
    expect(boxIn(world.store.rendered)).toEqual(boxIn(world.store.document));
  });

  it("lands in the same place whether the path was walked or jumped", () => {
    const walked = picked(BOX_ID);
    walked.dispatch(down(BOX_BODY));
    for (let step = 1; step <= 30; step += 1) {
      walked.dispatch(move([BOX_BODY[0] + step * 2, BOX_BODY[1] + step]));
    }

    const jumped = picked(BOX_ID);
    jumped.send(down(BOX_BODY), move([BOX_BODY[0] + 60, BOX_BODY[1] + 30]));

    expect(boxIn(walked.store.rendered)).toEqual(boxIn(jumped.store.rendered));
  });

  it("lands in the same place when half the moves are dropped", () => {
    const dense = picked(BOX_ID);
    dense.dispatch(down(BOX_BODY));
    const sparse = picked(BOX_ID);
    sparse.dispatch(down(BOX_BODY));
    for (let step = 1; step <= 20; step += 1) {
      const at: [number, number] = [BOX_BODY[0] + step * 3, BOX_BODY[1] + step * 2];
      dense.dispatch(move(at));
      if (step % 2 === 0) sparse.dispatch(move(at));
    }
    expect(boxIn(sparse.store.rendered)).toEqual(boxIn(dense.store.rendered));
  });

  it("commits one entry on release, and undo puts the box back", () => {
    const world = picked(BOX_ID);
    const committed = world.store.document;
    world.send(down(BOX_BODY), move([200, 200]), up([200, 200]));
    expect(world.state).toBe(IDLE);
    expect(boxIn(world.store.document).x).toBe(160);
    expect(world.store.getSnapshot().undoLabel).toBe("move sign");
    world.store.undo();
    expect(world.store.document).toBe(committed);
  });

  it("records nothing for a press and a release that never moved", () => {
    const world = picked(BOX_ID);
    world.send(down(BOX_BODY), up(BOX_BODY));
    expect(world.store.canUndo).toBe(false);
  });

  it("records nothing for a drag that wandered and came home", () => {
    const world = picked(BOX_ID);
    world.send(down(BOX_BODY), move([300, 300]), move(BOX_BODY), up(BOX_BODY));
    // The `stage`-versus-`discard` row: a fresh Map that is value-equal would
    // otherwise be a history entry doing visibly nothing.
    expect(world.store.canUndo).toBe(false);
  });

  it("puts the box back on escape, and the document is the object it was", () => {
    const world = picked(BOX_ID);
    const committed = world.store.document;
    world.send(down(BOX_BODY), move([200, 200]));
    world.dispatch({ type: "cancel" });
    expect(world.state).toBe(IDLE);
    expect(world.store.document).toBe(committed);
    expect(world.store.rendered).toBe(committed);
    expect(world.store.canUndo).toBe(false);
  });

  it("keeps the box inside the asset when the pointer leaves it", () => {
    const world = picked(BOX_ID);
    world.send(down(BOX_BODY), move([2000, 2000]), up([2000, 2000]));
    expect(boxIn(world.store.document)).toEqual({
      type: "bbox",
      x: 560,
      y: 420,
      width: 80,
      height: 60,
    });
  });

  it("picks once at the press and not again per pointer-move", () => {
    const world = picked(BOX_ID);
    const pressed = world.dispatch(down(BOX_BODY));
    expect(pressed.effects.filter((effect) => effect.kind === "select")).toHaveLength(1);
    for (let step = 1; step <= 5; step += 1) {
      const moved = world.dispatch(move([BOX_BODY[0] + step, BOX_BODY[1]]));
      // `selectOnly` builds a fresh Set, so re-emitting it every move would
      // notify every subscriber on every move — the storm the snapshot's
      // identity design exists to prevent.
      expect(moved.effects.filter((effect) => effect.kind === "select")).toHaveLength(0);
    }
  });
});

describe("moving a polygon", () => {
  it("moves rigidly, and stays rigid against an edge", () => {
    const world = picked(POLY_ID);
    world.send(down(POLY_BODY), move([50, 340]), up([50, 340]));
    // v1 clamped each vertex on its own, which flattened a polygon against an
    // image edge — permanently, since it wrote through.
    expect(polygonIn(world.store.document).points).toEqual([
      [0, 300],
      [100, 300],
      [100, 380],
      [0, 380],
    ]);
  });

  it("undoes to the polygon that was there", () => {
    const world = picked(POLY_ID);
    const committed = world.store.document;
    world.send(down(POLY_BODY), move([50, 340]), up([50, 340]));
    world.store.undo();
    expect(world.store.document).toBe(committed);
  });
});

describe("resizing a box by a grip", () => {
  it("drives the grip the press picked, from the box the gesture began on", () => {
    const world = picked(BOX_ID);
    world.send(down(BOX_NW), move([80, 80]), move([60, 70]), up([60, 70]));
    expect(boxIn(world.store.document)).toEqual({
      type: "bbox",
      x: 60,
      y: 70,
      width: 120,
      height: 90,
    });
    expect(world.store.getSnapshot().undoLabel).toBe("resize sign");
  });

  it("re-anchors rather than going negative when the drag crosses the anchor", () => {
    const world = picked(BOX_ID);
    world.send(down(BOX_NW), move([300, 300]), up([300, 300]));
    const resized = boxIn(world.store.document);
    expect(resized.width).toBeGreaterThan(0);
    expect(resized.height).toBeGreaterThan(0);
    expect(resized.x).toBeGreaterThanOrEqual(0);
  });

  it("puts the box back on escape", () => {
    const world = picked(BOX_ID);
    const committed = world.store.document;
    world.send(down(BOX_NW), move([60, 70]));
    world.dispatch({ type: "cancel" });
    expect(world.store.document).toBe(committed);
    expect(world.store.canUndo).toBe(false);
  });
});

describe("moving a polygon vertex", () => {
  it("moves the one vertex the press picked and leaves the rest", () => {
    const world = picked(POLY_ID);
    world.send(down(POLY_VERTEX), move([280, 290]), up([280, 290]));
    expect(polygonIn(world.store.document).points).toEqual([
      [280, 290],
      [400, 300],
      [400, 380],
      [300, 380],
    ]);
    expect(world.store.getSnapshot().undoLabel).toBe("edit lane");
  });

  it("puts the vertex back on escape", () => {
    const world = picked(POLY_ID);
    const committed = world.store.document;
    world.send(down(POLY_VERTEX), move([280, 290]));
    world.dispatch({ type: "cancel" });
    expect(world.store.document).toBe(committed);
  });
});

describe("drawing a polygon", () => {
  it("keeps the pending points in the state and stages nothing at all", () => {
    const world = new World();
    world.activeClass = "lane";
    const committed = world.store.document;
    world.send(down([200, 200]), move([210, 210]), down([260, 200]), down([260, 260]));
    expect(world.state).toEqual({
      type: "drawing-polygon",
      labelClass: "lane",
      points: [
        [200, 200],
        [260, 200],
        [260, 260],
      ],
      cursor: [260, 260],
    });
    expect(world.store.preview).toBeNull();
    expect(world.store.document).toBe(committed);
  });

  it("refuses to close on fewer than three points", () => {
    const world = new World();
    world.activeClass = "lane";
    world.send(down([200, 200]), down([260, 200]));
    world.dispatch({ type: "commit" });
    expect(world.state.type).toBe("drawing-polygon");
    expect(world.store.canUndo).toBe(false);
  });

  it("closes on commit, and the whole session is one undo step", () => {
    const world = new World();
    world.activeClass = "lane";
    const committed = world.store.document;
    world.send(down([200, 200]), down([260, 200]), down([260, 260]), down([200, 260]));
    world.dispatch({ type: "commit" });
    expect(polygonIn(world.store.document, "n1").points).toEqual([
      [200, 200],
      [260, 200],
      [260, 260],
      [200, 260],
    ]);
    // Four clicks, one entry — because the pending points were never in the log.
    world.store.undo();
    expect(world.store.document).toBe(committed);
    expect(world.store.canUndo).toBe(false);
  });

  it("drops every pending point on escape", () => {
    const world = new World();
    world.activeClass = "lane";
    world.send(down([200, 200]), down([260, 200]), down([260, 260]));
    world.dispatch({ type: "cancel" });
    expect(world.state).toBe(IDLE);
    expect(world.minted).toBe(0);
  });
});

describe("inserting a vertex on an edge", () => {
  it("puts one where the double-click landed, and picks the polygon", () => {
    const world = new World();
    world.dispatch({ type: "double-click", point: [350, 302], modifiers: { shift: false, ctrl: false, meta: false, alt: false } });
    expect(polygonIn(world.store.document).points).toEqual([
      [300, 300],
      [350, 300],
      [400, 300],
      [400, 380],
      [300, 380],
    ]);
    expect(world.store.selection.has(POLY_ID)).toBe(true);
  });

  it("inserts nothing when the double-click is on a vertex", () => {
    const world = new World();
    const committed = world.store.document;
    world.dispatch({ type: "double-click", point: [301, 301], modifiers: { shift: false, ctrl: false, meta: false, alt: false } });
    expect(world.store.document).toBe(committed);
  });
});

describe("the document moving under a live gesture", () => {
  it("gives up quietly when the annotation is deleted mid-drag", () => {
    const world = picked(BOX_ID);
    world.send(down(BOX_BODY), move([200, 200]));
    // What a host does when the user presses Delete, or Ctrl+Z, during a drag.
    // Without the staleness guard the next pointer-move asks `replaceAnnotation`
    // for an id the document no longer holds, and `DocumentError` comes out of a
    // pointer handler.
    world.store.execute(removeAnnotationsCommand([BOX_ID]));
    expect(() => world.dispatch(move([220, 220]))).not.toThrow();
    expect(world.state).toBe(IDLE);
    expect(world.store.preview).toBeNull();
  });

  it("gives up quietly when an undo takes the annotation away mid-drag", () => {
    const world = new World();
    world.activeClass = "sign";
    world.send(down([200, 200]), up([260, 250]));
    world.activeClass = null;
    world.send(down([230, 220]), move([240, 230]));
    world.store.undo();
    expect(() => world.dispatch(move([250, 240]))).not.toThrow();
    expect(world.state).toBe(IDLE);
  });

  it("gives up quietly when a vertex the drag holds is gone", () => {
    const world = picked(POLY_ID);
    world.dispatch(down(POLY_VERTEX));
    world.store.execute(removeAnnotationsCommand([POLY_ID]));
    expect(() => world.dispatch(move([280, 290]))).not.toThrow();
    expect(world.state).toBe(IDLE);
  });
});
