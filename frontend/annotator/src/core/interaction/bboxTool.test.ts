/**
 * #43's two acceptance criteria, in one file: draw, move and resize produce exact
 * geometry, and undo after each restores the document that was there before.
 *
 * `gestures.test.ts` already walks a draw and a move — it exists to kill the
 * accumulating-delta bug, and its there-and-back, walked-versus-jumped and
 * dropped-move trio are properties of an absolute transform. **Those are not
 * repeated here.** This file is the matrix: every drag direction, every grip, and
 * the threshold from both sides, each asserted as an exact `BboxGeometry` written
 * out in the test rather than recomputed from the function under test.
 *
 * ## Undo is asserted by reference wherever the prior document is still in hand
 *
 * `expect(store.document).toBe(before)` is a stronger claim than `toEqual`: the
 * command log keeps snapshots and undo is a pointer swap, so the object that comes
 * back must be the very one that was there, not an equal rebuild. Where the claim
 * is about a *geometry* it is `toEqual`, because a geometry is a value.
 *
 * ## The threshold gets two tests, not one
 *
 * v1 wrote `width > 3` when it accepted a drawn box and `< 3` when it clamped a
 * resized one — one boundary spelled twice, and differently, which is the failure
 * a single "it rejects a click" test leaves open. So: exactly at the threshold is
 * drawn, one pixel under on either axis alone is not.
 */

import { describe, expect, it } from "vitest";

import { BBOX_HANDLES, bboxHandlePositions } from "../geometry/bbox";
import type { BboxHandle } from "../geometry/bbox";
import { MIN_DRAW_SIZE_PX, assetTolerances } from "../geometry/tolerance";
import { ASSET } from "../state/_sample";
import { annotationById } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import { selectOnly } from "../state/selection";
import type { BboxGeometry, Point } from "../types";
import { BOX_BODY, BOX_ID, World, down, move, up } from "./_scene";

function bbox(x: number, y: number, width: number, height: number): BboxGeometry {
  return { type: "bbox", x, y, width, height };
}

/** The scene's box, as a value. Distinct edges, so a swapped axis cannot pass. */
const START = bbox(100, 100, 80, 60); // left 100, right 180, top 100, bottom 160

const GRIPS = bboxHandlePositions(START);

/** A world holding the bbox tool, so a press draws. */
function drawing(): World {
  const world = new World();
  world.activeClass = "sign";
  return world;
}

/** A world in select mode with the scene's box picked, so its grips resolve. */
function picked(): World {
  const world = new World();
  world.send(down(BOX_BODY), up(BOX_BODY));
  return world;
}

function geometryOf(document: AnnotationDocument, id: string): BboxGeometry {
  const annotation = annotationById(document, id);
  if (annotation === undefined || annotation.geometry.type !== "bbox") {
    throw new Error(`no bbox ${id} in the document`);
  }
  return annotation.geometry;
}

describe("drawing a box, which is the tool's whole first half", () => {
  it("produces the same box whichever corner the drag started from", () => {
    // One expectation, four gestures. `normalizeBbox` is unit-tested; what this
    // asserts is that the *tool* hands the drag's two ends over in either order
    // and never, for instance, sorts them itself on the way past.
    const expected = bbox(200, 200, 60, 50);
    for (const [start, end] of [
      [[200, 200], [260, 250]],
      [[260, 250], [200, 200]],
      [[260, 200], [200, 250]],
      [[200, 250], [260, 200]],
    ] as const) {
      const world = drawing();
      world.send(down(start), move(end), up(end));
      expect(geometryOf(world.store.document, "n1"), `${start} to ${end}`).toEqual(expected);
    }
  });

  it("keeps a box dragged out past the frame inside the asset", () => {
    const world = drawing();
    world.send(down([600, 450]), move([9999, 9999]), up([9999, 9999]));
    expect(geometryOf(world.store.document, "n1")).toEqual(
      bbox(600, 450, ASSET.width - 600, ASSET.height - 450),
    );
  });

  it("gives the new box the active class and picks it", () => {
    const world = drawing();
    world.send(down([10, 10]), move([90, 90]), up([90, 90]));
    expect(annotationById(world.store.document, "n1")?.label_class).toBe("sign");
    expect(world.store.selection.has("n1")).toBe(true);
    expect(world.store.getSnapshot().undoLabel).toBe("add sign");
  });

  it("mints one id for the whole gesture, however many moves it took", () => {
    const world = drawing();
    world.send(down([10, 10]), move([30, 30]), move([50, 50]), move([90, 90]), up([90, 90]));
    expect(world.minted).toBe(1);
  });

  it("writes nothing until the pointer comes up", () => {
    const world = drawing();
    const before = world.store.document;
    world.send(down([10, 10]), move([90, 90]));
    // The rubber band is the state; there is no annotation to preview yet.
    expect(world.store.document).toBe(before);
    expect(world.store.preview).toBeNull();
    expect(world.store.canUndo).toBe(false);
  });
});

describe("the threshold that tells a drawing from a mis-click", () => {
  /**
   * `World` holds unconverted tolerances — `assetTolerances(1)` — so the screen
   * constant is the asset number here and the drag distances are the constant's.
   */
  const MINIMUM = MIN_DRAW_SIZE_PX;

  it("refuses a click, which is a box with no extent at all", () => {
    const world = drawing();
    const before = world.store.document;
    world.send(down([200, 200]), up([200, 200]));
    expect(world.store.document).toBe(before);
    expect(world.store.canUndo).toBe(false);
    expect(world.minted).toBe(0);
  });

  it("leaves the selection the press cleared cleared, rather than restoring it", () => {
    // The press did land on empty canvas with a drawing tool held. Nothing was
    // drawn, and nothing should be picked either — restoring the prior selection
    // would make a mis-click undo a deliberate deselect.
    const world = drawing();
    world.store.select(selectOnly(BOX_ID));
    world.send(down([200, 200]), up([200, 200]));
    expect(world.store.selection.size).toBe(0);
  });

  it("draws a box that reaches the threshold exactly", () => {
    const world = drawing();
    const end: Point = [200 + MINIMUM, 200 + MINIMUM];
    world.send(down([200, 200]), move(end), up(end));
    expect(geometryOf(world.store.document, "n1")).toEqual(bbox(200, 200, MINIMUM, MINIMUM));
  });

  it("refuses one a pixel under the threshold, on either axis alone", () => {
    for (const end of [
      [200 + MINIMUM - 1, 200 + MINIMUM],
      [200 + MINIMUM, 200 + MINIMUM - 1],
    ] as const) {
      const world = drawing();
      world.send(down([200, 200]), move(end), up(end));
      expect(world.store.canUndo, `${end}`).toBe(false);
    }
  });

  it("refuses the sliver a click plus a flick of drift makes", () => {
    const world = drawing();
    world.send(down([100, 400]), move([300, 402]), up([300, 402]));
    expect(world.store.canUndo).toBe(false);
  });

  it("lets a zoomed-in user draw a box smaller than the screen threshold", () => {
    // The whole reason the constant is screen pixels. At 400% a 1-px asset box is
    // 4 screen pixels of drag, which is a deliberate gesture — somebody zoomed in
    // to draw something small. v1 compared against an already-divided coordinate
    // and refused it. Nothing else in this suite varies the frame, so swapping
    // `tolerances.minDraw` back for the raw constant would go unnoticed without
    // this test and the next.
    const world = drawing();
    world.tolerances = assetTolerances(4);
    world.send(down([200, 200]), move([201, 201]), up([201, 201]));
    expect(geometryOf(world.store.document, "n1")).toEqual(bbox(200, 200, 1, 1));
  });

  it("refuses a zoomed-out drag that covers more asset than the threshold", () => {
    // The other side, and the one v1's inversion let through: at 25% a 6-px asset
    // box is 1.5 screen pixels — a twitch — and `minDraw` is 12 asset pixels here.
    const world = drawing();
    world.tolerances = assetTolerances(0.25);
    world.send(down([200, 200]), move([206, 206]), up([206, 206]));
    expect(world.store.canUndo).toBe(false);
  });

  it("draws the box that dipped under the threshold and came back out", () => {
    // The gate reads the box at release, not the smallest one the drag ever
    // described — the same rule `stageOrDiscard` follows for a wandering move.
    const world = drawing();
    world.send(down([200, 200]), move([201, 201]), move([260, 250]), up([260, 250]));
    expect(geometryOf(world.store.document, "n1")).toEqual(bbox(200, 200, 60, 50));
  });
});

describe("moving a box", () => {
  it("puts it exactly where the pointer carried it", () => {
    const world = picked();
    // Press on the body at [140, 130] and drag 30 right, 20 down.
    world.send(down(BOX_BODY), move([170, 150]), up([170, 150]));
    expect(geometryOf(world.store.document, BOX_ID)).toEqual(bbox(130, 120, 80, 60));
  });

  it("stops at the frame edge instead of hanging over it", () => {
    const world = picked();
    world.send(down(BOX_BODY), move([9999, 9999]), up([9999, 9999]));
    expect(geometryOf(world.store.document, BOX_ID)).toEqual(
      bbox(ASSET.width - 80, ASSET.height - 60, 80, 60),
    );
  });

  it("commits under a label naming the class", () => {
    const world = picked();
    world.send(down(BOX_BODY), move([170, 150]));
    expect(world.store.preview).not.toBeNull();
    world.dispatch(up([170, 150]));
    expect(world.store.getSnapshot().undoLabel).toBe("move sign");
  });

  it("asks the store to stage exactly the geometry, with no store in the test", () => {
    // The effect-level form `effects.ts` specified for this task: a transition is
    // data, so a table row is assertable as a table row.
    const world = picked();
    world.dispatch(down(BOX_BODY));
    expect(world.turn(move([170, 150])).effects).toEqual([
      { kind: "stage", id: BOX_ID, geometry: bbox(130, 120, 80, 60) },
    ]);
  });
});

describe("resizing from each of the eight grips", () => {
  /**
   * Where each grip is dragged to, and the box that must come out.
   *
   * Total over `BboxHandle`, so a ninth grip cannot arrive without an answer
   * here. Every destination is far from every other grip, so a press that
   * resolved the wrong one fails rather than passing by coincidence, and every
   * expected box is written out rather than recomputed from `resizeBbox` — which
   * `bbox.test.ts` pins independently.
   */
  const DRAGS: Readonly<Record<BboxHandle, { to: Point; out: BboxGeometry }>> = {
    nw: { to: [40, 30], out: bbox(40, 30, 140, 130) },
    n: { to: [40, 30], out: bbox(100, 30, 80, 130) },
    ne: { to: [300, 30], out: bbox(100, 30, 200, 130) },
    e: { to: [300, 320], out: bbox(100, 100, 200, 60) },
    se: { to: [300, 320], out: bbox(100, 100, 200, 220) },
    s: { to: [300, 320], out: bbox(100, 100, 80, 220) },
    sw: { to: [40, 320], out: bbox(40, 100, 140, 220) },
    w: { to: [40, 30], out: bbox(40, 100, 140, 60) },
  };

  for (const handle of BBOX_HANDLES) {
    it(`drives the ${handle} grip and leaves the edges it does not own`, () => {
      const { to, out } = DRAGS[handle];
      const world = picked();
      world.send(down(GRIPS[handle]), move(to), up(to));
      expect(geometryOf(world.store.document, BOX_ID)).toEqual(out);
    });
  }

  it("takes the grip a press lands on, and not its neighbour", () => {
    for (const handle of BBOX_HANDLES) {
      const world = picked();
      world.dispatch(down(GRIPS[handle]));
      expect(world.state, handle).toEqual({
        type: "resizing",
        id: BOX_ID,
        handle,
        startGeometry: START,
      });
    }
  });

  it("commits under a label naming the class", () => {
    const world = picked();
    world.send(down(GRIPS.se), move([300, 320]), up([300, 320]));
    expect(world.store.getSnapshot().undoLabel).toBe("resize sign");
  });
});

describe("undo after each operation returns the document that was there before", () => {
  it("takes a drawn box back out", () => {
    const world = drawing();
    const before = world.store.document;
    world.send(down([200, 200]), move([260, 250]), up([260, 250]));
    expect(world.store.canUndo).toBe(true);

    expect(world.store.undo()).toBe(true);
    // By reference: undo is a pointer swap over kept snapshots, so the document
    // that comes back must be the very one, not an equal rebuild.
    expect(world.store.document).toBe(before);
    expect(annotationById(world.store.document, "n1")).toBeUndefined();
  });

  it("puts a moved box back where it started", () => {
    const world = picked();
    const before = world.store.document;
    world.send(down(BOX_BODY), move([170, 150]), up([170, 150]));
    expect(geometryOf(world.store.document, BOX_ID)).toEqual(bbox(130, 120, 80, 60));

    expect(world.store.undo()).toBe(true);
    expect(world.store.document).toBe(before);
    expect(geometryOf(world.store.document, BOX_ID)).toEqual(START);
  });

  it("puts a resized box back to the size it had", () => {
    const world = picked();
    const before = world.store.document;
    world.send(down(GRIPS.se), move([300, 320]), up([300, 320]));
    expect(geometryOf(world.store.document, BOX_ID)).not.toEqual(START);

    expect(world.store.undo()).toBe(true);
    expect(world.store.document).toBe(before);
    expect(geometryOf(world.store.document, BOX_ID)).toEqual(START);
  });

  it("unwinds a whole session one operation at a time, in order", () => {
    // Draw, move the drawn box, resize it: three entries, three undos, and the
    // document at the end is the one the session began with.
    const world = drawing();
    const initial = world.store.document;
    world.send(down([200, 200]), move([300, 300]), up([300, 300]));
    const drawn = world.store.document;

    world.activeClass = null; // select mode, so a press takes the shape
    world.send(down([250, 250]), move([270, 260]), up([270, 260]));
    const moved = world.store.document;
    expect(geometryOf(moved, "n1")).toEqual(bbox(220, 210, 100, 100));

    world.send(down([320, 310]), move([400, 420]), up([400, 420]));
    expect(geometryOf(world.store.document, "n1")).toEqual(bbox(220, 210, 180, 210));

    expect(world.store.getSnapshot().undoLabel).toBe("resize sign");
    world.store.undo();
    expect(world.store.document).toBe(moved);
    world.store.undo();
    expect(world.store.document).toBe(drawn);
    world.store.undo();
    expect(world.store.document).toBe(initial);
    expect(world.store.canUndo).toBe(false);
  });

  it("records nothing at all for a gesture that changed nothing", () => {
    // A press and release on a grip with no move in between. `stageOrDiscard`
    // discards a geometry equal to the committed one, and `commit` answers false
    // to a preview that never existed — so `canUndo` is where it was found.
    const world = picked();
    const before = world.store.document;
    world.send(down(GRIPS.se), up(GRIPS.se));
    expect(world.store.document).toBe(before);
    expect(world.store.canUndo).toBe(false);
  });
});
