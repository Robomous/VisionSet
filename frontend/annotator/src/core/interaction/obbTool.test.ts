/**
 * The rotated-box tool through the machine: draw, move, resize, rotate, each as
 * exact geometry, each one undo step, and every committed value canonical.
 */

import { describe, expect, it } from "vitest";

import { canonicalObb, obbCorners, obbHandlePositions, obbRotateHandle } from "../geometry/obb";
import { annotationById } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { ObbGeometry } from "../types";
import { OBB_BODY, OBB_ID, OBB_ROTATE, World, down, move, up } from "./_scene";

function obbOf(document: AnnotationDocument, id: string): ObbGeometry {
  const annotation = annotationById(document, id);
  if (annotation === undefined || annotation.geometry.type !== "obb") {
    throw new Error(`no obb ${id} in the document`);
  }
  return annotation.geometry;
}

const START: ObbGeometry = { type: "obb", cx: 180, cy: 380, width: 80, height: 40, angle: Math.PI / 6 };

function picked(): World {
  const world = new World();
  world.send(down(OBB_BODY), up(OBB_BODY));
  return world;
}

describe("drawing a rotated box", () => {
  it("drags out an axis-aligned box and stores it at angle 0", () => {
    const world = new World();
    world.activeClass = "crate";
    world.send(down([300, 100]), move([360, 140]), up([360, 140]));
    expect(world.state.type).toBe("idle");
    expect(obbOf(world.store.document, "n1")).toEqual({
      type: "obb",
      cx: 330,
      cy: 120,
      width: 60,
      height: 40,
      angle: 0,
    });
    expect([...world.store.selection]).toEqual(["n1"]);
    world.store.undo();
    expect(annotationById(world.store.document, "n1")).toBeUndefined();
  });

  it("stores a tall box canonically, width first", () => {
    const world = new World();
    world.activeClass = "crate";
    world.send(down([300, 100]), move([320, 160]), up([320, 160]));
    const drawn = obbOf(world.store.document, "n1");
    expect(drawn).toEqual(canonicalObb(drawn));
    expect(drawn.width).toBe(60);
    expect(drawn.height).toBe(20);
    expect(drawn.angle).toBeCloseTo(-Math.PI / 2, 12);
    expect(drawn).toMatchObject({ cx: 310, cy: 130 });
  });

  it("keeps the rotation grip above a tall box, before and after a turn past a quarter", () => {
    const world = new World();
    world.activeClass = "crate";
    world.send(down([300, 100]), move([320, 160]), up([320, 160]));
    world.activeClass = null;
    const top = (geometry: ObbGeometry): number => Math.min(...obbCorners(geometry).map(([, y]) => y));
    const offset = world.tolerances.rotateOffset;

    const drawn = obbOf(world.store.document, "n1");
    const grip = obbRotateHandle(drawn, offset);
    expect(grip[0]).toBeCloseTo(310, 9);
    expect(grip[1]).toBeLessThan(top(drawn));

    // A press on that grip is a rotation, and a sweep of 120° clockwise passes 90°.
    world.send(down(grip));
    expect(world.state.type).toBe("rotating");
    const radius = Math.hypot(grip[0] - drawn.cx, grip[1] - drawn.cy);
    const to = [drawn.cx + radius * Math.cos(Math.PI / 6), drawn.cy + radius * Math.sin(Math.PI / 6)] as const;
    world.send(move(to), up(to));
    const turned = obbOf(world.store.document, "n1");
    expect(turned).toEqual(canonicalObb(turned));
    expect(obbRotateHandle(turned, offset)[1]).toBeLessThan(top(turned));
  });

  it("adds nothing for a click", () => {
    const world = new World();
    world.activeClass = "crate";
    world.send(down([300, 100]), up([301, 101]));
    expect(annotationById(world.store.document, "n1")).toBeUndefined();
    expect(world.minted).toBe(0);
  });

  it("abandons the band on Escape", () => {
    const world = new World();
    world.activeClass = "crate";
    world.send(down([300, 100]), move([360, 140]), { type: "cancel" }, up([360, 140]));
    expect(world.minted).toBe(0);
  });
});

describe("moving a rotated box", () => {
  it("translates the centre and keeps the angle, as one undo step", () => {
    const world = new World();
    const before = world.store.document;
    world.send(down(OBB_BODY), move([190, 370]), up([190, 370]));
    expect(obbOf(world.store.document, OBB_ID)).toEqual({ ...START, cx: 190, cy: 370 });
    world.store.undo();
    expect(world.store.document).toBe(before);
  });
});

describe("resizing a rotated box", () => {
  it("drags a grip along the box's own axis and holds the opposite side", () => {
    const world = picked();
    const grips = obbHandlePositions(START);
    const u = [Math.cos(START.angle), Math.sin(START.angle)] as const;
    world.send(down(grips.e));
    expect(world.state.type).toBe("resizing");
    const to = [grips.e[0] + 20 * u[0], grips.e[1] + 20 * u[1]] as const;
    world.send(move(to), up(to));
    const resized = obbOf(world.store.document, OBB_ID);
    expect(resized.width).toBeCloseTo(100, 9);
    expect(resized.height).toBe(40);
    expect(resized.angle).toBe(START.angle);
    expect(obbHandlePositions(resized).w[0]).toBeCloseTo(grips.w[0], 9);
    expect(obbHandlePositions(resized).w[1]).toBeCloseTo(grips.w[1], 9);
  });

  it("commits canonically when the drag left the box taller than wide", () => {
    const world = picked();
    const grips = obbHandlePositions(START);
    const v = [-Math.sin(START.angle), Math.cos(START.angle)] as const;
    const to = [grips.s[0] + 60 * v[0], grips.s[1] + 60 * v[1]] as const;
    world.send(down(grips.s), move(to));
    const staged = obbOf(world.store.rendered, OBB_ID);
    expect(staged.height).toBeCloseTo(100, 9);
    expect(staged.angle).toBe(START.angle);
    world.send(up(to));
    const committed = obbOf(world.store.document, OBB_ID);
    expect(committed.width).toBeCloseTo(100, 9);
    expect(committed.height).toBeCloseTo(80, 9);
    expect(committed.angle).toBeCloseTo(START.angle + Math.PI / 2 - Math.PI, 12);
    expect(committed).toEqual(canonicalObb(committed));
  });
});

describe("rotating a rotated box", () => {
  it("enters from the grip, turns about the centre and commits once", () => {
    const world = picked();
    const before = world.store.document;
    world.send(down(OBB_ROTATE));
    expect(world.state.type).toBe("rotating");
    // From the grip (straight out along -v) to straight out along +u: a quarter turn clockwise.
    const to = [START.cx + 50 * Math.cos(START.angle), START.cy + 50 * Math.sin(START.angle)] as const;
    world.send(move(to));
    expect(obbOf(world.store.rendered, OBB_ID).angle).toBeCloseTo(START.angle + Math.PI / 2, 9);
    expect(world.store.canUndo).toBe(false);
    world.send(up(to));
    const turned = obbOf(world.store.document, OBB_ID);
    expect(turned).toEqual(canonicalObb(turned));
    expect(turned.angle).toBeCloseTo(START.angle + Math.PI / 2 - Math.PI, 9);
    expect(turned).toMatchObject({ cx: 180, cy: 380, width: 80, height: 40 });
    world.store.undo();
    expect(world.store.document).toBe(before);
  });

  it("reverts on Escape to exactly where it began", () => {
    const world = picked();
    const before = world.store.document;
    world.send(down(OBB_ROTATE), move([260, 380]), { type: "cancel" });
    expect(world.state.type).toBe("idle");
    expect(world.store.rendered).toBe(before);
    expect(world.store.canUndo).toBe(false);
  });

  it("records nothing for a turn that comes back to where it began", () => {
    const world = picked();
    world.send(down(OBB_ROTATE), move([260, 380]), move(OBB_ROTATE), up(OBB_ROTATE));
    expect(world.store.canUndo).toBe(false);
  });

  it("offers no rotation grip on a box that is not selected", () => {
    const world = new World();
    world.send(down(OBB_ROTATE));
    expect(world.state.type).toBe("pressing-empty");
  });
});
