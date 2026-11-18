/**
 * The static overlay, held to the three things a consumer relies on: one drawn
 * shape per placeable annotation, a `viewBox` that is the picture's pixel frame,
 * and the class palette the annotator itself draws with. Whether the SVG's box
 * lands on the image's box is a browser fact and lives in `e2e/dataset.spec.ts`.
 */

import { Vertices, classColor } from "@visionset/annotator/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WireAnnotation } from "../annotator/jobQueries";
import type { LabelClass } from "../palette";
import { StaticAnnotationOverlay } from "./StaticAnnotationOverlay";

const VEHICLE: LabelClass = { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] };

function annotation(id: string, labelClass: string, geometry: unknown): WireAnnotation {
  return {
    id,
    asset_id: "asset-1",
    label_class: labelClass,
    schema_version: 1,
    geometry,
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

const BOX = annotation("box", "vehicle", { type: "bbox", x: 10, y: 20, width: 100, height: 50 });
const LANE = annotation("lane", "lane", {
  type: "polygon",
  points: [
    [0, 0],
    [50, 0],
    [25, 40],
  ],
});
const TAG = annotation("tag", "night", { type: "classification_tag" });
const BROKEN = annotation("broken", "vehicle", { type: "hexagon" });

describe("StaticAnnotationOverlay", () => {
  it("draws one shape per placeable annotation in the picture's own pixel frame", () => {
    render(
      <StaticAnnotationOverlay
        width={640}
        height={480}
        src="blob:picture"
        alt="frame 1"
        annotations={[BOX, LANE, TAG, BROKEN]}
      />,
    );

    expect(screen.getByTestId("preview-overlay").getAttribute("viewBox")).toBe("0 0 640 480");
    expect(screen.getByTestId("preview-shape-box").getAttribute("data-geometry")).toBe("bbox");
    expect(screen.getByTestId("preview-shape-lane").getAttribute("data-geometry")).toBe("polygon");
    // A tag has no place on the picture, and a geometry the engine cannot parse
    // is skipped rather than allowed to fail the page.
    expect(screen.queryByTestId("preview-shape-tag")).toBeNull();
    expect(screen.queryByTestId("preview-shape-broken")).toBeNull();
    expect(screen.getByTestId("preview-overlay").querySelectorAll("[data-testid^='preview-shape-']")).toHaveLength(2);

    const picture = screen.getByTestId("preview-picture");
    expect(picture.style.aspectRatio).toBe("640 / 480");
    expect(screen.getByTestId("preview-image").getAttribute("src")).toBe("blob:picture");
    expect(screen.getByTestId("preview-image").getAttribute("alt")).toBe("frame 1");
  });

  it("colours a shape by the class palette: the declared colour, else the engine's derived hue", () => {
    render(
      <StaticAnnotationOverlay
        width={640}
        height={480}
        src="blob:picture"
        alt="frame 1"
        annotations={[BOX, LANE]}
        classes={[VEHICLE]}
      />,
    );

    const box = screen.getByTestId("preview-shape-box").querySelector("rect");
    expect(box?.getAttribute("stroke")).toBe("#38bdf8");
    const lane = screen.getByTestId("preview-shape-lane").querySelector("polygon");
    expect(lane?.getAttribute("stroke")).toBe(classColor(undefined, "lane"));
  });

  it("scales the stroke with the picture's width instead of a zoom", () => {
    render(
      <StaticAnnotationOverlay width={1600} height={900} src="blob:picture" alt="wide" annotations={[BOX]} />,
    );
    // The stage's shapes read `--vs-stroke`; without a zoom the value is a
    // fraction of the width, so a 4K frame does not draw hairline boxes.
    expect(screen.getByTestId("preview-overlay").style.getPropertyValue("--vs-stroke")).toBe("4px");
  });

  it("dashes the occluded stretch of a lane and draws the rest solid", () => {
    const centerline = annotation("centerline", "centerline", {
      type: "polyline",
      points: [
        [0, 0],
        [10, 0],
        [20, 0],
        [30, 0],
      ],
      visibility: [2, 2, 1, 2],
    });
    render(
      <StaticAnnotationOverlay width={1600} height={900} src="blob:picture" alt="lane" annotations={[centerline]} />,
    );
    const runs = [...screen.getByTestId("preview-shape-centerline").querySelectorAll("polyline")];
    expect(runs.map((run) => run.getAttribute("data-occluded"))).toEqual([null, "true"]);
    expect(runs[0].style.strokeDasharray).toBe("");
    expect(runs[1].style.strokeDasharray).toContain("var(--vs-stroke)");
    expect(runs[1].getAttribute("points")).toBe("10,0 20,0 30,0");
  });

  it("draws an unrecorded lane as the single solid line it always was", () => {
    const centerline = annotation("centerline", "centerline", {
      type: "polyline",
      points: [
        [0, 0],
        [10, 0],
      ],
    });
    render(
      <StaticAnnotationOverlay width={800} height={600} src="blob:picture" alt="lane" annotations={[centerline]} />,
    );
    const runs = screen.getByTestId("preview-shape-centerline").querySelectorAll("polyline");
    expect(runs).toHaveLength(1);
    expect(runs[0].hasAttribute("data-occluded")).toBe(false);
  });
});

describe("Vertices", () => {
  it("draws an occluded vertex hollow with a dashed outline, and the others filled white", () => {
    const { container } = render(
      <svg>
        <Vertices points={[[0, 0], [10, 0], [20, 0]]} color="#ff0000" zoom={1} hotIndex={null} visibility={[2, 1, 0]} />
      </svg>,
    );
    const dots = [...container.querySelectorAll("circle")];
    expect(dots.map((dot) => dot.getAttribute("fill"))).toEqual(["#ffffff", "none", "#ffffff"]);
    expect(dots.map((dot) => dot.getAttribute("data-occluded"))).toEqual([null, "true", null]);
    expect(dots[1].getAttribute("stroke-dasharray")).not.toBeNull();
    expect(dots[0].getAttribute("stroke-dasharray")).toBeNull();
  });
});
