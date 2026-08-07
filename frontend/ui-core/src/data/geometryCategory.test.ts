/**
 * The category map, and the two halves of the claim it makes.
 *
 * **Totality is a type-level fact and is proven there.** `GEOMETRY_CATEGORY` is
 * declared `satisfies Record<GeometryType, GeometryCategory>`, so a member added
 * to the generated union — or an entry deleted from the map — fails `tsc` before
 * any of these run. The assignability assertion below is the second statement of
 * the same claim, held in a file that does not move when somebody edits the
 * declaration: replacing the `satisfies` with a `Partial<…>` or dropping it
 * altogether still fails here.
 *
 * What it cannot be is a runtime test enumerating eight names. `GeometryType`
 * has no runtime enumeration in the client (`oneOf` closes over its list), so
 * writing the eight out here would be a hand-mirrored table asserting a
 * hand-mirrored table — the exact thing the `satisfies` exists to delete. What
 * the runtime half checks instead is the direction that *is* checkable: every
 * key of the map is a string the wire accepts as a geometry.
 */

import { describe, expect, it } from "vitest";

import { checkGeometryType } from "../generated/checks";
import type { GeometryType } from "../screens/queries";
import { firstMismatch } from "./check";
import {
  GEOMETRY_CATEGORIES,
  GEOMETRY_CATEGORY,
  groupGeometries,
  type GeometryCategory,
} from "./geometryCategory";

describe("the category map", () => {
  it("is total over the wire's geometry union", () => {
    // The assertion is the annotation, not the expectation: a missing key is a
    // compile error on this line. The `expect` exists so the local is used.
    const total: Record<GeometryType, GeometryCategory> = GEOMETRY_CATEGORY;
    expect(Object.keys(total).length).toBeGreaterThan(0);
  });

  it("categorises nothing the wire does not call a geometry", () => {
    for (const geometry of Object.keys(GEOMETRY_CATEGORY)) {
      expect(firstMismatch(checkGeometryType, geometry)).toBeNull();
    }
  });

  it("uses only the declared categories", () => {
    for (const category of Object.values(GEOMETRY_CATEGORY)) {
      expect(GEOMETRY_CATEGORIES).toContain(category);
    }
  });

  it("puts the reserved 3D members with the lanes they will ship beside", () => {
    // The two the kernel names and nothing implements. #375's whole reason for
    // categorising before a geometry reaches a picker: the category is decided
    // where the name is, so the map is never total only by coincidence.
    expect(GEOMETRY_CATEGORY.cuboid_3d).toBe("Robotics and AD");
    expect(GEOMETRY_CATEGORY.polyline_3d).toBe("Robotics and AD");
    expect(GEOMETRY_CATEGORY.polyline).toBe("Robotics and AD");
  });
});

describe("grouping what a surface offers", () => {
  /** Every geometry the map knows, derived — never a second list. */
  const all = Object.keys(GEOMETRY_CATEGORY) as readonly GeometryType[];

  it("returns the categories in declaration order", () => {
    // Deliberately self-referential: this pins that the helper *follows*
    // `GEOMETRY_CATEGORIES`, not what that order should be. Reversing the
    // constant leaves this green — which order a picker reads down in is a
    // design decision, and it is pinned where somebody sees it, by the document
    // -position assertion in `screens.test.tsx`.
    expect(groupGeometries(all).map((group) => group.category)).toEqual([...GEOMETRY_CATEGORIES]);
  });

  it("places every offered geometry in exactly one group", () => {
    const placed = groupGeometries(all).flatMap((group) => group.geometries);
    expect([...placed].sort()).toEqual([...all].sort());
  });

  it("keeps the caller's order inside a group", () => {
    // The schema editor's order is a design decision — `bbox` first because it is
    // what most people reach for — and grouping must not resort it.
    const grouped = groupGeometries(["classification_tag", "bbox", "polygon"]);
    expect(grouped[0]?.geometries).toEqual(["classification_tag", "bbox", "polygon"]);
  });

  it("omits a category with nothing offered under it", () => {
    // A heading over nothing is worse than no heading: it advertises a family the
    // surface cannot actually offer.
    expect(groupGeometries(["bbox", "polygon"])).toEqual([
      { category: "Basic Computer Vision", geometries: ["bbox", "polygon"] },
    ]);
    expect(groupGeometries(["polyline"])).toEqual([
      { category: "Robotics and AD", geometries: ["polyline"] },
    ]);
  });

  it("groups nothing when nothing is offered", () => {
    expect(groupGeometries([])).toEqual([]);
  });
});
