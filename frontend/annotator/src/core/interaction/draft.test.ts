/**
 * What a freshly drawn annotation carries before anybody has edited it.
 *
 * `draft.ts` is four lines of assembly and one loop, and the loop is the part with
 * a decision in it: #43 fills every attribute the class declares a default for,
 * and deliberately draws a class whose required attribute has none rather than
 * refusing the gesture.
 *
 * The fixtures are inline rather than `state/_sample.ts`'s, for the reason
 * `document.test.ts` gives for its own: the schema *is* the subject here, so a
 * reader chasing a failure has to be able to see which attributes were declared
 * without opening a second file.
 */

import { describe, expect, it } from "vitest";

import { createDocument } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { AnnotationSchema, AssetDescriptor, Geometry, LabelClass } from "../types";
import { draftAnnotation } from "./draft";

const ASSET: AssetDescriptor = { id: "asset-7", width: 640, height: 480 };

const BOX: Geometry = { type: "bbox", x: 10, y: 20, width: 30, height: 40 };

/** Every attribute kind, one with a default and one without, on one class. */
const SIGN: LabelClass = {
  name: "sign",
  geometry: "bbox",
  color: "#ff0000",
  attributes: [
    { name: "occluded", kind: "boolean", required: false, options: null, default: false },
    { name: "confidence_note", kind: "string", required: false, options: null, default: "" },
    { name: "lanes", kind: "number", required: false, options: null, default: 2 },
    {
      name: "material",
      kind: "select",
      required: false,
      options: ["metal", "plastic"],
      default: "metal",
    },
    // Required and undefaulted: the case with the decision in it.
    { name: "legend", kind: "string", required: true, options: null, default: null },
  ],
};

/** No attributes at all — the ordinary case, and what `_sample.ts` uses. */
const BARE: LabelClass = { name: "bare", geometry: "bbox", color: null, attributes: [] };

const SCHEMA: AnnotationSchema = {
  project_id: "project-7",
  version: 4,
  classes: [SIGN, BARE],
  description: null,
  created_at: null,
  provenance: null,
};

function documentHere(): AnnotationDocument {
  return createDocument(ASSET, SCHEMA);
}

/** Ids in call order, so a test can say how many were minted. */
function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `n${n}`;
  };
}

describe("what the class says a new annotation carries", () => {
  it("seeds every attribute the class gave a default", () => {
    const drawn = draftAnnotation(documentHere(), "sign", BOX, counter());
    expect(drawn.attributes).toEqual({
      occluded: false,
      confidence_note: "",
      lanes: 2,
      material: "metal",
    });
  });

  it("seeds a false and an empty string, which a truthiness test would drop", () => {
    // `occluded: false` and `confidence_note: ""` are the two defaults an
    // `if (attribute.default)` guard would silently skip, leaving a required-ish
    // field absent for no reason a reader could see.
    const drawn = draftAnnotation(documentHere(), "sign", BOX, counter());
    expect(Object.hasOwn(drawn.attributes, "occluded")).toBe(true);
    expect(Object.hasOwn(drawn.attributes, "confidence_note")).toBe(true);
  });

  it("leaves out an attribute with no default rather than writing a null", () => {
    // `AttributeValue` is `boolean | number | string` — there is no null on the
    // wire, so a key present with nothing in it would be a third state nobody
    // asked for and `toAnnotationCreate` would carry it to the kernel.
    const drawn = draftAnnotation(documentHere(), "sign", BOX, counter());
    expect(Object.hasOwn(drawn.attributes, "legend")).toBe(false);
  });

  it("draws a class whose required attribute has no default anyway", () => {
    // The decision, stated: refusing here would make such a class undrawable,
    // with no attributes panel in existence to satisfy it and no channel to say
    // why the pointer did nothing. The kernel's MissingRequiredAttribute is the
    // backstop on write; M5's panel is the remedy.
    const drawn = draftAnnotation(documentHere(), "sign", BOX, counter());
    expect(drawn.label_class).toBe("sign");
    expect(drawn.geometry).toBe(BOX);
  });

  it("gives a class with no attributes an empty map, not a shared one", () => {
    const mint = counter();
    const first = draftAnnotation(documentHere(), "bare", BOX, mint);
    const second = draftAnnotation(documentHere(), "bare", BOX, mint);
    expect(first.attributes).toEqual({});
    // Two drafts must not share one object: an attribute panel editing the first
    // would otherwise edit the second. `toBe` because identity is the claim.
    expect(first.attributes).not.toBe(second.attributes);
  });

  it("answers an empty map for a class the schema does not declare", () => {
    // `toolFor` has already refused to hand out a drawing tool for one, so
    // reaching this means the host swapped the document mid-gesture. An empty map
    // is a better answer to that than a throw from inside a pointer handler.
    const drawn = draftAnnotation(documentHere(), "ghost", BOX, counter());
    expect(drawn.attributes).toEqual({});
    expect(drawn.label_class).toBe("ghost");
  });
});

describe("the two fields it invents, and the ones it copies", () => {
  it("mints the id exactly once", () => {
    const mint = counter();
    expect(draftAnnotation(documentHere(), "sign", BOX, mint).id).toBe("n1");
    expect(draftAnnotation(documentHere(), "sign", BOX, mint).id).toBe("n2");
  });

  it("takes the asset and the schema version from the document in hand", () => {
    const drawn = draftAnnotation(documentHere(), "sign", BOX, counter());
    expect(drawn.asset_id).toBe(ASSET.id);
    expect(drawn.schema_version).toBe(SCHEMA.version);
  });

  it("is human, unmodelled and unscored, because a gesture is the only caller", () => {
    const drawn = draftAnnotation(documentHere(), "sign", BOX, counter());
    expect(drawn.provenance).toBe("human");
    expect(drawn.model_ref).toBeNull();
    expect(drawn.confidence).toBeNull();
  });
});
