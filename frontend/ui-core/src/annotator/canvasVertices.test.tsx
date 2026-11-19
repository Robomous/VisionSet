/**
 * A selected lane's vertices on the canvas: the dots a viewer still reads, and
 * the ring the side panel points with. Driven through the two layers directly,
 * for `canvasLabel.test.tsx`'s reason — `@visionset/annotator` has no DOM.
 */

import { IDLE, NO_TARGET, documentFromWire, selectOnly } from "@visionset/annotator";
import { AnnotationLayer, TransientLayer, paintHighlightedVertex } from "@visionset/annotator/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const ASSET = { id: "asset-1", width: 100, height: 100 };

const SCHEMA = {
  project_id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  classes: [
    { name: "centerline", geometries: ["polyline"], color: "#eb5a47", attributes: [] },
    { name: "lane", geometries: ["polygon"], color: "#f97316", attributes: [] },
  ],
};

function shape(id: string, labelClass: string, geometry: unknown): unknown {
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

const document = documentFromWire({
  asset: ASSET,
  schema: SCHEMA,
  annotations: [
    shape("lane-1", "centerline", {
      type: "polyline",
      points: [[10, 10], [20, 20], [30, 30]],
      visibility: [2, 1, 2],
    }),
    shape("poly-1", "lane", { type: "polygon", points: [[50, 50], [60, 50], [60, 60]] }),
  ],
});

describe("a selected lane in the read-only mode", () => {
  it("draws its vertex dots, the occluded one hollow", () => {
    render(
      <svg>
        <AnnotationLayer
          committed={document}
          selection={selectOnly("lane-1")}
          skipId={null}
          hotId={null}
          zoom={1}
          handles={false}
        />
      </svg>,
    );
    const dots = screen.getByTestId("annotation-layer").querySelectorAll("[data-vertex]");
    expect(dots).toHaveLength(3);
    expect(dots[1].getAttribute("data-occluded")).toBe("true");
    expect(dots[1].getAttribute("fill")).toBe("none");
  });

  it("still draws no dots on a selected polygon, which they would only offer to drag", () => {
    render(
      <svg>
        <AnnotationLayer
          committed={document}
          selection={selectOnly("poly-1")}
          skipId={null}
          hotId={null}
          zoom={1}
          handles={false}
        />
      </svg>,
    );
    expect(screen.getByTestId("annotation-layer").querySelectorAll("[data-vertex]")).toHaveLength(0);
  });
});

describe("the vertex the panel points at", () => {
  function layer(index: number | null): void {
    render(
      <svg>
        <TransientLayer
          edited={null}
          state={IDLE}
          hot={NO_TARGET}
          drawColor="#000000"
          zoom={1}
          closeRing={8}
          crosshair={null}
          asset={ASSET}
          highlightedVertex={paintHighlightedVertex(
            document,
            index === null ? null : { id: "lane-1", index },
          )}
        />
      </svg>,
    );
  }

  it("is ringed where it lies and carries its 1-based number", () => {
    layer(1);
    const ring = screen.getByTestId("highlighted-vertex");
    expect(ring.getAttribute("data-vertex-index")).toBe("1");
    expect(ring.querySelector("circle")?.getAttribute("cx")).toBe("20");
    expect(screen.getByTestId("highlighted-vertex-number").textContent).toBe("2");
  });

  it("draws nothing while nothing is pointed at", () => {
    layer(null);
    expect(screen.queryByTestId("highlighted-vertex")).toBeNull();
  });
});
