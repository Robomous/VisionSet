/**
 * The Overview panel, and the heuristic under it.
 *
 * Two halves, tested differently on purpose. `imbalanceNote` is a pure function
 * and is exercised at its boundaries directly — it is a stated placeholder, so
 * the thing worth pinning is exactly where it fires and where it stays quiet.
 * The panel is tested for its four states, the fourth being the one that would
 * be got wrong: assets but no annotations is *not* empty.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "../data/ApiProvider";
import { clearPrefs } from "../data/prefs";
import { IMBALANCE_MIN_CLASSES, IMBALANCE_SHARE, imbalanceNote } from "./imbalance";
import { journeySteps, OverviewPanel } from "./OverviewPanel";
import { batchActions, datasetOf, releaseOf } from "../testing/wire.fixtures.js";
import type { components as capComponents } from "../generated/api.js";

type BatchState = capComponents["schemas"]["BatchState"];

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";

// Every field `AssetOut` declares beyond the id and project. The server sends all of
// them on every asset, so a fixture that omits them is not a smaller answer — it is a
// document the endpoint never sends, and `unwrap` now says so.
const ASSET_REST = {
  modality: "image",
  content_hash: "0".repeat(64),
  width: 640,
  height: 480,
  format: "png",
  source_id: null,
  frame_index: null,
  frame_timestamp: null,
  thumbnail_hash: null,
  // Null is a legitimate value and the *key* is what the shape check wants:
  // #283 made the field required on the wire, and an asset ingested before
  // #216 existed genuinely has no arrival to report.
  ingested_at: null,
} as const;

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];

beforeEach(() => {
  handlers = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
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
  // `writePref` keeps an in-memory mirror beside storage, so clearing the store
  // alone leaves a dismissal leaking into the next test.
  globalThis.sessionStorage.clear();
  clearPrefs();
});

function on(method: string, pattern: RegExp, answer: Answer): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname)
      ? { status: answer.status, body: answer.body ?? null }
      : undefined,
  );
}

function mount(node: ReactNode): JSX.Element {
  return (
    <ApiProvider
      baseUrl={API}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </ApiProvider>
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

/**
 * The two-hop the journey's last step reads: project -> dataset -> releases.
 *
 * Installed for every fixture rather than per test, because `useProjectReadiness`
 * waits on it — a missing stub makes readiness `null`, which renders as nothing
 * at all and is indistinguishable from a hook that stopped working.
 */
function serveTrunk(releases: readonly string[] = []): void {
  on("GET", /\/projects\/[^/]+\/dataset$/, { status: 200, body: datasetOf(PROJECT, DATASET) });
  on("GET", /\/releases$/, {
    status: 200,
    body: { items: releases.map((tag) => releaseOf(DATASET, tag)), total: releases.length },
  });
}

function batchOf(state: string): Record<string, unknown> {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    project_id: PROJECT,
    name: "drive-01",
    state,
    schema_version: state === "draft" ? null : 1,
    asset_count: 48,
    progress: {
      unannotated: 48,
      annotated: 0,
      skipped: 0,
      review_pending: 0,
      accepted: 0,
      total: 48,
    },
    allowed_actions: batchActions(state as BatchState),
    promoted_asset_count: 0,
  };
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
    serve(statsOf());
    const { container } = render(mount(<OverviewPanel projectId={PROJECT} />));

    const loading = screen.getByTestId("overview-loading");
    // Two rows of four — the pipeline pointers and the counts — plus four
    // distribution rows and six tiles: the shape the data arrives into.
    expect(loading.querySelectorAll(".animate-pulse")).toHaveLength(18);
    const gridsWhileLoading = container.querySelectorAll(".grid").length;

    await screen.findByTestId("overview-stats");
    expect(container.querySelectorAll(".grid").length).toBe(gridsWhileLoading);
  });

  it("shows the four counts, formatted", async () => {
    serve(statsOf());
    render(mount(<OverviewPanel projectId={PROJECT} />));

    const stats = await screen.findByTestId("overview-stats");
    expect(stats.textContent).toContain((1248).toLocaleString(undefined));
    expect(stats.textContent).toContain((6431).toLocaleString(undefined));
    expect(stats.textContent).toContain("62%");
  });

  it("ranks the distribution by count, largest first", async () => {
    serve(statsOf());
    render(mount(<OverviewPanel projectId={PROJECT} />));

    const rows = (await screen.findByTestId("overview-distribution")).textContent ?? "";
    expect(rows.indexOf("dog")).toBeLessThan(rows.indexOf("person"));
    expect(rows.indexOf("person")).toBeLessThan(rows.indexOf("bicycle"));
  });

  it("shows the imbalance note when the distribution earns one", async () => {
    serve(statsOf());
    render(mount(<OverviewPanel projectId={PROJECT} />));

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
    render(mount(<OverviewPanel projectId={PROJECT} />));

    await screen.findByTestId("overview-distribution");
    expect(screen.queryByTestId("imbalance-note")).toBeNull();
  });

  it("invites a first ingest when the project holds nothing", async () => {
    serve(statsOf({ asset_count: 0, annotated_asset_count: 0, annotation_count: 0, classes: [] }));
    const ingest = vi.fn();
    render(mount(<OverviewPanel projectId={PROJECT} onIngest={ingest} />));

    const empty = await screen.findByTestId("overview-empty");
    // An invitation, not an apology.
    expect(empty.textContent).toContain("Ingest");
    expect(empty.textContent).not.toContain("Nothing here yet");
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
    render(mount(<OverviewPanel projectId={PROJECT} />));

    const stats = await screen.findByTestId("overview-stats");
    expect(screen.queryByTestId("overview-empty")).toBeNull();
    expect(stats.textContent).toContain("0%");
    expect(screen.queryByTestId("distribution-none")).not.toBeNull();
  });

  it("computes the overflow from the project total, not from the page", async () => {
    serve(statsOf(), {
      items: [
        { id: "a", project_id: PROJECT, ...ASSET_REST },
        { id: "b", project_id: PROJECT, ...ASSET_REST },
      ],
      total: 1245,
    });
    render(mount(<OverviewPanel projectId={PROJECT} />));

    expect((await screen.findByTestId("thumbnail-overflow")).textContent).toBe(
      `+${(1243).toLocaleString(undefined)}`,
    );
  });

  it("renders no overflow tile when the project fits in the grid", async () => {
    serve(statsOf(), {
      items: [{ id: "a", project_id: PROJECT, ...ASSET_REST }],
      total: 1,
    });
    render(mount(<OverviewPanel projectId={PROJECT} />));

    await screen.findByTestId("overview-samples");
    await waitFor(() => expect(screen.queryByTestId("thumbnail-overflow")).toBeNull());
  });

  it("surfaces a failure to count with a way to retry", async () => {
    serveTrunk();
    on("GET", /\/stats$/, { status: 500, body: { code: "BOOM", message: "counting failed" } });
    on("GET", /\/assets$/, { status: 200, body: { items: [], total: 0 } });
    render(mount(<OverviewPanel projectId={PROJECT} />));

    expect((await screen.findByRole("alert")).textContent).toContain("counting failed");
  });
});

// --- the journey checklist (#289) ---------------------------------------------

describe("journeySteps", () => {
  it("marks everything before the current step complete and everything after upcoming", () => {
    expect(journeySteps("annotate")?.map((step) => step.state)).toEqual([
      "complete",
      "complete",
      "active",
      "upcoming",
    ]);
  });

  it("retires the whole checklist once the journey is done", () => {
    // `"done"` is not derivable from live data yet (`useProjectReadiness` v1
    // leaves it to a release signal), which is exactly why the retirement rule
    // is a pure function: this is the only place it can be exercised.
    expect(journeySteps("done")).toBeNull();
  });
});

/** Every source the panel and its readiness hook read, in one call. */
function readinessOf(options: {
  schema?: boolean;
  stats: Record<string, unknown>;
  batches?: readonly Record<string, unknown>[];
  releases?: readonly string[];
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
  on("GET", /\/assets$/, { status: 200, body: { items: [], total: 0 } });
}

describe("the journey checklist", () => {

  const empty = statsOf({
    asset_count: 0,
    annotated_asset_count: 0,
    annotation_count: 0,
    annotated_pct: 0,
    classes: [],
  });

  it("opens a schema-less project on step one, above the empty state", async () => {
    readinessOf({ schema: false, stats: empty });
    render(mount(<OverviewPanel projectId={PROJECT} />));

    const checklist = await screen.findByTestId("journey-checklist");
    expect(checklist).not.toBeNull();
    // The empty state and the checklist coexist: the invitation says what to
    // do with data, the checklist says labels come first.
    expect(screen.getByTestId("overview-empty")).not.toBeNull();
    expect(screen.getByTestId("journey-labels").dataset.state).toBe("active");
    expect(screen.getByTestId("journey-images").dataset.state).toBe("upcoming");
  });

  it("moves to step two once labels exist and nothing is ingested", async () => {
    readinessOf({ stats: empty });
    render(mount(<OverviewPanel projectId={PROJECT} />));

    await screen.findByTestId("journey-checklist");
    expect(screen.getByTestId("journey-labels").dataset.state).toBe("complete");
    expect(screen.getByTestId("journey-images").dataset.state).toBe("active");
  });

  it("moves to annotate while ingested work is untouched", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48, annotated_pct: 0, annotation_count: 0 }) });
    render(mount(<OverviewPanel projectId={PROJECT} />));

    await screen.findByTestId("journey-checklist");
    expect(screen.getByTestId("journey-annotate").dataset.state).toBe("active");
    expect(screen.getByTestId("journey-export").dataset.state).toBe("upcoming");
  });

  it("moves to export once every batch is settled and work is annotated", async () => {
    readinessOf({ stats: statsOf(), batches: [batchOf("completed")] });
    render(mount(<OverviewPanel projectId={PROJECT} />));

    await screen.findByTestId("journey-checklist");
    expect(screen.getByTestId("journey-export").dataset.state).toBe("active");
    expect(screen.getByTestId("journey-annotate").dataset.state).toBe("complete");
  });

  it("wires each reachable step to its host callback", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48, annotated_pct: 0, annotation_count: 0 }) });
    const schema = vi.fn();
    const batches = vi.fn();
    render(
      mount(
        <OverviewPanel projectId={PROJECT} onOpenSchema={schema} onOpenBatches={batches} />,
      ),
    );

    await screen.findByTestId("journey-checklist");
    // The active step links; so does a completed one — going back is legal.
    await userEvent.click(within(screen.getByTestId("journey-annotate")).getByRole("button"));
    expect(batches).toHaveBeenCalledOnce();
    await userEvent.click(within(screen.getByTestId("journey-labels")).getByRole("button"));
    expect(schema).toHaveBeenCalledOnce();
    // An upcoming step is plain text: pointing three steps ahead is how somebody
    // lands on a screen that refuses everything.
    expect(within(screen.getByTestId("journey-export")).queryByRole("button")).toBeNull();
  });

  it("renders no checklist at all while readiness has no answer", async () => {
    // Only stats and assets are stubbed; the schema and batch queries fail for a
    // real (non-404) reason, so the journey must not guess.
    serve(statsOf());
    render(mount(<OverviewPanel projectId={PROJECT} />));

    await screen.findByTestId("overview-stats");
    expect(screen.queryByTestId("journey-checklist")).toBeNull();
  });
});

/**
 * The checklist retiring itself — the `information-architecture` rule that
 * onboarding is not navigation.
 *
 * Two exits, and they are different facts. One is that the journey is *finished*:
 * `hasReleases` makes `done` derivable, and `journeySteps` answers `null` for it.
 * The other is that somebody has *read it*: a strip you cannot dismiss is a strip
 * you learn to look past.
 */
describe("when the journey stops being worth showing", () => {
  it("retires itself once the project has published a release", async () => {
    readinessOf({
      stats: statsOf({ asset_count: 48, annotated_pct: 100, annotation_count: 96 }),
      batches: [batchOf("completed")],
      releases: ["v1"],
    });

    render(mount(<OverviewPanel projectId={PROJECT} />));

    // The dashboard is there, so this is not "nothing rendered".
    await screen.findByTestId("overview-pipeline");
    expect(screen.queryByTestId("journey-checklist")).toBeNull();
  });

  it("still shows it while there is no release yet", async () => {
    readinessOf({
      stats: statsOf({ asset_count: 48, annotated_pct: 100, annotation_count: 96 }),
      batches: [batchOf("completed")],
    });

    render(mount(<OverviewPanel projectId={PROJECT} />));

    await screen.findByTestId("journey-checklist");
    expect(screen.getByTestId("journey-export").dataset.state).toBe("active");
  });

  it("stays dismissed, and only for the project it was dismissed on", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    const { unmount } = render(mount(<OverviewPanel projectId={PROJECT} />));

    await userEvent.click(await screen.findByTestId("journey-dismiss"));
    expect(screen.queryByTestId("journey-checklist")).toBeNull();
    unmount();

    // Persisted: a remount is a reload, and onboarding that came back would be
    // onboarding nobody can get rid of.
    render(mount(<OverviewPanel projectId={PROJECT} />));
    await screen.findByTestId("overview-pipeline");
    expect(screen.queryByTestId("journey-checklist")).toBeNull();
  });
});

/**
 * The dashboard row — Overview as pointers rather than as a second copy of every
 * tab.
 */
describe("the pipeline row", () => {
  it("points each card at the section that owns it", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    const go = { schema: vi.fn(), batches: vi.fn(), dataset: vi.fn() };
    render(
      mount(
        <OverviewPanel
          projectId={PROJECT}
          onOpenSchema={go.schema}
          onOpenBatches={go.batches}
          onBrowseDataset={go.dataset}
        />,
      ),
    );

    await screen.findByTestId("overview-pipeline");
    await userEvent.click(screen.getByTestId("pipeline-batches"));
    await userEvent.click(screen.getByTestId("pipeline-schema"));
    await userEvent.click(screen.getByTestId("pipeline-dataset"));
    await userEvent.click(screen.getByTestId("pipeline-release"));

    expect(go.batches).toHaveBeenCalledOnce();
    expect(go.schema).toHaveBeenCalledOnce();
    // Both the trunk and the release live on the Dataset tab.
    expect(go.dataset).toHaveBeenCalledTimes(2);
  });

  it("is a row of buttons, so a keyboard can reach it", async () => {
    // A card with somewhere to go is an action, and an action a mouse alone can
    // take is half a control.
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    render(mount(<OverviewPanel projectId={PROJECT} onOpenBatches={vi.fn()} />));

    const card = await screen.findByTestId("pipeline-batches");
    expect(card.tagName).toBe("BUTTON");
    // And one with nowhere to go stays a plain statistic rather than a disabled
    // button — it is not a refused action, it is not an action.
    expect(screen.getByTestId("pipeline-release").tagName).toBe("DIV");
  });

  it("says a section is empty in words rather than showing a zero", async () => {
    // #287's lesson one screen over: a documented "no answer" rendered as data
    // reads as a broken screen. "None yet" is an invitation; `0` is a
    // measurement of nothing.
    readinessOf({ stats: statsOf({ asset_count: 48 }), batches: [] });

    render(mount(<OverviewPanel projectId={PROJECT} />));

    // `findByText`, not `findByTestId` then read: the card renders immediately
    // with an em dash while its query is in flight, so reading `textContent` off
    // the element the moment it appears asserts against the loading state.
    await screen.findByText("An ingest creates one");
    const batches = screen.getByTestId("pipeline-batches");
    expect(batches.textContent).toContain("None yet");
    await screen.findByText("Publish one from the Dataset tab");
    expect(screen.getByTestId("pipeline-release").textContent).toContain("None yet");
  });
});
