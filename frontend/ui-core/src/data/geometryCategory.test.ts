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
  GEOMETRY_LABELS,
  GEOMETRY_PLURALS,
  formatGeometries,
  geometryLabel,
  groupGeometries,
  producesProse,
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
    // The two the kernel names and nothing implements. The reason for categorising
    // before a geometry reaches a picker: the category is decided
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


describe("what a geometry is called on screen", () => {
  it("is total over the wire's geometry union", () => {
    // Same shape as the category map's own claim above, and for the same reason:
    // the `satisfies` is the proof, this is the copy of it that does not move
    // when somebody edits the declaration.
    const total: Record<GeometryType, string> = GEOMETRY_LABELS;
    expect(Object.keys(total).length).toBeGreaterThan(0);
  });

  it("names nothing the wire does not call a geometry", () => {
    for (const geometry of Object.keys(GEOMETRY_LABELS)) {
      expect(firstMismatch(checkGeometryType, geometry)).toBeNull();
    }
  });

  it("does not print the wire value where the two differ", () => {
    // **The assertion that matters.** A map whose every entry equalled its key
    // would type-check, satisfy totality, and be exactly the defect this exists
    // to remove — the interface showing users identifiers. These are the two the
    // kernel spells for itself rather than for a person, so they are the two that
    // prove the map is doing work.
    expect(geometryLabel("bbox")).toBe("box");
    expect(geometryLabel("classification_tag")).toBe("tag");
  });

  it("never starts with a capital, because the same word goes in a sentence", () => {
    // A capital reads fine as a chip and wrong mid-sentence ("Publishing adds
    // Polygon to it"). The tool strip capitalises at its own control instead.
    //
    // **Starts** lowercase rather than *is* lowercase, and the difference is a
    // real one this caught: `3D box` is an acronym, and a rule demanding the
    // whole string be lowercase would have forced `3d box`, which is wrong in
    // every position. Only the first letter is a sentence-position question.
    for (const label of Object.values(GEOMETRY_LABELS)) {
      expect(label).toBe(label.charAt(0).toLowerCase() + label.slice(1));
    }
  });
});

describe("a set of geometries, as one phrase", () => {
  it("joins with a middot, in the order it was given", () => {
    expect(formatGeometries(["bbox", "polygon"])).toBe("box · polygon");
  });

  it("uses the display words, so a tag class does not print its enum member", () => {
    // ~110px of a 248px row, before this. The single largest width saving
    // available in the class list, larger than widening the panel.
    expect(formatGeometries(["classification_tag"])).toBe("tag");
  });

  it("says nothing for an empty set, rather than a stray separator", () => {
    // The kernel cannot produce one, but a refusal renders `?? []` while a class
    // is being typed, and " · " alone would read as damage.
    expect(formatGeometries([])).toBe("");
  });
});

describe("what a model writes, as a phrase", () => {
  it("is total over the wire's geometry union", () => {
    // The same two-sided claim the labels make: the `satisfies` is the proof
    // and this is its copy in a file that does not move with the declaration.
    const total: Record<GeometryType, string> = GEOMETRY_PLURALS;
    expect(Object.keys(total).length).toBeGreaterThan(0);
  });

  it("pluralises nothing the wire does not call a geometry", () => {
    for (const geometry of Object.keys(GEOMETRY_PLURALS)) {
      expect(firstMismatch(checkGeometryType, geometry)).toBeNull();
    }
  });

  it("names every member the singular label names, and nothing else", () => {
    // Both directions at runtime, between the two tables this module keeps:
    // a plural with no singular is a geometry the screen can announce but not
    // chip, and the reverse is a chip no sentence can name.
    expect(Object.keys(GEOMETRY_PLURALS).sort()).toEqual(Object.keys(GEOMETRY_LABELS).sort());
  });

  it("is the plural of the display word, not the wire value", () => {
    expect(GEOMETRY_PLURALS.bbox).toBe("boxes");
    expect(GEOMETRY_PLURALS.classification_tag).toBe("tags");
    expect(GEOMETRY_PLURALS.cuboid_3d).toBe("3D cuboids");
  });

  it("joins with 'or', because a run writes one shape per label", () => {
    expect(producesProse(["bbox", "polygon"])).toBe("boxes or polygons");
    expect(producesProse(["mask"])).toBe("masks");
    expect(producesProse([])).toBe("");
  });

  it("passes a member this build has never seen through raw rather than dropping it", () => {
    // The vocabulary is open on the wire: what a newer server says a run
    // writes is exactly what the reader needs, so the unknown word stays.
    expect(producesProse(["bbox", "depth_map"])).toBe("boxes or depth_map");
  });
});
