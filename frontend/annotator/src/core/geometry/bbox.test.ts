/**
 * The box. Eight `it`s for the eight grips, because a resize that drives the wrong
 * edge for one of them is exactly the bug a single "it resizes" test would miss —
 * and one test carrying v1's own numbers for the escape that #41 closed.
 */

import { describe, expect, it } from "vitest";

import type { BboxGeometry } from "../types";
import {
  BBOX_HANDLES,
  MIN_BBOX_SIZE,
  bboxContains,
  bboxCorners,
  bboxHandlePositions,
  moveBbox,
  normalizeBbox,
  resizeBbox,
  type BboxHandle,
} from "./bbox";
import type { Bounds } from "./primitives";

const FRAME: Bounds = { width: 640, height: 480 };

/** A box with distinct edges, so a mixed-up axis cannot pass by coincidence. */
const BOX: BboxGeometry = { type: "bbox", x: 100, y: 200, width: 40, height: 80 };

function box(x: number, y: number, width: number, height: number): BboxGeometry {
  return { type: "bbox", x, y, width, height };
}

describe("a box built from two corners", () => {
  it("comes out the same whichever way the pointer went", () => {
    const expected = box(10, 20, 30, 40);
    expect(normalizeBbox([10, 20], [40, 60])).toEqual(expected);
    expect(normalizeBbox([40, 60], [10, 20])).toEqual(expected);
    expect(normalizeBbox([40, 20], [10, 60])).toEqual(expected);
    expect(normalizeBbox([10, 60], [40, 20])).toEqual(expected);
  });

  it("collapses to nothing when the corners coincide", () => {
    expect(normalizeBbox([7, 7], [7, 7])).toEqual(box(7, 7, 0, 0));
  });
});

describe("what a box contains", () => {
  it("holds a point in its middle and not one outside", () => {
    expect(bboxContains(BOX, [120, 240])).toBe(true);
    expect(bboxContains(BOX, [99, 240])).toBe(false);
    expect(bboxContains(BOX, [120, 199])).toBe(false);
    expect(bboxContains(BOX, [141, 240])).toBe(false);
    expect(bboxContains(BOX, [120, 281])).toBe(false);
  });

  it("counts the edges and the corners as inside", () => {
    expect(bboxContains(BOX, [100, 200])).toBe(true);
    expect(bboxContains(BOX, [140, 280])).toBe(true);
    expect(bboxContains(BOX, [100, 240])).toBe(true);
  });

  it("still answers for a box with no area", () => {
    // Reachable: `parseGeometry` validates only that the numbers are finite, so a
    // zero-area box loads. It is also the one a user most needs to be able to
    // click, in order to delete it.
    const flat = box(50, 50, 0, 0);
    expect(bboxContains(flat, [50, 50])).toBe(true);
    expect(bboxContains(flat, [51, 50])).toBe(false);
  });

  it("reads a negative width off the wire as the box it describes", () => {
    // Also reachable, and the naive `x <= p <= x + width` test would make this
    // box contain nothing at all.
    expect(bboxContains(box(100, 100, -40, -40), [80, 80])).toBe(true);
  });
});

describe("the eight handles", () => {
  it("sit on the corners, the edge midpoints and nowhere else", () => {
    expect(bboxHandlePositions(box(5, 7, 10, 20))).toEqual({
      nw: [5, 7],
      n: [10, 7],
      ne: [15, 7],
      e: [15, 17],
      se: [15, 27],
      s: [10, 27],
      sw: [5, 27],
      w: [5, 17],
    });
  });

  it("are listed clockwise from the top-left", () => {
    expect(BBOX_HANDLES).toEqual(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);
  });

  it("collapse onto each other on a box with no size", () => {
    const positions = bboxHandlePositions(box(9, 9, 0, 0));
    for (const handle of BBOX_HANDLES) {
      expect(positions[handle]).toEqual([9, 9]);
    }
  });

  it("names the same four points the corner ring does", () => {
    const positions = bboxHandlePositions(BOX);
    expect(bboxCorners(BOX)).toEqual([
      positions.nw,
      positions.ne,
      positions.se,
      positions.sw,
    ]);
  });
});

describe("moving a box keeps the whole of it in the asset", () => {
  it("puts the corner where it was asked to", () => {
    expect(moveBbox(BOX, [10, 20], FRAME)).toEqual(box(10, 20, 40, 80));
  });

  it("stops at each frame edge rather than hanging over it", () => {
    expect(moveBbox(BOX, [-50, 300], FRAME)).toEqual(box(0, 300, 40, 80));
    expect(moveBbox(BOX, [300, -50], FRAME)).toEqual(box(300, 0, 40, 80));
    expect(moveBbox(BOX, [9999, 300], FRAME)).toEqual(box(600, 300, 40, 80));
    expect(moveBbox(BOX, [300, 9999], FRAME)).toEqual(box(300, 400, 40, 80));
  });

  it("never changes the size", () => {
    for (const origin of [
      [-999, -999],
      [9999, 9999],
      [0, 0],
      [123, 456],
    ] as const) {
      const moved = moveBbox(BOX, origin, FRAME);
      expect(moved.width).toBe(BOX.width);
      expect(moved.height).toBe(BOX.height);
    }
  });

  it("pins a box wider than its asset to the origin rather than shrinking it", () => {
    // An annotation larger than its own asset is not a state a move can fix, and
    // deforming it to fit would destroy the data. Same call v1's moveBbox made.
    const huge = box(0, 0, 900, 900);
    expect(moveBbox(huge, [500, 500], FRAME)).toEqual(box(0, 0, 900, 900));
  });

  it("is a fixpoint, so a re-projected drag cannot drift", () => {
    const once = moveBbox(BOX, [9999, 9999], FRAME);
    expect(moveBbox(once, [9999, 9999], FRAME)).toEqual(once);
  });
});

describe("resizing from a handle", () => {
  const start = box(100, 200, 40, 80); // left 100, right 140, top 200, bottom 280

  it("drives the west edge from w and leaves the other three", () => {
    expect(resizeBbox(start, "w", [60, 999], FRAME)).toEqual(box(60, 200, 80, 80));
  });

  it("drives the east edge from e", () => {
    expect(resizeBbox(start, "e", [200, 0], FRAME)).toEqual(box(100, 200, 100, 80));
  });

  it("drives the north edge from n", () => {
    expect(resizeBbox(start, "n", [0, 150], FRAME)).toEqual(box(100, 150, 40, 130));
  });

  it("drives the south edge from s", () => {
    expect(resizeBbox(start, "s", [999, 400], FRAME)).toEqual(box(100, 200, 40, 200));
  });

  it("drives both edges from nw", () => {
    expect(resizeBbox(start, "nw", [60, 150], FRAME)).toEqual(box(60, 150, 80, 130));
  });

  it("drives both edges from ne", () => {
    expect(resizeBbox(start, "ne", [200, 150], FRAME)).toEqual(box(100, 150, 100, 130));
  });

  it("drives both edges from sw", () => {
    expect(resizeBbox(start, "sw", [60, 400], FRAME)).toEqual(box(60, 200, 80, 200));
  });

  it("drives both edges from se", () => {
    expect(resizeBbox(start, "se", [200, 400], FRAME)).toEqual(box(100, 200, 100, 200));
  });

  it("clamps the pointer to the frame before it touches an edge", () => {
    expect(resizeBbox(start, "se", [9999, 9999], FRAME)).toEqual(
      box(100, 200, FRAME.width - 100, FRAME.height - 200),
    );
  });

  it("pushes the anchored edge out to the minimum", () => {
    // Dragging e back onto the west edge would give a zero-width box; the anchor
    // at left = 100 stays put and the dragged edge is held MIN_BBOX_SIZE away.
    expect(resizeBbox(start, "e", [100, 0], FRAME)).toEqual(
      box(100, 200, MIN_BBOX_SIZE, 80),
    );
    // From the other side the anchor is the east edge, so the box grows leftward.
    expect(resizeBbox(start, "w", [140, 0], FRAME)).toEqual(
      box(140 - MIN_BBOX_SIZE, 200, MIN_BBOX_SIZE, 80),
    );
  });

  it("re-anchors when the drag flips past the anchor", () => {
    // se dragged above and left of nw: the box is valid and re-anchored, not
    // negative. v1's Math.min/Math.abs tail, kept.
    expect(resizeBbox(start, "se", [40, 100], FRAME)).toEqual(box(40, 100, 60, 100));
  });

  it("keeps the minimum-size push inside the frame, which v1 did not", () => {
    // v1, AnnotationCanvas.tsx:691. Box at x:0 width:2, grip `w`, pointer dragged
    // off the left of the image:
    //   px = clamp(-40, 0, width) -> 0;  left = 0, right = 2
    //   |right - left| = 2 < minSize 3, and "w" anchors on the right, so
    //   left = right - 3 = -1  <- a negative coordinate on a stored annotation.
    // The appended slide answers x:0, width:3 instead.
    expect(resizeBbox(box(0, 0, 2, 10), "w", [-40, 5], FRAME)).toEqual(
      box(0, 0, MIN_BBOX_SIZE, 10),
    );
    // The mirror case, off the right edge.
    expect(
      resizeBbox(box(FRAME.width - 2, 0, 2, 10), "e", [9999, 5], FRAME),
    ).toEqual(box(FRAME.width - MIN_BBOX_SIZE, 0, MIN_BBOX_SIZE, 10));
  });

  it("yields the minimum to a frame narrower than it", () => {
    // The one place the two rules collide. Bounds win: the acceptance criterion is
    // unconditional, a minimum size is a nicety.
    const narrow: Bounds = { width: 2, height: 400 };
    const answer = resizeBbox(box(0, 0, 2, 10), "w", [-40, 5], narrow);
    expect(answer.width).toBe(2);
    expect(answer.x).toBe(0);
    expect(answer.width).toBeLessThan(MIN_BBOX_SIZE);
  });

  it("repairs a box that had no area to begin with", () => {
    const answer = resizeBbox(box(50, 50, 0, 0), "se", [55, 60], FRAME);
    expect(answer).toEqual(box(50, 50, 5, 10));
  });

  it("is a fixpoint while the drag has not flipped past the anchor", () => {
    const once = resizeBbox(start, "se", [200, 400], FRAME);
    expect(resizeBbox(once, "se", [200, 400], FRAME)).toEqual(once);
  });

  it("is not a fixpoint across a flip, because a flip renames the handle", () => {
    // Worth writing down rather than discovering later: after `w` is dragged past
    // the east edge, the box has re-anchored and the *same* grip now means the
    // other side, so feeding the answer back is a different gesture. It costs
    // nothing in practice — #39's store re-projects from the committed document, so
    // a tool always passes the box the gesture began on — but it is the one
    // transform here that is not idempotent, and the property test excludes flips
    // for exactly this reason.
    const flipped = resizeBbox(box(10, 0, 20, 20), "w", [50, 5], FRAME);
    expect(flipped).toEqual(box(30, 0, 20, 20));
    expect(resizeBbox(flipped, "w", [50, 5], FRAME)).toEqual(
      box(50 - MIN_BBOX_SIZE, 0, MIN_BBOX_SIZE, 20),
    );
  });

  it("answers a box inside the frame for every handle, from anywhere", () => {
    const handles: readonly BboxHandle[] = BBOX_HANDLES;
    for (const handle of handles) {
      for (const point of [
        [-9999, -9999],
        [9999, 9999],
        [-9999, 9999],
        [9999, -9999],
      ] as const) {
        const answer = resizeBbox(start, handle, point, FRAME);
        expect(answer.x).toBeGreaterThanOrEqual(0);
        expect(answer.y).toBeGreaterThanOrEqual(0);
        expect(answer.x + answer.width).toBeLessThanOrEqual(FRAME.width);
        expect(answer.y + answer.height).toBeLessThanOrEqual(FRAME.height);
      }
    }
  });
});
