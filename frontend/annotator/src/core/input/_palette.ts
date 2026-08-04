/**
 * The input layer's fixtures: a palette whose *order* is the subject, and a
 * recording host.
 *
 * The `_` prefix marks a harness — `tsconfig.build.json` excludes `src/**\/_*.ts`,
 * so this is out of the shipped engine and out of the headless boundary's type
 * gate, which inherits that exclusion.
 *
 * Deliberately **not** promoted from `tags.test.ts`'s five-class fixture, under
 * the same promote-don't-copy rule `_random.ts` states from the other side. That
 * fixture's subject is the *orphan tag* — a `classification_tag` under a class
 * declared `bbox` — and this one's is *palette order and geometry variety*: which
 * class digit 3 lands on, and that two bbox classes in a row do not move the
 * tool. They share a shape, not a purpose, and promoting either would make one
 * test's setting depend on the other test's subject.
 *
 * The order is the fixture. Reading `PALETTE`'s five rows top to bottom gives
 * `1` → a bbox class, `2` → a polygon class, `3` → a tag class, `4` → a class no
 * annotation can carry, `5` → a *second* bbox class. That covers all four causes
 * of `select` in `tool.ts` and the one pair — 1 and 5 — where the derived tool
 * does not move.
 */

import { createDocument } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import { AnnotatorStore } from "../state/store";
import type {
  Annotation,
  AnnotationSchema,
  AssetDescriptor,
  Geometry,
  LabelClass,
} from "../types";
import type { KeyPress } from "./keys";
import type { InputHost } from "./runAction";

/**
 * A press with nothing held, unless told otherwise.
 *
 * Shared by `keys.test.ts` and `bindings.test.ts` rather than spelled twice: the
 * defaults *are* the claim that a press carries six fields, and two copies would
 * be free to disagree about which ones a test forgot to set.
 */
export function pressOf(key: string, held: Partial<KeyPress> = {}): KeyPress {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    ...held,
  };
}

export const PALETTE_ASSET: AssetDescriptor = { id: "asset-46", width: 800, height: 600 };

/** Digit 1. */
export const SIGN: LabelClass = {
  name: "sign",
  geometry: "bbox",
  color: null,
  attributes: [],
};
/** Digit 2. */
export const LANE: LabelClass = {
  name: "lane",
  geometry: "polygon",
  color: null,
  attributes: [],
};
/** Digit 3 — tagged, never drawn. */
export const WEATHER: LabelClass = {
  name: "weather",
  geometry: "classification_tag",
  color: null,
  attributes: [],
};
/** Digit 4 — declarable in a schema, carryable by no annotation. */
export const RAIL: LabelClass = {
  name: "rail",
  geometry: "polyline",
  color: null,
  attributes: [],
};
/** Digit 5 — a second bbox class, so "same tool" has a witness. */
export const STOP: LabelClass = {
  name: "stop",
  geometry: "bbox",
  color: null,
  attributes: [],
};

export const PALETTE: readonly LabelClass[] = [SIGN, LANE, WEATHER, RAIL, STOP];

export const PALETTE_SCHEMA: AnnotationSchema = {
  project_id: "project-46",
  version: 3,
  classes: PALETTE,
  description: null,
  created_at: null,
};

/** A schema declaring nothing. Every class hotkey question has an empty case. */
export const EMPTY_SCHEMA: AnnotationSchema = {
  project_id: "project-46",
  version: 3,
  classes: [],
  description: null,
  created_at: null,
};

/** A schema of `count` bbox classes named `c1…cN`, for the past-the-ninth cases. */
export function wideSchema(count: number): AnnotationSchema {
  return {
    ...PALETTE_SCHEMA,
    classes: Array.from({ length: count }, (_unused, index) => ({
      name: `c${index + 1}`,
      geometry: "bbox" as const,
      color: null,
      attributes: [],
    })),
  };
}

/** An annotation built by hand, so a test can plant exactly what it needs. */
export function annotationOf(
  id: string,
  labelClass: string,
  geometry: Geometry,
): Annotation {
  return {
    id,
    asset_id: PALETTE_ASSET.id,
    label_class: labelClass,
    schema_version: PALETTE_SCHEMA.version,
    geometry,
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

export const A_BOX: Geometry = { type: "bbox", x: 10, y: 20, width: 30, height: 40 };
export const A_TAG: Geometry = { type: "classification_tag" };

/** A document over the palette schema. */
export function paletteDocument(
  annotations: readonly Annotation[] = [],
  schema: AnnotationSchema = PALETTE_SCHEMA,
): AnnotationDocument {
  return createDocument(PALETTE_ASSET, schema, annotations);
}

/** A store over the palette schema. */
export function paletteStore(
  annotations: readonly Annotation[] = [],
  schema: AnnotationSchema = PALETTE_SCHEMA,
): AnnotatorStore {
  return new AnnotatorStore(paletteDocument(annotations, schema));
}

/** Ids in call order, so a test can say how many were minted. `draft.test.ts`'s. */
export function counter(): (() => string) & { calls: () => number } {
  let n = 0;
  const mint = () => {
    n += 1;
    return `n${n}`;
  };
  return Object.assign(mint, { calls: () => n });
}

/** An `InputHost` that remembers, so a test can assert what was *not* called. */
export interface RecordingHost extends InputHost {
  /** Every `activateClass` argument, in order. */
  readonly activated: readonly (string | null)[];
  /** Every `run` name, in order. */
  readonly ran: readonly string[];
}

/**
 * A host that records and answers `answers` to `run`.
 *
 * `activeClass` is a getter over a mutable field rather than a fixed value: an
 * `activate-class` reads the *previous* class to decide whether the tool moved,
 * so a host that never updated would make the second press of a key look like
 * the first.
 */
export function recordingHost(
  activeClass: string | null = null,
  answers: (name: string) => boolean = () => true,
): RecordingHost {
  const activated: (string | null)[] = [];
  const ran: string[] = [];
  let current = activeClass;
  return {
    get activeClass(): string | null {
      return current;
    },
    activateClass(labelClass: string | null): void {
      current = labelClass;
      activated.push(labelClass);
    },
    run(name: string): boolean {
      ran.push(name);
      return answers(name);
    },
    activated,
    ran,
  };
}
