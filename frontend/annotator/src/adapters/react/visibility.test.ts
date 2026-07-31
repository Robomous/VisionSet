/**
 * The view-level hide, and the two properties it has to keep.
 */

import { describe, expect, it } from "vitest";

import { documentFromWire } from "../../core/state/document";
import { withoutHidden } from "./visibility";

const WIRE = {
  asset: { id: "asset-1", width: 100, height: 100 },
  schema: {
    project_id: "11111111-1111-4111-8111-111111111111",
    version: 1,
    classes: [{ name: "box", geometry: "bbox", color: null, attributes: [] }],
  },
  annotations: [
    {
      id: "a",
      asset_id: "asset-1",
      label_class: "box",
      schema_version: 1,
      geometry: { type: "bbox", x: 1, y: 1, width: 10, height: 10 },
      attributes: {},
      provenance: "human",
      model_ref: null,
      confidence: null,
    },
    {
      id: "b",
      asset_id: "asset-1",
      label_class: "box",
      schema_version: 1,
      geometry: { type: "bbox", x: 20, y: 20, width: 10, height: 10 },
      attributes: {},
      provenance: "human",
      model_ref: null,
      confidence: null,
    },
  ],
};

describe("withoutHidden", () => {
  const document = documentFromWire(WIRE);

  it("does not touch the asset or the schema it is a view of", () => {
    const visible = withoutHidden(document, new Set(["a"]));
    expect(visible.asset).toBe(document.asset);
    expect(visible.schema).toBe(document.schema);
  });

  it("removes exactly the hidden annotations", () => {
    const visible = withoutHidden(document, new Set(["a"]));
    expect([...visible.annotations.keys()]).toEqual(["b"]);
  });

  it("returns the same object when nothing is hidden", () => {
    // Identity, not equality. `AnnotationLayer`'s `memo` is what makes a drag cost
    // the committed layer three DOM writes whatever its length, and a projection
    // allocating a new document every render would defeat the bail-out before it
    // was consulted — #49's finding, from the other side.
    expect(withoutHidden(document, undefined)).toBe(document);
    expect(withoutHidden(document, new Set())).toBe(document);
  });

  it("returns the same object when every hidden id names something already gone", () => {
    // Reachable in one keystroke: hide an object, then delete it. Without this the
    // canvas would re-render on every frame of the next drag for no reason.
    expect(withoutHidden(document, new Set(["gone"]))).toBe(document);
  });

  it("leaves draw order intact for what remains", () => {
    // Draw order *is* the map's insertion order — `AnnotationDocument` has no
    // separate list — so a projection that rebuilt the map from a filter would be
    // reordering the canvas, and `annotationsInDrawOrder` is where that shows.
    const visible = withoutHidden(document, new Set(["a"]));
    expect([...visible.annotations.keys()]).toEqual(["b"]);
    expect(withoutHidden(document, new Set(["b"])).annotations.has("a")).toBe(true);
  });
});
