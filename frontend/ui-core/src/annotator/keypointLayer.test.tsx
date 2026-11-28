/**
 * How legible the read-only keypoints are: full-opacity strokes on a dark halo,
 * sized in screen pixels at every zoom.
 */

import { keypointLabels, type LabelClass } from "@visionset/annotator";
import { KeypointLayer, STROKE_PX, VERTEX_PX } from "@visionset/annotator/react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const PERSON: LabelClass = {
  name: "person",
  geometries: ["keypoints"],
  color: "#2f7fd1",
  attributes: [],
  keypoints: { names: ["head", "hip", "knee"], skeleton: [[0, 1], [1, 2]] },
};

const LABELS = keypointLabels(
  [
    {
      id: "pose",
      label_class: "person",
      geometry: { type: "keypoints", points: [[10, 10], [10, 40], [20, 70]], visibility: [2, 1, 2] },
    },
  ],
  [PERSON],
);

function layer(zoom: number): SVGGElement {
  const { container } = render(
    <svg>
      <KeypointLayer labels={LABELS} classes={[PERSON]} zoom={zoom} />
    </svg>,
  );
  const group = container.querySelector<SVGGElement>("[data-keypoints-id='pose']");
  if (group === null) throw new Error("the keypoints were not drawn");
  return group;
}

const width = (element: Element): number => Number(element.getAttribute("stroke-width"));

describe.each([1, 3.05])("at zoom %s", (zoom) => {
  it("strokes the skeleton at full opacity, no thinner than a shape's outline", () => {
    const edges = [...layer(zoom).querySelectorAll("line[data-keypoint-edge]")];
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.getAttribute("stroke")).toBe("#2f7fd1");
      expect(edge.getAttribute("stroke-opacity")).toBeNull();
      expect(width(edge) * zoom).toBeCloseTo(STROKE_PX);
    }
  });

  it("puts a dark halo under every edge and point, wider than what it backs", () => {
    const group = layer(zoom);
    const halo = group.querySelector("[data-keypoint-halo]");
    if (halo === null) throw new Error("no halo");
    expect(halo.getAttribute("stroke")).toBe("#000000");
    expect(Number(halo.getAttribute("stroke-opacity"))).toBeGreaterThanOrEqual(0.45);
    expect(halo.compareDocumentPosition(group.querySelector("[data-keypoint-edge]")!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    const haloLines = [...halo.querySelectorAll("line")];
    const haloDots = [...halo.querySelectorAll("circle")];
    expect(haloLines).toHaveLength(2);
    expect(haloDots).toHaveLength(3);
    for (const line of haloLines) expect(width(line) * zoom).toBeCloseTo(STROKE_PX + 3);
    for (const dot of haloDots) expect(width(dot) * zoom).toBeCloseTo(2 + 3);
  });

  it("outlines a dot more heavily than a polyline vertex, and rings an occluded one in even dashes", () => {
    const dots = [...layer(zoom).querySelectorAll("circle[data-keypoint]")];
    for (const dot of dots) {
      expect(Number(dot.getAttribute("r")) * zoom).toBeCloseTo(VERTEX_PX);
      expect(width(dot) * zoom).toBeCloseTo(2);
    }
    const occluded = dots.filter((dot) => dot.getAttribute("data-occluded") === "true");
    expect(occluded).toHaveLength(1);
    const dash = Number(occluded[0].getAttribute("stroke-dasharray"));
    expect(dash * 12).toBeCloseTo(2 * Math.PI * Number(occluded[0].getAttribute("r")));
    expect(occluded[0].getAttribute("fill")).toBe("none");
  });
});
