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
 * Left for #40, the document model: a locally drawn annotation has no server
 * `id` — `AnnotationCreate` has no such field, because the service mints it. How
 * a draft carries identity between the first click and the response is the
 * document's question, not this file's.
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
