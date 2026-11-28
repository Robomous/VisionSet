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
 * 1. **Strict about unknown keys as well as missing ones — on the annotation
 *    path.** Lenient parsing plus a whole-object round-trip is data loss: the
 *    editor hands back what it was given, so a key it silently dropped is a
 *    field the kernel wrote and the editor erased. This is the `extra="forbid"`
 *    posture the request bodies already take, and it is what turns a kernel
 *    field addition into a build failure here instead of a quiet truncation in
 *    production. Rule 4 says where this applies and where it deliberately does
 *    not; read them together.
 *
 * 2. **Shape, not bounds.** A zero-area box and a two-point polygon are refused
 *    by the kernel's own models. Re-checking them here would be a second copy of
 *    a rule that already has an owner, and the copies would drift. What a
 *    half-drawn shape is allowed to be belongs to the document model, not to the
 *    parser of stored annotations.
 *
 * 3. **A declared-but-unimplemented geometry gets its own message.** A real
 *    `GeometryType` with no model is not a typo, and the refusal says so —
 *    because someone reading it needs to know the answer is "not yet" rather than
 *    "you misspelled it". Every name has a model today; the guard stays for the
 *    next one the kernel declares before it implements it.
 *
 * The schema and the asset bring a fourth rule:
 *
 * 4. **Strictness follows the round-trip, not the type.** Rule 1 is exact about
 *    keys *because the editor hands annotations back*: a key silently dropped is
 *    a field the kernel wrote and the editor erased. The schema, the label class,
 *    the attribute and the asset are **input-only** — nothing here ever returns
 *    them — so that argument does not transfer, and an unknown key on one of them
 *    can lose nothing.
 *
 *    So an input-only mirror **ignores keys it does not declare**, and a
 *    round-tripped one refuses them. Concretely: `requireExactKeys` for
 *    `Annotation` and every `Geometry` variant, `allowUndeclaredKeys` for
 *    everything else.
 *
 *    This is the rule `@visionset/ui-core` already follows on the other side of
 *    the frontend — its generated `checks.ts` says "unknown keys (a server that
 *    grows a field must not break an older client)" in its own header — and
 *    and the cost of disagreeing has been paid once: two fields added to
 *    `SchemaVersionOut` made `parseSchema` refuse every schema the server sent.
 *
 *    It matters because these two packages are published. Inside the wheel the
 *    annotator and the server always ship together, so skew is impossible; an
 *    application that embeds `@visionset/annotator` against a newer VisionSet has
 *    no such guarantee, and the right answer there is to render what it
 *    understands rather than refuse to open the page.
 *
 *    A *missing* key is still refused, because that is the server failing to
 *    send something the parser needs, which no amount of version skew excuses.
 *    An absent key that is optional on the wire is legal and the parser applies
 *    the wire's own default.
 *
 * No dependency: the package ships zero runtime dependencies and keeps them.
 */

import {
  ATTRIBUTE_KINDS,
  GEOMETRY_TYPES,
  IMPLEMENTED_GEOMETRY_TYPES,
  VERTEX_VISIBILITY,
  type Annotation,
  type AnnotationCreate,
  type AnnotationSchema,
  type AnnotationUpdate,
  type AssetDescriptor,
  type Attribute,
  type AttributeKind,
  type AttributeValue,
  type Calibration,
  type Cuboid3DGeometry,
  type Geometry,
  type KeypointSpec,
  type KeypointsGeometry,
  type LabelClass,
  type MaskGeometry,
  type Point,
  type Point3D,
  type Polyline3DGeometry,
  type Provenance,
  type ScanAnnotation,
  type StoredAnnotation,
  type StoredGeometry,
  type VertexVisibility,
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
  job_id: true,
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

// Only the *required* keys, for the four input-only mirrors. There is no
// matching list of optional ones and there does not need to be: under rule 4 an
// undeclared key is ignored, so "optional" and "not mentioned here" behave the
// same way, and a second list would only be somewhere for the two to drift.
// What each parser actually reads is `types.ts`, which is the mirror.
const ATTRIBUTE_REQUIRED_KEYS = ["name", "kind"] as const;
const LABEL_CLASS_REQUIRED_KEYS = ["name", "geometries"] as const;
const SCHEMA_REQUIRED_KEYS = ["project_id", "version", "classes"] as const;
// A projection: it names the three fields it wants of the eleven an asset
// carries. Rule 4 is what makes that unremarkable rather than a special case.
const ASSET_KEYS = ["id", "width", "height"] as const;
const INTRINSICS_KEYS = ["fx", "fy", "cx", "cy", "skew", "width", "height"] as const;
const DISTORTION_KEYS = ["model", "k1", "k2", "p1", "p2", "k3"] as const;

const BBOX_KEYS = ["type", "x", "y", "width", "height"] as const;
const OBB_KEYS = ["type", "cx", "cy", "width", "height", "angle"] as const;
const POLYGON_KEYS = ["type", "points"] as const;
// A polyline carries the same two keys; the discriminator is the difference.
const POLYLINE_KEYS = ["type", "points"] as const;
// Declared but optional: the kernel omits it when nobody has said.
const POLYLINE_OPTIONAL_KEYS = ["visibility"] as const;
const VERTEX_VISIBILITIES: readonly number[] = Object.values(VERTEX_VISIBILITY);
const MASK_KEYS = ["type", "size", "counts"] as const;
const KEYPOINT_SPEC_REQUIRED_KEYS = ["names"] as const;
const CUBOID_KEYS = ["type", "center", "size", "yaw"] as const;
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
  optional: readonly string[] = [],
): void {
  const present = new Set(Object.keys(value));
  const missing = expected.filter((key) => !present.has(key));
  const unknown = [...present].filter(
    (key) => !expected.includes(key) && !optional.includes(key),
  );
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
 * Refuse a payload missing a required key; ignore any key not declared here.
 *
 * Rule 4, for the input-only mirrors. A key this build does not know about is a
 * newer server's field, and ignoring it is safe precisely because nothing here
 * hands these objects back — there is nothing to erase.
 *
 * Deliberately a second function rather than a parameter on `requireExactKeys`,
 * so nothing can loosen the annotation path by accident. That path round-trips
 * and must stay exact.
 */
function allowUndeclaredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  what: string,
): void {
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new WireFormatError(`${what} is missing ${missing.join(", ")}`);
  }
}

/** One state per point. The kernel refuses any other length, and so does this. */
function requireVisibility(value: unknown, pointCount: number): VertexVisibility[] {
  if (!Array.isArray(value)) {
    throw new WireFormatError("geometry.visibility must be an array");
  }
  if (value.length !== pointCount) {
    throw new WireFormatError(
      `geometry.visibility names ${value.length} states for ${pointCount} points`,
    );
  }
  return value.map((state, index) => {
    if (typeof state !== "number" || !VERTEX_VISIBILITIES.includes(state)) {
      throw new WireFormatError(
        `geometry.visibility[${index}] ${JSON.stringify(state)} is not one of ${VERTEX_VISIBILITIES.join(", ")}`,
      );
    }
    return state as VertexVisibility;
  });
}

function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WireFormatError(`${what} must be a finite number`);
  }
  return value;
}

function requirePixelCount(value: unknown, what: string): number {
  const count = requireNumber(value, what);
  if (!Number.isInteger(count) || count < 1) {
    throw new WireFormatError(`${what} must be a positive whole number of pixels`);
  }
  return count;
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

function requirePoint3D(value: unknown, what: string): Point3D {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new WireFormatError(`${what} must be an [x, y, z] triple`);
  }
  return [
    requireNumber(value[0], `${what}[0]`),
    requireNumber(value[1], `${what}[1]`),
    requireNumber(value[2], `${what}[2]`),
  ];
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
 * One geometry this engine draws, routed on its `type` exactly as the domain's union is.
 *
 * A `type` this build cannot carry is told apart from a `type` that is not a
 * geometry at all, because the remedies differ: the first waits for a variant to
 * be implemented, the second is a bug in the caller. A 3D label (`polyline_3d`,
 * `cuboid_3d`) never enters the image scene, so it is refused here and parsed by
 * `parseStoredGeometry`; a scan's cuboids reach the scan editor that way.
 */
export function parseGeometry(value: unknown): Geometry {
  const geometry = parseStoredGeometry(value);
  if (geometry.type === "polyline_3d" || geometry.type === "cuboid_3d") {
    throw new WireFormatError(
      `geometry.type "${geometry.type}" has no pixel coordinates of its own — on an image ` +
        `only projectLabels3D draws it, read-only, and a scan edits it in a ScanDocument`,
    );
  }
  if (geometry.type === "mask") {
    throw new WireFormatError(
      `geometry.type "mask" is carried untouched: this engine neither draws nor edits a raster mask`,
    );
  }
  if (geometry.type === "keypoints") {
    throw new WireFormatError(
      `geometry.type "keypoints" is carried untouched: keypointLabels draws it read-only, ` +
        `and this engine does not edit it`,
    );
  }
  return geometry;
}

/** One geometry the wire can carry, including the ones the scene does not draw. */
export function parseStoredGeometry(value: unknown): StoredGeometry {
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
        `${IMPLEMENTED_GEOMETRY_TYPES.join(", ")}. See docs/content/schemas.md.`,
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
    case "obb":
      requireExactKeys(value, OBB_KEYS, "obb geometry");
      return {
        type: "obb",
        cx: requireNumber(value["cx"], "geometry.cx"),
        cy: requireNumber(value["cy"], "geometry.cy"),
        width: requireNumber(value["width"], "geometry.width"),
        height: requireNumber(value["height"], "geometry.height"),
        angle: requireNumber(value["angle"], "geometry.angle"),
      };
    case "polygon":
    case "polyline": {
      if (type === "polygon") {
        requireExactKeys(value, POLYGON_KEYS, "polygon geometry");
      } else {
        requireExactKeys(value, POLYLINE_KEYS, "polyline geometry", POLYLINE_OPTIONAL_KEYS);
      }
      const points = value["points"];
      if (!Array.isArray(points)) {
        throw new WireFormatError("geometry.points must be an array");
      }
      // The two share a branch because they share a payload. What they do NOT
      // share is a minimum: the kernel refuses a polygon under three points and
      // a polyline under two, and neither bound is restated here — the wire is
      // what the API sent, and re-deriving a domain rule in the parser is how a
      // mirror starts refusing things the kernel accepts.
      const parsed = points.map((point, index) =>
        requirePoint(point, `geometry.points[${index}]`),
      );
      if (type === "polygon") return { type, points: parsed };
      return {
        type,
        points: parsed,
        visibility:
          "visibility" in value
            ? requireVisibility(value["visibility"], parsed.length)
            : undefined,
      };
    }
    case "polyline_3d":
      return parsePolyline3D(value);
    case "cuboid_3d":
      return parseCuboid3D(value);
    case "mask":
      return parseMask(value);
    case "keypoints":
      return parseKeypoints(value);
    default:
      requireExactKeys(value, CLASSIFICATION_KEYS, "classification_tag geometry");
      return { type: "classification_tag" };
  }
}

function parsePolyline3D(value: Record<string, unknown>): Polyline3DGeometry {
  requireExactKeys(value, POLYLINE_KEYS, "polyline_3d geometry", POLYLINE_OPTIONAL_KEYS);
  const points = value["points"];
  if (!Array.isArray(points)) {
    throw new WireFormatError("geometry.points must be an array");
  }
  const parsed = points.map((point, index) =>
    requirePoint3D(point, `geometry.points[${index}]`),
  );
  return {
    type: "polyline_3d",
    points: parsed,
    visibility:
      "visibility" in value ? requireVisibility(value["visibility"], parsed.length) : undefined,
  };
}

function parseKeypoints(value: Record<string, unknown>): KeypointsGeometry {
  requireExactKeys(value, POLYLINE_KEYS, "keypoints geometry", POLYLINE_OPTIONAL_KEYS);
  const points = value["points"];
  if (!Array.isArray(points) || points.length === 0) {
    throw new WireFormatError("geometry.points must be a non-empty array");
  }
  const parsed = points.map((point, index) => requirePoint(point, `geometry.points[${index}]`));
  return {
    type: "keypoints",
    points: parsed,
    visibility:
      "visibility" in value ? requireVisibility(value["visibility"], parsed.length) : undefined,
  };
}

function parseMask(value: Record<string, unknown>): MaskGeometry {
  requireExactKeys(value, MASK_KEYS, "mask geometry");
  const size = value["size"];
  if (!Array.isArray(size) || size.length !== 2) {
    throw new WireFormatError("geometry.size must be a [height, width] pair");
  }
  return {
    type: "mask",
    size: [requirePixelCount(size[0], "geometry.size[0]"), requirePixelCount(size[1], "geometry.size[1]")],
    counts: requireString(value["counts"], "geometry.counts"),
  };
}

function parseCuboid3D(value: Record<string, unknown>): Cuboid3DGeometry {
  requireExactKeys(value, CUBOID_KEYS, "cuboid_3d geometry");
  return {
    type: "cuboid_3d",
    center: requirePoint3D(value["center"], "geometry.center"),
    size: requirePoint3D(value["size"], "geometry.size"),
    yaw: requireNumber(value["yaw"], "geometry.yaw"),
  };
}

/**
 * One stored annotation, rebuilt field by field.
 *
 * Rebuilding rather than casting is what gives the round-trip test its teeth:
 * re-serializing the result and comparing it to the input proves nothing was
 * dropped, renamed or reordered on the way through.
 */
export function parseAnnotation(value: unknown): StoredAnnotation {
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
    geometry: parseStoredGeometry(value["geometry"]),
    attributes: requireAttributes(value["attributes"], "annotation.attributes"),
    provenance: provenance as Provenance,
    model_ref: requireNullableString(value["model_ref"], "annotation.model_ref"),
    confidence:
      confidence === null ? null : requireNumber(confidence, "annotation.confidence"),
    job_id: requireNullableString(value["job_id"], "annotation.job_id"),
  };
}

/** A whole collection, refused entirely if any member is malformed. */
export function parseAnnotations(value: unknown): StoredAnnotation[] {
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
  allowUndeclaredKeys(value, ATTRIBUTE_REQUIRED_KEYS, "attribute");

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
 * Each member of `geometries` is validated against all nine, not the five the
 * scene draws. Narrowing here would make a whole class list unloadable because of
 * one class nobody was going to draw with.
 *
 * An empty list is refused. The kernel cannot produce one, so a class carrying
 * one is a document this does not understand — and every reader downstream
 * assumes a class has at least one shape, `toolFor` included.
 */
export function parseLabelClass(value: unknown): LabelClass {
  if (!isRecord(value)) {
    throw new WireFormatError("label class must be an object");
  }
  allowUndeclaredKeys(value, LABEL_CLASS_REQUIRED_KEYS, "label class");

  const name = requireString(value["name"], "label class name");
  const geometries = requireStringArray(value["geometries"], `class ${name} geometries`);
  if (geometries.length === 0) {
    throw new WireFormatError(`class ${name} declares no geometries; a class accepts at least one`);
  }
  for (const geometry of geometries) {
    if (!(GEOMETRY_TYPES as readonly string[]).includes(geometry)) {
      throw new WireFormatError(
        `class ${name} declares geometry ${JSON.stringify(geometry)}, which is not a GeometryType — ` +
          `expected one of ${GEOMETRY_TYPES.join(", ")}`,
      );
    }
  }

  const attributes = value["attributes"];
  if (attributes !== undefined && !Array.isArray(attributes)) {
    throw new WireFormatError(`class ${name} attributes must be an array`);
  }
  return {
    name,
    geometries: geometries as LabelClass["geometries"],
    color:
      value["color"] === undefined
        ? null
        : requireNullableString(value["color"], `class ${name} color`),
    attributes: attributes === undefined ? [] : attributes.map(parseAttribute),
    keypoints:
      value["keypoints"] === undefined || value["keypoints"] === null
        ? null
        : parseKeypointSpec(value["keypoints"], name),
  };
}

/**
 * A class's keypoint spec: names in order and the edges between them. Shape only —
 * blank or repeated names and dangling edges are the kernel's to refuse, and a
 * renderer skips an edge whose endpoint an annotation does not carry.
 */
function parseKeypointSpec(value: unknown, className: string): KeypointSpec {
  const what = `class ${className} keypoints`;
  if (!isRecord(value)) {
    throw new WireFormatError(`${what} must be an object or null`);
  }
  allowUndeclaredKeys(value, KEYPOINT_SPEC_REQUIRED_KEYS, what);
  const skeleton = value["skeleton"];
  if (skeleton !== undefined && !Array.isArray(skeleton)) {
    throw new WireFormatError(`${what} skeleton must be an array`);
  }
  return {
    names: requireStringArray(value["names"], `${what} names`),
    skeleton: (skeleton ?? []).map((edge: unknown, index: number) => requireEdge(edge, `${what} skeleton[${index}]`)),
  };
}

function requireEdge(value: unknown, what: string): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new WireFormatError(`${what} must be a pair of point indices`);
  }
  const index = (end: unknown, at: number): number => {
    const parsed = requireNumber(end, `${what}[${at}]`);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new WireFormatError(`${what}[${at}] must be a point index, a whole number from 0`);
    }
    return parsed;
  };
  return [index(value[0], 0), index(value[1], 1)];
}

/** One version of the labeling contract, classes in the order it declares them. */
export function parseSchema(value: unknown): AnnotationSchema {
  if (!isRecord(value)) {
    throw new WireFormatError("schema must be an object");
  }
  allowUndeclaredKeys(value, SCHEMA_REQUIRED_KEYS, "schema");
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
    provenance:
      value["provenance"] === undefined
        ? null
        : requireNullableString(value["provenance"], "schema.provenance"),
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
  allowUndeclaredKeys(value, ASSET_KEYS, "asset");
  const id = requireString(value["id"], "asset.id");
  if (value["modality"] === "point_cloud") return { id, width: 0, height: 0, modality: "point_cloud" };
  if (value["width"] === null || value["height"] === null) {
    throw new WireFormatError(
      `asset ${id} has no measured width and height, so there is no pixel frame to ` +
        `annotate in — an unmeasured asset needs the ingest pipeline to run first`,
    );
  }
  return {
    id,
    width: requirePixelCount(value["width"], "asset.width"),
    height: requirePixelCount(value["height"], "asset.height"),
  };
}

/**
 * A camera calibration, as `CalibrationOut` sends it. Input-only, so undeclared
 * keys are ignored (rule 4).
 *
 * A distortion model this build does not know is refused rather than dropped:
 * projecting through a lens it cannot model would draw a confident wrong line.
 */
export function parseCalibration(value: unknown): Calibration {
  if (!isRecord(value)) {
    throw new WireFormatError("calibration must be an object");
  }
  allowUndeclaredKeys(value, ["intrinsics", "extrinsics", "distortion"], "calibration");
  const intrinsics = value["intrinsics"];
  if (!isRecord(intrinsics)) {
    throw new WireFormatError("calibration.intrinsics must be an object");
  }
  allowUndeclaredKeys(intrinsics, INTRINSICS_KEYS, "calibration.intrinsics");
  const number = (key: string): number =>
    requireNumber(intrinsics[key], `calibration.intrinsics.${key}`);
  const extrinsics = value["extrinsics"];
  if (!isRecord(extrinsics)) {
    throw new WireFormatError("calibration.extrinsics must be an object");
  }
  allowUndeclaredKeys(extrinsics, ["rotation", "translation"], "calibration.extrinsics");
  const rotation = extrinsics["rotation"];
  if (!Array.isArray(rotation) || rotation.length !== 3) {
    throw new WireFormatError("calibration.extrinsics.rotation must be three rows");
  }
  return {
    intrinsics: {
      fx: number("fx"),
      fy: number("fy"),
      cx: number("cx"),
      cy: number("cy"),
      skew: number("skew"),
      width: requirePixelCount(intrinsics["width"], "calibration.intrinsics.width"),
      height: requirePixelCount(intrinsics["height"], "calibration.intrinsics.height"),
    },
    extrinsics: {
      rotation: [
        requirePoint3D(rotation[0], "calibration.extrinsics.rotation[0]"),
        requirePoint3D(rotation[1], "calibration.extrinsics.rotation[1]"),
        requirePoint3D(rotation[2], "calibration.extrinsics.rotation[2]"),
      ],
      translation: requirePoint3D(extrinsics["translation"], "calibration.extrinsics.translation"),
    },
    distortion: parseDistortion(value["distortion"]),
  };
}

function parseDistortion(value: unknown): Calibration["distortion"] {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new WireFormatError("calibration.distortion must be an object or null");
  }
  allowUndeclaredKeys(value, DISTORTION_KEYS, "calibration.distortion");
  if (value["model"] !== "plumb_bob") {
    throw new WireFormatError(
      `calibration.distortion.model ${JSON.stringify(value["model"])} is not one this build ` +
        `can project through`,
    );
  }
  const number = (key: string): number =>
    requireNumber(value[key], `calibration.distortion.${key}`);
  return {
    model: "plumb_bob",
    k1: number("k1"),
    k2: number("k2"),
    p1: number("p1"),
    p2: number("p2"),
    k3: number("k3"),
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
export function toAnnotationCreate(annotation: Annotation | ScanAnnotation): AnnotationCreate {
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
export function toAnnotationUpdate(annotation: Annotation | ScanAnnotation): AnnotationUpdate {
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
