import { describe, expect, it } from "vitest";

import { annotationById } from "../state/document";
import type { PolylineGeometry } from "../types";
import { PATH_ID, World } from "./_scene";
import { setVertexOccludedCommand } from "./vertexVisibility";

function lane(world: World): PolylineGeometry {
  const geometry = annotationById(world.store.document, PATH_ID)?.geometry;
  if (geometry?.type !== "polyline") throw new Error("not a polyline");
  return geometry;
}

function mark(world: World, index: number, occluded: boolean): void {
  const command = setVertexOccludedCommand(world.store.document, PATH_ID, index, occluded);
  if (command === null) throw new Error("nothing to execute");
  world.store.execute(command);
}

describe("marking a vertex occluded", () => {
  it("is one undo step, and redo puts it back", () => {
    const world = new World();
    const before = world.store.document;
    mark(world, 1, true);
    expect(lane(world).visibility).toEqual([0, 1, 0]);

    world.store.undo();
    expect(world.store.document).toBe(before);
    expect(lane(world).visibility).toBeUndefined();
    world.store.redo();
    expect(lane(world).visibility).toEqual([0, 1, 0]);
  });

  it("clears to visible, as its own step", () => {
    const world = new World();
    mark(world, 1, true);
    mark(world, 1, false);
    expect(lane(world).visibility).toEqual([0, 2, 0]);
    world.store.undo();
    expect(lane(world).visibility).toEqual([0, 1, 0]);
  });

  it("returns nothing to execute for a no-op, a missing annotation, or a non-polyline", () => {
    const world = new World();
    const document = world.store.document;
    expect(setVertexOccludedCommand(document, PATH_ID, 0, false)).toBeNull();
    expect(setVertexOccludedCommand(document, "missing", 0, true)).toBeNull();
    const other = [...document.annotations.values()].find((a) => a.geometry.type !== "polyline");
    expect(other).toBeDefined();
    expect(setVertexOccludedCommand(document, other?.id ?? "", 0, true)).toBeNull();
  });
});
