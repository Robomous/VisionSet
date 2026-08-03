/**
 * Parsing the wire contract: `unknown` in, a typed `Annotation` out.
 *
 * TypeScript erases at runtime, so declaring the shapes in `types.ts` proves
 * nothing about the bytes a host actually hands over. This is the half that
 * checks — and the half `wire.test.ts` runs against a fixture the Python kernel
 * produced, which is what makes "the TS mirror agrees with the union" a claim
 * rather than a hope.
 *
 * Three rules, each a decision:
 *
 * 1. **Strict about unknown keys as well as missing ones.** Lenient parsing plus
 *    a whole-object round-trip is data loss: the editor hands back what it was
 *    given, so a key it silently dropped is a field the kernel wrote and the
 *    editor erased. This is the `extra="forbid"` posture the request bodies
 *    already take, and it is what turns a kernel field addition into a build
 *    failure here instead of a quiet truncation in production.
 *
 * 2. **Shape, not bounds.** A zero-area box and a two-point polygon are refused
 *    by the kernel's own models. Re-checking them here would be a second copy of
 *    a rule that already has an owner, and the copies would drift. What a
 *    half-drawn shape is allowed to be belongs to the document model, not to the
 *    parser of stored annotations.
 *
 * 3. **A declared-but-unimplemented geometry gets its own message.** `polyline`
 *    is a real `GeometryType` with no model, not a typo, and the refusal says so
 *    — because someone reading it needs to know the answer is "not yet" rather
 *    than "you misspelled it".
 *
 * #40 added the schema and the asset, and with them a fourth rule:
 *
 * 4. **Strictness follows the round-trip, not the type.** Rule 1 is exact about
 *    keys *because the editor hands annotations back*. The schema and the asset
 *    are input-only — nothing here ever returns them — so that argument does not
 *    transfer, and `color`, `attributes`, `required`, `options` and `default` all
 *    carry defaults on the wire, which #27's rule emits as *optional*. So those
 *    parsers apply the wire's own defaults for an absent optional key while still
 *    refusing an unknown one, which is a caller bug either way. `allowExactKeys`
 *    is that distinction made explicit rather than `requireExactKeys` loosened.
 *
 * No dependency: the package ships zero runtime dependencies and keeps them.
 */

import {
  ATTRIBUTE_KINDS,
  GEOMETRY_TYPES,
  IMPLEMENTED_GEOMETRY_TYPES,
  type Annotation,
  type AnnotationCreate,
  type AnnotationSchema,
  type AnnotationUpdate,
  type AssetDescriptor,
  type Attribute,
  type AttributeKind,
  type AttributeValue,
  type Geometry,
  type LabelClass,
  type Point,
  type Provenance,
} from "./types";

/** A payload that is not the wire contract. The message names the field. */
export class WireFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireFormatError";
  }
}

// `Record<keyof T, true>` is the gate: it fails to compile when a key is
// missing AND when one is spelled that the interface does not declare. That is
// what keeps these lists pinned to `types.ts` without an assertion nobody runs.
const ANNOTATION_KEY_SET: Record<keyof Annotation, true> = {
  id: true,
  asset_id: true,
  label_class: true,
  schema_version: true,
  geometry: true,
  attributes: true,
  provenance: true,
  model_ref: true,
  confidence: true,
};

/** Exactly the keys of `Annotation`, in declaration order. */
export const ANNOTATION_KEYS = Object.keys(
  ANNOTATION_KEY_SET,
) as readonly (keyof Annotation)[];

// The two outbound projections get the same gate, which is what keeps them from
// drifting into "the same fields minus whichever one somebody forgot".
const CREATE_KEY_SET: Record<keyof AnnotationCreate, true> = {
  asset_id: true,
  label_class: true,
  geometry: true,
  attributes: true,
  provenance: true,
  model_ref: true,
  confidence: true,
};

const UPDATE_KEY_SET: Record<keyof AnnotationUpdate, true> = {
  id: true,
  label_class: true,
  geometry: true,
  attributes: true,
  provenance: true,
  model_ref: true,
  confidence: true,
};

/** Exactly the keys `POST /jobs/{id}/annotations` takes. */
export const ANNOTATION_CREATE_KEYS = Object.keys(
  CREATE_KEY_SET,
) as readonly (keyof AnnotationCreate)[];

/** Exactly the keys `PATCH /jobs/{id}/annotations` takes. */
export const ANNOTATION_UPDATE_KEYS = Object.keys(
  UPDATE_KEY_SET,
) as readonly (keyof AnnotationUpdate)[];

const ATTRIBUTE_REQUIRED_KEYS = ["name", "kind"] as const;
const ATTRIBUTE_OPTIONAL_KEYS = ["required", "options", "default"] as const;
const LABEL_CLASS_REQUIRED_KEYS = ["name", "geometry"] as const;
const LABEL_CLASS_OPTIONAL_KEYS = ["color", "attributes"] as const;
const SCHEMA_REQUIRED_KEYS = ["project_id", "version", "classes"] as const;
// Optional rather than required, so a payload from a server older than #230
// still parses. A current one always sends them — a pydantic field with a
// default is serialized, present and null.
const SCHEMA_OPTIONAL_KEYS = ["description", "created_at"] as const;
// A projection, so it names the three fields it wants and ignores the eight it
// does not — the one place here that is deliberately not exact about keys.
const ASSET_KEYS = ["id", "width", "height"] as const;

const BBOX_KEYS = ["type", "x", "y", "width", "height"] as const;
const POLYGON_KEYS = ["type", "points"] as const;
const CLASSIFICATION_KEYS = ["type"] as const;

const PROVENANCES: readonly Provenance[] = ["human", "model", "import"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refuse a payload whose key set is not exactly `expected`, naming the difference. */
function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  what: string,
): void {
  const present = new Set(Object.keys(value));
  const missing = expected.filter((key) => !present.has(key));
  const unknown = [...present].filter((key) => !expected.includes(key));
  if (missing.length > 0) {
    throw new WireFormatError(`${what} is missing ${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    throw new WireFormatError(
      `${what} carries ${unknown.join(", ")}, which the wire contract does not declare`,
    );
  }
}

/**
 * Refuse a payload missing a required key or carrying an undeclared one.
 *
 * Rule 4: an absent *optional* key is legal and the caller applies the wire's own
 * default. Deliberately a second function rather than a parameter on
 * `requireExactKeys`, so nothing can loosen the annotation path by accident.
 */
function allowExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  what: string,
): void {
  const present = new Set(Object.keys(value));
  const missing = required.filter((key) => !present.has(key));
  const declared = [...required, ...optional];
  const unknown = [...present].filter((key) => !declared.includes(key));
  if (missing.length > 0) {
    throw new WireFormatError(`${what} is missing ${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    throw new WireFormatError(
      `${what} carries ${unknown.join(", ")}, which the wire contract does not declare`,
    );
  }
}

function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WireFormatError(`${what} must be a finite number`);
  }
  return value;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new WireFormatError(`${what} must be a string`);
  }
  return value;
}

function requireNullableString(value: unknown, what: string): string | null {
  return value === null ? null : requireString(value, what);
}

function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    throw new WireFormatError(`${what} must be a boolean`);
  }
  return value;
}

function requireStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) {
    throw new WireFormatError(`${what} must be an array`);
  }
  return value.map((entry, index) => requireString(entry, `${what}[${index}]`));
}

/** One attribute value: the three types the kernel's smart union tries, in order. */
function requireAttributeValue(value: unknown, what: string): AttributeValue {
  if (
    typeof value !== "boolean" &&
    typeof value !== "number" &&
    typeof value !== "string"
  ) {
    throw new WireFormatError(`${what} must be a boolean, a number or a string`);
  }
  return value;
}

function requirePoint(value: unknown, what: string): Point {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new WireFormatError(
      `${what} must be an [x, y] pair — the wire has no {x, y} point`,
    );
  }
  return [requireNumber(value[0], `${what}[0]`), requireNumber(value[1], `${what}[1]`)];
}

function requireAttributes(
  value: unknown,
  what: string,
): Record<string, AttributeValue> {
  if (!isRecord(value)) {
    throw new WireFormatError(`${what} must be an object`);
  }
  const attributes: Record<string, AttributeValue> = {};
  for (const [key, attribute] of Object.entries(value)) {
    attributes[key] = requireAttributeValue(attribute, `${what}.${key}`);
  }
  return attributes;
}

/**
 * One geometry, routed on its `type` exactly as the domain's union is.
 *
 * A `type` this build cannot carry is told apart from a `type` that is not a
 * geometry at all, because the remedies differ: the first waits for a variant to
 * be implemented, the second is a bug in the caller.
 */
export function parseGeometry(value: unknown): Geometry {
  if (!isRecord(value)) {
    throw new WireFormatError("geometry must be an object");
  }
  const type = value["type"];
  if (typeof type !== "string" || !(GEOMETRY_TYPES as readonly string[]).includes(type)) {
    throw new WireFormatError(
      `geometry.type ${JSON.stringify(type)} is not a GeometryType — expected one of ${GEOMETRY_TYPES.join(", ")}`,
    );
  }
  if (!(IMPLEMENTED_GEOMETRY_TYPES as readonly string[]).includes(type)) {
    throw new WireFormatError(
      `geometry.type "${type}" is a declared GeometryType with no implementation — ` +
        `the kernel refuses it too (UNSUPPORTED_GEOMETRY). Carryable today: ` +
        `${IMPLEMENTED_GEOMETRY_TYPES.join(", ")}. See docs/schemas.md.`,
    );
  }

  switch (type) {
    case "bbox":
      requireExactKeys(value, BBOX_KEYS, "bbox geometry");
      return {
        type: "bbox",
        x: requireNumber(value["x"], "geometry.x"),
        y: requireNumber(value["y"], "geometry.y"),
        width: requireNumber(value["width"], "geometry.width"),
        height: requireNumber(value["height"], "geometry.height"),
      };
    case "polygon": {
      requireExactKeys(value, POLYGON_KEYS, "polygon geometry");
      const points = value["points"];
      if (!Array.isArray(points)) {
        throw new WireFormatError("geometry.points must be an array");
      }
      return {
        type: "polygon",
        points: points.map((point, index) =>
          requirePoint(point, `geometry.points[${index}]`),
        ),
      };
    }
    default:
      requireExactKeys(value, CLASSIFICATION_KEYS, "classification_tag geometry");
      return { type: "classification_tag" };
  }
}

/**
 * One stored annotation, rebuilt field by field.
 *
 * Rebuilding rather than casting is what gives the round-trip test its teeth:
 * re-serializing the result and comparing it to the input proves nothing was
 * dropped, renamed or reordered on the way through.
 */
export function parseAnnotation(value: unknown): Annotation {
  if (!isRecord(value)) {
    throw new WireFormatError("annotation must be an object");
  }
  requireExactKeys(value, ANNOTATION_KEYS, "annotation");

  const provenance = requireString(value["provenance"], "annotation.provenance");
  if (!(PROVENANCES as readonly string[]).includes(provenance)) {
    throw new WireFormatError(
      `annotation.provenance ${JSON.stringify(provenance)} is not one of ${PROVENANCES.join(", ")}`,
    );
  }

  const confidence = value["confidence"];
  return {
    id: requireString(value["id"], "annotation.id"),
    asset_id: requireString(value["asset_id"], "annotation.asset_id"),
    label_class: requireString(value["label_class"], "annotation.label_class"),
    schema_version: requireNumber(value["schema_version"], "annotation.schema_version"),
    geometry: parseGeometry(value["geometry"]),
    attributes: requireAttributes(value["attributes"], "annotation.attributes"),
    provenance: provenance as Provenance,
    model_ref: requireNullableString(value["model_ref"], "annotation.model_ref"),
    confidence:
      confidence === null ? null : requireNumber(confidence, "annotation.confidence"),
  };
}

/** A whole collection, refused entirely if any member is malformed. */
export function parseAnnotations(value: unknown): Annotation[] {
  if (!Array.isArray(value)) {
    throw new WireFormatError("annotations must be an array");
  }
  return value.map(parseAnnotation);
}

/**
 * One attribute declaration. Optional keys take the wire model's own defaults.
 *
 * What an attribute will and will not *accept* is not checked here: `Attribute`'s
 * own validators own that, and re-deriving "a select needs options" in TypeScript
 * would be a second copy of a rule with an owner. This parser establishes the
 * shape a surface renders a field from.
 */
export function parseAttribute(value: unknown): Attribute {
  if (!isRecord(value)) {
    throw new WireFormatError("attribute must be an object");
  }
  allowExactKeys(value, ATTRIBUTE_REQUIRED_KEYS, ATTRIBUTE_OPTIONAL_KEYS, "attribute");

  const name = requireString(value["name"], "attribute.name");
  const kind = requireString(value["kind"], `attribute ${name} kind`);
  if (!(ATTRIBUTE_KINDS as readonly string[]).includes(kind)) {
    throw new WireFormatError(
      `attribute ${name} kind ${JSON.stringify(kind)} is not one of ${ATTRIBUTE_KINDS.join(", ")}`,
    );
  }

  const options = value["options"];
  const fallback = value["default"];
  return {
    name,
    kind: kind as AttributeKind,
    required:
      value["required"] === undefined
        ? false
        : requireBoolean(value["required"], `attribute ${name} required`),
    options:
      options === undefined || options === null
        ? null
        : requireStringArray(options, `attribute ${name} options`),
    default:
      fallback === undefined || fallback === null
        ? null
        : requireAttributeValue(fallback, `attribute ${name} default`),
  };
}

/**
 * One labelable class.
 *
 * `geometry` is validated against the **eight**, not the three: declaring
 * `polyline` is legal in a schema and refused at the annotation. Narrowing here
 * would make a whole class list unloadable because of one class nobody was going
 * to draw with.
 */
export function parseLabelClass(value: unknown): LabelClass {
  if (!isRecord(value)) {
    throw new WireFormatError("label class must be an object");
  }
  allowExactKeys(value, LABEL_CLASS_REQUIRED_KEYS, LABEL_CLASS_OPTIONAL_KEYS, "label class");

  const name = requireString(value["name"], "label class name");
  const geometry = requireString(value["geometry"], `class ${name} geometry`);
  if (!(GEOMETRY_TYPES as readonly string[]).includes(geometry)) {
    throw new WireFormatError(
      `class ${name} declares geometry ${JSON.stringify(geometry)}, which is not a GeometryType — ` +
        `expected one of ${GEOMETRY_TYPES.join(", ")}`,
    );
  }

  const attributes = value["attributes"];
  if (attributes !== undefined && !Array.isArray(attributes)) {
    throw new WireFormatError(`class ${name} attributes must be an array`);
  }
  return {
    name,
    geometry: geometry as LabelClass["geometry"],
    color:
      value["color"] === undefined
        ? null
        : requireNullableString(value["color"], `class ${name} color`),
    attributes: attributes === undefined ? [] : attributes.map(parseAttribute),
  };
}

/** One version of the labeling contract, classes in the order it declares them. */
export function parseSchema(value: unknown): AnnotationSchema {
  if (!isRecord(value)) {
    throw new WireFormatError("schema must be an object");
  }
  allowExactKeys(value, SCHEMA_REQUIRED_KEYS, SCHEMA_OPTIONAL_KEYS, "schema");
  const classes = value["classes"];
  if (!Array.isArray(classes)) {
    throw new WireFormatError("schema.classes must be an array");
  }
  return {
    project_id: requireString(value["project_id"], "schema.project_id"),
    version: requireNumber(value["version"], "schema.version"),
    classes: classes.map(parseLabelClass),
    description:
      value["description"] === undefined
        ? null
        : requireNullableString(value["description"], "schema.description"),
    created_at:
      value["created_at"] === undefined
        ? null
        : requireNullableString(value["created_at"], "schema.created_at"),
  };
}

/**
 * The frame an asset's annotations are measured in, read off an `AssetOut`.
 *
 * The one deliberately non-exact parser: it takes the three fields an engine can
 * use and ignores the eight about where the bytes came from, so a host can hand
 * over the response it already has.
 *
 * A null `width` or `height` is refused rather than defaulted. `AssetOut` declares
 * both nullable because a pre-pipeline row has never been measured, and there is
 * no honest fallback: geometry here is native pixels, so an unmeasured asset has
 * no frame to be native to. Guessing would produce coordinates that are in range
 * and uniformly wrong.
 */
export function parseAssetDescriptor(value: unknown): AssetDescriptor {
  if (!isRecord(value)) {
    throw new WireFormatError("asset must be an object");
  }
  const missing = ASSET_KEYS.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new WireFormatError(`asset is missing ${missing.join(", ")}`);
  }
  const id = requireString(value["id"], "asset.id");
  if (value["width"] === null || value["height"] === null) {
    throw new WireFormatError(
      `asset ${id} has no measured width and height, so there is no pixel frame to ` +
        `annotate in — an unmeasured asset needs the ingest pipeline to run first`,
    );
  }
  return {
    id,
    width: requireNumber(value["width"], "asset.width"),
    height: requireNumber(value["height"], "asset.height"),
  };
}

/**
 * What `POST /jobs/{id}/annotations` takes, from an annotation the engine holds.
 *
 * Drops `id` and `schema_version`, and dropping them is the point rather than a
 * detail: both are provisional locally — a client-minted uuid v4 and whatever
 * version the schema in hand claimed — and the service mints the first and stamps
 * the second from the version its batch pinned. A field a client could set and
 * never observe is a lie, so neither travels, which is exactly what makes
 * inventing a local id safe.
 */
export function toAnnotationCreate(annotation: Annotation): AnnotationCreate {
  return {
    asset_id: annotation.asset_id,
    label_class: annotation.label_class,
    geometry: annotation.geometry,
    attributes: annotation.attributes,
    provenance: annotation.provenance,
    model_ref: annotation.model_ref,
    confidence: annotation.confidence,
  };
}

/**
 * What `PATCH /jobs/{id}/annotations` takes: a whole replacement, addressed by id.
 *
 * No `asset_id` — the stored one wins, so moving a label to another asset is a
 * delete and an add. No `schema_version` either, for `toAnnotationCreate`'s reason.
 */
export function toAnnotationUpdate(annotation: Annotation): AnnotationUpdate {
  return {
    id: annotation.id,
    label_class: annotation.label_class,
    geometry: annotation.geometry,
    attributes: annotation.attributes,
    provenance: annotation.provenance,
    model_ref: annotation.model_ref,
    confidence: annotation.confidence,
  };
}
