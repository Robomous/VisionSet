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
 * the API publishes; `Geometry` has three variants, because that is what an
 * annotation can actually carry. Naming `polyline` or `keypoints` is legal in a
 * schema and refused at the annotation, by the kernel (`UNSUPPORTED_GEOMETRY`)
 * and by `parseGeometry` here. See `docs/schemas.md`.
 *
 * #40 answered the question this docstring used to leave open — how a locally
 * drawn annotation carries identity when `AnnotationCreate` has no `id` field.
 * It mints a client-side uuid v4 into the ordinary `id`, and `toAnnotationCreate`
 * drops it: the provisional value is the document's key and the selection's key
 * for the life of the session, and it never travels. See `state/document.ts`.
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

/** The vocabulary a `LabelClass` declares. Eight names; three have a model. */
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
  "polygon",
] as const satisfies readonly GeometryType[];

/**
 * What an `Attribute` may hold — the kernel's `Attribute.kind` Literal.
 *
 * A `Literal` rather than an enum on the Python side, spelled inline in the wire
 * model for #27's reason, so nothing structural ties this list to that one.
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

/** A whole-asset tag: a class with no coordinates. */
export interface ClassificationGeometry {
  readonly type: "classification_tag";
}

/** Every shape an annotation can carry, discriminated on `type`. */
export type Geometry = BboxGeometry | PolygonGeometry | ClassificationGeometry;

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
 * One labelable class, bound to **one** geometry. Mirrors `LabelClassBody`.
 *
 * `geometry` is singular, and that is the rule an annotator is built around:
 * picking a class picks a tool. `color` is the kernel's own field — a renderer
 * choosing its own palette when it is null is a rendering decision, not a
 * document one.
 *
 * `geometry` is a `GeometryType`, all eight, not just the carryable three. A
 * schema may legally declare `polyline`; an annotation may not carry one. Keeping
 * the wide type here is what lets a class list load intact and the refusal happen
 * where a user can be told about it.
 */
export interface LabelClass {
  readonly name: string;
  readonly geometry: GeometryType;
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
 */
export interface AnnotationSchema {
  readonly project_id: string;
  readonly version: number;
  readonly classes: readonly LabelClass[];
  readonly description: string | null;
  readonly created_at: string | null;
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
 * transform belongs to the adapter (#47); the document only ever holds native
 * pixels.
 */
export interface AssetDescriptor {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}
