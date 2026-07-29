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
 * The fixture is read through `import.meta.url` rather than a relative path, so
 * it does not matter what vitest's working directory is.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GEOMETRY_TYPES, IMPLEMENTED_GEOMETRY_TYPES } from "./types";
import { ANNOTATION_KEYS, WireFormatError, parseAnnotation, parseGeometry } from "./wire";

interface Fixture {
  readonly annotations: readonly unknown[];
  readonly geometry_types: readonly string[];
  readonly implemented_geometry_types: readonly string[];
}

const FIXTURE_URL = new URL(
  "../../../../tests/fixtures/wire_annotations.json",
  import.meta.url,
);

const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Fixture;

/** A known-good annotation to mutate into each malformed case. */
function sample(): Record<string, unknown> {
  return structuredClone(fixture.annotations[0]) as Record<string, unknown>;
}

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
