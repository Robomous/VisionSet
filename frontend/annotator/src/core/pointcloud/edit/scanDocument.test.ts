import { describe, expect, it } from "vitest";

import { DocumentError } from "../../state/document";
import { cuboidOf, SCAN, SCAN_SCHEMA, scanBox, scanDocumentOf } from "./_scan";
import {
  addScanAnnotation,
  createScanDocument,
  removeScanAnnotations,
  replaceScanAnnotation,
  scanDocumentFromWire,
  scanEditability,
} from "./scanDocument";

describe("scanDocumentFromWire", () => {
  it("holds the scan's cuboids and polylines and parses, then leaves out, everything else", () => {
    const path = { ...scanBox("path"), geometry: { type: "polyline_3d", points: [[0, 0, 0], [1, 1, 1]] } };
    const tag = { ...scanBox("tag"), geometry: { type: "classification_tag" } };
    const document = scanDocumentFromWire({
      asset: { id: SCAN.id, width: null, height: null, modality: "point_cloud" },
      schema: SCAN_SCHEMA,
      annotations: [path, scanBox("car-1"), tag],
    });
    expect([...document.annotations.keys()]).toEqual(["path", "car-1"]);
    expect(document.annotations.get("path")?.geometry.type).toBe("polyline_3d");
    expect(document.annotations.get("car-1")?.provenance).toBe("import");
  });

  it("still refuses a malformed label it would have left out", () => {
    const broken = { ...scanBox("path"), geometry: { type: "polyline_3d", points: [[0, 0]] } };
    expect(() =>
      scanDocumentFromWire({
        asset: { id: SCAN.id, width: null, height: null, modality: "point_cloud" },
        schema: SCAN_SCHEMA,
        annotations: [broken],
      }),
    ).toThrow(/\[x, y, z\] triple/);
  });

  it("refuses an image asset: an image's 3D labels stay read-only overlays", () => {
    expect(() => createScanDocument({ id: "image", width: 10, height: 10 }, SCAN_SCHEMA)).toThrow(DocumentError);
  });
});

describe("scanEditability", () => {
  it("is editable in the frame the source declares", () => {
    expect(scanEditability(SCAN, "lidar_rfu")).toEqual({ editable: true, frame: "lidar_rfu" });
  });

  it("is off when the source declares no frame, though the viewer still draws one", () => {
    expect(scanEditability(SCAN, null)).toEqual({ editable: false, reason: "frame-undeclared" });
    expect(scanEditability(SCAN, "lidar_xyz")).toEqual({ editable: false, reason: "frame-undeclared" });
  });

  it("is off on an image", () => {
    expect(scanEditability({ id: "image", width: 10, height: 10 }, "lidar_flu")).toEqual({
      editable: false,
      reason: "not-a-scan",
    });
  });
});

describe("the scan document's operations", () => {
  it("adds at the end, replaces in place, removes all or nothing", () => {
    const start = scanDocumentOf(scanBox("a"), scanBox("b"));
    const added = addScanAnnotation(start, scanBox("c"));
    expect([...added.annotations.keys()]).toEqual(["a", "b", "c"]);
    const moved = replaceScanAnnotation(added, scanBox("a", { center: [5, 5, 1] }));
    expect([...moved.annotations.keys()]).toEqual(["a", "b", "c"]);
    expect(cuboidOf(moved.annotations.get("a")).geometry.center).toEqual([5, 5, 1]);
    expect(cuboidOf(start.annotations.get("a")).geometry.center).toEqual([0, 0, 1]);
    expect(() => removeScanAnnotations(moved, ["b", "missing"])).toThrow(DocumentError);
    expect([...removeScanAnnotations(moved, ["b"]).annotations.keys()]).toEqual(["a", "c"]);
    expect(removeScanAnnotations(moved, [])).toBe(moved);
  });

  it("refuses a repeated id, an unknown id and another asset's label", () => {
    const start = scanDocumentOf(scanBox("a"));
    expect(() => addScanAnnotation(start, scanBox("a"))).toThrow(DocumentError);
    expect(() => replaceScanAnnotation(start, scanBox("z"))).toThrow(DocumentError);
    expect(() => addScanAnnotation(start, { ...scanBox("b"), asset_id: "elsewhere" })).toThrow(DocumentError);
    expect(() => scanDocumentOf(scanBox("a"), scanBox("a"))).toThrow(DocumentError);
  });
});
