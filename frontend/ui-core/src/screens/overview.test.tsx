/**
 * The Overview panel, and the heuristic under it.
 *
 * Two halves, tested differently on purpose. `imbalanceNote` is a pure function
 * and is exercised at its boundaries directly — it is a stated placeholder, so
 * the thing worth pinning is exactly where it fires and where it stays quiet.
 * The panel is tested for its four states, the fourth being the one that would
 * be got wrong: assets but no annotations is *not* empty. Around them: the four
 * cards as doors and their one pointer each, the batches table and its sheet,
 * and the class rail.
 */

import { TooltipProvider } from "@robomous/ui-core";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMBALANCE_MIN_CLASSES, IMBALANCE_SHARE, imbalanceNote } from "./imbalance";
import {
  batchRows,
  classRows,
  firstRunInvitation,
  invitationOwnsTheAction,
  OverviewPanel,
} from "./OverviewPanel";
import type { Batch, BatchJobsRead, Job, LabelClassBody } from "./queries";
import { CLASS_RAIL_ROWS, ClassRail, type ClassRow } from "../patterns/project/ClassRail";
import { KPI_CARD_HEIGHT, KPI_GRID } from "../patterns/project/KpiCards";
import { renderWithData } from "../testing/dataHarness";
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
    // three bars each; the rail is a blank cell until the classes arrive.
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
    // The third card counts classes, and says how many annotations they carry
    // and which schema they were declared in.
    const classes = screen.getByTestId("kpi-annotations");
    expect(classes.textContent).toContain("Classes");
    expect(within(classes).getByText("3")).not.toBeNull();
    await waitFor(() => expect(classes.textContent).toContain(`${(6431).toLocaleString(undefined)} annotations · schema v1`));
  });

  it("says a project without a schema has none yet, rather than inventing a version", async () => {
    readinessOf({ schema: false, stats: statsOf({ asset_count: 48 }) });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-stats");
    expect(screen.getByTestId("kpi-annotations").textContent).toContain("no schema yet");
  });

  it("ranks the distribution by count, largest first", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const rows = (await screen.findByTestId("overview-distribution")).textContent ?? "";
    expect(rows.indexOf("dog")).toBeLessThan(rows.indexOf("person"));
    expect(rows.indexOf("person")).toBeLessThan(rows.indexOf("bicycle"));
  });

  it("says the imbalance note from the band's thin badge when the distribution earns one", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    // The note is not inline: it is said from the band's "N thin" badge.
    await userEvent.hover(await screen.findByTestId("classes-thin"));
    expect((await screen.findByTestId("imbalance-note")).textContent).toContain("bicycle");
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

    await screen.findByTestId("overview-distribution");
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
    await waitFor(() => expect(screen.getByTestId("kpi-annotated").textContent).toContain("0 of 40 images"));
    expect(screen.getByTestId("kpi-annotated").textContent).toContain("0%");
    // The class rail says so in words, rather than drawing an empty list.
    expect(screen.getByTestId("overview-distribution").textContent).toContain("No classes yet");
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
      await waitFor(() => expect(kpi("annotated").textContent).toContain("10 of 10 images"));
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
        { name: "nothing promoted", trunk: 0, releases: [], says: "Nothing promoted yet" },
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

  it("hands the filled button to the invitation only where the header has none to lose", () => {
    // Both ingest invitations are the exception: the header's Add images is the same
    // label and the same handler, so the filled one stays up there.
    expect(invitationOwnsTheAction("classes-after-ingest")).toBe(true);
    expect(invitationOwnsTheAction("ingest-first")).toBe(false);
    expect(invitationOwnsTheAction("ingest")).toBe(false);
    expect(invitationOwnsTheAction(null)).toBe(false);
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
    // Zero filled buttons *here*: the page's one is the header's Add images, which
    // this panel does not render, and the classes CTA is gone — three voices
    // became one.
    expect(filledButtons()).toHaveLength(0);
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
    expect(filledButtons()).toHaveLength(0);

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
    // Zero filled buttons *here*, because the page's one lives in the header
    // this panel does not render. `ProjectScreen`'s own tests carry the
    // other half of that claim.
    expect(filledButtons()).toHaveLength(0);
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
    expect(region.textContent).toContain("48 images are in");
    // The gate is stated, not re-derived — approval is what pins a version.
    expect(region.textContent).toContain("first approved batch");
    expect(filledButtons()).toEqual([screen.getByTestId("first-run-cta")]);
  });

  it("says one image rather than 1 images", async () => {
    readinessOf({ schema: false, stats: statsOf({ asset_count: 1 }) });
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} />);

    expect((await screen.findByTestId("first-run")).textContent).toContain("1 image is in");
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
    await userEvent.click(screen.getByRole("button", { name: "Images, 48. Open Images" }));
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
    expect(within(strip).queryByRole("button")).toBeNull();
  });

  it("labels its four cards by what they count", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const strip = await screen.findByTestId("overview-stats");
    const labels = [...strip.children].map((cell) => cell.querySelector("h3")?.textContent);
    expect(labels).toEqual(["Images", "Labeled", "Classes", "In dataset"]);
    expect([...strip.children].map((cell) => cell.getAttribute("data-testid"))).toEqual([
      "kpi-images",
      "kpi-annotated",
      "kpi-annotations",
      "kpi-dataset",
    ]);
  });

  it("says a section is empty in words rather than showing a zero", async () => {
    // A documented "no answer" rendered as data reads as a broken screen.
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [] });

    renderWithData(<OverviewPanel projectId={PROJECT} />);

    // `findByText`, not `findByTestId` then read: the card renders immediately
    // with an em dash while its query is in flight.
    await screen.findByText("Nothing promoted yet");
    expect(screen.getByTestId("kpi-annotated").textContent).toContain("0 of 48 images");
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
    await waitFor(() => expect(screen.getByTestId("kpi-dataset").textContent).toMatch(/Nothing promoted yet|No releases yet|since|all in/));
  }

  describe("Review draft", () => {
    it("opens the draft's gallery from the images card's badge, labelled from the batch declaring approve", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [draftOf("d1")] });
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} />);

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
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} />);

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
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} />);

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
          batchOf({ id: "live", name: "live", state: "in_annotation", allowed_actions: batchActions("in_annotation") }),
          batchOf({ id: "ok", name: "ok", state: "approved", allowed_actions: batchActions("approved") }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

      await settled();
      expect(screen.queryByTestId("kpi-attention-images")).toBeNull();
      // The approved batch does declare start, so that card — and only that card — has its own badge.
      expect(screen.getByTestId("kpi-attention-labeled").textContent).toBe("1 to start");
    });

    it("is absent where the host cannot open a batch", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [draftOf("d1")] });
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await settled();
      expect(screen.queryByTestId("kpi-attention-images")).toBeNull();
    });
  });

  describe("Review and promote", () => {
    it("lists every finished batch that declares promote behind the dataset card's badge, each opening its own batch", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [finishedOf("first"), finishedOf("second")] });
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} />);

      const badge = await screen.findByTestId("kpi-attention-dataset");
      expect(badge.textContent).toBe("2 to promote");
      expect(within(screen.getByTestId("kpi-dataset")).getByTestId("kpi-attention-dataset")).toBe(badge);
      await userEvent.click(badge);

      const first = await screen.findByTestId("kpi-step-promote-first");
      expect(first.textContent).toContain("Review and promote");
      expect(screen.getByTestId("kpi-step-promote-second")).not.toBeNull();
      await userEvent.click(first);
      expect(open).toHaveBeenCalledExactlyOnceWith("first");
      // Nothing was promoted from here: it is a way into the gallery.
      expect(sent.filter((request) => request.method !== "GET")).toEqual([]);
    });

    it("is absent once every image is in the dataset, though promote stays declared", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [finishedOf("all-in", { promoted_asset_count: 10 })] });
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

      await settled();
      expect(screen.queryByTestId("kpi-attention-dataset")).toBeNull();
    });

    it("is absent for a finished batch that does not declare it, and without a way to open a batch", async () => {
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [finishedOf("bare", { allowed_actions: [] })] });
      const { unmount } = renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);
      await settled();
      expect(screen.queryByTestId("kpi-attention-dataset")).toBeNull();
      unmount();

      handlers = [];
      readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [finishedOf("waiting")] });
      renderWithData(<OverviewPanel projectId={PROJECT} />);
      await settled();
      expect(screen.queryByTestId("kpi-attention-dataset")).toBeNull();
    });

    it("is absent for a batch still being labeled", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "live", state: "in_annotation", allowed_actions: batchActions("in_annotation") })],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

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
      expect(screen.getByTestId("kpi-dataset").textContent).toContain("Nothing promoted yet");
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
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} onOpenReleases={releases} />);

      const badge = await screen.findByTestId("kpi-attention-dataset");
      // The batch to promote speaks first; the release is a step inside, not a second badge.
      expect(badge.textContent).toBe("1 to promote");
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
      expect(live.textContent).toContain("6/10");
      expect(screen.getByTestId("overview-batch-Draft").textContent).toContain("Not started");
      expect(screen.getByTestId("overview-batch-Draft").textContent).not.toContain("0/30");
    });
  });

  describe("opening a batch's sheet", () => {
    it("opens it from the row's button, without leaving the page", async () => {
      trio();
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} />);

      await screen.findByTestId("overview-batches");
      expect(rowButton(HARBOR).getAttribute("aria-haspopup")).toBe("dialog");
      expect(rowButton(HARBOR).getAttribute("aria-expanded")).toBe("false");
      await userEvent.click(rowButton(HARBOR));

      const sheet = await screen.findByTestId("batch-sheet");
      expect(open).not.toHaveBeenCalled();
      expect(sheet.textContent).toContain("Harbor");
      expect(within(sheet).getByTestId("batch-phase").textContent).toBe("Completed");
      expect(sheet.textContent).toContain("Batch 2 of 3");
      expect(screen.getByTestId("overview-batch-Harbor").getAttribute("data-open")).toBe("");
    });

    it("opens it from anywhere on the row, too", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Downtown"));
      expect((await screen.findByTestId("batch-sheet")).textContent).toContain("Downtown");
    });

    it("closes with Escape", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Downtown"));
      await screen.findByTestId("batch-sheet");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByTestId("batch-sheet")).toBeNull());
    });

    it("lists that batch's jobs, each with who holds it and how far it has come", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation") })],
        jobs: [
          jobOf("j1", "live", { state: "in_progress", assignee: "Dana Reyes" }),
          jobOf("j2", "live", { state: "pending" }),
          jobOf("j3", "live", { state: "completed", assignee: "Kim" }),
        ],
        progress: progressOf({ total: 5, annotated: 2, unannotated: 3 }),
      });
      const job = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} onOpenJob={job} />);

      await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
      const jobs = await screen.findByTestId("batch-sheet-jobs");
      const first = await within(jobs).findByTestId("batch-sheet-job-Job 1");
      expect(first.textContent).toContain("Dana Reyes");
      await waitFor(() => expect(first.textContent).toContain("2/5"));
      expect(within(jobs).getByTestId("batch-sheet-job-Job 2").textContent).toContain("Unassigned");
      // A finished job says so instead of offering to open it again.
      const done = within(jobs).getByTestId("batch-sheet-job-Job 3");
      expect(done.textContent).toContain("Done");
      expect(within(done).queryByRole("button")).toBeNull();

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

    it("says what a draft's missing jobs are waiting on", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Suburbs"));
      expect((await screen.findByTestId("batch-sheet-jobs")).textContent).toContain(
        "No jobs yet. Approving the batch in its gallery cuts it into jobs.",
      );
      // A draft's jobs are never read: there are none to read.
      expect(sent.some((request) => /\/batches\/b-suburbs\/jobs$/.test(new URL(request.url).pathname))).toBe(false);
    });

    it("walks the batches with J and K, and with its own arrows, in the order the table shows", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Suburbs"));
      const sheet = await screen.findByTestId("batch-sheet");
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
      await userEvent.click(rowButton(SUBURBS));
      const sheet = await screen.findByTestId("batch-sheet");
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
          batchOf({ id: "a", name: "Alpha", state: "in_annotation", allowed_actions: batchActions("in_annotation") }),
          batchOf({ id: "b", name: "Beta", state: "in_annotation", allowed_actions: batchActions("in_annotation") }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Alpha"));
      const sheet = await screen.findByTestId("batch-sheet");
      expect(sheet.textContent).toContain("Batch 1 of 2");
      // A menu opened from the sheet's footer is a menu: its letters are its own.
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

  describe("the sheet's footer", () => {
    it("opens the batch from Open batch", async () => {
      trio();
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Downtown"));
      const button = await screen.findByTestId("sheet-open");
      expect(button.textContent).toBe("Open batch");
      await userEvent.click(button);
      expect(open).toHaveBeenCalledExactlyOnceWith(DOWNTOWN);
    });

    it("leads with the batch's forward pointer and puts focus on it", async () => {
      trio();
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Suburbs"));
      const approve = await screen.findByTestId("sheet-approve");
      expect(approve.textContent).toBe("Review and approve");
      await waitFor(() => expect(document.activeElement).toBe(approve));
      await userEvent.click(approve);
      expect(open).toHaveBeenCalledExactlyOnceWith(SUBURBS);
      // Approve lives in the gallery with its gating: nothing was sent from here.
      expect(screen.queryByRole("button", { name: /^(Approve|Promote)$/ })).toBeNull();
      expect(sent.filter((request) => request.method !== "GET")).toEqual([]);
    });

    it("puts focus on Open batch where the batch has no forward step", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Downtown"));
      const open = await screen.findByTestId("sheet-open");
      expect(screen.queryByTestId("sheet-promote")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(open));
    });

    it("annotates straight into the one job it has", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation") })],
        jobs: [jobOf("j1", "live", { state: "in_progress", assignee: "Dana" })],
      });
      const open = vi.fn();
      const job = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} onOpenJob={job} />);

      await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
      const annotate = await screen.findByTestId("sheet-annotate");
      expect(annotate.textContent).toBe("Annotate");
      await screen.findByTestId("batch-sheet-job-Job 1");
      await userEvent.click(annotate);
      expect(job).toHaveBeenCalledExactlyOnceWith("j1");
      expect(open).not.toHaveBeenCalled();
    });

    it("annotates through the gallery when there are several jobs to pick from", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation") })],
        jobs: [jobOf("j1", "live"), jobOf("j2", "live")],
      });
      const open = vi.fn();
      const job = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} onOpenJob={job} />);

      await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
      await screen.findByTestId("batch-sheet-job-Job 2");
      await userEvent.click(screen.getByTestId("sheet-annotate"));
      expect(open).toHaveBeenCalledExactlyOnceWith("live");
      expect(job).not.toHaveBeenCalled();
    });

    it("offers no footer where the host has nowhere to send anybody", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await userEvent.click(await screen.findByTestId("overview-batch-Suburbs"));
      const sheet = await screen.findByTestId("batch-sheet");
      expect(within(sheet).queryByTestId("sheet-open")).toBeNull();
      expect(within(sheet).queryByTestId("sheet-approve")).toBeNull();
      expect(within(sheet).queryByTestId("sheet-prelabel")).toBeNull();
    });

    describe("Pre-label", () => {
      const live = (): Record<string, unknown> =>
        batchOf({
          id: "live",
          name: "drive-01",
          state: "in_annotation",
          progress: progressOf({ total: 10, unannotated: 10 }),
          allowed_actions: batchActions("in_annotation"),
        });

      it("opens the dialog over that one batch, titled for it", async () => {
        readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [live()] });
        renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

        await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
        await userEvent.click(await screen.findByTestId("sheet-prelabel"));

        expect(await screen.findByText("Pre-label drive-01")).not.toBeNull();
        expect(screen.getByTestId("project-prelabel-dialog")).not.toBeNull();
      });

      it("is offered only to a batch that declares pre_label", async () => {
        trio();
        renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

        // A draft declares approve, not pre_label.
        await userEvent.click(await screen.findByTestId("overview-batch-Suburbs"));
        await screen.findByTestId("sheet-approve");
        expect(screen.queryByTestId("sheet-prelabel")).toBeNull();
      });

      it("is absent where the host cannot open a batch, because the dialog leads into one", async () => {
        readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [live()] });
        renderWithData(<OverviewPanel projectId={PROJECT} />);

        await userEvent.click(await screen.findByTestId("overview-batch-drive-01"));
        await screen.findByTestId("batch-sheet");
        expect(screen.queryByTestId("sheet-prelabel")).toBeNull();
      });
    });
  });

  describe("the row's pointer", () => {
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
          label: "Review and promote",
        },
        {
          name: "to annotate",
          over: { state: "in_annotation", allowed_actions: batchActions("in_annotation") },
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
        const { unmount } = renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} />);

        await screen.findByTestId("overview-batch-Only");
        const pointers = [...document.querySelectorAll("[data-testid^=row-]")];
        if (one.key === null) {
          expect(pointers, one.name).toHaveLength(0);
        } else {
          expect(pointers.map((node) => node.getAttribute("data-testid")), one.name).toEqual([`row-${one.key}-Only`]);
          const pointer = screen.getByTestId(`row-${one.key}-Only`);
          expect(pointer.textContent, one.name).toBe(one.label);
          await userEvent.click(pointer);
          expect(open, one.name).toHaveBeenCalledExactlyOnceWith("only");
          // Pointing is not opening the sheet.
          expect(screen.queryByTestId("batch-sheet"), one.name).toBeNull();
        }
        unmount();
      }
    });

    it("offers no pointer where the host has nowhere to send anybody", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await screen.findByTestId("overview-batches");
      expect(document.querySelector("[data-testid^=row-]")).toBeNull();
    });

    it("is not the Overview's to act on: it sends nothing that changes anything", async () => {
      trio();
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} />);

      await userEvent.click(await screen.findByTestId("row-approve-Suburbs"));
      await userEvent.click(screen.getByTestId("row-promote-Harbor"));
      expect(open.mock.calls).toEqual([[SUBURBS], [HARBOR]]);
      expect(sent.filter((request) => request.method !== "GET")).toEqual([]);
    });

    describe("on a batch being labeled", () => {
      function labeling(jobs: readonly Record<string, unknown>[]): void {
        readinessOf({
          stats: statsOf({ asset_count: 48 }),
          batches: [batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation") })],
          jobs,
        });
      }

      it("annotates straight into the one job it has", async () => {
        labeling([jobOf("j1", "live", { state: "in_progress", assignee: "Dana" })]);
        const open = vi.fn();
        const job = vi.fn();
        renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} onOpenJob={job} />);

        const row = await screen.findByTestId("overview-batch-drive-01");
        // Who holds the jobs, once they have been read: the pointer waits on them.
        await waitFor(() => expect(row.textContent).toContain("1 job: Dana"));
        expect(within(row).getByText("DA")).not.toBeNull();
        await userEvent.click(screen.getByTestId("row-annotate-drive-01"));
        expect(job).toHaveBeenCalledExactlyOnceWith("j1");
        expect(open).not.toHaveBeenCalled();
      });

      it("annotates through the gallery when there are several jobs to pick from", async () => {
        labeling([jobOf("j1", "live"), jobOf("j2", "live", { assignee: "Kim Lee" })]);
        const open = vi.fn();
        const job = vi.fn();
        renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} onOpenJob={job} />);

        const row = await screen.findByTestId("overview-batch-drive-01");
        await waitFor(() => expect(row.textContent).toContain("2 jobs: Unassigned, Kim Lee"));
        // An unassigned job is a dashed mark, not a name.
        expect(within(row).getByText("?")).not.toBeNull();
        expect(within(row).getByText("KL")).not.toBeNull();
        await userEvent.click(screen.getByTestId("row-annotate-drive-01"));
        expect(open).toHaveBeenCalledExactlyOnceWith("live");
        expect(job).not.toHaveBeenCalled();
      });

      it("goes through the gallery where the host cannot open a job", async () => {
        labeling([jobOf("j1", "live")]);
        const open = vi.fn();
        renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} />);

        const row = await screen.findByTestId("overview-batch-drive-01");
        await waitFor(() => expect(row.textContent).toContain("1 job"));
        await userEvent.click(screen.getByTestId("row-annotate-drive-01"));
        expect(open).toHaveBeenCalledExactlyOnceWith("live");
      });
    });

    describe("each row's own jobs read", () => {
      function twoLive(): void {
        readinessOf({
          stats: statsOf({ asset_count: 48 }),
          batches: [
            batchOf({ id: "live", name: "drive-01", state: "in_annotation", allowed_actions: batchActions("in_annotation") }),
            batchOf({ id: "broken", name: "drive-02", state: "in_annotation", allowed_actions: batchActions("in_annotation") }),
          ],
          jobs: [jobOf("j1", "live", { state: "in_progress", assignee: "Dana" })],
        });
      }

      it("shows a row's holders even while another row's read is refused", async () => {
        twoLive();
        first("GET", /\/batches\/broken\/jobs$/, { status: 500, body: { code: "BOOM", message: "Jobs could not be read." } });
        renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

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
        renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

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
    it("offers every way into a batch labelled from what it declares, pre-label only where declared", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [
          batchOf({ id: "live", name: "Live", state: "in_annotation", allowed_actions: batchActions("in_annotation") }),
          batchOf({ id: "d", name: "Draft", state: "draft", allowed_actions: batchActions("draft") }),
          batchOf({ id: "ok", name: "Approved", state: "approved", allowed_actions: batchActions("approved") }),
          batchOf({ id: "fin", name: "Finished", state: "completed", promoted_asset_count: 4, allowed_actions: batchActions("completed") }),
          batchOf({ id: "all", name: "Everything", state: "completed", promoted_asset_count: 10, allowed_actions: batchActions("completed") }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

      const expected: Record<string, string[]> = {
        Live: ["menu-details", "menu-annotate", "menu-open", "menu-prelabel"],
        Draft: ["menu-details", "menu-approve", "menu-open"],
        Approved: ["menu-details", "menu-start", "menu-open"],
        Finished: ["menu-details", "menu-promote", "menu-open"],
        Everything: ["menu-details", "menu-open"],
      };
      for (const [name, items] of Object.entries(expected)) {
        await openMenu(name);
        expect(menuItems(), name).toEqual(items);
        await userEvent.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByTestId("menu-details")).toBeNull());
      }
    });

    it("offers only the details where the host has nowhere to send anybody", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await openMenu("Suburbs");
      expect(menuItems()).toEqual(["menu-details"]);
    });

    it("opens the sheet from Jobs and details", async () => {
      trio();
      renderWithData(<OverviewPanel projectId={PROJECT} />);

      await openMenu("Harbor");
      await userEvent.click(screen.getByTestId("menu-details"));
      expect((await screen.findByTestId("batch-sheet")).textContent).toContain("Harbor");
    });

    it("opens the gallery from the pointer and from Open batch", async () => {
      trio();
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} />);

      await openMenu("Suburbs");
      await userEvent.click(screen.getByTestId("menu-approve"));
      expect(open).toHaveBeenLastCalledWith(SUBURBS);

      await openMenu("Downtown");
      await userEvent.click(screen.getByTestId("menu-open"));
      expect(open).toHaveBeenLastCalledWith(DOWNTOWN);
      expect(open).toHaveBeenCalledTimes(2);
    });

    it("opens the pre-label dialog over that one batch", async () => {
      readinessOf({
        stats: statsOf({ asset_count: 48 }),
        batches: [
          batchOf({
            id: "live",
            name: "drive-01",
            state: "in_annotation",
            progress: progressOf({ total: 10, unannotated: 10 }),
            allowed_actions: batchActions("in_annotation"),
          }),
        ],
      });
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

      await openMenu("drive-01");
      await userEvent.click(screen.getByTestId("menu-prelabel"));
      expect(await screen.findByText("Pre-label drive-01")).not.toBeNull();
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
      const open = vi.fn();
      renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={open} />);

      await screen.findByTestId("overview-batches");
      rowButton(SUBURBS).focus();
      await userEvent.keyboard("j{Enter}");
      expect((await screen.findByTestId("batch-sheet")).textContent).toContain("Harbor");
      expect(open).not.toHaveBeenCalled();
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

describe("the batches panel's tool row", () => {
  const OPEN = "b-open";
  const DRAFT = "b-draft";

  function open(): Record<string, unknown> {
    return batchOf({ id: OPEN, name: "Open", state: "in_annotation", allowed_actions: batchActions("in_annotation") });
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

  it("offers Pre-label, then the view switch and filter: Add images is not among them", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [open()] });
    renderWithData(<OverviewPanel projectId={PROJECT} onIngest={vi.fn()} onOpenBatch={vi.fn()} />);

    await waitFor(async () => expect(await toolIds()).toEqual(["project-prelabel", "batches-lens", "batches-filter"]));
    // Add images lives in the toolbar alone, whatever the host hands the panel.
    expect(screen.queryByTestId("go-ingest")).toBeNull();
  });

  it("draws no Add images in the panel with or without an ingest to go to", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [open()] });
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-batches");
    expect(screen.queryByTestId("go-ingest")).toBeNull();
  });

  it("draws no tool row at all until there is a batch", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [] });
    renderWithData(<OverviewPanel projectId={PROJECT} onIngest={vi.fn()} onOpenBatch={vi.fn()} />);

    await screen.findByTestId("batches-none");
    expect(screen.queryByTestId("batches-lens")).toBeNull();
    expect(screen.queryByTestId("batches-filter")).toBeNull();
    expect(screen.queryByTestId("project-prelabel")).toBeNull();
    // The empty table has its own single next step, which is not the panel's
    // `go-ingest` tool.
    expect(screen.queryByTestId("go-ingest")).toBeNull();
  });

  it("offers the project-wide Pre-label when a host can open batches and a batch declares it", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [open()] });
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

    const button = await screen.findByTestId("project-prelabel");
    expect(within(screen.getByTestId("overview-batches")).getByTestId("project-prelabel")).toBe(button);
  });

  it("offers no Pre-label when no batch declares it", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [draft()] });
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenBatch={vi.fn()} />);

    await screen.findByTestId("overview-batches");
    expect(screen.queryByTestId("project-prelabel")).toBeNull();
  });

  it("offers no Pre-label to a host that cannot open a batch, because its dialog leads into one", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [open()] });
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

// --- the class rail -------------------------------------------------------------

describe("the class rail", () => {
  const DECLARED: LabelClassBody[] = [
    { name: "dog", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
    { name: "person", geometries: ["bbox"], color: null, attributes: [] },
    { name: "bicycle", geometries: ["bbox"], color: null, attributes: [] },
    { name: "unicycle", geometries: ["bbox"], color: null, attributes: [] },
  ];
  const rowsIn = (): string[] =>
    [...screen.getByTestId("overview-distribution").querySelectorAll("li")].map((one) => one.getAttribute("data-testid") ?? "");

  /** `n` classes, each with fewer annotations than the one before, so the rank is the name's order. */
  function manyClasses(n: number): Record<string, unknown> {
    const classes = Array.from({ length: n }, (_, i) => ({ label_class: `c${i + 1}`, annotations: 1000 - i * 10, assets: 10 }));
    return statsOf({ class_count: n, annotation_count: classes.reduce((sum, one) => sum + one.annotations, 0), classes });
  }

  it("heads the list with the class count, and leaves the annotation total to the Classes card", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} classes={DECLARED} />);

    const rail = await screen.findByTestId("overview-distribution");
    const header = rail.querySelector("h2")?.parentElement?.textContent ?? "";
    // Four declared classes, one of them undrawn.
    expect(header).toContain("Classes");
    expect(header).toContain("4");
    expect(header).not.toContain("annotations");
    expect(header).not.toContain((6431).toLocaleString(undefined));
    expect(screen.getByTestId("kpi-annotations").textContent).toContain(`${(6431).toLocaleString(undefined)} annotations`);
  });

  it("ranks the classes largest first", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} classes={DECLARED} />);

    await screen.findByTestId("overview-class-dog");
    expect(rowsIn()).toEqual([
      "overview-class-dog",
      "overview-class-person",
      "overview-class-bicycle",
      "overview-class-unicycle",
    ]);
    expect(screen.getByTestId("overview-class-dog").textContent).toContain("68%");
    expect(screen.getByTestId("overview-class-dog").textContent).toContain((4372).toLocaleString(undefined));
  });

  it("reads a dash for a declared class nobody has drawn yet, never a zero", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} classes={DECLARED} />);

    const row = await screen.findByTestId("overview-class-unicycle");
    expect(row.textContent).toContain("unicycle");
    expect(row.textContent).toContain("—");
    expect(row.textContent).not.toMatch(/\b0\b/);
    // The others carry a share, not a dash.
    expect(screen.getByTestId("overview-class-dog").textContent).not.toContain("—");
  });

  it("marks the thin class with a labelled warning dot, and only the thin class", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} classes={DECLARED} />);

    await screen.findByTestId("overview-distribution");
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

  it("carries no per-class image columns", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} classes={DECLARED} />);

    const rail = await screen.findByTestId("overview-distribution");
    expect(rail.querySelector("table")).toBeNull();
    expect(rail.textContent).not.toContain("Per image");
    expect(rail.textContent).not.toContain("Images");
  });

  it("writes the imbalance note from imbalanceNote, in the tooltip of the band's thin badge", async () => {
    const stats = statsOf();
    serve(stats);
    renderWithData(<OverviewPanel projectId={PROJECT} classes={DECLARED} />);

    // One thin class, counted in the band; the note stays out of the list until asked for.
    const badge = await screen.findByTestId("classes-thin");
    expect(badge.textContent).toContain("1 thin");
    expect(badge.closest("header")).toBe(screen.getByTestId("overview-distribution").querySelector("header"));
    expect(screen.queryByTestId("imbalance-note")).toBeNull();
    await userEvent.hover(badge);
    const note = await screen.findByTestId("imbalance-note");
    expect(note.textContent).toBe(
      imbalanceNote(
        (stats.classes as { label_class: string; annotations: number }[]).map(({ label_class, annotations }) => ({
          label_class,
          annotations,
        })),
      ),
    );
  });

  it("names only the top eight, and folds the rest into one Others row", async () => {
    serve(manyClasses(12));
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} />);

    await screen.findByTestId("overview-class-c1");
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
    serve(manyClasses(10));
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const trigger = await screen.findByTestId("overview-class-others");
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

  it("folds exactly one class beyond the eight into Others (1)", async () => {
    serve(manyClasses(9));
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-class-c1");
    expect(rowsIn()).toHaveLength(9);
    expect(screen.queryByTestId("overview-class-c9")).toBeNull();
    expect(screen.getByTestId("overview-class-Others").textContent).toContain("Others (1)");
  });

  it("shows all eight and no Others row when none are left over", async () => {
    serve(manyClasses(8));
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} />);

    await screen.findByTestId("overview-class-c8");
    expect(rowsIn()).toEqual(Array.from({ length: 8 }, (_, i) => `overview-class-c${i + 1}`));
    expect(screen.queryByTestId("overview-class-Others")).toBeNull();
    expect(screen.queryByTestId("overview-class-others")).toBeNull();
  });

  it("opens the Classes section from the header's Edit door, only where the host has one", async () => {
    serve(statsOf());
    const schema = vi.fn();
    const { unmount } = renderWithData(<OverviewPanel projectId={PROJECT} />);
    await screen.findByTestId("overview-distribution");
    expect(screen.queryByTestId("overview-edit-classes")).toBeNull();
    unmount();

    renderWithData(<OverviewPanel projectId={PROJECT} onOpenSchema={schema} />);
    const door = await screen.findByTestId("overview-edit-classes");
    expect(door.getAttribute("aria-label")).toBe("Edit classes");
    expect(door.textContent).toBe("Edit");
    // It lives in the panel's header; the panel has no footer.
    expect(door.closest("header")).toBe(screen.getByTestId("overview-distribution").querySelector("header"));
    await userEvent.click(door);
    expect(schema).toHaveBeenCalledOnce();
  });

  it("keeps the same Edit door when classes fold into Others", async () => {
    serve(manyClasses(9));
    const schema = vi.fn();
    renderWithData(<OverviewPanel projectId={PROJECT} onOpenSchema={schema} />);

    await userEvent.click(await screen.findByTestId("overview-edit-classes"));
    expect(schema).toHaveBeenCalledOnce();
  });

  it("puts the batches ahead of the rail in one four-column work row, the batches taking three", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    const batches = await screen.findByTestId("overview-batches");
    const classes = await screen.findByTestId("overview-distribution");
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

    // Batches, then the rail: the classes, then the images, in one column.
    expect(row?.children[0]).toBe(batches);
    const rail = row?.children[1];
    expect(rail?.children[0]).toBe(classes);
    expect(rail?.children[1]).toBe(images);
    expect(batches.compareDocumentPosition(classes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(classes.compareDocumentPosition(images) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lays the legend in one column inside the rail from xl, and two below it", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} classes={DECLARED} />);

    const legend = (await screen.findByTestId("overview-distribution")).querySelector("ol");
    expect(legend?.classList.contains("xl:grid-cols-1")).toBe(true);
    expect(legend?.classList.contains("sm:grid-cols-2")).toBe(true);
    expect([...(legend?.classList ?? [])].some((one) => one.startsWith("@2xl"))).toBe(false);
  });

  it("draws no releases panel: the dataset card and its pointer are where releases are reached", async () => {
    serve(statsOf());
    renderWithData(<OverviewPanel projectId={PROJECT} />);

    await screen.findByTestId("overview-batches");
    expect(screen.queryByTestId("overview-releases")).toBeNull();
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
    promoted_asset_count: 0,
    schema_version: 1,
    parent_batch_id: null,
    pre_label_run: null,
    progress: progressOf(),
    allowed_actions: [],
    ...over,
  };
}
