/**
 * Which family of work a geometry belongs to — a presentation grouping, and
 * nothing the kernel has ever heard of.
 *
 * ## Why it lives here and not beside `GeometryType`
 *
 * The alternative home is the kernel — category metadata declared next to the
 * enum — which would give docs, MCP and the UI one source of truth and make a new
 * geometry categorise itself where it is named. It was declined:
 * "Robotics and AD" is a market segment, not a domain fact, and the kernel has
 * refused exactly this kind of value before (`DatasetChange.operation` is a plain
 * `str` so a log outlives the build that wrote it). A category is a claim about
 * who buys the product, and it can be renamed on a Tuesday; the domain cannot.
 *
 * The cost of that — a geometry added to the enum with no entry in the map is a
 * silent gap, the way every hand-mirrored table in this repo has been — is the
 * reason for the `satisfies` below rather than a reason to
 * reconsider. `GEOMETRY_CATEGORY` is declared **total over the generated union**,
 * so a ninth `GeometryType` arriving from the wire fails `tsc` in this file until
 * somebody says where it goes. The gap is paid for by type-check, not by
 * discipline, which is the difference between this table and the mirrors
 * `data/capabilities.ts` was written to delete.
 *
 * ## What it does not touch
 *
 * Exporter capability declarations (`Exporter.supported_geometries`,
 * `degraded_geometries`) and the MCP tool descriptions are untouched, and that is
 * a decision rather than an omission: **a format's capability is per geometry, not
 * per category**. A lane exporter supports `polyline`; it does not support
 * "Robotics and AD", and saying so would be a claim about `cuboid_3d` that no
 * exporter has made.
 *
 * Renaming a category is a string change in this file, which is most of the
 * argument for the file existing.
 */

import type { components } from "../generated/api.js";

/**
 * The wire's whole geometry vocabulary, all eight members.
 *
 * Not re-exported: `screens/queries.ts` already publishes this exact alias off
 * this exact generated schema, and two public spellings of one type is the thing
 * a `satisfies`-checked table exists to avoid. Both resolve to the same type, so
 * a caller holding the published one passes straight into `groupGeometries`.
 */
type GeometryType = components["schemas"]["GeometryType"];

/**
 * The families, and there are two.
 *
 * A union rather than a `string`, because these are chosen by this build alone —
 * no foreign writer produces one, nothing round-trips one, and the set grows
 * deliberately. That is the same test `SourceKind` passes and `DatasetChange`
 * .`operation` fails, applied to a value that never leaves the client at all.
 */
export type GeometryCategory = "Basic Computer Vision" | "Robotics and AD";

/**
 * Category order, and it is the order a picker renders them in.
 *
 * Declared rather than derived from the map's insertion order: object key order
 * is a property of how somebody typed the literal, and a picker's section order
 * is a design decision. "Basic Computer Vision" leads because it holds every
 * geometry a first-time user will pick.
 */
export const GEOMETRY_CATEGORIES = [
  "Basic Computer Vision",
  "Robotics and AD",
] as const satisfies readonly GeometryCategory[];

/**
 * Every geometry the wire declares, and where it sits.
 *
 * **Total by `satisfies`, and that is the whole enforcement.** Adding a member to
 * `GeometryType` and regenerating the client breaks this file; removing one from
 * this map breaks it too. Neither can be committed past a `tsc` run.
 *
 * The categorisation covers the four unimplemented members as well as the four
 * writable ones, because the point at which a geometry gets a category is the
 * point at which it is *named*, not the point at which it reaches a picker —
 * otherwise the map is only ever total by coincidence.
 *
 * `mask` and `keypoints` are the two the issue did not name. Both go to Basic
 * Computer Vision: segmentation and pose are ordinary image tasks, and what puts
 * a geometry in the other family is a **sensor or a scene the camera alone does
 * not give you** — a lane that continues past the frame, a box with a depth.
 */
export const GEOMETRY_CATEGORY = {
  bbox: "Basic Computer Vision",
  polygon: "Basic Computer Vision",
  mask: "Basic Computer Vision",
  keypoints: "Basic Computer Vision",
  classification_tag: "Basic Computer Vision",
  polyline: "Robotics and AD",
  cuboid_3d: "Robotics and AD",
  polyline_3d: "Robotics and AD",
} as const satisfies Record<GeometryType, GeometryCategory>;

/** One rendered section: a heading and the geometries under it. */
export interface GeometryGroup {
  readonly category: GeometryCategory;
  readonly geometries: readonly GeometryType[];
}

/**
 * The offered geometries, grouped — the one grouping spelling in the client.
 *
 * Takes the offerable list rather than reading a flag off the map, because
 * *which geometries a surface offers* is that surface's question and the two
 * differ: the schema editor offers what an `Annotation` can carry, the annotator's
 * palette offers what a schema declared, and neither is "everything categorised".
 * This function answers only "in what order, under what headings".
 *
 * **A category with no offered member produces no group**, so a heading never
 * stands over nothing. That is what makes the same call correct on a picker
 * showing four geometries and on one showing a single `bbox`.
 *
 * Order within a group is the caller's, preserved. Order of the groups is
 * `GEOMETRY_CATEGORIES`.
 */
export function groupGeometries(
  offered: readonly GeometryType[],
): readonly GeometryGroup[] {
  return GEOMETRY_CATEGORIES.map((category) => ({
    category,
    geometries: offered.filter((geometry) => GEOMETRY_CATEGORY[geometry] === category),
  })).filter((group) => group.geometries.length > 0);
}

/**
 * What each geometry is **called on screen**, which is not what it is called on
 * the wire.
 *
 * `GeometryType`'s members are the kernel's identifiers — `bbox` because that is
 * the discriminator every payload carries, `classification_tag` because that is
 * what the variant is. Neither is a word to show somebody. Until this map existed
 * the product had **two vocabularies**: the tool strip's private `TOOL_LABELS`
 * said `Box`, and every other surface — class rows, the reassignment menu, the
 * add-a-class dialog's checkboxes and prose, the schema editor's badges, the
 * project summary — printed the enum. So one thing was `Box` on the left of the
 * canvas and `bbox` on the right, and a tag class's row spent about 110px of a
 * 248px row saying `classification_tag`.
 *
 * **Lowercase**, because the same word is used two ways and only lowercase reads
 * correctly in both: as a chip in a dense row (`box · polygon`) and inside a
 * sentence (*"Publishing adds polygon to it"*). A control that wants a capital
 * — the tool strip's `Box (1)` — capitalises at the point of use, so there is one
 * source and one transform rather than two lists free to drift apart again.
 *
 * Total over the union by `satisfies`, exactly as `GEOMETRY_CATEGORY` above, so a
 * ninth member fails the build until somebody names it. The four with no
 * implementation are named too: a schema may legally declare `mask`, and the
 * surface that has to refuse it should refuse it in words.
 */
export const GEOMETRY_LABELS = {
  bbox: "box",
  polygon: "polygon",
  polyline: "polyline",
  classification_tag: "tag",
  mask: "mask",
  keypoints: "keypoints",
  cuboid_3d: "3D box",
  polyline_3d: "3D polyline",
} as const satisfies Record<GeometryType, string>;

/** What to call this geometry on screen. Never the wire value. */
export function geometryLabel(geometry: GeometryType): string {
  return GEOMETRY_LABELS[geometry];
}

/**
 * A class's geometry set, as one phrase for a row, a badge or a refusal.
 *
 * One spelling, product-wide, for the reason `classColor` is one: a class list, a
 * reassignment menu and a schema row all name the same set, and three joins would
 * be three chances to render `box,polygon` beside `box, polygon` beside
 * `box or polygon`.
 *
 * **A middot, not "or".** The set is a choice — an annotation carries one of them,
 * never several — and a comma list would read as things a class has all of. "or"
 * says that correctly and costs four characters in a row where the class *name*
 * is what those characters come out of. `·` is what a set reads as at this
 * density, and the row has no room to be polite.
 *
 * The order is the caller's, which for anything off the wire is the kernel's own
 * sorted order. Nothing re-sorts here: a surface that grouped by category would
 * hand them over grouped, and this would silently undo it.
 */
export function formatGeometries(geometries: readonly GeometryType[]): string {
  return geometries.map(geometryLabel).join(" · ");
}

/**
 * What each geometry is called **in the plural**, for a sentence about a run.
 *
 * `GEOMETRY_LABELS` is the singular, tuned for a chip and for "adds polygon to
 * it". A pre-label plan and a model card both say what a model *writes* — "boxes
 * or polygons" — and an "s" appended to the singular gets `boxs`. Kept beside the
 * singular so the two cannot name a member apart, and total over the union by
 * the same `satisfies`.
 */
export const GEOMETRY_PLURALS = {
  bbox: "boxes",
  polygon: "polygons",
  polyline: "polylines",
  mask: "masks",
  keypoints: "keypoints",
  classification_tag: "tags",
  cuboid_3d: "3D cuboids",
  polyline_3d: "3D polylines",
} as const satisfies Record<GeometryType, string>;

/**
 * How the shapes a model writes read: "boxes or polygons".
 *
 * Takes `readonly string[]` rather than the union on purpose: `produces` is
 * a list a newer server may extend, and what it says a run will write is
 * exactly what the reader needs, so an unknown member passes through raw
 * rather than being dropped. "or", not the middot — a run writes one shape per
 * label, and this goes inside a sentence where the middot has no room to mean.
 */
export function producesProse(produces: readonly string[]): string {
  return produces.map((one) => (GEOMETRY_PLURALS as Record<string, string>)[one] ?? one).join(" or ");
}
