/**
 * The clipboard, and the two transformations over it.
 *
 * `runAction.test.ts` proves the *actions* — one history entry, the selection
 * that follows, the empty cases. This file is about the transformations
 * themselves, and about the three rules a paste has that nothing else does: the
 * offset, the clamp into the target asset's frame, and the fresh identity.
 *
 * A second asset, deliberately smaller than the first, is what makes the clamp
 * testable at all — cross-frame paste is the founder's decision and a frame that
 * cannot hold what was copied is the case it is easy to ship broken.
 */

import { describe, expect, it } from "vitest";

import { createDocument } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { Annotation, AssetDescriptor, AnnotationSchema, Geometry } from "../types";
import { copiedEntries, createClipboard, pastedAnnotations } from "./clipboard";
import type { ClipboardEntry } from "./clipboard";

const WIDE: AssetDescriptor = { id: "wide", width: 800, height: 600 };
/** Small enough that a shape copied off `WIDE` has to be pushed back inside. */
const NARROW: AssetDescriptor = { id: "narrow", width: 100, height: 100 };

const SCHEMA: AnnotationSchema = {
  project_id: "p",
  version: 4,
  description: null,
  created_at: "2026-08-06T00:00:00Z",
  provenance: null,
  classes: [
    { name: "sign", geometry: "bbox", color: null, attributes: [] },
    { name: "lane", geometry: "polygon", color: null, attributes: [] },
    { name: "centerline", geometry: "polyline", color: null, attributes: [] },
    { name: "weather", geometry: "classification_tag", color: null, attributes: [] },
  ],
};

function annotationOf(id: string, labelClass: string, geometry: Geometry, asset = WIDE): Annotation {
  return {
    id,
    asset_id: asset.id,
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

function documentOf(
  annotations: readonly Annotation[] = [],
  asset: AssetDescriptor = WIDE,
): AnnotationDocument {
  return createDocument(asset, SCHEMA, annotations);
}

/** Ids in call order, so a test can say how many were minted. */
function counter(): (() => string) & { calls: () => number } {
  let n = 0;
  const mint = (): string => {
    n += 1;
    return `n${n}`;
  };
  return Object.assign(mint, { calls: () => n });
}

const BOX: Geometry = { type: "bbox", x: 10, y: 20, width: 30, height: 40 };
const TRIANGLE: Geometry = {
  type: "polygon",
  points: [
    [100, 100],
    [160, 100],
    [130, 160],
  ],
};
const LINE: Geometry = {
  type: "polyline",
  points: [
    [200, 200],
    [260, 240],
  ],
};

describe("the clipboard is a holder and nothing else", () => {
  it("starts empty and hands back exactly what was written", () => {
    const clipboard = createClipboard();
    expect(clipboard.read()).toEqual([]);
    const entries: readonly ClipboardEntry[] = [
      { label_class: "sign", geometry: BOX, attributes: { lit: true } },
    ];
    clipboard.write(entries);
    expect(clipboard.read()).toBe(entries);
  });

  it("is one per call, so two annotators on one page do not share one", () => {
    // The reason this is a factory rather than a module-level singleton, which
    // would be one clipboard per *bundle*.
    const first = createClipboard();
    const second = createClipboard();
    first.write([{ label_class: "sign", geometry: BOX, attributes: {} }]);
    expect(second.read()).toEqual([]);
  });
});

describe("copying keeps what identifies the annotation out of it", () => {
  it("carries the class, the geometry and the attributes, and nothing else", () => {
    const source = annotationOf("a1", "sign", BOX);
    expect(copiedEntries([{ ...source, attributes: { lit: true, count: 2 } }])).toEqual([
      { label_class: "sign", geometry: BOX, attributes: { lit: true, count: 2 } },
    ]);
  });

  it("copies the source's attributes rather than the class's defaults", () => {
    // The distinction that makes this not `draftAnnotation`: a draft seeds what
    // the class declares, a copy carries what the original was actually holding.
    const source = annotationOf("a1", "sign", BOX);
    const entry = copiedEntries([{ ...source, attributes: { lit: false } }])[0];
    expect(entry.attributes).toEqual({ lit: false });
  });

  it("shares no object with the annotation it came from", () => {
    const source = annotationOf("a1", "lane", TRIANGLE);
    const entry = copiedEntries([source])[0];
    expect(entry.geometry).not.toBe(source.geometry);
    expect(entry.geometry).toEqual(source.geometry);
    if (entry.geometry.type === "polygon" && source.geometry.type === "polygon") {
      expect(entry.geometry.points).not.toBe(source.geometry.points);
    }
    expect(entry.attributes).not.toBe(source.attributes);
  });

  it("copies nothing from nothing", () => {
    expect(copiedEntries([])).toEqual([]);
  });
});

describe("pasting offsets, and the offset is in asset pixels", () => {
  it("moves a box down and right by one delta", () => {
    const pasted = pastedAnnotations(
      documentOf(),
      [{ label_class: "sign", geometry: BOX, attributes: {} }],
      12,
      counter(),
    );
    expect(pasted[0].geometry).toEqual({ type: "bbox", x: 22, y: 32, width: 30, height: 40 });
  });

  it("moves a polygon rigidly, so every pairwise distance survives", () => {
    const pasted = pastedAnnotations(
      documentOf(),
      [{ label_class: "lane", geometry: TRIANGLE, attributes: {} }],
      12,
      counter(),
    );
    expect(pasted[0].geometry).toEqual({
      type: "polygon",
      points: [
        [112, 112],
        [172, 112],
        [142, 172],
      ],
    });
  });

  it("moves a polyline the same way, though nothing can drag one yet", () => {
    // `MovableGeometry` is `bbox | polygon` — a polyline has no pointer move.
    // Pasting one is whole-object and needs neither.
    const pasted = pastedAnnotations(
      documentOf(),
      [{ label_class: "centerline", geometry: LINE, attributes: {} }],
      12,
      counter(),
    );
    expect(pasted[0].geometry).toEqual({
      type: "polyline",
      points: [
        [212, 212],
        [272, 252],
      ],
    });
  });

  it("leaves a tag alone, because a tag has nowhere to be moved to", () => {
    const pasted = pastedAnnotations(
      documentOf(),
      [{ label_class: "weather", geometry: { type: "classification_tag" }, attributes: {} }],
      12,
      counter(),
    );
    expect(pasted[0].geometry).toEqual({ type: "classification_tag" });
  });
});

describe("pasting onto another frame clamps into that frame", () => {
  it("pushes a box back inside a smaller asset rather than off its edge", () => {
    // Copied off an 800x600 frame, pasted onto a 100x100 one. `moveBbox`'s own
    // rule: the *translation* is clamped, so the box keeps its size.
    const pasted = pastedAnnotations(
      documentOf([], NARROW),
      [{ label_class: "sign", geometry: BOX, attributes: {} }],
      12,
      counter(),
    );
    expect(pasted[0].geometry).toEqual({ type: "bbox", x: 22, y: 32, width: 30, height: 40 });

    const far: Geometry = { type: "bbox", x: 700, y: 500, width: 30, height: 40 };
    const pushed = pastedAnnotations(
      documentOf([], NARROW),
      [{ label_class: "sign", geometry: far, attributes: {} }],
      12,
      counter(),
    );
    // Pinned against the far edge: 100 - 30 and 100 - 40.
    expect(pushed[0].geometry).toEqual({ type: "bbox", x: 70, y: 60, width: 30, height: 40 });
  });

  it("does not deform a polygon wider than the frame — it pins at zero", () => {
    const wide: Geometry = {
      type: "polygon",
      points: [
        [0, 0],
        [400, 0],
        [200, 300],
      ],
    };
    const pasted = pastedAnnotations(
      documentOf([], NARROW),
      [{ label_class: "lane", geometry: wide, attributes: {} }],
      12,
      counter(),
    );
    // Every vertex took the same offset, and the shape is unchanged.
    expect(pasted[0].geometry).toEqual(wide);
  });

  it("takes the target document's asset and schema version, not the source's", () => {
    const pasted = pastedAnnotations(
      documentOf([], NARROW),
      [{ label_class: "sign", geometry: BOX, attributes: {} }],
      12,
      counter(),
    );
    expect(pasted[0].asset_id).toBe(NARROW.id);
    expect(pasted[0].schema_version).toBe(SCHEMA.version);
  });

  it("keeps every entry when the schema is the one it was copied under", () => {
    // The assumption cross-frame paste rests on, asserted rather than asserted in
    // prose: two assets of one job are two documents over the *same* pinned
    // schema, so a copied class is declared in the target by construction and
    // nothing has to be filtered.
    const entries = copiedEntries([
      annotationOf("a1", "sign", BOX),
      annotationOf("a2", "lane", TRIANGLE),
      annotationOf("a3", "centerline", LINE),
    ]);
    const pasted = pastedAnnotations(documentOf([], NARROW), entries, 12, counter());
    expect(pasted.map((one) => one.label_class)).toEqual(["sign", "lane", "centerline"]);
  });
});

describe("a pasted annotation is a new annotation", () => {
  it("mints a fresh id for each and shares no structure with the entry", () => {
    const mint = counter();
    const entry: ClipboardEntry = { label_class: "lane", geometry: TRIANGLE, attributes: { lit: true } };
    const pasted = pastedAnnotations(documentOf(), [entry, entry], 12, mint);
    expect(mint.calls()).toBe(2);
    expect(pasted[0].id).not.toBe(pasted[1].id);
    expect(pasted[0].geometry).not.toBe(entry.geometry);
    expect(pasted[0].attributes).not.toBe(entry.attributes);
    expect(pasted[0].attributes).toEqual({ lit: true });
  });

  it("claims no provenance the service would overwrite", () => {
    const pasted = pastedAnnotations(
      documentOf(),
      [{ label_class: "sign", geometry: BOX, attributes: {} }],
      12,
      counter(),
    );
    expect(pasted[0]).toMatchObject({
      provenance: "human",
      job_id: null,
      model_ref: null,
      confidence: null,
    });
  });

  it("is human even when what it was copied from was a model's", () => {
    const machine: Annotation = {
      ...annotationOf("a1", "sign", BOX),
      provenance: "model",
      model_ref: "yolo-v8",
      confidence: 0.9,
    };
    const pasted = pastedAnnotations(documentOf(), copiedEntries([machine]), 12, counter());
    expect(pasted[0].provenance).toBe("human");
    expect(pasted[0].model_ref).toBeNull();
    expect(pasted[0].confidence).toBeNull();
  });
});

describe("a second paste cascades rather than stacking", () => {
  it("offsets again when one delta lands on a copy already there", () => {
    const first = pastedAnnotations(
      documentOf([annotationOf("a1", "sign", BOX)]),
      [{ label_class: "sign", geometry: BOX, attributes: {} }],
      12,
      counter(),
    );
    const second = pastedAnnotations(
      documentOf([annotationOf("a1", "sign", BOX), { ...first[0], id: "a2" }]),
      [{ label_class: "sign", geometry: BOX, attributes: {} }],
      12,
      counter(),
    );
    expect(first[0].geometry).toMatchObject({ x: 22, y: 32 });
    expect(second[0].geometry).toMatchObject({ x: 34, y: 44 });
  });

  it("cascades within one paste too, so two copies of one shape do not collide", () => {
    const entry: ClipboardEntry = { label_class: "sign", geometry: BOX, attributes: {} };
    const pasted = pastedAnnotations(documentOf(), [entry, entry], 12, counter());
    expect(pasted[0].geometry).toMatchObject({ x: 22, y: 32 });
    expect(pasted[1].geometry).toMatchObject({ x: 34, y: 44 });
  });

  it("starts at one delta again on a different frame", () => {
    // What makes cross-frame paste land where somebody expects: the rule reads the
    // target document, so a frame that has never been pasted into is a clean slate.
    const pasted = pastedAnnotations(
      documentOf([], NARROW),
      [{ label_class: "sign", geometry: BOX, attributes: {} }],
      12,
      counter(),
    );
    expect(pasted[0].geometry).toMatchObject({ x: 22, y: 32 });
  });

  it("does not cascade past an annotation of a different class in the same place", () => {
    // The predicate is class **and** geometry: a lane sitting exactly where a sign
    // copy would land is not that copy, so nothing is in the way.
    const overlapping = annotationOf("a1", "lane", { type: "bbox", x: 22, y: 32, width: 30, height: 40 });
    const pasted = pastedAnnotations(
      documentOf([overlapping]),
      [{ label_class: "sign", geometry: BOX, attributes: {} }],
      12,
      counter(),
    );
    expect(pasted[0].geometry).toMatchObject({ x: 22, y: 32 });
  });

  it("stops when the shape is pinned and cannot move any further", () => {
    // Stated rather than discovered: against the asset edge the search runs out of
    // room, so copies do stack there. The alternative is a loop that never ends.
    const pinned: Geometry = { type: "bbox", x: 70, y: 60, width: 30, height: 40 };
    const there = annotationOf("a1", "sign", pinned, NARROW);
    const pasted = pastedAnnotations(
      documentOf([there], NARROW),
      [{ label_class: "sign", geometry: pinned, attributes: {} }],
      12,
      counter(),
    );
    expect(pasted[0].geometry).toEqual(pinned);
  });
});

describe("a tag the asset already carries is never pasted twice", () => {
  const TAG: Geometry = { type: "classification_tag" };

  it("drops the entry rather than refusing the whole paste", () => {
    const pasted = pastedAnnotations(
      documentOf([annotationOf("t1", "weather", TAG)]),
      [
        { label_class: "weather", geometry: TAG, attributes: {} },
        { label_class: "sign", geometry: BOX, attributes: {} },
      ],
      12,
      counter(),
    );
    expect(pasted.map((one) => one.label_class)).toEqual(["sign"]);
  });

  it("burns no id on the entry it dropped", () => {
    // `tags.ts`'s rule, kept: a repeated press neither grows the history nor
    // consumes an id.
    const mint = counter();
    pastedAnnotations(
      documentOf([annotationOf("t1", "weather", TAG)]),
      [{ label_class: "weather", geometry: TAG, attributes: {} }],
      12,
      mint,
    );
    expect(mint.calls()).toBe(0);
  });

  it("collapses two copies of one tag in a single paste", () => {
    const entry: ClipboardEntry = { label_class: "weather", geometry: TAG, attributes: {} };
    const pasted = pastedAnnotations(documentOf(), [entry, entry], 12, counter());
    expect(pasted).toHaveLength(1);
  });

  it("does paste a tag onto a frame that does not carry it", () => {
    // The cross-frame case this is actually for: this frame is rainy too.
    const pasted = pastedAnnotations(
      documentOf([], NARROW),
      [{ label_class: "weather", geometry: TAG, attributes: {} }],
      12,
      counter(),
    );
    expect(pasted).toHaveLength(1);
    expect(pasted[0].label_class).toBe("weather");
  });

  it("matches on the geometry, never on the class name alone", () => {
    // The fixture's own hazard: an annotation whose `label_class` names a tag
    // class while carrying a box is not a tag, so it does not block one.
    const impostor = annotationOf("a1", "weather", BOX);
    const pasted = pastedAnnotations(
      documentOf([impostor]),
      [{ label_class: "weather", geometry: TAG, attributes: {} }],
      12,
      counter(),
    );
    expect(pasted).toHaveLength(1);
  });
});
