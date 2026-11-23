import { describe, expect, it } from "vitest";

import { EMPTY_SELECTION, selectOnly } from "../../state/selection";
import { contextOf, pixelOf, scanBox, scanDocumentOf, scanLine } from "./_scan";
import { scanHandleLayout, scanVertexLayout } from "./overlay";
import { faceHandles, hitTest3D, yawRing } from "./scene";

const document = scanDocumentOf(scanBox("near"), scanBox("far", { center: [12, 6, 1] }));

describe("scanHandleLayout", () => {
  it("is empty unless exactly one box is selected", () => {
    expect(scanHandleLayout(contextOf(document, { selection: EMPTY_SELECTION }))).toBeNull();
    expect(scanHandleLayout(contextOf(document, { selection: new Set(["near", "far"]) }))).toBeNull();
  });

  it("puts each face handle where the hit test finds it", () => {
    const scene = contextOf(document, { selection: selectOnly("near") });
    const layout = scanHandleLayout(scene);
    expect(layout?.id).toBe("near");
    expect(layout?.handles).toHaveLength(6);
    for (const handle of layout?.handles ?? []) {
      expect(hitTest3D(scene, handle.point)).toEqual({ kind: "face", id: "near", face: handle.face });
    }
    const expected = faceHandles(scanBox("near").geometry, "lidar_flu").map((one) => pixelOf(scene, one.point));
    expect(layout?.handles.map((one) => one.point)).toEqual(expected);
  });

  it("traces the yaw ring the hit test grabs", () => {
    const scene = contextOf(document, { selection: selectOnly("near") });
    const layout = scanHandleLayout(scene);
    expect(layout?.ring).toHaveLength(1);
    const ring = layout?.ring[0] ?? [];
    expect(ring.length).toBeGreaterThan(32);
    const geometry = yawRing(scanBox("near").geometry, "lidar_flu");
    expect(ring[0]).toEqual(pixelOf(scene, [geometry.center[0] + geometry.radius, geometry.center[1], geometry.center[2]]));
    const middle = ring[Math.floor(ring.length / 3)];
    expect(hitTest3D(scene, middle)).toMatchObject({ kind: "yaw-ring", id: "near" });
  });

  it("follows the box it is given, so a staged drag moves the handles", () => {
    const moved = scanDocumentOf(scanBox("near", { center: [3, 0, 1] }));
    const before = scanHandleLayout(contextOf(document, { selection: selectOnly("near") }));
    const after = scanHandleLayout(contextOf(moved, { selection: selectOnly("near") }));
    expect(after?.handles[0]?.point).not.toEqual(before?.handles[0]?.point);
  });
});

describe("scanVertexLayout", () => {
  const lane = scanLine("lane", [[0, -3, 0], [4, -3, 0], [8, -4, 0]]);
  const withLane = scanDocumentOf(scanBox("near"), lane);

  it("is empty unless exactly one polyline is selected", () => {
    expect(scanVertexLayout(contextOf(withLane, { selection: EMPTY_SELECTION }))).toBeNull();
    expect(scanVertexLayout(contextOf(withLane, { selection: selectOnly("near") }))).toBeNull();
  });

  it("puts each vertex where the hit test finds it", () => {
    const scene = contextOf(withLane, { selection: selectOnly("lane") });
    const layout = scanVertexLayout(scene);
    expect(layout?.id).toBe("lane");
    expect(layout?.vertices.map((one) => one.index)).toEqual([0, 1, 2]);
    for (const vertex of layout?.vertices ?? []) {
      expect(hitTest3D(scene, vertex.point)).toEqual({ kind: "vertex", id: "lane", index: vertex.index });
    }
  });
});
