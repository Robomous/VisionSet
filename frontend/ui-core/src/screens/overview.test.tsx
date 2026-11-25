/**
 * The Overview panel, and the heuristic under it.
 *
 * Two halves, tested differently on purpose. `imbalanceNote` is a pure function
 * and is exercised at its boundaries directly — it is a stated placeholder, so
 * the thing worth pinning is exactly where it fires and where it stays quiet.
 * The panel is tested for its four states, the fourth being the one that would
 * be got wrong: assets but no annotations is *not* empty. Around them: the four
 * cards as doors and their one pointer each, the batches table and its panel,
 * and the work row. The class panel is tested on its own, in
 * `patterns/project/classRail.test.tsx`.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Toaster } from "sonner";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMBALANCE_MIN_CLASSES, IMBALANCE_SHARE, imbalanceNote } from "./imbalance";
import { firstRunInvitation } from "./firstRunInvitation";
import { OverviewPanel } from "./OverviewPanel";
import { clearPrefs, readPref } from "../data/prefs";
import { batchRows, classRows } from "./overviewRows";
import type { Batch, BatchJobsRead, Job, LabelClassBody } from "./queries";
import { KPI_CARD_HEIGHT, KPI_GRID } from "../patterns/project/KpiCards";
import { harnessQueryClient, renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { batchActions, datasetOf, releaseOf } from "../testing/wire.fixtures.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
/** Every request the panel made, so "the Overview mutates nothing" is a count rather than a hope. */
const sent: Request[] = [];

beforeEach(() => {
  // The tooltips and popovers here measure themselves through it; jsdom has none.
  stubResizeObserver();
  handlers = [];
  sent.length = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    sent.push(request);
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) {
        return Promise.resolve(
          new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
            status: answer.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }
    /*
     * The three reads `useProjectReadiness` needs, answered emptily when no test
     * said otherwise.
     *
     * A fallback rather than a handler, so an explicit `on(...)` always wins
     * whatever order it was registered in — handlers are consulted first, and
     * this is what is left. Registering these as handlers instead made the order
     * of `serve()` against a test's own `on()` load-bearing, which is a rule
     * nobody can see at the call site.
     *
     * The 500 stays for everything else: a request nobody stubbed is a fixture
     * that forgot something, and answering it politely is how a test comes to
     * assert against a screen the server could never produce.
     */
    const path = new URL(request.url).pathname;
    if (path.endsWith("/batches")) return json({ items: [], total: 0 });
    if (path.endsWith("/releases")) return json({ items: [], total: 0 });
    if (path.endsWith("/sources")) return json({ items: [], total: 0 });
    if (path.endsWith("/dataset")) {
      return json(datasetOf(PROJECT, "22222222-2222-4222-8222-222222222222"));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ code: "NO_STUB", message: request.url }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
  });
});

/** A 200 with a JSON body — the fallback's only shape. */
function json(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  // "Not now" on the auto-label line is remembered per project; no test inherits it.
  clearPrefs();
});

function on(method: string, pattern: RegExp, answer: Answer): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname)
      ? { status: answer.status, body: answer.body ?? null }
      : undefined,
  );
}

/**
 * Answers ahead of everything `readinessOf` and `serveTrunk` registered, so a
 * test can say what *this* trunk or *these* releases are without caring in which
 * order the shared fixtures went in.
 */
function first(method: string, pattern: RegExp, answer: Answer): void {
  handlers.unshift((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname)
      ? { status: answer.status, body: answer.body ?? null }
      : undefined,
  );
}

function statsOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: PROJECT,
    asset_count: 1248,
    annotated_asset_count: 774,
    annotation_count: 6431,
    class_count: 3,
    annotated_pct: 62.0,
    classes: [
      { label_class: "dog", annotations: 4372, assets: 900 },
      { label_class: "person", annotations: 1544, assets: 400 },
      { label_class: "bicycle", annotations: 515, assets: 100 },
    ],
    ...over,
  };
}

const DATASET = "22222222-2222-4222-8222-222222222222";

function trunkStatsOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { dataset_id: DATASET, asset_count: 0, annotated_asset_count: 0, annotation_count: 0, classes: [], ...over };
}

/**
 * The two-hop the pipeline row reads: project -> dataset -> releases.
 *
 * Installed for every fixture rather than per test. `useProjectReadiness` does not
 * wait on it, but the dashboard's trunk and release cards still ask, and an unstubbed pair
 * falls through to the 500 the harness answers with.
 */
function serveTrunk(releases: readonly string[] = []): void {
  on("GET", /\/projects\/[^/]+\/dataset$/, { status: 200, body: datasetOf(PROJECT, DATASET) });
  // Registered before any project `/stats` handler, so the trunk's own counts win
  // for the trunk's path. An empty trunk opens the image window on what was imported.
  on("GET", /\/datasets\/[^/]+\/stats$/, { status: 200, body: trunkStatsOf() });
  on("GET", /\/releases$/, {
    status: 200,
    body: { items: releases.map((tag) => releaseOf(DATASET, tag)), total: releases.length },
  });
}

function serve(stats: Record<string, unknown>, assets: unknown = { items: [], total: 0 }): void {
  serveTrunk();
  on("GET", /\/stats$/, { status: 200, body: stats });
  on("GET", /\/assets$/, { status: 200, body: assets });
}

/**
 * A host that holds the open batch, the way the route's `?batch=` does.
 *
 * `openBatchId` with `onOpenBatchChange` makes the panel controlled: it shows
 * exactly what the host says. A bare `vi.fn()` setter would therefore leave the
 * panel closed for good, so a test that clicks a row and then reads the panel
 * needs a host that actually remembers. `onChange` is the spy.
 */
function Held({ initial = null, onChange }: { readonly initial?: string | null; readonly onChange?: (id: string | null) => void }) {
  const [id, setId] = useState<string | null>(initial);
  return (
    <OverviewPanel
      projectId={PROJECT}
      openBatchId={id}
      onOpenBatchChange={(next) => {
        onChange?.(next);
        setId(next);
      }}
    />
  );
}

// --- the heuristic ------------------------------------------------------------

describe("imbalanceNote", () => {
  const share = (name: string, annotations: number) => ({ label_class: name, annotations });

  it("names the smallest class and its share", () => {
    const note = imbalanceNote([share("dog", 4372), share("person", 1544), share("bicycle", 515)]);
    expect(note).toContain("bicycle");
    expect(note).toContain("8%");
  });

  it("stays quiet below three classes, however lopsided", () => {
    // A 99/1 split across two classes is often exactly what somebody built — a
    // defect detector is mostly not-a-defect.
    expect(imbalanceNote([share("defect", 1), share("clean", 999)])).toBeNull();
    expect(IMBALANCE_MIN_CLASSES).toBe(3);
  });

  it("fires at exactly three classes, which is the boundary it claims", () => {
    expect(imbalanceNote([share("a", 100), share("b", 100), share("c", 1)])).not.toBeNull();
  });

  it("stays quiet at exactly the threshold, and fires just under it", () => {
    // A class holding a round tenth is not being starved; a rule that fires on
    // equality fires on the case somebody deliberately aimed at.
    const atThreshold = [share("a", 45), share("b", 45), share("c", 10)];
    expect(10 / 100).toBe(IMBALANCE_SHARE);
    expect(imbalanceNote(atThreshold)).toBeNull();

    expect(imbalanceNote([share("a", 45), share("b", 46), share("c", 9)])).not.toBeNull();
  });

  it("stays quiet when nobody has annotated anything", () => {
    expect(imbalanceNote([share("a", 0), share("b", 0), share("c", 0)])).toBeNull();
  });

  it("never rounds a class at a fraction of a percent up to one", () => {
    const note = imbalanceNote([share("a", 5000), share("b", 5000), share("c", 4)]);
    expect(note).toContain("0%");
  });

  it("is silent on an empty distribution rather than throwing", () => {
    expect(imbalanceNote([])).toBeNull();
  });
});

// --- the panel ----------------------------------------------------------------

describe("the Overview panel", () => {
  it("reserves the final layout while loading, so nothing shifts", async () => {
    readinessOf({ stats: statsOf(), batches: [batchOf({ id: "a", name: "drive-01", state: "draft" })] });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const loading = screen.getByTestId("overview-loading");
    // Four cells in the cards' own grid, then the work row: the shape the data
    // arrives into. Three bars to a cell, then the batch band and five rows of
    // three bars each; the rail is a blank cell until the images arrive.
    expect(loading.querySelectorAll(".animate-pulse")).toHaveLength(4 * 3 + 1 + 5 * 3);
    const strip = [...loading.children].find((child) => !child.classList.contains("sr-only"));
    expect(strip?.className).toBe(KPI_GRID);
    expect(strip?.children).toHaveLength(4);
    for (const card of strip?.children ?? []) expect(card.classList.contains(KPI_CARD_HEIGHT)).toBe(true);
    const rowsWhileLoading = rowsOf(loading);
    expect(rowsWhileLoading.map((row) => row.cells)).toEqual([4, 2]);
    expect(rowsWhileLoading.map((row) => row.split)).toEqual(["lg:grid-cols-4", "xl:grid-cols-4"]);
    // The batches cell already spans three of the work row's four columns.
    const work = loading.children[2];
    expect(work?.children[0]?.classList.contains("xl:col-span-3")).toBe(true);

    const panel = await screen.findByTestId("overview-panel");
    await screen.findByTestId("overview-batches");
    // Four grey cells while loading and four cards once the numbers arrive; the
    // work row keeps both its cells (batches, rail) and the same four-column split.
    expect(rowsOf(panel)).toEqual(rowsWhileLoading);
    expect(screen.getByTestId("overview-stats").children).toHaveLength(4);
  });

  it("says a missing project in words, not as an identifier", async () => {
    on("GET", /\/stats$/, {
      status: 404,
      body: {
        code: "PROJECT_NOT_FOUND",
        message: `project ${PROJECT} not found in workspace /tmp/ws`,
      },
    });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That project is no longer on record.");
    expect(alert.textContent).not.toContain(PROJECT);
    expect(alert.textContent).not.toContain("workspace");
  });

  it("shows the project's counts, formatted", async () => {
    readinessOf({ stats: statsOf() });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-stats");
    expect(screen.getByTestId("kpi-images").textContent).toContain((1248).toLocaleString(undefined));
    // The last card counts classes and draws them: the count beside its label,
    // then the chart, whose readout says the largest class's figures. The
    // schema version, the "no schema yet" line and the annotation total that
    // this cell used to say are no longer on the Overview — the chart replaced
    // them — so a project without a schema reads the same chart.
    const classes = screen.getByTestId("kpi-annotations");
    expect(classes.getAttribute("aria-label")).toBe("Classes");
    expect(classes.querySelector("h3")?.textContent).toMatch(new RegExp(`^Classes${(3).toLocaleString(undefined)}`));
    const readout = within(classes).getByTestId("class-readout");
    expect(readout.textContent).toContain("68%");
    expect(readout.textContent).toContain("dog");
    expect(readout.textContent).toContain(`${(4372).toLocaleString(undefined)} on ${(900).toLocaleString(undefined)} assets`);
    expect(classes.textContent).not.toContain("schema");
  });

  it("draws the classes chart without a schema, rather than asking for one", async () => {
    readinessOf({ schema: false, stats: statsOf({ asset_count: 48 }) });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-stats");
    const classes = screen.getByTestId("kpi-annotations");
    expect(within(classes).getByRole("img")).not.toBeNull();
    expect(classes.textContent).not.toContain("no schema yet");
  });

  it("ranks the chart's shares by count, largest first", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-stats");
    const chart = within(screen.getByTestId("kpi-annotations")).getByRole("img");
    expect(chart.getAttribute("aria-label")).toBe("dog 68%, person 24%, bicycle 8%");
  });

  it("warns that classes are thin, and says the imbalance note, when the distribution earns one", async () => {
    const stats = statsOf();
    serve(stats);
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-stats");
    const warning = within(screen.getByTestId("kpi-annotations")).getByTestId("classes-thin");
    expect(warning.getAttribute("aria-label")).toBe("Warning: 1 thin class");
    // The note is the button's description (a hidden element it points at), not a sentence in the cell.
    const described = warning.getAttribute("aria-describedby");
    expect(described).not.toBeNull();
    const note = document.getElementById(described ?? "");
    expect(note?.hidden).toBe(true);
    expect(note?.textContent).toBe(
      imbalanceNote(
        (stats.classes as { label_class: string; annotations: number }[]).map(({ label_class, annotations }) => ({
          label_class,
          annotations,
        })),
      ),
    );
  });

  it("shows no imbalance note when the distribution is even", async () => {
    serve(
      statsOf({
        classes: [
          { label_class: "dog", annotations: 100, assets: 10 },
          { label_class: "person", annotations: 100, assets: 10 },
          { label_class: "bicycle", annotations: 100, assets: 10 },
        ],
      }),
    );
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-stats");
    expect(within(screen.getByTestId("kpi-annotations")).getByRole("img")).not.toBeNull();
    expect(screen.queryByTestId("classes-thin")).toBeNull();
    expect(screen.queryByTestId("imbalance-note")).toBeNull();
  });

  it("invites the first images when the project holds nothing", async () => {
    serve(statsOf({ asset_count: 0, annotated_asset_count: 0, annotation_count: 0, classes: [] }));
    const ingest = vi.fn();
    renderWithData(<OverviewPanel projectId={PROJECT} onIngest={ingest} />);

    const empty = await screen.findByTestId("overview-empty");
    // An invitation, not an apology.
    expect(empty.textContent).toContain("No images yet");
    expect(screen.getByTestId("overview-ingest").textContent).toBe("Add images");
    expect(empty.textContent).not.toContain("Nothing here yet");
    expect(empty.textContent).not.toContain("Ingest");
    await userEvent.click(screen.getByTestId("overview-ingest"));
    expect(ingest).toHaveBeenCalledOnce();
  });

  it("treats assets-with-no-annotations as populated, not as empty", async () => {
    // The state that would be got wrong. There *is* data and a real 0%; telling
    // this user to ingest again answers a question they did not ask.
    serve(
      statsOf({
        asset_count: 40,
        annotated_asset_count: 0,
        annotation_count: 0,
        annotated_pct: 0,
        classes: [],
      }),
    );
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-stats");
    expect(screen.queryByTestId("overview-empty")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("kpi-annotated").textContent).toContain("0 of 40 assets"));
    expect(screen.getByTestId("kpi-annotated").textContent).toContain("0%");
    // The classes chart says so in words, rather than drawing an empty bar.
    const classes = screen.getByTestId("kpi-annotations");
    expect(classes.textContent).toContain("No annotations yet.");
    expect(within(classes).queryByRole("img")).toBeNull();
    expect(within(classes).queryByTestId("class-readout")).toBeNull();
  });

  describe("the cards", () => {
    const kpi = (id: string): HTMLElement => screen.getByTestId(`kpi-${id}`);

    it("reads Labeled from the batches' progress, and leaves a draft's images out of it", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 100, annotated_asset_count: 90, annotated_pct: 90 }),
        batches: [
          batchOf({
            id: "open",
            state: "in_annotation",
            asset_count: 30,
            progress: progressOf({ total: 30, unannotated: 10, pre_labeled: 5, annotated: 15 }),
          }),
          batchOf({
            id: "done",
            state: "completed",
            asset_count: 20,
            progress: progressOf({ total: 20, accepted: 20 }),
          }),
          // A draft's counts are not offered to anybody yet: in neither number.
          batchOf({ id: "draft", state: "draft", asset_count: 10, progress: progressOf({ total: 10, annotated: 10 }) }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      // 15 + 20 labeled out of 100 images: the stats document's own 90% is not used.
      await waitFor(() => expect(kpi("annotated").textContent).toContain("15 left in 1 open batch"));
      const value = within(kpi("annotated")).getByText("35");
      // The percent sign is its own, quieter element.
      expect(value.nextElementSibling?.textContent).toBe("%");
      expect(kpi("annotated").textContent).not.toContain("90");
    });

    it("makes Labeled and what is left add up over the batches that have jobs", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 60 }),
        batches: [
          batchOf({
            id: "a",
            state: "in_annotation",
            progress: progressOf({ total: 30, unannotated: 10, pre_labeled: 5, annotated: 15 }),
          }),
          batchOf({ id: "b", state: "approved", progress: progressOf({ total: 20, unannotated: 20 }) }),
          batchOf({ id: "d", state: "draft", progress: progressOf({ total: 10, unannotated: 10 }) }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await waitFor(() => expect(kpi("annotated").textContent).toContain("35 left in 2 open batches"));
      // 15 of 60 images is a quarter.
      expect(within(kpi("annotated")).getByText("25").nextElementSibling?.textContent).toBe("%");
      // 15 labeled + 35 left are the 50 images outside the draft's 10.
      const labeled = (Number(within(kpi("annotated")).getByText("25").textContent) / 100) * 60;
      const left = Number(/(\d+) left/.exec(kpi("annotated").textContent ?? "")?.[1]);
      expect(labeled + left).toBe(60 - 10);
    });

    it("counts an image awaiting review as labeled, never as left too", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 30 }),
        batches: [
          batchOf({
            id: "a",
            state: "in_annotation",
            progress: progressOf({ total: 30, unannotated: 10, pre_labeled: 5, review_pending: 6, annotated: 9 }),
          }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      // 10 unlabeled + 5 drafts are left; the 6 awaiting review are among the 15 labeled, half of 30.
      await waitFor(() => expect(kpi("annotated").textContent).toContain("15 left in 1 open batch"));
      expect(within(kpi("annotated")).getByText("50")).not.toBeNull();
    });

    it("caps Labeled at the project's image count", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 10 }),
        batches: [batchOf({ id: "a", state: "completed", progress: progressOf({ total: 25, accepted: 25 }) })],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      // Nothing left, so the context says how much was labeled instead.
      await waitFor(() => expect(kpi("annotated").textContent).toContain("10 of 10 assets"));
      expect(within(kpi("annotated")).getByText("100")).not.toBeNull();
    });

    it("shows Labeled as a dash until the batches have loaded", async () => {
      readinessOf({ stats: statsOf(), batches: [] });
      first("GET", /\/batches$/, { status: 500, body: { code: "BOOM", message: "no batches" } });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await screen.findByTestId("overview-stats");
      expect(kpi("annotated").textContent).toBe("Labeled—");
    });

    it("reads the dataset's count and says how much of it a release holds", async () => {
      const cases = [
        { name: "nothing promoted", trunk: 0, releases: [], says: "Nothing added yet" },
        { name: "no release yet", trunk: 50, releases: [], says: "No releases yet" },
        { name: "images since the newest release", trunk: 42, releases: [["v1", 20], ["v2", 30]], says: "12 since v2" },
        { name: "all in the newest release", trunk: 30, releases: [["v1", 20], ["v2", 30]], says: "all in v2" },
      ] as const;

      for (const one of cases) {
        handlers = [];
        readinessOf({ stats: statsOf({ asset_count: 200 }), batches: [] });
        first("GET", /\/datasets\/[^/]+\/stats$/, { status: 200, body: trunkStatsOf({ asset_count: one.trunk }) });
        releasesOf(one.releases);
        const { unmount } = renderWithData(<OverviewPanel projectId={PROJECT} />);

        // The list answers oldest first, so "newest" is the last entry: reading the
        // first named the oldest release as the latest.
        await waitFor(() => expect(kpi("dataset").textContent, one.name).toContain(one.says));
        expect(within(kpi("dataset")).getByText(String(one.trunk)), one.name).not.toBeNull();
        unmount();
      }
    });

    it("shows a dash in the dataset card until its count arrives", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [] });
      first("GET", /\/datasets\/[^/]+\/stats$/, { status: 500, body: { code: "BOOM", message: "no count" } });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await screen.findByTestId("overview-stats");
      expect(kpi("dataset").textContent).toContain("—");
      // Another source has answered, so its neighbour shows a real value.
      expect(kpi("images").textContent).toContain("48");
    });
  });

  it("surfaces a failure to count with a way to retry", async () => {
    serveTrunk();
    on("GET", /\/stats$/, { status: 500, body: { code: "BOOM", message: "counting failed" } });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    expect((await screen.findByRole("alert")).textContent).toContain("counting failed");
  });
});

// --- the first-run invitation -------------------------------------------------

describe("firstRunInvitation", () => {
  // The whole state table, swept — four combinations and four answers, so the
  // rule is checked rather than described. `null` is the fourth answer and it is
  // the one the page depends on most: a project with both halves is a dashboard,
  // and an invitation over it would be onboarding somebody who is already here.
  it("answers exactly one invitation per state, and none once both halves exist", () => {
    expect(firstRunInvitation({ hasSchema: false, hasAssets: false })).toBe("ingest-first");
    expect(firstRunInvitation({ hasSchema: true, hasAssets: false })).toBe("ingest");
    expect(firstRunInvitation({ hasSchema: false, hasAssets: true })).toBe("classes-after-ingest");
    expect(firstRunInvitation({ hasSchema: true, hasAssets: true })).toBeNull();
  });
});

/** Every source the panel and its readiness hook read, in one call. */
function readinessOf(options: {
  schema?: boolean;
  stats: Record<string, unknown>;
  batches?: readonly Record<string, unknown>[];
  releases?: readonly string[];
  /** What `/batches/{id}/jobs` answers for whichever batch is asked. */
  jobs?: readonly Record<string, unknown>[];
  /** What `/jobs/{id}/progress` answers for whichever job is asked. */
  progress?: Record<string, number>;
}): void {
  on(
    "GET",
    /^\/projects\/[^/]+\/schema$/,
    options.schema === false
      ? { status: 404, body: { code: "SCHEMA_NOT_FOUND", message: "none yet" } }
      : { status: 200, body: { project_id: PROJECT, version: 1, classes: [] } },
  );
  serveTrunk(options.releases ?? []);
  on("GET", /\/stats$/, { status: 200, body: options.stats });
  on("GET", /\/batches$/, {
    status: 200,
    body: { items: options.batches ?? [], total: options.batches?.length ?? 0 },
  });
  on("GET", /\/batches\/[^/]+\/jobs$/, {
    status: 200,
    body: { items: options.jobs ?? [], total: options.jobs?.length ?? 0 },
  });
  on("GET", /\/jobs\/[^/]+\/progress$/, { status: 200, body: options.progress ?? progressOf() });
  // The rail's image preview: `GET /projects/{id}/assets?limit=24`.
  on("GET", /\/projects\/[^/]+\/assets$/, { status: 200, body: { items: [], total: options.stats["asset_count"] ?? 0 } });
  // The pre-label dialog reads the connections when a batch's own opens it.
  on("GET", /\/inference\/connections$/, { status: 200, body: { items: [], total: 0 } });
}

/**
 * The releases the dataset holds, oldest first as the wire lists them, each with
 * the images it froze. Answers ahead of the empty list `serveTrunk` registered.
 */
function releasesOf(entries: readonly (readonly [tag: string, images: number])[]): void {
  first("GET", /\/releases$/, {
    status: 200,
    body: {
      items: entries.map(([tag, images]) => releaseOf(DATASET, tag, { id: `release-${tag}`, asset_count: images })),
      total: entries.length,
    },
  });
}

/**
 * How many filled buttons the rendered tree carries.
 *
 * `bg-primary` is the one utility the `primary` variant owns (`buttonVariants`),
 * so counting it is counting filled buttons — and principle 8's whole claim is a
 * count. A test that only asserted "the CTA is there" would pass just as
 * happily with two of them, which is the defect worth catching.
 */
function filledButtons(): readonly HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("button.bg-primary")];
}

describe("the first-run invitation", () => {
  const empty = statsOf({
    asset_count: 0,
    annotated_asset_count: 0,
    annotation_count: 0,
    annotated_pct: 0,
    classes: [],
  });

  it("invites a schema-less, empty project to ingest, and nothing else", async () => {
    readinessOf({ schema: false, stats: empty });
    const ingest = vi.fn();
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} onIngest={ingest} />);

    const region = await screen.findByTestId("first-run");
    expect(region.dataset.invitation).toBe("ingest-first");
    expect(region.textContent).toContain("Add your first images");
    // One filled button: the invitation's Add images, the page's only one — an
    // empty Overview has no batches band and the bar draws none here — and the
    // classes CTA is gone: three voices became one.
    expect(filledButtons()).toEqual([screen.getByTestId("overview-ingest")]);
    expect(screen.queryByTestId("first-run-cta")).toBeNull();

    await userEvent.click(screen.getByTestId("overview-ingest"));
    expect(ingest).toHaveBeenCalledOnce();
  });

  it("names the other order as prose with a link, never as a second filled button", async () => {
    // It guides, it never gates. Both orders are legitimate, so the page says so
    // — and says it without splitting its own hierarchy.
    readinessOf({ schema: false, stats: empty });
    const schema = vi.fn();
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenSchema={schema} onIngest={vi.fn()} />);

    const alt = await screen.findByTestId("first-run-alt");
    expect(alt.className).not.toContain("bg-primary");
    expect(screen.getByTestId("first-run").textContent).toContain("both orders work");
    expect(filledButtons()).toEqual([screen.getByTestId("overview-ingest")]);

    await userEvent.click(alt);
    expect(schema).toHaveBeenCalledOnce();
  });

  it("invites an ingest once classes exist and nothing is ingested", async () => {
    readinessOf({ stats: empty });
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} onIngest={vi.fn()} />);

    const region = await screen.findByTestId("first-run");
    expect(region.dataset.invitation).toBe("ingest");
    expect(screen.getByTestId("overview-ingest")).not.toBeNull();
    // Classes exist, so there is no other order left to name.
    expect(screen.queryByTestId("first-run-alt")).toBeNull();
    // The invitation's Add images is the page's one filled button.
    expect(filledButtons()).toEqual([screen.getByTestId("overview-ingest")]);
    expect(screen.queryByTestId("first-run-cta")).toBeNull();
  });

  it("invites classes over a project that ingested first, and says where annotation opens", async () => {
    readinessOf({ schema: false, stats: statsOf({ asset_count: 48 }) });
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} onIngest={vi.fn()} />);

    const region = await screen.findByTestId("first-run");
    expect(region.dataset.invitation).toBe("classes-after-ingest");
    // The state the counts are real for: the invitation sits above the dashboard
    // rather than replacing it, because there *is* something to describe.
    expect(screen.getByTestId("overview-stats")).not.toBeNull();
    expect(screen.queryByTestId("overview-empty")).toBeNull();
    expect(region.textContent).toContain("48 assets are in");
    // The gate is stated, not re-derived — approval is what pins a version.
    expect(region.textContent).toContain("first approved batch");
    expect(filledButtons()).toEqual([screen.getByTestId("first-run-cta")]);
  });

  it("says one image rather than 1 images", async () => {
    readinessOf({ schema: false, stats: statsOf({ asset_count: 1 }) });
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} />);

    expect((await screen.findByTestId("first-run")).textContent).toContain("1 asset is in");
  });

  it("invites nothing once the project has both classes and images", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} onIngest={vi.fn()} />);

    // The dashboard is there, so this is not "nothing rendered".
    await screen.findByTestId("overview-stats");
    expect(screen.queryByTestId("first-run")).toBeNull();
    expect(filledButtons()).toHaveLength(0);
  });

  it("is retired outright: no checklist, no dismissal, on any state", async () => {
    // There is no four-station onboarding strip and no per-project dismissal.
    // Asserted on the state that would render step one, which is
    // where a survivor would show up first.
    readinessOf({ schema: false, stats: empty });
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} />);

    await screen.findByTestId("first-run");
    expect(screen.queryByTestId("journey")).toBeNull();
    expect(screen.queryByTestId("journey-checklist")).toBeNull();
    expect(screen.queryByTestId("journey-dismiss")).toBeNull();
    expect(document.body.textContent).not.toContain("Export your dataset");
  });

  it("falls back to the ingest invitation when readiness has no answer", async () => {
    // Only stats and assets are stubbed, so the schema query fails for a real
    // (non-404) reason and readiness stays `null`. "Nothing ingested yet" is
    // true whatever the schema turns out to be; a classes invitation would be a
    // guess about the one fact the page could not obtain.
    serve(empty);
    renderWithData(<OverviewPanel projectId={PROJECT} onIngest={vi.fn()} />);

    const region = await screen.findByTestId("first-run");
    expect(region.dataset.invitation).toBe("ingest");
  });

  it("guesses nothing over a project that has images and no readable schema", async () => {
    // The other half of the same rule. With assets present there is no
    // invitation that is true without the schema fact, so the page renders its
    // dashboard and stays quiet.
    serve(statsOf({ asset_count: 48 }));
    renderWithData(<OverviewPanel projectId={PROJECT} onIngest={vi.fn()} />);

    await screen.findByTestId("overview-stats");
    expect(screen.queryByTestId("first-run")).toBeNull();
  });
});

/**
 * The cards — Overview as pointers rather than as a second copy of every
 * section. A number is a door into the section that owns it, and a card carries
 * at most one pointer, labelled from what the wire declares.
 */
describe("the cards as doors", () => {
  const doorOf = (id: string): HTMLElement | null => screen.getByTestId(`kpi-${id}`).querySelector<HTMLElement>("[data-door]");

  it("points each door at the section that owns it, named by what it counts", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    const go = { images: vi.fn(), schema: vi.fn(), dataset: vi.fn() };
    renderWithData(
      <OverviewPanel
        projectId={PROJECT}
        onOpenImages={go.images}
        onOpenSchema={go.schema}
        onBrowseDataset={go.dataset}
      />,
    );

    await screen.findByTestId("overview-stats");
    // The accessible name says what the number is and where the door leads.
    await userEvent.click(screen.getByRole("button", { name: "Assets, 48. Open Images" }));
    await userEvent.click(screen.getByRole("button", { name: "Classes, 3. Open Classes" }));
    await userEvent.click(await screen.findByRole("button", { name: /^In dataset, 0\. Open the Dataset$/ }));

    expect(go.images).toHaveBeenCalledOnce();
    expect(go.schema).toHaveBeenCalledOnce();
    expect(go.dataset).toHaveBeenCalledOnce();
  });

  it("is a real button where a card has somewhere to go, so a keyboard can reach it", async () => {
    // A card with somewhere to go is an action, and an action a mouse alone can
    // take is half a control.
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenImages={vi.fn()} onBrowseDataset={vi.fn()} />);

    await screen.findByTestId("overview-stats");
    expect(doorOf("images")?.tagName).toBe("BUTTON");
    expect(doorOf("dataset")?.tagName).toBe("BUTTON");
    // The host did not name the Classes section, so that card is a plain
    // statistic rather than a disabled button: it is not a refused action.
    expect(doorOf("annotations")).toBeNull();
    // Labeled never has a door, whatever the host wires: the batches that
    // answer it are the panel right below.
    expect(doorOf("annotated")).toBeNull();
  });

  it("draws no door at all where the host has nowhere to send anybody", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const strip = await screen.findByTestId("overview-stats");
    expect(strip.querySelector("[data-door]")).toBeNull();
    // The one button left is the Classes cell's thin warning, its own target and no door.
    expect(within(strip).getAllByRole("button").map((button) => button.getAttribute("data-testid"))).toEqual(["classes-thin"]);
  });

  it("labels its four cards by what they count", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const strip = await screen.findByTestId("overview-stats");
    // By the cell's own name: the Classes heading also carries its count.
    expect([...strip.children].map((cell) => cell.getAttribute("aria-label"))).toEqual(["Assets", "Labeled", "In dataset", "Classes"]);
    expect([...strip.children].map((cell) => cell.getAttribute("data-testid"))).toEqual([
      "kpi-images",
      "kpi-annotated",
      "kpi-dataset",
      "kpi-annotations",
    ]);
    // Classes is the last, rightmost cell of the row.
    expect(strip.lastElementChild).toBe(screen.getByTestId("kpi-annotations"));
  });

  it("says a section is empty in words rather than showing a zero", async () => {
    // A documented "no answer" rendered as data reads as a broken screen.
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [] });

    renderWithData(<OverviewPanel projectId={PROJECT} />);

    // `findByText`, not `findByTestId` then read: the card renders immediately
    // with an em dash while its query is in flight.
    await screen.findByText("Nothing added yet");
    expect(screen.getByTestId("kpi-annotated").textContent).toContain("0 of 48 assets");
    expect((await screen.findByTestId("batches-none")).textContent).toContain("Adding images creates the first one");
  });

  it("shows a dash in a card while its source loads, and keeps the card", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    const answering = globalThis.fetch;
    // The batches request never settles, so the card that reads it stays loading.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname.endsWith("/batches")
        ? new Promise<Response>(() => undefined)
        : answering(input, init),
    );
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-stats");
    const labeled = screen.getByTestId("kpi-annotated");
    expect(labeled.textContent).toContain("Labeled");
    expect(labeled.textContent).toContain("—");
    // Another source has answered, so its neighbour shows a real value.
    expect(screen.getByTestId("kpi-images").textContent).toContain("48");
  });

  it("says how many sources the images came from", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    first("GET", /\/sources$/, { status: 200, body: { items: [], total: 2 } });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await waitFor(() => expect(screen.getByTestId("kpi-images").textContent).toContain("from 2 sources"));
  });

  it.each([
    ["image-only", ["image_directory"]],
    ["scan-only", ["point_cloud_directory"]],
    ["mixed", ["image_directory", "point_cloud_directory"]],
  ] as const)("counts a %s project's assets as Assets", async (_kind, kinds) => {
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    const items = kinds.map((kind, i) => ({
      id: `00000000-0000-4000-8000-00000000000${i}`,
      project_id: PROJECT,
      kind,
      name: `source-${i}`,
      registered_at: "2026-11-01T00:00:00Z",
      frame: null,
      video: null,
    }));
    first("GET", /\/sources$/, { status: 200, body: { items, total: items.length } });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const card = await screen.findByTestId("kpi-images");
    await waitFor(() => expect(card.textContent).toContain(`from ${items.length} source`));
    expect(card.getAttribute("aria-label")).toBe("Assets");
    expect(card.textContent).not.toMatch(/image|scan/i);
  });

  it("reads the dataset's own count, not the project's", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    first("GET", /\/datasets\/[^/]+\/stats$/, { status: 200, body: trunkStatsOf({ asset_count: 12 }) });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await waitFor(() => expect(within(screen.getByTestId("kpi-dataset")).getByText("12")).not.toBeNull());
  });

  it("sums the images left across batches that have jobs, never a draft's zeros", async () => {
    readinessOf({
      stats: statsOf({ asset_count: 48 }),
      batches: [
        batchOf({ id: "a", state: "in_annotation", progress: progressOf({ total: 20, unannotated: 5, pre_labeled: 2, annotated: 13 }) }),
        batchOf({ id: "d", state: "draft", asset_count: 30 }),
      ],
    });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    // One batch is open; the draft is not work anybody has been offered yet.
    await waitFor(() => expect(screen.getByTestId("kpi-annotated").textContent).toContain("7 left in 1 open batch"));
  });
});

/** The one thing a card may offer: a pointer, present only where the wire declares the move. */
describe("the cards' pointers", () => {
  const draftOf = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
    batchOf({ id, name: id, state: "draft", allowed_actions: batchActions("draft"), ...over });
  const finishedOf = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
    batchOf({ id, name: id, state: "completed", asset_count: 10, promoted_asset_count: 4, allowed_actions: batchActions("completed"), ...over });

  /** Waits until the batches and the dataset's two reads have all answered, so an absence is an answer. */
  async function settled(): Promise<void> {
    await screen.findByTestId("overview-batches");
    await waitFor(() => expect(screen.getByTestId("kpi-dataset").textContent).toMatch(/Nothing added yet|No releases yet|since|all in/));
  }

  describe("Review draft", () => {
    it("opens the draft's gallery from the images card's badge, labelled from the batch declaring approve", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [draftOf("d1")] });
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatchChange={open} />);

      const badge = await screen.findByTestId("kpi-attention-images");
      expect(badge.textContent).toBe("1 to review");
      // It sits in the card of the images it is about, and its steps wait behind it.
      expect(within(screen.getByTestId("kpi-images")).getByTestId("kpi-attention-images")).toBe(badge);
      expect(screen.queryByTestId("kpi-step-approve-d1")).toBeNull();
      await userEvent.click(badge);

      const step = await screen.findByTestId("kpi-step-approve-d1");
      expect(step.textContent).toContain("Review and approve");
      expect(step.textContent).toContain("d1");
      await userEvent.click(step);
      expect(open).toHaveBeenCalledExactlyOnceWith("d1");
    });

    it("counts the drafts on the badge and gives each its own step into its own batch", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [draftOf("d1"), draftOf("d2")] });
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatchChange={open} />);

      const badge = await screen.findByTestId("kpi-attention-images");
      expect(badge.textContent).toBe("2 to review");
      await userEvent.click(badge);

      expect(await screen.findByTestId("kpi-step-approve-d1")).not.toBeNull();
      await userEvent.click(screen.getByTestId("kpi-step-approve-d2"));
      expect(open).toHaveBeenCalledExactlyOnceWith("d2");
    });

    it("badges the batches declaring start in the Labeled card, each with its own step", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [
          batchOf({ id: "ok1", name: "ok1", state: "approved", allowed_actions: batchActions("approved") }),
          batchOf({ id: "ok2", name: "ok2", state: "approved", allowed_actions: batchActions("approved") }),
        ],
      });
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatchChange={open} />);

      const badge = await screen.findByTestId("kpi-attention-labeled");
      expect(within(screen.getByTestId("kpi-annotated")).getByTestId("kpi-attention-labeled")).toBe(badge);
      expect(badge.textContent).toBe("2 to start");
      await userEvent.click(badge);

      const step = await screen.findByTestId("kpi-step-start-ok2");
      expect(step.textContent).toContain("Review and start");
      expect(screen.getByTestId("kpi-step-start-ok1")).not.toBeNull();
      await userEvent.click(step);
      expect(open).toHaveBeenCalledExactlyOnceWith("ok2");
    });

    it("is absent where nothing declares approve, whatever the state says", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [
          // A draft by state that declares nothing is not offered a review.
          draftOf("bare", { allowed_actions: [] }),
          batchOf({ id: "live", name: "live", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) }),
          batchOf({ id: "ok", name: "ok", state: "approved", allowed_actions: batchActions("approved") }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await settled();
      expect(screen.queryByTestId("kpi-attention-images")).toBeNull();
      // The approved batch does declare start, so that card — and only that card — has its own badge.
      expect(screen.getByTestId("kpi-attention-labeled").textContent).toBe("1 to start");
    });

    it("needs no host to open a batch: the step opens the panel itself", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [draftOf("d1")] });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      // Opening a batch is the panel's own business now, not a callback a host may withhold.
      await userEvent.click(await screen.findByTestId("kpi-attention-images"));
      await userEvent.click(await screen.findByTestId("kpi-step-approve-d1"));

      const sheet = await screen.findByTestId("batch-sheet");
      expect(sheet.textContent).toContain("d1");
      expect(within(sheet).getByTestId("approve-batch")).not.toBeNull();
    });
  });

  describe("Review and add to dataset", () => {
    it("lists every finished batch that declares promote behind the dataset card's badge, each opening its own batch", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [finishedOf("first"), finishedOf("second")] });
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatchChange={open} />);

      const badge = await screen.findByTestId("kpi-attention-dataset");
      expect(badge.textContent).toBe("2 to add");
      expect(within(screen.getByTestId("kpi-dataset")).getByTestId("kpi-attention-dataset")).toBe(badge);
      await userEvent.click(badge);

      const first = await screen.findByTestId("kpi-step-promote-first");
      expect(first.textContent).toContain("Review and add to dataset");
      expect(screen.getByTestId("kpi-step-promote-second")).not.toBeNull();
      await userEvent.click(first);
      expect(open).toHaveBeenCalledExactlyOnceWith("first");
      // Nothing was promoted from here: it is a way into the gallery.
      expect(sent.filter((request) => request.method !== "GET")).toEqual([]);
    });

    it("is absent once every image is in the dataset, though promote stays declared", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [finishedOf("all-in", { promoted_asset_count: 10 })] });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await settled();
      expect(screen.queryByTestId("kpi-attention-dataset")).toBeNull();
    });

    it("is absent for a finished batch that does not declare it", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [finishedOf("bare", { allowed_actions: [] })] });
      renderWithData(<OverviewPanel projectId={PROJECT} />);
      await settled();
      expect(screen.queryByTestId("kpi-attention-dataset")).toBeNull();
    });

    it("is offered with no host wiring, and its step opens the batch's panel", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [finishedOf("waiting")] });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("kpi-attention-dataset"));
      await userEvent.click(await screen.findByTestId("kpi-step-promote-waiting"));

      const sheet = await screen.findByTestId("batch-sheet");
      expect(sheet.textContent).toContain("waiting");
      expect(within(sheet).getByTestId("promote-waiting")).not.toBeNull();
    });

    it("is absent for a batch still being labeled", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "live", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) })],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await settled();
      expect(screen.queryByTestId("kpi-attention-dataset")).toBeNull();
    });
  });

  describe("Publish a release", () => {
    const trunk = (images: number): void => first("GET", /\/datasets\/[^/]+\/stats$/, { status: 200, body: trunkStatsOf({ asset_count: images }) });

    it("opens the releases from the dataset badge when the dataset holds images and there is no release", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [] });
      trunk(42);
      const releases = vi.fn();
      const dataset = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onBrowseDataset={dataset} onOpenReleases={releases} />);

      const badge = await screen.findByTestId("kpi-attention-dataset");
      expect(badge.textContent).toBe("Unreleased");
      expect(within(screen.getByTestId("kpi-dataset")).getByTestId("kpi-attention-dataset")).toBe(badge);
      expect(screen.queryByTestId("kpi-publish")).toBeNull();
      await userEvent.click(badge);

      const action = await screen.findByTestId("kpi-publish");
      expect(action.textContent).toContain("Publish a release");
      await userEvent.click(action);
      expect(releases).toHaveBeenCalledOnce();
      expect(dataset).not.toHaveBeenCalled();
    });

    it("is offered again once images have arrived since the newest release", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [] });
      trunk(42);
      releasesOf([["v1", 20], ["v2", 30]]);
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenReleases={vi.fn()} />);

      const badge = await screen.findByTestId("kpi-attention-dataset");
      expect(badge.textContent).toBe("Unreleased");
      expect(screen.getByTestId("kpi-dataset").textContent).toContain("12 since v2");
      await userEvent.click(badge);
      expect(await screen.findByTestId("kpi-publish")).not.toBeNull();
    });

    it("is absent when the newest release already holds everything", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [] });
      trunk(30);
      releasesOf([["v1", 20], ["v2", 30]]);
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenReleases={vi.fn()} />);

      await settled();
      expect(screen.queryByTestId("kpi-attention-dataset")).toBeNull();
      expect(screen.queryByTestId("kpi-publish")).toBeNull();
    });

    it("is absent while the dataset is empty", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [] });
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenReleases={vi.fn()} />);

      await settled();
      expect(screen.getByTestId("kpi-dataset").textContent).toContain("Nothing added yet");
      expect(screen.queryByTestId("kpi-attention-dataset")).toBeNull();
      expect(screen.queryByTestId("kpi-publish")).toBeNull();
    });

    it("is absent where the host names no releases section", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [] });
      trunk(42);
      renderWithData(<OverviewPanel projectId={PROJECT} onBrowseDataset={vi.fn()} />);

      await settled();
      expect(screen.queryByTestId("kpi-attention-dataset")).toBeNull();
      expect(screen.queryByTestId("kpi-publish")).toBeNull();
    });

    it("lists the promote step ahead of the publish step, and reads the badge as the batches to promote", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [finishedOf("waiting")] });
      trunk(5);
      const open = vi.fn();
      const releases = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatchChange={open} onOpenReleases={releases} />);

      const badge = await screen.findByTestId("kpi-attention-dataset");
      // The batch to promote speaks first; the release is a step inside, not a second badge.
      expect(badge.textContent).toBe("1 to add");
      await userEvent.click(badge);

      const promote = await screen.findByTestId("kpi-step-promote-waiting");
      const publish = screen.getByTestId("kpi-publish");
      expect(promote.compareDocumentPosition(publish) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(screen.getByRole("dialog")).getAllByRole("button")).toHaveLength(2);

      await userEvent.click(promote);
      expect(open).toHaveBeenCalledExactlyOnceWith("waiting");
      expect(releases).not.toHaveBeenCalled();
    });
  });
});

// --- the batches panel ---------------------------------------------------------

/** The batches panel: a pointer at each batch, never a second set of its controls. */
describe("the batches panel", () => {
  const SUBURBS = "b-suburbs";
  const DOWNTOWN = "b-downtown";
  const HARBOR = "b-harbor";

  function trio(): void {
    readinessOf({
      stats: statsOf({ asset_count: 48 }),
      batches: [
        batchOf({ id: SUBURBS, name: "Suburbs", state: "draft", allowed_actions: batchActions("draft") }),
        batchOf({
          id: DOWNTOWN,
          name: "Downtown",
          state: "completed",
          promoted_asset_count: 10,
          allowed_actions: batchActions("completed"),
        }),
        batchOf({
          id: HARBOR,
          name: "Harbor",
          state: "completed",
          promoted_asset_count: 4,
          allowed_actions: batchActions("completed"),
        }),
      ],
    });
  }

  /** A row's own button: the one `Tab` reaches, the one that opens the sheet. */
  function rowButton(id: string): HTMLElement {
    const found = document.querySelector<HTMLElement>(`[data-row-open="${id}"]`);
    if (found === null) throw new Error(`no row button for ${id}`);
    return found;
  }

  function rowOrder(panel: HTMLElement): (string | null)[] {
    return [...panel.querySelectorAll("tbody tr")].map((row) => row.getAttribute("data-testid"));
  }

  /** Open one row's `⋯` menu and wait for it. */
  async function openMenu(name: string): Promise<void> {
    await userEvent.click(await screen.findByTestId(`batch-menu-${name}`));
    await screen.findByTestId("menu-details");
  }

  /**
   * Open a batch's panel the way a draft's is reached: its row opens the
   * approval instead, so the panel is the row menu's Jobs and details.
   */
  async function openPanelOf(name: string): Promise<HTMLElement> {
    await openMenu(name);
    await userEvent.click(screen.getByTestId("menu-details"));
    return screen.findByTestId("batch-sheet");
  }

  /** Open a row's menu and hand back one of its items. */
  async function openMenuItem(name: string, item: string): Promise<HTMLElement> {
    await openMenu(name);
    return screen.getByTestId(item);
  }

  /** Every item the open menu offers, in order. */
  function menuItems(): (string | null)[] {
    return [...document.querySelectorAll("[data-testid^=menu-]")].map((item) => item.getAttribute("data-testid"));
  }

  it("lists every batch, live work first, with no sheet open", async () => {
    trio();
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const panel = await screen.findByTestId("overview-batches");
    // A draft waits on a person; a completed batch only partly promoted is
    // ahead of one wholly in the dataset.
    expect(rowOrder(panel)).toEqual(["overview-batch-Suburbs", "overview-batch-Harbor", "overview-batch-Downtown"]);
    expect(within(screen.getByTestId("overview-batch-Suburbs")).getByTestId("batch-phase").textContent).toBe("Draft");
    expect(within(screen.getByTestId("overview-batch-Downtown")).getByTestId("batch-phase").textContent).toBe("In dataset");
    expect(screen.queryByTestId("batch-sheet")).toBeNull();
  });

  it("names each batch's size and pinned schema under it", async () => {
    readinessOf({
      stats: statsOf({ asset_count: 48 }),
      batches: [
        batchOf({ id: "one", name: "One", state: "draft", asset_count: 1, schema_version: null }),
        batchOf({ id: "many", name: "Many", state: "draft", asset_count: 1200, schema_version: 3 }),
      ],
    });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    expect((await screen.findByTestId("overview-batch-One")).textContent).toContain("1 image");
    expect(screen.getByTestId("overview-batch-One").textContent).not.toContain("schema v");
    expect(screen.getByTestId("overview-batch-Many").textContent).toContain(`${(1200).toLocaleString(undefined)} images · schema v3`);
  });

  describe("a batch's noun, from what it holds", () => {
    function sourcesOf(...kinds: string[]): void {
      first("GET", /\/sources$/, {
        status: 200,
        body: {
          items: kinds.map((kind, at) => ({ id: `s${at}`, project_id: PROJECT, kind, name: `s${at}`, registered_at: "2026-11-01T00:00:00Z", frame: null, video: null })),
          total: kinds.length,
        },
      });
    }
    function assetReads(): string[] {
      return sent.map((request) => new URL(request.url).pathname).filter((path) => /\/batches\/[^/]+\/assets$/.test(path));
    }

    it("counts scans in the row and the sheet of a project whose scans were imported, with no source", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 13 }),
        batches: [
          batchOf({ id: "one", name: "One", state: "draft", asset_count: 1, schema_version: null, modalities: ["point_cloud"] }),
          batchOf({ id: "many", name: "Many", state: "draft", asset_count: 12, schema_version: null, modalities: ["point_cloud"] }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      expect((await screen.findByTestId("overview-batch-Many")).textContent).toContain("12 scans");
      expect(screen.getByTestId("overview-batch-One").textContent).toContain("1 scan");
      expect(screen.getByTestId("overview-batch-One").textContent).not.toContain("image");
      await userEvent.click(rowButton("many"));
      const facts = within(await screen.findByTestId("batch-sheet")).getByTestId("batch-sheet-facts");
      expect(facts.textContent).toContain("Scans12");
      expect(facts.textContent).not.toContain("Images");
      expect(assetReads()).toEqual([]);
    });

    it("words each batch by its own modalities in a project holding a scan source and image batches", async () => {
      sourcesOf("point_cloud_directory", "image_directory");
      readinessOf({
        stats: statsOf({ asset_count: 7 }),
        batches: [
          batchOf({ id: "scans", name: "Scans", state: "draft", asset_count: 3, schema_version: null, modalities: ["point_cloud"] }),
          batchOf({ id: "photos", name: "Photos", state: "draft", asset_count: 4, schema_version: null, modalities: ["image"] }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      expect((await screen.findByTestId("overview-batch-Scans")).textContent).toContain("3 scans");
      expect(screen.getByTestId("overview-batch-Photos").textContent).toContain("4 images");
      expect(assetReads()).toEqual([]);
    });

    it("counts assets for a batch holding both images and scans", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 5 }),
        batches: [batchOf({ id: "both", name: "Both", state: "draft", asset_count: 5, schema_version: null, modalities: ["image", "point_cloud"] })],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const row = await screen.findByTestId("overview-batch-Both");
      expect(row.textContent).toContain("5 assets");
      expect(row.textContent).not.toMatch(/image|scan/);

      await userEvent.click(rowButton("both"));
      const facts = within(await screen.findByTestId("batch-sheet")).getByTestId("batch-sheet-facts");
      expect(facts.textContent).toContain("Assets5");
    });

    it("never draws a scan batch as images while anything else loads", async () => {
      sourcesOf("image_directory");
      readinessOf({
        stats: statsOf({ asset_count: 12 }),
        batches: [batchOf({ id: "many", name: "Many", state: "draft", asset_count: 12, schema_version: null, modalities: ["point_cloud"] })],
      });
      const seen: string[] = [];
      const watch = new MutationObserver(() => {
        const row = document.querySelector('[data-testid="overview-batch-Many"]');
        if (row?.textContent) seen.push(row.textContent);
      });
      watch.observe(document.body, { childList: true, subtree: true, characterData: true });
      try {
        renderWithData(<OverviewPanel projectId={PROJECT} />);
        await screen.findByTestId("overview-batch-Many");
        await waitFor(() => expect(sent.some((request) => new URL(request.url).pathname.endsWith("/sources"))).toBe(true));
      } finally {
        watch.disconnect();
      }

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((text) => /image/.test(text))).toEqual([]);
      expect(seen.every((text) => text.includes("12 scans"))).toBe(true);
    });
  });

  describe("the Labeled column", () => {
    it("draws one count of what is decided, and says a draft has not started", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [
          batchOf({ id: "live", name: "Live", state: "in_annotation", asset_count: 10, progress: progressOf({ total: 10, unannotated: 4, accepted: 6 }) }),
          batchOf({ id: "draft", name: "Draft", state: "draft", asset_count: 30 }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const live = await screen.findByTestId("overview-batch-Live");
      expect(live.textContent).toContain("6 of 10 · 60%");
      expect(screen.getByTestId("overview-batch-Draft").textContent).toContain("Not started");
      expect(screen.getByTestId("overview-batch-Draft").textContent).not.toContain("0 of 30");
    });
  });

  describe("opening a batch's panel", () => {
    it("opens it from the row's button, without leaving the page", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await screen.findByTestId("overview-batches");
      // The row opens a modal sheet; it claims no popup of its own.
      expect(rowButton(HARBOR).getAttribute("aria-haspopup")).toBeNull();
      expect(rowButton(HARBOR).getAttribute("aria-expanded")).toBe("false");
      await userEvent.click(rowButton(HARBOR));

      const sheet = await screen.findByTestId("batch-sheet");
      expect(sheet.textContent).toContain("Harbor");
      expect(within(sheet).getByTestId("batch-phase").textContent).toBe("Completed");
      expect(sheet.textContent).toContain("Batch 2 of 3");
      expect(screen.getByTestId("overview-batch-Harbor").getAttribute("data-open")).toBe("");

      // A sheet over the page from the right, named for what it holds — and
      // modal, as a dialog is: the table under it is put out of reach.
      expect(screen.getByRole("dialog", { name: "Batch" })).toBe(sheet);
      expect(screen.getByTestId("overview-row").contains(sheet)).toBe(false);
      expect(rowButton(DOWNTOWN).closest("[inert], [aria-hidden=true]")).not.toBeNull();
    });

    it("opens it from anywhere on the row, too", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Downtown"));
      expect((await screen.findByTestId("batch-sheet")).textContent).toContain("Downtown");
    });

    it("is the host's to hold when it names the open batch: it opens on that batch and reports every change", async () => {
      trio();
      const change = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} openBatchId={HARBOR} onOpenBatchChange={change} />);

      // Opened on the batch the URL names, without anybody clicking.
      const sheet = await screen.findByTestId("batch-sheet");
      expect(sheet.textContent).toContain("Harbor");
      expect(change).not.toHaveBeenCalled();

      // The table is out of reach under the scrim, so the next batch is asked for with J; the
      // panel stays on what the host says until it answers.
      await userEvent.keyboard("j");
      expect(change).toHaveBeenLastCalledWith(DOWNTOWN);
      expect(sheet.textContent).toContain("Harbor");

      await userEvent.click(within(sheet).getByTestId("batch-close"));
      expect(change).toHaveBeenLastCalledWith(null);
      expect(change).toHaveBeenCalledTimes(2);
    });

    it("closes with Escape", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Downtown"));
      const sheet = await screen.findByTestId("batch-sheet");
      // Focus opens on the forward control, whose tooltip is a layer of its own that takes the
      // first Escape; the sheet answers the one that reaches it.
      within(sheet).getByTestId("batch-close").focus();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByTestId("batch-sheet")).toBeNull());
    });

    it("closes when a press lands outside it, on the scrim", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Downtown"));
      await screen.findByTestId("batch-sheet");
      const scrim = document.querySelector<HTMLElement>('[data-slot="sheet-overlay"]');
      expect(scrim).not.toBeNull();
      await userEvent.click(scrim!);
      await waitFor(() => expect(screen.queryByTestId("batch-sheet")).toBeNull());
    });

    it("has a left-edge handle that resizes it and remembers the width", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Downtown"));
      const sheet = await screen.findByTestId("batch-sheet");
      expect(sheet.style.width).toBe("480px");
      const handle = within(sheet).getByTestId("detail-resize");
      handle.focus();
      await userEvent.keyboard("{ArrowLeft}");
      await waitFor(() => expect(Number.parseInt(sheet.style.width, 10)).toBeGreaterThan(480));
      expect(Number(readPref("detail-width:batch-sheet"))).toBeGreaterThan(480);
    });

    it("closes with its own button, and hands the focus back to the batch's row", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await screen.findByTestId("overview-batches");
      await userEvent.click(rowButton(HARBOR));
      const sheet = await screen.findByTestId("batch-sheet");
      await userEvent.click(within(sheet).getByRole("button", { name: "Close the batch" }));
      await waitFor(() => expect(screen.queryByTestId("batch-sheet")).toBeNull());
      expect(screen.getByTestId("overview-batch-Harbor").getAttribute("data-open")).toBeNull();
      expect(document.activeElement).toBe(rowButton(HARBOR));
    });

    it("leaves Escape to a field being typed in", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Harbor"));
      const sheet = await screen.findByTestId("batch-sheet");
      // The table's filter is out of reach under the scrim, so the field is one the sheet holds.
      const field = document.createElement("input");
      sheet.append(field);
      try {
        field.focus();
        await userEvent.keyboard("{Escape}");
        expect(screen.getByTestId("batch-sheet")).not.toBeNull();
      } finally {
        field.remove();
      }
    });

    it("lists that batch's jobs, each with who holds it and how far it has come", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) })],
        jobs: [
          jobOf("j1", "live", { state: "in_progress", assignee: "Dana Reyes" }),
          jobOf("j2", "live", { state: "pending" }),
          jobOf("j3", "live", { state: "completed", assignee: "Kim" }),
        ],
        progress: progressOf({ total: 5, annotated: 2, unannotated: 3 }),
      });
      const job = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenJob={job} />);

      await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
      const jobs = await screen.findByTestId("batch-sheet-jobs");
      const first = await within(jobs).findByTestId("batch-sheet-job-Job 1");
      expect(first.textContent).toContain("Dana Reyes");
      await waitFor(() => expect(first.textContent).toContain("2 of 5 · 40%"));
      expect(within(jobs).getByTestId("batch-sheet-job-Job 2").textContent).toContain("Unassigned");
      // A finished job says so, and still opens — to be read, not continued:
      // with no batch page, the panel is the only way into its frames.
      const done = within(jobs).getByTestId("batch-sheet-job-Job 3");
      expect(within(done).queryByRole("button", { name: /^Open/ })).toBeNull();
      await userEvent.click(within(done).getByRole("button", { name: "View Job 3 in the editor, done" }));
      expect(job).toHaveBeenLastCalledWith("j3");
      job.mockClear();

      await userEvent.click(within(first).getByRole("button", { name: "Open Job 1 in the editor" }));
      expect(job).toHaveBeenCalledExactlyOnceWith("j1");
    });

    it("says a job's state in words where the host has no editor to send it to", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation" })],
        jobs: [jobOf("j1", "live", { state: "in_progress" })],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
      const card = await screen.findByTestId("batch-sheet-job-Job 1");
      expect(card.textContent).toContain("In progress");
      expect(within(card).queryByRole("button")).toBeNull();
    });

    it("opens a draft's approval from its row, by click or Enter, and leaves every other row opening the panel", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Suburbs"));
      expect(await screen.findByTestId("approve-dialog")).not.toBeNull();
      expect(screen.queryByTestId("batch-sheet")).toBeNull();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByTestId("approve-dialog")).toBeNull());

      rowButton(SUBURBS).focus();
      await userEvent.keyboard("{Enter}");
      expect(await screen.findByTestId("approve-dialog")).not.toBeNull();
      expect(screen.queryByTestId("batch-sheet")).toBeNull();
      expect(sent.filter((request) => request.method !== "GET")).toEqual([]);
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByTestId("approve-dialog")).toBeNull());

      await userEvent.click(screen.getByTestId("overview-batch-Harbor"));
      expect((await screen.findByTestId("batch-sheet")).textContent).toContain("Harbor");
      expect(screen.queryByTestId("approve-dialog")).toBeNull();
    });

    it("says what a draft's missing jobs are waiting on", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await openPanelOf("Suburbs");
      expect((await screen.findByTestId("batch-sheet-jobs")).textContent).toContain(
        "No jobs yet. Approving the batch cuts it into jobs.",
      );
      // A draft's jobs are never read: there are none to read.
      expect(sent.some((request) => /\/batches\/b-suburbs\/jobs$/.test(new URL(request.url).pathname))).toBe(false);
    });

    it("walks the batches with J and K, and with its own arrows, in the order the table shows", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const sheet = await openPanelOf("Suburbs");
      expect(sheet.textContent).toContain("Batch 1 of 3");
      expect(within(sheet).getByRole("button", { name: "Previous batch (K)" }).hasAttribute("disabled")).toBe(true);

      await userEvent.keyboard("j");
      expect(sheet.textContent).toContain("Harbor");
      expect(sheet.textContent).toContain("Batch 2 of 3");

      await userEvent.click(within(sheet).getByRole("button", { name: "Next batch (J)" }));
      expect(sheet.textContent).toContain("Downtown");
      expect(sheet.textContent).toContain("Batch 3 of 3");
      // The last batch is a wall, not a wrap.
      expect(within(sheet).getByRole("button", { name: "Next batch (J)" }).hasAttribute("disabled")).toBe(true);
      await userEvent.keyboard("j");
      expect(sheet.textContent).toContain("Batch 3 of 3");

      await userEvent.keyboard("k");
      expect(sheet.textContent).toContain("Harbor");
      await userEvent.click(within(sheet).getByRole("button", { name: "Previous batch (K)" }));
      expect(sheet.textContent).toContain("Suburbs");
      expect(screen.getByTestId("overview-batch-Suburbs").getAttribute("data-open")).toBe("");
    });

    it("steps only through the batches the table is showing", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(within(await screen.findByTestId("batches-lens")).getByRole("radio", { name: "Open" }));
      const sheet = await openPanelOf("Suburbs");
      // Downtown is wholly in the dataset, so the Open view leaves it out.
      expect(sheet.textContent).toContain("Batch 1 of 2");
      await userEvent.keyboard("j");
      expect(sheet.textContent).toContain("Harbor");
      await userEvent.keyboard("j");
      expect(sheet.textContent).toContain("Harbor");
    });

    it("leaves J and K to an open menu", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [
          batchOf({ id: "a", name: "Alpha", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) }),
          batchOf({ id: "b", name: "Beta", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Alpha"));
      const sheet = await screen.findByTestId("batch-sheet");
      expect(sheet.textContent).toContain("Batch 1 of 2");
      // A menu opened from the sheet's top bar is a menu: its letters are its own.
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      document.body.append(menu);
      try {
        await userEvent.keyboard("j");
        expect(sheet.textContent).toContain("Batch 1 of 2");
      } finally {
        menu.remove();
      }
    });
  });

  describe("the sheet's top bar", () => {
    /** Open one batch's panel and hand back its actions. */
    async function actionsOf(name: string): Promise<HTMLElement> {
      // A draft's row opens its approval, so only its panel goes through the menu.
      if (name === "Suburbs") await openPanelOf(name);
      else {
        await userEvent.click(await screen.findByTestId(`overview-batch-${name}`));
        await screen.findByTestId("batch-sheet");
      }
      return screen.getByTestId("batch-sheet-actions");
    }

    it("has no Open batch and no forward pointer: the batch is already open, and its controls are the top bar's", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const footer = await actionsOf("Suburbs");
      // The pointers pointed at a page that is gone; the controls themselves are here now.
      expect(within(footer).queryByTestId("sheet-open")).toBeNull();
      expect(within(footer).queryByTestId("sheet-approve")).toBeNull();
      expect(within(footer).getByTestId("approve-batch")).not.toBeNull();
    });

    it("leads with Approve for a draft, puts focus on it, and opens the partition dialog without sending anything", async () => {
      trio();
      // Held open, the way `?batch=` arrives: the menu that would open it takes the focus back to its trigger.
      renderWithData(<Held initial={SUBURBS} />);

      await screen.findByTestId("batch-sheet");
      const footer = screen.getByTestId("batch-sheet-actions");
      const approve = within(footer).getByTestId("approve-batch");
      // Every footer control is an icon button, named by its tooltip.
      expect(approve.getAttribute("aria-label")).toBe("Approve");
      expect(approve.textContent).toBe("");
      expect(approve.hasAttribute("data-autofocus")).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(approve));

      await userEvent.click(approve);
      // Approval carries a partition and has no route back: the press opens the dialog and nothing more.
      expect(await screen.findByTestId("approve-dialog")).not.toBeNull();
      expect(sent.filter((request) => request.method !== "GET")).toEqual([]);
    });

    it("puts focus on the last enabled footer button where the batch has no forward step", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      // Downtown is wholly in the dataset: it declares promote, but there is nothing left to add.
      const footer = await actionsOf("Downtown");
      expect(footer.querySelector("[data-autofocus]")).toBeNull();
      const last = [...footer.querySelectorAll<HTMLElement>("button:not(:disabled)")].at(-1);
      expect(last).toBeDefined();
      await waitFor(() => expect(document.activeElement).toBe(last));
    });

    it("promotes a finished batch from its footer, and says what the press did", async () => {
      trio();
      on("POST", /\/batches\/b-harbor\/promote$/, { status: 200, body: { items: [], total: 6 } });
      renderWithData(
        <>
          <OverviewPanel projectId={PROJECT} />
          <Toaster />
        </>,
      );

      const footer = await actionsOf("Harbor");
      await userEvent.click(within(footer).getByTestId("promote-Harbor"));

      // What the press did is a toast, not a line among the panel's controls.
      const said = await screen.findByTestId("promoted-Harbor");
      expect(said.textContent).toContain("Added 6 images");
      expect(said.closest("[data-sonner-toast]")).not.toBeNull();
      expect(sent.filter((request) => request.method === "POST").map((request) => new URL(request.url).pathname)).toEqual([
        "/batches/b-harbor/promote",
      ]);
    });

    it("says a batch wholly in the dataset is there, rather than offering to add it again", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      // Downtown declares promote, but every one of its images is already in the trunk:
      // no Add to dataset, and no line saying so either — its State says In dataset.
      const footer = await actionsOf("Downtown");
      expect(within(footer).queryByTestId("promote-Downtown")).toBeNull();
      expect(screen.queryByTestId("in-dataset-Downtown")).toBeNull();
      expect(within(screen.getByTestId("batch-sheet-facts")).getByTestId("batch-phase").textContent).toBe("In dataset");
    });

    it("puts Correct in a completed batch's bar, with no Delete, away from the forward step, and opens its dialog", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const footer = await actionsOf("Harbor");
      expect(within(footer).getByTestId("promote-Harbor").getAttribute("aria-label")).toBe("Add to dataset");
      const correct = within(footer).getByTestId("correct-Harbor");
      // Said in words: no icon reads as "fix a finished batch's labels".
      expect(correct.textContent).toBe("Correct");
      // A completed batch can never be deleted, so there is no Delete beside it.
      expect(within(footer).queryByTestId("delete-batch-Harbor")).toBeNull();
      const order = [...footer.querySelectorAll<HTMLElement>("button")].map((one) => one.getAttribute("data-testid"));
      expect(order.indexOf("correct-Harbor")).toBeLessThan(order.indexOf("promote-Harbor"));
      // No overflow menu any more.
      expect(within(footer).queryByTestId("batch-overflow-Harbor")).toBeNull();

      await userEvent.click(correct);
      expect(await screen.findByTestId("correction-dialog")).not.toBeNull();
      expect(sent.filter((request) => request.method !== "GET")).toEqual([]);
    });

    it("completes without adding only after a confirmation with its switch off, and sends no promotion", async () => {
      const done = batchOf({
        id: "done",
        name: "drive-02",
        state: "in_annotation",
        progress: progressOf({ total: 10, annotated: 10 }),
        allowed_actions: batchActions("in_annotation", { settled: true }),
      });
      readinessOf({
        stats: statsOf({ asset_count: 10 }),
        batches: [done],
        jobs: [{ id: "job-1", batch_id: "done", state: "completed", asset_count: 10, assignee: null, pre_label_run: null, allowed_actions: [] }],
      });
      on("POST", /\/batches\/done\/finish$/, {
        status: 200,
        body: {
          batch: batchOf({ id: "done", name: "drive-02", state: "completed", allowed_actions: batchActions("completed") }),
          jobs_completed: 0,
        },
      });
      renderWithData(
        <>
          <OverviewPanel projectId={PROJECT} />
          <Toaster />
        </>,
      );

      const footer = await actionsOf("drive-02");
      await userEvent.click(within(footer).getByTestId("complete-drive-02"));
      const confirm = await screen.findByTestId("complete-confirm");
      expect(confirm.textContent).toContain("can’t be reopened");
      expect(sent.filter((request) => request.method !== "GET")).toEqual([]);

      // The switch remembers its last answer for the session, so the test says its own.
      const add = within(confirm).getByTestId("complete-add");
      if (add.getAttribute("aria-checked") === "true") await userEvent.click(add);
      await userEvent.click(within(confirm).getByTestId("complete-submit"));
      await waitFor(() => expect(screen.queryByTestId("complete-confirm")).toBeNull());
      expect((await screen.findByTestId("completed-drive-02")).textContent).toContain("Nothing is in the dataset yet");
      expect(sent.filter((request) => request.method === "POST").map((request) => new URL(request.url).pathname)).toEqual([
        "/batches/done/finish",
      ]);
    });

    it("withholds Complete, with its count in the tooltip, while the batch does not declare it", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 10 }),
        batches: [
          batchOf({
            id: "open",
            name: "drive-03",
            state: "in_annotation",
            progress: progressOf({ total: 10, annotated: 8, unannotated: 2 }),
            allowed_actions: batchActions("in_annotation", { settled: false }),
          }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const footer = await actionsOf("drive-03");
      const complete = within(footer).getByTestId("complete-drive-03");
      expect(complete.getAttribute("aria-disabled")).toBe("true");
      expect(complete.getAttribute("aria-label")).toBe("Complete batch");
      // The count is the tooltip's reason, reached by keyboard: the withheld button stays focusable.
      complete.focus();
      expect((await screen.findAllByText(/^2 .+ still to annotate or skip$/)).length).toBeGreaterThan(0);
      await userEvent.click(complete);
      expect(screen.queryByTestId("complete-confirm")).toBeNull();
    });

    it("offers Complete to a batch being labeled, and no separate Add to dataset beside it", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) })],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const footer = await actionsOf("drive-01");
      // One control: whether the images go into the dataset is the confirmation's switch.
      expect(within(footer).getByTestId("complete-drive-01").getAttribute("aria-label")).toBe("Complete batch");
      expect(within(footer).queryByTestId("complete-promote-drive-01")).toBeNull();
      expect(within(footer).queryByTestId("promote-drive-01")).toBeNull();
      expect(within(footer).queryByTestId("approve-batch")).toBeNull();
      expect(within(footer).queryByTestId("correct-drive-01")).toBeNull();
    });

    it("offers Start annotating to an approved batch, and nothing that moves it elsewhere", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "ok", name: "ok", state: "approved", allowed_actions: batchActions("approved") })],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const footer = await actionsOf("ok");
      expect(within(footer).getByTestId("start-batch")).not.toBeNull();
      expect(within(footer).queryByTestId("approve-batch")).toBeNull();
      expect(within(footer).queryByTestId("complete-ok")).toBeNull();
    });

    it("draws a control only where the batch declares it, whatever its state says", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [
          batchOf({ id: "bare-draft", name: "bare-draft", state: "draft", allowed_actions: [] }),
          batchOf({ id: "bare-done", name: "bare-done", state: "completed", promoted_asset_count: 4, allowed_actions: [] }),
        ],
      });
      for (const name of ["bare-draft", "bare-done"]) {
        // A fresh panel each time: the open sheet's scrim covers the table's other rows.
        const { unmount } = renderWithData(<OverviewPanel projectId={PROJECT} />);
        const footer = await actionsOf(name);
        for (const id of ["approve-batch", "start-batch", "sheet-annotate", "sheet-prelabel", `complete-${name}`, `complete-promote-${name}`, `promote-${name}`, `correct-${name}`]) {
          expect(within(footer).queryByTestId(id), `${name}: ${id}`).toBeNull();
        }
        // A draft that does not declare delete may yet be deletable: withheld with its reason.
        // A completed batch never can be again, so it has no Delete at all.
        if (name === "bare-done") {
          expect(within(footer).queryByTestId(`delete-batch-${name}`), `${name}: delete`).toBeNull();
        } else {
          const remove = within(footer).getByTestId(`delete-batch-${name}`);
          expect(remove.getAttribute("aria-disabled"), `${name}: delete`).toBe("true");
        }
        unmount();
      }
    });

    it("closes the panel when its batch is deleted", async () => {
      trio();
      on("DELETE", /\/batches\/b-suburbs$/, { status: 204 });
      const change = vi.fn();
      renderWithData(<Held onChange={change} />);

      await openPanelOf("Suburbs");
      expect(change).toHaveBeenLastCalledWith(SUBURBS);

      await userEvent.click(within(screen.getByTestId("batch-sheet-actions")).getByTestId("delete-batch-Suburbs"));
      await userEvent.click(await screen.findByTestId("delete-batch-submit"));

      await waitFor(() => expect(screen.queryByTestId("batch-sheet")).toBeNull());
      expect(change).toHaveBeenLastCalledWith(null);
    });

    it("annotates straight into the one job it has", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) })],
        jobs: [jobOf("j1", "live", { state: "in_progress", assignee: "Dana" })],
      });
      const job = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenJob={job} />);

      await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
      const annotate = await screen.findByTestId("sheet-annotate");
      // The one control in the bar that says its name rather than leaving it to a tooltip.
      expect(annotate.textContent).toBe("Annotate");
      await screen.findByTestId("batch-sheet-job-Job 1");
      await userEvent.click(annotate);
      expect(job).toHaveBeenCalledExactlyOnceWith("j1");
    });

    it("opens the batch's images in Images from the count on its Images property", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: false }) })],
        jobs: [jobOf("j1", "live", { state: "in_progress", assignee: "Dana" })],
      });
      const assets = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenJob={vi.fn()} onOpenBatchAssets={assets} />);

      await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
      const link = await screen.findByTestId("batch-sheet-assets");
      expect(screen.getByTestId("batch-sheet-facts").contains(link)).toBe(true);
      // Its name starts with what it shows, so a spoken command finds it.
      expect(link.getAttribute("aria-label")).toMatch(/^\d+ images, open in Images$/);
      await userEvent.click(link);
      expect(assets).toHaveBeenCalledExactlyOnceWith("live");
    });

    it("says the count as plain text where the host has nowhere to send it", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: false }) })],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
      await screen.findByTestId("batch-sheet-facts");
      expect(screen.queryByTestId("batch-sheet-assets")).toBeNull();
    });

    it("leaves the choice to the jobs list when there are several jobs to pick from", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) })],
        jobs: [jobOf("j1", "live"), jobOf("j2", "live")],
      });
      const job = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenJob={job} />);

      await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
      const second = await screen.findByTestId("batch-sheet-job-Job 2");
      // One Annotate cannot name a job among several; each job carries its own Open.
      expect(screen.queryByTestId("sheet-annotate")).toBeNull();
      await userEvent.click(within(second).getByRole("button", { name: "Open Job 2 in the editor" }));
      expect(job).toHaveBeenCalledExactlyOnceWith("j2");
    });

    it("offers no Annotate where the host has no editor to send anybody to", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) })],
        jobs: [jobOf("j1", "live")],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
      await screen.findByTestId("batch-sheet-job-Job 1");
      expect(screen.queryByTestId("sheet-annotate")).toBeNull();
    });

    describe("Auto-label", () => {
      const live = (): Record<string, unknown> =>
        batchOf({
          id: "live",
          name: "drive-01",
          state: "in_annotation",
          progress: progressOf({ total: 10, unannotated: 10 }),
          allowed_actions: batchActions("in_annotation", { settled: false }),
        });

      it("opens the dialog over that one batch, titled for it", async () => {
        readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [live()] });
        renderWithData(<OverviewPanel projectId={PROJECT} />);

        await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
        const control = await screen.findByTestId("sheet-prelabel");
        // An icon in the sheet's top bar, named by its tooltip, first among the batch's actions.
        expect(control.getAttribute("aria-label")).toBe("Auto-label this batch");
        expect(screen.getByTestId("batch-sheet-tools").contains(control)).toBe(true);
        expect(screen.getByTestId("batch-sheet-actions").contains(control)).toBe(true);
        await userEvent.click(control);

        expect(await screen.findByText("Auto-label drive-01")).not.toBeNull();
        expect(screen.getByTestId("project-prelabel-dialog")).not.toBeNull();
      });

      it("is offered only to a batch that declares pre_label", async () => {
        trio();
        renderWithData(<OverviewPanel projectId={PROJECT} />);

        // A draft declares approve, not pre_label.
        await openPanelOf("Suburbs");
        await screen.findByTestId("approve-batch");
        expect(screen.queryByTestId("sheet-prelabel")).toBeNull();
      });
    });
  });

  describe("the row's pointer, in its menu", () => {
    it("labels the way in from what the batch may do, never from its state", async () => {
      const cases = [
        {
          name: "to approve",
          over: { state: "draft", allowed_actions: batchActions("draft") },
          key: "approve",
          label: "Review and approve",
        },
        {
          name: "to start",
          over: { state: "approved", allowed_actions: batchActions("approved") },
          key: "start",
          label: "Review and start",
        },
        {
          name: "to promote",
          over: { state: "completed", promoted_asset_count: 4, allowed_actions: batchActions("completed") },
          key: "promote",
          label: "Review and add to dataset",
        },
        {
          name: "to annotate",
          over: { state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) },
          key: "annotate",
          label: "Annotate",
        },
        {
          // `promote` stays declared once everything is in the trunk, so no label
          // offers a promotion that would add nothing.
          name: "with everything already promoted",
          over: { state: "completed", promoted_asset_count: 10, allowed_actions: batchActions("completed") },
          key: null,
          label: null,
        },
        { name: "with nothing declared", over: { state: "draft", allowed_actions: [] }, key: null, label: null },
        {
          // Annotate is the one pointer read from the phase, not from a declared
          // batch action: it opens jobs, and moves nothing.
          name: "to annotate with nothing declared",
          over: { state: "in_annotation", allowed_actions: [] },
          key: "annotate",
          label: "Annotate",
        },
      ] as const;

      for (const one of cases) {
        handlers = [];
        readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [batchOf({ id: "only", name: "Only", ...one.over })] });
        const open = vi.fn();
        const { unmount } = renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatchChange={open} />);

        await screen.findByTestId("overview-batch-Only");
        // Nothing sits on the row at rest or on hover: the pointer is a menu item.
        expect(document.querySelectorAll("[data-testid^=row-]"), one.name).toHaveLength(0);
        await openMenu("Only");
        const pointers = menuItems().filter((id) => id !== "menu-details" && id !== "menu-prelabel");
        if (one.key === null) {
          expect(pointers, one.name).toHaveLength(0);
        } else {
          expect(pointers, one.name).toEqual([`menu-${one.key}`]);
          const pointer = screen.getByTestId(`menu-${one.key}`);
          expect(pointer.textContent, one.name).toBe(one.label);
          await userEvent.click(pointer);
          if (one.key === "approve") {
            // A draft's way in is its approval, not its panel.
            expect(await screen.findByTestId("approve-dialog"), one.name).not.toBeNull();
            expect(open, one.name).not.toHaveBeenCalled();
          } else {
            expect(open, one.name).toHaveBeenCalledExactlyOnceWith("only");
          }
          // The host holds the open batch here and answered nothing, so the panel stays shut:
          // pointing asks the host to open the batch, it does not open a panel behind its back.
          expect(screen.queryByTestId("batch-sheet"), one.name).toBeNull();
          expect(sent.filter((request) => request.method !== "GET"), one.name).toEqual([]);
        }
        unmount();
      }
    });

    it("needs no host: pressing a finished batch's opens that batch's panel itself", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await openMenu("Harbor");
      await userEvent.click(screen.getByTestId("menu-promote"));
      const sheet = await screen.findByTestId("batch-sheet");
      expect(sheet.textContent).toContain("Harbor");
    });

    it("needs no host: a draft's opens its approval, and approving opens its panel", async () => {
      trio();
      on("POST", /\/batches\/b-suburbs\/approve$/, {
        status: 200,
        body: batchOf({ id: "b-suburbs", name: "Suburbs", state: "approved", allowed_actions: batchActions("approved") }),
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await openMenu("Suburbs");
      await userEvent.click(screen.getByTestId("menu-approve"));
      await screen.findByTestId("approve-dialog");
      expect(screen.queryByTestId("batch-sheet")).toBeNull();
      expect(sent.filter((request) => request.method !== "GET")).toEqual([]);

      // Approval only: starting is its own request, and this test is about where approving lands.
      await userEvent.click(screen.getByTestId("approve-start"));
      await userEvent.click(screen.getByTestId("approve-submit"));
      expect((await screen.findByTestId("batch-sheet")).textContent).toContain("Suburbs");
      expect(screen.queryByTestId("approve-dialog")).toBeNull();
    });

    it("only points: pressing it sends nothing that changes anything", async () => {
      trio();
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatchChange={open} />);

      await openMenu("Suburbs");
      await userEvent.click(screen.getByTestId("menu-approve"));
      await screen.findByTestId("approve-dialog");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByTestId("approve-dialog")).toBeNull());
      await openMenu("Harbor");
      await userEvent.click(screen.getByTestId("menu-promote"));
      // The draft's pointer opened its approval, not a panel: only the finished batch asked the host.
      expect(open.mock.calls).toEqual([[HARBOR]]);
      expect(sent.filter((request) => request.method !== "GET")).toEqual([]);
    });

    describe("on a batch being labeled", () => {
      function labeling(jobs: readonly Record<string, unknown>[]): void {
        readinessOf({
          stats: statsOf({ asset_count: 48 }),
          batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) })],
          jobs,
        });
      }

      it("annotates straight into the one job it has", async () => {
        labeling([jobOf("j1", "live", { state: "in_progress", assignee: "Dana" })]);
        const open = vi.fn();
        const job = vi.fn();
        renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatchChange={open} onOpenJob={job} />);

        const row = await screen.findByTestId("overview-batch-drive-01");
        // Who holds the jobs, once they have been read: the pointer waits on them.
        await waitFor(() => expect(row.textContent).toContain("1 job: Dana"));
        expect(within(row).getByText("DA")).not.toBeNull();
        await userEvent.click(await openMenuItem("drive-01", "menu-annotate"));
        expect(job).toHaveBeenCalledExactlyOnceWith("j1");
        expect(open).not.toHaveBeenCalled();
      });

      it("opens the batch's panel when there are several jobs to pick from", async () => {
        labeling([jobOf("j1", "live"), jobOf("j2", "live", { assignee: "Kim Lee" })]);
        const open = vi.fn();
        const job = vi.fn();
        renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatchChange={open} onOpenJob={job} />);

        const row = await screen.findByTestId("overview-batch-drive-01");
        await waitFor(() => expect(row.textContent).toContain("2 jobs: Unassigned, Kim Lee"));
        // An unassigned job is a dashed mark, not a name.
        expect(within(row).getByText("?")).not.toBeNull();
        expect(within(row).getByText("KL")).not.toBeNull();
        await userEvent.click(await openMenuItem("drive-01", "menu-annotate"));
        expect(open).toHaveBeenCalledExactlyOnceWith("live");
        expect(job).not.toHaveBeenCalled();
      });

      it("opens the batch's panel where the host cannot open a job", async () => {
        labeling([jobOf("j1", "live")]);
        const open = vi.fn();
        renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatchChange={open} />);

        const row = await screen.findByTestId("overview-batch-drive-01");
        await waitFor(() => expect(row.textContent).toContain("1 job"));
        await userEvent.click(await openMenuItem("drive-01", "menu-annotate"));
        expect(open).toHaveBeenCalledExactlyOnceWith("live");
      });
    });

    describe("each row's own jobs read", () => {
      function twoLive(): void {
        readinessOf({
          stats: statsOf({ asset_count: 48 }),
          batches: [
            batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) }),
            batchOf({ id: "broken", name: "drive-02", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) }),
          ],
          jobs: [jobOf("j1", "live", { state: "in_progress", assignee: "Dana" })],
        });
      }

      it("shows a row's holders even while another row's read is refused", async () => {
        twoLive();
        first("GET", /\/batches\/broken\/jobs$/, { status: 500, body: { code: "BOOM", message: "Jobs could not be read." } });
        renderWithData(<OverviewPanel projectId={PROJECT} />);

        const live = await screen.findByTestId("overview-batch-drive-01");
        await waitFor(() => expect(live.textContent).toContain("1 job: Dana"));
        const broken = await screen.findByTestId("batch-jobs-error-drive-02");
        expect(broken.textContent).toContain("Unavailable");
        expect(broken.getAttribute("title")).toBe("Jobs could not be read.");
      });

      it("says the refusal in the sheet and reads again on Try again", async () => {
        twoLive();
        let refuse = true;
        handlers.unshift((request) =>
          refuse && request.method === "GET" && /\/batches\/broken\/jobs$/.test(new URL(request.url).pathname)
            ? { status: 500, body: { code: "BOOM", message: "Jobs could not be read." } }
            : undefined,
        );
        renderWithData(<OverviewPanel projectId={PROJECT} />);

        await screen.findByTestId("batch-jobs-error-drive-02");
        await userEvent.click(screen.getByTestId("overview-batch-drive-02"));
        const refused = await screen.findByTestId("batch-sheet-jobs-error");
        expect(refused.textContent).toContain("Jobs could not be read.");

        refuse = false;
        await userEvent.click(within(refused).getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(screen.queryByTestId("batch-sheet-jobs-error")).toBeNull());
        expect(await screen.findByTestId("batch-sheet-job-Job 1")).not.toBeNull();
      });
    });

    it("reads no jobs for a draft, and a dash where it has none", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const draft = await screen.findByTestId("overview-batch-Suburbs");
      expect(draft.textContent).not.toContain("job");
      expect(sent.some((request) => /\/batches\/b-suburbs\/jobs$/.test(new URL(request.url).pathname))).toBe(false);
      // The cut batches are read, once each.
      await waitFor(() => expect(sent.some((request) => /\/batches\/b-harbor\/jobs$/.test(new URL(request.url).pathname))).toBe(true));
    });
  });

  describe("the row's menu", () => {
    it("offers the details and the one forward pointer labelled from what the batch declares, pre-label only where declared, and no Open batch", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [
          batchOf({ id: "live", name: "Live", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) }),
          batchOf({ id: "d", name: "Draft", state: "draft", allowed_actions: batchActions("draft") }),
          batchOf({ id: "ok", name: "Approved", state: "approved", allowed_actions: batchActions("approved") }),
          batchOf({ id: "fin", name: "Finished", state: "completed", promoted_asset_count: 4, allowed_actions: batchActions("completed") }),
          batchOf({ id: "all", name: "Everything", state: "completed", promoted_asset_count: 10, allowed_actions: batchActions("completed") }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const expected: Record<string, string[]> = {
        Live: ["menu-details", "menu-annotate", "menu-prelabel"],
        Draft: ["menu-details", "menu-approve"],
        Approved: ["menu-details", "menu-start"],
        Finished: ["menu-details", "menu-promote"],
        Everything: ["menu-details"],
      };
      for (const [name, items] of Object.entries(expected)) {
        await openMenu(name);
        expect(menuItems(), name).toEqual(items);
        await userEvent.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByTestId("menu-details")).toBeNull());
      }
    });

    it("opens the sheet from Jobs and details", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await openMenu("Harbor");
      await userEvent.click(screen.getByTestId("menu-details"));
      expect((await screen.findByTestId("batch-sheet")).textContent).toContain("Harbor");
    });

    it("opens the batch's panel from the pointer, and a draft's pointer opens its approval instead", async () => {
      trio();
      const open = vi.fn();
      renderWithData(<Held onChange={open} />);

      await openMenu("Harbor");
      await userEvent.click(screen.getByTestId("menu-promote"));
      expect(open).toHaveBeenCalledExactlyOnceWith(HARBOR);
      expect((await screen.findByTestId("batch-sheet")).textContent).toContain("Harbor");
      await userEvent.click(within(screen.getByTestId("batch-sheet")).getByRole("button", { name: "Close the batch" }));
      await waitFor(() => expect(screen.queryByTestId("batch-sheet")).toBeNull());
      open.mockClear();

      await openMenu("Suburbs");
      await userEvent.click(screen.getByTestId("menu-approve"));
      expect(await screen.findByTestId("approve-dialog")).not.toBeNull();
      expect(open).not.toHaveBeenCalled();
      expect(screen.queryByTestId("batch-sheet")).toBeNull();
    });

    it("opens the auto-label dialog over that one batch, from Auto-label", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [
          batchOf({
            id: "live",
            name: "drive-01",
            state: "in_annotation",
            progress: progressOf({ total: 10, unannotated: 10 }),
            allowed_actions: batchActions("in_annotation", { settled: false }),
          }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await openMenu("drive-01");
      expect(screen.getByTestId("menu-prelabel").textContent).toBe("Auto-label");
      await userEvent.click(screen.getByTestId("menu-prelabel"));
      expect(await screen.findByText("Auto-label drive-01")).not.toBeNull();
    });
  });

  describe("from the keyboard", () => {
    it("moves focus between the rows' buttons with J and K, and with the arrow keys", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await screen.findByTestId("overview-batches");
      rowButton(SUBURBS).focus();

      await userEvent.keyboard("j");
      expect(document.activeElement).toBe(rowButton(HARBOR));
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(rowButton(DOWNTOWN));
      // The last row is a wall, not a wrap.
      await userEvent.keyboard("j");
      expect(document.activeElement).toBe(rowButton(DOWNTOWN));
      await userEvent.keyboard("k");
      expect(document.activeElement).toBe(rowButton(HARBOR));
      await userEvent.keyboard("{ArrowUp}");
      expect(document.activeElement).toBe(rowButton(SUBURBS));
      // Moving is not opening: the sheet waits for Enter.
      expect(screen.queryByTestId("batch-sheet")).toBeNull();
    });

    it("opens the focused batch's sheet with Enter", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await screen.findByTestId("overview-batches");
      rowButton(SUBURBS).focus();
      await userEvent.keyboard("j{Enter}");
      expect((await screen.findByTestId("batch-sheet")).textContent).toContain("Harbor");
    });

    it("leaves the arrows to a row's own menu", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await screen.findByTestId("overview-batches");
      screen.getByTestId("batch-menu-Suburbs").focus();
      await userEvent.keyboard("j");
      expect(document.activeElement).toBe(screen.getByTestId("batch-menu-Suburbs"));
    });

    it("focuses the filter on / from anywhere on the page", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await screen.findByTestId("overview-batches");
      await userEvent.keyboard("/");
      expect(document.activeElement).toBe(screen.getByTestId("batches-filter"));
    });

    it("types a slash into the filter rather than stealing it back", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("batches-filter"));
      await userEvent.keyboard("a/b");
      expect((screen.getByTestId("batches-filter") as HTMLInputElement).value).toBe("a/b");
    });

    it("leaves / alone while a dialog is open", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);
      await screen.findByTestId("overview-batches");

      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.append(dialog);
      try {
        await userEvent.keyboard("/");
        expect(document.activeElement).not.toBe(screen.getByTestId("batches-filter"));
      } finally {
        dialog.remove();
      }
    });
  });

  describe("narrowed by view and by name", () => {
    it("filters by name, says how many of the whole are shown, and says when none match", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const filter = await screen.findByTestId("batches-filter");
      await userEvent.type(filter, "ar");
      const panel = screen.getByTestId("overview-batches");
      expect(panel.querySelectorAll("tbody tr")).toHaveLength(1);
      expect(screen.getByTestId("overview-batch-Harbor")).toBeTruthy();
      expect(panel.textContent).toContain("1 of 3");

      await userEvent.clear(filter);
      await userEvent.type(filter, "zzz");
      expect(panel.textContent).toContain("No batch matches “zzz”.");
    });

    it("switches the view between all, open, and in the dataset", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const rows = async (): Promise<(string | null)[]> => rowOrder(await screen.findByTestId("overview-batches"));
      expect(await rows()).toHaveLength(3);

      await userEvent.click(within(screen.getByTestId("batches-lens")).getByRole("radio", { name: "In dataset" }));
      expect(await rows()).toEqual(["overview-batch-Downtown"]);

      await userEvent.click(within(screen.getByTestId("batches-lens")).getByRole("radio", { name: "Open" }));
      expect(await rows()).toEqual(["overview-batch-Suburbs", "overview-batch-Harbor"]);
    });
  });

  describe("paged ten to a page", () => {
    /** Twenty-five drafts, `b-01` to `b-25`: three pages, the last holding five. */
    function many(): void {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: Array.from({ length: 25 }, (_, index) => {
          const n = String(index + 1).padStart(2, "0");
          return batchOf({ id: `id-${n}`, name: `b-${n}`, state: "draft", allowed_actions: batchActions("draft") });
        }),
      });
    }
    const names = (panel: HTMLElement): (string | undefined)[] => rowOrder(panel).map((id) => id?.replace("overview-batch-", ""));

    it("shows the first ten, pages from the always-visible footer, and starts over when the filter narrows", async () => {
      many();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      const panel = await screen.findByTestId("overview-batches");
      expect(names(panel)).toHaveLength(10);
      expect(names(panel)[0]).toBe("b-01");
      // The footer closes the table: the count, rows per page and the steps. No pager in the band.
      const footer = screen.getByTestId("table-footer");
      expect(within(panel).getByTestId("table-footer")).toBe(footer);
      expect(screen.queryByTestId("inline-pager")).toBeNull();
      expect(within(footer).getByTestId("table-pager-range").textContent).toBe("1–10 of 25 batches");
      expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 3");
      expect(within(footer).getByTestId("table-pager-size").textContent).toBe("10");
      expect(screen.getByTestId("table-pager-prev").getAttribute("aria-disabled")).toBe("true");

      await userEvent.click(screen.getByTestId("table-pager-next"));
      expect(names(panel)[0]).toBe("b-11");
      await userEvent.click(screen.getByTestId("table-pager-next"));
      expect(names(panel)).toEqual(["b-21", "b-22", "b-23", "b-24", "b-25"]);
      expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 3 of 3");
      expect(screen.getByTestId("table-pager-next").getAttribute("aria-disabled")).toBe("true");

      // A filter starts over at the first page; six matches fit on it, and the footer stays to count them.
      await userEvent.type(screen.getByTestId("batches-filter"), "b-2");
      expect(names(panel)).toEqual(["b-20", "b-21", "b-22", "b-23", "b-24", "b-25"]);
      expect(screen.getByTestId("table-footer")).not.toBeNull();
      expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 1");
      expect(screen.getByTestId("table-pager-range").textContent).toContain("filtered from 25");
      expect(screen.getByTestId("batches-count").textContent).toBe("6 of 25");
    });

    it("starts over at the first page when the lens changes", async () => {
      many();
      renderWithData(<OverviewPanel projectId={PROJECT} />);
      await screen.findByTestId("overview-batches");

      await userEvent.click(screen.getByTestId("table-pager-next"));
      expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 2 of 3");
      await userEvent.click(within(screen.getByTestId("batches-lens")).getByRole("radio", { name: "Open" }));
      expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 3");
    });

    it("walks the rows of a page with the arrow keys and stops at its last row", async () => {
      many();
      renderWithData(<OverviewPanel projectId={PROJECT} />);
      await screen.findByTestId("overview-batches");

      rowButton("id-09").focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(rowButton("id-10"));
      // The eleventh is the next page's: the pager goes there, the keys do not.
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(rowButton("id-10"));
      await userEvent.keyboard("{ArrowUp}");
      expect(document.activeElement).toBe(rowButton("id-09"));
    });

    it("shows the page of a batch the host opens", async () => {
      many();
      renderWithData(<Held initial="id-12" />);

      // Named from outside the table: its page is the one shown.
      expect((await screen.findByTestId("batch-sheet")).textContent).toContain("b-12");
      expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 2 of 3");
      expect(screen.getByTestId("overview-batch-b-12").getAttribute("data-open")).toBe("");

      // The pager is under the scrim while the sheet is open. Once it is put away, paging is the
      // table's again, and closing does not bring the opened batch's page back.
      await userEvent.click(within(screen.getByTestId("batch-sheet")).getByTestId("batch-close"));
      await waitFor(() => expect(screen.queryByTestId("batch-sheet")).toBeNull());
      await userEvent.click(screen.getByTestId("table-pager-next"));
      expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 3 of 3");
    });

    it("brings in the page of the batch the panel steps to across a page's edge", async () => {
      many();
      renderWithData(<Held initial="id-10" />);

      const sheet = await screen.findByTestId("batch-sheet");
      expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 3");
      // The panel walks every batch the table's lens leaves, not only the page's.
      await userEvent.click(within(sheet).getByRole("button", { name: "Next batch (J)" }));
      expect(sheet.textContent).toContain("b-11");
      expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 2 of 3");
      await userEvent.click(within(sheet).getByRole("button", { name: "Previous batch (K)" }));
      expect(screen.getByTestId("table-pager-page").textContent).toBe("Page 1 of 3");
    });
  });

  it("names a correction for the batch it corrects, and a running pre-label as drafting", async () => {
    readinessOf({
      stats: statsOf({ asset_count: 48 }),
      batches: [
        batchOf({
          id: "c",
          name: "Highway",
          state: "in_annotation",
          parent_batch_id: "p",
          pre_label_run: {
            annotation_job_id: "aj",
            annotations_replaced: null,
            assets_labeled: null,
            assets_processed: 3,
            assets_total: 10,
            error: null,
            error_code: null,
            job_id: "pj",
            regions_discarded: null,
            regions_out_of_bounds: null,
            state: "running",
            stopped_early: null,
          },
          progress: progressOf({ total: 10, unannotated: 10 }),
        }),
      ],
    });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const row = await screen.findByTestId("overview-batch-Highway — correction");
    expect(row.textContent).toContain("Drafting 3/10");
    await userEvent.click(row);
    const sheet = await screen.findByTestId("batch-sheet");
    expect(sheet.textContent).toContain("Highway — correction");
    expect((await within(sheet).findByTestId("batch-sheet-prelabel")).textContent).toContain("3/10");
  });

  it("says there are no batches in words, and leaves Add images to the toolbar", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [] });
    renderWithData(<OverviewPanel projectId={PROJECT} onIngest={vi.fn()} />);

    const none = await screen.findByTestId("batches-none");
    expect(none.textContent).toContain("No batches yet. Adding images creates the first one");
    expect(screen.queryByTestId("batches-filter")).toBeNull();
    // Add images lives in the project toolbar alone, so the empty panel draws none.
    expect(none.querySelector("button")).toBeNull();
  });
});

// --- the batches panel's tool row ------------------------------------------------

describe("auto-label over the batches", () => {
  const RUNNING = {
    annotation_job_id: "aj",
    annotations_replaced: null,
    assets_labeled: null,
    assets_processed: 3,
    assets_total: 40,
    error: null,
    error_code: null,
    job_id: "pj",
    regions_discarded: null,
    regions_out_of_bounds: null,
    state: "running",
    stopped_early: null,
  };

  function live(id: string, name: string, unannotated: number, over: Record<string, unknown> = {}): Record<string, unknown> {
    return batchOf({
      id,
      name,
      state: "in_annotation",
      asset_count: 200,
      progress: progressOf({ total: 200, unannotated, annotated: 200 - unannotated }),
      allowed_actions: batchActions("in_annotation", { settled: unannotated === 0 }),
      ...over,
    });
  }

  /** Two batches that declare the run, one that does not, and one a model is drafting now. */
  function mixed(): Record<string, unknown>[] {
    return [
      live("a", "drive-01", 120),
      live("b", "drive-02", 113),
      batchOf({ id: "d", name: "Draft", state: "draft", progress: progressOf({ total: 50, unannotated: 50 }), allowed_actions: batchActions("draft") }),
      live("r", "drive-03", 40, { pre_label_run: RUNNING }),
    ];
  }

  const line = (): HTMLElement => screen.getByTestId("prelabel-offer");

  async function settled(): Promise<void> {
    await screen.findByTestId("overview-batch-drive-01");
  }

  it("says how many assets nobody has labeled in the batches that declare the run, and offers to do it", async () => {
    readinessOf({ stats: statsOf({ asset_count: 690 }), batches: mixed() });
    renderWithData(<OverviewPanel projectId={PROJECT} />);
    await settled();

    // The draft does not declare pre_label, and drive-03's images are being drafted now.
    expect(line().dataset.state).toBe("open");
    expect(screen.getByTestId("prelabel-offer-text").textContent).toBe("233 assets have no labels yet. A model can draft them for you to check.");
    expect(screen.getByTestId("prelabel-offer-start").textContent).toBe("Auto-label them");
    expect(screen.getByRole("button", { name: "Not now" })).not.toBeNull();
    // The line is the offer while it is there: the band says nothing beside it.
    expect(screen.queryByTestId("project-prelabel")).toBeNull();
    // Between the band and the table.
    const section = screen.getByTestId("overview-batches");
    expect(section.querySelector("header")?.nextElementSibling).toBe(line());
  });

  it("speaks of one asset as one", async () => {
    readinessOf({ stats: statsOf({ asset_count: 200 }), batches: [live("a", "drive-01", 1)] });
    renderWithData(<OverviewPanel projectId={PROJECT} />);
    await settled();

    expect(screen.getByTestId("prelabel-offer-text").textContent).toBe("1 asset has no labels yet. A model can draft it for you to check.");
    expect(screen.getByTestId("prelabel-offer-start").textContent).toBe("Auto-label it");
  });

  it("draws no line when nothing is waiting, and keeps the run one press away in the band", async () => {
    readinessOf({ stats: statsOf({ asset_count: 200 }), batches: [live("a", "drive-01", 0)] });
    renderWithData(<OverviewPanel projectId={PROJECT} />);
    await settled();

    expect(line().dataset.state).toBe("closed");
    expect(line().hasAttribute("inert")).toBe(true);
    const icon = screen.getByTestId("project-prelabel");
    expect(icon.getAttribute("aria-label")).toBe("Auto-label");
  });

  it("draws neither when no batch declares the run", async () => {
    readinessOf({
      stats: statsOf({ asset_count: 50 }),
      batches: [batchOf({ id: "d", name: "drive-01", state: "draft", progress: progressOf({ total: 50, unannotated: 50 }), allowed_actions: batchActions("draft") })],
    });
    renderWithData(<OverviewPanel projectId={PROJECT} />);
    await settled();

    expect(line().dataset.state).toBe("closed");
    expect(screen.queryByTestId("project-prelabel")).toBeNull();
  });

  it("opens the dialog over every batch that declares the run, from the line and from the band", async () => {
    readinessOf({ stats: statsOf({ asset_count: 690 }), batches: mixed() });
    renderWithData(<OverviewPanel projectId={PROJECT} />);
    await settled();

    await userEvent.click(screen.getByTestId("prelabel-offer-start"));
    const dialog = await screen.findByTestId("project-prelabel-dialog");
    expect(within(dialog).getByText("Auto-label batches")).not.toBeNull();
    // Every batch that declares it, the drafting one too: a re-run is still the batch's to ask for.
    expect(within(dialog).getByText("drive-01")).not.toBeNull();
    expect(within(dialog).getByText("drive-03")).not.toBeNull();
    expect(within(dialog).queryByText("Draft")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("project-prelabel-dialog")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await userEvent.click(screen.getByTestId("project-prelabel"));
    expect(within(await screen.findByTestId("project-prelabel-dialog")).getByText("Auto-label batches")).not.toBeNull();
  });

  it("puts the line away on Not now, into the band, and remembers it for the project", async () => {
    readinessOf({ stats: statsOf({ asset_count: 690 }), batches: mixed() });
    const first = renderWithData(<OverviewPanel projectId={PROJECT} />);
    await settled();

    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(line().dataset.state).toBe("closed");
    expect(line().hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("project-prelabel").getAttribute("aria-label")).toBe("Auto-label");
    // Against the count it was put away at.
    expect(readPref(`autolabel.dismissed.${PROJECT}`)).toBe("233");

    // Back on the Overview with the same images waiting: still put away.
    first.unmount();
    renderWithData(<OverviewPanel projectId={PROJECT} />);
    await settled();
    expect(line().dataset.state).toBe("closed");
    expect(screen.getByTestId("project-prelabel")).not.toBeNull();
  });

  it("comes back when more images are waiting than when it was put away", async () => {
    readinessOf({ stats: statsOf({ asset_count: 690 }), batches: mixed() });
    const queryClient = harnessQueryClient();
    renderWithData(<OverviewPanel projectId={PROJECT} />, { queryClient });
    await settled();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(line().dataset.state).toBe("closed");

    // Fewer waiting — some were labeled — keeps it away.
    first("GET", /\/batches$/, { status: 200, body: { items: [live("a", "drive-01", 100), live("b", "drive-02", 113)], total: 2 } });
    await queryClient.invalidateQueries();
    await waitFor(() => expect(screen.getByTestId("project-prelabel")).not.toBeNull());
    expect(line().dataset.state).toBe("closed");

    // A new batch arrives: more are waiting than it was put away at.
    first("GET", /\/batches$/, {
      status: 200,
      body: { items: [live("a", "drive-01", 120), live("b", "drive-02", 113), live("n", "drive-04", 60)], total: 3 },
    });
    await queryClient.invalidateQueries();
    await waitFor(() => expect(line().dataset.state).toBe("open"));
    expect(screen.getByTestId("prelabel-offer-text").textContent).toMatch(/^293 assets/);
    expect(screen.queryByTestId("project-prelabel")).toBeNull();
  });

  it("leaves when a run starts, and the band takes over", async () => {
    readinessOf({ stats: statsOf({ asset_count: 200 }), batches: [live("a", "drive-01", 120)] });
    const queryClient = harnessQueryClient();
    renderWithData(<OverviewPanel projectId={PROJECT} />, { queryClient });
    await settled();
    expect(line().dataset.state).toBe("open");

    first("GET", /\/batches$/, { status: 200, body: { items: [live("a", "drive-01", 120, { pre_label_run: RUNNING })], total: 1 } });
    await queryClient.invalidateQueries();
    await waitFor(() => expect(line().dataset.state).toBe("closed"));
    // It leaves with what it said rather than with a zero.
    expect(screen.getByTestId("prelabel-offer-text").textContent).toMatch(/^120 assets/);
    expect(screen.getByTestId("project-prelabel")).not.toBeNull();
  });

  describe("its motion", () => {
    interface Call {
      readonly element: Element;
      readonly keyframes: Keyframe[];
    }
    let calls: Call[] = [];
    let pending: { resolve: () => void }[] = [];

    /** A stand-in for the Web Animations API, which jsdom lacks: it records, and finishes on request. */
    beforeEach(() => {
      calls = [];
      pending = [];
      Object.defineProperty(Element.prototype, "animate", {
        configurable: true,
        value(this: Element, keyframes: Keyframe[]) {
          calls.push({ element: this, keyframes });
          const settle = { resolve: (): void => {}, reject: (reason: unknown): void => void reason };
          const finished = new Promise<void>((yes, no) => {
            settle.resolve = yes;
            settle.reject = no;
          });
          pending.push(settle);
          return { finished, cancel: () => settle.reject(new DOMException("cancelled", "AbortError")) };
        },
      });
    });

    afterEach(() => {
      delete (Element.prototype as { animate?: unknown }).animate;
    });

    const land = async (): Promise<void> => {
      for (const one of pending) one.resolve();
      await waitFor(() => expect(document.body.querySelector("body > [aria-hidden='true'][inert]")).toBeNull());
    };

    it("is there on load, without arriving", async () => {
      readinessOf({ stats: statsOf({ asset_count: 690 }), batches: mixed() });
      renderWithData(<OverviewPanel projectId={PROJECT} />);
      await settled();

      expect(line().style.gridTemplateRows).toBe("1fr");
      expect(calls).toEqual([]);
    });

    it("turns the line's button into the band's icon on Not now, and closes the line's row", async () => {
      readinessOf({ stats: statsOf({ asset_count: 690 }), batches: mixed() });
      renderWithData(<OverviewPanel projectId={PROJECT} />);
      await settled();
      const start = screen.getByTestId("prelabel-offer-start");

      await userEvent.click(screen.getByRole("button", { name: "Not now" }));

      const icon = screen.getByTestId("project-prelabel");
      // The icon's surface fades in where it lives; it never moves, so a press mid-flight lands on it.
      expect(calls.find((call) => call.element === icon)?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
      // The wand flies on its own, from the line's button onto the icon's, which waits hidden for it.
      const wand = document.body.querySelector<SVGElement>("body > svg[inert]");
      const flight = calls.filter((call) => call.element === wand).flatMap((call) => call.keyframes);
      expect(flight.at(-1)?.transform).toMatch(/^translate\(.*\) scale\(/);
      const landing = icon.querySelector<SVGElement>("svg");
      expect(landing?.style.visibility).toBe("hidden");
      // The line's button shrinks into the icon as a copy, its words going first; the real one waits, hidden.
      const surface = document.body.querySelector<HTMLElement>("body > button[aria-hidden='true'][inert]");
      expect(surface?.textContent).toBe("Auto-label them");
      expect(surface?.dataset.testid).toBeUndefined();
      expect(calls.filter((call) => call.element === surface).length).toBeGreaterThan(0);
      expect(start.style.visibility).toBe("hidden");
      // Meanwhile the line's row closes.
      expect(line().style.gridTemplateRows).toBe("0fr");

      await land();
      expect(start.style.visibility).toBe("");
      expect(landing?.style.visibility).toBe("");
    });

    it("hands focus to the band's icon once it lands, when Not now was pressed from the keyboard", async () => {
      readinessOf({ stats: statsOf({ asset_count: 690 }), batches: mixed() });
      renderWithData(<OverviewPanel projectId={PROJECT} />);
      await settled();

      screen.getByRole("button", { name: "Not now" }).focus();
      await userEvent.keyboard("{Enter}");
      const icon = screen.getByTestId("project-prelabel");
      await land();
      await waitFor(() => expect(document.activeElement).toBe(icon));
    });

    it("only fades under reduced motion: nothing flies and nothing rises", async () => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("reduce"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      readinessOf({ stats: statsOf({ asset_count: 690 }), batches: mixed() });
      renderWithData(<OverviewPanel projectId={PROJECT} />);
      await settled();

      await userEvent.click(screen.getByRole("button", { name: "Not now" }));

      const icon = screen.getByTestId("project-prelabel");
      expect(calls.map((call) => call.element)).toEqual([icon]);
      expect(calls[0]?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
      expect(document.body.querySelector("body > [aria-hidden='true'][inert]")).toBeNull();
      const words = line().querySelector<HTMLElement>("[role=note]");
      expect(words?.style.transform).toBe("none");
      expect(words?.style.opacity).toBe("0");
    });

    it("stops flying when the Overview goes", async () => {
      readinessOf({ stats: statsOf({ asset_count: 690 }), batches: mixed() });
      const view = renderWithData(<OverviewPanel projectId={PROJECT} />);
      await settled();

      await userEvent.click(screen.getByRole("button", { name: "Not now" }));
      expect(document.body.querySelector("body > [aria-hidden='true'][inert]")).not.toBeNull();
      view.unmount();
      await waitFor(() => expect(document.body.querySelector("body > [aria-hidden='true'][inert]")).toBeNull());
    });
  });
});

describe("the batches panel's tool row", () => {
  const OPEN = "b-open";
  const DRAFT = "b-draft";

  function open(): Record<string, unknown> {
    return batchOf({ id: OPEN, name: "Open", state: "in_annotation", allowed_actions: batchActions("in_annotation", { settled: true }) });
  }

  function draft(): Record<string, unknown> {
    return batchOf({ id: DRAFT, name: "Draft", state: "draft", allowed_actions: batchActions("draft") });
  }

  /** The tool row's own controls, in document order, as their test ids. */
  async function toolIds(): Promise<(string | null)[]> {
    const panel = await screen.findByTestId("overview-batches");
    return [...panel.querySelectorAll("[data-testid]")]
      .map((node) => node.getAttribute("data-testid"))
      .filter((id) => id === "go-ingest" || id === "project-prelabel" || id === "batches-lens" || id === "batches-filter");
  }

  it("offers Auto-label, then the view switch and filter, then Add images last", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [open()] });
    renderWithData(<OverviewPanel projectId={PROJECT} onIngest={vi.fn()} />);

    await waitFor(async () => expect(await toolIds()).toEqual(["project-prelabel", "batches-lens", "batches-filter", "go-ingest"]));
    expect(within(screen.getByTestId("overview-batches")).getByTestId("go-ingest").dataset.variant).toBe("ghost");
  });

  it("draws no Add images in the band without an ingest to go to", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [open()] });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-batches");
    expect(screen.queryByTestId("go-ingest")).toBeNull();
  });

  it("draws no view tools until there is a batch, but still offers Add images", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [] });
    renderWithData(<OverviewPanel projectId={PROJECT} onIngest={vi.fn()} />);

    await screen.findByTestId("batches-none");
    expect(screen.queryByTestId("batches-lens")).toBeNull();
    expect(screen.queryByTestId("batches-filter")).toBeNull();
    expect(screen.queryByTestId("project-prelabel")).toBeNull();
    expect(within(screen.getByTestId("overview-batches")).getByTestId("go-ingest")).toBeTruthy();
  });

  it("offers the project-wide Auto-label when a batch declares it", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [open()] });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const button = await screen.findByTestId("project-prelabel");
    expect(within(screen.getByTestId("overview-batches")).getByTestId("project-prelabel")).toBe(button);
  });

  it("offers no Auto-label when no batch declares it", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [draft()] });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-batches");
    expect(screen.queryByTestId("project-prelabel")).toBeNull();
  });

  it("shows a batch's pinned schema version once it has one, and none before", async () => {
    readinessOf({
      stats: statsOf({ asset_count: 48 }),
      batches: [{ ...draft(), schema_version: null }, { ...open(), schema_version: 3 }],
    });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const approved = await screen.findByTestId("overview-batch-Open");
    expect(approved.textContent).toContain("schema v3");
    expect(screen.getByTestId("overview-batch-Draft").textContent).not.toContain("schema v");
  });
});

describe("the Overview's work row", () => {
  it("puts the batches beside the images' rail in one four-column work row, the batches taking three", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const batches = await screen.findByTestId("overview-batches");
    const images = await screen.findByTestId("overview-images");

    const panel = screen.getByTestId("overview-panel");
    expect(panel.classList.contains("flex")).toBe(true);
    expect(panel.classList.contains("flex-col")).toBe(true);
    expect(panel.classList.contains("gap-px")).toBe(true);
    // The KPI sheet first, then the work row.
    expect(panel.children[0]).toBe(screen.getByTestId("overview-stats"));

    const row = batches.parentElement;
    expect(row).toBe(panel.children[1]);
    expect(row?.classList.contains("xl:grid-cols-4")).toBe(true);
    expect(batches.classList.contains("xl:col-span-3")).toBe(true);

    // Batches, then the rail, which holds the images and no class panel: the
    // classes live in the last KPI cell, over the rail's column.
    expect(row?.children[0]).toBe(batches);
    const rail = row?.children[1];
    expect(rail?.children).toHaveLength(1);
    expect(rail?.children[0]).toBe(images);
    expect(screen.queryByTestId("overview-distribution")).toBeNull();
  });

  it("heads the batch column with the field it shows: Name", async () => {
    readinessOf({ stats: statsOf(), batches: [batchOf({ id: "a", name: "drive-01", state: "draft" })] });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-batch-drive-01");
    const batches = screen.getByTestId("overview-batches");
    const headers = [...batches.querySelectorAll("thead th")].map((h) => h.textContent?.trim());
    expect(headers[0]).toBe("Name");
    expect(headers).not.toContain("Batch");
  });

  it("draws no releases panel: the dataset card and its pointer are where releases are reached", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-batches");
    expect(screen.queryByTestId("overview-releases")).toBeNull();
  });
});

describe("classRows", () => {
  const declared = (...names: string[]): LabelClassBody[] =>
    names.map((name) => ({ name, geometries: ["bbox"], color: null, attributes: [] }));
  const count = (label_class: string, annotations: number, assets: number) => ({ label_class, annotations, assets });

  it("ranks by annotations, largest first", () => {
    const rows = classRows({ classes: [count("b", 10, 5), count("a", 30, 9), count("c", 20, 7)] }, declared("a", "b", "c"));
    expect(rows.map((row) => row.name)).toEqual(["a", "c", "b"]);
    expect(rows.map((row) => row.images)).toEqual([9, 7, 5]);
  });

  it("keeps a declared class nobody has drawn, at zero, after every counted one", () => {
    const rows = classRows({ classes: [count("a", 4, 2)] }, declared("unused", "a"));
    expect(rows.map((row) => [row.name, row.annotations, row.images, row.thin])).toEqual([
      ["a", 4, 2, false],
      ["unused", 0, 0, false],
    ]);
  });

  it("keeps a counted class the schema no longer declares, rather than hiding annotations that exist", () => {
    const rows = classRows({ classes: [count("old", 8, 3), count("a", 2, 1)] }, declared("a"));
    expect(rows.map((row) => row.name)).toEqual(["old", "a"]);
  });

  it("lists the counted classes alone when the project has no schema", () => {
    const rows = classRows({ classes: [count("a", 2, 1)] }, undefined);
    expect(rows.map((row) => row.name)).toEqual(["a"]);
    expect(classRows({ classes: [] }, undefined)).toEqual([]);
  });

  it("names each row's colour from the schema when it declared one", () => {
    const [row] = classRows({ classes: [count("a", 2, 1)] }, [
      { name: "a", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
    ]);
    expect(row?.color).toBe("#38bdf8");
  });

  it("marks a class thin only under the threshold, among at least the minimum number of classes", () => {
    const rows = classRows(
      { classes: [count("a", 45, 1), count("b", 45, 1), count("c", 10, 1), count("d", 9, 1)] },
      undefined,
    );
    // 9 of 109 is under a tenth; 10 of 109 is under it too, since the total grew.
    expect(rows.find((row) => row.name === "d")?.thin).toBe(true);
    expect(rows.find((row) => row.name === "c")?.thin).toBe(true);
    expect(rows.find((row) => row.name === "a")?.thin).toBe(false);

    // Exactly the threshold is not thin: the same boundary `imbalanceNote` keeps.
    const edge = classRows({ classes: [count("a", 45, 1), count("b", 45, 1), count("c", 10, 1)] }, undefined);
    expect(10 / 100).toBe(IMBALANCE_SHARE);
    expect(edge.find((row) => row.name === "c")?.thin).toBe(false);
  });

  it("judges nobody thin below the minimum number of classes, or when nothing is annotated", () => {
    const two = classRows({ classes: [count("a", 99, 1), count("b", 1, 1)] }, undefined);
    expect(two.every((row) => !row.thin)).toBe(true);
    expect(IMBALANCE_MIN_CLASSES).toBe(3);

    const none = classRows({ classes: [count("a", 0, 0), count("b", 0, 0), count("c", 0, 0)] }, undefined);
    expect(none.every((row) => !row.thin)).toBe(true);
  });
});

// --- the batches' rows ----------------------------------------------------------------

describe("batchRows", () => {
  const ZERO = { total: 0, unannotated: 0, pre_labeled: 0, annotated: 0, review_pending: 0, accepted: 0, skipped: 0 };
  function batch(over: Partial<Batch>): Batch {
    return {
      id: "b",
      name: "Batch",
      project_id: PROJECT,
      state: "in_annotation",
      asset_count: 10,
      modalities: ["image"],
      promoted_asset_count: 0,
      schema_version: 1,
      parent_batch_id: null,
      pre_label_run: null,
      progress: ZERO,
      allowed_actions: [],
      ...over,
    };
  }
  function job(id: string, batchId: string, assignee: string | null): Job {
    return { id, batch_id: batchId, asset_count: 5, assignee, state: "pending", allowed_actions: [], pre_label_run: null };
  }

  it("orders live work first, then what waits, then what is done", () => {
    const rows = batchRows(
      [
        batch({ id: "in", state: "completed", asset_count: 2, promoted_asset_count: 2 }),
        batch({ id: "done", state: "completed", asset_count: 2, promoted_asset_count: 1 }),
        batch({ id: "draft", state: "draft" }),
        batch({ id: "ok", state: "approved" }),
        batch({ id: "live", state: "in_annotation" }),
      ],
      undefined,
    );
    expect(rows.map((row) => row.id)).toEqual(["live", "ok", "draft", "done", "in"]);
    expect(rows.map((row) => row.phase)).toEqual(["annotating", "approved", "draft", "completed", "in_dataset"]);
  });

  it("carries what each batch holds, off the wire", () => {
    const rows = batchRows(
      [batch({ id: "scan", state: "draft", modalities: ["point_cloud"] }), batch({ id: "both", state: "draft", modalities: ["image", "point_cloud"] }), batch({ id: "empty", state: "draft", modalities: [] })],
      undefined,
    );
    expect(rows.map((row) => row.modalities)).toEqual([["point_cloud"], ["image", "point_cloud"], []]);
  });

  it("keeps the wire's order within a phase", () => {
    const rows = batchRows([batch({ id: "b2", state: "draft" }), batch({ id: "b1", state: "draft" })], undefined);
    expect(rows.map((row) => row.id)).toEqual(["b2", "b1"]);
  });

  it("gives a draft no labeled count rather than reading its documented zeros as none", () => {
    const rows = batchRows(
      [
        batch({ id: "draft", state: "draft", asset_count: 30 }),
        batch({ id: "live", state: "in_annotation", progress: { ...ZERO, total: 10, annotated: 4, accepted: 2, unannotated: 4 } }),
      ],
      undefined,
    );
    expect(rows.find((row) => row.id === "draft")).toMatchObject({ done: null, total: 30 });
    expect(rows.find((row) => row.id === "live")?.done).toBe(6);
  });

  it("never says correction twice when the name already does", () => {
    const [row] = batchRows([batch({ name: "Highway — correction", parent_batch_id: "x" })], undefined);
    expect(row?.name).toBe("Highway — correction");
  });

  it("names a correction for the batch it corrects, and carries the pinned schema version", () => {
    const [row] = batchRows([batch({ name: "Highway", parent_batch_id: "x", schema_version: 4 })], undefined);
    expect(row?.name).toBe("Highway — correction");
    expect(row?.schemaVersion).toBe(4);
    expect(batchRows([batch({ schema_version: null })], undefined)[0]?.schemaVersion).toBeNull();
  });

  it("shows a pre-label run while it works, never after", () => {
    const run = (state: "queued" | "running" | "succeeded" | "failed" | "cancelled"): Batch["pre_label_run"] => ({
      annotation_job_id: "aj",
      annotations_replaced: null,
      assets_labeled: null,
      assets_processed: 3,
      assets_total: 10,
      error: null,
      error_code: null,
      job_id: "pj",
      regions_discarded: null,
      regions_out_of_bounds: null,
      state,
      stopped_early: null,
    });
    for (const state of ["queued", "running"] as const) {
      expect(batchRows([batch({ pre_label_run: run(state) })], undefined)[0]?.prelabel).toEqual({ processed: 3, total: 10 });
    }
    for (const state of ["succeeded", "failed", "cancelled"] as const) {
      expect(batchRows([batch({ pre_label_run: run(state) })], undefined)[0]?.prelabel).toBeNull();
    }
    expect(batchRows([batch({ pre_label_run: null })], undefined)[0]?.prelabel).toBeNull();
  });

  describe("assignees", () => {
    const ready = (jobs: readonly Job[]): BatchJobsRead => ({ status: "ready", jobs });

    it("reads who holds a batch's jobs, in job order, with an unassigned job as null", () => {
      const jobsOf = new Map([["live", ready([job("j1", "live", "Dana"), job("j2", "live", null)])]]);
      const [row] = batchRows([batch({ id: "live", state: "in_annotation" })], jobsOf);
      expect(row?.assignees).toEqual(["Dana", null]);
    });

    it("is empty for a batch that has been cut into jobs but has none listed", () => {
      const [row] = batchRows([batch({ id: "ok", state: "approved" })], new Map([["ok", ready([])]]));
      expect(row?.assignees).toEqual([]);
    });

    it("waits on each batch's own read, never on its neighbours'", () => {
      const jobsOf = new Map<string, BatchJobsRead>([
        ["live", ready([job("j1", "live", "Dana")])],
        ["slow", { status: "pending" }],
      ]);
      const rows = batchRows([batch({ id: "live" }), batch({ id: "slow" })], jobsOf);
      expect(rows.find((row) => row.id === "live")?.assignees).toEqual(["Dana"]);
      expect(rows.find((row) => row.id === "slow")?.assignees).toBeUndefined();
    });

    it("says a refused read in that row only", () => {
      const refused = new Error("jobs unreadable");
      const jobsOf = new Map<string, BatchJobsRead>([
        ["live", ready([job("j1", "live", "Dana")])],
        ["broken", { status: "error", error: refused, retry: vi.fn() }],
      ]);
      const rows = batchRows([batch({ id: "live" }), batch({ id: "broken" })], jobsOf);
      expect(rows.find((row) => row.id === "broken")).toMatchObject({ assignees: undefined, jobsError: expect.any(String) });
      expect(rows.find((row) => row.id === "live")?.jobsError).toBeUndefined();
    });

    it("is null for a draft, which has no jobs to hold, whatever the map says", () => {
      const jobsOf = new Map([["draft", ready([job("j1", "draft", "Dana")])]]);
      expect(batchRows([batch({ id: "draft", state: "draft" })], jobsOf)[0]?.assignees).toBeNull();
    });

    it("is undefined while the jobs are being read, and still null for a draft", () => {
      const rows = batchRows([batch({ id: "live", state: "in_annotation" }), batch({ id: "draft", state: "draft" })], undefined);
      expect(rows.find((row) => row.id === "live")?.assignees).toBeUndefined();
      expect(rows.find((row) => row.id === "draft")?.assignees).toBeNull();
    });
  });
});

/**
 * The panel's rows: how many cells each lays out, and the column split it
 * declares at the width the row first goes side by side.
 */
function rowsOf(root: HTMLElement): { cells: number; split: string | null }[] {
  return [...root.children]
    .filter((child) => !child.classList.contains("sr-only"))
    .map((child) => ({
      cells: child.classList.contains("grid") ? child.children.length : 0,
      split: [...child.classList].find((one) => /^(lg|xl):grid-cols-/.test(one)) ?? null,
    }));
}

function jobOf(id: string, batchId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    batch_id: batchId,
    asset_count: 5,
    assignee: null,
    state: "pending",
    allowed_actions: [],
    pre_label_run: null,
    ...over,
  };
}

function progressOf(over: Record<string, number> = {}): Record<string, number> {
  return { total: 0, unannotated: 0, pre_labeled: 0, annotated: 0, review_pending: 0, accepted: 0, skipped: 0, ...over };
}

function batchOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "batch",
    name: "Batch",
    project_id: PROJECT,
    state: "in_annotation",
    asset_count: 10,
    modalities: ["image"],
    promoted_asset_count: 0,
    schema_version: 1,
    parent_batch_id: null,
    pre_label_run: null,
    progress: progressOf(),
    allowed_actions: [],
    ...over,
  };
}
