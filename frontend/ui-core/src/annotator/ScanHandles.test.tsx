import { createScanDocument, EMPTY_SELECTION, selectOnly, topDownCamera, type Scene3D } from "@visionset/annotator";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScanHandles } from "./ScanHandles";

const SCHEMA = { project_id: "p", version: 1, classes: [], description: null, created_at: null, provenance: null };

function scene(selection = selectOnly("box")): Scene3D {
  const document = createScanDocument({ id: "scan-1", width: 0, height: 0, modality: "point_cloud" }, SCHEMA, [
    {
      id: "box",
      asset_id: "scan-1",
      label_class: "car",
      schema_version: 1,
      geometry: { type: "cuboid_3d", center: [0, 0, 1], size: [4, 2, 2], yaw: 0 },
      attributes: {},
      provenance: "human",
      model_ref: null,
      confidence: null,
      job_id: null,
    },
    {
      id: "lane",
      asset_id: "scan-1",
      label_class: "curb",
      schema_version: 1,
      geometry: { type: "polyline_3d", points: [[0, -2, 0], [4, -2, 0], [8, -3, 0]], visibility: undefined },
      attributes: {},
      provenance: "human",
      model_ref: null,
      confidence: null,
      job_id: null,
    },
  ]);
  return {
    document,
    selection,
    frame: "lidar_flu",
    camera: { yaw: Math.PI, pitch: 1.2, distance: 30, target: [0, 0, 0] },
    viewport: { width: 800, height: 600 },
  };
}

describe("ScanHandles", () => {
  it("draws the face handles turned towards the camera and the yaw ring over the selected box, in tokens", () => {
    render(<ScanHandles scene={scene()} />);
    const svg = screen.getByTestId("scan-handles");
    expect(svg.getAttribute("data-target")).toBe("box");
    expect(svg.getAttribute("width")).toBe("800");
    for (const face of ["back", "top"]) {
      expect(screen.getByTestId(`scan-handle-${face}`).getAttribute("class")).toContain("stroke-foreground");
    }
    expect(screen.getByTestId("scan-yaw-ring").getAttribute("points")?.split(" ").length).toBeGreaterThan(32);
    expect(svg.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it("over the top-down view, draws the footprint, the four side handles and a yaw handle on the heading", () => {
    const top: Scene3D = {
      ...scene(),
      camera: topDownCamera([0, 0, 0], 30),
      view: "top-down",
    };
    render(<ScanHandles scene={top} testIdPrefix="scan-top" />);
    expect(screen.getByTestId("scan-top-handles").getAttribute("data-target")).toBe("box");
    expect(screen.getByTestId("scan-top-footprint").getAttribute("points")?.split(" ")).toHaveLength(4);
    for (const face of ["front", "back", "left", "right"]) expect(screen.getByTestId(`scan-top-handle-${face}`)).toBeTruthy();
    expect(screen.queryByTestId("scan-top-handle-top")).toBeNull();
    expect(screen.queryByTestId("scan-handles")).toBeNull();
    const knob = screen.getByTestId("scan-top-yaw-handle");
    const front = screen.getByTestId("scan-top-handle-front");
    // Yaw 0 heads forward, which the top-down view draws up the screen.
    expect(Number(knob.getAttribute("cy"))).toBeLessThan(Number(front.getAttribute("y")));
    expect(Number(knob.getAttribute("cx"))).toBeCloseTo(400, 0);
  });

  it("draws no handle on a face turned away from the camera, and follows the camera round", () => {
    const { unmount } = render(<ScanHandles scene={scene()} />);
    for (const face of ["front", "left", "right", "bottom"]) expect(screen.queryByTestId(`scan-handle-${face}`)).toBeNull();
    unmount();

    render(<ScanHandles scene={{ ...scene(), camera: { yaw: 0, pitch: 0.5, distance: 30, target: [0, 0, 0] } }} />);
    expect(screen.getByTestId("scan-handle-front")).toBeTruthy();
    expect(screen.getByTestId("scan-handle-top")).toBeTruthy();
    expect(screen.queryByTestId("scan-handle-back")).toBeNull();
  });

  it("over the perspective view, draws neither footprint nor yaw handle", () => {
    render(<ScanHandles scene={scene()} />);
    expect(screen.queryByTestId("scan-footprint")).toBeNull();
    expect(screen.queryByTestId("scan-yaw-handle")).toBeNull();
  });

  it("draws nothing when no single label is selected and nothing is being drawn", () => {
    render(<ScanHandles scene={scene(EMPTY_SELECTION)} />);
    expect(screen.queryByTestId("scan-handles")).toBeNull();
  });

  it("draws a handle on each vertex of the selected polyline, and no cuboid handles", () => {
    render(<ScanHandles scene={scene(selectOnly("lane"))} />);
    expect(screen.getByTestId("scan-handles").getAttribute("data-target")).toBe("lane");
    for (const index of [0, 1, 2]) {
      expect(screen.getByTestId(`scan-vertex-${index}`).getAttribute("class")).toContain("stroke-foreground");
    }
    expect(screen.queryByTestId("scan-handle-front")).toBeNull();
    expect(screen.queryByTestId("scan-yaw-ring")).toBeNull();
  });

  it("over the top-down view, draws the selected polyline's vertex handles too", () => {
    const top: Scene3D = { ...scene(selectOnly("lane")), camera: topDownCamera([0, 0, 0], 30), view: "top-down" };
    render(<ScanHandles scene={top} testIdPrefix="scan-top" />);
    expect(screen.getAllByTestId(/^scan-top-vertex-\d$/)).toHaveLength(3);
  });

  it("draws the placed vertices of a polyline being drawn", () => {
    const draft = [[0, 0, 0], [3, 1, 0]] as const;
    render(<ScanHandles scene={scene(EMPTY_SELECTION)} draft={draft} />);
    expect(screen.getByTestId("scan-handles").getAttribute("data-target")).toBe("draft");
    expect(screen.getAllByTestId(/^scan-draft-vertex-\d$/)).toHaveLength(2);
    expect(screen.getByTestId("scan-handles").innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
