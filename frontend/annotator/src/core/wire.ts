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
 * No dependency: the package ships zero runtime dependencies and keeps them.
 */

import {
  GEOMETRY_TYPES,
  IMPLEMENTED_GEOMETRY_TYPES,
  type Annotation,
  type AttributeValue,
  type Geometry,
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
    if (
      typeof attribute !== "boolean" &&
      typeof attribute !== "number" &&
      typeof attribute !== "string"
    ) {
      throw new WireFormatError(
        `${what}.${key} must be a boolean, a number or a string`,
      );
    }
    attributes[key] = attribute;
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
