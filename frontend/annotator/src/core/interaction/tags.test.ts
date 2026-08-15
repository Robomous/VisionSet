/**
 * The classification tag tool, and its two claims: **toggle semantics, with
 * several classes tagging one asset**, and **serialization to the
 * `ClassificationGeometry` wire variant**.
 * The second is proved by a full parse round-trip rather than by reading the
 * geometry's one field, because `parseGeometry` checks keys exactly — a stray key
 * and a missing one both throw — so one assertion covers wire-legality.
 *
 * What it deliberately does not repeat, and who owns it instead:
 * `draft.test.ts` owns which attributes a fresh annotation carries and why a
 * required-and-undefaulted one is drafted anyway; `commandLog.test.ts` owns that
 * redo replays a snapshot; `machine.test.ts` and `_scene.ts` own that a taggable
 * class implies `select` and never enters the canvas machine. This file asserts
 * only the parts a tag adds.
 *
 * Fixtures are inline, for the reason `document.test.ts` and `draft.test.ts` both
 * give: the schema *is* the subject, so a reader chasing a failure must see which
 * classes were declared without opening a second file. The kernel-written fixture
 * is used where the claim is about *real* wire data — chiefly its `"sign"`
 * annotation, a `classification_tag` under a class declared `bbox`, which is what
 * makes the asymmetric refusal rule necessary rather than merely defensible.
 *
 * Assertion style, the package's: documents and annotations are identities, so
 * `toBe`; geometries and id lists are values, so `toEqual`.
 */

import { describe, expect, it } from "vitest";

import { SEEDS, mulberry32 } from "../_random";
import { fixture } from "../_fixture";
import { CommandLog } from "../state/commandLog";
import { createDocument, documentFromWire } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import { AnnotatorStore } from "../state/store";
import {
  ANNOTATION_CREATE_KEYS,
  parseAnnotation,
  toAnnotationCreate,
} from "../wire";
import { GEOMETRY_TYPES } from "../types";
import type {
  Annotation,
  AnnotationSchema,
  AssetDescriptor,
  LabelClass,
} from "../types";
import {
  isTaggableClass,
  tagCommand,
  taggedClassNames,
  tagsFor,
  toggleTagCommand,
  untagCommand,
} from "./tags";

const ASSET: AssetDescriptor = { id: "asset-7", width: 640, height: 480 };

/** A tag class carrying attributes, so the draft's seeding is visible here too. */
const WEATHER: LabelClass = {
  name: "weather",
  geometries: ["classification_tag"],
  color: "#00a0ff",
  attributes: [
    { name: "heavy", kind: "boolean", required: false, options: null, default: false },
    { name: "note", kind: "string", required: false, options: null, default: null },
  ],
};

/** A second tag class, bare — the "multiple classes tag one asset" other half. */
const NIGHT: LabelClass = {
  name: "night",
  geometries: ["classification_tag"],
  color: null,
  attributes: [],
};

const SIGN: LabelClass = { name: "sign", geometries: ["bbox"], color: null, attributes: [] };
const LANE: LabelClass = { name: "lane", geometries: ["polygon"], color: null, attributes: [] };
/** Declarable in a schema, never carryable by an annotation. Not taggable either. */
const RAIL: LabelClass = { name: "rail", geometries: ["polyline"], color: null, attributes: [] };

const SCHEMA: AnnotationSchema = {
  project_id: "project-7",
  version: 4,
  classes: [WEATHER, NIGHT, SIGN, LANE, RAIL],
  description: null,
  created_at: null,
  provenance: null,
};

function documentHere(annotations: readonly Annotation[] = []): AnnotationDocument {
  return createDocument(ASSET, SCHEMA, annotations);
}

/** Ids in call order, so a test can say how many were minted. `draft.test.ts`'s. */
function counter(): (() => string) & { calls: () => number } {
  let n = 0;
  const mint = () => {
    n += 1;
    return `n${n}`;
  };
  return Object.assign(mint, { calls: () => n });
}

/** An annotation built by hand, so a test can plant a duplicate or a mismatch. */
function annotationOf(
  id: string,
  labelClass: string,
  geometry: Annotation["geometry"],
): Annotation {
  return {
    id,
    asset_id: ASSET.id,
    label_class: labelClass,
    schema_version: SCHEMA.version,
    geometry,
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

const A_BOX: Annotation["geometry"] = {
  type: "bbox",
  x: 1,
  y: 2,
  width: 3,
  height: 4,
};
const A_TAG: Annotation["geometry"] = { type: "classification_tag" };

/** The kernel's own fixture as a document — its `"sign"` tag is the trap. */
function fixtureDocument(): AnnotationDocument {
  return documentFromWire({
    asset: fixture.asset,
    schema: fixture.schema,
    annotations: fixture.annotations,
  });
}

describe("which classes can be tagged", () => {
  it("says yes to a class declaring classification_tag", () => {
    expect(isTaggableClass(WEATHER)).toBe(true);
  });

  it("says no to the two geometries that are drawn instead", () => {
    expect(isTaggableClass(SIGN)).toBe(false);
    expect(isTaggableClass(LANE)).toBe(false);
  });

  it("says no to a geometry a schema may declare but an annotation may not carry", () => {
    // `drawableGeometry` also answers null here, which is exactly why both
    // functions are needed: together they tell "tagged" from "not usable here".
    expect(isTaggableClass(RAIL)).toBe(false);
  });

  it("is true of exactly one of the eight geometries the wire names", () => {
    // Reads the vocabulary rather than restating it, so a ninth kernel geometry
    // arriving in `GEOMETRY_TYPES` cannot silently become taggable.
    const taggable = GEOMETRY_TYPES.filter((geometry) =>
      isTaggableClass({ name: "x", geometries: [geometry], color: null, attributes: [] }),
    );
    expect(taggable).toEqual(["classification_tag"]);
  });
});

describe("what the document already carries", () => {
  it("finds a tag by its class name", () => {
    const tag = annotationOf("t1", "weather", A_TAG);
    expect(tagsFor(documentHere([tag]), "weather")).toEqual([tag]);
  });

  it("ignores a box carrying a taggable class's name", () => {
    // The document does not enforce class-geometry agreement, so this is a state
    // that reaches the engine. Matching on the name alone would find it.
    const box = annotationOf("b1", "weather", A_BOX);
    expect(tagsFor(documentHere([box]), "weather")).toEqual([]);
  });

  it("returns every duplicate, in draw order", () => {
    // The kernel permits these: `AnnotationService._validate` never reads the
    // store and `AnnotationRow` has no unique index.
    const first = annotationOf("t1", "weather", A_TAG);
    const second = annotationOf("t2", "weather", A_TAG);
    const document = documentHere([first, second]);
    expect(tagsFor(document, "weather")).toEqual([first, second]);
  });

  it("reports a class the schema no longer declares", () => {
    const orphan = annotationOf("t1", "ghost", A_TAG);
    expect(taggedClassNames(documentHere([orphan])).has("ghost")).toBe(true);
  });

  it("reports the kernel fixture's tag, whose class is declared a bbox", () => {
    // The row this module's whole refusal rule is shaped around.
    const document = fixtureDocument();
    expect(taggedClassNames(document).has("sign")).toBe(true);
    expect(isTaggableClass({ ...SIGN, name: "sign" })).toBe(false);
  });
});

describe("tagging an asset", () => {
  it("adds one annotation carrying the tag geometry and the class", () => {
    const document = documentHere();
    const command = tagCommand(document, "weather", counter());
    const after = command!.apply(document);
    const added = [...after.annotations.values()];
    expect(added).toHaveLength(1);
    expect(added[0]!.geometry).toEqual({ type: "classification_tag" });
    expect(added[0]!.label_class).toBe("weather");
    expect(added[0]!.provenance).toBe("human");
    expect(added[0]!.asset_id).toBe(ASSET.id);
    expect(added[0]!.schema_version).toBe(SCHEMA.version);
  });

  it("seeds the class's attribute defaults, which draft.ts owns in detail", () => {
    const document = documentHere();
    const after = tagCommand(document, "weather", counter())!.apply(document);
    expect([...after.annotations.values()][0]!.attributes).toEqual({ heavy: false });
  });

  it("labels the step 'tag weather', not 'add weather'", () => {
    // The undo menu is the only place a user reads a label, and `add weather`
    // would be indistinguishable from a drawn box.
    expect(tagCommand(documentHere(), "weather", counter())!.label).toBe("tag weather");
  });

  it("mints exactly once", () => {
    const mint = counter();
    tagCommand(documentHere(), "weather", mint);
    expect(mint.calls()).toBe(1);
  });

  it("is the identity when the asset already carries the tag", () => {
    // This is what makes "at most one tag per class" structural: there is no
    // other path in this module that can add one.
    const document = documentHere([annotationOf("t1", "weather", A_TAG)]);
    const command = tagCommand(document, "weather", counter());
    expect(command!.apply(document)).toBe(document);
  });

  it("burns no id when it is the identity", () => {
    const mint = counter();
    tagCommand(documentHere([annotationOf("t1", "weather", A_TAG)]), "weather", mint);
    expect(mint.calls()).toBe(0);
  });

  it("refuses a class the schema does not declare", () => {
    expect(tagCommand(documentHere(), "ghost", counter())).toBeNull();
  });

  it("refuses a class that is drawn rather than tagged", () => {
    expect(tagCommand(documentHere(), "sign", counter())).toBeNull();
    expect(tagCommand(documentHere(), "lane", counter())).toBeNull();
    expect(tagCommand(documentHere(), "rail", counter())).toBeNull();
  });

  it("appends at the end of the draw order", () => {
    const box = annotationOf("b1", "sign", A_BOX);
    const document = documentHere([box]);
    const after = tagCommand(document, "weather", counter())!.apply(document);
    expect([...after.annotations.keys()]).toEqual(["b1", "n1"]);
  });

  it("carries the annotation it drafted, rather than re-drafting on apply", () => {
    // Decision and mint happen at construction. If `apply` re-drafted, redo would
    // restore an annotation undo never removed — `commandLog.ts`'s trap.
    const built = documentHere();
    const command = tagCommand(built, "weather", counter())!;
    const first = [...command.apply(built).annotations.values()][0]!;
    const elsewhere = documentHere([annotationOf("b1", "sign", A_BOX)]);
    const second = [...command.apply(elsewhere).annotations.values()][1]!;
    expect(second).toBe(first);
  });
});

describe("untagging an asset", () => {
  it("removes the tag", () => {
    const document = documentHere([annotationOf("t1", "weather", A_TAG)]);
    const after = untagCommand(document, "weather").apply(document);
    expect(after.annotations.size).toBe(0);
  });

  it("labels the step 'untag weather'", () => {
    expect(untagCommand(documentHere(), "weather").label).toBe("untag weather");
  });

  it("removes every duplicate in one command, so one undo restores them all", () => {
    const tags = [
      annotationOf("t1", "weather", A_TAG),
      annotationOf("t2", "weather", A_TAG),
      annotationOf("t3", "weather", A_TAG),
    ];
    const document = documentHere(tags);
    const log = new CommandLog(document);
    log.execute(untagCommand(document, "weather"));
    expect(log.document.annotations.size).toBe(0);
    expect(log.undoDepth).toBe(1);
    log.undo();
    expect(log.document).toBe(document);
  });

  it("is the identity when the class is not tagged, and does not throw", () => {
    const document = documentHere();
    expect(untagCommand(document, "weather").apply(document)).toBe(document);
  });

  it("never refuses, even for a class the schema does not declare", () => {
    // The orphan path: a tag whose class the schema dropped must stay clearable.
    const document = documentHere([annotationOf("t1", "ghost", A_TAG)]);
    const after = untagCommand(document, "ghost").apply(document);
    expect(after.annotations.size).toBe(0);
  });

  it("never refuses a class the schema declares as a bbox", () => {
    // The kernel fixture's own case, on real data.
    const document = fixtureDocument();
    const before = taggedClassNames(document).has("sign");
    const after = untagCommand(document, "sign").apply(document);
    expect(before).toBe(true);
    expect(taggedClassNames(after).has("sign")).toBe(false);
  });

  it("does not remove a box carrying the same class name", () => {
    // The twin of the `tagsFor` case, and the one that is data loss if it breaks.
    const box = annotationOf("b1", "weather", A_BOX);
    const tag = annotationOf("t1", "weather", A_TAG);
    const document = documentHere([box, tag]);
    const after = untagCommand(document, "weather").apply(document);
    expect([...after.annotations.keys()]).toEqual(["b1"]);
  });

  it("changes nothing when the class has only boxes", () => {
    const document = documentHere([annotationOf("b1", "weather", A_BOX)]);
    expect(untagCommand(document, "weather").apply(document)).toBe(document);
  });
});

describe("toggling a tag", () => {
  it("tags an asset that is not tagged", () => {
    const document = documentHere();
    const after = toggleTagCommand(document, "weather", counter())!.apply(document);
    expect(taggedClassNames(after).has("weather")).toBe(true);
  });

  it("untags an asset that is", () => {
    const document = documentHere([annotationOf("t1", "weather", A_TAG)]);
    const after = toggleTagCommand(document, "weather", counter())!.apply(document);
    expect(taggedClassNames(after).has("weather")).toBe(false);
  });

  it("returns to the same annotation ids after two toggles", () => {
    const start = documentHere([annotationOf("b1", "sign", A_BOX)]);
    const mint = counter();
    const on = toggleTagCommand(start, "weather", mint)!.apply(start);
    const off = toggleTagCommand(on, "weather", mint)!.apply(on);
    // `toEqual`: the Map spine is rebuilt, so identity is not the claim.
    expect([...off.annotations.keys()]).toEqual([...start.annotations.keys()]);
  });

  it("refuses a class that is neither tagged nor taggable", () => {
    expect(toggleTagCommand(documentHere(), "sign", counter())).toBeNull();
    expect(toggleTagCommand(documentHere(), "ghost", counter())).toBeNull();
  });

  it("does NOT refuse a tagged class the schema declares as a bbox", () => {
    // The asymmetry, pinned on the kernel's own fixture: a symmetric refusal
    // would draw a checked checkbox that could never be cleared.
    const document = fixtureDocument();
    const command = toggleTagCommand(document, "sign", counter());
    expect(command).not.toBeNull();
    expect(taggedClassNames(command!.apply(document)).has("sign")).toBe(false);
  });

  it("mints a fresh id across a tag, untag, tag cycle", () => {
    const mint = counter();
    const start = documentHere();
    const on = toggleTagCommand(start, "weather", mint)!.apply(start);
    const off = toggleTagCommand(on, "weather", mint)!.apply(on);
    const again = toggleTagCommand(off, "weather", mint)!.apply(off);
    expect([...on.annotations.keys()]).toEqual(["n1"]);
    expect([...again.annotations.keys()]).toEqual(["n2"]);
  });

  it("mints nothing when it resolves to an untag", () => {
    const mint = counter();
    toggleTagCommand(documentHere([annotationOf("t1", "weather", A_TAG)]), "weather", mint);
    expect(mint.calls()).toBe(0);
  });
});

describe("several classes tagging one asset", () => {
  it("keeps both tags", () => {
    const mint = counter();
    const start = documentHere();
    const one = tagCommand(start, "weather", mint)!.apply(start);
    const two = tagCommand(one, "night", mint)!.apply(one);
    expect([...taggedClassNames(two)]).toEqual(["weather", "night"]);
  });

  it("untags one and leaves the other", () => {
    const mint = counter();
    const start = documentHere();
    const one = tagCommand(start, "weather", mint)!.apply(start);
    const two = tagCommand(one, "night", mint)!.apply(one);
    const after = untagCommand(two, "weather").apply(two);
    expect([...taggedClassNames(after)]).toEqual(["night"]);
  });

  it("tags alongside drawn annotations without disturbing them", () => {
    const box = annotationOf("b1", "sign", A_BOX);
    const start = documentHere([box]);
    const after = tagCommand(start, "weather", counter())!.apply(start);
    expect(after.annotations.get("b1")).toBe(box);
  });
});

describe("through the store, where undo lives", () => {
  it("records one undoable step labelled for the tag", () => {
    const store = new AnnotatorStore(documentHere());
    store.execute(tagCommand(store.document, "weather", counter())!);
    expect(store.canUndo).toBe(true);
    expect(store.getSnapshot().undoLabel).toBe("tag weather");
  });

  it("undoes to the original document and redoes the same annotation object", () => {
    const start = documentHere();
    const store = new AnnotatorStore(start);
    store.execute(tagCommand(store.document, "weather", counter())!);
    const tagged = [...store.document.annotations.values()][0]!;
    store.undo();
    expect(store.document).toBe(start);
    store.redo();
    // `toBe`: redo replays a snapshot, so it is the very same annotation. A mint
    // inside `apply` would make this a different object with a different id.
    expect([...store.document.annotations.values()][0]!).toBe(tagged);
  });

  it("does not grow the history, or notify, when the tag is already there", () => {
    const store = new AnnotatorStore(documentHere([annotationOf("t1", "weather", A_TAG)]));
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.execute(tagCommand(store.document, "weather", counter())!);
    expect(store.canUndo).toBe(false);
    expect(notifications).toBe(0);
  });

  it("rewinds a toggle pair to the document it started from", () => {
    const start = documentHere();
    const store = new AnnotatorStore(start);
    const mint = counter();
    store.execute(toggleTagCommand(store.document, "weather", mint)!);
    store.execute(toggleTagCommand(store.document, "weather", mint)!);
    store.undo();
    store.undo();
    expect(store.document).toBe(start);
  });
});

describe("what a tag serializes to", () => {
  it("becomes an AnnotationCreate carrying the classification_tag variant", () => {
    const document = documentHere();
    const after = tagCommand(document, "weather", counter())!.apply(document);
    const payload = toAnnotationCreate([...after.annotations.values()][0]!);
    expect(Object.keys(payload).sort()).toEqual([...ANNOTATION_CREATE_KEYS].sort());
    expect(payload.geometry).toEqual({ type: "classification_tag" });
    expect(Object.hasOwn(payload, "id")).toBe(false);
    expect(Object.hasOwn(payload, "schema_version")).toBe(false);
  });

  it("survives a round trip through JSON and the wire parser", () => {
    // `parseGeometry` checks keys exactly, so this one assertion proves the
    // drafted annotation is wire-legal — no stray key, none missing.
    const document = documentHere();
    const after = tagCommand(document, "weather", counter())!.apply(document);
    const tag = [...after.annotations.values()][0]!;
    expect(parseAnnotation(JSON.parse(JSON.stringify(tag)))).toEqual(tag);
  });

  it("does the same against the kernel's own schema", () => {
    const document = fixtureDocument();
    const after = tagCommand(document, "weather", counter())!.apply(document);
    const tag = [...after.annotations.values()].at(-1)!;
    expect(tag.geometry).toEqual({ type: "classification_tag" });
    expect(parseAnnotation(JSON.parse(JSON.stringify(tag)))).toEqual(tag);
  });
});

describe("over any sequence of toggles", () => {
  const CLASSES = ["weather", "night"] as const;

  for (const seed of SEEDS) {
    it(`holds at most one tag per class, seed ${seed}`, () => {
      const random = mulberry32(seed);
      const store = new AnnotatorStore(documentHere([annotationOf("b1", "sign", A_BOX)]));
      const mint = counter();
      const expected = new Set<string>();

      for (let step = 0; step < 60; step += 1) {
        const name = CLASSES[Math.floor(random() * CLASSES.length)]!;
        const command = toggleTagCommand(store.document, name, mint);
        expect(command).not.toBeNull();
        store.execute(command!);
        if (expected.has(name)) expected.delete(name);
        else expected.add(name);

        expect([...taggedClassNames(store.document)].sort()).toEqual(
          [...expected].sort(),
        );
        for (const each of CLASSES) {
          expect(tagsFor(store.document, each).length).toBeLessThanOrEqual(1);
        }
      }
      // The box was never a tag and was never touched.
      expect(store.document.annotations.has("b1")).toBe(true);
    });
  }
});
