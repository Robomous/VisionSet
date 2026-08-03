/**
 * The TypeScript half of the wire gate.
 *
 * `tests/fixtures/wire_annotations.json` is written by
 * `scripts/export_wire_fixtures.py` from the same pydantic models `openapi.json`
 * is generated from, and kept current by `tests/server/test_wire_fixtures.py`.
 * This file proves the mirror in `types.ts` parses it — which is the only way a
 * package that must not depend on `@visionset/ui-core` can show its hand-written
 * types still agree with the kernel's union.
 *
 * The fixture is loaded by `_fixture.ts`, through `import.meta.url` rather than a
 * relative path, so it does not matter what vitest's working directory is.
 */

import { describe, expect, it } from "vitest";

import { fixture, sampleAnnotation as sample } from "./_fixture";
import { ATTRIBUTE_KINDS, GEOMETRY_TYPES, IMPLEMENTED_GEOMETRY_TYPES } from "./types";
import {
  ANNOTATION_CREATE_KEYS,
  ANNOTATION_KEYS,
  ANNOTATION_UPDATE_KEYS,
  WireFormatError,
  parseAnnotation,
  parseAssetDescriptor,
  parseAttribute,
  parseGeometry,
  parseLabelClass,
  parseSchema,
  toAnnotationCreate,
  toAnnotationUpdate,
} from "./wire";

describe("the geometry vocabulary", () => {
  it("names every geometry the kernel can address", () => {
    expect([...GEOMETRY_TYPES].sort()).toEqual([...fixture.geometry_types]);
  });

  it("names exactly the geometries an annotation can carry", () => {
    expect([...IMPLEMENTED_GEOMETRY_TYPES].sort()).toEqual([
      ...fixture.implemented_geometry_types,
    ]);
  });

  it("keeps the carryable set a strict subset of the vocabulary", () => {
    // Five members are roadmap. If this ever becomes an equality the two lists
    // have collapsed into one and `parseGeometry` has nothing left to refuse.
    expect(IMPLEMENTED_GEOMETRY_TYPES.length).toBeLessThan(GEOMETRY_TYPES.length);
    for (const type of IMPLEMENTED_GEOMETRY_TYPES) {
      expect(GEOMETRY_TYPES).toContain(type);
    }
  });
});

describe("parsing what the kernel produced", () => {
  it("parses every annotation in the fixture", () => {
    expect(fixture.annotations.length).toBeGreaterThan(0);
    for (const annotation of fixture.annotations) {
      expect(() => parseAnnotation(annotation)).not.toThrow();
    }
  });

  it("round-trips each one without dropping or renaming a field", () => {
    // The parser rebuilds field by field, so re-serializing and comparing to the
    // input is what proves nothing was lost on the way through. A parser that
    // cast instead of rebuilding would pass this while ignoring the payload.
    for (const annotation of fixture.annotations) {
      const parsed = parseAnnotation(annotation);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(annotation);
    }
  });

  it("finds exactly the keys the Annotation interface declares", () => {
    for (const annotation of fixture.annotations) {
      expect(Object.keys(annotation as object).sort()).toEqual([...ANNOTATION_KEYS].sort());
    }
  });

  it("covers every carryable geometry", () => {
    const seen = new Set(
      fixture.annotations.map((a) => parseAnnotation(a).geometry.type),
    );
    expect([...seen].sort()).toEqual([...IMPLEMENTED_GEOMETRY_TYPES].sort());
  });

  it("reads a polygon point as an [x, y] pair", () => {
    const polygon = fixture.annotations
      .map((a) => parseAnnotation(a).geometry)
      .find((g) => g.type === "polygon");
    expect(polygon).toBeDefined();
    expect(polygon?.type === "polygon" && polygon.points[0]).toEqual([0, 0]);
  });
});

describe("the divergences this file exists to keep closed", () => {
  it('refuses "classification", the value the mirror used to carry', () => {
    // The kernel has always said `classification_tag`. This is the mismatch #73
    // was filed for; it must fail loudly rather than parse into a variant that
    // does not exist.
    expect(() => parseGeometry({ type: "classification" })).toThrow(WireFormatError);
    expect(() => parseGeometry({ type: "classification" })).toThrow(/not a GeometryType/);
  });

  it("refuses {x, y} points, the shape the mirror used to carry", () => {
    expect(() =>
      parseGeometry({
        type: "polygon",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
      }),
    ).toThrow(/\[x, y\] pair/);
  });

  it("refuses a flattened geometry, the shape the mirror used to carry", () => {
    // `type` used to sit on the annotation itself. It sits on `geometry`.
    const flattened = { ...sample(), type: "bbox" };
    expect(() => parseAnnotation(flattened)).toThrow(/does not declare/);
  });

  it.each(["polyline", "keypoints", "mask", "cuboid_3d", "polyline_3d"])(
    "refuses %s as declared-but-unimplemented rather than as unknown",
    (type) => {
      // The distinction is the point: the remedy for one is to wait for a
      // variant, and for the other to fix the caller. #48 inherits this answer.
      expect(() => parseGeometry({ type })).toThrow(WireFormatError);
      expect(() => parseGeometry({ type })).toThrow(/no implementation/);
      expect(() => parseGeometry({ type })).toThrow(/UNSUPPORTED_GEOMETRY/);
    },
  );
});

describe("strictness, so the editor cannot silently erase a field", () => {
  it("refuses an annotation carrying a key the contract does not declare", () => {
    expect(() => parseAnnotation({ ...sample(), reviewed: true })).toThrow(
      /carries reviewed/,
    );
  });

  it("refuses an annotation missing a key the contract declares", () => {
    const missing = sample();
    delete missing["confidence"];
    expect(() => parseAnnotation(missing)).toThrow(/missing confidence/);
  });

  it("refuses a geometry carrying an extra key", () => {
    expect(() =>
      parseGeometry({ type: "bbox", x: 0, y: 0, width: 1, height: 1, rotation: 0 }),
    ).toThrow(/carries rotation/);
  });

  it("refuses a provenance outside the three the domain names", () => {
    expect(() => parseAnnotation({ ...sample(), provenance: "robot" })).toThrow(
      /provenance/,
    );
  });

  it("accepts null for both nullable fields and rejects a wrong type", () => {
    expect(() =>
      parseAnnotation({ ...sample(), model_ref: null, confidence: null }),
    ).not.toThrow();
    expect(() => parseAnnotation({ ...sample(), model_ref: 7 })).toThrow(/model_ref/);
  });
});

describe("rule 4: an input-only mirror survives a server that grew a field", () => {
  // #230 is why this block exists. Two fields were added to `SchemaVersionOut`
  // and `parseSchema` refused every schema the server sent, because it was as
  // exact about keys as the annotation path is. The annotation path *has* to be
  // — it round-trips, so an ignored key is a field the editor erases on save —
  // and none of these four do.

  it("parses a schema carrying a field this build has never heard of", () => {
    const schema = parseSchema({
      project_id: "p",
      version: 3,
      classes: [{ name: "sign", geometry: "bbox" }],
      description: "why",
      created_at: "2026-08-02T12:00:00Z",
      published_by: "someone in a later release",
    });
    expect(schema.version).toBe(3);
    expect(schema.classes).toHaveLength(1);
  });

  it("parses a label class and an attribute carrying one too", () => {
    const labelClass = parseLabelClass({
      name: "sign",
      geometry: "bbox",
      shortcut_key: "s",
    });
    expect(labelClass.name).toBe("sign");
    const attribute = parseAttribute({ name: "lit", kind: "boolean", helptext: "later" });
    expect(attribute.kind).toBe("boolean");
  });

  it("parses an asset carrying one too, which it always did", () => {
    // The asset parser has ignored undeclared keys since #40 — it names three
    // fields of the eleven an asset carries. Rule 4 is that behaviour named and
    // extended to its three siblings, not a new idea.
    const asset = parseAssetDescriptor({
      id: "a",
      width: 640,
      height: 480,
      ingested_at: "2026-08-02T12:00:00Z",
    });
    expect(asset).toEqual({ id: "a", width: 640, height: 480 });
  });

  it("still refuses one that is missing a key it needs", () => {
    // Tolerating additions is not tolerating absences: a missing key is the
    // server failing to send something the parser reads, which no amount of
    // version skew excuses.
    expect(() => parseSchema({ version: 3, classes: [] })).toThrow(/missing project_id/);
    expect(() => parseLabelClass({ name: "sign" })).toThrow(/missing geometry/);
  });

  it("does not extend that tolerance to the annotation path", () => {
    // The other half of the rule, and the one that would cost data if it moved.
    expect(() => parseAnnotation({ ...sample(), reviewed: true })).toThrow(
      /carries reviewed/,
    );
  });
});

describe("bounds, which belong to the kernel and are not restated here", () => {
  it("accepts a zero-area box", () => {
    // `BboxGeometry` refuses this with a 422. Re-checking it here would be a
    // second copy of a rule that already has an owner — and a half-drawn shape
    // is the document model's question, not the parser's.
    expect(() =>
      parseGeometry({ type: "bbox", x: 0, y: 0, width: 0, height: 0 }),
    ).not.toThrow();
  });

  it("accepts a two-point polygon", () => {
    expect(() =>
      parseGeometry({
        type: "polygon",
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).not.toThrow();
  });
});

describe("the attribute vocabulary", () => {
  it("names every kind the kernel's Attribute accepts", () => {
    // `Attribute.kind` is a Literal spelled inline in the wire model, so nothing
    // structural ties this union to that one. This is the tie.
    expect([...ATTRIBUTE_KINDS].sort()).toEqual([...fixture.attribute_kinds]);
  });
});

describe("parsing the schema the kernel produced", () => {
  it("parses it, and finds a class per carryable geometry", () => {
    const schema = parseSchema(fixture.schema);
    expect(schema.classes.map((c) => c.geometry).sort()).toEqual([
      ...fixture.implemented_geometry_types,
    ]);
  });

  it("round-trips without dropping or renaming a field", () => {
    expect(JSON.parse(JSON.stringify(parseSchema(fixture.schema)))).toEqual(
      fixture.schema,
    );
  });

  it("reads both states of every optional field", () => {
    // The fixture carries a populated class and a bare one precisely so this can
    // be asserted; a mirror only ever handed values leaves the null branch dead.
    const classes = parseSchema(fixture.schema).classes;
    expect(new Set(classes.map((c) => c.color === null))).toEqual(new Set([true, false]));
    expect(new Set(classes.map((c) => c.attributes.length === 0))).toEqual(
      new Set([true, false]),
    );
    const attributes = classes.flatMap((c) => c.attributes);
    expect(new Set(attributes.map((a) => a.options === null))).toEqual(
      new Set([true, false]),
    );
    expect(new Set(attributes.map((a) => a.default === null))).toEqual(
      new Set([true, false]),
    );
  });

  it("carries the version's commit message and the moment it was published", () => {
    // Non-null on purpose: the round-trip above proves the *values* survive, and
    // this proves the fixture is exercising the populated branch rather than
    // agreeing with itself about two nulls.
    const schema = parseSchema(fixture.schema);
    expect(typeof schema.description).toBe("string");
    expect(schema.description).toBeTruthy();
    expect(schema.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reads a version that carries neither, which is every version before #230", () => {
    // Both branches by hand, because the committed fixture can only be in one
    // state at a time and it is populated so the round-trip above means something.
    const bare = { project_id: "p", version: 1, classes: [] };
    expect(parseSchema(bare)).toEqual({ ...bare, description: null, created_at: null });
    expect(parseSchema({ ...bare, description: null, created_at: null })).toEqual({
      ...bare,
      description: null,
      created_at: null,
    });
  });

  it("ignores a key the schema contract does not declare", () => {
    // This asserted the opposite until #230, and the reversal is rule 4. A
    // schema is input-only, so a key this build does not know is a newer
    // server's field and dropping it loses nothing — where refusing it loses
    // the whole schema, which is exactly what #230 did.
    const parsed = parseSchema({ project_id: "p", version: 1, classes: [], notes: "hi" });
    expect(parsed.version).toBe(1);
    expect(parsed).not.toHaveProperty("notes");
  });

  it("applies the wire's own defaults when an optional key is absent", () => {
    // Rule 4: the schema is input-only, so absence is legal here where it is not
    // for an annotation. A host assembling a class by hand writes two fields.
    const parsed = parseLabelClass({ name: "sign", geometry: "bbox" });
    expect(parsed).toEqual({
      name: "sign",
      geometry: "bbox",
      color: null,
      attributes: [],
    });
  });

  it("ignores a key the contract does not declare", () => {
    // Reversed with its schema sibling above, for rule 4's reason. Note what is
    // given up: a genuine caller typo — `colour` for `color` — now parses, and
    // the class comes back with the default colour instead of an error. That is
    // the price of surviving a server one version ahead, and `types.ts` is what
    // catches the typo for anyone compiling against this package.
    const parsed = parseLabelClass({ name: "sign", geometry: "bbox", colour: "#fff" });
    expect(parsed.name).toBe("sign");
    expect(parsed).not.toHaveProperty("colour");
  });

  it("accepts a class declaring a geometry no annotation can carry", () => {
    // Eight names, three models. A schema may legally say `polyline`; refusing it
    // here would make one such class cost the whole class list.
    const parsed = parseLabelClass({ name: "lane", geometry: "polyline" });
    expect(parsed.geometry).toBe("polyline");
  });

  it("refuses a geometry that is not in the vocabulary at all", () => {
    expect(() => parseLabelClass({ name: "lane", geometry: "squiggle" })).toThrow(
      /not a GeometryType/,
    );
  });

  it("refuses an attribute kind the domain does not have", () => {
    expect(() =>
      parseLabelClass({
        name: "sign",
        geometry: "bbox",
        attributes: [{ name: "note", kind: "text" }],
      }),
    ).toThrow(/kind "text" is not one of/);
  });
});

describe("parsing the asset the kernel produced", () => {
  it("takes the three fields an engine can use and ignores the rest", () => {
    const asset = parseAssetDescriptor(fixture.asset);
    expect(Object.keys(asset).sort()).toEqual(["height", "id", "width"]);
    expect(asset.width).toBeGreaterThan(0);
    expect(asset.height).toBeGreaterThan(0);
  });

  it("refuses an asset whose dimensions were never measured", () => {
    // `AssetOut.width`/`height` are `int | None` because a pre-pipeline row has
    // never been probed. There is no honest default: geometry here is native
    // pixels, so no frame means nothing to be native to.
    const unmeasured = { ...(fixture.asset as object), width: null, height: null };
    expect(() => parseAssetDescriptor(unmeasured)).toThrow(/no measured width and height/);
  });

  it("refuses an asset missing a dimension key entirely", () => {
    // Absent is told apart from null: one is a payload that is not an AssetOut,
    // the other is an AssetOut for an asset nobody has measured.
    const truncated = structuredClone(fixture.asset) as Record<string, unknown>;
    delete truncated["width"];
    expect(() => parseAssetDescriptor(truncated)).toThrow(/missing width/);
  });
});

describe("what leaves for the API", () => {
  it("drops id and schema_version from a create", () => {
    // Both are provisional locally and the service owns both, so a field here
    // would be one a client could set and never observe.
    const annotation = parseAnnotation(fixture.annotations[0]);
    const create = toAnnotationCreate(annotation);
    expect(Object.keys(create).sort()).toEqual([...ANNOTATION_CREATE_KEYS].sort());
    expect(create).not.toHaveProperty("id");
    expect(create).not.toHaveProperty("schema_version");
  });

  it("keeps the id on an update and drops asset_id", () => {
    // An update is addressed by id and by nothing else; the stored asset wins, so
    // moving a label to another asset is a delete and an add.
    const annotation = parseAnnotation(fixture.annotations[0]);
    const update = toAnnotationUpdate(annotation);
    expect(Object.keys(update).sort()).toEqual([...ANNOTATION_UPDATE_KEYS].sort());
    expect(update.id).toBe(annotation.id);
    expect(update).not.toHaveProperty("asset_id");
    expect(update).not.toHaveProperty("schema_version");
  });

  it("carries the geometry through untouched", () => {
    for (const raw of fixture.annotations) {
      const annotation = parseAnnotation(raw);
      expect(toAnnotationCreate(annotation).geometry).toEqual(annotation.geometry);
      expect(toAnnotationUpdate(annotation).geometry).toEqual(annotation.geometry);
    }
  });
});
