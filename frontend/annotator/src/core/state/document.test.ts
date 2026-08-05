/**
 * The document: identity, containment, draw order, and the wire round-trip.
 *
 * Acceptance criterion 2 of #40 is the `documentFromWire` block — a document built
 * from what the kernel actually produced, and serialized back to the same bytes.
 * The fixture carries a bbox, a polygon and a classification tag, so all three
 * carryable variants make the trip.
 */

import { describe, expect, it } from "vitest";

import { fixture } from "../_fixture";
import type { Annotation, AnnotationSchema, AssetDescriptor } from "../types";
import { WireFormatError, parseAnnotations, toAnnotationCreate } from "../wire";
import {
  DocumentError,
  addAnnotation,
  annotationById,
  annotationsInDrawOrder,
  classNamed,
  createDocument,
  documentFromWire,
  removeAnnotations,
  replaceAnnotation,
} from "./document";

const ASSET: AssetDescriptor = { id: "asset-1", width: 640, height: 480 };

const SCHEMA: AnnotationSchema = {
  project_id: "project-1",
  version: 3,
  classes: [
    { name: "sign", geometry: "bbox", color: "#ff0000", attributes: [] },
    { name: "lane", geometry: "polygon", color: null, attributes: [] },
  ],
  description: null,
  created_at: null,
};

/** A minimal annotation. The tests that care about a field set it explicitly. */
function annotation(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    asset_id: ASSET.id,
    label_class: "sign",
    schema_version: 3,
    geometry: { type: "bbox", x: 0, y: 0, width: 10, height: 10 },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
    ...overrides,
  };
}

function documentOf(...ids: readonly string[]) {
  return createDocument(ASSET, SCHEMA, ids.map((id) => annotation(id)));
}

describe("building a document", () => {
  it("keys annotations by id and keeps the order they arrived in", () => {
    const document = documentOf("c", "a", "b");
    expect([...document.annotations.keys()]).toEqual(["c", "a", "b"]);
    expect(annotationsInDrawOrder(document).map((a) => a.id)).toEqual(["c", "a", "b"]);
  });

  it("starts empty when handed nothing", () => {
    const document = createDocument(ASSET, SCHEMA);
    expect(document.annotations.size).toBe(0);
    expect(annotationsInDrawOrder(document)).toEqual([]);
  });

  it("refuses two annotations sharing an id", () => {
    // The id is the document's only handle, so a repeat is a lost annotation
    // rather than a duplicate one.
    expect(() => documentOf("a", "a")).toThrow(DocumentError);
    expect(() => documentOf("a", "a")).toThrow(/share the id a/);
  });

  it("refuses an annotation belonging to another asset", () => {
    expect(() =>
      createDocument(ASSET, SCHEMA, [annotation("a", { asset_id: "asset-2" })]),
    ).toThrow(/belongs to asset asset-2/);
  });
});

describe("adding, replacing and removing", () => {
  it("adds at the end of the draw order", () => {
    const document = addAnnotation(documentOf("a", "b"), annotation("c"));
    expect(annotationsInDrawOrder(document).map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("refuses to add an id already present", () => {
    expect(() => addAnnotation(documentOf("a"), annotation("a"))).toThrow(
      /already in this document/,
    );
  });

  it("replaces an annotation without moving it in the draw order", () => {
    // `Map.set` on a present key keeps its position, and this is the behaviour
    // the whole edit loop rests on: nudging a box must not send it behind
    // everything else. An editor where editing changes z-order fights its user.
    const before = documentOf("a", "b", "c");
    const moved = annotation("a", {
      geometry: { type: "bbox", x: 99, y: 99, width: 1, height: 1 },
    });
    const after = replaceAnnotation(before, moved);
    expect(annotationsInDrawOrder(after).map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(annotationById(after, "a")?.geometry).toEqual(moved.geometry);
  });

  it("refuses to replace an id it does not hold", () => {
    // An update that silently created would turn a stale id — the one case worth
    // catching — into a second copy of the annotation.
    expect(() => replaceAnnotation(documentOf("a"), annotation("b"))).toThrow(
      /no annotation b in this document/,
    );
  });

  it("removes by id, and a repeat counts once", () => {
    const document = removeAnnotations(documentOf("a", "b", "c"), ["b", "b"]);
    expect(annotationsInDrawOrder(document).map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("removes nothing at all when one id is unknown", () => {
    // All or nothing, the kernel's own bulk-delete posture: a partial removal
    // leaves the caller working out how far it got.
    const before = documentOf("a", "b");
    expect(() => removeAnnotations(before, ["a", "zz"])).toThrow(/no annotation zz/);
    expect(annotationsInDrawOrder(before).map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("returns the same document when asked to remove nothing", () => {
    const before = documentOf("a");
    expect(removeAnnotations(before, [])).toBe(before);
  });
});

describe("immutability, which is what makes undo a pointer swap", () => {
  it("never mutates the document it was given", () => {
    const before = documentOf("a", "b");
    const snapshot = [...before.annotations.keys()];

    addAnnotation(before, annotation("c"));
    removeAnnotations(before, ["a"]);
    replaceAnnotation(before, annotation("a", { label_class: "lane" }));

    expect([...before.annotations.keys()]).toEqual(snapshot);
    expect(annotationById(before, "a")?.label_class).toBe("sign");
  });

  it("hands back a new map each time, so a snapshot stays a snapshot", () => {
    const before = documentOf("a");
    const after = addAnnotation(before, annotation("b"));
    expect(after.annotations).not.toBe(before.annotations);
    expect(before.annotations.size).toBe(1);
  });

  it("shares the asset and schema rather than copying them", () => {
    // They are inputs, not editable state — #39 will snapshot documents on every
    // command and neither should be copied 200 times.
    const after = addAnnotation(documentOf("a"), annotation("b"));
    expect(after.asset).toBe(ASSET);
    expect(after.schema).toBe(SCHEMA);
  });
});

describe("the schema, which is looked up and not enforced", () => {
  it("finds a class by its exact name", () => {
    const document = documentOf("a");
    expect(classNamed(document, "sign")?.geometry).toBe("bbox");
    expect(classNamed(document, "lane")?.color).toBeNull();
  });

  it("answers undefined for a class the schema does not declare", () => {
    // An annotation naming a class a later version removed is a real state — it
    // is what SCHEMA_CHANGE_WOULD_ORPHAN is about — and a document that refused
    // to load one would leave a labeller unable to see the annotation at fault.
    expect(classNamed(documentOf("a"), "pedestrian")).toBeUndefined();
  });

  it("accepts an annotation whose geometry its class does not declare", () => {
    // Deliberate. That rule has an owner in the kernel, and the proof it must not
    // be copied here is one line below: the round-trip fixture violates it.
    const document = createDocument(ASSET, SCHEMA, [
      annotation("a", { label_class: "sign", geometry: { type: "classification_tag" } }),
    ]);
    expect(annotationById(document, "a")?.geometry.type).toBe("classification_tag");
  });

  it("accepts an annotation naming no class in the schema", () => {
    const document = createDocument(ASSET, SCHEMA, [
      annotation("a", { label_class: "pedestrian" }),
    ]);
    expect(classNamed(document, annotationById(document, "a")!.label_class)).toBeUndefined();
  });
});

describe("built from the wire, and back again", () => {
  const wire = {
    asset: fixture.asset,
    schema: fixture.schema,
    annotations: fixture.annotations,
  };

  it("loads what the kernel produced", () => {
    const document = documentFromWire(wire);
    expect(document.annotations.size).toBe(fixture.annotations.length);
    expect(document.asset.width).toBeGreaterThan(0);
  });

  it("round-trips every annotation back to the bytes it came from", () => {
    // Acceptance criterion 2. The document is keyed by id and iterated in
    // insertion order, so this also proves loading preserved both.
    const document = documentFromWire(wire);
    const out = annotationsInDrawOrder(document).map((a) =>
      JSON.parse(JSON.stringify(a)),
    );
    expect(out).toEqual(fixture.annotations);
  });

  it("carries every carryable geometry variant through the document", () => {
    const seen = new Set(
      annotationsInDrawOrder(documentFromWire(wire)).map((a) => a.geometry.type),
    );
    expect([...seen].sort()).toEqual([...fixture.implemented_geometry_types]);
  });

  it("holds annotations whose class declares a different geometry", () => {
    // The fixture's annotations all say `label_class: "sign"`, whose class
    // declares `bbox`, while most carry something else. That is valid data
    // the kernel produced — so a document enforcing class↔geometry agreement
    // could not load its own round-trip fixture. This is that argument, executed.
    const document = documentFromWire(wire);
    const disagreeing = annotationsInDrawOrder(document).filter(
      (a) => classNamed(document, a.label_class)?.geometry !== a.geometry.type,
    );
    expect(disagreeing.length).toBeGreaterThan(0);
  });

  it("projects a loaded annotation onto what a create takes", () => {
    const document = documentFromWire(wire);
    const first = annotationsInDrawOrder(document)[0];
    expect(toAnnotationCreate(first).asset_id).toBe(document.asset.id);
  });

  it("refuses the whole document when one annotation is malformed", () => {
    const bad = [...fixture.annotations, { id: "x" }];
    expect(() => documentFromWire({ ...wire, annotations: bad })).toThrow(WireFormatError);
  });

  it("refuses annotations belonging to a different asset than the one given", () => {
    // The parser cannot catch this — each payload is individually valid — so it is
    // the document's own invariant, and it is the one that stops a host pairing an
    // asset with somebody else's labels.
    const foreign = parseAnnotations(fixture.annotations).map((a) => ({
      ...a,
      asset_id: "asset-elsewhere",
    }));
    expect(() =>
      createDocument({ ...ASSET }, { ...SCHEMA }, foreign),
    ).toThrow(/belongs to asset asset-elsewhere/);
  });
});
