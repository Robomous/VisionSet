/**
 * The Overview panel, and the heuristic under it.
 *
 * Two halves, tested differently on purpose. `imbalanceNote` is a pure function
 * and is exercised at its boundaries directly — it is a stated placeholder, so
 * the thing worth pinning is exactly where it fires and where it stays quiet.
 * The panel is tested for its four states, the fourth being the one that would
 * be got wrong: assets but no annotations is *not* empty.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "../data/ApiProvider";
import { IMBALANCE_MIN_CLASSES, IMBALANCE_SHARE, imbalanceNote } from "./imbalance";
import { firstRunInvitation, invitationOwnsTheAction, OverviewPanel } from "./OverviewPanel";
import { datasetOf, releaseOf } from "../testing/wire.fixtures.js";

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
  // Null is a legitimate value and the *key* is what the shape check wants: the
  // field is required on the wire, and an asset ingested before the column
  // existed genuinely has no arrival to report.
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
 * The two-hop the pipeline row reads: project -> dataset -> releases.
 *
 * Installed for every fixture rather than per test. `useProjectReadiness` does not
 * wait on it, but the dashboard's trunk and release cards still ask, and an unstubbed pair
 * falls through to the 500 the harness answers with.
 */
function serveTrunk(releases: readonly string[] = []): void {
  on("GET", /\/projects\/[^/]+\/dataset$/, { status: 200, body: datasetOf(PROJECT, DATASET) });
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

  it("says a missing project in words, not as an identifier", async () => {
    on("GET", /\/stats$/, {
      status: 404,
      body: {
        code: "PROJECT_NOT_FOUND",
        message: `project ${PROJECT} not found in workspace /tmp/ws`,
      },
    });
    render(mount(<OverviewPanel projectId={PROJECT} />));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That project is no longer on record.");
    expect(alert.textContent).not.toContain(PROJECT);
    expect(alert.textContent).not.toContain("workspace");
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

// --- the first-run invitation -------------------------------------------------

describe("firstRunInvitation", () => {
  // The whole state table, swept — four combinations and four answers, so the
  // rule is checked rather than described. `null` is the fourth answer and it is
  // the one the page depends on most: a project with both halves is a dashboard,
  // and an invitation over it would be onboarding somebody who is already here.
  it("answers exactly one invitation per state, and none once both halves exist", () => {
    expect(firstRunInvitation({ hasSchema: false, hasAssets: false })).toBe("classes-first");
    expect(firstRunInvitation({ hasSchema: true, hasAssets: false })).toBe("ingest");
    expect(firstRunInvitation({ hasSchema: false, hasAssets: true })).toBe("classes-after-ingest");
    expect(firstRunInvitation({ hasSchema: true, hasAssets: true })).toBeNull();
  });

  it("hands the filled button to the invitation only where the header has none to lose", () => {
    // The `ingest` invitation is the exception: the header's Ingest is the same
    // label and the same handler, so the filled one stays up there.
    expect(invitationOwnsTheAction("classes-first")).toBe(true);
    expect(invitationOwnsTheAction("classes-after-ingest")).toBe(true);
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

  it("invites a schema-less, empty project to define classes, and nothing else", async () => {
    readinessOf({ schema: false, stats: empty });
    const schema = vi.fn();
    render(mount(<OverviewPanel projectId={PROJECT} onOpenSchema={schema} onIngest={vi.fn()} />));

    const region = await screen.findByTestId("first-run");
    expect(region.dataset.invitation).toBe("classes-first");
    // One filled button on the page, and it is this one.
    expect(filledButtons()).toEqual([screen.getByTestId("first-run-cta")]);
    // And the ingest empty state's own button is gone: three voices became one.
    expect(screen.queryByTestId("overview-ingest")).toBeNull();

    await userEvent.click(screen.getByTestId("first-run-cta"));
    expect(schema).toHaveBeenCalledOnce();
  });

  it("names the other order as prose with a link, never as a second filled button", async () => {
    // It guides, it never gates. Both orders are legitimate, so the page says so
    // — and says it without splitting its own hierarchy.
    readinessOf({ schema: false, stats: empty });
    const ingest = vi.fn();
    render(mount(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} onIngest={ingest} />));

    const alt = await screen.findByTestId("first-run-alt");
    expect(alt.className).not.toContain("bg-primary");
    expect(screen.getByTestId("first-run").textContent).toContain("both orders work");
    expect(filledButtons()).toHaveLength(1);

    await userEvent.click(alt);
    expect(ingest).toHaveBeenCalledOnce();
  });

  it("invites an ingest once classes exist and nothing is ingested", async () => {
    readinessOf({ stats: empty });
    render(mount(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} onIngest={vi.fn()} />));

    const region = await screen.findByTestId("first-run");
    expect(region.dataset.invitation).toBe("ingest");
    expect(screen.getByTestId("overview-ingest")).not.toBeNull();
    // Zero filled buttons *here*, because the page's one lives in the header
    // this panel does not render. `ProjectScreen`'s own tests carry the
    // other half of that claim.
    expect(filledButtons()).toHaveLength(0);
    expect(screen.queryByTestId("first-run-cta")).toBeNull();
  });

  it("invites classes over a project that ingested first, and says where annotation opens", async () => {
    readinessOf({ schema: false, stats: statsOf({ asset_count: 48 }) });
    render(mount(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} onIngest={vi.fn()} />));

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
    render(mount(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} />));

    expect((await screen.findByTestId("first-run")).textContent).toContain("1 image is in");
  });

  it("invites nothing once the project has both classes and images", async () => {
    readinessOf({ stats: statsOf({ asset_count: 48 }) });
    render(mount(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} onIngest={vi.fn()} />));

    // The dashboard is there, so this is not "nothing rendered".
    await screen.findByTestId("overview-pipeline");
    expect(screen.queryByTestId("first-run")).toBeNull();
    expect(filledButtons()).toHaveLength(0);
  });

  it("is retired outright: no checklist, no dismissal, on any state", async () => {
    // There is no four-station onboarding strip and no per-project dismissal.
    // Asserted on the state that would render step one, which is
    // where a survivor would show up first.
    readinessOf({ schema: false, stats: empty });
    render(mount(<OverviewPanel projectId={PROJECT} onOpenSchema={vi.fn()} />));

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
    render(mount(<OverviewPanel projectId={PROJECT} onIngest={vi.fn()} />));

    const region = await screen.findByTestId("first-run");
    expect(region.dataset.invitation).toBe("ingest");
  });

  it("guesses nothing over a project that has images and no readable schema", async () => {
    // The other half of the same rule. With assets present there is no
    // invitation that is true without the schema fact, so the page renders its
    // dashboard and stays quiet.
    serve(statsOf({ asset_count: 48 }));
    render(mount(<OverviewPanel projectId={PROJECT} onIngest={vi.fn()} />));

    await screen.findByTestId("overview-stats");
    expect(screen.queryByTestId("first-run")).toBeNull();
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
    // A documented "no answer" rendered as data reads as a broken screen.
    // "None yet" is an invitation; `0` is a
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
