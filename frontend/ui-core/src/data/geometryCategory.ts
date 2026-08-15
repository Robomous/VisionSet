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
 * A class's geometry set, as one phrase for a row, a badge or a refusal.
 *
 * One spelling, product-wide, for the reason `classColor` is one: a class list, a
 * reassignment menu and a schema row all name the same set, and three joins would
 * be three chances to render `bbox,polygon` beside `bbox, polygon` beside
 * `bbox or polygon`.
 *
 * "or" rather than a comma at the end, because the set is a *choice* — an
 * annotation carries one of them, never several — and a comma list reads as
 * things a class has all of.
 *
 * The order is the caller's, which for anything off the wire is the kernel's own
 * sorted order. Nothing re-sorts here: a surface that grouped by category would
 * hand them over grouped, and this would silently undo it.
 */
export function formatGeometries(geometries: readonly GeometryType[]): string {
  if (geometries.length <= 2) return geometries.join(" or ");
  return `${geometries.slice(0, -1).join(", ")} or ${geometries[geometries.length - 1]}`;
}
