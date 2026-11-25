/**
 * The project screens, driven against a stubbed `fetch`: the project list, the
 * project view's sections and its identity.
 *
 * The acceptance criteria are "component tests for the editor's edit/validate/save
 * flow" and "version history renders and past versions are read-only". Both are
 * below, and so is the thing the editor actually exists to get right: **the two
 * 409s, and the fact that only one of them may be retried.**
 *
 * That last one cannot be checked any other way. It is not a rendering question
 * and not a request-shape question — it is whether the screen branches on the
 * error `code` or on the status, and a screen that branches on the status looks
 * completely correct until somebody meets `SCHEMA_CHANGE_WOULD_ORPHAN` and is
 * offered a button that will never work.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState, type JSX } from "react";
import { formatCount, formatPercent, formatWhen } from "../lib/format";
import { ProjectScreen } from "./ProjectScreen";
import { PageStatusOutlet, PageStatusProvider } from "../patterns/PageStatus";
import { ProjectsScreen } from "./ProjectsScreen";
import type { ProjectListItem } from "./queries";
import { renderWithData } from "../testing/dataHarness";
import { batchActions } from "../testing/wire.fixtures.js";
import {
  CLASSES,
  OTHER_PROJECT,
  PROJECT,
  addNamedClass,
  handlers,
  on,
  sent,
  installScreensHarness,
  type BatchState,
} from "../testing/screensHarness";

installScreensHarness();

describe("the project list", () => {
  const THIRD_PROJECT = "99999999-9999-4999-8999-999999999999";
  /** A digest with nothing in it: the kernel's answer for a project made a moment ago. */
  const EMPTY_DIGEST: ProjectListItem["digest"] = {
    asset_count: 0,
    annotated_asset_count: 0,
    annotated_fraction: 0,
    class_count: 0,
    batch_count: 0,
    frames_left: 0,
    frames_in_review: 0,
    dataset_asset_count: 0,
    latest_release: null,
    last_activity_at: null,
    stage: "empty",
  };
  function project(
    id: string,
    name: string,
    created_at: string | null,
    digest: Partial<ProjectListItem["digest"]> = {},
  ): ProjectListItem {
    return {
      id,
      name,
      description: null,
      thumbnail_asset_id: null,
      thumbnail_hash: null,
      created_at,
      digest: { ...EMPTY_DIGEST, ...digest },
    };
  }
  function list(...items: ProjectListItem[]): void {
    on("GET", /^\/projects$/, { status: 200, body: { items, total: items.length } });
  }
  function rowNames(): string[] {
    return screen
      .getAllByTestId(/^project-(?!stage)/)
      .map((row) => row.getAttribute("data-testid")?.replace("project-", "") ?? "");
  }
  /**
   * The screen as the app mounts it: inside a status provider, with the outlet the
   * shell's status bar carries. What the list adds up to is said there and not on
   * the page, so a test that reads a count needs the pair.
   */
  async function rendered(): Promise<void> {
    renderWithData(
      <PageStatusProvider>
        <ProjectsScreen onOpenProject={vi.fn()} />
        <PageStatusOutlet />
      </PageStatusProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId("projects-table")).not.toBeNull());
  }

  it("orders projects by last activity, newest first, and the Activity header flips it", async () => {
    list(
      project(PROJECT, "quiet", "2026-01-01T08:00:00Z", { last_activity_at: "2026-02-01T08:00:00Z" }),
      project(OTHER_PROJECT, "busy", "2026-01-02T08:00:00Z", { last_activity_at: "2026-09-01T08:00:00Z" }),
      // Nothing has happened in it yet, so it moved when it was made.
      project(THIRD_PROJECT, "new", "2026-05-01T08:00:00Z"),
    );
    await rendered();
    expect(rowNames()).toEqual(["busy", "new", "quiet"]);
    expect(screen.getByRole("columnheader", { name: /activity/i }).getAttribute("aria-sort")).toBe("descending");

    await userEvent.click(screen.getByTestId("sort-activity"));
    expect(rowNames()).toEqual(["quiet", "new", "busy"]);
    expect(screen.getByRole("columnheader", { name: /activity/i }).getAttribute("aria-sort")).toBe("ascending");
  });

  it("keeps never-dated projects last in both directions, in the order the wire gave them", async () => {
    list(project(PROJECT, "legacy-a", null), project(OTHER_PROJECT, "legacy-b", null), project(THIRD_PROJECT, "dated", "2026-08-01T08:00:00Z"));
    await rendered();
    expect(rowNames()).toEqual(["dated", "legacy-a", "legacy-b"]);
    // A project the workspace never dated shows a dash, never a guessed date.
    expect(screen.getByTestId("project-legacy-a").textContent).toContain("—");

    await userEvent.click(screen.getByTestId("sort-activity"));
    expect(rowNames()).toEqual(["dated", "legacy-a", "legacy-b"]);
  });

  it("sorts a numeric column largest first on its first click, and marks only that header", async () => {
    list(
      project(PROJECT, "small", null, { asset_count: 40, stage: "not_started" }),
      project(OTHER_PROJECT, "large", null, { asset_count: 12480, stage: "not_started" }),
      project(THIRD_PROJECT, "middle", null, { asset_count: 900, stage: "not_started" }),
    );
    await rendered();
    await userEvent.click(screen.getByTestId("sort-images"));
    expect(rowNames()).toEqual(["large", "middle", "small"]);
    expect(screen.getByRole("columnheader", { name: /assets/i }).getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("columnheader", { name: /activity/i }).getAttribute("aria-sort")).toBe("none");
    // Numbers are grouped the product's way.
    expect(screen.getByTestId("project-large").textContent).toContain("12,480");
  });

  it("says each stage in words, with the size of what is waiting", async () => {
    list(
      project(PROJECT, "reviewing", null, { asset_count: 900, frames_in_review: 37, stage: "in_review" }),
      project(OTHER_PROJECT, "labelling", null, { asset_count: 1840, frames_left: 1112, stage: "annotating" }),
      project(THIRD_PROJECT, "fresh", null),
    );
    await rendered();
    const stage = (name: string): string => within(screen.getByTestId(`project-${name}`)).getByTestId("project-stage").textContent ?? "";
    expect(stage("reviewing")).toBe("In review");
    expect(screen.getByTestId("project-reviewing").textContent).toContain("37 to review");
    expect(stage("labelling")).toBe("Annotating");
    // What is left to annotate is the Annotated column's, said once: the stage
    // carries no "left" of its own beside it.
    expect(screen.getByTestId("project-labelling").textContent).toContain("1,840 to annotate");
    expect(screen.getByTestId("project-labelling").textContent).not.toContain("left");
    expect(stage("fresh")).toBe("No assets");
  });

  it("names the latest release's tag alone, with what it holds on hover, or a dash without one", async () => {
    list(
      project(PROJECT, "released", null, {
        asset_count: 9000,
        dataset_asset_count: 8460,
        latest_release: { tag: "v0.6", asset_count: 8460, published_at: "2026-10-28T08:00:00Z" },
        stage: "up_to_date",
      }),
      project(OTHER_PROJECT, "promoted", null, { asset_count: 500, dataset_asset_count: 480, stage: "unreleased" }),
    );
    await rendered();
    // The tag and nothing else: its image count is the title's, and "no release"
    // is the Status column's word (Not released), not the cell's.
    const released = screen.getByTestId("project-released");
    const tag = within(released).getByText("v0.6");
    expect(tag.className).toContain("font-mono");
    expect(tag.getAttribute("title")).toMatch(/^8,460 assets · published /);
    expect(released.textContent).not.toContain("8,460");
    const promoted = screen.getByTestId("project-promoted");
    expect(promoted.textContent).not.toContain("480");
    expect(promoted.textContent).not.toContain("no release");
    expect(promoted.textContent).not.toMatch(/v\d/);
    expect(within(promoted).queryByTitle(/published/)).toBeNull();
  });

  it("filters by name or description as you type, and says so when nothing matches", async () => {
    list(
      { ...project(PROJECT, "highway", null), description: "M4 survey" },
      project(OTHER_PROJECT, "warehouse", null),
    );
    await rendered();
    await userEvent.type(screen.getByTestId("projects-search"), "m4");
    expect(rowNames()).toEqual(["highway"]);
    await userEvent.clear(screen.getByTestId("projects-search"));
    await userEvent.type(screen.getByTestId("projects-search"), "zebra");
    const none = screen.getByTestId("projects-no-match");
    expect(none.textContent).toContain("zebra");
    // A row of the table, spanning it — the grid and its headers stay.
    expect(none.tagName).toBe("TD");
    expect(screen.getByTestId("projects-table").contains(none)).toBe(true);
    expect(none.getAttribute("colspan")).toBe("8");
    expect(screen.queryAllByTestId(/^project-(?!stage)/)).toHaveLength(0);
    // The footer says what the search left, of everything — and with nothing
    // left there is nothing to total.
    expect(screen.getByTestId("table-pager-range").textContent).toBe("No projects match");
    expect(screen.queryByTestId("projects-images")).toBeNull();
    expect(screen.queryByTestId("projects-review")).toBeNull();
  });

  it("clears a search that matched nothing from the empty result, and gives focus back to the field", async () => {
    list(project(PROJECT, "highway", null), project(OTHER_PROJECT, "warehouse", null));
    await rendered();
    const search = screen.getByTestId("projects-search");
    await userEvent.type(search, "zebra");
    expect(screen.getByTestId("projects-no-match")).not.toBeNull();

    const clear = within(screen.getByTestId("projects-no-match")).getByTestId("projects-clear-search");
    expect(clear.textContent).toBe("Clear search");
    await userEvent.click(clear);

    expect(search).toHaveProperty("value", "");
    expect(screen.queryByTestId("projects-no-match")).toBeNull();
    expect(rowNames().sort()).toEqual(["highway", "warehouse"]);
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–2 of 2 projects");
    expect(document.activeElement).toBe(search);
  });

  it("is one table of projects, headed by its columns, under a heading that carries no count", async () => {
    list(project(PROJECT, "highway", null, { asset_count: 10, stage: "not_started" }), project(OTHER_PROJECT, "warehouse", null));
    await rendered();

    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).not.toBeNull();
    // What the list adds up to is the status bar's, and which rows are on
    // screen the footer's: not the heading's.
    const heading = screen.getByRole("heading", { level: 1, name: "Projects" });
    expect(heading.textContent).toBe("Projects");
    // The header band is the name alone; New sits at the end of the search and sort bar.
    expect(heading.closest("header")?.textContent).toBe("Projects");
    const add = screen.getByRole("button", { name: "New project" });
    expect(add).toBe(screen.getByTestId("new-project"));
    expect(screen.getByTestId("projects-search").closest("div")?.parentElement?.contains(add)).toBe(true);
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–2 of 2 projects");
    expect(screen.getByTestId("projects-images").textContent).toBe("10 assets · 10 to annotate");
    expect(screen.getByTestId("projects-screen").contains(screen.getByTestId("projects-images"))).toBe(false);
    // The count is the footer's alone: the status bar does not say it again.
    expect(screen.queryByTestId("projects-totals")).toBeNull();
    const table = screen.getByRole("table", { name: "Projects" });
    expect(table).toBe(screen.getByTestId("projects-table"));
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Project", "Assets", "Annotated", "Classes", "Status", "Release", "Activity", "Actions"]);
    expect(within(table).getAllByTestId(/^project-(?!stage)/).every((row) => row.tagName === "TR")).toBe(true);
    // One count, in the footer: no totals table under the rows.
    expect(screen.queryByTestId("projects-table-totals")).toBeNull();
    expect(screen.queryByTestId("projects-shown")).toBeNull();
    expect(screen.queryByRole("table", { name: "Projects, totals" })).toBeNull();
    expect(screen.getAllByRole("table")).toHaveLength(1);
    // No cards, and no list of anything but the table's own rows.
    expect(document.querySelector('[data-slot="card"]')).toBeNull();
  });

  it("shows a project's description beside its name, and what is left to annotate beside a ring", async () => {
    list(
      { ...project(PROJECT, "highway", null, { asset_count: 200, annotated_asset_count: 50, annotated_fraction: 0.25, stage: "annotating", frames_left: 150 }), description: "M4 survey" },
      project(OTHER_PROJECT, "fresh", null),
      project(THIRD_PROJECT, "done", null, { asset_count: 48, annotated_asset_count: 48, annotated_fraction: 1, stage: "up_to_date" }),
    );
    await rendered();

    const row = screen.getByTestId("project-highway");
    expect(row.textContent).toContain("M4 survey");
    expect(within(row).getByTestId("open-highway").closest("td")?.textContent).toContain("M4 survey");
    // The work left, in words — the ring beside it is decoration for the glance.
    const cell = within(row).getByTestId("remaining-cell");
    expect(cell.textContent).toBe("150 to annotate");
    expect(cell.getAttribute("title")).toBe("25% of assets annotated");
    expect(within(cell).getByTestId("remaining-ring").getAttribute("aria-hidden")).toBe("true");
    // Tabular figures, so a count that changes never moves the words after it.
    expect(cell.querySelector(".tabular-nums")).not.toBeNull();
    // A finished project says so in words, with no ring and no count.
    const done = within(screen.getByTestId("project-done")).getByTestId("remaining-cell");
    expect(done.textContent).toBe("All annotated");
    expect(within(done).queryByTestId("remaining-ring")).toBeNull();
    // Nothing to annotate yet: the dash every column uses, not "0 to annotate".
    expect(within(screen.getByTestId("project-fresh")).queryByTestId("remaining-cell")).toBeNull();
    expect(screen.getByTestId("project-fresh").textContent).not.toContain("to annotate");
  });

  it("counts frames a person still has to do, so pre-labels nobody read are never all annotated", async () => {
    // Every image carries an annotation — a model's pre-label — and 11 frames
    // still wait on an annotator: the row says the 11, never "All annotated".
    list(project(PROJECT, "prelabelled", null, { asset_count: 13, annotated_asset_count: 13, annotated_fraction: 1, frames_left: 11, stage: "annotating" }));
    await rendered();
    const cell = within(screen.getByTestId("project-prelabelled")).getByTestId("remaining-cell");
    expect(cell.textContent).toBe("11 to annotate");
    expect(screen.getByTestId("projects-images").textContent).toBe("13 assets · 11 to annotate");
    // The ring stays open while anything is left, whatever the images' share.
    const arc = within(cell).getByTestId("remaining-ring").querySelectorAll("circle")[1];
    const [drawn, length] = (arc?.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
    expect(drawn! / length!).toBeLessThan(1);
  });

  it("says in the status bar how many images there are, and in the footer how many projects the search left of them", async () => {
    list(
      { ...project(PROJECT, "highway", null, { asset_count: 100, annotated_asset_count: 50, annotated_fraction: 0.5, latest_release: { tag: "v1", asset_count: 90, published_at: "2026-10-28T08:00:00Z" }, stage: "up_to_date" }), description: "M4 survey" },
      project(OTHER_PROJECT, "warehouse", null, { asset_count: 300, annotated_asset_count: 300, annotated_fraction: 1, stage: "unreleased" }),
    );
    await rendered();

    // The images are announced as a status: the outlet is a polite status
    // region that exists before anything is put in it.
    const images = screen.getByTestId("projects-images");
    expect(images.closest('[role="status"]')).toBe(screen.getByTestId("page-status"));
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–2 of 2 projects");
    // Over the rows shown, the same count the rows say: 50 left, all in highway.
    expect(images.textContent).toBe("400 assets · 50 to annotate");
    expect(screen.queryByTestId("projects-review")).toBeNull();
    expect(screen.queryByTestId("projects-table-totals")).toBeNull();

    await userEvent.type(screen.getByTestId("projects-search"), "m4");

    // What the search hid is said, never dropped — and the rest follows the rows left.
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1 project · filtered from 2");
    expect(screen.getByTestId("projects-images").textContent).toBe("100 assets · 50 to annotate");
    expect(rowNames()).toEqual(["highway"]);
  });

  it("says how many shown projects wait on a review, only while some do", async () => {
    list(
      project(PROJECT, "reviewing", null, { asset_count: 900, frames_in_review: 37, stage: "in_review" }),
      project(OTHER_PROJECT, "also-reviewing", null, { asset_count: 10, frames_in_review: 2, stage: "in_review" }),
      project(THIRD_PROJECT, "labelling", null, { asset_count: 40, frames_left: 4, stage: "annotating" }),
    );
    await rendered();
    expect(screen.getByTestId("projects-review").textContent).toBe("2 in review");

    // Over the rows shown: the search leaves one that is, then one that is not.
    await userEvent.type(screen.getByTestId("projects-search"), "also");
    expect(screen.getByTestId("projects-review").textContent).toBe("1 in review");
    await userEvent.clear(screen.getByTestId("projects-search"));
    await userEvent.type(screen.getByTestId("projects-search"), "labelling");
    expect(screen.queryByTestId("projects-review")).toBeNull();
  });

  it("says nothing about images while the projects shown hold none", async () => {
    list(project(PROJECT, "fresh", null), project(OTHER_PROJECT, "newer", null));
    await rendered();
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–2 of 2 projects");
    expect(screen.queryByTestId("projects-images")).toBeNull();
    expect(screen.queryByTestId("projects-review")).toBeNull();
  });

  it("says none of its counts when no status bar is there to say them in", async () => {
    // The facts are a summary of the page, never the only place something is
    // said: a host without an outlet loses the summary and nothing else.
    list(project(PROJECT, "highway", null, { asset_count: 10, stage: "in_review", frames_in_review: 1 }));
    renderWithData(<ProjectsScreen onOpenProject={vi.fn()} />);
    await waitFor(() => expect(screen.queryByTestId("projects-table")).not.toBeNull());
    for (const id of ["projects-images", "projects-review"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(rowNames()).toEqual(["highway"]);
  });

  it("speaks of one project and one image in the singular", async () => {
    list(project(PROJECT, "fresh", null, { asset_count: 1, stage: "not_started" }));
    await rendered();
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1 project");
    expect(screen.getByTestId("projects-images").textContent).toBe("1 asset · 1 to annotate");
  });

  it("sorts from the toolbar's menu, and the header that carries the sort follows", async () => {
    list(
      project(PROJECT, "small", null, { asset_count: 40, class_count: 9, stage: "not_started" }),
      project(OTHER_PROJECT, "large", null, { asset_count: 12480, class_count: 1, stage: "not_started" }),
      project(THIRD_PROJECT, "middle", null, { asset_count: 900, class_count: 4, stage: "not_started" }),
    );
    await rendered();
    const menu = screen.getByTestId("projects-sort");
    // The toolbar says the order it is in, and the header agrees.
    expect(menu.textContent).toBe("Sorted byActivity");
    expect(screen.getByRole("columnheader", { name: /activity/i }).getAttribute("aria-sort")).toBe("descending");

    await userEvent.click(menu);
    await userEvent.click(await screen.findByTestId("projects-sort-images"));

    expect(rowNames()).toEqual(["large", "middle", "small"]);
    expect(screen.getByTestId("projects-sort").textContent).toBe("Sorted byAssets");
    expect(screen.getByRole("columnheader", { name: /assets/i }).getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("columnheader", { name: /activity/i }).getAttribute("aria-sort")).toBe("none");

    // Which way, in the same menu.
    await userEvent.click(screen.getByTestId("projects-sort"));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Ascending" }));
    expect(rowNames()).toEqual(["small", "middle", "large"]);
    expect(screen.getByRole("columnheader", { name: /assets/i }).getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByTestId("projects-sort").textContent).toBe("Sorted byAssets");

    await userEvent.click(screen.getByTestId("projects-sort"));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Descending" }));
    expect(rowNames()).toEqual(["large", "middle", "small"]);
  });

  it("keeps the menu and the headers in step the other way round too", async () => {
    list(
      project(PROJECT, "few", null, { class_count: 2, stage: "not_started" }),
      project(OTHER_PROJECT, "many", null, { class_count: 12, stage: "not_started" }),
    );
    await rendered();

    // The Classes header sorts now, and the menu reads what it did.
    await userEvent.click(screen.getByTestId("sort-classes"));
    expect(rowNames()).toEqual(["many", "few"]);
    expect(screen.getByRole("columnheader", { name: /classes/i }).getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByTestId("projects-sort").textContent).toBe("Sorted byClasses");

    await userEvent.click(screen.getByTestId("sort-classes"));
    expect(rowNames()).toEqual(["few", "many"]);
    await userEvent.click(screen.getByTestId("projects-sort"));
    expect(await screen.findByRole("menuitemradio", { name: "Classes" })).not.toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "Classes" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Ascending" }).getAttribute("aria-checked")).toBe("true");
  });

  it("has one way to make a project, the header's, and no row of the table that offers another", async () => {
    list(project(PROJECT, "highway", null));
    await rendered();

    expect(screen.queryByTestId("projects-add-row")).toBeNull();
    // The table holds the projects and nothing else.
    const rows = [...screen.getByTestId("projects-table").querySelectorAll("tbody > tr")];
    expect(rows).toHaveLength(1);
    expect(rowNames()).toEqual(["highway"]);
    expect(screen.getAllByRole("button", { name: /new project/i })).toHaveLength(1);

    await userEvent.click(screen.getByTestId("new-project"));

    expect(await screen.findByTestId("create-project-dialog")).not.toBeNull();
    expect(screen.getByTestId("project-name")).toHaveProperty("value", "");
  });

  it("keeps the header's New project under a search that matches nothing", async () => {
    list(project(PROJECT, "highway", null));
    await rendered();
    await userEvent.type(screen.getByTestId("projects-search"), "zebra");

    expect(screen.getByTestId("projects-no-match")).not.toBeNull();
    expect(screen.queryByTestId("projects-add-row")).toBeNull();
    await userEvent.click(screen.getByTestId("new-project"));
    expect(await screen.findByTestId("create-project-dialog")).not.toBeNull();
  });

  it("lists projects and opens one through the callback, never a router", async () => {
    list({ ...project(PROJECT, "highway", null), description: "M4 survey" });
    const opened = vi.fn();

    renderWithData(<ProjectsScreen onOpenProject={opened} />);

    await waitFor(() => expect(screen.queryByTestId("projects-table")).not.toBeNull());
    await userEvent.click(screen.getByTestId("open-highway"));
    // The screen navigates by asking, which is what keeps `ui-core` free of a
    // router it would then only work inside.
    expect(opened).toHaveBeenCalledWith(PROJECT);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("fetches a pictured project's thumbnail and gives an imageless one a placeholder", async () => {
    const ASSET = "22222222-2222-4222-8222-222222222222";
    list(
      { ...project(PROJECT, "highway", null, { asset_count: 3, stage: "not_started" }), thumbnail_asset_id: ASSET, thumbnail_hash: "ab".repeat(32) },
      project(OTHER_PROJECT, "unstocked", null),
    );
    on("GET", /^\/projects\/[^/]+\/assets\/[^/]+\/thumbnail$/, { status: 200, body: "bytes" });

    await rendered();
    // The pictured row asks for the asset the wire named — and only that row
    // asks: a null preview is "known absent", not a fetch that comes back empty.
    await waitFor(() =>
      expect(
        sent.some((r) => new URL(r.url).pathname === `/projects/${PROJECT}/assets/${ASSET}/thumbnail`),
      ).toBe(true),
    );
    expect(sent.filter((r) => r.url.includes("/thumbnail")).length).toBe(1);
    // The imageless project states its own situation, not the backfill remedy
    // `AssetThumbnail` offers for an asset whose preview was never cached.
    expect(screen.getByTitle("No assets in this project yet.")).not.toBeNull();
  });

  it("shows the empty state rather than an empty table", async () => {
    on("GET", /^\/projects$/, { status: 200, body: { items: [], total: 0 } });
    renderWithData(<ProjectsScreen onOpenProject={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("No projects yet")).not.toBeNull());
    expect(screen.queryByTestId("projects-table")).toBeNull();
    // The empty state has no button of its own: the header's is the one way in.
    expect(screen.getByText(/Start one with New\./)).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /new project/i })).toHaveLength(1);
    expect(screen.queryByTestId("table-footer")).toBeNull();
  });

  it("pages the list 25 to a page, from a footer, over the rows the search and the order leave", async () => {
    // Sixty projects, named so the order is plain: name ascending is p01…p60.
    const sixty = Array.from({ length: 60 }, (_, index) => {
      const name = `p${String(index + 1).padStart(2, "0")}`;
      return project(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, name, null, { asset_count: index + 1 });
    });
    list(...sixty);
    await rendered();
    await userEvent.click(screen.getByTestId("sort-name"));

    expect(rowNames()).toHaveLength(25);
    expect(rowNames()[0]).toBe("p01");
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–25 of 60 projects");
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 3");
    // The status bar sums every project the search leaves, not the page.
    expect(screen.getByTestId("projects-images").textContent).toMatch(/^1,830 assets/);

    await userEvent.click(screen.getByTestId("table-pager-next"));
    expect(rowNames()[0]).toBe("p26");
    expect(screen.getByTestId("table-pager-range").textContent).toBe("26–50 of 60 projects");

    await userEvent.click(screen.getByTestId("table-pager-last"));
    expect(rowNames()).toHaveLength(10);
    expect(screen.getByTestId("table-pager-range").textContent).toBe("51–60 of 60 projects");
    expect(screen.getByTestId("table-pager-next").getAttribute("aria-disabled")).toBe("true");

    // A new order starts over at the first page.
    await userEvent.click(screen.getByTestId("sort-name"));
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 3");
    expect(rowNames()[0]).toBe("p60");

    // So does a search, which also says what it was filtered from.
    await userEvent.click(screen.getByTestId("table-pager-next"));
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 2 of 3");
    await userEvent.type(screen.getByTestId("projects-search"), "p");
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 3");
    await userEvent.type(screen.getByTestId("projects-search"), "1");
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 1");
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–10 of 10 projects · filtered from 60");
  });

  it("walks the rows of a page with the arrow keys, and stops at its last row", async () => {
    const thirty = Array.from({ length: 30 }, (_, index) => {
      const name = `p${String(index + 1).padStart(2, "0")}`;
      return project(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, name, null, { asset_count: index + 1 });
    });
    list(...thirty);
    await rendered();
    await userEvent.click(screen.getByTestId("sort-name"));

    screen.getByTestId("open-p24").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("open-p25"));
    await userEvent.keyboard("{ArrowDown}");
    // The twenty-sixth is the next page's: the footer goes there, the keys do not.
    expect(document.activeElement).toBe(screen.getByTestId("open-p25"));
  });

  it("lands inside the project it just created, not back on the list", async () => {
    on("GET", /^\/projects$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /^\/projects$/, {
      status: 201,
      body: {
        id: PROJECT,
        name: "highway",
        description: null,
        thumbnail_asset_id: null,
        thumbnail_hash: null,
        created_at: null,
      },
    });
    const opened = vi.fn();

    renderWithData(<ProjectsScreen onOpenProject={opened} />);
    await userEvent.click(await screen.findByTestId("new-project"));
    await userEvent.type(screen.getByTestId("project-name"), "highway");
    await userEvent.click(screen.getByTestId("create-submit"));

    // Every project is created in order to do something with it, so the list is
    // never the destination.
    await waitFor(() => expect(opened).toHaveBeenCalledWith(PROJECT));
    expect(screen.queryByTestId("create-project-dialog")).toBeNull();
  });

  it("renders a name collision as the server's sentence, which names the name in the way", async () => {
    on("GET", /^\/projects$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /^\/projects$/, {
      status: 409,
      body: { code: "PROJECT_NAME_TAKEN", message: "a project named 'Highway' already exists" },
    });
    const opened = vi.fn();

    renderWithData(<ProjectsScreen onOpenProject={opened} />);
    await userEvent.click(await screen.findByTestId("new-project"));
    await userEvent.type(screen.getByTestId("project-name"), "highway");
    await userEvent.click(screen.getByTestId("create-submit"));

    const error = await screen.findByTestId("create-error");
    expect(error.textContent).toContain("a project named 'Highway' already exists");
    expect(error.textContent).not.toContain("PROJECT_NAME_TAKEN");
    expect(screen.queryByTestId("create-project-dialog")).not.toBeNull();
    expect(screen.getByTestId("project-name")).toHaveProperty("value", "highway");
    expect(opened).not.toHaveBeenCalled();
  });

  it("renames from the row menu, without opening the project", async () => {
    list(project(PROJECT, "highway", null));
    on("PATCH", /^\/projects\/[^/]+$/, {
      status: 200,
      body: { id: PROJECT, name: "motorway", description: null, thumbnail_asset_id: null, thumbnail_hash: null, created_at: null },
    });
    const opened = vi.fn();

    renderWithData(<ProjectsScreen onOpenProject={opened} />);
    await userEvent.click(await screen.findByTestId("menu-highway"));
    await userEvent.click(await screen.findByTestId("rename-highway"));
    await userEvent.clear(screen.getByTestId("rename-input"));
    await userEvent.type(screen.getByTestId("rename-input"), "motorway");
    await userEvent.click(screen.getByTestId("rename-submit"));

    await waitFor(() => expect(sent.some((r) => r.method === "PATCH")).toBe(true));
    // The menu lives inside the row, and the row opens the project on click: a
    // menu action must never also be an open.
    expect(opened).not.toHaveBeenCalled();
  });

  it("sends confirm=true on a delete, because the API will not act without it", async () => {
    list(project(PROJECT, "highway", null));
    on("DELETE", /^\/projects\//, { status: 204 });
    const opened = vi.fn();

    renderWithData(<ProjectsScreen onOpenProject={opened} />);
    await userEvent.click(await screen.findByTestId("menu-highway"));
    await userEvent.click(await screen.findByTestId("delete-highway"));
    await userEvent.click(screen.getByTestId("delete-submit"));

    await waitFor(() => expect(sent.some((r) => r.method === "DELETE")).toBe(true));
    const request = sent.find((r) => r.method === "DELETE");
    // The dialog is the *user's* confirmation; this parameter is the API's. Both
    // are doing something, which is why neither replaced the other.
    expect(new URL(request?.url ?? "").searchParams.get("confirm")).toBe("true");
    expect(opened).not.toHaveBeenCalled();
  });
});

/**
 * The class rows, in order — the buttons that open them, not their dialog. None
 * when the ledger is not on the page: an empty ledger and a filter that matches
 * nothing each show a message in its place.
 */

describe("the project view's sections", () => {
  /** The items of the project's navigation, in display order. */
  function sectionItems(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('[data-testid^="nav-"]')];
  }

  function project(): void {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: {
        id: PROJECT,
        name: "highway",
        description: null,
        thumbnail_asset_id: null,
        thumbnail_hash: null,
        created_at: null,
      },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 200,
      body: { project_id: PROJECT, version: 2, classes: CLASSES },
    });
    on("GET", /schema\/versions$/, { status: 200, body: { items: [], total: 0 } });
    on("GET", /\/batches/, { status: 200, body: { items: [], total: 0 } });
    // Overview is the default tab, so its two reads are part of
    // opening a project at all.
    on("GET", /\/stats$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        asset_count: 12,
        annotated_asset_count: 3,
        annotation_count: 20,
        class_count: 2,
        annotated_pct: 25,
        classes: [{ label_class: "vehicle", annotations: 20, assets: 3 }],
      },
    });
    on("GET", /\/assets$/, { status: 200, body: { items: [], total: 0 } });
  }

  it("shows one section at a time, and the others are not in the DOM", async () => {
    project();
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);

    // Overview is where a project opens: a project page's subject is
    // its data, and the schema editor renders the same for an empty project and
    // a hundred-thousand-image one.
    await screen.findByTestId("overview-panel");
    expect(screen.queryByTestId("schema-editor")).toBeNull();
    expect(screen.queryByTestId("images-screen")).toBeNull();
    // The history is inside Schema now, so it is absent for the same reason the
    // editor is rather than for one of its own.
    expect(screen.queryByTestId("version-history")).toBeNull();

    await userEvent.click(screen.getByTestId("nav-images"));
    await screen.findByTestId("images-screen");
    expect(screen.queryByTestId("overview-panel")).toBeNull();
    expect(screen.queryByTestId("schema-editor")).toBeNull();
    expect(screen.queryByTestId("version-history")).toBeNull();
  });

  it("presents the sections as navigation, with the open one marked and the others not", async () => {
    project();
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);
    await screen.findByTestId("overview-panel");

    // Structural, never a class string: the styling changed once already
    // and will again, but "this section is the open one" is what the keyboard and
    // a screen reader read, and it is what a restyle must not lose.
    expect(sectionItems()).toHaveLength(4);
    expect(screen.getByTestId("nav-overview").getAttribute("aria-current")).toBe("page");
    for (const other of ["nav-images", "nav-schema", "nav-dataset"]) {
      expect(screen.getByTestId(other).hasAttribute("aria-current")).toBe(false);
    }

    await userEvent.click(screen.getByTestId("nav-images"));
    await screen.findByTestId("images-screen");
    expect(screen.getByTestId("nav-images").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("nav-overview").hasAttribute("aria-current")).toBe(false);
  });

  const DATASET = "99999999-9999-4999-8999-999999999999";

  /** The latest release the dataset stubs answer, as the wire spells it. */
  const RELEASE = {
    id: "88888888-8888-4888-8888-888888888888",
    dataset_id: DATASET,
    tag: "v1",
    manifest_hash: "abcdef0123456789",
    schema_version: 2,
    asset_count: 12,
    annotation_count: 40,
    split: null,
    created_at: "2026-07-31T10:00:00.000000Z",
    visionset_version: "0.0.1.dev0",
  };

  /**
   * The dataset's three reads, for the sections that count or name it.
   *
   * Registered *before* `project()`: its `/stats$/` stub matches the dataset's
   * stats path too, and the first matching handler wins.
   */
  function dataset(releases: readonly unknown[] = []): void {
    on("GET", /^\/projects\/[^/]+\/dataset$/, {
      status: 200,
      body: { id: DATASET, project_id: PROJECT, name: "highway", description: null },
    });
    on("GET", /^\/datasets\/[^/]+\/stats$/, {
      status: 200,
      body: {
        dataset_id: DATASET,
        asset_count: 9,
        annotated_asset_count: 9,
        annotation_count: 40,
        classes: [{ label_class: "vehicle", annotations: 40, assets: 9 }],
      },
    });
    on("GET", /^\/datasets\/[^/]+\/releases$/, { status: 200, body: { items: releases, total: releases.length } });
  }

  it("gives every section one heading for the outline, and no section header", async () => {
    // The bar's active tab names the page to the eye; the heading names it to
    // whoever navigates by headings. Exactly one, so nothing is said twice.
    const sections = [
      { tab: "overview", title: "Overview", sentinel: "overview-panel" },
      { tab: "images", title: "Images", sentinel: "images-screen" },
      { tab: "schema", title: "Classes", sentinel: "schema-editor" },
      { tab: "dataset", title: "Dataset", sentinel: "dataset-screen" },
    ] as const;
    for (const one of sections) {
      handlers.length = 0;
      dataset();
      project();
      const { unmount } = renderWithData(
        <ProjectScreen projectId={PROJECT} tab={one.tab} onOpenBatch={vi.fn()} />,
      );
      await screen.findByTestId(one.sentinel);
      const headings = screen.getAllByRole("heading", { level: 1 });
      expect(
        headings.map((heading) => heading.textContent),
        one.tab,
      ).toEqual([one.title]);
      expect(screen.queryByTestId("section-header"), one.tab).toBeNull();
      unmount();
    }
  });

  it("says what the open section holds in the bar, after the tabs: the version in force, the latest release", async () => {
    const sections = [
      { tab: "schema", releases: [], meta: "Version 2 in force" },
      { tab: "dataset", releases: [RELEASE], meta: `Latest release v1 · ${formatWhen(RELEASE.created_at)}` },
      { tab: "dataset", releases: [], meta: "No releases yet" },
    ] as const;
    for (const one of sections) {
      handlers.length = 0;
      dataset(one.releases);
      project();
      const { unmount } = renderWithData(
        <ProjectScreen projectId={PROJECT} tab={one.tab} onOpenBatch={vi.fn()} />,
      );
      const meta = await within(screen.getByTestId("project-nav")).findByTestId("section-meta");
      expect(meta.textContent, `${one.tab}: ${one.meta}`).toBe(one.meta);
      // One line, and it lives in the bar: no section draws a second.
      expect(screen.getAllByTestId("section-meta"), one.tab).toEqual([meta]);
      unmount();
    }
  });

  it("says a project with no schema has no version published yet, and the Images section says nothing", async () => {
    // Registered before `project()`, whose own schema stub would answer first.
    on("GET", /^\/projects\/[^/]+\/schema$/, { status: 404, body: { code: "SCHEMA_NOT_FOUND", message: "none yet" } });
    project();
    const { unmount } = renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    expect((await screen.findByTestId("section-meta")).textContent).toBe("No version published yet");
    unmount();

    handlers.length = 0;
    dataset();
    project();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="images" />);
    await screen.findByTestId("images-screen");
    // Wait for the tabs' counts, the last thing the bar settles on.
    await waitFor(() => expect(within(screen.getByTestId("nav-images")).queryByText("12")).not.toBeNull());
    expect(screen.queryByTestId("section-meta")).toBeNull();
  });

  it("shows what each section holds beside its name, once every count has answered", async () => {
    dataset();
    project();
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);
    await screen.findByTestId("overview-panel");

    // The images in the project, the classes in force, the images in the dataset.
    await waitFor(() => expect(within(screen.getByTestId("nav-images")).queryByText("12")).not.toBeNull());
    expect(within(screen.getByTestId("nav-schema")).getByText(String(CLASSES.length))).not.toBeNull();
    expect(within(screen.getByTestId("nav-dataset")).getByText("9")).not.toBeNull();
    // The Overview is the page, not a collection: it has no count.
    expect(within(screen.getByTestId("nav-overview")).queryByText(/\d/)).toBeNull();
  });

  it("names the Images section by heading alone: the section bar is its title, and its band says what it holds", async () => {
    // The one section laid out as a pane rather than a page: a big title over
    // the grid would cost the rows the section exists for, so the heading is
    // for whoever navigates by headings, and nothing is said twice.
    project();
    on("GET", /\/assets$/, { status: 200, body: { items: [], total: 0 } });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="images" onOpenBatch={vi.fn()} />);
    await screen.findByTestId("images-screen");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Images");
    expect(screen.queryByTestId("section-header")).toBeNull();
  });

  it("opens on the section the URL named, and on the default when it names nothing valid", async () => {
    project();
    const { unmount } = renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    expect(screen.queryByTestId("overview-panel")).toBeNull();
    unmount();

    // A stale link or a typo: neither is an empty page. The default they land on
    // is Overview.
    renderWithData(<ProjectScreen projectId={PROJECT} tab="nonsense" />);
    await screen.findByTestId("overview-panel");
  });

  it("lands a bookmarked ?tab=batches on Overview, where batches are listed now", async () => {
    // The Labeling section is gone: `batches` is an unknown value like any other,
    // and Overview is where a batch is opened from.
    project();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="batches" onOpenBatch={vi.fn()} />);

    await screen.findByTestId("overview-panel");
    expect(screen.queryByTestId("nav-batches")).toBeNull();
    expect(screen.getByTestId("nav-overview").getAttribute("aria-current")).toBe("page");
  });

  /**
   * The sections' names in display order. By the name's own text rather than the
   * item's `textContent`: once the counts have answered an item reads
   * `Images12`, and the name is what a person and a screen reader take from it.
   */
  function sectionNames(): string[] {
    const names = ["Overview", "Images", "Classes", "Dataset"];
    return sectionItems().map((item) => names.find((name) => within(item).queryByText(name) !== null) ?? item.textContent ?? "");
  }

  it("opens on Overview, and offers the four sections in order", async () => {
    // Not Schema. A schema editor is configuration,
    // and it renders identically for an empty project and a 100k-image one —
    // which is the test `DESIGN.md` principle 6 states, about this page.
    project();
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);

    await screen.findByTestId("overview-panel");
    expect(sectionNames()).toEqual([
      "Overview",
      // Every image, then what the labels mean, then what came out. The id stays
      // `schema` — a bookmarked URL is a promise — while the word is the
      // person's. Batches have no section: they are opened from Overview.
      "Images",
      "Classes",
      // **Dataset, where "Schema history" used to be.** The trunk is the
      // product's central object and was reachable only through an overflow
      // menu, an Overview link and the last step of a checklist; the history is
      // a *view of* Schema and now sits inside it. `?tab=versions` still works
      // and lands on Schema — a bookmarked URL is a promise.
      "Dataset",
    ]);
    expect(sectionItems().map((item) => item.getAttribute("data-testid"))).toEqual([
      "nav-overview",
      "nav-images",
      "nav-schema",
      "nav-dataset",
    ]);
  });

  it("offers the same four sections to a host with no batch route", async () => {
    project();
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    await screen.findByTestId("overview-panel");
    expect(sectionNames()).toEqual(["Overview", "Images", "Classes", "Dataset"]);
  });

  it("round-trips ?tab=overview, so the default is addressable too", async () => {
    // The default being addressable is what makes a link to it survive the
    // default moving again.
    project();
    const changed = vi.fn();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="overview" onTabChange={changed} />);

    await screen.findByTestId("overview-panel");
    await userEvent.click(screen.getByTestId("nav-dataset"));
    expect(changed).toHaveBeenCalledWith("dataset");
  });

  it("reports the tab to the host rather than reaching for a router", async () => {
    project();
    const changed = vi.fn();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" onTabChange={changed} />);

    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("nav-overview"));
    expect(changed).toHaveBeenCalledWith("overview");
    // Controlled: the host owns the value, so the section does not move until the
    // URL does. Anything else would make the back button lie.
    expect(screen.queryByTestId("overview-panel")).toBeNull();
  });

  it("does not read the version list until somebody opens Schema", async () => {
    // The history moved *inside* Schema, so the query moved with it — only the
    // open section is mounted, which is what makes "requests follow the open
    // section" true by construction rather than by every panel remembering.
    project();
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    await screen.findByTestId("overview-panel");
    const versionRequests = (): number =>
      sent.filter((request) => new URL(request.url).pathname.endsWith("/schema/versions")).length;
    expect(versionRequests()).toBe(0);

    await userEvent.click(screen.getByTestId("nav-schema"));
    await waitFor(() => expect(versionRequests()).toBe(1));
  });

  it("carries a bookmarked ?tab=versions to Schema, where the history now lives", async () => {
    // A URL somebody saved is a promise. `resolveProjectTab` is what the *host*
    // asks to rewrite the address bar; this is the screen holding up its end
    // when handed the stale value directly.
    project();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="versions" />);

    await screen.findByTestId("schema-editor");
    // The history is one press away, in the band.
    expect(await screen.findByTestId("open-history")).not.toBeNull();
    expect(screen.queryByTestId("overview-panel")).toBeNull();
  });
});


describe("the project's identity and its one filled control", () => {
  const STATS = {
    project_id: PROJECT,
    asset_count: 1248,
    annotated_asset_count: 774,
    annotation_count: 6431,
    class_count: 3,
    annotated_pct: 62.0,
    classes: [],
    // Null by default, which is what an upgraded workspace reports for every
    // asset written before migration 13 — the state that cannot be backfilled.
    last_ingest_at: null as unknown,
  };

  /**
   * One batch as the wire spells it.
   *
   * `batchState` builds a single batch and answers most of this suite. The CTA's
   * own tests need several at once, in a stated order and with different pinned
   * versions, so both go through here rather than through two spellings of the
   * same twelve fields.
   */
  function batchStub(fields: {
    readonly id: string;
    readonly name: string;
    readonly state: string;
    readonly schemaVersion?: number | null;
    readonly unannotated?: number;
  }): Record<string, unknown> {
    return {
      id: fields.id,
      project_id: PROJECT,
      name: fields.name,
      state: fields.state,
      asset_count: 4,
      schema_version: fields.schemaVersion === undefined ? 1 : fields.schemaVersion,
      progress: {
        unannotated: fields.unannotated ?? 4,
        pre_labeled: 0,
        annotated: 0,
        skipped: 0,
        review_pending: 0,
        accepted: 0,
        total: 4,
      },
      allowed_actions: batchActions(fields.state as BatchState, { settled: (fields.unannotated ?? 4) === 0 }),
      modalities: ["image"],
      promoted_asset_count: 0,
      parent_batch_id: null,
      pre_label_run: null,
    };
  }

  function headerFor(options: {
    description?: string | null;
    schema?: boolean;
    stats?: boolean;
    batchState?: string;
    /** Several batches, in wire order. Takes the place of `batchState`. */
    batches?: readonly Parameters<typeof batchStub>[0][];
    lastIngest?: unknown;
    /** `asset_count`, which is half of what the Overview's invitation reads. */
    assets?: number;
  }): void {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: {
        id: PROJECT,
        name: "highway",
        description: options.description ?? null,
        thumbnail_asset_id: null,
        thumbnail_hash: null,
        created_at: null,
      },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: options.schema === false ? 404 : 200,
      body:
        options.schema === false
          ? { code: "SCHEMA_NOT_FOUND", message: "none yet" }
          : { project_id: PROJECT, version: 3, classes: CLASSES },
    });
    on("GET", /\/stats$/, {
      status: options.stats === false ? 500 : 200,
      body:
        options.stats === false
          ? { code: "BOOM", message: "no" }
          : {
              ...STATS,
              asset_count: options.assets ?? STATS.asset_count,
              last_ingest_at: options.lastIngest ?? null,
            },
    });
    const items =
      options.batches !== undefined
        ? options.batches.map(batchStub)
        : options.batchState === undefined
          ? []
          : [
              batchStub({
                id: "22222222-2222-4222-8222-222222222222",
                name: "drive-01",
                state: options.batchState,
              }),
            ];
    on("GET", /\/batches$/, { status: 200, body: { items, total: items.length } });
    on("GET", /schema\/versions$/, { status: 200, body: { items: [], total: 0 } });
  }

  it("says how far the labelling has come where a description is absent, never that there is none", async () => {
    // Not "No description." — a line about a field rather than about a project.
    headerFor({});
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    const meta = await within(screen.getByTestId("project-nav")).findByTestId("section-meta");
    expect(meta.textContent).toBe(`${formatPercent(62)} labeled · ${formatCount(6431)} annotations`);
    expect(screen.queryByTestId("project-description")).toBeNull();
    expect(document.body.textContent).not.toContain("No description");
  });

  it("draws no line at all for a description-less project with no images to have labeled", async () => {
    headerFor({ assets: 0 });
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    await screen.findByTestId("overview-ingest");
    // The tabs' counts are the last thing the bar settles on: after them, the
    // absence is an answer rather than a pending query.
    await waitFor(() => expect(within(screen.getByTestId("nav-images")).queryByText("0")).not.toBeNull());
    expect(screen.queryByTestId("section-meta")).toBeNull();
  });

  it("shows the description as the Overview's line in the bar when there is one", async () => {
    headerFor({ description: "M4 survey" });
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    const meta = await within(screen.getByTestId("project-nav")).findByTestId("section-meta");
    expect(meta.textContent).toBe("M4 survey");
    // The description is the line itself: it has no testid of its own any more.
    expect(screen.queryByTestId("project-description")).toBeNull();
    expect(screen.getAllByTestId("section-meta")).toEqual([meta]);
  });

  it("draws the classes as their bar of shares in the Classes card, and puts the version in no chip", async () => {
    headerFor({});
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    // The card draws the composition instead of a sentence about it; the version is the Classes section's to say.
    const card = await screen.findByTestId("kpi-annotations");
    expect(within(card).queryByText(/schema v3/)).toBeNull();
    // The bar of shares, or its empty face when nothing is labelled yet — never a sentence of totals.
    expect(within(card).queryByRole("img") ?? within(card).queryByText("No annotations yet.")).not.toBeNull();
    expect(screen.queryByTestId("chip-version")).toBeNull();
  });

  it("says a schema-less project has no schema yet, rather than placeholding a version", async () => {
    // A project three seconds old is the ordinary case.
    headerFor({ schema: false });
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    // Wait on the invitation to define classes, which only renders once the
    // schema request has answered "none yet", so the assertion below is about an
    // answer rather than about a pending query.
    const invitation = await screen.findByTestId("first-run");
    expect(invitation.getAttribute("data-invitation")).toBe("classes-after-ingest");
    expect(screen.queryByTestId("chip-version")).toBeNull();
  });

  it("draws no project eyebrow on any section: the name, the chip and the way out are not repeated", async () => {
    const SENTINEL = { overview: "overview-panel", images: "images-screen", schema: "schema-editor" } as const;
    for (const tab of ["overview", "images", "schema"] as const) {
      handlers.length = 0;
      headerFor({ assets: 3 });
      on("GET", /\/assets$/, { status: 200, body: { items: [], total: 0 } });
      const { unmount } = renderWithData(<ProjectScreen projectId={PROJECT} tab={tab} />);

      await screen.findByTestId(SENTINEL[tab]);
      for (const id of ["project-identity", "project-title", "chip-version"]) {
        expect(screen.queryByTestId(id), `${id} on ${tab}`).toBeNull();
      }
      unmount();
    }
  });

  /**
   * The Overview's one line, in the bar after the tabs: the description when
   * there is one, otherwise how far the labelling has come. The counts it used
   * to carry are the tabs' now, and the ingest moment is the stat strip's.
   */
  it("reads the labelling's progress in the bar when there is no description, with no ingest moment", async () => {
    headerFor({ lastIngest: "2026-07-31T10:00:00.000000Z" });
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    const meta = (await within(screen.getByTestId("project-nav")).findByTestId("section-meta")).textContent;
    expect(meta).toBe("62% labeled · 6,431 annotations".replace("6,431", formatCount(6431)));
    expect(meta).not.toContain("ingested");
    // The old fixed sentence is gone.
    expect(document.body.textContent).not.toContain("Where this project stands");
  });

  it("draws no line when the counts cannot be read, and the page still stands", async () => {
    headerFor({ stats: false });
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    await screen.findByRole("alert");
    expect(screen.queryByTestId("section-meta")).toBeNull();
    expect(screen.getByTestId("project-nav")).not.toBeNull();
  });

  it("refuses a stats document whose timestamp is not a string, and the page still stands", async () => {
    // This assertion moved rather than being removed. It used to read "the line
    // is simply absent", which was the *symptom* of a document nobody had
    // checked: the same wrong body white-screened three surfaces once. The
    // check runs at `unwrap`, so the query fails for every reader of it — the
    // Overview's panel says so as an error, and the bar draws no line from
    // counts it could not read — while the bar itself is untouched.
    headerFor({ lastIngest: 1_754_000_000 });
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("overview-stats")).toBeNull();
    expect(screen.queryByTestId("section-meta")).toBeNull();
    expect(screen.getByTestId("nav-overview").getAttribute("aria-current")).toBe("page");
  });

  it("offers Annotate when a batch is open for annotation, and opens that batch", async () => {
    const opened = vi.fn();
    headerFor({ batchState: "in_annotation" });
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatchChange={opened} />);

    const cta = await screen.findByTestId("go-annotate");
    // With nothing to choose between, the button is shaped like one that jumps:
    // it announces no menu, and it carries the pen and no chevron.
    expect(cta.getAttribute("aria-haspopup")).toBeNull();
    expect(cta.querySelectorAll("svg")).toHaveLength(1);

    await userEvent.click(cta);

    expect(opened).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    expect(screen.queryByTestId("annotate-batch-drive-01")).toBeNull();
  });

  /*
   * The three shapes of one control.
   *
   * A batch pins the project's active schema version at approval and the pin never
   * moves, so with two batches open for annotation the header used to make a
   * semantic choice on somebody's behalf — a `find` over the wire's own order —
   * and never say that it had. These fix the shape of each arm, and the second
   * one is the guard: reverting to a `find` turns it red.
   */
  const OPEN_PAIR = [
    { id: "44444444-4444-4444-8444-444444444444", name: "closed-run", state: "completed" },
    {
      id: "55555555-5555-4555-8555-555555555555",
      name: "drive-02",
      state: "in_annotation",
      schemaVersion: 2,
      unannotated: 7,
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      name: "drive-03",
      state: "in_annotation",
      schemaVersion: 2,
      unannotated: 12,
    },
  ] as const;

  it("asks which batch when two are open for annotation, instead of picking one", async () => {
    const opened = vi.fn();
    headerFor({ batches: OPEN_PAIR });
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatchChange={opened} />);

    // A split button: the pen jumps to the first (newest) target and says which in its
    // tooltip; the chevron beside it is the one that asks.
    const cta = await screen.findByTestId("go-annotate");
    expect(cta.getAttribute("aria-haspopup")).toBeNull();
    const chevron = screen.getByTestId("go-annotate-menu");
    expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
    expect(chevron.getAttribute("aria-label")).toBe("Choose a batch to annotate");

    await userEvent.click(chevron);

    // Opening the choice navigated nowhere: the choice is the point.
    expect(opened).not.toHaveBeenCalled();
    expect(await screen.findByTestId("annotate-batch-drive-03")).not.toBeNull();
    expect(screen.getByTestId("annotate-batch-drive-02")).not.toBeNull();
  });

  it("lists only the batches work can happen in, newest first, with their remaining count and pinned version", async () => {
    headerFor({ batches: OPEN_PAIR });
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);

    await userEvent.click(await screen.findByTestId("go-annotate-menu"));
    await screen.findByTestId("annotate-batch-drive-03");

    // A completed batch refuses every save, so it is not somewhere to be sent.
    expect(screen.queryByTestId("annotate-batch-closed-run")).toBeNull();
    // `BatchOut` carries no timestamp, so newest-first is the wire's order
    // reversed — `drive-03` arrived last and leads.
    const rows = [...document.querySelectorAll("[data-testid^='annotate-batch-']")];
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "annotate-batch-drive-03",
      "annotate-batch-drive-02",
    ]);
    // Remaining work in the batch table's own words, and the version the pick
    // actually decides — the one consequence invisible everywhere else here.
    expect(rows[0]?.textContent).toContain("12 to do");
    expect(rows[0]?.textContent).toContain("v2");
    expect(rows[1]?.textContent).toContain("7 to do");
  });

  it("opens the batch the menu row names", async () => {
    const opened = vi.fn();
    headerFor({ batches: OPEN_PAIR });
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatchChange={opened} />);

    await userEvent.click(await screen.findByTestId("go-annotate-menu"));
    await userEvent.click(await screen.findByTestId("annotate-batch-drive-02"));

    expect(opened).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555");
  });

  it("does not render Annotate at all when no batch is open for annotation", async () => {
    // `DESIGN.md`'s never-disable rule: a control
    // that leads nowhere is absent, not grey.
    headerFor({ batchState: "draft" });
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);

    await screen.findByTestId("go-ingest");
    expect(screen.queryByTestId("go-annotate")).toBeNull();
  });

  describe("where Add images lives: the batches band on the Overview, the bar on Images, the overflow elsewhere", () => {
    function inBand(): HTMLElement | null {
      return within(screen.getByTestId("overview-batches")).queryByTestId("go-ingest");
    }
    function inToolbar(): HTMLElement | null {
      return within(screen.getByTestId("project-nav")).queryByTestId("go-ingest");
    }

    it("draws it as a ghost icon button before the filled Annotate, at the end of the batches band", async () => {
      headerFor({ batchState: "in_annotation" });
      renderWithData(<ProjectScreen projectId={PROJECT} />);

      const annotate = await screen.findByTestId("go-annotate");
      const ingest = screen.getByTestId("go-ingest");
      expect(ingest.dataset.variant).toBe("ghost");
      expect(ingest.textContent).toBe("");
      expect(ingest.getAttribute("aria-label")).toBe("Add images");
      expect(annotate.dataset.variant).toBe("default");
      expect(annotate.textContent).toBe("Annotate");
      // Add images leads: the DOM order is the visual order.
      expect(ingest.compareDocumentPosition(annotate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(inBand()).toBe(ingest);
      // Last in the band, after the filter.
      const filter = screen.getByTestId("batches-filter");
      expect(filter.compareDocumentPosition(ingest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(filled()).toEqual([annotate]);
    });

    it("keeps it ghost when no batch is open, and draws no Annotate", async () => {
      headerFor({ batchState: "draft" });
      renderWithData(<ProjectScreen projectId={PROJECT} />);

      await screen.findByTestId("overview-batches");
      expect(screen.queryByTestId("go-annotate")).toBeNull();
      expect(screen.getAllByTestId("go-ingest")).toEqual([inBand()]);
      expect(inBand()?.dataset.variant).toBe("ghost");
    });

    it("gives the project bar no Add images on the Overview — not a button, not a menu entry", async () => {
      headerFor({ batchState: "in_annotation" });
      renderWithData(<ProjectScreen projectId={PROJECT} />);

      await screen.findByTestId("go-annotate");
      expect(inToolbar()).toBeNull();
      expect(within(screen.getByTestId("project-nav")).queryByTestId("go-annotate")).toBeNull();
      await userEvent.click(screen.getByTestId("project-menu"));
      await screen.findByTestId("rename-project");
      expect(screen.queryByTestId("menu-ingest")).toBeNull();
    });

    it.each([
      { failing: "batches", pattern: /\/batches$/ },
      { failing: "stats", pattern: /\/stats$/ },
    ])("offers it first in the overflow while the $failing read has failed and the band is not drawn", async ({ pattern }) => {
      const added = vi.fn();
      on("GET", pattern, { status: 500, body: { code: "BOOM", message: "no" } });
      headerFor({ batchState: "in_annotation" });
      renderWithData(<ProjectScreen projectId={PROJECT} onAddImagesOpenChange={added} />);

      await screen.findAllByRole("button", { name: "Try again" });
      expect(screen.queryByTestId("go-ingest")).toBeNull();
      await userEvent.click(screen.getByTestId("project-menu"));
      const item = await screen.findByTestId("menu-ingest");
      expect(item.parentElement?.querySelector('[role="menuitem"]')).toBe(item);
      await userEvent.click(item);
      expect(added).toHaveBeenCalledWith(true);
    });

    it("opens the batch from Annotate even for a host that holds no batch route: the panel holds it", async () => {
      headerFor({ batchState: "in_annotation" });
      renderWithData(<ProjectScreen projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("go-annotate"));
      expect(await screen.findByRole("heading", { level: 2, name: "drive-01" })).toBeTruthy();
    });

    it("opens its own Add images dialog, so a host with no route for it still offers it", async () => {
      headerFor({ batchState: "in_annotation" });
      renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);

      await screen.findByTestId("go-annotate");
      expect(screen.queryByRole("dialog")).toBeNull();
      await userEvent.click(screen.getByTestId("go-ingest"));
      expect(await screen.findByRole("dialog", { name: "Add images" })).not.toBeNull();
      await userEvent.click(screen.getByTestId("add-images-close"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("hands the dialog's open state to a host that holds it, and draws what the host says", async () => {
      headerFor({ batchState: "in_annotation" });
      const change = vi.fn();
      function Host(): JSX.Element {
        const [open, setOpen] = useState(false);
        return (
          <ProjectScreen
            projectId={PROJECT}
            addImagesOpen={open}
            onAddImagesOpenChange={(next) => {
              change(next);
              setOpen(next);
            }}
          />
        );
      }
      renderWithData(<Host />);

      await userEvent.click(await screen.findByTestId("go-ingest"));
      expect(change).toHaveBeenCalledWith(true);
      expect(await screen.findByRole("dialog", { name: "Add images" })).not.toBeNull();
      await userEvent.click(screen.getByTestId("add-images-close"));
      expect(change).toHaveBeenLastCalledWith(false);
    });

    it("draws exactly one filled button, in the toolbar, on the Images section: the subject is images", async () => {
      headerFor({ batchState: "in_annotation", assets: 3 });
      on("GET", /\/assets$/, { status: 200, body: { items: [], total: 0 } });
      renderWithData(<ProjectScreen projectId={PROJECT} tab="images" onOpenBatch={vi.fn()} />);

      await screen.findByTestId("images-screen");
      const ingest = await screen.findByTestId("go-ingest");
      expect(screen.getAllByTestId("go-ingest")).toEqual([inToolbar()]);
      // Not also a menu entry: one way to it per section.
      await userEvent.click(screen.getByTestId("project-menu"));
      await screen.findByTestId("rename-project");
      expect(screen.queryByTestId("menu-ingest")).toBeNull();
      expect(ingest.dataset.variant).toBe("default");
      // Annotate is the Overview's batches band's alone.
      expect(screen.queryByTestId("go-annotate")).toBeNull();
    });

    it.each([
      { tab: "schema", sentinel: "schema-editor" },
      { tab: "dataset", sentinel: "dataset-screen" },
    ] as const)(
      "draws no button on the $tab section, and offers Add images first in the overflow",
      async ({ tab, sentinel }) => {
        const added = vi.fn();
        headerFor({ batchState: "in_annotation", assets: 3 });
        renderWithData(<ProjectScreen projectId={PROJECT} tab={tab} onOpenBatch={vi.fn()} onAddImagesOpenChange={added} />);

        await screen.findByTestId(sentinel);
        expect(screen.queryByTestId("go-ingest")).toBeNull();
        // Annotate belongs to the Overview, where the batches are listed.
        expect(screen.queryByTestId("go-annotate")).toBeNull();

        const trigger = screen.getByTestId("project-menu");
        expect(trigger.getAttribute("aria-label")).toBe("Project actions");
        await userEvent.click(trigger);
        const item = await screen.findByTestId("menu-ingest");
        expect(item.textContent).toBe("Add images");
        // The first entry, ahead of Rename and Delete project.
        expect(item.parentElement?.querySelector('[role="menuitem"]')).toBe(item);
        expect(screen.getByTestId("delete-project").textContent).toBe("Delete project");
        // Still only the bar's menu: never in the section's own content.
        expect(within(screen.getByTestId("project-nav")).queryByTestId("go-ingest")).toBeNull();

        await userEvent.click(item);
        expect(added).toHaveBeenCalledWith(true);
      },
    );
  });

  /*
   * The header's half of the one-filled-button rule.
   *
   * `headerFor` stubs no assets endpoint and no dataset, which is exactly the
   * state a three-second-old project is in — so these run against the same
   * fixtures the rest of the header suite does, with only the schema moving.
   *
   * The count is the claim, so each of these asserts the *total* number of
   * filled buttons in the document rather than the variant of one of them: a
   * test that only checked "Ingest is secondary" would pass with two filled
   * buttons elsewhere, which is the defect that was filed.
   */
  function filled(): readonly HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("button.bg-primary")];
  }

  it("fills the invitation's Add images over an empty, schema-less project, with the other order as prose", async () => {
    // An empty Overview has no batches band, so the invitation's Add images is
    // the page's only one and it is filled; the classes order is a link beneath.
    headerFor({ schema: false, assets: 0 });
    renderWithData(
      <ProjectScreen projectId={PROJECT} onTabChange={vi.fn()} />,
    );

    await screen.findByTestId("first-run-alt");
    expect(filled()).toEqual([screen.getByTestId("overview-ingest")]);
    expect(screen.queryByTestId("go-ingest")).toBeNull();
  });

  it("leaves the filled button to the Overview's invitation: the band's Add images is ghost", async () => {
    headerFor({ schema: false, assets: 48 });
    renderWithData(
      <ProjectScreen projectId={PROJECT} onTabChange={vi.fn()} />,
    );

    const cta = await screen.findByTestId("first-run-cta");
    expect(filled()).toEqual([cta]);
    expect(screen.getByTestId("go-ingest").className).not.toContain("bg-primary");
  });

  it("lets the other order act for a host with no onTabChange, by holding the section itself", async () => {
    // The section is held here when the host does not wire it, so the panel
    // always has a way into Schema and the invitation always has its link. A
    // page that rendered the other order as bare prose would be the right count
    // reached by leaving the person nothing to press.
    headerFor({ schema: false, assets: 0 });
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    const alt = await screen.findByTestId("first-run-alt");
    expect(filled()).toEqual([screen.getByTestId("overview-ingest")]);
    await userEvent.click(alt);
    await screen.findByTestId("schema-editor");
  });

  it("fills the invitation's Add images when the invitation is the ingest one", async () => {
    headerFor({ assets: 0 });
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    await screen.findByTestId("overview-ingest");
    expect(filled()).toEqual([screen.getByTestId("overview-ingest")]);
  });

  it("fills nothing once the project has classes and images but no batch open: Add images stays a ghost icon", async () => {
    headerFor({});
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    await screen.findByTestId("overview-stats");
    expect(screen.queryByTestId("first-run")).toBeNull();
    const ingest = await screen.findByTestId("go-ingest");
    expect(ingest.getAttribute("aria-label")).toBe("Add images");
    expect(filled()).toEqual([]);
  });

  /** The dataset's reads, which put Publish release into the bar. */
  function datasetStubs(): void {
    on("GET", /\/dataset$/, {
      status: 200,
      body: { id: "99999999-9999-4999-8999-999999999999", project_id: PROJECT, name: "highway", description: null },
    });
    on("GET", /\/preprocessing-recipes$/, { status: 200, body: { items: [], total: 0 } });
    on("GET", /\/releases$/, { status: 200, body: { items: [], total: 0 } });
  }

  it("hands the filled button back the moment another section is showing", async () => {
    // The invitation is the *Overview's*. Only the open section is mounted, so a
    // navigation still standing back on the Dataset section would be a page with
    // no forward action at all: here the section's own, Publish release, in the bar.
    headerFor({ schema: false, assets: 0 });
    datasetStubs();
    renderWithData(
      <ProjectScreen projectId={PROJECT} tab="dataset" />,
    );

    const publish = await screen.findByTestId("publish-release");
    expect(screen.queryByTestId("first-run")).toBeNull();
    expect(filled()).toEqual([publish]);
    expect(within(screen.getByTestId("project-nav")).getByTestId("publish-release")).toBe(publish);
    expect(publish.dataset.variant).toBe("default");
  });

  it("keeps one filled control on the Dataset: Publish release on the working copy, none in the bar on a release, whose export is in the column", async () => {
    // A release is exported from its own Export section in the left column, so
    // the bar has no forward action to draw for it, and the recipes chosen there
    // are shelved nowhere else. A pressed toggle is filled to show a selection
    // and is not a forward action: only commands count.
    const commands = (): readonly HTMLElement[] => filled().filter((one) => !one.hasAttribute("aria-pressed"));
    headerFor({});
    on("GET", /\/releases$/, {
      status: 200,
      body: {
        items: [
          {
            id: "88888888-8888-4888-8888-888888888888",
            dataset_id: "99999999-9999-4999-8999-999999999999",
            tag: "v1",
            manifest_hash: "abcdef0123456789",
            schema_version: 1,
            asset_count: 3,
            annotation_count: 0,
            split: null,
            created_at: "2026-07-31T10:00:00.000000Z",
            visionset_version: "0.0.1.dev0",
          },
        ],
        total: 1,
      },
    });
    datasetStubs();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="dataset" />);

    await screen.findByTestId("version-nav");
    const publish = await screen.findByTestId("publish-release");
    expect(within(screen.getByTestId("project-nav")).getByTestId("publish-release")).toBe(publish);
    expect(commands()).toEqual([publish]);
    expect(publish.dataset.variant).toBe("default");
    // The working copy shelves no recipes, and Add images is in the overflow, not a second candidate for the slot.
    expect(screen.queryByTestId("recipe-shelf")).toBeNull();
    expect(screen.queryByTestId("recipe-new")).toBeNull();
    expect(screen.queryByTestId("go-ingest")).toBeNull();

    // A release draws nothing in the bar: its export is a section of the column, with the one filled command that runs it.
    await userEvent.click(await screen.findByTestId("version-v1"));
    const section = await screen.findByTestId("section-export");
    const submit = await within(section).findByTestId("export-submit");
    expect(screen.queryByTestId("publish-release")).toBeNull();
    expect(screen.queryByTestId("export-open")).toBeNull();
    expect(screen.queryByTestId("export-dialog")).toBeNull();
    const bar = screen.getByTestId("project-nav");
    expect(commands().filter((one) => bar.contains(one))).toEqual([]);
    expect(commands()).toEqual([submit]);
    // The row that writes a recipe is in the same section, never a second filled button.
    expect(within(section).getByTestId("recipe-new")).not.toBeNull();
    expect(screen.queryByTestId("recipe-shelf")).toBeNull();
  });

  it("draws New beside the history in the section's band, as its one filled control, not in the project bar", async () => {
    headerFor({});
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    const add = await screen.findByTestId("add-class");
    expect(within(screen.getByTestId("project-nav")).queryByTestId("add-class")).toBeNull();
    // In the band, right after the history's icon button; it says "New" and is named in full.
    const band = screen.getByTestId("schema-editor").querySelector("header");
    expect(band?.contains(add)).toBe(true);
    expect(add.textContent?.trim()).toBe("New");
    expect(add.getAttribute("aria-label")).toBe("New class");
    const history = screen.getByTestId("open-history");
    expect(history.nextElementSibling).toBe(add);
    expect(within(screen.getByTestId("class-list")).queryByTestId("add-class")).toBeNull();
    expect(screen.getAllByTestId("add-class")).toEqual([add]);
    expect(add.dataset.variant).toBe("default");
    expect(filled()).toEqual([add]);
  });

  it("steps Add class back while the draft's Save is the page's filled control", async () => {
    headerFor({});
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    const add = await screen.findByTestId("add-class");
    expect(filled()).toEqual([add]);

    await addNamedClass("pedestrian");

    // One filled control at a time: the commit bar's Save, while it is up.
    await waitFor(() => expect(filled()).toEqual([screen.getByTestId("save-schema")]));
    expect(screen.getByTestId("add-class").dataset.variant).toBe("outline");
  });

  it("keeps Add class in the section for an empty draft, and draws none in the bar", async () => {
    headerFor({ schema: false });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    const add = await screen.findByTestId("add-class");
    expect(within(screen.getByTestId("project-nav")).queryByTestId("add-class")).toBeNull();
    expect(screen.getAllByTestId("add-class")).toEqual([add]);
  });

  it("moves Rename into the overflow, so only two buttons show", async () => {
    headerFor({ batchState: "in_annotation" });
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);

    await screen.findByTestId("go-annotate");
    // Rename is behind the menu, so it is not in the document yet.
    expect(screen.queryByTestId("rename-project")).toBeNull();

    await userEvent.click(screen.getByTestId("project-menu"));

    expect(await screen.findByTestId("rename-project")).not.toBeNull();
    // **No Dataset item.** It was in this menu because the dataset had no tab of
    // its own; it has one now, and the same destination in a tab bar *and* a
    // hidden menu is two answers to one question — the second of which nobody
    // finds.
    expect(screen.queryByTestId("go-dataset")).toBeNull();
    expect(screen.queryByTestId("delete-project")).not.toBeNull();
  });

  it("states the blast radius in counted terms before deleting anything", async () => {
    headerFor({});
    renderWithData(<ProjectScreen projectId={PROJECT} />);

    await screen.findByTestId("project-menu");
    await userEvent.click(screen.getByTestId("project-menu"));
    await userEvent.click(await screen.findByTestId("delete-project"));

    const said = (await screen.findByTestId("delete-blast-radius")).textContent ?? "";
    expect(said).toContain((1248).toLocaleString(undefined));
    expect(said).toContain((6431).toLocaleString(undefined));
    // The one thing a delete does *not* do, said out loud.
    expect(said).toContain("not removed");
  });

  it("sends the delete and then hands the host somewhere to go", async () => {
    headerFor({});
    on("DELETE", /^\/projects\/[^/]+$/, { status: 204 });
    const gone = vi.fn();
    renderWithData(<ProjectScreen projectId={PROJECT} onDeleted={gone} />);

    await screen.findByTestId("project-menu");
    await userEvent.click(screen.getByTestId("project-menu"));
    await userEvent.click(await screen.findByTestId("delete-project"));
    await userEvent.click(await screen.findByTestId("delete-submit"));

    await waitFor(() => expect(gone).toHaveBeenCalledOnce());
  });
});
