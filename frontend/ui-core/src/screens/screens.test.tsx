/**
 * The project screens, driven against a stubbed `fetch`.
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

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type JSX, type ReactNode } from "react";

// `VisionSetDataProvider` and `QueryClient` stay direct imports: three tests
// below build their own local `wrap` that a `rerender` reuses across a prop
// change, which needs the same `client` identity (and the same `QueryClient`,
// since they assert on its cache) present on both sides of the rerender —
// something `renderWithData`'s result cannot give a caller-driven `rerender`.
// See each local `wrap` below.
import { Toaster, TooltipProvider } from "@robomous/ui-core";
import { VisionSetDataProvider } from "../data/VisionSetDataProvider";
import { formatCount, formatPercent, formatWhen } from "../lib/format";
import { classColor, hexColor } from "../palette";
import { ProjectScreen } from "./ProjectScreen";
import { PageStatusOutlet, PageStatusProvider } from "../patterns/PageStatus";
import { ProjectsScreen } from "./ProjectsScreen";
import type { ProjectListItem } from "./queries";
import {
  usePreviewSchemaChange,
  useSchemaBlockingAssets,
  type LabelClassBody,
  type SchemaChangePreview,
} from "./queries";
import { harnessClient, renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { batchActions } from "../testing/wire.fixtures.js";
import type { components as capComponents } from "../generated/api.js";

type BatchState = capComponents["schemas"]["BatchState"];

const PROJECT = "11111111-1111-4111-8111-111111111111";
/** A second project, for the draft that must not follow somebody into it. */
const OTHER_PROJECT = "77777777-7777-4777-8777-777777777777";

/** One route table, matched in order. A miss is a loud 500 rather than a hang. */
type HandlerAnswer = { status: number; body: unknown } | undefined;
type Handler = (request: Request) => HandlerAnswer | Promise<HandlerAnswer>;

let handlers: Handler[] = [];
const sent: Request[] = [];
/**
 * What each request carried, captured before the client consumes it.
 *
 * Cloned rather than read later: a `Request` body is a one-shot stream, so a test
 * asking for it after the fact gets nothing. The colour-input claim needs it —
 * is about the payload a save actually sends, not about what the control shows.
 */
const bodies = new Map<Request, string>();

/**
 * A minimal stand-in for `SchemaDraftService`, keyed by project id — the schema
 * editor now writes the shared draft before every publish, so `save-schema`
 * needs a `PUT .../schema/drafts/{kind}` that actually answers rather than the
 * loud 500 an unmatched route gets everywhere else in this file. No test here
 * exercises `STALE_WRITE` — that belongs to `schemaDraft.test.tsx`, which owns
 * the fuller simulation — so this one only ever creates and re-saves.
 */
let curatedDrafts: Map<
  string,
  { project_id: string; kind: string; classes: unknown[]; note: string; based_on: number | null; revision: number; updated_at: string }
>;

/** `/projects/{id}/schema/drafts/{kind}`'s `id`, or `null` off that path. */
function draftProjectId(path: string): string | null {
  const match = /^\/projects\/([^/]+)\/schema\/drafts\/[^/]+$/.exec(path);
  return match ? match[1] : null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  // The class dialog's fields sit in a `<form>`, where a Radix Checkbox measures
  // itself through `ResizeObserver`; jsdom has none. `afterEach` unstubs it.
  stubResizeObserver();
  handlers = [];
  sent.length = 0;
  bodies.clear();
  curatedDrafts = new Map();
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    if (request.method !== "GET") bodies.set(request, await request.clone().text());
    for (const handler of handlers) {
      const answer = await handler(request);
      if (answer !== undefined) {
        return Promise.resolve(
          new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
            status: answer.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }
    const path = new URL(request.url).pathname;
    const draftProject = draftProjectId(path);
    if (draftProject !== null && request.method === "GET") {
      const stored = curatedDrafts.get(draftProject);
      return Promise.resolve(
        stored === undefined
          ? jsonResponse(404, { code: "SCHEMA_DRAFT_NOT_FOUND", message: "no draft yet" })
          : jsonResponse(200, stored),
      );
    }
    if (draftProject !== null && request.method === "PUT") {
      const written = JSON.parse(bodies.get(request) ?? "{}") as {
        classes: unknown[];
        note: string;
        based_on: number | null;
      };
      const saved = {
        project_id: draftProject,
        kind: "curated",
        classes: written.classes,
        note: written.note,
        based_on: written.based_on,
        revision: (curatedDrafts.get(draftProject)?.revision ?? 0) + 1,
        updated_at: "2024-01-01T00:00:00Z",
      };
      curatedDrafts.set(draftProject, saved);
      return Promise.resolve(jsonResponse(200, saved));
    }
    if (path.endsWith("/schema/preview") && request.method === "POST") {
      return Promise.resolve(
        jsonResponse(200, {
          diff: { changes: [], destructive_classes: [], is_destructive: false },
          blockers: [],
          is_refused: false,
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ code: "NO_STUB", message: `${request.method} ${request.url}` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
});

function on(method: string, pattern: RegExp, answer: { status: number; body?: unknown }): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname + new URL(request.url).search)
      ? { status: answer.status, body: answer.body ?? null }
      : undefined,
  );
}

/** The text of every element a dialog's `aria-describedby` reaches. */
function describedBy(dialog: HTMLElement): readonly (string | null)[] {
  return (dialog.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? null);
}

const CLASSES = [
  { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
  { name: "lane", geometries: ["polygon"], color: null, attributes: [] },
];

function PreviewSchemaChangeProbe({
  projectId,
  classes,
}: {
  readonly projectId: string;
  readonly classes: readonly LabelClassBody[];
}): JSX.Element {
  const preview = usePreviewSchemaChange(projectId);
  const [result, setResult] = useState<SchemaChangePreview | null>(null);

  return (
    <div>
      <button
        data-testid="preview-schema-change"
        onClick={() => {
          void preview.mutateAsync({ classes }).then(setResult);
        }}
      >
        preview
      </button>
      {result === null ? null : (
        <p data-testid="preview-result">
          {`${result.diff.destructive_classes.join(",")}:${result.blockers[0]?.annotations}:${result.blockers[0]?.assets}:${result.is_refused}`}
        </p>
      )}
    </div>
  );
}

function SchemaBlockingAssetsProbe({
  projectId,
  classes,
}: {
  readonly projectId: string;
  readonly classes: readonly LabelClassBody[] | null;
}): JSX.Element {
  const query = useSchemaBlockingAssets(projectId, classes);
  return (
    <div data-testid="blocking-assets-result">
      {query.data === undefined
        ? "pending"
        : `${query.data.total}:${query.data.items[0]?.annotations}:${query.data.items[0]?.batch_ids.length}`}
    </div>
  );
}

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
    expect(screen.getByRole("columnheader", { name: /images/i }).getAttribute("aria-sort")).toBe("descending");
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
    expect(stage("fresh")).toBe("No images");
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
    expect(tag.getAttribute("title")).toMatch(/^8,460 images · published /);
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
    expect(screen.getByTestId("projects-images").textContent).toBe("10 images · 10 to annotate");
    expect(screen.getByTestId("projects-screen").contains(screen.getByTestId("projects-images"))).toBe(false);
    // The count is the footer's alone: the status bar does not say it again.
    expect(screen.queryByTestId("projects-totals")).toBeNull();
    const table = screen.getByRole("table", { name: "Projects" });
    expect(table).toBe(screen.getByTestId("projects-table"));
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Project", "Images", "Annotated", "Classes", "Status", "Release", "Activity", "Actions"]);
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
    expect(cell.getAttribute("title")).toBe("25% of images annotated");
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
    expect(screen.getByTestId("projects-images").textContent).toBe("13 images · 11 to annotate");
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
    expect(images.textContent).toBe("400 images · 50 to annotate");
    expect(screen.queryByTestId("projects-review")).toBeNull();
    expect(screen.queryByTestId("projects-table-totals")).toBeNull();

    await userEvent.type(screen.getByTestId("projects-search"), "m4");

    // What the search hid is said, never dropped — and the rest follows the rows left.
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1 project · filtered from 2");
    expect(screen.getByTestId("projects-images").textContent).toBe("100 images · 50 to annotate");
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
    expect(screen.getByTestId("projects-images").textContent).toBe("1 image · 1 to annotate");
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
    expect(screen.getByTestId("projects-sort").textContent).toBe("Sorted byImages");
    expect(screen.getByRole("columnheader", { name: /images/i }).getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("columnheader", { name: /activity/i }).getAttribute("aria-sort")).toBe("none");

    // Which way, in the same menu.
    await userEvent.click(screen.getByTestId("projects-sort"));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Ascending" }));
    expect(rowNames()).toEqual(["small", "middle", "large"]);
    expect(screen.getByRole("columnheader", { name: /images/i }).getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByTestId("projects-sort").textContent).toBe("Sorted byImages");

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
    expect(screen.getByTitle("No images in this project yet.")).not.toBeNull();
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
    expect(screen.getByTestId("projects-images").textContent).toMatch(/^1,830 images/);

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
function classCards(): HTMLElement[] {
  const list = screen.queryByTestId("class-list");
  return list === null ? [] : [...list.querySelectorAll<HTMLElement>('button[data-testid^="class-card-"]')];
}

/**
 * Put the open class dialog away with its submit — Save, or Add to draft — the
 * way a person finishes with a class before moving on. A dialog is modal, so a
 * test that leaves one open would find the page behind it inert; and an edit
 * only reaches the draft when it is submitted, so this is also what makes what
 * was typed count.
 */
async function closeSheet(): Promise<void> {
  if (screen.queryByTestId("class-sheet") === null) return;
  await userEvent.click(screen.getByTestId("class-sheet-done"));
  await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
}

/** Whether the commit bar is up: the draft differs from the version in force. */
function barState(): string | null {
  return screen.queryByTestId("commit-bar")?.getAttribute("data-state") ?? null;
}

/** The History sheet, opened from the band if it is not open already. */
async function openHistory(): Promise<HTMLElement> {
  if (screen.queryByTestId("history-sheet") === null) {
    await userEvent.click(await screen.findByTestId("open-history"));
  }
  return screen.findByTestId("version-history");
}

/** A version's entry in the History sheet. */
async function historyEntry(version: number): Promise<HTMLElement> {
  const history = await openHistory();
  return within(history).findByTestId(`version-${version}`);
}

/** Show a published version in the table, through its History entry's View. */
async function viewVersion(version: number): Promise<void> {
  const entry = await historyEntry(version);
  await userEvent.click(within(entry).getByTestId(`view-version-${version}`));
  await waitFor(() => expect(screen.queryByTestId("history-sheet")).toBeNull());
}

/**
 * The controls in a read-only table that would be an edit: everything but the
 * buttons that open a row to read it and the hints a hover or focus opens.
 */
function editAffordances(table: HTMLElement): HTMLElement[] {
  return [...table.querySelectorAll<HTMLElement>("button, input, textarea, select, [role=switch], [role=combobox]")].filter((control) => {
    const id = control.dataset.testid ?? "";
    return !/^past-class-\d+$/.test(id) && !/^class-mark-/.test(id) && !/^class-attributes-/.test(id);
  });
}

/** Put the open class dialog away without keeping anything typed in it. */
async function cancelSheet(): Promise<void> {
  if (screen.queryByTestId("class-sheet") === null) return;
  await userEvent.click(screen.getByTestId("class-dialog-cancel"));
  await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
}

/** Add a class: name it in the dialog `Add class` opens, and add it to the draft. */
async function addNamedClass(name: string, slot = CLASSES.length): Promise<void> {
  await userEvent.click(screen.getByTestId("add-class"));
  await userEvent.type(screen.getByTestId(`class-name-${slot}`), name);
  await closeSheet();
}

describe("the schema editor", () => {
  function projectWithSchema(): void {
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
      body: { project_id: PROJECT, version: 3, classes: CLASSES },
    });
    on("GET", /schema\/versions$/, {
      status: 200,
      body: {
        items: [
          { project_id: PROJECT, version: 1, classes: [CLASSES[0]] },
          { project_id: PROJECT, version: 2, classes: CLASSES },
          { project_id: PROJECT, version: 3, classes: CLASSES },
        ],
        total: 3,
      },
    });
  }

  /** Open one class's dialog, putting away whichever one was open first. */
  async function selectClass(index: number): Promise<void> {
    await closeSheet();
    await userEvent.click(screen.getByTestId(`class-card-${index}`));
    await screen.findByTestId(`class-${index}`);
  }

  /** Remove a class from its open dialog; the dialog closes with it. */
  async function removeClass(index: number): Promise<void> {
    await selectClass(index);
    await userEvent.click(screen.getByTestId(`remove-class-${index}`));
    await waitFor(() => expect(classCards()).toHaveLength(CLASSES.length - 1));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
  }

  it("previews a candidate without lane and reads its orphan blockers", async () => {
    const candidate: readonly LabelClassBody[] = [
      { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
    ];
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });

    renderWithData(<PreviewSchemaChangeProbe projectId={PROJECT} classes={candidate} />);
    await userEvent.click(screen.getByTestId("preview-schema-change"));

    await waitFor(() =>
      expect(screen.getByTestId("preview-result").textContent).toBe("lane:12:3:true"),
    );
    const request = sent.find(
      (sentRequest) =>
        sentRequest.method === "POST" && new URL(sentRequest.url).pathname.endsWith("/schema/preview"),
    );
    if (request === undefined) throw new Error("Expected a schema preview request");
    expect(JSON.parse(bodies.get(request) ?? "")).toEqual({ classes: candidate });
    expect(
      sent.some(
        (sentRequest) =>
          sentRequest.method === "POST" &&
          new URL(sentRequest.url).pathname.endsWith("/schema/drafts/curated/publish"),
      ),
    ).toBe(false);
  });

  it("reads the blocking frames off the typed listing", async () => {
    const ASSET = "22222222-2222-4222-8222-222222222222";
    const BATCH = "33333333-3333-4333-8333-333333333333";
    on("POST", /\/schema\/blocking-assets$/, {
      status: 200,
      body: {
        items: [
          {
            asset: {
              id: ASSET,
              project_id: PROJECT,
              modality: "image",
              point_cloud: null,
              content_hash: "deadbeef",
              format: "jpeg",
              width: 1920,
              height: 1080,
              frame_index: null,
              frame_timestamp: null,
              source_id: null,
              thumbnail_hash: "abc",
              ingested_at: "2024-01-01T00:00:00Z",
            },
            label_classes: ["lane"],
            annotations: 12,
            batch_ids: [BATCH],
          },
        ],
        total: 1,
      },
    });

    renderWithData(<SchemaBlockingAssetsProbe projectId={PROJECT} classes={[]} />);

    await waitFor(() =>
      expect(screen.getByTestId("blocking-assets-result").textContent).toBe("1:12:1"),
    );
  });

  it("stays disabled while nothing is proposed", () => {
    renderWithData(<SchemaBlockingAssetsProbe projectId={PROJECT} classes={null} />);
    expect(screen.getByTestId("blocking-assets-result").textContent).toBe("pending");
    expect(
      sent.some((sentRequest) => new URL(sentRequest.url).pathname.endsWith("/schema/blocking-assets")),
    ).toBe(false);
  });

  it("hashes a proposal's property order out of the key, not just its members", async () => {
    on("POST", /\/schema\/blocking-assets$/, { status: 200, body: { items: [], total: 0 } });

    // Same class, two builds: `color` before `attributes` versus after. Two
    // logically-identical proposals reaching this hook by different code paths
    // must share a cache entry — TanStack's own key hash sorts object keys for
    // exactly this reason, and pre-stringifying here would have thrown that away.
    const classesA: readonly LabelClassBody[] = [
      { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
    ];
    const classesB: readonly LabelClassBody[] = [
      { color: "#38bdf8", attributes: [], name: "vehicle", geometries: ["bbox"] },
    ];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = harnessClient();
    const scope = Symbol("schema-blocking-assets-test");
    const wrap = (node: ReactNode): JSX.Element => (
      <TooltipProvider>
        <VisionSetDataProvider client={client} scope={scope} makeQueryClient={() => queryClient}>
          {node}
        </VisionSetDataProvider>
      </TooltipProvider>
    );

    const { rerender } = render(
      wrap(<SchemaBlockingAssetsProbe projectId={PROJECT} classes={classesA} />),
    );
    await waitFor(() =>
      expect(screen.getByTestId("blocking-assets-result").textContent).toBe("0:undefined:undefined"),
    );

    rerender(wrap(<SchemaBlockingAssetsProbe projectId={PROJECT} classes={classesB} />));
    await waitFor(() =>
      expect(screen.getByTestId("blocking-assets-result").textContent).toBe("0:undefined:undefined"),
    );

    expect(
      sent.filter((sentRequest) =>
        new URL(sentRequest.url).pathname.endsWith("/schema/blocking-assets"),
      ),
    ).toHaveLength(1);
  });

  /**
   * The frames behind a refusal are listed in the refusal's own dialog, and only
   * there. The page has no section for them; they are one press from every place
   * that mentions them, and they are asked about when that dialog opens — not on
   * page load, and not on a timer of their own.
   */
  it("lists the frames in the way inside the refusal, and links each to every batch holding it", async () => {
    const ASSET = "22222222-2222-4222-8222-222222222222";
    const BATCH = "33333333-3333-4333-8333-333333333333";
    const CORRECTION = "44444444-4444-4444-8444-444444444444";
    projectWithSchema();
    // The full wire shape: `useBatches` validates the response, and a listing
    // that fails validation is a query with no data — which reads here as every
    // link falling back to "Open batch".
    const batch = (id: string, name: string): Record<string, unknown> => ({
      id,
      project_id: PROJECT,
      name,
      state: "in_annotation",
      asset_count: 4,
      schema_version: 3,
      progress: {
        unannotated: 4,
        pre_labeled: 0,
        annotated: 0,
        skipped: 0,
        review_pending: 0,
        accepted: 0,
        total: 4,
      },
      allowed_actions: batchActions("in_annotation"),
      promoted_asset_count: 0,
      parent_batch_id: null,
      pre_label_run: null,
    });
    on("GET", /\/batches$/, {
      status: 200,
      body: { items: [batch(BATCH, "survey"), batch(CORRECTION, "fixes")], total: 2 },
    });
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    on("POST", /\/schema\/blocking-assets/, {
      status: 200,
      body: {
        items: [
          {
            asset: {
              id: ASSET,
              project_id: PROJECT,
              modality: "image",
              point_cloud: null,
              content_hash: "deadbeef",
              format: "jpeg",
              width: 1920,
              height: 1080,
              frame_index: 42,
              frame_timestamp: null,
              source_id: null,
              thumbnail_hash: null,
              ingested_at: "2024-01-01T00:00:00Z",
            },
            label_classes: ["lane"],
            annotations: 12,
            batch_ids: [BATCH, CORRECTION],
          },
        ],
        // Every blocking frame, not this page's size: the list says how many
        // there are and how many of them it is showing.
        total: 30,
      },
    });
    const opened = vi.fn();
    const asks = (): Request[] =>
      sent.filter((request) => new URL(request.url).pathname.endsWith("/schema/blocking-assets"));

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" onOpenBatch={opened} />);
    await screen.findByTestId("schema-editor");
    // Nothing on the page, and nothing asked: there is no frames section to fill.
    expect(screen.queryByTestId("blocking-assets")).toBeNull();
    expect(asks()).toHaveLength(0);

    await selectClass(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("“lane” can’t be removed yet");
    expect(within(dialog).getByTestId("orphan-close").textContent).toBe("Keep lane");
    expect(dialog.textContent).toContain("open a batch below to clear or relabel a frame");
    const panel = await within(dialog).findByTestId("blocking-assets");
    await within(panel).findByTestId("blocking-asset-list");
    expect(panel.textContent).toContain("12");
    expect(panel.textContent).toContain("lane");
    // Two rows reading "12 labels under lane" would be one row to a screen
    // reader, so the frame names itself.
    expect(panel.textContent).toContain("Frame 42");
    // `total` counts every blocking frame and the request is windowed, so the
    // panel states the whole number and how much of it is on screen.
    expect(within(dialog).getByTestId("blocking-asset-count").textContent).toContain("30");
    // The clause too, not only the number: a count with no window stated is a
    // panel silently showing 12 of 30.
    expect(within(dialog).getByTestId("blocking-asset-count").textContent).toContain(
      "showing the first",
    );
    // Asked once, with the proposal the refusal was about — the draft without
    // the class being removed — and windowed.
    expect(asks()).toHaveLength(1);
    expect(new URL(asks()[0].url).searchParams.get("limit")).toBe("12");
    expect(JSON.parse(bodies.get(asks()[0]) ?? "")).toEqual({ classes: [CLASSES[0]] });
    // An asset is held by many batches — `batches_holding` returns a list, and an
    // annotation names no batch at all — so the row offers all of them rather
    // than picking one there is no stored fact to prefer.
    const links = within(panel).getAllByTestId("blocking-asset-batch");
    expect(links).toHaveLength(2);
    // Named from the batch listing: three links all reading "Open batch" would
    // name no destination between them.
    expect(links[0].textContent).toContain("survey");
    expect(links[1].textContent).toContain("fixes");
    await userEvent.click(links[0]);
    expect(opened).toHaveBeenCalledWith(BATCH);
  });

  /**
   * The rail settles its preview on the draft's classes, and `useSettled` holds
   * that value across a props change — while this screen is re-rendered rather
   * than remounted when `:projectId` does. A rail that survived the switch would
   * ask the arriving project about the classes it settled on under the departing
   * one. `key={projectId}` is what remounts it, and this is the probe that says so.
   *
   * The arriving project has a stored draft that differs from its active version,
   * so it is dirty from its first render: the rail asks about it at once, and the
   * only list a surviving timer could hand it is the departing project's. Both
   * halves of the setup are load-bearing. The arriving project is rendered
   * **first** so its schema and draft are cached — without that `SchemaSection`
   * renders `LoadingState`, the rail unmounts on its own, and the bug hides. And
   * the typing is followed by a real pause, so the settle actually fires under the
   * departing project — a switch inside the debounce window clears the pending
   * timer and the probe passes whether or not the key is there.
   */
  it("does not carry a settled preview across a project switch", async () => {
    projectWithSchema();
    curatedDrafts.set(OTHER_PROJECT, {
      project_id: OTHER_PROJECT,
      kind: "curated",
      classes: [CLASSES[0]],
      note: "",
      based_on: 3,
      revision: 1,
      updated_at: "2024-01-01T00:00:00Z",
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = harnessClient();
    const scope = Symbol("project-switch-test");
    const wrap = (projectId: string): JSX.Element => (
      <TooltipProvider>
        <VisionSetDataProvider client={client} scope={scope} makeQueryClient={() => queryClient}>
          <ProjectScreen projectId={projectId} tab="schema" onOpenBatch={vi.fn()} />
        </VisionSetDataProvider>
      </TooltipProvider>
    );
    const previewsUnder = (projectId: string): Request[] =>
      sent.filter((request) => {
        const path = new URL(request.url).pathname;
        return path.startsWith(`/projects/${projectId}/`) && path.endsWith("/schema/preview");
      });

    // The project switched *to*, first, so its own queries are warm when it
    // comes back — otherwise the rail is unmounted by its own loading state.
    const view = render(wrap(OTHER_PROJECT));
    await screen.findByTestId("schema-editor");
    await waitFor(() => expect(previewsUnder(OTHER_PROJECT).length).toBeGreaterThan(0));
    const before = previewsUnder(OTHER_PROJECT).length;

    view.rerender(wrap(PROJECT));
    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "PEDESTRIAN");
    // The class reaches the draft when it is added, and the draft is what the
    // rail asks about.
    await closeSheet();
    // Long enough for the settle to fire here, which is the whole point: the
    // value the rail is holding when the switch lands must be this project's.
    await waitFor(() => {
      const asked = previewsUnder(PROJECT).map((request) => bodies.get(request) ?? "");
      expect(asked.some((body) => body.includes("PEDESTRIAN"))).toBe(true);
    });

    view.rerender(wrap(OTHER_PROJECT));
    await screen.findByTestId("schema-editor");
    await new Promise((resolve) => setTimeout(resolve, 600));

    // The arriving project is still dirty and is not asked about the departing
    // one's classes — whichever way its own preview was answered.
    for (const request of previewsUnder(OTHER_PROJECT)) {
      expect(bodies.get(request) ?? "").not.toContain("PEDESTRIAN");
    }
    expect(previewsUnder(OTHER_PROJECT).length).toBeGreaterThanOrEqual(before);
  });

  /**
   * The version being read is state of the editor, and the editor is keyed by
   * project — so a version somebody was looking at in one project is not the one
   * the next project opens on.
   */
  it("opens a project on its draft, not on the version read in the one before it", async () => {
    projectWithSchema();
    on("GET", /schema\/compare/, {
      status: 200,
      body: { is_destructive: false, destructive_classes: [], changes: [] },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = harnessClient();
    const scope = Symbol("project-switch-viewing-test");
    const wrap = (projectId: string): JSX.Element => (
      <TooltipProvider>
        <VisionSetDataProvider client={client} scope={scope} makeQueryClient={() => queryClient}>
          <ProjectScreen projectId={projectId} tab="schema" />
        </VisionSetDataProvider>
      </TooltipProvider>
    );

    const view = render(wrap(OTHER_PROJECT));
    await screen.findByTestId("schema-editor");
    view.rerender(wrap(PROJECT));
    await viewVersion(1);
    await screen.findByTestId("past-version");

    view.rerender(wrap(OTHER_PROJECT));

    await screen.findByTestId("class-list");
    expect(screen.queryByTestId("past-version")).toBeNull();
    expect(screen.getByTestId("save-schema")).not.toBeNull();
  });

  /**
   * The rail asks the server what saving would change, and it asks about the
   * name somebody meant: a settled proposal, not a keystroke. A clean draft
   * publishes nothing, so it is not asked about at all.
   */
  it("asks once the class name stops changing, not once per keystroke", async () => {
    projectWithSchema();

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    const asks = (): Request[] =>
      sent.filter(
        (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/schema/preview"),
      );
    // Nothing has changed, so there is nothing to say about it.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(asks()).toHaveLength(0);

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    // The dialog buffers: ten keystrokes change nothing the draft holds, so the
    // server — which walks every annotation in the project for each answer — is
    // asked about none of them, nor about the nine prefixes of the name.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(asks()).toHaveLength(0);

    // The class is added once, whole, and that is what the rail asks about.
    await closeSheet();
    await waitFor(() => expect(asks().length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 600));

    // A bound rather than an exact count: a slow machine can outlast one 400ms
    // settle window, which makes a further ask correct behaviour. What is not a
    // race is that the last question asked is about the whole name.
    expect(asks().length).toBeLessThan(5);
    expect(bodies.get(asks()[asks().length - 1] as Request)).toContain("pedestrian");
    // An unnamed class is never part of a proposal: it is not a class
    // `POST /preview` accepts.
    for (const request of asks()) {
      for (const declared of (JSON.parse(bodies.get(request) ?? "{}") as { classes: { name: string }[] }).classes) {
        expect(declared.name).not.toBe("");
      }
    }
  });

  /**
   * `ProjectScreen` is *re-rendered* rather than remounted when the route's
   * `:projectId` changes, and nothing clears the draft it holds — so a draft
   * typed in one project is still in hand while another one is on screen. Every
   * read of it goes through `shownDraft`'s project guard, and the rail is the
   * one that would otherwise POST project A's classes to project B's API and
   * invite somebody to go clear real annotations over a narrowing nobody
   * proposed there.
   */
  it("never asks one project's API about another project's draft", async () => {
    projectWithSchema();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = harnessClient();
    const scope = Symbol("schema-draft-cross-project-test");
    const wrap = (node: ReactNode): JSX.Element => (
      <TooltipProvider>
        <VisionSetDataProvider client={client} scope={scope} makeQueryClient={() => queryClient}>
          {node}
        </VisionSetDataProvider>
      </TooltipProvider>
    );

    const view = render(
      wrap(<ProjectScreen projectId={PROJECT} tab="schema" onOpenBatch={vi.fn()} />),
    );
    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    await closeSheet();
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");

    view.rerender(wrap(<ProjectScreen projectId={OTHER_PROJECT} tab="schema" onOpenBatch={vi.fn()} />));

    // The arriving project shows its own, untouched draft…
    await waitFor(() =>
      expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes"),
    );
    // …and long enough for the settle to have fired the departing project's
    // proposal too, had anything been holding it.
    await new Promise((resolve) => setTimeout(resolve, 600));
    // …and nothing under it ever carries the class somebody typed in the project
    // they left.
    for (const request of sent.filter((sentRequest) =>
      new URL(sentRequest.url).pathname.startsWith(`/projects/${OTHER_PROJECT}/`),
    )) {
      expect(bodies.get(request) ?? "").not.toContain("pedestrian");
    }
    expect(
      sent.some(
        (request) =>
          new URL(request.url).pathname.startsWith(`/projects/${OTHER_PROJECT}/`) &&
          new URL(request.url).pathname.endsWith("/schema/preview"),
      ),
    ).toBe(false);
  });

  it("lists no frames on the page, and asks about none until a refusal opens the dialog", async () => {
    projectWithSchema();
    on("POST", /\/schema\/blocking-assets/, { status: 200, body: { items: [], total: 0 } });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" onOpenBatch={vi.fn()} />);

    await screen.findByTestId("schema-editor");
    // The frames used to be a section under the editor, asked about on load and
    // again per keystroke. They are the refusal dialog's now, so the page itself
    // neither shows them nor pays for them.
    expect(screen.queryByTestId("blocking-assets")).toBeNull();
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByTestId("blocking-assets")).toBeNull();
    expect(
      sent.some((request) =>
        new URL(request.url).pathname.endsWith("/schema/blocking-assets"),
      ),
    ).toBe(false);
  });

  it("treats a schema-less project as an empty draft, not as an error", async () => {
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: {
        id: PROJECT,
        name: "fresh",
        description: null,
        thumbnail_asset_id: null,
        thumbnail_hash: null,
        created_at: null,
      },
    });
    // A project starts schema-less on purpose. This 404 is the normal state
    // of a project three seconds old, and an error surface here would tell a new
    // user their project is broken.
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 404,
      body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
    });
    on("GET", /schema\/versions$/, { status: 200, body: { items: [], total: 0 } });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    await waitFor(() => expect(screen.queryByTestId("schema-editor")).not.toBeNull());
    expect(screen.queryByTestId("schema-error")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).toContain("Saving creates version 1");
    expect(screen.getByTestId("save-schema").textContent).toBe("Save version 1");
    // Nothing is published yet, so there is no history to open and nothing to
    // compare a draft against.
    expect(screen.queryByTestId("open-history")).toBeNull();
  });

  it("edits a draft and publishes it as the next version", async () => {
    projectWithSchema();
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { project_id: PROJECT, version: 4, classes: CLASSES }, advanced_batches: [] },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    // Versioning is on demand: a clean draft has nothing to save, so the bar
    // that saves it is down — inert, and hidden from assistive tech — while
    // the status line says where the project stands for whoever cannot see it.
    expect(screen.getByTestId("schema-status").textContent).toContain("Version 3 active");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    expect(barState()).toBe("down");
    expect(screen.getByTestId("commit-bar").hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("commit-bar").getAttribute("aria-hidden")).toBe("true");
    // The button names the version it would publish.
    expect(screen.getByTestId("save-schema").textContent).toBe("Save version 4");
    // Reached anyway, a save of nothing answers rather than sending anything.
    await userEvent.click(screen.getByTestId("save-schema"));
    expect(sent.some((r) => r.method === "POST")).toBe(false);

    await userEvent.click(screen.getByTestId("add-class"));
    // A nameless class is refused the same way, not by a grey button:
    // `normalize_name` refuses a blank, so this mirrors the API's rule — and it
    // is refused at the dialog, so no nameless class ever reaches the draft.
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    expect((await screen.findByTestId("class-name-error-2")).textContent).toBe("Name this class.");
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    // The rail's own settled previews are questions, not writes, so what must
    // not go out is a publish.
    expect(
      sent.some(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname.endsWith("/publish"),
      ),
    ).toBe(false);

    await userEvent.type(screen.getByTestId("class-name-2"), "pedestrian");
    await closeSheet();
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes create v4");
    // The bar rises with the first edit, reachable now.
    expect(barState()).toBe("up");
    expect(screen.getByTestId("commit-bar").hasAttribute("inert")).toBe(false);
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() =>
      expect(
        sent.some(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
        ),
      ).toBe(true),
    );
    const request = sent.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
    );
    expect(request).toBeDefined();
    // The plain save carries no gate — `allow_destructive` is only ever sent
    // after the API has said it is needed.
    expect(new URL(request?.url ?? "").searchParams.get("allow_destructive")).toBeNull();
  });

  /**
   * A row's mark is what the draft does to its class, read off the kernel's own
   * answer by name. Only a draft that differs from the active version has
   * anything to say, so a clean ledger is unmarked.
   */
  it("marks a draft's rows with what saving would do to each, and lists the changes", async () => {
    projectWithSchema();
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        is_refused: false,
        blockers: [],
        diff: {
          is_destructive: false,
          destructive_classes: [],
          changes: [
            { kind: "additive", label_class: "pedestrian", attribute: null, detail: "class 'pedestrian' added" },
            {
              kind: "additive",
              label_class: "vehicle",
              attribute: "lit",
              detail: "optional attribute 'lit' added to 'vehicle'",
            },
          ],
        },
      },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    expect(document.querySelectorAll('[data-testid^="class-mark-"]')).toHaveLength(0);
    expect(screen.queryByTestId("draft-changes")).toBeNull();

    await addNamedClass("pedestrian");

    // New is known the moment the class is named; Changed is the kernel's, so it
    // waits for the settled answer.
    expect(screen.getByTestId("class-mark-2").textContent).toBe("New");
    await waitFor(() => expect(screen.getByTestId("class-mark-0").textContent).toBe("Changed"));
    // `lane` was not touched, and a row with nothing to say carries nothing.
    expect(screen.queryByTestId("class-mark-1")).toBeNull();
    // The mark is a description of the row, not part of its name: "Edit
    // pedestrian" is still what it is called, and a screen reader hears the mark
    // after it.
    const card = screen.getByTestId("class-card-2");
    expect(card.getAttribute("aria-label")).toBe("Edit pedestrian");
    expect(document.getElementById(card.getAttribute("aria-describedby") ?? "")?.textContent).toBe("New");
    // The bar counts the same answer, and its Review lists it, one line per
    // change, in the kernel's words.
    await waitFor(() => expect(screen.getByTestId("draft-count").textContent).toBe("2 changes in draft"));
    await userEvent.click(screen.getByTestId("review-changes"));
    const changes = await screen.findByTestId("draft-changes");
    expect([...changes.querySelectorAll("li")].map((line) => line.textContent)).toEqual([
      "class 'pedestrian' added",
      "optional attribute 'lit' added to 'vehicle'",
    ]);
    // A line opens the class it is about.
    await userEvent.click(within(changes).getByRole("button", { name: "optional attribute 'lit' added to 'vehicle'" }));
    expect(await screen.findByTestId("class-0")).not.toBeNull();
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "vehicle");
  });

  /**
   * The badge is the dialog's third door, beside a refused removal and a refused
   * Save: it says the frames are there before Save is pressed, from a settled
   * preview — the publish's own answer still decides.
   */
  it("says how many frames are in the way before Save, and opens the dialog that lists them", async () => {
    const ASSET = "22222222-2222-4222-8222-222222222222";
    const BATCH = "33333333-3333-4333-8333-333333333333";
    projectWithSchema();
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        is_refused: true,
        diff: { changes: [], destructive_classes: ["lane", "vehicle"], is_destructive: true },
        blockers: [
          { label_class: "lane", annotations: 12, assets: 3 },
          { label_class: "vehicle", annotations: 2, assets: 1 },
        ],
      },
    });
    on("POST", /\/schema\/blocking-assets/, {
      status: 200,
      body: {
        items: [
          {
            asset: {
              id: ASSET,
              project_id: PROJECT,
              modality: "image",
              point_cloud: null,
              content_hash: "deadbeef",
              format: "jpeg",
              width: 1920,
              height: 1080,
              frame_index: 7,
              frame_timestamp: null,
              source_id: null,
              thumbnail_hash: null,
              ingested_at: "2024-01-01T00:00:00Z",
            },
            label_classes: ["lane"],
            annotations: 12,
            batch_ids: [BATCH],
          },
        ],
        total: 1,
      },
    });
    const opened = vi.fn();

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" onOpenBatch={opened} />);
    await screen.findByTestId("schema-editor");
    expect(screen.queryByTestId("frames-in-the-way")).toBeNull();

    await addNamedClass("pedestrian");

    // The sum of the blockers' frames, said in the draft's own panel.
    const badge = await screen.findByTestId("frames-in-the-way");
    expect(badge.textContent).toContain("4 frames in the way");
    // And on the rows the preview names, over the "Changed"/"New" a row would
    // otherwise carry.
    await waitFor(() => expect(screen.getByTestId("class-mark-0").textContent).toBe("In the way"));
    expect(screen.getByTestId("class-mark-1").textContent).toBe("In the way");
    expect(screen.getByTestId("class-mark-2").textContent).toBe("New");
    // Nothing has been asked about the frames themselves, nor published.
    expect(screen.queryByTestId("orphan-dialog")).toBeNull();
    expect(
      sent.some((request) => new URL(request.url).pathname.endsWith("/schema/blocking-assets")),
    ).toBe(false);

    // The badge can be showing the answer about the draft a moment ago (the
    // list is kept while the next proposal is asked about); the dialog is about
    // the settled one, so wait for it to have settled on the typed name.
    await waitFor(() =>
      expect(
        sent.some(
          (request) =>
            new URL(request.url).pathname.endsWith("/schema/preview") &&
            (bodies.get(request) ?? "").includes("pedestrian"),
        ),
      ).toBe(true),
    );
    await userEvent.click(badge);

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("This draft can’t be saved yet");
    expect(dialog.textContent).toContain("lane: 12 annotations across 3 assets");
    expect(dialog.textContent).toContain("Undo the change, or clear those labels first");
    expect(within(dialog).getByTestId("orphan-close").textContent).toBe("Close");
    await within(dialog).findByTestId("blocking-asset-list");
    expect(within(dialog).getByTestId("blocking-asset-count").textContent).toContain("1");
    // Asked about the settled draft, pedestrian included — the list is of what
    // *this* proposal would orphan.
    const asked = sent.filter((request) =>
      new URL(request.url).pathname.endsWith("/schema/blocking-assets"),
    );
    expect(asked).toHaveLength(1);
    expect(bodies.get(asked[0])).toContain("pedestrian");
    await userEvent.click(within(dialog).getByTestId("blocking-asset-batch"));
    expect(opened).toHaveBeenCalledWith(BATCH);

    await userEvent.click(within(dialog).getByTestId("orphan-close"));
    await waitFor(() => expect(screen.queryByTestId("orphan-dialog")).toBeNull());
    // Closing it changes nothing about the draft or what is in the way.
    expect(screen.getByTestId("frames-in-the-way")).not.toBeNull();
    expect(classCards()).toHaveLength(3);
    expect(sent.some((request) => new URL(request.url).pathname.endsWith("/publish"))).toBe(false);
  });

  it("speaks of a single frame in the way in the singular", async () => {
    projectWithSchema();
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        is_refused: true,
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 5, assets: 1 }],
      },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await addNamedClass("pedestrian");

    expect((await screen.findByTestId("frames-in-the-way")).textContent).toContain("1 frame in the way");
  });

  it("locks draft mutations until a deferred publish settles", async () => {
    projectWithSchema();
    let resolvePublish: ((answer: Exclude<HandlerAnswer, undefined>) => void) | undefined;
    handlers.push((request) => {
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish")
      ) {
        return undefined;
      }
      return new Promise((resolve) => {
        resolvePublish = resolve;
      });
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await addNamedClass("pedestrian");
    await userEvent.click(screen.getByTestId("save-schema"));
    await waitFor(() => expect(resolvePublish).toBeDefined());

    // The row is still pressable while the publish is in flight; what it opens
    // is a form whose every control is locked.
    await userEvent.click(screen.getByTestId("class-card-2"));
    const className = await screen.findByTestId("class-name-2");
    expect(className).toHaveProperty("disabled", true);
    expect(screen.getByTestId("add-class")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("remove-class-2")).toHaveProperty("disabled", true);
    await userEvent.type(className, "-newer");
    expect(className).toHaveProperty("value", "pedestrian");

    if (resolvePublish === undefined) throw new Error("Expected the deferred publish request");
    resolvePublish({
      status: 201,
      body: {
        published: {
          project_id: PROJECT,
          version: 4,
          classes: [...CLASSES, { name: "pedestrian", geometries: ["bbox"], color: null, attributes: [] }],
        },
        advanced_batches: [],
      },
    });
    await waitFor(() => expect(screen.getByTestId("save-schema")).toHaveProperty("disabled", false));
    expect(screen.getByTestId("class-name-2")).toHaveProperty("value", "pedestrian");
  });

  it("previews a publishable narrowing before one flagged publish", async () => {
    projectWithSchema();
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });
    handlers.push((request) => {
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish")
      ) {
        return undefined;
      }
      const allowed = new URL(request.url).searchParams.get("allow_destructive") === "true";
      return allowed
        ? {
            status: 201,
            body: {
              published: { project_id: PROJECT, version: 4, classes: [] },
              advanced_batches: [],
            },
          }
        : {
            status: 409,
            body: {
              code: "DESTRUCTIVE_SCHEMA_CHANGE",
              message: "internal wording must not appear",
            },
          };
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("destructive-dialog");
    expect(dialog.textContent).toContain("lane");
    expect(dialog.textContent).not.toContain("internal wording must not appear");
    // Three descriptions, and a screen reader reaches all three — not only the first.
    expect(describedBy(dialog)).toHaveLength(3);
    expect(describedBy(dialog).join(" ")).toContain("A batch still open on the current version");
    // The blast radius, counted: DESIGN.md requires a confirmation to name what
    // it costs. `blockers` is empty on every preview that reaches this dialog,
    // so the zero is measured rather than assumed.
    expect(dialog.textContent).toContain("1 class narrows");
    expect(dialog.textContent).toContain("No existing annotation becomes invalid");
    // The removed promise. It said annotations are untouched, which answers the
    // invariant by implication; the dialog states the rule itself instead.
    expect(dialog.textContent).not.toContain("Existing annotations are not touched");
    expect(
      sent.some(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
      ),
    ).toBe(false);

    const allow = screen.getByTestId("allow-destructive");
    await waitFor(() => expect(allow).toHaveProperty("disabled", false));
    await userEvent.click(allow);
    await waitFor(() =>
      expect(
        sent.filter(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
        ),
      ).toHaveLength(1),
    );
    const publishRequest = sent.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
    );
    expect(new URL(publishRequest?.url ?? "").searchParams.get("allow_destructive")).toBe("true");
  });

  it("counts every narrowing class in the confirmation", async () => {
    projectWithSchema();
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) {
        return undefined;
      }
      return {
        status: 200,
        body: {
          is_refused: false,
          blockers: [],
          diff: {
            is_destructive: true,
            destructive_classes: ["lane", "sign"],
            changes: [
              { kind: "destructive", label_class: "lane", attribute: null, detail: "class 'lane' removed" },
              { kind: "destructive", label_class: "sign", attribute: null, detail: "class 'sign' removed" },
            ],
          },
        },
      };
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("destructive-dialog");
    expect(dialog.textContent).toContain("2 classes narrow");
    expect(dialog.textContent).toContain("lane");
    expect(dialog.textContent).toContain("sign");
    expect(dialog.textContent).toContain("No existing annotation becomes invalid");
    // The kernel's words, not a count: a re-casing and a removal both "narrow one
    // class", and only the detail tells them apart.
    const listed = within(dialog).getAllByTestId("narrowing-change").map((item) => item.textContent);
    expect(listed).toEqual(["class 'lane' removed", "class 'sign' removed"]);
  });

  it("says what a batch still open on the outgoing version will keep writing", async () => {
    projectWithSchema();
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) {
        return undefined;
      }
      return {
        status: 200,
        body: {
          is_refused: false,
          blockers: [],
          diff: {
            is_destructive: true,
            destructive_classes: ["lane", "sign"],
            changes: [
              { kind: "destructive", label_class: "lane", attribute: null, detail: "class 'lane' removed" },
              { kind: "destructive", label_class: "sign", attribute: null, detail: "class 'sign' removed" },
            ],
          },
        },
      };
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("destructive-dialog");
    // A batch still pinned to the outgoing version keeps writing the dropped
    // class, and the bill arrives at the release rather than at this save.
    expect(dialog.textContent).toContain("still open on the current version");
    expect(dialog.textContent).toContain("a release cannot be published");
    // Still no machine code, no UUID, no SDK keyword.
    expect(dialog.textContent).not.toContain("SCHEMA_CHANGE_WOULD_ORPHAN");
    expect(dialog.textContent).not.toContain("allow_destructive");
  });

  it("prevents repeated confirmation while its second preview is pending", async () => {
    projectWithSchema();
    // The removal's own preview, then the rail's settled one and Save's — in
    // whichever order the debounce and the click fall — and then the preview the
    // confirmation sends again, which is the one held open.
    let previews = 0;
    let resolveSecondPreview: ((answer: Exclude<HandlerAnswer, undefined>) => void) | undefined;
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) {
        return undefined;
      }
      previews += 1;
      if (previews === 4) {
        return new Promise((resolve) => {
          resolveSecondPreview = resolve;
        });
      }
      return {
        status: 200,
        body: {
          diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
          blockers: [],
          is_refused: false,
        },
      };
    });
    on("POST", /schema\/drafts\/curated\/publish(?:\?.*)?$/, {
      status: 201,
      body: {
        published: { project_id: PROJECT, version: 4, classes: [] },
        advanced_batches: [],
      },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));
    const allow = await screen.findByTestId("allow-destructive");
    await waitFor(() => expect(allow).toHaveProperty("disabled", false));
    // The rail's settled preview has landed too, so the next one is the
    // confirmation's and not a late arrival from the debounce.
    await waitFor(() => expect(previews).toBe(3));
    await userEvent.click(allow);
    await waitFor(() => expect(resolveSecondPreview).toBeDefined());

    expect(allow).toHaveProperty("disabled", true);
    await userEvent.click(allow);

    if (resolveSecondPreview === undefined) throw new Error("Expected the deferred second preview");
    resolveSecondPreview({
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });
    await waitFor(() =>
      expect(
        sent.filter(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
        ),
      ).toHaveLength(1),
    );
  });

  it("opens the terminal blocker dialog when the save-time preview refuses", async () => {
    projectWithSchema();
    let previews = 0;
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) {
        return undefined;
      }
      previews += 1;
      return previews === 1
        ? {
            status: 200,
            body: {
              diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
              blockers: [],
              is_refused: false,
            },
          }
        : {
            status: 200,
            body: {
              diff: {
                changes: [
                  { kind: "additive", label_class: "Lane", attribute: null, detail: "class 'Lane' added" },
                  {
                    kind: "destructive",
                    label_class: "lane",
                    attribute: null,
                    detail: "class 'lane' removed; 'Lane' differs only in its casing",
                  },
                ],
                destructive_classes: ["lane"],
                is_destructive: true,
              },
              blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
              is_refused: true,
            },
          };
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("12 annotations");
    expect(dialog.textContent).toContain("3 assets");
    expect(describedBy(dialog)).toHaveLength(2);
    expect(describedBy(dialog).join(" ")).toContain("There is no override for this one");
    // What was asked, in the kernel's words — the only place a re-casing is told
    // apart from a removal. Additive changes stay out of a refusal.
    expect(
      within(dialog).getAllByTestId("narrowing-change").map((item) => item.textContent),
    ).toEqual(["class 'lane' removed; 'Lane' differs only in its casing"]);
    // The missing button *is* the assertion. `SchemaChangeWouldOrphan` has no
    // override and is deliberately not a subclass of `DestructiveSchemaChange`, so
    // a "Save anyway" here would be an infinite loop with a person in it.
    expect(screen.queryByTestId("allow-destructive")).toBeNull();
    expect(screen.queryByTestId("destructive-dialog")).toBeNull();
    expect(within(dialog).getByTestId("orphan-close")).not.toBeNull();
    expect(
      sent.some(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
      ),
    ).toBe(false);
  });

  it("uses typed publish-time orphan blockers when the preview becomes stale", async () => {
    projectWithSchema();
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });
    on("POST", /schema\/drafts\/curated\/publish(?:\?.*)?$/, {
      status: 409,
      body: {
        code: "SCHEMA_CHANGE_WOULD_ORPHAN",
        message: "internal wording must not appear",
        detail: { blockers: [{ label_class: "lane", annotations: 12, assets: 3 }] },
      },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await removeClass(1);
    await userEvent.click(screen.getByTestId("save-schema"));
    const allow = await screen.findByTestId("allow-destructive");
    await waitFor(() => expect(allow).toHaveProperty("disabled", false));
    await userEvent.click(allow);
    await waitFor(() =>
      expect(
        sent.filter(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/schema/drafts/curated/publish"),
        ),
      ).toHaveLength(1),
    );

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("lane: 12 annotations across 3 assets");
    expect(dialog.textContent).not.toContain("internal wording must not appear");
    expect(screen.queryByTestId("allow-destructive")).toBeNull();
    expect(screen.queryByTestId("destructive-dialog")).toBeNull();
  });

  it.each([
    { shape: "absent", detail: undefined },
    { shape: "malformed", detail: { blockers: [{ label_class: "lane" }] } },
  ])(
    "clears destructive confirmation and renders prose for an orphan refusal with $shape detail",
    async ({ detail }) => {
      projectWithSchema();
      on("POST", /schema\/preview$/, {
        status: 200,
        body: {
          diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
          blockers: [],
          is_refused: false,
        },
      });
      on("POST", /schema\/drafts\/curated\/publish(?:\?.*)?$/, {
        status: 409,
        body: {
          code: "SCHEMA_CHANGE_WOULD_ORPHAN",
          message: "internal wording must not appear",
          detail,
        },
      });

      renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
      await screen.findByTestId("schema-editor");
      await removeClass(1);
      await userEvent.click(screen.getByTestId("save-schema"));
      await userEvent.click(await screen.findByTestId("allow-destructive"));

      const error = await screen.findByTestId("schema-error");
      expect(error.textContent).toContain(
        "Annotations already exist that this change would orphan.",
      );
      expect(error.textContent).not.toContain("internal wording must not appear");
      expect(error.textContent).not.toContain("SCHEMA_CHANGE_WOULD_ORPHAN");
      expect(screen.queryByTestId("allow-destructive")).toBeNull();
      expect(screen.queryByTestId("destructive-dialog")).toBeNull();
    },
  );

  it("says an autosave failure in prose, not as a kernel identifier", async () => {
    projectWithSchema();
    on("PUT", /\/schema\/drafts\/curated$/, {
      status: 409,
      body: {
        code: "DESTRUCTIVE_SCHEMA_CHANGE",
        message: "internal wording must not appear",
      },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await addNamedClass("pedestrian");

    const alert = await screen.findByTestId("schema-draft-error", {}, { timeout: 2000 });
    expect(alert.textContent).toContain(
      "This change removes part of the contract already in use.",
    );
    expect(alert.textContent).not.toContain("DESTRUCTIVE_SCHEMA_CHANGE");
    expect(alert.textContent).not.toContain("internal wording must not appear");
  });

  it("offers only the geometries an annotation can carry", async () => {
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);

    // `polyline` is offered even where no tool draws one: the API
    // accepts it, the exporters need it, and the tool strip is where a person
    // learns there is nothing to draw with. Offering it is not offering a refusal.
    //
    // Addressed by `data-testid`, which keeps the **wire** value, while the label
    // beside it is the display word — so this asserts which geometries are on
    // offer without also asserting what they are called, which is
    // `geometryCategory.test.ts`'s job.
    for (const geometry of ["bbox", "polygon", "polyline", "classification_tag"]) {
      expect(screen.getByTestId(`class-geometry-0-${geometry}`)).toBeTruthy();
    }
    // `GeometryType` has eight members; four are refused at write time with
    // `UnsupportedGeometry`, so offering them would be offering a refusal.
    for (const geometry of ["mask", "keypoints", "cuboid_3d", "polyline_3d"]) {
      expect(screen.queryByTestId(`class-geometry-0-${geometry}`)).toBeNull();
    }
  });

  /**
   * The class dialog's shapes are one flat group of four checkboxes: a class
   * takes a handful of shapes, and a caption per category over one or two of
   * them is more page than the choice is worth. (The annotator's narrow
   * add-a-class dialog still groups them — `classFields.test.tsx` holds that.)
   *
   * What is asserted is what is on the page without opening anything, which is
   * the point of checkboxes over a dropdown: what a class accepts is readable
   * at a glance, in the order a person reads down it.
   */
  it("lists the shapes it offers as one row of icon buttons, with no category captions", async () => {
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);

    const group = screen.getByTestId("class-geometry-0");
    const chips = within(group).getAllByRole("button");
    expect(chips.map((chip) => chip.getAttribute("data-testid"))).toEqual([
      "class-geometry-0-bbox",
      "class-geometry-0-polygon",
      "class-geometry-0-polyline",
      "class-geometry-0-classification_tag",
    ]);
    // The display words, not the wire values: `classification_tag` is an
    // identifier and `tag` is what it is called. Icon only, so the word is
    // each button's name, and it is said again beside the group.
    expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual(["Box", "Polygon", "Polyline", "Tag"]);
    expect(chips.map((chip) => chip.textContent)).toEqual(["", "", "", ""]);
    expect(within(group.parentElement!).getByText("Box").getAttribute("aria-hidden")).toBe("true");
    // What the class accepts is readable at a glance, with nothing opened.
    expect(chips.map((chip) => chip.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    expect(screen.queryByTestId(/^geometry-category-/)).toBeNull();
  });

  /**
   * The regression pin. A shape is *added* to the set, and — like every other
   * field in the dialog — only reaches the draft on Save.
   */
  it("adds a geometry to a class rather than replacing the one it had, and only on Save", async () => {
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);

    expect(screen.getByTestId("class-geometry-0-bbox").getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(screen.getByTestId("class-geometry-0-polyline"));

    // Both, which is the whole feature — a control that replaced would leave the
    // first chip off and this would still find the second one on.
    expect(screen.getByTestId("class-geometry-0-bbox").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("class-geometry-0-polyline").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");

    await closeSheet();
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    await userEvent.click(screen.getByTestId("class-card-0"));
    expect(screen.getByTestId("class-geometry-0-bbox").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("class-geometry-0-polyline").getAttribute("aria-pressed")).toBe("true");
  });

  it("refuses to unpress the last geometry, and says why rather than greying out", async () => {
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);

    const only = screen.getByTestId("class-geometry-0-bbox");
    expect(only.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(only);

    expect(screen.getByTestId("class-geometry-0-bbox").getAttribute("aria-pressed")).toBe("true");
    // Principle 9: the control that will not move carries the reason. `title`
    // and `aria-disabled` rather than the `disabled` attribute, so a keyboard
    // still reaches it.
    expect(only.getAttribute("title")).toMatch(/at least one shape/i);
    expect(only.getAttribute("aria-disabled")).toBe("true");
    expect(only.tagName).toBe("BUTTON");
    expect(only.hasAttribute("disabled")).toBe(false);
    // Drawn as the canvas draws it, beside its word.
    expect(only.querySelector("svg")).not.toBeNull();
    expect(only.getAttribute("aria-label")).toBe("Box");
    // Nothing was changed, so there is nothing to save.
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  /**
   * The colour control has to show the colour the class is actually drawn in.
   *
   * The swatch was bound to the **stored** colour, which is `null` for a derived
   * class, so `<input type="color">` fell back to its own default and rendered
   * grey — beside a dot showing the real teal, and against an annotator drawing
   * that same teal. One row, two colours, in the one control whose entire job is to
   * say what colour something is.
   */
  it("previews a derived class in the colour it is actually drawn in", async () => {
    projectWithSchema();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");

    // `lane` declares no colour, so `classColor` derives one. Computed here from
    // the shipped rule rather than hardcoded, which is what makes this a check on
    // *agreement* — a change to the palette moves both sides together, and only a
    // picker that stopped reading `classColor` fails.
    const derived = hexColor(
      classColor({ name: "lane", geometries: ["polygon"], color: null, attributes: [] }, "lane"),
    );
    expect(derived).not.toBeNull();
    // One dialog at a time, so each class is asserted from its own.
    await selectClass(1);
    // The picker lives in the custom tile's popover, so it is opened to be read.
    await userEvent.click(screen.getByTestId("class-color-trigger-1"));
    expect(screen.getByTestId("class-color-hex-1")).toHaveProperty("value", derived!.slice(1).toUpperCase());
    // Never the neutral, which is what it used to be for every derived class.
    expect(screen.getByTestId("class-color-hex-1")).not.toHaveProperty("value", "888888");
    // A derived colour is not a declared one, so there is nothing to put back.
    expect(screen.queryByTestId("clear-color-1")).toBeNull();

    // And a declared colour is still itself.
    await userEvent.keyboard("{Escape}");
    await selectClass(0);
    await userEvent.click(screen.getByTestId("class-color-trigger-0"));
    expect(screen.getByTestId("class-color-hex-0")).toHaveProperty("value", "38BDF8");
  });

  it("does not turn a derived colour into a declared one just by showing it", async () => {
    // The half worth being careful about: making the
    // input *display* a colour must not make the class *declare* it. A schema
    // version that pinned today's hash output would make every derived class look
    // authored, and would change meaning if the palette rule ever moved.
    projectWithSchema();
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { project_id: PROJECT, version: 4, classes: CLASSES }, advanced_batches: [] },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    // Dirty by something that is not the colour. An untouched draft sends
    // nothing — the button answers instead of being grey, and that
    // refusal is itself the first half of the guarantee.
    await userEvent.click(screen.getByTestId("save-schema"));
    expect(sent.some((r) => r.method === "PUT")).toBe(false);
    await addNamedClass("pedestrian");
    await userEvent.click(screen.getByTestId("save-schema"));

    // The classes now travel in the draft's own write, not in the publish —
    // Save flushes it before publishing, so this is the request that carries
    // what the version will actually record.
    await waitFor(() => expect(sent.some((r) => r.method === "PUT")).toBe(true));
    const request = sent.find((r) => r.method === "PUT")!;
    const body = JSON.parse(bodies.get(request) ?? "{}") as {
      classes: { name: string; color: string | null }[];
    };
    // Assert the payload, never the control: what matters is what the version
    // records.
    expect(body.classes.find((one) => one.name === "lane")?.color).toBeNull();
    expect(body.classes.find((one) => one.name === "pedestrian")?.color).toBeNull();
    expect(body.classes.find((one) => one.name === "vehicle")?.color).toBe("#38bdf8");
  });

  it("\"Use the name’s colour\" clears a declared colour back to the derived one, once saved", async () => {
    projectWithSchema();
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { project_id: PROJECT, version: 4, classes: CLASSES }, advanced_batches: [] },
    });

    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await selectClass(0);
    await userEvent.click(screen.getByTestId("class-color-trigger-0"));
    await userEvent.click(screen.getByTestId("clear-color-0"));

    // Nothing is declared any more, so the way back is gone with it.
    expect(screen.queryByTestId("clear-color-0")).toBeNull();
    // The stored value goes back to null, which is what the button is for.
    await userEvent.keyboard("{Escape}");
    await closeSheet();
    await userEvent.click(screen.getByTestId("save-schema"));
    // The draft's own write carries the classes now; the publish that follows
    // carries only a revision.
    await waitFor(() => expect(sent.some((r) => r.method === "PUT")).toBe(true));
    const request = sent.find((r) => r.method === "PUT")!;
    const body = JSON.parse(bodies.get(request) ?? "{}") as {
      classes: { name: string; color: string | null }[];
    };
    expect(body.classes.find((one) => one.name === "vehicle")?.color).toBeNull();
  });
});

/**
 * The sections are tabs, so what is *not* on the page is an assertion.
 *
 * The interesting one is the last: a query that lives in the section that renders
 * it is a query that follows the tab. That is what makes the split more than
 * cosmetic, and it is invisible in the rendering — only the request log shows it.
 */
describe("the schema version history", () => {
  /**
   * Three versions with descriptions and moments, the wire's own shape.
   *
   * Descriptions differ per version on purpose: a history whose entries all said
   * the same thing would pass an assertion that the *selected* one is shown while
   * actually showing any of them.
   */
  const VERSIONS = [
    {
      project_id: PROJECT,
      version: 1,
      classes: [CLASSES[0]],
      description: "the first contract",
      created_at: "2026-07-01T09:00:00Z",
    },
    {
      project_id: PROJECT,
      version: 2,
      classes: CLASSES,
      description: "lanes too",
      created_at: "2026-07-15T09:00:00Z",
    },
    {
      project_id: PROJECT,
      version: 3,
      classes: CLASSES,
      description: null,
      created_at: "2026-08-01T09:00:00Z",
    },
  ];

  /**
   * The project, its active version, and its history.
   *
   * ``active`` is passed rather than derived from ``items`` because the two are
   * separate routes and the screen reads them separately — a fixture that derived
   * one from the other would hide the case where they disagree, which is exactly
   * what a stale refetch looks like.
   */
  function withHistory(items: unknown[] = VERSIONS, active: unknown = VERSIONS[2]): void {
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
    on("GET", /^\/projects\/[^/]+\/schema$/, { status: 200, body: active });
    on("GET", /schema\/versions$/, { status: 200, body: { items, total: items.length } });
  }

  function withDiff(answer: unknown): void {
    on("GET", /schema\/compare/, { status: 200, body: answer });
  }

  const NOTHING = { is_destructive: false, destructive_classes: [], changes: [] };

  async function open(): Promise<void> {
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("schema-editor");
    await screen.findByTestId("open-history");
  }

  /** Read a published version through its History entry. */
  async function view(version: number): Promise<void> {
    await viewVersion(version);
  }

  /** The entries of the open History sheet, in the order it lists them. */
  function entries(history: HTMLElement): HTMLElement[] {
    return [...history.querySelectorAll<HTMLElement>("[data-testid]")].filter((element) =>
      /^version-\d+$/.test(element.dataset.testid ?? ""),
    );
  }

  it("lists every version newest first in a sheet, and says which one is active", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    // The band names the version in force on the button that opens the rest.
    expect(screen.getByTestId("open-history").getAttribute("aria-label")).toContain("version 3");
    // An icon button: no words of its own on the band.
    expect(screen.getByTestId("open-history").textContent?.trim()).toBe("");

    const history = await openHistory();
    await within(history).findByTestId("version-3");
    const listed = entries(history);
    expect(listed.map((entry) => entry.dataset.testid)).toEqual(["version-3", "version-2", "version-1"]);
    expect(within(listed[0]).getByText("Active")).not.toBeNull();
    expect(within(listed[1]).queryByText("Active")).toBeNull();
    expect(listed[1].textContent).toContain(formatWhen(VERSIONS[1].created_at));
    // Each says why it was made, in the words written beside Save — or that
    // nobody wrote any.
    expect(listed[1].textContent).toContain("lanes too");
    expect(listed[0].textContent).toContain("No message");
  });

  it("raises the commit bar once the draft has unsaved changes, and counts them", async () => {
    withHistory();
    withDiff(NOTHING);
    on("POST", /schema\/preview$/, {
      status: 200,
      body: {
        is_refused: false,
        blockers: [],
        diff: {
          is_destructive: false,
          destructive_classes: [],
          changes: [{ kind: "additive", label_class: "pedestrian", attribute: null, detail: "class 'pedestrian' added" }],
        },
      },
    });
    await open();
    expect(barState()).toBe("down");

    await addNamedClass("pedestrian");

    expect(barState()).toBe("up");
    await waitFor(() => expect(screen.getByTestId("draft-count").textContent).toBe("1 change in draft"));
    expect(screen.getByTestId("save-schema").textContent).toBe("Save version 4");
  });

  it("offers the history from the first published version, and not before", async () => {
    // One published version is already a history: there is a past to read, and
    // the draft to come back to.
    withHistory([VERSIONS[2]], VERSIONS[2]);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    await screen.findByTestId("schema-editor");
    const history = await openHistory();
    await within(history).findByTestId("version-3");
    expect(entries(history).map((entry) => entry.dataset.testid)).toEqual(["version-3"]);
  });

  it("offers no history to a project that has never published", async () => {
    // Nothing but the draft to choose from is furniture.
    on("GET", /^\/projects\/[^/]+$/, {
      status: 200,
      body: {
        id: PROJECT,
        name: "fresh",
        description: null,
        thumbnail_asset_id: null,
        thumbnail_hash: null,
        created_at: null,
      },
    });
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 404,
      body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
    });
    on("GET", /schema\/versions$/, { status: 200, body: { items: [], total: 0 } });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    await screen.findByTestId("schema-editor");
    // Nothing but the draft to come back to is furniture.
    expect(screen.queryByTestId("open-history")).toBeNull();
    expect(screen.queryByTestId("history-sheet")).toBeNull();
  });

  it("switches the page to a read-only past version, marking what it added", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    await view(2);

    // The rows are read-only: a row opens to read the class, and nothing in the
    // table takes input or offers an edit — no menu, no restore — because a
    // published version is immutable and there is no "not now" to say.
    const past = await screen.findByTestId("past-version");
    expect(within(past).getAllByTestId(/^past-class-\d+$/).map((button) => button.getAttribute("data-testid"))).toEqual(["past-class-0", "past-class-1"]);
    expect(editAffordances(past)).toEqual([]);
    expect(within(past).getByTestId("past-class-0").textContent).toContain("vehicle");
    expect(within(past).getByTestId("past-class-1").textContent).toContain("lane");
    expect(screen.getByRole("heading", { level: 2, name: "Classes in version 2" })).not.toBeNull();
    // `lane` is not in version 1, which is the version before it — read off the
    // history, not computed from the diff. `vehicle` was already there.
    expect(within(past).getByTestId("class-mark-1").textContent).toBe("New");
    expect(within(past).queryByTestId("class-mark-0")).toBeNull();
    // And the band across the table says whose words these are.
    const panel = screen.getByTestId("past-version-panel");
    expect(within(panel).getByTestId("schema-status").textContent).toContain("version 2");
    expect(within(panel).getByTestId("schema-status").textContent).toContain("read-only");
    expect(within(panel).getByTestId("restore-version")).not.toBeNull();
  });

  it("opens a past version's row in a dialog to read the whole class, with nothing to edit", async () => {
    const DECLARED = [
      { name: "vehicle", geometries: ["bbox", "polygon"], color: "#38bdf8", attributes: [] },
      {
        name: "lane",
        geometries: ["polyline"],
        color: null,
        attributes: [
          { name: "surface", kind: "select", required: true, options: ["tarmac", "gravel"], default: "tarmac" },
          { name: "faded", kind: "boolean", required: false, options: null, default: null },
        ],
      },
    ];
    const history = [{ ...VERSIONS[0], classes: DECLARED }, VERSIONS[2]];
    withHistory(history, VERSIONS[2]);
    withDiff(NOTHING);
    await open();

    await view(1);
    const past = await screen.findByTestId("past-version");
    // Closed to begin with: a row is a summary until it is asked for.
    expect(screen.queryByTestId("past-class-detail-1")).toBeNull();
    expect(screen.queryByTestId("past-class-sheet")).toBeNull();
    // It opens a panel beside the table, not a dialog over it.
    expect(within(past).getByTestId("past-class-1").getAttribute("aria-haspopup")).toBeNull();

    await userEvent.click(within(past).getByTestId("past-class-1"));

    const sheet = await screen.findByTestId("past-class-sheet");
    // A panel at the right of the table, not a dialog over the page.
    expect(sheet.closest("aside")?.getAttribute("aria-label")).toBe("Class");
    expect(sheet.closest("[role=dialog]")).toBeNull();
    expect(within(sheet).getByRole("heading", { name: "lane" })).not.toBeNull();
    expect(sheet.textContent).toContain("As version 1 declares it");
    const detail = within(sheet).getByTestId("past-class-detail-1");
    // The colour it derives from its name, the key it holds and the shape it draws as.
    expect(detail.textContent).toContain("from the name");
    expect(within(detail).getByText("Shortcut").nextElementSibling!.textContent).toBe("2");
    expect(detail.textContent).toContain("Polyline");
    // Each attribute, as its name, whether it is required, what it accepts and its default.
    expect(detail.textContent).toContain("surface");
    expect(detail.textContent).toContain("Choice of 2 · required");
    // Its choices are always shown, with the default marked: a read has no group to open.
    expect(detail.textContent).toContain("tarmac (default)");
    expect(detail.textContent).toContain("gravel");
    expect(detail.textContent).not.toContain("gravel (default)");
    expect(detail.textContent).toContain("faded");
    expect(detail.textContent).toContain("Yes or no");
    // Read, not edited: nothing in the class takes input or changes a value, and
    // an attribute has no menu to remove it from.
    expect(detail.querySelectorAll("input, textarea, select, button, [role=switch], [role=combobox], [role=checkbox]")).toHaveLength(0);
    expect(screen.queryByTestId("class-sheet")).toBeNull();
    expect(within(sheet).queryByTestId("class-sheet-done")).toBeNull();
    expect(within(sheet).queryByTestId("remove-class-1")).toBeNull();

    // Put away with its footer's Close, and focus is back on the row it was opened from.
    await userEvent.click(within(sheet).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByTestId("past-class-sheet")).toBeNull());
    expect(document.activeElement).toBe(within(past).getByTestId("past-class-1"));

    // A class with no attributes says so, and a declared colour is read as its hex.
    await userEvent.click(within(past).getByTestId("past-class-0"));
    const first = await screen.findByTestId("past-class-detail-0");
    expect(first.textContent).toContain("None — an annotation carries only its class.");
    expect(first.textContent).toContain("Box");
    expect(first.textContent).toContain("Polygon");
    expect(first.textContent).toContain("#38bdf8");
    await waitFor(() => expect(screen.queryByTestId("past-class-detail-1")).toBeNull());
    expect(screen.getAllByTestId("past-class-sheet")).toHaveLength(1);
  });

  it("marks a class the comparison says changed, and only that class", async () => {
    withHistory();
    withDiff({
      is_destructive: false,
      destructive_classes: [],
      changes: [
        { kind: "additive", label_class: "lane", attribute: "lit", detail: "attribute 'lit' added to 'lane'" },
      ],
    });
    await open();

    await view(3);

    // Version 2 already declared both classes, so neither is new; `lane` is the
    // one the API's own comparison names.
    const past = await screen.findByTestId("past-version");
    await waitFor(() => expect(within(past).queryByTestId("class-mark-1")).not.toBeNull());
    expect(within(past).getByTestId("class-mark-1").textContent).toBe("Changed");
    expect(within(past).queryByTestId("class-mark-0")).toBeNull();
  });

  it("opens a version from the history, and its second press goes back to the draft", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    const history = await openHistory();
    await userEvent.click(await within(history).findByTestId("view-version-2"));

    // The panel puts itself away, and the table is the version's.
    await screen.findByTestId("past-version");
    await waitFor(() => expect(screen.queryByTestId("history-sheet")).toBeNull());
    expect(screen.queryByTestId("save-schema")).toBeNull();

    // Opened again, the history says which version is on screen, and that
    // entry's View is the way back.
    const again = await openHistory();
    expect(within(again).getByTestId("version-2").getAttribute("aria-current")).toBe("true");
    expect(within(again).getByTestId("version-1").getAttribute("aria-current")).toBeNull();
    expect(within(again).getByTestId("view-version-2").getAttribute("aria-pressed")).toBe("true");
    expect(within(again).getByTestId("view-version-2").getAttribute("aria-label")).toContain("Back to the draft");
    await userEvent.click(within(again).getByTestId("view-version-2"));

    await screen.findByTestId("class-list");
    expect(screen.queryByTestId("past-version")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).toContain("Version 3 active");
  });

  it("opens as a labelled panel beside the table, takes focus, and Escape puts it away", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    const history = await openHistory();
    const pane = screen.getByTestId("history-sheet").closest("aside")!;
    expect(pane.getAttribute("aria-label")).toBe("Schema history");
    expect(pane.closest("[role=dialog]")).toBeNull();
    expect(pane.contains(document.activeElement)).toBe(true);
    // The table stays on the page beside it.
    expect(screen.getByTestId("class-list")).not.toBeNull();
    expect(history).not.toBeNull();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("history-sheet")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("open-history"));
  });

  it("is replaced by a class's panel, and a class's panel by it — one detail at a time", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    await openHistory();
    await userEvent.click(screen.getByTestId("class-card-0"));
    await screen.findByTestId("class-sheet");
    await waitFor(() => expect(screen.queryByTestId("history-sheet")).toBeNull());
    expect(document.querySelectorAll("aside[aria-label]")).toHaveLength(1);

    await userEvent.click(screen.getByTestId("open-history"));
    await screen.findByTestId("history-sheet");
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
  });

  it("renders a past version with no edit affordance at all", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    expect(screen.queryByTestId("save-schema")).not.toBeNull();

    await view(1);

    // Absent, not disabled: a disabled control says "not now", and there is no
    // now — a published version is immutable.
    await waitFor(() => expect(screen.queryByTestId("past-version")).not.toBeNull());
    const past = screen.getByTestId("past-version");
    expect(within(past).getAllByTestId(/^past-class-\d+$/).map((button) => button.getAttribute("data-testid"))).toEqual(["past-class-0"]);
    expect(editAffordances(past)).toEqual([]);
    // No commit bar to rise, and so nothing to discard or save: a published
    // version has no draft in it. No lens either — nothing in it changed.
    expect(screen.queryByTestId("commit-bar")).toBeNull();
    expect(screen.queryByTestId("discard-draft")).toBeNull();
    expect(screen.queryByTestId("classes-lens")).toBeNull();
    expect(screen.queryByTestId("save-schema")).toBeNull();
    expect(screen.queryByTestId("add-class")).toBeNull();
    expect(screen.queryByTestId("class-list")).toBeNull();
    expect(screen.queryByTestId("class-sheet")).toBeNull();
    expect(screen.queryByTestId("classes-none")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).toContain("read-only");
    // Version 1 has nothing before it, so nothing on it can be new or changed.
    expect(screen.queryByTestId("class-mark-0")).toBeNull();
  });

  it("returns to the draft, unchanged, when the way back is pressed", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    await view(1);
    await screen.findByTestId("past-version");

    await userEvent.click(screen.getByTestId("back-to-active"));

    await waitFor(() => expect(screen.queryByTestId("save-schema")).not.toBeNull());
    expect(screen.getByTestId("schema-status").textContent).toContain("Version 3 active");
    expect(screen.getByRole("heading", { level: 2, name: "Classes" })).not.toBeNull();
    expect(screen.queryByTestId("past-version-panel")).toBeNull();
  });

  it("shows the selected version's own description, and says so when there is none", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    // v3 is active and was published without one — and it is read under the
    // same band as any other, as "active · read-only".
    await view(3);
    expect(screen.getByTestId("version-description").textContent).toContain("No message");
    expect(screen.getByTestId("schema-status").textContent).toContain("active · read-only");
    // The active version is what the draft already starts from: nothing to
    // restore, said in Restore's own room so walking onto it moves nothing.
    expect(screen.queryByTestId("restore-version")).toBeNull();
    expect(screen.getByTestId("version-active").textContent).toContain("Active version");

    await view(2);

    await waitFor(() =>
      expect(screen.getByTestId("version-description").textContent).toContain("lanes too"),
    );
    expect(screen.getByTestId("schema-status").textContent).not.toContain("active");
  });

  it("marks the version by the API's comparison, whose word wins over the cells", async () => {
    withHistory();
    withDiff({
      is_destructive: true,
      destructive_classes: ["lane"],
      changes: [
        { kind: "destructive", label_class: "lane", attribute: "lit", detail: "required attribute 'lit' added to class 'lane'" },
      ],
    });
    await open();
    await view(3);

    // v2 and v3 declare the same classes, so no cell moved — yet the kernel
    // names `lane`, and the table says what the kernel says.
    const past = await screen.findByTestId("past-version");
    await waitFor(() => expect(within(past).getByTestId("class-mark-1").textContent).toBe("Changed"));
    expect(within(past).queryByTestId("class-mark-0")).toBeNull();
    // A narrowing says so in a word beside the mark — the colour is not the only cue.
    expect(within(past).getByTestId("class-mark-narrows-1").textContent).toContain("Narrows");
    expect(within(past).queryByTestId("class-mark-narrows-0")).toBeNull();
    // And the head counts both.
    const counted = screen.getByTestId("version-diff").textContent;
    expect(counted).toContain("1 changed");
    expect(counted).toContain("1 narrows");
  });

  it("keeps a class the version dropped where it stood, struck, and marks the ones it added", async () => {
    const [vehicle, lane] = CLASSES;
    withHistory([
      { project_id: PROJECT, version: 1, classes: [lane, vehicle], description: "both", created_at: "2026-07-01T09:00:00Z" },
      { project_id: PROJECT, version: 2, classes: [vehicle], description: "lane out", created_at: "2026-07-15T09:00:00Z" },
      { project_id: PROJECT, version: 3, classes: [vehicle, lane], description: "lane back", created_at: "2026-08-01T09:00:00Z" },
    ], { project_id: PROJECT, version: 3, classes: [vehicle, lane] });
    withDiff({
      is_destructive: true,
      destructive_classes: ["lane"],
      changes: [{ kind: "destructive", label_class: "lane", attribute: null, detail: "class 'lane' removed" }],
    });
    await open();
    await view(2);

    const past = await screen.findByTestId("past-version");
    // Removed, in the row it held in v1 — above vehicle — and nothing to press.
    const rows = [...past.querySelectorAll<HTMLElement>("tbody tr")].map((row) => row.dataset.testid);
    expect(rows).toEqual(["class-removed-lane", "past-row-0"]);
    expect(within(past).getByTestId("class-mark-removed-lane").textContent).toBe("Removed");
    expect(within(past).getByTestId("class-mark-narrows-lane").textContent).toContain("Narrows");
    // vehicle moved from the second hotkey to the first: the old digit is struck beside the new.
    expect(within(past).getByTestId("past-row-0").textContent).toContain("2");
    expect(within(past).getByLabelText("was 2")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("version-diff").textContent).toContain("1 removed"));

    // v3 brings lane back: new.
    await userEvent.click(screen.getByTestId("newer-version"));
    await waitFor(() => expect(screen.getByTestId("schema-status").textContent).toContain("version 3"));
    expect(within(await screen.findByTestId("past-version")).getByTestId("class-mark-1").textContent).toBe("New");
  });

  it("asks nothing until a version is opened, then about it against its predecessor", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    // On the draft there is no version to compare, so nothing is asked — and
    // the sheet is a navigator: opening it asks nothing either.
    await openHistory();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent.some((r) => r.url.includes("/schema/compare"))).toBe(false);

    await view(3);
    await waitFor(() => expect(sent.some((r) => r.url.includes("from=2&to=3"))).toBe(true));
    // Never about a version against one that does not exist.
    expect(sent.some((r) => r.url.includes("from=0"))).toBe(false);
  });

  it("asks nothing about version 1, because there is nothing before it", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();
    await view(1);
    await screen.findByTestId("past-version");

    // Its head says it is the first, and no row is marked.
    expect(screen.getByTestId("version-diff-none").textContent).toContain("first version");
    expect(screen.queryAllByTestId(/^class-mark-/)).toHaveLength(0);
    // `from=0` is a 422, so the query is disabled rather than sent with a guess.
    expect(sent.some((r) => r.url.includes("from=0"))).toBe(false);
  });

  it("restores a past version into the draft, with the note, and goes back to the draft", async () => {
    withHistory();
    withDiff(NOTHING);
    renderWithData(
      <>
        <ProjectScreen projectId={PROJECT} tab="schema" />
        <Toaster />
      </>,
    );
    await screen.findByTestId("open-history");
    await view(1);
    await screen.findByTestId("past-version");

    await userEvent.click(screen.getByTestId("restore-version"));

    // Back on the draft, which is now version 1's contract — one class — and
    // nothing has been published: a version is never rewritten.
    await screen.findByTestId("class-list");
    expect(screen.queryByTestId("past-version")).toBeNull();
    await waitFor(() => expect(classCards()).toHaveLength(1));
    expect(screen.getByTestId("class-card-0").getAttribute("aria-label")).toBe("Edit vehicle");
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes create v4");
    expect(barState()).toBe("up");
    expect(screen.getByTestId("save-schema").textContent).toBe("Save version 4");
    expect(sent.some((r) => r.method === "POST" && r.url.includes("/publish"))).toBe(false);
    // Said once, with what Save will do. The draft was clean, so there is
    // nothing to undo and no Undo is offered.
    expect(await screen.findByText("Version 1's classes are in the draft")).not.toBeNull();
    expect(screen.getByText("Saving publishes them as version 4.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("puts the draft that a restore replaced back, when Undo is pressed", async () => {
    withHistory();
    withDiff(NOTHING);
    renderWithData(
      <>
        <ProjectScreen projectId={PROJECT} tab="schema" />
        <Toaster />
      </>,
    );
    await screen.findByTestId("open-history");
    await addNamedClass("pedestrian");
    await view(1);
    await screen.findByTestId("past-version");

    await userEvent.click(screen.getByTestId("restore-version"));

    await waitFor(() => expect(classCards()).toHaveLength(1));
    // The draft held unsaved work, so the restore replaced it and says how to
    // get it back.
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(classCards()).toHaveLength(3));
    expect(screen.getByTestId("class-card-2").getAttribute("aria-label")).toBe("Edit pedestrian");
  });

  it("discards the draft back to the version in force, with an Undo", async () => {
    withHistory();
    withDiff(NOTHING);
    renderWithData(
      <>
        <ProjectScreen projectId={PROJECT} tab="schema" />
        <Toaster />
      </>,
    );
    await screen.findByTestId("open-history");
    await addNamedClass("pedestrian");
    expect(barState()).toBe("up");

    await userEvent.click(screen.getByTestId("discard-draft"));

    // Nothing asked first: what was there is one Undo away, and nothing was published.
    await waitFor(() => expect(classCards()).toHaveLength(2));
    expect(barState()).toBe("down");
    expect(sent.some((r) => r.method === "POST" && r.url.includes("/publish"))).toBe(false);
    expect(await screen.findByText("Draft discarded")).not.toBeNull();

    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(classCards()).toHaveLength(3));
    expect(barState()).toBe("up");
  });

  it("restores a version straight from its History entry, publishing nothing", async () => {
    withHistory();
    withDiff(NOTHING);
    await open();

    const entry = await historyEntry(1);
    await userEvent.click(within(entry).getByTestId("restore-version-1"));

    await waitFor(() => expect(screen.queryByTestId("history-sheet")).toBeNull());
    await waitFor(() => expect(classCards()).toHaveLength(1));
    expect(barState()).toBe("up");
    expect(sent.some((r) => r.method === "POST" && r.url.includes("/publish"))).toBe(false);
  });

  it("publishes a restored version with the message the restore wrote", async () => {
    withHistory();
    withDiff(NOTHING);
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { ...VERSIONS[0], version: 4 }, advanced_batches: [] },
    });
    await open();

    // There is no field for a version's message: the one a draft carries is
    // the restore's own, and Save flushes it with the draft before it
    // publishes — the kernel reads the description off the stored draft.
    const entry = await historyEntry(1);
    await userEvent.click(within(entry).getByTestId("restore-version-1"));
    await waitFor(() => expect(classCards()).toHaveLength(1));
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() => expect(sent.some((r) => r.method === "PUT")).toBe(true));
    const request = sent.filter((r) => r.method === "PUT").at(-1);
    expect(JSON.parse(bodies.get(request!) ?? "{}").note).toBe("Restore version 1");
  });

  /**
   * The old client-side omission this test's name described no longer exists
   * to prove: `SchemaDraftBody.note` (`generated/api.ts`) is a required
   * `string`, so there is no key left to leave out, and "blank is legal"
   * became the kernel's decision (`draft.note or None`, read off the stored
   * draft at publish time) rather than a choice this screen makes about the
   * request. What is still this screen's to get right is that it does not
   * invent a *second* version of that decision — an empty box is sent exactly
   * as typed, not coerced to `null` or held back.
   */
  it("sends an empty note rather than inventing an omission for it", async () => {
    withHistory();
    withDiff(NOTHING);
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { ...VERSIONS[2], version: 4 }, advanced_batches: [] },
    });
    await open();

    await addNamedClass("pedestrian");
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() => expect(sent.some((r) => r.method === "PUT")).toBe(true));
    const request = sent.find((r) => r.method === "PUT");
    expect(JSON.parse(bodies.get(request!) ?? "{}").note).toBe("");
  });

  it("declares every version it publishes as curated", async () => {
    // The editor is where somebody sits down and decides what the project labels,
    // so what makes a version a milestone is the *surface* rather than the size of
    // the change — a one-class save from here is still curated. The sibling claim,
    // that the annotator's dialog says `annotation`, lives in `addClass.test.ts`.
    //
    // `curated` used to be a field on the publish body; it is now the draft's own
    // `kind`, named in the path rather than the payload — so the path this
    // editor publishes through *is* the claim.
    withHistory();
    withDiff(NOTHING);
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published: { ...VERSIONS[2], version: 4 }, advanced_batches: [] },
    });
    await open();

    await addNamedClass("pedestrian");
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(() =>
      expect(
        sent.some(
          (r) =>
            r.method === "POST" &&
            /\/schema\/drafts\/curated\/publish$/.test(new URL(r.url).pathname),
        ),
      ).toBe(true),
    );
  });

  it("shows a published description as soon as the refetch lands", async () => {
    withHistory();
    withDiff(NOTHING);
    const published = {
      project_id: PROJECT,
      version: 4,
      classes: CLASSES,
      description: "added pedestrians",
      created_at: "2026-08-02T09:00:00Z",
    };
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published, advanced_batches: [] },
    });
    await open();
    await addNamedClass("pedestrian");

    // The refetch after the save finds a fourth version, which is what the
    // history renders — this is the round trip, not the mutation's own answer.
    handlers.length = 0;
    withHistory([...VERSIONS, published], published);
    withDiff(NOTHING);
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: { published, advanced_batches: [] },
    });
    await userEvent.click(screen.getByTestId("save-schema"));

    // Back on the draft after a publish, and the history — the one place every
    // version's own note is shown without being opened — carries it.
    await waitFor(() => expect(screen.getByTestId("open-history").getAttribute("aria-label")).toContain("version 4"));
    const history = await openHistory();
    await waitFor(() =>
      expect(within(history).getByTestId("version-4").textContent).toContain("added pedestrians"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("schema-status").textContent).toContain("Version 4 active"),
    );
  });

  it("says so rather than going blank when the comparison cannot be loaded", async () => {
    withHistory();
    on("GET", /schema\/compare/, { status: 500, body: { code: "INTERNAL_ERROR", message: "no" } });
    await open();
    await view(2);

    await screen.findByTestId("version-diff-error");
    // The version is still readable and still restorable: a diff is context, not
    // the contract.
    expect(screen.queryByTestId("past-version")).not.toBeNull();
    expect(screen.queryByTestId("restore-version")).not.toBeNull();
    // And the draft it came from is untouched.
    await userEvent.click(screen.getByTestId("back-to-active"));
    expect(screen.queryByTestId("save-schema")).not.toBeNull();
    // Restoring from the history does not wait on a comparison either.
    const entry = await historyEntry(2);
    expect(within(entry).getByTestId("restore-version-2")).not.toBeNull();
  });
});

describe("the schema editor's class ledger", () => {
  /** Fifty classes: an ordinary Physical AI ontology, and what the stack broke at. */
  const MANY = Array.from({ length: 50 }, (_, index) => ({
    name: `class-${String(index).padStart(2, "0")}`,
    geometries: ["bbox"],
    color: null,
    attributes: [],
  }));

  function withClasses(
    classes: unknown[],
    options: {
      readonly usage?: readonly { label_class: string; annotations: number; assets: number }[];
      readonly versions?: readonly unknown[];
    } = {},
  ): void {
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
      body: { project_id: PROJECT, version: 1, classes },
    });
    on("GET", /schema\/versions$/, {
      status: 200,
      body: { items: options.versions ?? [], total: options.versions?.length ?? 0 },
    });
    on("GET", /\/stats$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        asset_count: 10,
        annotated_asset_count: 5,
        annotation_count: 4372,
        class_count: classes.length,
        annotated_pct: 50,
        classes: options.usage ?? [{ label_class: "class-00", annotations: 4372, assets: 5 }],
      },
    });
    on("GET", /\/assets$/, { status: 200, body: { items: [], total: 0 } });
    on("GET", /\/batches/, { status: 200, body: { items: [], total: 0 } });
  }

  /** Open one class's dialog. */
  async function openCard(index: number): Promise<void> {
    await userEvent.click(screen.getByTestId(`class-card-${index}`));
    await screen.findByTestId(`class-${index}`);
  }

  /** Pick the Shortcut the open dialog's class should hold — its place in the list. */
  async function choosePosition(slot: number, place: number): Promise<void> {
    await userEvent.click(screen.getByTestId(`class-position-${slot}`));
    await userEvent.click(await screen.findByTestId(`class-position-${slot}-${place}`));
  }

  it("shows every class as a row, and none of their forms until one is opened", async () => {
    // The whole point of the layout. Fifty stacked forms is what the first
    // editor was, and it is unusable well before fifty. Rows come twenty-five to
    // a page, so the table is never as long as the schema.
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    await screen.findByTestId("class-list");
    expect(classCards()).toHaveLength(25);
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–25 of 50 classes");
    expect(screen.queryByTestId("class-sheet")).toBeNull();
    expect(screen.queryByTestId("class-name-0")).toBeNull();
    expect(screen.queryByTestId("class-name-49")).toBeNull();
    // The ledger is the page: no picker to choose a class from.
    expect(screen.queryByTestId("class-picker")).toBeNull();
  });

  it("shows a row's name, shapes, hotkey, attributes and how much has been drawn with it", async () => {
    withClasses([
      {
        name: "class-00",
        geometries: ["bbox", "polygon"],
        color: "#38bdf8",
        attributes: [
          { name: "occluded", kind: "boolean", required: true, options: null, default: null },
          { name: "note", kind: "string", required: false, options: null, default: null },
        ],
      },
      { name: "class-01", geometries: ["polyline"], color: null, attributes: [] },
    ]);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    const first = screen.getByTestId("class-card-0");
    // A row's name is a plain button that says what it opens.
    expect(first.tagName).toBe("BUTTON");
    expect(first.getAttribute("aria-label")).toBe("Edit class-00");
    expect(first.getAttribute("aria-haspopup")).toBeNull();
    expect(first.textContent).toContain("class-00");
    // How many attributes it declares, inline beside the name.
    expect(first.textContent).toContain("2 attributes");
    const row = screen.getByTestId("class-row-0");
    // One glyph per geometry, each shape named in words for a screen reader.
    expect(row.querySelectorAll("svg[viewBox='0 0 28 20']")).toHaveLength(2);
    expect(row.textContent).toContain("box");
    expect(row.textContent).toContain("polygon");
    // The hotkey the annotator will give it, and the attributes it declares —
    // a required one carries a star.
    expect(within(row).getByLabelText("Hotkey 1").textContent).toBe("1");
    expect(row.textContent).toContain("occluded*, note");
    expect(row.textContent).not.toContain("note*");
    expect(row.textContent).not.toContain("No attributes");

    const second = screen.getByTestId("class-row-1");
    expect(within(second).getByLabelText("Hotkey 2").textContent).toBe("2");
    expect(second.textContent).toContain("No attributes");

    // Counts arrive after the rows do, and a class nothing has used says so.
    await waitFor(() =>
      expect(screen.getByTestId("class-card-count-0").textContent).toBe(
        `${(4372).toLocaleString(undefined)} annotations`,
      ),
    );
    expect(screen.getByTestId("class-card-count-1").textContent).toBe("Not used yet");
  });

  it("speaks of a single annotation in the singular", async () => {
    withClasses(MANY.slice(0, 1), { usage: [{ label_class: "class-00", annotations: 1, assets: 1 }] });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    // The row says it in the singular, and so does the open row's sentence.
    await waitFor(() =>
      expect(screen.getByTestId("class-card-count-0").textContent).toBe("1 annotation"),
    );
    await openCard(0);
    expect(screen.getByTestId("class-count-0").textContent).toContain("1 label on 1 frame");
  });

  it("gives a hotkey to the first nine classes and none to the rest", async () => {
    withClasses(MANY.slice(0, 10));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    expect(screen.getByLabelText("Hotkey 9")).not.toBeNull();
    expect(screen.queryByLabelText("Hotkey 10")).toBeNull();
    expect(screen.getByTestId("class-card-9").textContent).not.toMatch(/\b10\b/);
  });

  it("opens the dialog of the class it names, over the ledger", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-card-1"));

    const detail = await screen.findByTestId("class-sheet");
    // A panel at the right of the table, labelled for what it holds.
    expect(detail.closest("aside")?.getAttribute("aria-label")).toBe("Class");
    expect(detail.closest("[role=dialog]")).toBeNull();
    // Focus went into it, onto the name.
    expect(document.activeElement).toBe(within(detail).getByTestId("class-name-1"));
    expect(within(detail).getByTestId("class-1")).not.toBeNull();
    expect(within(detail).queryByTestId("class-0")).toBeNull();
    expect(within(detail).getByTestId("class-name-1")).toHaveProperty("value", "lane");
    // It is the table's neighbour, not a part of the list.
    expect(screen.getByTestId("class-list").contains(detail)).toBe(false);
    expect(within(detail).getByRole("heading", { name: "Edit lane" })).not.toBeNull();
    // Nothing is drawn with `lane` yet, so the dialog says a change is free.
    expect(screen.getByTestId("class-count-1").textContent).toContain(
      "Not used yet, so any change here is free.",
    );
    expect(screen.getByTestId("class-meta-1").textContent).toContain("Not used yet");
    // One class's form at a time, the other's is not in the page.
    expect(screen.queryByTestId("class-name-0")).toBeNull();
  });

  it("opens a row from the keyboard, and puts it away with Save, focus back on the row", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    screen.getByTestId("class-card-0").focus();
    await userEvent.keyboard("{Enter}");
    await screen.findByTestId("class-0");

    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(classCards()).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByTestId("class-card-0"));
    // Saving what was not changed is not an edit.
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("puts a dialog away with Cancel, and opens another class's in its place, one at a time", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-card-0"));
    await screen.findByTestId("class-0");
    expect(screen.getAllByTestId("class-sheet")).toHaveLength(1);
    // Not modal: the rows beside the panel stay in the page, and it is its own region.
    expect(screen.getByTestId("class-list").closest("[aria-hidden='true']")).toBeNull();
    expect(screen.getByTestId("class-sheet").closest("aside")?.getAttribute("aria-label")).toBe("Class");

    await userEvent.click(screen.getByTestId("class-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("class-card-0"));

    await userEvent.click(screen.getByTestId("class-card-1"));
    await screen.findByTestId("class-1");
    expect(screen.queryByTestId("class-0")).toBeNull();
    expect(screen.getAllByTestId("class-sheet")).toHaveLength(1);

    await userEvent.click(screen.getByTestId("class-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));
    // Closing it is not an edit.
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("puts a dialog away with Escape and hands focus back to the row", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-card-1"));
    const name = await screen.findByTestId("class-name-1");
    name.focus();
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("moves focus between the rows with the arrow keys, and stops at the ends", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    screen.getByTestId("class-card-0").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-2"));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));

    // Moving between rows opens nothing: focus is not selection.
    expect(screen.queryByTestId("class-sheet")).toBeNull();

    // And stops at the ends rather than wrapping or leaving the list.
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-0"));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-0"));

    // J and K too, as every table on the workbench takes them.
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));
    await userEvent.keyboard("k");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-0"));
  });

  it("shows how much a class is drawn with as a bar relative to the most-drawn one", async () => {
    withClasses(MANY.slice(0, 3), {
      usage: [
        { label_class: "class-00", annotations: 40, assets: 4 },
        { label_class: "class-01", annotations: 10, assets: 1 },
      ],
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    const share = (name: string): HTMLElement =>
      screen.getByRole("progressbar", { name: `${name}: share of the most-drawn class` });
    // Counts arrive after the rows do; the bars follow them.
    await waitFor(() => expect(share("class-00").getAttribute("aria-valuenow")).toBe("100"));
    // A quarter of the busiest class; one nothing is drawn with says so in
    // words rather than drawing an empty bar.
    expect(share("class-01").getAttribute("aria-valuenow")).toBe("25");
    expect(screen.queryByRole("progressbar", { name: "class-02: share of the most-drawn class" })).toBeNull();
    expect(screen.getByTestId("class-card-count-2").textContent).toBe("Not used yet");
    expect(share("class-01").closest('[data-testid="class-row-1"]')).not.toBeNull();
  });

  it("draws a row's bar in its class's colour, declared or derived, and none for an unused class", async () => {
    withClasses(
      [
        { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
        { name: "lane", geometries: ["polygon"], color: null, attributes: [] },
        { name: "sign", geometries: ["bbox"], color: null, attributes: [] },
      ],
      {
        usage: [
          { label_class: "vehicle", annotations: 4, assets: 1 },
          { label_class: "lane", annotations: 2, assets: 1 },
        ],
      },
    );
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    const declared = await screen.findByTestId("class-card-bar-0");
    expect(declared.style.getPropertyValue("--bar")).toBe("#38bdf8");
    expect(declared.style.getPropertyValue("--bar-track")).toContain("#38bdf8");
    // Derived from the name, so the same colour the annotator draws it in.
    const derived = screen.getByTestId("class-card-bar-1");
    expect(derived.style.getPropertyValue("--bar")).toBe(classColor({ name: "lane", geometries: ["polygon"], color: null, attributes: [] }, "lane"));
    expect(declared.getAttribute("aria-valuenow")).toBe("100");
    expect(derived.getAttribute("aria-valuenow")).toBe("50");
    // Nothing drawn with it: said, not drawn.
    expect(screen.queryByTestId("class-card-bar-2")).toBeNull();
    expect(screen.getByTestId("class-card-count-2").textContent).toBe("Not used yet");
  });

  it("discards what was typed when its dialog is put away with Escape", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.type(screen.getByTestId("class-name-1"), "s");
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(screen.getByTestId("class-card-1").getAttribute("aria-label")).toBe("Edit lane");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    // Opened again, it is the class as the draft holds it, not as it was left.
    await openCard(1);
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "lane");
  });

  it("opens a class on the draft's values again after Cancel", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.type(screen.getByTestId("class-name-1"), "s");
    await choosePosition(1, 0);
    await userEvent.click(screen.getByTestId("class-geometry-1-bbox"));
    await cancelSheet();

    await openCard(1);
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "lane");
    expect(screen.getByTestId("class-position-1").textContent).toBe("2picks it while annotating");
    expect(screen.getByTestId("class-geometry-1-bbox").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("class-geometry-1-polygon").getAttribute("aria-pressed")).toBe("true");
    // And Saving it unchanged is no edit, rather than writing the discarded one.
    await closeSheet();
    expect(screen.getByTestId("class-card-1").getAttribute("aria-label")).toBe("Edit lane");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("opens a blank dialog for a second add, with no name carried over from the first", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await addNamedClass("a");
    expect(classCards()).toHaveLength(3);

    await userEvent.click(screen.getByTestId("add-class"));
    const name = await screen.findByTestId("class-name-3");
    expect(name).toHaveProperty("value", "");
    expect(screen.queryByTestId("class-name-error-3")).toBeNull();
    expect(screen.getByTestId("class-position-3").textContent).toBe("4picks it while annotating");
    expect(screen.getByTestId("class-sheet-done").textContent).toBe("Add to draft");

    await userEvent.type(name, "b");
    await closeSheet();
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual([
      "Edit vehicle",
      "Edit lane",
      "Edit a",
      "Edit b",
    ]);
  });

  it("opens an add on a blank dialog after an abandoned one", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(await screen.findByTestId("class-name-2"), "pedestrian");
    await cancelSheet();

    await userEvent.click(screen.getByTestId("add-class"));
    expect(await screen.findByTestId("class-name-2")).toHaveProperty("value", "");
    expect(screen.queryByTestId("class-name-error-2")).toBeNull();
  });

  it("opens the class that took a removed one's place on its own fields", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.click(screen.getByTestId("remove-class-0"));
    await waitFor(() => expect(classCards()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    await openCard(0);
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "lane");
    expect(screen.getByTestId("class-geometry-0-polygon").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("class-geometry-0-bbox").getAttribute("aria-pressed")).toBe("false");
    // Saved as it is, it leaves the surviving class alone.
    await closeSheet();
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit lane"]);
  });

  it("says a class is in use, in its dialog, once something is drawn with it", async () => {
    withClasses(MANY.slice(0, 2));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");
    await waitFor(() =>
      expect(screen.getByTestId("class-card-count-0").textContent).toContain(
        (4372).toLocaleString(undefined),
      ),
    );

    // `class-00` has 4,372 annotations on 5 frames; `class-01` has none.
    await openCard(0);
    expect(screen.getByTestId("class-count-0").textContent).toBe(
      `${(4372).toLocaleString(undefined)} labels on 5 frames — removing the class, or a shape they use, waits until they are cleared.`,
    );

    await cancelSheet();
    await openCard(1);
    expect(screen.getByTestId("class-count-1").textContent).toBe(
      "Not used yet, so any change here is free.",
    );
  });

  /** The classes' names in ledger order, read off the rows' own labels. */
  function ledgerOrder(): (string | null)[] {
    return classCards().map((card) => card.getAttribute("aria-label"));
  }

  it("moves a class by its Shortcut, as one edit applied on Save that renumbers the hotkeys", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");

    await openCard(0);
    // Said as a number, because a class's position is its hotkey.
    expect(screen.getByTestId("class-position-0").textContent).toBe("1picks it while annotating");
    await choosePosition(0, 1);
    // And as whose place it takes, before anything is saved.
    expect(screen.getByTestId("class-position-0").textContent).toBe("2takes class-01's place");
    // Picking is buffered like every other field: the ledger has not moved.
    expect(ledgerOrder()).toEqual(["Edit class-00", "Edit class-01", "Edit class-02"]);
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");

    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(ledgerOrder()).toEqual(["Edit class-01", "Edit class-00", "Edit class-02"]);
    // A move is an edit like any other.
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    // The hotkeys follow the positions, not the classes.
    expect(within(screen.getByTestId("class-row-0")).getByLabelText("Hotkey 1")).not.toBeNull();
    expect(within(screen.getByTestId("class-row-1")).getByLabelText("Hotkey 2")).not.toBeNull();
    expect(screen.getByTestId("class-card-1").textContent).toContain("class-00");
    // The dialog is gone, and focus is on the row the class landed in.
    expect(screen.queryByTestId("class-sheet")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));

    // Opened again, it is the same class, now at place two.
    await openCard(1);
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "class-00");
    expect(screen.getByTestId("class-position-1").textContent).toBe("2picks it while annotating");
  });

  it("moves a class up, and moving it back is no change at all", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(2);
    await choosePosition(2, 1);
    await closeSheet();

    expect(ledgerOrder()).toEqual(["Edit class-00", "Edit class-02", "Edit class-01"]);
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-1"));

    // The order the active version has again: nothing left to save.
    await openCard(1);
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "class-02");
    await choosePosition(1, 2);
    await closeSheet();
    expect(ledgerOrder()).toEqual(["Edit class-00", "Edit class-01", "Edit class-02"]);
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("changes nothing when the Shortcut it holds is picked again, and a move is lost to Cancel", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    // Every place the list has, and no more: three classes, three keys.
    await userEvent.click(screen.getByTestId("class-position-0"));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await userEvent.click(await screen.findByTestId("class-position-0-0"));
    await closeSheet();
    expect(ledgerOrder()).toEqual(["Edit class-00", "Edit class-01", "Edit class-02"]);
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");

    await openCard(0);
    await choosePosition(0, 2);
    await cancelSheet();
    expect(ledgerOrder()).toEqual(["Edit class-00", "Edit class-01", "Edit class-02"]);
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("names whose place each Shortcut takes, and says when a place has no key", async () => {
    // Only the first nine classes have one, so the tenth is where a move runs out.
    withClasses(MANY.slice(0, 10));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(8);
    await userEvent.click(screen.getByTestId("class-position-8"));
    expect(screen.getByTestId("class-position-8-8").textContent).toContain("where it is now");
    expect(screen.getByTestId("class-position-8-7").textContent).toContain("class-07");
    expect(screen.getByTestId("class-position-8-9").textContent).toContain("class-09");
    expect(screen.getByTestId("class-position-8-9").textContent).toContain("no key");
    expect(screen.getByTestId("class-position-8-7").textContent).not.toContain("no key");
    await userEvent.click(screen.getByTestId("class-position-8-9"));
    // Past the ninth the trigger says there is no key, and its title says why.
    expect(screen.getByTestId("class-position-8").textContent).toBe("No key — past the ninth class");
    expect(screen.getByTestId("class-position-8").getAttribute("title")).toMatch(/Only the first nine classes have a key/);
    await userEvent.click(screen.getByTestId("class-position-8"));
    await userEvent.click(await screen.findByTestId("class-position-8-7"));
    expect(screen.getByTestId("class-position-8").textContent).toBe("8takes class-07's place");
    expect(screen.getByTestId("class-position-8").getAttribute("title")).toBe("Pressing 8 picks this class while annotating");
  });

  it("clears the filter when a class is moved, so it lands where it can be seen", async () => {
    // The class lands somewhere the filter may hide.
    withClasses(MANY.slice(0, 9));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "class-03");
    expect(classCards()).toHaveLength(1);
    await userEvent.click(classCards()[0]);
    await choosePosition(3, 2);
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(screen.getByTestId("class-filter")).toHaveProperty("value", "");
    expect(classCards()).toHaveLength(9);
    expect(screen.getByTestId("class-card-2").getAttribute("aria-label")).toBe("Edit class-03");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-2"));
  });

  it("adds the class once on Ctrl+Enter, from the name and from anywhere else in the sheet", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(await screen.findByTestId("class-name-2"), "pedestrian");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual([
      "Edit vehicle",
      "Edit lane",
      "Edit pedestrian",
    ]);

    // And from a control that is not the name: Meta, on the shape chips.
    await openCard(1);
    await userEvent.click(screen.getByTestId("class-geometry-1-polyline"));
    screen.getByTestId("class-geometry-1-polyline").focus();
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    await openCard(1);
    expect(screen.getByTestId("class-geometry-1-polyline").getAttribute("aria-pressed")).toBe("true");
    expect(classCards()).toHaveLength(3);
  });

  it("does not submit on Ctrl+Enter while the class has no name, and says so", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await screen.findByTestId("class-name-2");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");

    expect((await screen.findByTestId("class-name-error-2")).textContent).toBe("Name this class.");
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(classCards()).toHaveLength(2);
  });

  it("keeps the one status line when a name is taken: the error replaces the facts, in the same place", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    const meta = screen.getByTestId("class-meta-1");
    const status = meta.parentElement!;
    expect(screen.queryByTestId("class-name-error-1")).toBeNull();

    await userEvent.clear(screen.getByTestId("class-name-1"));
    await userEvent.type(screen.getByTestId("class-name-1"), "vehicle");

    // The same line says it, so nothing below it moves.
    const error = await screen.findByTestId("class-name-error-1");
    expect(error.parentElement).toBe(status);
    expect(screen.queryByTestId("class-meta-1")).toBeNull();
    expect(screen.getByTestId("class-name-1").getAttribute("aria-describedby")).toBe(error.id);

    await userEvent.clear(screen.getByTestId("class-name-1"));
    await userEvent.type(screen.getByTestId("class-name-1"), "lane");
    expect(await screen.findByTestId("class-meta-1")).toBeTruthy();
    expect(screen.queryByTestId("class-name-error-1")).toBeNull();
  });

  it("adds an attribute line in the sheet, in place, and writes it to the draft on Save", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    const add = screen.getByTestId("add-attribute-0");
    await userEvent.click(add);
    // The button did not move, and the new group is open with its name in focus.
    expect(screen.getByTestId("add-attribute-0")).toBe(add);
    expect(screen.getByTestId("attr-toggle-0-0").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByTestId("attr-name-0-0"));
    await userEvent.type(screen.getByTestId("attr-name-0-0"), "occluded");
    await userEvent.click(screen.getByTestId("attr-required-0-0"));
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");

    await closeSheet();
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    expect(screen.getByTestId("class-row-0").textContent).toContain("occluded*");

    // Reopened, the group is closed again and says what it asks; opening it shows the fields.
    await openCard(0);
    const toggle = screen.getByTestId("attr-toggle-0-0");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("occluded, Text · required");
    // The active version has no such attribute, so the group is marked new.
    expect(within(toggle).getByText("new")).toBeTruthy();
    await userEvent.click(toggle);
    expect(screen.getByTestId("attr-name-0-0")).toHaveProperty("value", "occluded");
    expect(screen.getByTestId("attr-required-0-0").getAttribute("aria-checked")).toBe("true");
  });

  it("drops an attribute line nobody touched on Save, so a blank name never reaches the draft", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.click(screen.getByTestId("add-attribute-0"));
    await userEvent.click(screen.getByTestId("add-attribute-0"));
    expect(screen.getByTestId("attr-row-0-1")).toBeTruthy();

    // Two abandoned adds and nothing else: Save is no change at all.
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    expect(screen.getByTestId("class-row-0").textContent).not.toContain("unnamed");
  });

  it("refuses Save while an attribute somebody filled in has no name, and says so on the status line", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.click(screen.getByTestId("add-attribute-0"));
    await userEvent.click(screen.getByTestId("attr-required-0-0"));

    await userEvent.click(screen.getByTestId("class-sheet-done"));
    expect(screen.getByTestId("class-sheet")).toBeTruthy();
    expect(screen.getByTestId("class-attribute-error-0").textContent).toContain("Name every attribute");
    expect(document.activeElement).toBe(screen.getByTestId("attr-name-0-0"));
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");

    await userEvent.type(screen.getByTestId("attr-name-0-0"), "occluded");
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(screen.getByTestId("class-row-0").textContent).toContain("occluded*");
  });

  it("makes a choice the default by pressing its chip, and keeps that on Save", async () => {
    withClasses([
      {
        name: "lane",
        geometries: ["polyline"],
        color: null,
        attributes: [{ name: "surface", kind: "select", required: false, options: ["tarmac", "gravel"], default: null }],
      },
    ]);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.click(screen.getByTestId("attr-toggle-0-0"));
    await userEvent.click(screen.getByRole("button", { name: "gravel" }));
    expect(screen.getByRole("button", { name: "gravel" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "tarmac" }).getAttribute("aria-pressed")).toBe("false");
    await closeSheet();
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");

    await openCard(0);
    await userEvent.click(screen.getByTestId("attr-toggle-0-0"));
    expect(screen.getByRole("button", { name: "gravel" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("edits a class in its dialog, and the row shows the change only once saved", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.type(screen.getByTestId("class-name-1"), "s");
    // The dialog holds a working copy: neither the row nor the draft has it yet.
    expect(screen.getByTestId("class-card-1").getAttribute("aria-label")).toBe("Edit lane");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    await closeSheet();

    expect(screen.getByTestId("class-card-1").getAttribute("aria-label")).toBe("Edit lanes");
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
  });

  it("writes the draft once on Save, trimming the name, with every field and the move in that one edit", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(2);
    await userEvent.type(screen.getByTestId("class-name-2"), "  extra ");
    await userEvent.click(screen.getByTestId("class-geometry-2-polygon"));
    // The palette is behind the swatch; it is put away again before the rest.
    await userEvent.click(screen.getByTestId("class-color-trigger-2"));
    await userEvent.click(screen.getByTestId("class-palette-2-7C3AED"));
    await userEvent.keyboard("{Escape}");
    await choosePosition(2, 0);
    expect(ledgerOrder()).toEqual(["Edit class-00", "Edit class-01", "Edit class-02"]);
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(ledgerOrder()).toEqual(["Edit class-02  extra", "Edit class-00", "Edit class-01"]);
    // One edit carried all of it, and the name lost its trailing space.
    await openCard(0);
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "class-02  extra");
    expect(screen.getByTestId("class-geometry-0-polygon").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("class-color-trigger-0").getAttribute("aria-description")).toBe("#7C3AED");
    expect(screen.getByTestId("class-position-0").textContent).toBe("1picks it while annotating");
  });

  it("closes with its close button without keeping what was typed", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.type(screen.getByTestId("class-name-0"), "x");
    const sheet = screen.getByTestId("class-sheet");
    await userEvent.click(within(sheet).getByRole("button", { name: "Close vehicle" }));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("class-card-0"));

    expect(screen.getByTestId("class-card-0").getAttribute("aria-label")).toBe("Edit vehicle");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("is not replaced by another row while it holds changes, and is when it holds none", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.type(screen.getByTestId("class-name-0"), "x");
    // The rows are beside the panel, not behind a modal: a press on one is
    // answered rather than obeyed, so the typed name is not thrown away.
    await userEvent.click(screen.getByTestId("class-card-1"));
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "vehiclex");
    expect(screen.queryByTestId("class-name-1")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("class-name-0"));

    await userEvent.clear(screen.getByTestId("class-name-0"));
    await userEvent.type(screen.getByTestId("class-name-0"), "vehicle");
    await userEvent.click(screen.getByTestId("class-card-1"));
    await screen.findByTestId("class-name-1");
    expect(screen.getAllByTestId("class-sheet")).toHaveLength(1);
    expect(screen.queryByTestId("class-name-0")).toBeNull();
  });

  it("locks its fields and its buttons while a save is in flight", async () => {
    withClasses(CLASSES);
    let resolvePreview: ((answer: Exclude<HandlerAnswer, undefined>) => void) | undefined;
    handlers.push((request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/schema/preview")) return undefined;
      return new Promise((resolve) => {
        resolvePreview = resolve;
      });
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));
    await waitFor(() => expect(screen.getByTestId("class-sheet-done")).toHaveProperty("disabled", true));
    expect(screen.getByTestId("class-name-1")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("class-geometry-1-polygon")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("class-position-1")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("class-color-trigger-1")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("add-attribute-1")).toHaveProperty("disabled", true);

    if (resolvePreview === undefined) throw new Error("Expected the deferred preview request");
    resolvePreview({
      status: 200,
      body: { diff: { changes: [], destructive_classes: [], is_destructive: false }, blockers: [], is_refused: false },
    });
    await waitFor(() => expect(classCards()).toHaveLength(1));
  });

  it("gives its blockers dialog the page, and comes back to the class dialog when it is closed", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));
    await screen.findByTestId("orphan-dialog");
    expect(screen.getByTestId("orphan-dialog").textContent).toContain("“lane” can’t be removed yet");
    await userEvent.click(screen.getByTestId("orphan-close"));

    await waitFor(() => expect(screen.queryByTestId("orphan-dialog")).toBeNull());
    // Back on the class it was about, still open and still editable.
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(screen.getByTestId("remove-class-1").getAttribute("aria-label")).toBe("Remove class 2");
    await waitFor(() => expect(screen.getByTestId("class-name-1")).toHaveProperty("disabled", false));
  });


  it("opens the class a row names, not the row's position in a filtered ledger", async () => {
    // The trap the filter creates: a row's index in the *view* is not its index
    // in the schema, and writing through the wrong one edits a different class.
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "class-42");
    expect(classCards()).toHaveLength(1);

    await userEvent.click(classCards()[0]);
    expect(await screen.findByTestId("class-name-42")).toHaveProperty("value", "class-42");
    expect(screen.getByTestId("class-42")).not.toBeNull();
  });

  it("filters case-insensitively on a substring", async () => {
    withClasses([
      { name: "Vehicle", geometries: ["bbox"], color: null, attributes: [] },
      ...MANY.slice(0, 8),
    ]);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "EHIC");
    expect(classCards()).toHaveLength(1);
    expect(classCards()[0].getAttribute("aria-label")).toBe("Edit Vehicle");
  });

  it("says so when a filter matches nothing, rather than showing an empty box", async () => {
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "zzz");
    // A sentence in the accordion's place, not an accordion with nothing in it.
    expect(screen.getByTestId("filter-empty").textContent).toBe("No class matches “zzz”.");
    expect(screen.queryByTestId("class-list")).toBeNull();
    expect(classCards()).toHaveLength(0);
    // The way to add a class is still there while nothing matches.
    expect(screen.getByTestId("add-class")).not.toBeNull();
  });

  it("clears the filter with its clear button, and with Escape, bringing every row back", async () => {
    withClasses(MANY.slice(0, 12));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-filter");
    expect(classCards()).toHaveLength(12);
    // No clear button while there is nothing to clear.
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    await userEvent.type(screen.getByTestId("class-filter"), "class-0");
    expect(classCards()).toHaveLength(10);
    await userEvent.type(screen.getByTestId("class-filter"), "3");
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit class-03"]);

    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByTestId("class-filter")).toHaveProperty("value", "");
    expect(classCards()).toHaveLength(12);
    expect(document.activeElement).toBe(screen.getByTestId("class-filter"));

    await userEvent.type(screen.getByTestId("class-filter"), "zzz");
    expect(screen.getByTestId("filter-empty")).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("filter-empty")).toBeNull();
    expect(classCards()).toHaveLength(12);
  });

  it("offers the filter in the band whenever there is a class to find, and / reaches it from anywhere", async () => {
    // A tool that came and went with the ninth class moved the band under the
    // pointer; the band holds its tools still.
    withClasses(MANY.slice(0, 1));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    expect(screen.getByTestId("class-filter")).not.toBeNull();
    expect(screen.getByTestId("class-filter").getAttribute("aria-keyshortcuts")).toBe("/");
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("/");
    expect(document.activeElement).toBe(screen.getByTestId("class-filter"));
    // Typed into the filter, a slash is a slash.
    await userEvent.keyboard("/");
    expect(screen.getByTestId("class-filter")).toHaveProperty("value", "/");
  });

  it("keeps the filter in place as classes are added and removed", async () => {
    withClasses(MANY.slice(0, 8));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");
    const filter = screen.getByTestId("class-filter");

    await addNamedClass("class-08", 8);
    expect(screen.getByTestId("class-filter")).toBe(filter);
    expect(classCards()).toHaveLength(9);

    // Asked of the server, which answers that nothing is in the way.
    await openCard(8);
    await userEvent.click(screen.getByTestId("remove-class-8"));
    await waitFor(() => expect(classCards()).toHaveLength(8));
    expect(screen.getByTestId("class-filter")).toBe(filter);
  });

  it("offers Add class from the empty ledger, which opens a dialog and gives way to the class it adds", async () => {
    withClasses([]);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    const none = await screen.findByTestId("classes-none");
    expect(within(none).getByText("No classes yet")).not.toBeNull();
    await userEvent.click(within(none).getByRole("button", { name: "New class" }));

    await screen.findByTestId("class-0");
    // Nothing exists until the dialog submits, so the empty ledger stays put.
    expect(screen.queryByTestId("classes-none")).not.toBeNull();
    expect(classCards()).toHaveLength(0);

    await userEvent.type(screen.getByTestId("class-name-0"), "vehicle");
    await closeSheet();

    expect(screen.queryByTestId("classes-none")).toBeNull();
    expect(classCards()).toHaveLength(1);
    expect(screen.getByTestId("class-card-0").getAttribute("aria-label")).toBe("Edit vehicle");
    // Below the ledger now, as the one button that adds another.
    expect(screen.getAllByTestId("add-class")).toHaveLength(1);
    expect(screen.queryByTestId("classes-none")).toBeNull();
  });

  it("says what a class is when there are none, with Add class as the only way on", async () => {
    withClasses([]);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    const none = await screen.findByTestId("classes-none");
    expect(none.textContent).toContain("No classes yet");
    expect(none.textContent).toContain("A class is a name for what you draw");
    expect(classCards()).toHaveLength(0);
    expect(screen.queryByTestId("class-list")).toBeNull();
    // The one Add class button, and it lives in the Empty.
    expect(screen.getAllByTestId("add-class")).toHaveLength(1);
    expect(within(none).getByTestId("add-class")).not.toBeNull();
    expect(screen.queryByTestId("class-filter")).toBeNull();

    // The line goes once there is a class to look at — not when the dialog opens.
    await userEvent.click(screen.getByTestId("add-class"));
    await screen.findByTestId("class-0");
    expect(screen.queryByTestId("classes-none")).not.toBeNull();
    await userEvent.type(screen.getByTestId("class-name-0"), "vehicle");
    await closeSheet();
    expect(screen.queryByTestId("classes-none")).toBeNull();
  });

  it("pages the ledger twenty-five to a page, keeps each class's own place, and returns focus to a row on the page it is on", async () => {
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 2");
    expect(screen.getByTestId("table-pager-prev").getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(screen.getByTestId("table-pager-next"));

    // The second page holds the schema's own places 26–50: a row's place is its
    // position in the schema, never its place on the page.
    expect(screen.getByTestId("table-pager-range").textContent).toBe("26–50 of 50 classes");
    expect(classCards()).toHaveLength(25);
    expect(screen.queryByTestId("class-card-0")).toBeNull();
    expect(screen.getByTestId("class-row-25")).not.toBeNull();
    expect(screen.getByTestId("class-card-25").getAttribute("aria-label")).toBe("Edit class-25");

    // Opening a class there and putting the sheet away returns focus to its row.
    await userEvent.click(screen.getByTestId("class-card-30"));
    await screen.findByTestId("class-sheet");
    await closeSheet();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("class-card-30")));

    // The filter's rows are paged too, and narrowing starts over at the first page.
    await userEvent.type(screen.getByTestId("class-filter"), "class-4");
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–10 of 10 classes · filtered from 50");
    expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 1");
  });

  it("adds a class from a dialog on a blank one, and nothing is added until it submits", async () => {
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));

    const detail = await screen.findByTestId("class-sheet");
    expect(within(detail).getByRole("heading", { name: "New class" })).not.toBeNull();
    expect(within(detail).getByTestId("class-50")).not.toBeNull();
    expect(within(detail).getByTestId("class-name-50")).toHaveProperty("value", "");
    // Focus lands in the name, so adding a class is typing its name.
    expect(document.activeElement).toBe(screen.getByTestId("class-name-50"));
    // One shape to begin with, and a shortcut at the end of the list.
    expect(screen.getByTestId("class-geometry-50-bbox").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("class-position-50").getAttribute("title")).toMatch(/Only the first nine classes have a key/);
    // Not a class yet: no row, no draft change, and no Remove for what is not there.
    expect(classCards()).toHaveLength(25);
    expect(screen.getByTestId("table-pager-range").textContent).toBe("1–25 of 50 classes");
    expect(screen.queryByTestId("class-card-50")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    expect(screen.queryByTestId("remove-class-50")).toBeNull();
    // The button says what pressing it will do, and names the class once it has a name.
    expect(screen.getByTestId("class-sheet-done").textContent).toBe("Add to draft");
    await userEvent.type(screen.getByTestId("class-name-50"), "  pedestrian ");
    expect(screen.getByTestId("class-sheet-done").textContent).toBe("Add pedestrian to draft");
    expect(classCards()).toHaveLength(25);

    await userEvent.click(screen.getByTestId("class-sheet-done"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    // Once, at the end, with its name trimmed — on the last page, which is the
    // page shown so focus can return to the row.
    expect(screen.getByTestId("table-pager-range").textContent).toBe("51 of 51 classes");
    expect(classCards()).toHaveLength(1);
    expect(screen.getByTestId("class-card-50").getAttribute("aria-label")).toBe("Edit pedestrian");
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    expect(document.activeElement).toBe(screen.getByTestId("class-card-50"));
  });

  it("adds the class once when Enter submits the dialog", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(await screen.findByTestId("class-name-2"), "pedestrian{Enter}");
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual([
      "Edit vehicle",
      "Edit lane",
      "Edit pedestrian",
    ]);
  });

  it("abandons an add with Cancel, leaving no class and no unsaved change behind", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(await screen.findByTestId("class-name-2"), "pedestrian");
    await userEvent.click(screen.getByTestId("class-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(classCards()).toHaveLength(2);
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
    expect(document.activeElement).toBe(screen.getByTestId("add-class"));
  });

  it("refuses to add a class with no name, saying so beside the field", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await screen.findByTestId("class-name-2");
    expect(screen.queryByTestId("class-name-error-2")).toBeNull();
    await userEvent.click(screen.getByTestId("class-sheet-done"));

    expect((await screen.findByTestId("class-name-error-2")).textContent).toBe("Name this class.");
    expect(screen.getByTestId("class-name-2").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("class-name-2"));
    expect(classCards()).toHaveLength(2);
    // Whitespace is no name either.
    await userEvent.type(screen.getByTestId("class-name-2"), "   ");
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(classCards()).toHaveLength(2);
  });

  it("says a name is taken as it is typed, ignoring case and spaces, and will not submit it", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(await screen.findByTestId("class-name-2"), "  LANE ");

    // Live, before anything is pressed, and naming the class it clashes with.
    expect((await screen.findByTestId("class-name-error-2")).textContent).toBe(
      "“lane” already has this name — names ignore case.",
    );
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(classCards()).toHaveLength(2);

    // A different name clears it, and the add goes through.
    await userEvent.clear(screen.getByTestId("class-name-2"));
    await userEvent.type(screen.getByTestId("class-name-2"), "lane marking");
    expect(screen.queryByTestId("class-name-error-2")).toBeNull();
    await closeSheet();
    expect(classCards()).toHaveLength(3);
  });

  it("says a rename is taken too, but not that a class clashes with itself", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    // Its own name, in another case, is the same class and not a clash.
    await userEvent.clear(screen.getByTestId("class-name-1"));
    await userEvent.type(screen.getByTestId("class-name-1"), "Lane");
    expect(screen.queryByTestId("class-name-error-1")).toBeNull();

    await userEvent.clear(screen.getByTestId("class-name-1"));
    await userEvent.type(screen.getByTestId("class-name-1"), "VEHICLE");
    expect((await screen.findByTestId("class-name-error-1")).textContent).toContain("“vehicle” already has this name");
    await userEvent.click(screen.getByTestId("class-sheet-done"));
    expect(screen.getByTestId("class-sheet")).not.toBeNull();
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("clears the filter when a class is added, or the new class would be hidden by it", async () => {
    // A filter that matched the new name's absence would hide the card that was
    // just created, and the ledger would look as though nothing had happened.
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-filter");

    await userEvent.type(screen.getByTestId("class-filter"), "class-42");
    expect(classCards()).toHaveLength(1);
    await addNamedClass("zebra", 50);

    expect(screen.getByTestId("class-filter")).toHaveProperty("value", "");
    // The new class is the 51st, on the last page — and that page is the one shown.
    expect(screen.getByTestId("table-pager-range").textContent).toBe("51 of 51 classes");
    expect(screen.getByTestId("class-card-50").getAttribute("aria-label")).toBe("Edit zebra");
  });

  it("keeps an orphaning removal terminal and leaves the draft unchanged", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    expect((await screen.findByTestId("orphan-dialog")).textContent).toContain("12 annotations");
    expect(screen.getByTestId("orphan-dialog").textContent).toContain("3 assets");
    expect(screen.queryByTestId("remove-class-confirm")).toBeNull();
    expect(screen.queryByTestId("allow-destructive")).toBeNull();
    // Refused, so the class is still in the draft and still in its open row.
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "lane");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved changes");
  });

  it("lists the frames behind a refusal in the dialog, for a host that can open a batch", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    on("POST", /\/schema\/blocking-assets/, { status: 200, body: { items: [], total: 0 } });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" onOpenBatch={vi.fn()} />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    // The count without a destination is what this flow was refused for. The
    // sentence says where the remedy is, and the frames are right under it — in
    // the dialog, not in a section somewhere else on the page.
    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("open a batch below to clear or relabel a frame");
    expect(within(dialog).getByTestId("blocking-assets")).not.toBeNull();
    expect(screen.queryByText("Frames in the way")).toBeNull();
  });

  it("names no list of frames to a host that cannot open a batch, because none is shown", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    // The frames are listed only where a batch can be opened, so pointing at
    // them here would name a list that is not in the dialog — and asking the
    // server for frames nothing can link to would be a walk for nothing.
    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("Keep the class");
    expect(dialog.textContent).not.toContain("open a batch");
    expect(within(dialog).queryByTestId("blocking-assets")).toBeNull();
    expect(
      sent.some((request) => new URL(request.url).pathname.endsWith("/schema/blocking-assets")),
    ).toBe(false);
  });

  it("removes a clear candidate from the local draft without publishing, and closes its row", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    await waitFor(() => expect(classCards()).toHaveLength(1));
    // The open row was editing the class that is gone, so it goes with it.
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(screen.queryByTestId("class-1")).toBeNull();
    expect(screen.queryByTestId("orphan-dialog")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    expect(sent.some((request) => new URL(request.url).pathname.endsWith("/publish"))).toBe(false);
  });

  it("shows shared preview failure prose and leaves the draft unchanged", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 503,
      body: { code: "NETWORK_ERROR", message: "unreachable" },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    const error = await screen.findByTestId("schema-preview-error");
    expect(error.textContent).toContain("The server could not be reached");
    expect(error.textContent).not.toContain("unreachable");
    expect(screen.getByTestId("class-name-1")).toHaveProperty("value", "lane");
    expect(screen.queryByTestId("orphan-dialog")).toBeNull();
  });

  it("does not apply field edits while a removal preview is pending", async () => {
    withClasses(CLASSES);
    let resolvePreview: ((answer: Exclude<HandlerAnswer, undefined>) => void) | undefined;
    handlers.push((request) => {
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/schema/preview")
      ) {
        return undefined;
      }
      return new Promise((resolve) => {
        resolvePreview = resolve;
      });
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(0);
    await userEvent.click(screen.getByTestId("remove-class-0"));
    await waitFor(() => expect(screen.getByTestId("remove-class-0")).toHaveProperty("disabled", true));
    expect(screen.getByTestId("remove-class-0").textContent).toContain("Checking…");
    expect(screen.getByTestId("remove-class-0").getAttribute("aria-label")).toBe(
      "Checking class removal",
    );

    await userEvent.type(screen.getByTestId("class-name-0"), "-edited");
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "vehicle");

    if (resolvePreview === undefined) throw new Error("Expected the deferred preview request");
    resolvePreview({
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["vehicle"], is_destructive: true },
        blockers: [],
        is_refused: false,
      },
    });

    await waitFor(() => expect(classCards()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    // The class that was asked about is the one that went, and the edit typed
    // while it was being asked about went nowhere.
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit lane"]);
    await openCard(0);
    expect(screen.getByTestId("class-name-0")).toHaveProperty("value", "lane");
  });

  it("shows each class's annotation count on its row and in its open row", async () => {
    withClasses(MANY);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    // The row renders before the counts arrive — it has a class to show and does
    // not wait on a number to show it — so this waits for the count.
    await waitFor(() =>
      expect(screen.getByTestId("class-card-count-0").textContent).toContain(
        (4372).toLocaleString(undefined),
      ),
    );
    await openCard(0);
    expect(screen.getByTestId("class-count-0").textContent).toContain(
      `${(4372).toLocaleString(undefined)} labels on`,
    );
    await closeSheet();

    await openCard(1);
    expect(screen.getByTestId("class-count-1").textContent).toContain("Not used yet");
  });

  it("removes a class from its row menu, asking the server first, and keeps it in the table struck through with the way back", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: {
          changes: [{ kind: "destructive", label_class: "lane", attribute: null, detail: "class 'lane' removed" }],
          destructive_classes: ["lane"],
          is_destructive: true,
        },
        blockers: [],
        is_refused: false,
      },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-menu-1"));
    await userEvent.click(await screen.findByTestId("class-menu-remove"));

    await waitFor(() => expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit vehicle"]));
    // Asked about the draft without it, before anything left the draft.
    const asked = sent
      .filter((request) => request.url.endsWith("/schema/preview"))
      .map((request) => JSON.parse(bodies.get(request) ?? "") as unknown);
    expect(asked).toContainEqual({ classes: [CLASSES[0]] });
    // Still in the table where it stood, struck through: a removal is a change
    // that saving would publish, and it is seen as one. It opens nothing and
    // holds no key.
    const gone = screen.getByTestId("class-removed-lane");
    expect(gone.textContent).toContain("Removed");
    expect(within(gone).queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(within(gone).queryByLabelText(/^Hotkey/)).toBeNull();
    expect(barState()).toBe("up");

    // And kept again, where it was: the draft is the version in force once more.
    await userEvent.click(within(gone).getByRole("button", { name: "Restore lane" }));
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit vehicle", "Edit lane"]);
    expect(screen.queryByTestId("class-removed-lane")).toBeNull();
    expect(barState()).toBe("down");
    expect(sent.some((request) => new URL(request.url).pathname.endsWith("/publish"))).toBe(false);
  });

  it("refuses a row menu's Remove of a class frames carry in the dialog that says why, never with a greyed-out item", async () => {
    withClasses(CLASSES);
    on("POST", /\/schema\/preview$/, {
      status: 200,
      body: {
        diff: { changes: [], destructive_classes: ["lane"], is_destructive: true },
        blockers: [{ label_class: "lane", annotations: 12, assets: 3 }],
        is_refused: true,
      },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-menu-1"));
    const remove = await screen.findByTestId("class-menu-remove");
    expect(remove.getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(remove);

    const dialog = await screen.findByTestId("orphan-dialog");
    expect(dialog.textContent).toContain("“lane” can’t be removed yet");
    expect(dialog.textContent).toContain("lane: 12 annotations across 3 assets");
    expect(within(dialog).queryByTestId("allow-destructive")).toBeNull();
    await userEvent.click(within(dialog).getByTestId("orphan-close"));
    await waitFor(() => expect(screen.queryByTestId("orphan-dialog")).toBeNull());
    // Refused, so nothing left the draft.
    expect(classCards()).toHaveLength(2);
    expect(screen.queryByTestId("class-removed-lane")).toBeNull();
    expect(barState()).toBe("down");
  });

  it("undoes every edit to one class from its row menu", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("class-geometry-1-bbox"));
    await closeSheet();
    expect(barState()).toBe("up");

    await userEvent.click(screen.getByTestId("class-menu-1"));
    await userEvent.click(await screen.findByTestId("class-menu-revert"));

    expect(barState()).toBe("down");
    await openCard(1);
    expect(screen.getByTestId("class-geometry-1-bbox").getAttribute("aria-pressed")).toBe("false");
  });

  it("offers no Undo for a class the draft has not touched", async () => {
    withClasses(CLASSES);
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await userEvent.click(screen.getByTestId("class-menu-0"));
    await screen.findByTestId("class-menu-edit");
    expect(screen.queryByTestId("class-menu-revert")).toBeNull();
    // Edit opens the class, as its row does.
    await userEvent.click(screen.getByTestId("class-menu-edit"));
    expect(await screen.findByTestId("class-0")).not.toBeNull();
  });

  it("narrows the table to what the draft changed, or to the classes nothing is drawn with", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");
    await addNamedClass("zebra", 3);
    // `class-00` has 4,372 annotations; the rest none.
    await waitFor(() => expect(screen.getByTestId("class-card-count-0").textContent).toContain((4372).toLocaleString(undefined)));
    const lens = screen.getByTestId("classes-lens");

    await userEvent.click(within(lens).getByText("Changed in draft"));
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit zebra"]);
    expect(screen.getByTestId("classes-count").textContent).toBe("1 of 4");

    await userEvent.click(within(lens).getByText("Not used"));
    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual(["Edit class-01", "Edit class-02", "Edit zebra"]);

    await userEvent.click(within(lens).getByText("All"));
    expect(classCards()).toHaveLength(4);
    expect(screen.getByTestId("classes-count").textContent).toBe("4");
  });

  it("keeps the other classes, and no open row, after a class in the middle is removed", async () => {
    withClasses(MANY.slice(0, 3));
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));
    await waitFor(() => expect(classCards()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());

    expect(classCards().map((card) => card.getAttribute("aria-label"))).toEqual([
      "Edit class-00",
      "Edit class-02",
    ]);
  });

  /**
   * A draft the server holds with a class nobody has named yet — a colleague's
   * unfinished work. The dialog never writes one, but one can arrive, and it has
   * to be removable.
   */
  function withUnnamedClass(): void {
    withClasses(CLASSES);
    curatedDrafts.set(PROJECT, {
      project_id: PROJECT,
      kind: "curated",
      classes: [...CLASSES, { name: "", geometries: ["bbox"], color: null, attributes: [] }],
      note: "",
      based_on: 1,
      revision: 1,
      updated_at: "2024-01-01T00:00:00Z",
    });
  }

  it("removes a class that was never named without asking the server", async () => {
    withUnnamedClass();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");
    expect(screen.getByTestId("class-card-2").getAttribute("aria-label")).toBe("Edit New class");
    const before = sent.filter((request) => request.url.endsWith("/schema/preview")).length;

    await openCard(2);
    expect(screen.getByRole("heading", { name: "Edit new class" })).not.toBeNull();
    await userEvent.click(screen.getByTestId("remove-class-2"));

    await waitFor(() => expect(classCards()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId("class-sheet")).toBeNull());
    expect(sent.filter((request) => request.url.endsWith("/schema/preview"))).toHaveLength(before);
    expect(screen.queryByTestId("schema-preview-error")).toBeNull();
  });

  it("leaves an unnamed class out of the removal preview it cannot be part of", async () => {
    withUnnamedClass();
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
    await screen.findByTestId("class-list");

    await openCard(1);
    await userEvent.click(screen.getByTestId("remove-class-1"));

    await waitFor(() => expect(classCards()).toHaveLength(2));
    const previews = sent
      .filter((sentRequest) => sentRequest.url.endsWith("/schema/preview"))
      .map((sentRequest) => JSON.parse(bodies.get(sentRequest) ?? "") as { classes: { name: string }[] });
    // The removal's own question: the draft without `lane`, and without the
    // class nobody has named yet.
    expect(previews).toContainEqual({ classes: [CLASSES[0]] });
    // And no question the rail asks while the draft is dirty carries it either.
    for (const asked of previews) {
      expect(asked.classes.every((declared) => declared.name !== "")).toBe(true);
    }
    expect(screen.queryByTestId("schema-preview-error")).toBeNull();
  });
});

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
      handlers = [];
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
      handlers = [];
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

    handlers = [];
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

describe("version history", () => {
  /** The lines of the open History sheet, in the order it lists them. */
  function entries(history: HTMLElement): HTMLElement[] {
    return [...history.querySelectorAll<HTMLElement>("[data-testid]")].filter((element) => /^version-\d+$/.test(element.dataset.testid ?? ""));
  }

  it("renders every version, marks the active one, and offers no way to edit a past one", async () => {
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
    on("GET", /schema\/versions$/, {
      status: 200,
      body: {
        items: [
          { project_id: PROJECT, version: 1, classes: [CLASSES[0]] },
          { project_id: PROJECT, version: 2, classes: CLASSES },
        ],
        total: 2,
      },
    });

    on("GET", /schema\/compare/, {
      status: 200,
      body: {
        is_destructive: false,
        destructive_classes: [],
        changes: [{ kind: "additive", label_class: "lane", attribute: null, detail: "class 'lane' added" }],
      },
    });

    // Reached through the Classes section, which is where the history lives: it
    // is a view *of* the schema rather than a peer of it.
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    const history = await openHistory();
    // `findBy` on the entry: the sheet renders at once and holds the skeletons,
    // so a `getBy` here asserts against a loading state.
    await within(history).findByTestId("version-1");
    // A line says the version's message — these were published without one.
    expect(within(history).getByTestId("version-1").textContent).toContain("No message");

    // Active is *derived* — the highest version, never a stored flag.
    expect(within(history).getByTestId("version-2").textContent).toContain("Active");
    expect(within(history).getByTestId("version-1").textContent).not.toContain("Active");

    // Read-only is structural rather than disabled: an entry's controls only
    // *open* the version or copy it into the draft, and nothing in the history
    // can write to it. The active one has nothing to restore.
    const buttons = within(history).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "View version 2, active: no message",
      "View version 1: no message",
      "Restore version 1",
    ]);
    expect(within(history).queryAllByRole("textbox")).toHaveLength(0);
    await userEvent.click(buttons[1]);
    const past = await screen.findByTestId("past-version");
    // Version 1 declares one class: its row is the only thing to press, and it
    // only opens to read.
    expect(within(past).getAllByTestId(/^past-class-\d+$/).map((button) => button.getAttribute("data-testid"))).toEqual(["past-class-0"]);
    expect(editAffordances(past)).toEqual([]);
  });

  it("shows why and when, and an em dash for a version that recorded neither", async () => {
    // The two optional fields on the ledger. Both are null for a version published
    // before the migration, and nothing backfills either — so the row has to say
    // "not recorded" rather than go blank, which reads as a rendering bug.
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
    on("GET", /schema\/versions$/, {
      status: 200,
      body: {
        items: [
          { project_id: PROJECT, version: 1, classes: CLASSES, description: null, created_at: null },
          {
            project_id: PROJECT,
            version: 2,
            classes: CLASSES,
            description: "split vehicle into car and truck",
            created_at: "2026-07-15T09:00:00Z",
          },
        ],
        total: 2,
      },
    });

    // The editor is above the history in the same tab now, so its own query has
    // to be answered or the section never gets past loading.
    on("GET", /^\/projects\/[^/]+\/schema$/, {
      status: 200,
      body: { project_id: PROJECT, version: 2, classes: CLASSES },
    });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

    const history = await openHistory();
    await within(history).findByTestId("version-1");
    expect(within(history).getByTestId("version-2").textContent).toContain(
      "split vehicle into car and truck",
    );
    expect(within(history).getByTestId("version-1").textContent).toContain("—");
  });

  /**
   * Grouping the ledger by provenance.
   *
   * The rule itself is `schemaHistory.test.ts` — pure, and where the boundaries
   * are. This is the half that only exists on screen: that a run renders as one
   * collapsed row, that the milestones around it do not, and that expanding
   * gives back exactly the entries a flat list would have had.
   */
  describe("versions published while annotating", () => {
    /** Four versions: two curated milestones with a two-version run between them. */
    function withRun(): void {
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
        body: { project_id: PROJECT, version: 4, classes: CLASSES },
      });
      on("GET", /schema\/versions$/, {
        status: 200,
        body: {
          items: [
            { project_id: PROJECT, version: 1, classes: CLASSES, provenance: "curated" },
            {
              project_id: PROJECT,
              // Deliberately **fewer classes than v3**: with every version
              // declaring the same contract, a run summarising its oldest member
              // instead of its newest reads identically and the assertion below
              // cannot fail. The run's summary is what it *left behind*.
              version: 2,
              classes: [CLASSES[0]],
              provenance: "annotation",
              description: 'Added class "cone" from the annotation view',
            },
            {
              project_id: PROJECT,
              version: 3,
              classes: CLASSES,
              provenance: "annotation",
              description: 'Added class "barrier" from the annotation view',
            },
            {
              project_id: PROJECT,
              version: 4,
              classes: CLASSES,
              provenance: "curated",
              description: "split vehicle into car and truck",
            },
          ],
          total: 4,
        },
      });
    }

    it("draws the run on a lane of its own, and leaves the milestones on the main one", async () => {
      withRun();
      renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

      const history = await openHistory();
      await within(history).findByTestId("version-4");

      // Every version is a line of its own, newest first — a run is a detour on
      // the graph, not a disclosure that hides its members.
      expect(entries(history).map((entry) => entry.dataset.testid)).toEqual(["version-4", "version-3", "version-2", "version-1"]);
      expect(within(history).getByTestId("version-3").dataset.lane).toBe("1");
      expect(within(history).getByTestId("version-2").dataset.lane).toBe("1");
      expect(within(history).getByTestId("version-4").dataset.lane).toBe("0");
      expect(within(history).getByTestId("version-1").dataset.lane).toBe("0");
    });

    it("says which sitting a version came from when it is read", async () => {
      withRun();
      on("GET", /schema\/compare/, { status: 200, body: { is_destructive: false, destructive_classes: [], changes: [] } });
      renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
      await viewVersion(3);

      const head = await screen.findByTestId("past-version-panel");
      expect(head.textContent).toContain("Annotating session 1");
      expect(head.textContent).toContain('Added class "barrier" from the annotation view');
    });

    it("marks the version on screen in the history, inside its run", async () => {
      withRun();
      on("GET", /schema\/compare/, { status: 200, body: { is_destructive: false, destructive_classes: [], changes: [] } });
      renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);
      await viewVersion(3);
      await screen.findByTestId("past-version");

      const again = await openHistory();
      const entry = await within(again).findByTestId("version-3");
      expect(entry.getAttribute("aria-current")).toBe("true");
      expect(within(again).getByTestId("version-2").getAttribute("aria-current")).toBeNull();
    });

    it("reads a run's members like any other version", async () => {
      withRun();
      renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

      const history = await openHistory();
      await within(history).findByTestId("version-3");
      expect(within(history).getByTestId("version-3").textContent).toContain('Added class "barrier" from the annotation view');
      expect(within(history).getByTestId("version-2").textContent).toContain('Added class "cone" from the annotation view');
    });

    it("groups nothing in a history that recorded no provenance", async () => {
      // Every version published before WS1's migration answers null, and nothing
      // backfills them. "Nobody said" must not be read as "incidental" — so a
      // project untouched since then reads exactly as it did before this rule.
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
      on("GET", /schema\/versions$/, {
        status: 200,
        body: {
          items: [
            { project_id: PROJECT, version: 1, classes: CLASSES },
            { project_id: PROJECT, version: 2, classes: CLASSES },
          ],
          total: 2,
        },
      });
      renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" />);

      const history = await openHistory();
      await within(history).findByTestId("version-1");
      expect(within(history).getByTestId("version-2")).toBeTruthy();
      // And therefore no lane but the main one.
      expect(entries(history).map((entry) => entry.dataset.lane)).toEqual(["0", "0"]);
    });
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
      allowed_actions: batchActions(fields.state as BatchState),
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
    renderWithData(<ProjectScreen projectId={PROJECT} onIngest={vi.fn()} />);

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
      handlers = [];
      headerFor({ assets: 3 });
      on("GET", /\/assets$/, { status: 200, body: { items: [], total: 0 } });
      const { unmount } = renderWithData(<ProjectScreen projectId={PROJECT} tab={tab} onIngest={vi.fn()} />);

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
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={opened} />);

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
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={opened} />);

    const cta = await screen.findByTestId("go-annotate");
    expect(cta.getAttribute("aria-haspopup")).toBe("menu");
    // The pen and the chevron: the shape is what says a press opens a choice.
    expect(cta.querySelectorAll("svg")).toHaveLength(2);

    await userEvent.click(cta);

    // Pressing it navigated nowhere. This is the whole defect, stated once.
    expect(opened).not.toHaveBeenCalled();
    expect(await screen.findByTestId("annotate-batch-drive-03")).not.toBeNull();
    expect(screen.getByTestId("annotate-batch-drive-02")).not.toBeNull();
  });

  it("lists only the batches work can happen in, newest first, with their remaining count and pinned version", async () => {
    headerFor({ batches: OPEN_PAIR });
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);

    await userEvent.click(await screen.findByTestId("go-annotate"));
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
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={opened} />);

    await userEvent.click(await screen.findByTestId("go-annotate"));
    await userEvent.click(await screen.findByTestId("annotate-batch-drive-02"));

    expect(opened).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555");
  });

  it("does not render Annotate at all when no batch is open for annotation", async () => {
    // `DESIGN.md`'s never-disable rule: a control
    // that leads nowhere is absent, not grey.
    headerFor({ batchState: "draft" });
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} onIngest={vi.fn()} />);

    await screen.findByTestId("go-ingest");
    expect(screen.queryByTestId("go-annotate")).toBeNull();
  });

  describe("where Add images lives: a button on Overview and Images, the overflow elsewhere", () => {
    function inToolbar(): HTMLElement | null {
      return within(screen.getByTestId("project-nav")).queryByTestId("go-ingest");
    }

    it("draws it outlined before the filled Annotate while a batch is open", async () => {
      headerFor({ batchState: "in_annotation" });
      renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} onIngest={vi.fn()} />);

      const annotate = await screen.findByTestId("go-annotate");
      const ingest = screen.getByTestId("go-ingest");
      expect(ingest.dataset.variant).toBe("outline");
      expect(annotate.dataset.variant).toBe("default");
      // Add images leads: the DOM order is the visual order.
      expect(ingest.compareDocumentPosition(annotate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(ingest.parentElement).toBe(annotate.parentElement);
      expect(inToolbar()).toBe(ingest);
      expect(filled()).toEqual([annotate]);
    });

    it("draws it as the filled control when no batch is open", async () => {
      headerFor({ batchState: "draft" });
      renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} onIngest={vi.fn()} />);

      await screen.findByTestId("overview-batches");
      expect(screen.queryByTestId("go-annotate")).toBeNull();
      expect(screen.getAllByTestId("go-ingest")).toHaveLength(1);
      expect(inToolbar()).toBe(screen.getByTestId("go-ingest"));
      expect(filled()).toEqual([screen.getByTestId("go-ingest")]);
    });

    it("gives the Overview's content and its Batches panel no Add images: the bar has the only one", async () => {
      headerFor({ batchState: "in_annotation" });
      renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} onIngest={vi.fn()} />);

      const panel = await screen.findByTestId("overview-batches");
      // No section header exists to carry one, and nothing in the content does.
      expect(screen.queryByTestId("section-header")).toBeNull();
      expect(within(panel).queryByTestId("go-ingest")).toBeNull();
      expect(await screen.findAllByTestId("go-ingest")).toEqual([inToolbar()]);
    });

    it("keeps Add images in the toolbar for a host that cannot open a batch, even over an open one", async () => {
      // Annotate has nowhere to send anybody without `onOpenBatch`, so it never
      // takes the slot: Add images is the filled control.
      headerFor({ batchState: "in_annotation" });
      renderWithData(<ProjectScreen projectId={PROJECT} onIngest={vi.fn()} />);

      await screen.findByTestId("overview-batches");
      expect(screen.queryByTestId("go-annotate")).toBeNull();
      expect(screen.getAllByTestId("go-ingest")).toHaveLength(1);
      expect(inToolbar()).toBe(screen.getByTestId("go-ingest"));
    });

    it("draws no Add images at all for a host with nowhere to send anybody", async () => {
      headerFor({ batchState: "in_annotation" });
      renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);

      await screen.findByTestId("go-annotate");
      expect(screen.queryByTestId("go-ingest")).toBeNull();
    });

    it.each(["overview", "images"] as const)(
      "draws exactly one button, in the toolbar, on the %s section: the subject is images",
      async (tab) => {
        headerFor({ batchState: "in_annotation", assets: 3 });
        on("GET", /\/assets$/, { status: 200, body: { items: [], total: 0 } });
        renderWithData(<ProjectScreen projectId={PROJECT} tab={tab} onOpenBatch={vi.fn()} onIngest={vi.fn()} />);

        await screen.findByTestId(tab === "images" ? "images-screen" : "go-annotate");
        const ingest = await screen.findByTestId("go-ingest");
        expect(screen.getAllByTestId("go-ingest")).toEqual([inToolbar()]);
        // Not also a menu entry: one way to it per section.
        await userEvent.click(screen.getByTestId("project-menu"));
        await screen.findByTestId("rename-project");
        expect(screen.queryByTestId("menu-ingest")).toBeNull();
        // Annotate is the Overview's alone, so it is the one that sets the variant.
        expect(ingest.dataset.variant).toBe(tab === "overview" ? "outline" : "default");
        expect(screen.queryByTestId("go-annotate") !== null).toBe(tab === "overview");
      },
    );

    it.each([
      { tab: "schema", sentinel: "schema-editor" },
      { tab: "dataset", sentinel: "dataset-screen" },
    ] as const)(
      "draws no button on the $tab section, and offers Add images first in the overflow",
      async ({ tab, sentinel }) => {
        const added = vi.fn();
        headerFor({ batchState: "in_annotation", assets: 3 });
        renderWithData(<ProjectScreen projectId={PROJECT} tab={tab} onOpenBatch={vi.fn()} onIngest={added} />);

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
        expect(added).toHaveBeenCalledOnce();
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

  it("keeps the filled Ingest over an empty, schema-less project, with the other order as prose", async () => {
    // The invitation and the header say the same thing with the same handler, so
    // the loud one stays in the header; the classes order is a link beneath.
    headerFor({ schema: false, assets: 0 });
    renderWithData(
      <ProjectScreen projectId={PROJECT} onIngest={vi.fn()} onTabChange={vi.fn()} />,
    );

    await screen.findByTestId("first-run-alt");
    expect(filled()).toEqual([screen.getByTestId("go-ingest")]);
  });

  it("steps Ingest back while the Overview's invitation owns the filled button", async () => {
    headerFor({ schema: false, assets: 48 });
    renderWithData(
      <ProjectScreen projectId={PROJECT} onIngest={vi.fn()} onTabChange={vi.fn()} />,
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
    renderWithData(<ProjectScreen projectId={PROJECT} onIngest={vi.fn()} />);

    const alt = await screen.findByTestId("first-run-alt");
    expect(filled()).toEqual([screen.getByTestId("go-ingest")]);
    await userEvent.click(alt);
    await screen.findByTestId("schema-editor");
  });

  it("keeps the filled Ingest when the invitation is the ingest one", async () => {
    // The invitation and the header say the same thing with the same handler, so
    // the loud one stays in the header and the panel's stays outlined.
    headerFor({ assets: 0 });
    renderWithData(<ProjectScreen projectId={PROJECT} onIngest={vi.fn()} />);

    await screen.findByTestId("overview-ingest");
    expect(filled()).toEqual([screen.getByTestId("go-ingest")]);
  });

  it("keeps the filled Ingest once the project has both classes and images", async () => {
    headerFor({});
    renderWithData(<ProjectScreen projectId={PROJECT} onIngest={vi.fn()} />);

    await screen.findByTestId("overview-stats");
    expect(screen.queryByTestId("first-run")).toBeNull();
    expect(filled()).toEqual([screen.getByTestId("go-ingest")]);
    expect(screen.getByTestId("go-ingest").textContent).toBe("Add images");
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
      <ProjectScreen projectId={PROJECT} onIngest={vi.fn()} tab="dataset" />,
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
    renderWithData(<ProjectScreen projectId={PROJECT} onIngest={vi.fn()} tab="dataset" />);

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
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" onIngest={vi.fn()} />);

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
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" onIngest={vi.fn()} />);
    const add = await screen.findByTestId("add-class");
    expect(filled()).toEqual([add]);

    await addNamedClass("pedestrian");

    // One filled control at a time: the commit bar's Save, while it is up.
    await waitFor(() => expect(filled()).toEqual([screen.getByTestId("save-schema")]));
    expect(screen.getByTestId("add-class").dataset.variant).toBe("outline");
  });

  it("keeps Add class in the section for an empty draft, and draws none in the bar", async () => {
    headerFor({ schema: false });
    renderWithData(<ProjectScreen projectId={PROJECT} tab="schema" onIngest={vi.fn()} />);

    const add = await screen.findByTestId("add-class");
    expect(within(screen.getByTestId("project-nav")).queryByTestId("add-class")).toBeNull();
    expect(screen.getAllByTestId("add-class")).toEqual([add]);
  });

  it("moves Rename into the overflow, so only two buttons show", async () => {
    headerFor({ batchState: "in_annotation" });
    renderWithData(<ProjectScreen projectId={PROJECT} onOpenBatch={vi.fn()} onIngest={vi.fn()} />);

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
