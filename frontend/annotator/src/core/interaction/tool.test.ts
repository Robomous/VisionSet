/**
 * Resolving a tool against a class that accepts a set of geometries.
 *
 * Before #584 a class was bound to one geometry and `toolFor` was a pure function
 * of the class, so there was nothing here to test that `draft.test.ts` and the
 * palette tests did not already cover between them. A set makes the class an
 * insufficient answer, and the resolution rule it needs instead is the one thing
 * standing between a class switch and a stranded tool.
 *
 * Fixtures are inline, for the reason `draft.test.ts` gives for its own: the
 * schema *is* the subject, so a reader chasing a failure must be able to see what
 * each class accepts without opening a second file.
 */

import { describe, expect, it } from "vitest";

import { createDocument } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { AnnotationSchema, AssetDescriptor, LabelClass } from "../types";
import { drawableGeometries, toolFor } from "./tool";

const ASSET: AssetDescriptor = { id: "asset-584", width: 640, height: 480 };

function classOf(name: string, ...geometries: LabelClass["geometries"]): LabelClass {
  return { name, geometries, color: null, attributes: [] };
}

/** A box, a box-or-polygon, a pure tag, a tag that is also drawable, and a mask. */
const CLASSES = [
  classOf("box-only", "bbox"),
  classOf("either", "bbox", "polygon"),
  classOf("tag-only", "classification_tag"),
  classOf("tag-and-box", "bbox", "classification_tag"),
  classOf("unbuildable", "mask"),
];

const SCHEMA: AnnotationSchema = {
  project_id: "project-584",
  version: 1,
  classes: CLASSES,
  description: null,
  created_at: null,
  provenance: null,
};

const DOCUMENT: AnnotationDocument = createDocument(ASSET, SCHEMA);

describe("which of a class's geometries can be drawn", () => {
  it("lists only the ones with a tool behind them", () => {
    expect(drawableGeometries(classOf("x", "bbox", "polygon"))).toEqual(["bbox", "polygon"]);
    // `classification_tag` has no canvas gesture and `mask` has no model at all,
    // so both drop out — and the class is still drawable through what is left.
    expect(drawableGeometries(classOf("x", "mask", "polyline", "classification_tag"))).toEqual([
      "polyline",
    ]);
  });

  it("is empty for a class that draws nothing, whichever reason", () => {
    expect(drawableGeometries(classOf("x", "classification_tag"))).toEqual([]);
    expect(drawableGeometries(classOf("x", "mask"))).toEqual([]);
  });

  it("answers in one order, whatever order the class was written in", () => {
    // Two classes offering the same shapes must offer them in the same order, or
    // `toolFor`'s fallback would depend on how somebody happened to type the set.
    expect(drawableGeometries(classOf("x", "polygon", "bbox"))).toEqual(
      drawableGeometries(classOf("y", "bbox", "polygon")),
    );
  });
});

describe("resolving the tool", () => {
  it("keeps the tool the host holds when the class accepts it", () => {
    expect(toolFor(DOCUMENT, "either", "polygon")).toBe("polygon");
    expect(toolFor(DOCUMENT, "either", "bbox")).toBe("bbox");
  });

  it("falls to the class's first drawable geometry when the class forbids it", () => {
    // The guarantee: switching class never strands a tool. A host holding
    // `polygon` that moves to a boxes-only class draws boxes, and does not keep
    // an active tool nothing on the canvas would answer.
    expect(toolFor(DOCUMENT, "box-only", "polygon")).toBe("bbox");
    expect(toolFor(DOCUMENT, "box-only", "polyline")).toBe("bbox");
  });

  it("takes the class's first drawable geometry when the host has no preference", () => {
    // The behaviour before a class could accept more than one, kept as the
    // default so a host with no tool strip is unaffected.
    expect(toolFor(DOCUMENT, "either", null)).toBe("bbox");
    expect(toolFor(DOCUMENT, "either")).toBe("bbox");
  });

  it("ignores a preference for select, which is spelled by having no class", () => {
    // Otherwise there would be two ways to say the same thing and one of them
    // would leave a class armed that nothing could draw with.
    expect(toolFor(DOCUMENT, "either", "select")).toBe("bbox");
  });

  it("answers select for a class that draws nothing, preference or not", () => {
    for (const preferred of ["bbox", "polygon", null] as const) {
      expect(toolFor(DOCUMENT, "tag-only", preferred)).toBe("select");
      expect(toolFor(DOCUMENT, "unbuildable", preferred)).toBe("select");
    }
  });

  it("draws with a class that is both taggable and drawable", () => {
    // The two stopped being each other's negation, so a class accepting a tag
    // *and* a box is not a tag class: it has a tool, and the tag is a panel's.
    expect(toolFor(DOCUMENT, "tag-and-box", null)).toBe("bbox");
  });

  it("answers select with no class and with a class the schema never declared", () => {
    expect(toolFor(DOCUMENT, null, "polygon")).toBe("select");
    expect(toolFor(DOCUMENT, "ghost", "polygon")).toBe("select");
  });
});
