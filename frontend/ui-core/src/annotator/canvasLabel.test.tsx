/**
 * What the canvas writes over a shape, and when.
 *
 * Two rules, one element. The label renders **only while its shape is
 * selected** — a frame of forty boxes drawing forty class names hides the asset
 * behind the annotations of it, and the panel is the full inventory. And it
 * says **the class and nothing else** — a confidence belongs to the
 * accept-or-reject decision on the live preview, and which model produced a
 * stored shape is the panel row's mark.
 *
 * Here rather than in `@visionset/annotator`, which has no DOM to render into:
 * its suites are pure by construction, and this is a claim about markup. It is
 * jsdom-complete — the presence or absence of a `<text>` node is not something
 * a browser knows better — so `AnnotationLayer` is driven directly rather than
 * through the page. The label's *metrics* are the browser's business and are
 * unchanged by this file.
 */

import {
  AnnotationLayer,
  EMPTY_SELECTION,
  documentFromWire,
  selectionOf,
} from "@visionset/annotator";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JSX } from "react";
import type { Selection } from "@visionset/annotator";

const SCHEMA = {
  project_id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  classes: [
    { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
    { name: "pedestrian", geometries: ["bbox"], color: null, attributes: [] },
  ],
};

function annotation(id: string, labelClass: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    id,
    asset_id: "asset-1",
    label_class: labelClass,
    schema_version: 1,
    geometry: { type: "bbox", x: 10, y: 10, width: 20, height: 20 },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
    ...overrides,
  };
}

/** A model's own work: the three fields the accept path stamps together. */
function predicted(id: string, labelClass: string, confidence: number | null = 0.62): unknown {
  return annotation(id, labelClass, {
    provenance: "model",
    model_ref: "IDEA-Research/grounding-dino-tiny@abc123",
    confidence,
  });
}

function paint(annotations: readonly unknown[], selection: Selection = EMPTY_SELECTION): JSX.Element {
  const document = documentFromWire({
    asset: { id: "asset-1", width: 100, height: 100 },
    schema: SCHEMA,
    annotations,
  });
  return (
    <svg>
      <AnnotationLayer
        committed={document}
        selection={selection}
        skipId={null}
        hotId={null}
        zoom={1}
        handles
      />
    </svg>
  );
}

/** Every class name the canvas is currently writing. */
function labels(): readonly string[] {
  return [...screen.getByTestId("annotation-layer").querySelectorAll("text")].map(
    (node) => node.textContent ?? "",
  );
}

describe("the class label is part of what selection looks like", () => {
  it("writes nothing over an unselected shape", () => {
    render(paint([annotation("a", "vehicle")]));

    // The box is drawn; the name over it is not.
    expect(screen.getByTestId("annotation-layer").querySelector("rect")).not.toBeNull();
    expect(labels()).toEqual([]);
  });

  it("writes the class over the shape somebody picked", () => {
    render(paint([annotation("a", "vehicle")], selectionOf(["a"])));

    expect(labels()).toEqual(["vehicle"]);
  });

  it("names only the selection, in a frame carrying several shapes", () => {
    render(
      paint(
        [
          annotation("a", "vehicle"),
          annotation("b", "pedestrian"),
          annotation("c", "vehicle"),
        ],
        selectionOf(["b"]),
      ),
    );

    // One name on a canvas of three, which is the whole of the rule: the panel
    // is the inventory and the canvas answers "what is *this* one".
    expect(labels()).toEqual(["pedestrian"]);
  });

  it("names each of several selected shapes", () => {
    render(
      paint([annotation("a", "vehicle"), annotation("b", "pedestrian")], selectionOf(["a", "b"])),
    );

    expect(labels()).toEqual(["vehicle", "pedestrian"]);
  });
});

describe("the label is the class and nothing else", () => {
  it("writes no score over a model's shape", () => {
    render(paint([predicted("m", "vehicle")], selectionOf(["m"])));

    // The number aided a decision that has already been made. It is still
    // stored, and it still renders on the live suggestion preview.
    expect(labels()).toEqual(["vehicle"]);
  });

  it("writes no provenance mark either — the panel row carries that", () => {
    render(paint([predicted("m", "vehicle", null)], selectionOf(["m"])));

    expect(labels()).toEqual(["vehicle"]);
  });

  it("draws a model's selected shape exactly as it draws a person's", () => {
    const { container: mine } = render(paint([annotation("h", "vehicle")], selectionOf(["h"])));
    const person = mine.innerHTML;
    const { container: theirs } = render(paint([predicted("h", "vehicle")], selectionOf(["h"])));

    // Same id, same class, same geometry: the only difference in the fixture is
    // the three fields the canvas has stopped being given.
    expect(theirs.innerHTML).toBe(person);
  });
});
