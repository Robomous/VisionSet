/**
 * The wire contract, mirrored exactly.
 *
 * These are not "types like the backend's" — they are the shapes the API sends
 * and takes, spelled in TypeScript. A host hands the annotator exactly what
 * `GET /jobs/{id}/assets/{asset_id}/annotations` returned, and hands back
 * exactly what `POST`/`PATCH /jobs/{id}/annotations` accept. There is no
 * mapping layer, and that is the decision rather than an omission: a second
 * spelling of twenty fields is free to drift, and every host would pay the
 * conversion regardless of who wrote it. `snake_case` fields, geometry nested
 * under its own key, points as `[x, y]` pairs — all of it is the wire's, not a
 * TypeScript convention.
 *
 * The names are the *domain's* (`BboxGeometry`), not the server's (`BboxBody`):
 * `Body` is a FastAPI artifact and `Out` means nothing in a browser. Only the
 * shape is copied.
 *
 * Invariants shared with the Python kernel:
 * - every stored annotation carries a mandatory UUID `id` — identity is NEVER
 *   an array index;
 * - coordinates are ALWAYS in the asset's native reference frame (pixels for
 *   images) and are NEVER normalized. Normalization is an exporter's concern,
 *   at the boundary, never the engine's.
 *
 * Two vocabularies, one union — the kernel's own split, kept: `GeometryType`
 * names eight geometries, because that is what a `LabelClass` declares and what
 * the API publishes; `Geometry` has four variants, because that is what this
 * engine draws. Naming `mask` or `keypoints` is legal in a schema and refused at
 * the annotation, by the kernel (`UNSUPPORTED_GEOMETRY`) and by `parseGeometry`
 * here. See `docs/content/schemas.md`.
 *
 * Two more variants, `polyline_3d` and `cuboid_3d`, are carried and never
 * edited: `StoredGeometry` admits them, `parseAnnotation` parses them, and
 * `documentFromWire` leaves them out of the scene, so a job holding one loads,
 * and its 3D labels are never sent back changed or deleted. A host may draw
 * them read-only through `projectLabels3D`, against the asset's calibration.
 *
 * A locally drawn annotation carries identity even though `AnnotationCreate` has
 * no `id` field: it mints a client-side uuid v4 into the ordinary `id`, and
 * `toAnnotationCreate` drops it. The provisional value is the document's key and
 * the selection's key for the life of the session, and it never travels. See
 * `state/document.ts`.
 */

/**
 * Every geometry the domain can address — the kernel's `GeometryType` StrEnum.
 *
 * The array is the source and the union is read off it, so the two cannot
 * disagree and no exhaustiveness assertion is needed to prove it.
 */
export const GEOMETRY_TYPES = [
  "bbox",
  "classification_tag",
  "cuboid_3d",
  "keypoints",
  "mask",
  "polygon",
  "polyline",
  "polyline_3d",
] as const;

/** The vocabulary a `LabelClass` declares. Eight names; six have a model. */
export type GeometryType = (typeof GEOMETRY_TYPES)[number];

/**
 * The subset an `Annotation` can carry — the kernel's `IMPLEMENTED_GEOMETRIES`.
 *
 * `satisfies` keeps every entry a real `GeometryType`; that both lists still
 * agree with the kernel's is asserted at runtime in `wire.test.ts`, against a
 * fixture the kernel produced.
 */
export const IMPLEMENTED_GEOMETRY_TYPES = [
  "bbox",
  "classification_tag",
  "cuboid_3d",
  "polygon",
  "polyline",
  "polyline_3d",
] as const satisfies readonly GeometryType[];

/** The carryable geometries this engine draws: every member of `Geometry`. */
export const DRAWN_GEOMETRY_TYPES = [
  "bbox",
  "classification_tag",
  "polygon",
  "polyline",
] as const satisfies readonly (typeof IMPLEMENTED_GEOMETRY_TYPES)[number][];

/** Whether a stored geometry `type` is one the scene holds, rather than one it carries past. */
export function isDrawnGeometryType(type: string): type is Geometry["type"] {
  return (DRAWN_GEOMETRY_TYPES as readonly string[]).includes(type);
}

/**
 * What an `Attribute` may hold — the kernel's `Attribute.kind` Literal.
 *
 * A `Literal` rather than an enum on the Python side, spelled inline in the wire
 * model, so nothing structural ties this list to that one.
 * `wire.test.ts` asserts it against the fixture's `attribute_kinds`.
 */
export const ATTRIBUTE_KINDS = ["boolean", "number", "select", "string"] as const;

/** The four kinds an attribute may declare. */
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];

/** One vertex, `[x, y]`, in the asset's own pixels. A pair, never `{x, y}`. */
export type Point = readonly [number, number];

/** What an attribute may hold, in the order pydantic's smart union tries. */
export type AttributeValue = boolean | number | string;

/** Who made this annotation. */
export type Provenance = "human" | "model" | "import";

/** An axis-aligned rectangle: top-left corner plus size, in asset pixels. */
export interface BboxGeometry {
  readonly type: "bbox";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A closed polygon of at least three points. The closing edge is implicit. */
export interface PolygonGeometry {
  readonly type: "polygon";
  readonly points: readonly Point[];
}

/**
 * An open path of at least two points, in order. Nothing joins the ends.
 *
 * Structurally identical to `PolygonGeometry`, and deliberately a separate type
 * rather than a flag on it: the closing edge is the whole difference, and a
 * renderer that took a boolean would eventually read it as `false` by accident
 * and draw a lane closed.
 */
export interface PolylineGeometry {
  readonly type: "polyline";
  readonly points: readonly Point[];
  /**
   * One state per point, or `undefined` when nobody has said — the wire omits the
   * key then, and `JSON.stringify` drops an `undefined` value, so an untouched
   * polyline goes back out exactly as it came in. Required rather than optional so
   * every edit that rebuilds a polyline has to decide what happens to it.
   */
  readonly visibility: readonly VertexVisibility[] | undefined;
}

/**
 * The kernel's `VertexVisibility`: COCO's keypoint integers. `UNLABELED` is
 * drawn as visible but is not a judgement that the vertex was seen.
 */
export const VERTEX_VISIBILITY = { UNLABELED: 0, OCCLUDED: 1, VISIBLE: 2 } as const;

export type VertexVisibility = (typeof VERTEX_VISIBILITY)[keyof typeof VERTEX_VISIBILITY];

/** A whole-asset tag: a class with no coordinates. */
export interface ClassificationGeometry {
  readonly type: "classification_tag";
}

/** One 3D vertex, `[x, y, z]`, in metres in the camera's sensor frame. */
export type Point3D = readonly [number, number, number];

/**
 * An open 3D path in the sensor frame. Carried, never edited: it has no pixel
 * coordinates without its asset's calibration, and `projectLabels3D` is the only
 * way it reaches the canvas — as a read-only overlay outside the document.
 */
export interface Polyline3DGeometry {
  readonly type: "polyline_3d";
  readonly points: readonly Point3D[];
  readonly visibility: readonly VertexVisibility[] | undefined;
}

/**
 * A box in the sensor frame, in metres: its centre, `[length, width, height]`,
 * and a yaw in radians about the sensor's +y (down) axis within `[-π, π]`. The
 * heading — the `length` axis — is `(cos yaw, 0, −sin yaw)`. Carried, never
 * edited, and drawn only through `projectLabels3D`, as `polyline_3d` is.
 */
export interface Cuboid3DGeometry {
  readonly type: "cuboid_3d";
  readonly center: Point3D;
  readonly size: Point3D;
  readonly yaw: number;
}

/** Pinhole intrinsics in pixels, and the image size they were measured at. Mirrors `CameraIntrinsicsOut`. */
export interface CameraIntrinsics {
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
  readonly skew: number;
  readonly width: number;
  readonly height: number;
}

/** Sensor to rig, `p_rig = rotation @ p_sensor + translation`. Mirrors `SensorExtrinsicsOut`. */
export interface SensorExtrinsics {
  readonly rotation: readonly [Point3D, Point3D, Point3D];
  readonly translation: Point3D;
}

/** OpenCV's radial-tangential lens distortion. Mirrors `DistortionOut`. */
export interface PlumbBobDistortion {
  readonly model: "plumb_bob";
  readonly k1: number;
  readonly k2: number;
  readonly p1: number;
  readonly p2: number;
  readonly k3: number;
}

/** One camera's calibration, in OpenCV's sensor frame. Mirrors `CalibrationOut`. */
export interface Calibration {
  readonly intrinsics: CameraIntrinsics;
  readonly extrinsics: SensorExtrinsics;
  readonly distortion: PlumbBobDistortion | null;
}

/** Every shape an annotation can carry, discriminated on `type`. */
export type Geometry =
  | BboxGeometry
  | PolygonGeometry
  | PolylineGeometry
  | ClassificationGeometry;

/** Every geometry the wire can carry, drawn or not. */
export type StoredGeometry = Geometry | Polyline3DGeometry | Cuboid3DGeometry;

/** One stored annotation as the wire sends it, whether or not the scene can hold it. */
export type StoredAnnotation = Omit<Annotation, "geometry"> & {
  readonly geometry: StoredGeometry;
};

/** Whether the scene holds this annotation; `false` only for one it carries past. */
export function isDrawnAnnotation(annotation: StoredAnnotation): annotation is Annotation {
  return isDrawnGeometryType(annotation.geometry.type);
}

/** One stored annotation, in the asset's own pixel frame. Mirrors `AnnotationOut`. */
export interface Annotation {
  readonly id: string;
  readonly asset_id: string;
  readonly label_class: string;
  readonly schema_version: number;
  readonly geometry: Geometry;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly provenance: Provenance;
  readonly model_ref: string | null;
  readonly confidence: number | null;
  /**
   * Which round of work produced this label, or `null` when nothing recorded it.
   *
   * Read-only here, and absent from both projections below for the reason
   * `schema_version` is: the service stamps it with the job doing the writing,
   * so a field a client could set would be one it never observes.
   *
   * `null` is a real answer rather than a gap in this build: a label written
   * before the column existed, whose asset belonged to more than one job, could
   * not be attributed by the migration — and guessing would have put a
   * confident wrong answer where an honest absent one belongs.
   */
  readonly job_id: string | null;
}

/**
 * One annotation to store. Mirrors `AnnotationCreate`.
 *
 * No `id` and no `schema_version`: the service mints the first and stamps the
 * second with the version its batch pinned, so a field here would be one a
 * client could set and never observe.
 */
export interface AnnotationCreate {
  readonly asset_id: string;
  readonly label_class: string;
  readonly geometry: Geometry;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly provenance: Provenance;
  readonly model_ref: string | null;
  readonly confidence: number | null;
}

/**
 * One stored annotation, replaced whole. Mirrors `AnnotationUpdate`.
 *
 * Addressed by `id` and by nothing else. No `asset_id`: the stored one wins, so
 * moving a label to another asset is a delete and an add, not an edit.
 */
export interface AnnotationUpdate {
  readonly id: string;
  readonly label_class: string;
  readonly geometry: Geometry;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly provenance: Provenance;
  readonly model_ref: string | null;
  readonly confidence: number | null;
}

/**
 * A typed attribute on a label class. Mirrors `AttributeBody`.
 *
 * `required` and `default` are independent: a required attribute with a default
 * is an ordinary, useful thing — the first says an annotation must carry a value,
 * the second says which one a surface should offer.
 */
export interface Attribute {
  readonly name: string;
  readonly kind: AttributeKind;
  readonly required: boolean;
  readonly options: readonly string[] | null;
  readonly default: AttributeValue | null;
}

/**
 * One labelable class and the geometries it accepts. Mirrors `LabelClassBody`.
 *
 * `geometries` is a **set**, non-empty, and the wire sends it sorted. Picking a
 * class therefore no longer picks a tool: it constrains which tools are on
 * offer, and `toolFor` resolves the rest against what the host has active.
 * `color` is the kernel's own field — a renderer choosing its own palette when
 * it is null is a rendering decision, not a document one.
 *
 * The members are `GeometryType`, all eight, not just the carryable four. A
 * schema may legally declare `mask`; an annotation may not carry one. Keeping the
 * wide type here is what lets a class list load intact and the refusal happen
 * where a user can be told about it.
 */
export interface LabelClass {
  readonly name: string;
  readonly geometries: readonly GeometryType[];
  readonly color: string | null;
  readonly attributes: readonly Attribute[];
}

/**
 * One version of a project's labeling contract. Mirrors `SchemaVersionOut`.
 *
 * `version` is kept because a locally created annotation has to put *something*
 * in `schema_version`, and the schema in hand is the only honest answer. It is
 * provisional: the kernel stamps the version its batch pinned, and
 * `toAnnotationCreate` drops the field entirely so the guess never travels.
 *
 * `classes` order is the schema's own and is preserved — it is authored, and a
 * class list is what a surface renders as a palette.
 *
 * `description` and `created_at` are carried rather than dropped, because this is
 * a mirror and not a projection: `SchemaVersionOut` has them, so this does. The
 * engine reads neither — they are a version's commit message and the moment it
 * was published — but a host rendering "you are annotating against version 3,
 * published Tuesday" should not have to fetch the same object twice to say so.
 * Both are `null` for a version published before they existed.
 *
 * `provenance` is carried for the same reason and read by the engine just as
 * little: it says whether a version was designed deliberately (`curated`) or fell
 * out of adding a class mid-job (`annotation`), so a host can collapse the runs
 * in a version history. It is `null` for a version published before it existed
 * and for any writer that declined to say, and it is deliberately typed as a bare
 * `string` rather than a union of the two spellings — the engine never branches
 * on it, and a closed union here would make a *newer* server's third value a
 * parse failure in an older annotator, which is exactly rule 4's hazard.
 */
export interface AnnotationSchema {
  readonly project_id: string;
  readonly version: number;
  readonly classes: readonly LabelClass[];
  readonly description: string | null;
  readonly created_at: string | null;
  readonly provenance: string | null;
}

/**
 * The asset being annotated, reduced to the frame its geometry is measured in.
 *
 * A projection of `AssetOut`, not a mirror, and the three fields are the three an
 * engine can use: everything else on that model — content hash, format, frame
 * provenance, thumbnail hash — is about where the bytes came from, which is the
 * host's business.
 *
 * `width`/`height` are the asset's **native** pixels. `AssetOut` declares them
 * `int | None` because a pre-pipeline row has never been measured, and
 * `parseAssetDescriptor` refuses that case: annotation geometry is native and
 * never normalized, so an asset with no known frame has nothing to be native to.
 *
 * They are emphatically **not** the size of the image a renderer displays. That
 * is the same trap `get_asset_image` publishes four numbers to avoid — a preview
 * is capped on its long edge, and coordinates measured on it and submitted
 * unscaled are individually plausible and uniformly wrong. The screen↔image
 * transform belongs to the adapter; the document only ever holds native pixels.
 *
 * A point-cloud scan has no pixel frame at all: its descriptor says
 * `modality: "point_cloud"` and carries `0 × 0`, and no pixel geometry is ever
 * drawn on it.
 */
export interface AssetDescriptor {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly modality?: "point_cloud";
}
