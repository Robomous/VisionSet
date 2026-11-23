/**
 * The class panel: the Classes bar over its legend.
 *
 * The Overview no longer draws it — its Classes cell draws the bar alone — but
 * the Dataset screen does, so it is exercised here on fixture rows, without a
 * screen or a server around it.
 */

import { TooltipProvider } from "@robomous/ui-core";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubResizeObserver } from "../../testing/resizeObserver.js";
import { CLASS_RAIL_ROWS, ClassRail, type ClassRow } from "./ClassRail";

beforeEach(() => {
  // The tooltips here measure themselves through it; jsdom has none.
  stubResizeObserver();
});

const NOTE = "bicycle holds 8% of annotations — under a tenth, a model will struggle with it.";

// The rail's hints are tooltips, which need the provider the host's shell supplies.
const renderRail = (ui: ReactElement) => render(ui, { wrapper: TooltipProvider });

const fixture = (name: string, annotations: number, images: number, thin = false): ClassRow => ({ name, color: "#38bdf8", annotations, images, thin });

/** The Overview's fixture project: three classes drawn, a fourth declared and undrawn. */
const FOUR: readonly ClassRow[] = [fixture("dog", 4372, 900), fixture("person", 1544, 400), fixture("bicycle", 515, 100, true), fixture("unicycle", 0, 0)];
const FOUR_TOTAL = 6431;

/** `n` classes, each with fewer annotations than the one before, so the rank is the name's order. */
function many(n: number): { rows: ClassRow[]; total: number } {
  const rows = Array.from({ length: n }, (_, i) => fixture(`c${i + 1}`, 1000 - i * 10, 10));
  return { rows, total: rows.reduce((sum, one) => sum + one.annotations, 0) };
}

const rowsIn = (): string[] =>
  [...screen.getByTestId("overview-distribution").querySelectorAll("li")].map((one) => one.getAttribute("data-testid") ?? "");

describe("the class rail's legend", () => {
  it("heads the list with the class count, and leaves the annotation total to whoever hosts it", () => {
    renderRail(<ClassRail rows={FOUR} totalAnnotations={FOUR_TOTAL} note={NOTE} />);

    const rail = screen.getByTestId("overview-distribution");
    const header = rail.querySelector("h2")?.parentElement?.textContent ?? "";
    // Four declared classes, one of them undrawn.
    expect(header).toContain("Classes");
    expect(header).toContain("4");
    expect(header).not.toContain("annotations");
    expect(header).not.toContain((6431).toLocaleString(undefined));
  });

  it("ranks the classes largest first", () => {
    renderRail(<ClassRail rows={FOUR} totalAnnotations={FOUR_TOTAL} note={NOTE} />);

    expect(rowsIn()).toEqual(["overview-class-dog", "overview-class-person", "overview-class-bicycle", "overview-class-unicycle"]);
    expect(screen.getByTestId("overview-class-dog").textContent).toContain("68%");
    expect(screen.getByTestId("overview-class-dog").textContent).toContain((4372).toLocaleString(undefined));
  });

  it("reads a dash for a declared class nobody has drawn yet, never a zero", () => {
    renderRail(<ClassRail rows={FOUR} totalAnnotations={FOUR_TOTAL} note={NOTE} />);

    const row = screen.getByTestId("overview-class-unicycle");
    expect(row.textContent).toContain("unicycle");
    expect(row.textContent).toContain("—");
    expect(row.textContent).not.toMatch(/\b0\b/);
    // The others carry a share, not a dash.
    expect(screen.getByTestId("overview-class-dog").textContent).not.toContain("—");
  });

  it("marks the thin class with a labelled warning dot, and only the thin class", async () => {
    renderRail(<ClassRail rows={FOUR} totalAnnotations={FOUR_TOTAL} note={NOTE} />);

    const thin = { name: /^Thin: / };
    // bicycle holds 515 of 6,431 annotations, under the threshold.
    const dot = within(screen.getByTestId("overview-class-bicycle")).getByRole("button", thin);
    expect(dot.getAttribute("aria-label")).toBe("Thin: bicycle is 8% of annotations — a model will struggle to learn it.");
    expect(within(screen.getByTestId("overview-class-dog")).queryByRole("button", thin)).toBeNull();
    expect(within(screen.getByTestId("overview-class-person")).queryByRole("button", thin)).toBeNull();
    // A class nobody drew is not thin, it is absent.
    expect(within(screen.getByTestId("overview-class-unicycle")).queryByRole("button", thin)).toBeNull();
    // The word is not drawn: the dot is the whole mark.
    expect(screen.getByTestId("overview-class-bicycle").textContent).not.toContain("Thin");

    // What it means is said on hover.
    await userEvent.hover(dot);
    expect((await screen.findByRole("tooltip")).textContent).toBe("bicycle is 8% of annotations — a model will struggle to learn it.");
  });

  it("carries no per-class image columns", () => {
    renderRail(<ClassRail rows={FOUR} totalAnnotations={FOUR_TOTAL} note={NOTE} />);

    const rail = screen.getByTestId("overview-distribution");
    expect(rail.querySelector("table")).toBeNull();
    expect(rail.textContent).not.toContain("Per image");
    expect(rail.textContent).not.toContain("Images");
  });

  it("says the note it is given in the tooltip of the band's thin badge", async () => {
    renderRail(<ClassRail rows={FOUR} totalAnnotations={FOUR_TOTAL} note={NOTE} />);

    // One thin class, counted in the band; the note stays out of the list until asked for.
    const badge = screen.getByTestId("classes-thin");
    expect(badge.textContent).toContain("1 thin");
    expect(badge.closest("header")).toBe(screen.getByTestId("overview-distribution").querySelector("header"));
    expect(screen.queryByTestId("imbalance-note")).toBeNull();
    await userEvent.hover(badge);
    expect((await screen.findByTestId("imbalance-note")).textContent).toBe(NOTE);
  });

  it("names only the top eight, and folds the rest into one Others row", () => {
    const { rows, total } = many(12);
    renderRail(<ClassRail rows={rows} totalAnnotations={total} note={null} onOpen={vi.fn()} />);

    expect(CLASS_RAIL_ROWS).toBe(8);
    expect(rowsIn()).toEqual([...Array.from({ length: 8 }, (_, i) => `overview-class-c${i + 1}`), "overview-class-Others"]);
    expect(screen.queryByTestId("overview-class-c9")).toBeNull();
    // Four classes stand behind it, and their annotations are summed: 920 + 910 + 900 + 890.
    const others = screen.getByTestId("overview-class-Others");
    expect(others.textContent).toContain("Others (4)");
    expect(others.textContent).toContain((3620).toLocaleString(undefined));
    // The header still counts every class, not the shown ones.
    expect(screen.getByTestId("overview-distribution").querySelector("h2")?.parentElement?.textContent).toContain("12");
  });

  it("lists the classes behind Others, with their counts, in a tooltip on its button", async () => {
    const { rows, total } = many(10);
    renderRail(<ClassRail rows={rows} totalAnnotations={total} note={null} />);

    const trigger = screen.getByTestId("overview-class-others");
    expect(within(screen.getByTestId("overview-class-Others")).getByTestId("overview-class-others")).toBe(trigger);
    expect(trigger.getAttribute("aria-label")).toBe("The 2 other classes");
    await userEvent.hover(trigger);

    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("c9");
    expect(tip.textContent).toContain((920).toLocaleString(undefined));
    expect(tip.textContent).toContain("c10");
    expect(tip.textContent).toContain((910).toLocaleString(undefined));
    expect(tip.textContent).not.toContain("c8");
  });

  it("folds exactly one class beyond the eight into Others (1)", () => {
    const { rows, total } = many(9);
    renderRail(<ClassRail rows={rows} totalAnnotations={total} note={null} />);

    expect(rowsIn()).toHaveLength(9);
    expect(screen.queryByTestId("overview-class-c9")).toBeNull();
    expect(screen.getByTestId("overview-class-Others").textContent).toContain("Others (1)");
  });

  it("shows all eight and no Others row when none are left over", () => {
    const { rows, total } = many(8);
    renderRail(<ClassRail rows={rows} totalAnnotations={total} note={null} onOpen={vi.fn()} />);

    expect(rowsIn()).toEqual(Array.from({ length: 8 }, (_, i) => `overview-class-c${i + 1}`));
    expect(screen.queryByTestId("overview-class-Others")).toBeNull();
    expect(screen.queryByTestId("overview-class-others")).toBeNull();
  });

  it("opens the Classes section from the header's Edit door, only where the host has one", async () => {
    const schema = vi.fn();
    const { unmount } = renderRail(<ClassRail rows={FOUR} totalAnnotations={FOUR_TOTAL} note={NOTE} />);
    expect(screen.queryByTestId("overview-edit-classes")).toBeNull();
    unmount();

    renderRail(<ClassRail rows={FOUR} totalAnnotations={FOUR_TOTAL} note={NOTE} onOpen={schema} />);
    const door = screen.getByTestId("overview-edit-classes");
    expect(door.getAttribute("aria-label")).toBe("Edit classes");
    expect(door.textContent).toBe("Edit");
    // It lives in the panel's header; the panel has no footer.
    expect(door.closest("header")).toBe(screen.getByTestId("overview-distribution").querySelector("header"));
    await userEvent.click(door);
    expect(schema).toHaveBeenCalledOnce();
  });

  it("keeps the same Edit door when classes fold into Others", async () => {
    const { rows, total } = many(9);
    const schema = vi.fn();
    renderRail(<ClassRail rows={rows} totalAnnotations={total} note={null} onOpen={schema} />);

    await userEvent.click(screen.getByTestId("overview-edit-classes"));
    expect(schema).toHaveBeenCalledOnce();
  });

  it("lays the legend in one column from xl, and two below it", () => {
    renderRail(<ClassRail rows={FOUR} totalAnnotations={FOUR_TOTAL} note={NOTE} />);

    const legend = screen.getByTestId("overview-distribution").querySelector("ol");
    expect(legend?.classList.contains("xl:grid-cols-1")).toBe(true);
    expect(legend?.classList.contains("sm:grid-cols-2")).toBe(true);
    expect([...(legend?.classList ?? [])].some((one) => one.startsWith("@2xl"))).toBe(false);
  });
});

describe("ClassRail", () => {
  const row = (name: string, annotations: number, thin = false): ClassRow => ({ name, color: "#38bdf8", annotations, images: 1, thin });
  // The rail's hints are tooltips, which need the provider the host's shell supplies.
  const renderRail = (ui: ReactElement) => render(ui, { wrapper: TooltipProvider });

  it("reads under one percent as <1%, and an undrawn class as a dash", () => {
    renderRail(<ClassRail rows={[row("big", 999), row("tiny", 1), row("none", 0)]} totalAnnotations={1000} note={null} />);

    expect(screen.getByTestId("overview-class-big").textContent).toContain("100%");
    expect(screen.getByTestId("overview-class-tiny").textContent).toContain("<1%");
    expect(screen.getByTestId("overview-class-none").textContent).toContain("—");
  });

  it("says what a class is when there are none, and offers no footer", () => {
    renderRail(<ClassRail rows={[]} totalAnnotations={0} note={null} onOpen={vi.fn()} />);

    expect(screen.getByTestId("overview-distribution").textContent).toContain("No classes yet. A class is what an annotation can say a shape is.");
  });

  it("draws no Edit door without a host section to open, and folds past eight classes either way", () => {
    const nine = Array.from({ length: 9 }, (_, i) => row(`c${i}`, 10));
    const { unmount } = renderRail(<ClassRail rows={nine.slice(0, 3)} totalAnnotations={30} note={null} />);
    expect(screen.queryByTestId("overview-edit-classes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit classes" })).toBeNull();
    expect(screen.queryByTestId("overview-class-Others")).toBeNull();
    unmount();

    renderRail(<ClassRail rows={nine} totalAnnotations={90} note={null} />);
    expect(screen.queryByTestId("overview-edit-classes")).toBeNull();
    expect(screen.getByTestId("overview-class-Others").textContent).toContain("Others (1)");
    expect(screen.getByTestId("overview-distribution").textContent).not.toContain("more class");
  });

  it("draws the Edit door in the header when it is given a section to open", async () => {
    const open = vi.fn();
    renderRail(<ClassRail rows={[row("a", 1)]} totalAnnotations={1} note={null} onOpen={open} />);

    const door = screen.getByRole("button", { name: "Edit classes" });
    expect(door.closest("header")).not.toBeNull();
    await userEvent.click(door);
    expect(open).toHaveBeenCalledOnce();
  });

  it("says the note it is given from the thin badge, and only when a class is thin", async () => {
    const { unmount } = renderRail(<ClassRail rows={[row("a", 1)]} totalAnnotations={1} note="a is thin" />);
    expect(screen.queryByTestId("classes-thin")).toBeNull();
    unmount();

    renderRail(<ClassRail rows={[row("a", 1, true), row("b", 99)]} totalAnnotations={100} note="a is thin" />);
    expect(screen.queryByTestId("imbalance-note")).toBeNull();
    const badge = screen.getByTestId("classes-thin");
    expect(badge.textContent).toContain("1 thin");
    await userEvent.hover(badge);
    expect((await screen.findByTestId("imbalance-note")).textContent).toBe("a is thin");
  });

  it("draws one bar of the classes that have annotations, named for a screen reader", () => {
    renderRail(<ClassRail rows={[row("big", 900), row("tiny", 1), row("none", 0)]} totalAnnotations={901} note={null} />);

    // An undrawn class has no block: it has no share to show.
    expect(screen.getByRole("img", { name: "big 100%, tiny <1%" })).not.toBeNull();
  });

  it("reads the largest class in the readout until another is pointed at or pinned", async () => {
    renderRail(<ClassRail rows={[row("big", 90), row("small", 10)]} totalAnnotations={100} note={null} />);

    const readout = screen.getByTestId("class-readout");
    expect(readout.textContent).toContain("90%");
    expect(readout.textContent).toContain("big");

    const small = within(screen.getByTestId("overview-class-small")).getByRole("button");
    expect(small.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(small);
    expect(small.getAttribute("aria-pressed")).toBe("true");
    expect(readout.textContent).toContain("10%");
    expect(readout.textContent).toContain("small");
    expect(readout.textContent).toContain("10 on 1 image");

    // Pointing elsewhere reads that class for as long as it is pointed at.
    await userEvent.hover(within(screen.getByTestId("overview-class-big")).getByRole("button"));
    expect(readout.textContent).toContain("big");
  });

  it("cannot pin a class nobody has drawn", () => {
    renderRail(<ClassRail rows={[row("big", 10), row("none", 0)]} totalAnnotations={10} note={null} />);

    expect(within(screen.getByTestId("overview-class-none")).getByRole("button").hasAttribute("disabled")).toBe(true);
  });

  it("says there are no annotations yet instead of drawing an empty bar", () => {
    renderRail(<ClassRail rows={[row("a", 0), row("b", 0)]} totalAnnotations={0} note={null} />);

    expect(screen.getByTestId("overview-distribution").textContent).toContain("No annotations yet.");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByTestId("class-readout")).toBeNull();
  });
});
