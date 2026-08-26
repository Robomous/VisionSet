/**
 * The static overlay, held to the three things a consumer relies on: one drawn
 * shape per placeable annotation, a `viewBox` that is the picture's pixel frame,
 * and the class palette the annotator itself draws with. Whether the SVG's box
 * lands on the image's box is a browser fact and lives in `e2e/dataset.spec.ts`.
 */

import { classColor } from "@visionset/annotator";
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
});
