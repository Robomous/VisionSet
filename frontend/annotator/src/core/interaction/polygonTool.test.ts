/**
 * #44's acceptance criteria in one file: the draw/close/cancel/edit event
 * sequences, and the degenerate cases the issue asks to be handled "per documented
 * policy".
 *
 * The policy, restated here so a reader of the tests does not have to go and find
 * `machine.ts`'s header: a press inside the ring around the first vertex is a close
 * attempt and never appends; a press on the vertex just placed is that same vertex
 * and never appends; everything else appends.
 *
 * ## What this file does *not* repeat
 *
 * `gestures.test.ts` already walks a polygon session and pins "four clicks, one
 * entry", the escape-drops-everything rule and the pointer-cancel asymmetry.
 * `machine.test.ts` owns the table's silent squares and the vertex-delete
 * refusals. This is the matrix on top: the three ways to close, the two ways a
 * press is swallowed, the take-back, and one undo assertion per edit.
 *
 * ## Undo is asserted by reference where the prior document is in hand
 *
 * `toBe(before)`, not `toEqual` — `bboxTool.test.ts` sets out why. A geometry is a
 * value and gets `toEqual`; a document is an identity, because the log keeps
 * snapshots and undo is a pointer swap.
 *
 * ## The double-click test sends what an adapter really sends
 *
 * Two full press/release pairs *and then* a `double-click`, which is the sequence a
 * DOM adapter produces. Sending the `double-click` alone would test a gesture no
 * user can perform and would hide the duplicate-vertex problem the tolerance rule
 * exists to solve.
 */

import { describe, expect, it } from "vitest";

import { MIN_POLYGON_POINTS } from "../geometry/polygon";
import {
  CLOSE_POLYGON_TOLERANCE_PX,
  VERTEX_TOLERANCE_PX,
  assetTolerances,
} from "../geometry/tolerance";
import { annotationById } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import { selectOnly } from "../state/selection";
import type { Point, PolygonGeometry } from "../types";
import { POLY_BODY, POLY_ID, POLY_VERTEX, World, doubleClick, down, move, up } from "./_scene";
import { IDLE } from "./state";

/** Three points that close a triangle, far enough apart that no rule swallows one. */
const A: Point = [200, 200];
const B: Point = [300, 200];
const C: Point = [300, 300];

/** A world holding the polygon tool, so a press places a vertex. */
function drawing(): World {
  const world = new World();
  world.activeClass = "lane";
  return world;
}

/** A world in select mode with the scene's polygon picked, so vertices resolve. */
function picked(): World {
  const world = new World();
  world.send(down(POLY_BODY), up(POLY_BODY));
  return world;
}

function polygonOf(document: AnnotationDocument, id: string): PolygonGeometry {
  const geometry = annotationById(document, id)?.geometry;
  if (geometry?.type !== "polygon") {
    throw new Error(`annotation ${id} is not a polygon`);
  }
  return geometry;
}

/** The one annotation a drawing session produced. `World` mints `n1`, `n2`, … */
function drawn(world: World): PolygonGeometry {
  return polygonOf(world.store.document, "n1");
}

describe("placing vertices", () => {
  it("opens the session on the first press and appends on each one after", () => {
    const world = drawing();
    world.dispatch(down(A));
    expect(world.state).toEqual({
      type: "drawing-polygon",
      labelClass: "lane",
      points: [A],
      cursor: A,
    });
    world.send(down(B), down(C));
    expect(world.state.type === "drawing-polygon" && world.state.points).toEqual([A, B, C]);
  });

  it("writes nothing to the document until the session closes", () => {
    const world = drawing();
    const before = world.store.document;
    world.send(down(A), down(B), down(C), move([250, 250]));
    expect(world.store.document).toBe(before);
    expect(world.store.preview).toBeNull();
    expect(world.store.canUndo).toBe(false);
    expect(world.minted).toBe(0);
  });

  it("clamps a vertex placed outside the asset, unlike v1", () => {
    // v1 clamped bbox corners and keypoints and left pending polygon points alone,
    // so a click in the padding stored a negative coordinate.
    const world = drawing();
    world.send(down([-40, -40]), down(B), down(C));
    world.dispatch({ type: "commit" });
    expect(drawn(world).points[0]).toEqual([0, 0]);
  });

  it("rubber-bands to where the vertex would land, not to where the pointer is", () => {
    const world = drawing();
    world.send(down(A), move([-40, 900]));
    expect(world.state.type === "drawing-polygon" && world.state.cursor).toEqual([0, 480]);
  });
});

describe("closing, three ways, all of them one command", () => {
  const closers = [
    { how: "the first vertex", finish: (world: World) => world.dispatch(down(A)) },
    { how: "commit", finish: (world: World) => world.dispatch({ type: "commit" }) },
    { how: "double-click", finish: (world: World) => world.dispatch(doubleClick(C)) },
  ] as const;

  for (const { how, finish } of closers) {
    it(`closes on ${how}, selecting the polygon it just made`, () => {
      const world = drawing();
      const before = world.store.document;
      world.send(down(A), down(B), down(C));
      finish(world);

      expect(world.state).toBe(IDLE);
      expect(drawn(world).points).toEqual([A, B, C]);
      expect(world.store.selection).toEqual(selectOnly("n1"));
      expect(annotationById(world.store.document, "n1")?.label_class).toBe("lane");

      // One command for the whole session, however it ended.
      expect(world.store.canUndo).toBe(true);
      world.store.undo();
      expect(world.store.document).toBe(before);
      expect(world.store.canUndo).toBe(false);
    });

    it(`refuses ${how} below three points and leaves the session alive`, () => {
      const world = drawing();
      world.send(down(A), down(B));
      const before = world.state;
      finish(world);
      expect(world.state).toBe(before);
      expect(world.store.canUndo).toBe(false);
      expect(world.minted).toBe(0);
    });
  }

  it("closes anywhere inside the ring, not only dead on the first vertex", () => {
    const world = drawing();
    world.send(down(A), down(B), down(C));
    world.dispatch(down([A[0] + 6, A[1] + 6]));
    expect(world.state).toBe(IDLE);
    // The click that closed is not a fourth vertex — the shape is what was placed.
    expect(drawn(world).points).toEqual([A, B, C]);
  });

  it("keeps placing vertices just outside the ring", () => {
    const world = drawing();
    const outside: Point = [A[0] + CLOSE_POLYGON_TOLERANCE_PX + 1, A[1]];
    world.send(down(A), down(B), down(C), down(outside));
    expect(world.state.type).toBe("drawing-polygon");
    expect(world.state.type === "drawing-polygon" && world.state.points).toEqual([
      A,
      B,
      C,
      outside,
    ]);
  });

  it("holds the ring at a constant size on screen, across zoom", () => {
    // The conversion is load-bearing, not decorative: v1 compared against an
    // already-zoom-divided coordinate, so its ring was ~3 screen px at 30% and ~20
    // at 200%. Ten screen pixels here is 40 asset px at 25% and 2.5 at 400%.
    for (const zoom of [0.25, 4] as const) {
      const world = drawing();
      world.tolerances = assetTolerances(zoom);
      const tenScreenPixelsAway: Point = [A[0] + CLOSE_POLYGON_TOLERANCE_PX / zoom, A[1]];
      world.send(down(A), down(B), down(C), down(tenScreenPixelsAway));
      expect(world.state, `zoom ${zoom}`).toBe(IDLE);
      expect(drawn(world).points, `zoom ${zoom}`).toEqual([A, B, C]);
    }
  });
});

describe("the duplicate-vertex policy, which is what makes double-click honest", () => {
  it("swallows a press on the vertex just placed", () => {
    const world = drawing();
    world.send(down(A), down(B), down([B[0] + 1, B[1] + 1]));
    expect(world.state.type === "drawing-polygon" && world.state.points).toEqual([A, B]);
  });

  it("still moves the rubber band when it swallows one", () => {
    // The press placed no vertex, but the pointer is demonstrably there.
    const world = drawing();
    world.send(down(A), down(B));
    world.dispatch(down([B[0] + 1, B[1] + 1]));
    expect(world.state.type === "drawing-polygon" && world.state.cursor).toEqual([
      B[0] + 1,
      B[1] + 1,
    ]);
  });

  it("appends once the press clears the vertex tolerance", () => {
    const world = drawing();
    const clear: Point = [B[0] + VERTEX_TOLERANCE_PX + 1, B[1]];
    world.send(down(A), down(B), down(clear));
    expect(world.state.type === "drawing-polygon" && world.state.points).toEqual([A, B, clear]);
  });

  it("only ever compares against the last vertex, never an earlier one", () => {
    // Coming back to where the session started is a *close*, and coming back to a
    // middle vertex is an ordinary new vertex — neither is the duplicate rule.
    const world = drawing();
    const backToB: Point = [B[0], B[1]];
    world.send(down(A), down(B), down(C), down(backToB));
    expect(world.state.type === "drawing-polygon" && world.state.points).toEqual([A, B, C, backToB]);
  });

  it("makes a real double-click sequence produce exactly the vertices clicked", () => {
    // The finding. An adapter sends a press *and* a release for each click before
    // the double-click arrives, so without the duplicate rule the second press
    // would stack a fourth vertex onto C and the polygon would carry a duplicate
    // nobody drew.
    const world = drawing();
    world.send(down(A), up(A), down(B), up(B), down(C), up(C), down(C), up(C), doubleClick(C));
    expect(world.state).toBe(IDLE);
    expect(drawn(world).points).toEqual([A, B, C]);
  });
});

describe("taking a vertex back, and abandoning the session", () => {
  it("drops the last pending vertex on a secondary press", () => {
    const world = drawing();
    world.send(down(A), down(B), down(C));
    world.dispatch(down(C, "secondary"));
    expect(world.state.type === "drawing-polygon" && world.state.points).toEqual([A, B]);
  });

  it("takes them back one at a time, wherever the press lands", () => {
    // v1's gesture is "undo the last point", not "delete the point under me".
    const world = drawing();
    world.send(down(A), down(B), down(C));
    world.send(down([10, 10], "secondary"), down([500, 400], "secondary"));
    expect(world.state.type === "drawing-polygon" && world.state.points).toEqual([A]);
  });

  it("returns to idle rather than holding an empty buffer", () => {
    // `points` is never empty: the close ring and the affordance both measure from
    // `points[0]`, and a representable-but-unreachable empty case would put a guard
    // in each. Same place Escape from a one-point session lands.
    const world = drawing();
    world.dispatch(down(A));
    world.dispatch(down(A, "secondary"));
    expect(world.state).toBe(IDLE);
    expect(world.minted).toBe(0);
  });

  it("starts a fresh session on the next press, because the tool has not changed", () => {
    const world = drawing();
    world.send(down(A), down(A, "secondary"), down(B));
    expect(world.state.type === "drawing-polygon" && world.state.points).toEqual([B]);
  });

  it("ignores an auxiliary press instead of taking anything back", () => {
    const world = drawing();
    world.send(down(A), down(B));
    const before = world.state;
    world.dispatch(down(B, "auxiliary"));
    expect(world.state).toBe(before);
  });

  it("writes nothing to the document however far a session is wound back", () => {
    const world = drawing();
    const before = world.store.document;
    world.send(down(A), down(B), down(C), down(C, "secondary"), down(B, "secondary"));
    expect(world.store.document).toBe(before);
    expect(world.store.canUndo).toBe(false);
  });
});

describe("editing a closed polygon, one undo step each", () => {
  it("drags a vertex and commits once", () => {
    const world = picked();
    const before = world.store.document;
    world.send(down(POLY_VERTEX), move([320, 290]), up([320, 290]));
    expect(polygonOf(world.store.document, POLY_ID).points[0]).toEqual([320, 290]);
    expect(world.store.getSnapshot().undoLabel).toBe("edit lane");
    world.store.undo();
    expect(world.store.document).toBe(before);
  });

  it("inserts a vertex on an edge and commits once", () => {
    const world = picked();
    const before = world.store.document;
    // The scene's polygon spans 300..400 × 300..380; [350, 300] is its top edge.
    world.dispatch(doubleClick([350, 300]));
    const points = polygonOf(world.store.document, POLY_ID).points;
    expect(points.length).toBe(5);
    expect(points[1]).toEqual([350, 300]);
    world.store.undo();
    expect(world.store.document).toBe(before);
  });

  it("deletes a vertex and commits once", () => {
    const world = picked();
    const before = world.store.document;
    world.dispatch(down(POLY_VERTEX, "secondary"));
    expect(polygonOf(world.store.document, POLY_ID).points.length).toBe(MIN_POLYGON_POINTS);
    world.store.undo();
    expect(world.store.document).toBe(before);
  });

  it("refuses the delete that would take a triangle below three points", () => {
    const world = picked();
    world.dispatch(down(POLY_VERTEX, "secondary"));
    const triangle = world.store.document;
    world.dispatch(down([400, 300], "secondary"));
    expect(world.store.document).toBe(triangle);
    expect(polygonOf(world.store.document, POLY_ID).points.length).toBe(MIN_POLYGON_POINTS);
  });
});

describe("a long session is still one entry", () => {
  it("collapses eight placed vertices into a single undo step", () => {
    const world = drawing();
    const before = world.store.document;
    const octagon: readonly Point[] = [
      [200, 100],
      [260, 100],
      [300, 140],
      [300, 200],
      [260, 240],
      [200, 240],
      [160, 200],
      [160, 140],
    ];
    world.send(...octagon.map((point) => down(point)));
    world.dispatch({ type: "commit" });

    expect(drawn(world).points).toEqual(octagon);
    expect(world.store.getSnapshot().undoLabel).toBe("add lane");
    world.store.undo();
    expect(world.store.document).toBe(before);
    expect(world.store.canUndo).toBe(false);
  });
});
