/**
 * The classes region: the height rule and the hotkeys.
 *
 * Driven through `ClassRegion` directly rather than through `AnnotationPage`,
 * unlike `topBar.test.tsx` — every claim here is about this component's own
 * arithmetic and none of it is about wiring, which is what that file covers from
 * the other end.
 *
 * **The height is asserted as the style the rule produces, not as pixels.** jsdom
 * has no layout, so `getBoundingClientRect` answers zero for everything and a test
 * reading real geometry would pass over any rule at all. What a component test
 * *can* prove is that the number handed to the browser is the one the rule says,
 * and that the list is the thing that scrolls; whether eight rows of 36px actually
 * come out 288px tall is `e2e/annotate.spec.ts`'s, in a browser.
 */

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AnnotationSchema } from "@visionset/annotator";
import type { JSX } from "react";

import { CLASS_ROW_PX } from "../patterns/DataDisplay";
import { ClassRegion, MAX_CLASS_ROWS, MIN_CLASS_ROWS, classListHeight } from "./ClassRegion";

/** A schema of `n` classes, named so the row order is readable in a failure. */
function schemaOf(n: number): AnnotationSchema {
  return {
    project_id: "p",
    version: 1,
    description: null,
    created_at: null,
    provenance: "curated",
    classes: Array.from({ length: n }, (_unused, index) => ({
      name: `class-${index + 1}`,
      geometries: index % 2 === 0 ? ["bbox"] : ["polygon"],
      color: null,
      attributes: [],
    })),
  } as unknown as AnnotationSchema;
}

function mount(n: number, overrides: Partial<Parameters<typeof ClassRegion>[0]> = {}): JSX.Element {
  return (
    <ClassRegion
      schema={schemaOf(n)}
      activeClass={null}
      onActivateClass={vi.fn()}
      {...overrides}
    />
  );
}

/** The list viewport's height in pixels, as the component actually set it. */
function listHeight(): number {
  return Number.parseInt(screen.getByTestId("class-list").style.height, 10);
}

describe("the height rule", () => {
  it("gives a one-class schema three rows' worth of height, not one", () => {
    // The floor exists so a small ontology does not render as a sliver with a
    // filter box over it — three rows is enough for the region to read as a list.
    render(mount(1));

    expect(listHeight()).toBe(MIN_CLASS_ROWS * CLASS_ROW_PX);
    expect(screen.getByTestId("class-list").getAttribute("data-rows")).toBe("3");
  });

  it("grows one row per class between the floor and the cap", () => {
    render(mount(5));

    expect(listHeight()).toBe(5 * CLASS_ROW_PX);
  });

  it("shows exactly the cap when the schema has exactly that many", () => {
    render(mount(MAX_CLASS_ROWS));

    expect(listHeight()).toBe(MAX_CLASS_ROWS * CLASS_ROW_PX);
  });

  it("stops growing at the cap and scrolls the surplus instead", () => {
    // The claim the cap exists for: twelve classes must not push the objects
    // region off the bottom of the panel. The region is fixed at eight rows and
    // the rest is reachable by scrolling *inside* it.
    render(mount(12));

    expect(listHeight()).toBe(MAX_CLASS_ROWS * CLASS_ROW_PX);
    expect(screen.getByTestId("class-list").className).toContain("overflow-y-auto");
    // All twelve are rendered — the cap is a viewport, not a truncation, so
    // scrolling reaches the twelfth rather than a "3 more" nobody can open.
    expect(screen.getByTestId("class-row-class-12")).toBeDefined();
  });

  it("does not move when the filter narrows the list", async () => {
    // Height from the schema's count, never the filtered one. A region that
    // resized on every keystroke would reflow the objects region under it, which
    // is the controls-moving-under-the-cursor problem the top bar guards against.
    render(mount(12));
    const before = listHeight();

    await userEvent.type(screen.getByTestId("class-filter"), "class-1");

    expect(listHeight()).toBe(before);
  });

  it("is the same arithmetic whether it is called or rendered", () => {
    // `classListHeight` is exported so the rule is checkable as a function; this
    // is what stops it becoming a second spelling of what the component does.
    expect(classListHeight(0)).toBe(MIN_CLASS_ROWS * CLASS_ROW_PX);
    expect(classListHeight(1)).toBe(MIN_CLASS_ROWS * CLASS_ROW_PX);
    expect(classListHeight(4)).toBe(4 * CLASS_ROW_PX);
    expect(classListHeight(99)).toBe(MAX_CLASS_ROWS * CLASS_ROW_PX);
  });
});

describe("the hotkeys the rows advertise", () => {
  it("numbers the first nine in schema order and nothing after them", () => {
    render(mount(12));

    expect(screen.getByTestId("class-row-class-1").textContent).toContain("1");
    expect(screen.getByTestId("class-row-class-9").textContent).toContain("9");
    // The tenth answers to no digit, so it carries no chip — a key badge on a row
    // the key does not reach is the lie `ReassignMenu` refuses to tell.
    expect(screen.getByTestId("class-row-class-10").querySelector("kbd")).toBeNull();
  });
});

describe("the empty schema", () => {
  // This region carries no refusal machinery, because the reason for it is gone:
  // the read-only mode renders no classes region at all, so a
  // region that exists is always armable. `panel.test.tsx` holds the absence.
  it("invites a first class rather than showing an empty list", () => {
    render(mount(0, { onAddClass: vi.fn() }));

    expect(screen.getByTestId("classes-empty")).toBeDefined();
    expect(screen.queryByTestId("class-list")).toBeNull();
  });
});
