import { describe, expect, it } from "vitest";

import { selectOnly } from "../../state/selection";
import { faceCenter } from "../cuboid";
import { contextOf, pixelOf, scanBox, scanDocumentOf, scanLine } from "./_scan";
import { faceHandles, hitTest3D, yawRing } from "./scene";

const document = scanDocumentOf(scanBox("near", { center: [0, 0, 1] }), scanBox("far", { center: [12, 6, 1] }));

describe("hitTest3D", () => {
  it("hits a box's body, and nothing in open ground", () => {
    const scene = contextOf(document);
    expect(hitTest3D(scene, pixelOf(scene, [12, 6, 2]))).toMatchObject({ kind: "body", id: "far" });
    expect(hitTest3D(scene, pixelOf(scene, [-8, 8, 0]))).toBeNull();
  });

  it("offers no handles on a box nobody selected", () => {
    const scene = contextOf(document);
    expect(hitTest3D(scene, pixelOf(scene, faceCenter(scanBox("x").geometry, "lidar_flu", "front")))).toMatchObject({
      kind: "body",
      id: "near",
    });
  });

  it("finds each face handle of the selected box", () => {
    const scene = contextOf(document, { selection: selectOnly("near") });
    for (const handle of faceHandles(scanBox("near").geometry, "lidar_flu")) {
      expect(hitTest3D(scene, pixelOf(scene, handle.point))).toEqual({ kind: "face", id: "near", face: handle.face });
    }
  });

  it("finds the yaw ring of the selected box, and only near the ring", () => {
    const scene = contextOf(document, { selection: selectOnly("near") });
    const ring = yawRing(scanBox("near").geometry, "lidar_flu");
    const at = (radius: number) =>
      pixelOf(scene, [ring.center[0] + radius * Math.SQRT1_2, ring.center[1] - radius * Math.SQRT1_2, ring.center[2]]);
    expect(hitTest3D(scene, at(ring.radius))).toMatchObject({ kind: "yaw-ring", id: "near" });
    expect(hitTest3D(scene, at(ring.radius + 1.5))).toBeNull();
  });

  it("the ring is level with the bottom face and clear of the footprint", () => {
    const geometry = scanBox("x").geometry;
    const ring = yawRing(geometry, "lidar_flu");
    expect(ring.level).toBe(0);
    expect(ring.radius).toBeGreaterThan(Math.hypot(geometry.size[0], geometry.size[1]) / 2);
  });
});

describe("hitTest3D on a polyline", () => {
  const lines = scanDocumentOf(scanLine("lane-1", [[-4, 6, 0], [0, 6, 0], [4, 6, 0]]));

  it("hit test prefers a selected polyline's vertex over a segment", () => {
    const vertex = pixelOf(contextOf(lines), [0, 6, 0]);
    expect(hitTest3D(contextOf(lines, { selection: selectOnly("lane-1") }), vertex)).toEqual({ kind: "vertex", id: "lane-1", index: 1 });
    expect(hitTest3D(contextOf(lines), vertex)).toMatchObject({ kind: "segment", id: "lane-1" });
  });

  it("hits a segment only near it, at the point on the segment", () => {
    const scene = contextOf(lines);
    const hit = hitTest3D(scene, pixelOf(scene, [2, 6, 0]));
    if (hit?.kind !== "segment") throw new Error("no segment hit");
    expect(hit.segment).toBe(1);
    hit.point.forEach((value, i) => expect(value).toBeCloseTo([2, 6, 0][i] ?? NaN, 6));
    expect(hitTest3D(scene, pixelOf(scene, [2, 8, 0]))).toBeNull();
  });

  it("the selected box's face handle wins over a lane segment under it, and a segment over a body", () => {
    const front = faceCenter(scanBox("x").geometry, "lidar_flu", "front");
    const crossing = scanDocumentOf(scanBox("near"), scanLine("lane-1", [[front[0], -3, front[2]], [front[0], 3, front[2]]]));
    const selected = contextOf(crossing, { selection: selectOnly("near") });
    expect(hitTest3D(selected, pixelOf(selected, front))).toEqual({ kind: "face", id: "near", face: "front" });
    const unselected = contextOf(crossing);
    expect(hitTest3D(unselected, pixelOf(unselected, front))).toMatchObject({ kind: "segment", id: "lane-1" });
  });
});
