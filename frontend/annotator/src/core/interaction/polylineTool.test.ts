/**
 * The polyline tool in one file: draw a lane, end it deliberately, hit it, move it,
 * edit its vertices, and stop at two.
 *
 * The policy, restated so a reader does not have to go and find `machine.ts`'s
 * header: a path has **no close ring**, so a press anywhere places a vertex; a
 * press on the vertex just placed is that same vertex and never appends; a session
 * ends on a double-click or on `commit`, and only once it has two points.
 *
 * ## What this file does not repeat
 *
 * `machine.test.ts` sweeps the table's silent squares and the cancel rows for every
 * state including this one, and `polygonTool.test.ts` owns the polygon's ring. What
 * is here is the matrix on top: the two ways to end, the swallowed press, the
 * take-back, the hit test that had no answer before, and the two-point floor.
 *
 * ## The ordering claim is the one worth reading first
 *
 * **Nothing sorts the points.** TuSimple's ascending-Y rule is enforced at export,
 * in `visionset.formats.lanes`, precisely so that the drawing end never has to
 * guess which way a lane runs — and a tool that normalised here would silently
 * reverse half of what somebody drew, in a way no assertion downstream could tell
 * from intent. `draws its points in the order they were placed` is that rule, and
 * the lane it draws runs **upward** — Y descending — so a sort into TuSimple's
 * ascending-Y order would reverse it and the reversed lane would still look
 * perfectly well-formed. Asserting the order is the only thing that separates them.
 */

import { describe, expect, it } from "vitest";

import { geometryContains } from "../geometry/hitTest";
import { MIN_POLYLINE_POINTS } from "../geometry/polygon";
import { VERTEX_TOLERANCE_PX, assetTolerances } from "../geometry/tolerance";
import { annotationById } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { Point, PolylineGeometry } from "../types";
import { PATH_BODY, PATH_ID, PATH_VERTEX, World, doubleClick, down, move, up } from "./_scene";
import { IDLE } from "./state";

/** Three points running up and to the right — deliberately in descending Y. */
const A: Point = [200, 400];
const B: Point = [300, 300];
const C: Point = [400, 200];

/** A world holding the polyline tool, so a press places a vertex. */
function drawing(): World {
  const world = new World();
  world.activeClass = "path";
  return world;
}

/** A world in select mode with the scene's path picked, so its vertices resolve. */
function picked(): World {
  const world = new World();
  world.send(down(PATH_BODY), up(PATH_BODY));
  return world;
}

function polylineOf(document: AnnotationDocument, id: string): PolylineGeometry {
  const geometry = annotationById(document, id)?.geometry;
  if (geometry?.type !== "polyline") {
    throw new Error(`annotation ${id} is not a polyline`);
  }
  return geometry;
}

/** The one annotation a drawing session produced. `World` mints `n1`, `n2`, … */
function drawn(world: World): PolylineGeometry {
  return polylineOf(world.store.document, "n1");
}

describe("placing vertices", () => {
  it("opens the session on the first press and appends on each one after", () => {
    const world = drawing();
    world.dispatch(down(A));
    expect(world.state).toEqual({
      type: "drawing-polyline",
      labelClass: "path",
      points: [A],
      cursor: A,
    });
    world.send(down(B), down(C));
    expect(world.state.type === "drawing-polyline" && world.state.points).toEqual([A, B, C]);
  });

  it("appends near the first vertex, because a path has no ring to close", () => {
    // **Three points before the press, deliberately.** A polygon's close ring only
    // fires at `MIN_POLYGON_POINTS`, so a two-point buffer would answer `too-few`
    // and swallow the press either way — a fixture that stopped there could not
    // tell "no ring" from "ring not yet armed", and a ring added to this row would
    // pass it. With three placed, a polygon *would* close here; the path appends.
    const world = drawing();
    world.send(down(A), down(B), down(C), down([A[0] + 2, A[1] + 2]));

    expect(world.state.type).toBe("drawing-polyline");
    expect(world.state.type === "drawing-polyline" && world.state.points).toHaveLength(4);
    expect(world.store.canUndo).toBe(false);
    expect(world.minted).toBe(0);
  });

  it("swallows a press on the vertex it just placed, so a double-click ends cleanly", () => {
    const world = drawing();
    world.send(down(A), down(B), down([B[0] + VERTEX_TOLERANCE_PX - 1, B[1]]));
    expect(world.state.type === "drawing-polyline" && world.state.points).toEqual([A, B]);
  });

  it("writes nothing to the document until the session ends", () => {
    const world = drawing();
    const before = world.store.document;
    world.send(down(A), down(B), move([250, 250]));
    expect(world.store.document).toBe(before);
    expect(world.store.preview).toBeNull();
    expect(world.store.canUndo).toBe(false);
    expect(world.minted).toBe(0);
  });

  it("clamps a vertex placed outside the asset", () => {
    const world = drawing();
    world.send(down([-40, -40]), down(B));
    world.dispatch({ type: "commit" });
    expect(drawn(world).points[0]).toEqual([0, 0]);
  });
});

describe("ending the path", () => {
  it("ends on commit, and the whole session is one undo step", () => {
    const world = drawing();
    const before = world.store.document;
    world.send(down(A), down(B), down(C));
    world.dispatch({ type: "commit" });

    expect(world.state).toBe(IDLE);
    expect(drawn(world).points).toEqual([A, B, C]);
    expect(world.minted).toBe(1);
    world.store.undo();
    expect(world.store.document).toBe(before);
  });

  it("ends on a double-click, sending what an adapter really sends", () => {
    // Two full press/release pairs and *then* the `double-click` — the sequence a
    // DOM adapter produces. Without the swallowed-duplicate rule the second press
    // would stack a vertex on top of the first, which is the bug that rule exists
    // for and which sending the `double-click` alone would hide.
    const world = drawing();
    world.send(down(A), up(A), down(B), up(B), doubleClick(B));

    expect(world.state).toBe(IDLE);
    expect(drawn(world).points).toEqual([A, B]);
  });

  it("draws its points in the order they were placed, and nothing sorts them", () => {
    // The lane runs **upward**: Y descends from 400 to 200. A tool that normalised
    // to ascending Y — TuSimple's rule, which is enforced at export and must not be
    // enforced here — would reverse it, and the reversed lane would look perfectly
    // well-formed. Asserting the order is the only thing that can tell them apart.
    const world = drawing();
    world.send(down(A), down(B), down(C));
    world.dispatch({ type: "commit" });

    expect(drawn(world).points).toEqual([A, B, C]);
    expect(drawn(world).points.map(([, y]) => y)).toEqual([400, 300, 200]);
  });

  it("refuses to end on one point, and keeps the session alive rather than dropping it", () => {
    const world = drawing();
    world.dispatch(down(A));
    world.dispatch({ type: "commit" });

    expect(world.state.type).toBe("drawing-polyline");
    expect(world.store.canUndo).toBe(false);
    // Two is the floor, and it is the polyline's own — a polygon needs three.
    expect(MIN_POLYLINE_POINTS).toBe(2);
    world.dispatch(down(B));
    world.dispatch({ type: "commit" });
    expect(world.state).toBe(IDLE);
  });

  it("takes back the last point, and the last one of all returns to idle", () => {
    const world = drawing();
    world.send(down(A), down(B), down(C));

    world.dispatch({ type: "take-back-point" });
    expect(world.state.type === "drawing-polyline" && world.state.points).toEqual([A, B]);
    world.dispatch({ type: "take-back-point" });
    world.dispatch({ type: "take-back-point" });
    expect(world.state).toBe(IDLE);
    expect(world.store.canUndo).toBe(false);
  });

  it("abandons the whole session on escape, having written nothing", () => {
    const world = drawing();
    const before = world.store.document;
    world.send(down(A), down(B), down(C));
    world.dispatch({ type: "cancel" });

    expect(world.state).toBe(IDLE);
    expect(world.store.document).toBe(before);
    expect(world.store.canUndo).toBe(false);
  });
});

describe("reaching a lane on the canvas", () => {
  const path = () => polylineOf(new World().store.document, PATH_ID);

  it("is under a point near its outline, which is the only way an open shape is hit", () => {
    const tolerance = assetTolerances(1).shape;
    // On the first segment, between the two vertices.
    expect(geometryContains(path(), [560, 300], tolerance)).toBe(true);
    // Just off it, inside the band.
    expect(geometryContains(path(), [560, 300 + tolerance - 1], tolerance)).toBe(true);
  });

  it("is not under a point in the region a closed shape would call inside", () => {
    // `[520, 380]` sits inside the triangle the path's two segments would enclose
    // if it had a third, closing one. It has no inside, so nothing is there — and
    // this is exactly what a closed-edge walk would get wrong.
    expect(geometryContains(path(), [520, 380], assetTolerances(1).shape)).toBe(false);
  });

  it("selects on a press, where before there was nothing to press", () => {
    const world = new World();
    world.dispatch(down(PATH_BODY));
    expect([...world.store.selection]).toEqual([PATH_ID]);
  });
});

describe("moving and editing a lane", () => {
  it("moves rigidly, and one drag is one undo step", () => {
    const world = picked();
    const before = world.store.document;
    const to: Point = [PATH_BODY[0] - 40, PATH_BODY[1] + 20];
    world.send(down(PATH_BODY), move(to));
    expect(world.store.preview).not.toBeNull();
    world.dispatch(up(to));

    // Every pairwise distance survives: one offset, applied to all three.
    expect(polylineOf(world.store.document, PATH_ID).points).toEqual([
      [460, 320],
      [580, 320],
      [580, 420],
    ]);
    world.store.undo();
    expect(world.store.document).toBe(before);
  });

  it("clamps the translation, not the vertices, so a lane against an edge keeps its shape", () => {
    // The path is 120 wide and its right edge is 20px from the asset's, so a drag
    // 200px to the right can only travel 20 — and the *whole* shape stops. v1
    // clamped each vertex independently, which piled them onto the edge and
    // flattened the shape permanently; `translatedPoints` is the one clamp both
    // geometries share, and this is that rule seen from the polyline's side.
    const world = picked();
    const to: Point = [PATH_BODY[0] + 200, PATH_BODY[1]];
    world.send(down(PATH_BODY), move(to), up(to));

    const points = polylineOf(world.store.document, PATH_ID).points;
    expect(points).toEqual([
      [520, 300],
      [640, 300],
      [640, 400],
    ]);
    // Still 120 wide: pinned, not deformed.
    expect(points[1][0] - points[0][0]).toBe(120);
  });

  it("drags one vertex and leaves the others where they were", () => {
    const world = picked();
    world.send(down(PATH_VERTEX), move([480, 260]), up([480, 260]));

    expect(polylineOf(world.store.document, PATH_ID).points).toEqual([
      [480, 260],
      [620, 300],
      [620, 400],
    ]);
  });

  it("inserts a vertex on a double-click over a segment", () => {
    const world = picked();
    world.dispatch(doubleClick([560, 300]));

    expect(polylineOf(world.store.document, PATH_ID).points).toEqual([
      [500, 300],
      [560, 300],
      [620, 300],
      [620, 400],
    ]);
  });

  it("never offers the segment a path does not have, so no insert appends a duplicate", () => {
    // The closed twin of this path would have a third edge from [620,400] back to
    // [500,300]; a point near where that edge would run must find nothing. If
    // `nearestEdge` were used here instead of its open sibling, this would insert.
    const world = picked();
    const before = world.store.document;
    world.dispatch(doubleClick([560, 350]));

    expect(world.store.document).toBe(before);
  });

  it("deletes a vertex, and refuses at two rather than deleting the lane", () => {
    const world = picked();
    world.dispatch(down(PATH_VERTEX, "secondary"));
    expect(polylineOf(world.store.document, PATH_ID).points).toHaveLength(2);

    const atTheFloor = world.store.document;
    world.dispatch(down([620, 300], "secondary"));
    // Nothing happens, inherited from the polygon: a gesture that escalates from
    // "remove this vertex" to "remove the whole lane" at an invisible boundary is
    // the same surprise whichever shape it happens to.
    expect(world.store.document).toBe(atTheFloor);
    expect(annotationById(world.store.document, PATH_ID)).toBeDefined();
  });
});
