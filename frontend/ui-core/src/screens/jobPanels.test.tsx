/**
 * The gallery as an accordion of jobs.
 *
 * The claim under all of these is one sentence: **once a batch has jobs, its
 * frames are shown per job, and at most one job's are on screen.** A screen that
 * showed the batch's frames beside a strip of jobs had two truths for the same
 * pictures — the strip's job and the grid's batch — and a person working one job
 * saw everybody else's frames.
 *
 * The fetch-stub harness is `gallery.test.tsx`'s, reused rather than reinvented:
 * `handlers` consulted in registration order, `on()` for a path, `mount()` for the
 * provider. What is new here is that `/assets` **answers by the `job` query
 * parameter**, because a stub that handed every job the same page could not tell
 * a request that carries `job=` from one that does not.
 */

import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { GalleryScreen } from "./GalleryScreen";
import { defaultOpenJob } from "./JobPanels";
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";
import type { Job } from "./queries";
import type { components } from "../generated/api.js";

type BatchState = components["schemas"]["BatchState"];
type JobState = components["schemas"]["AnnotationJobState"];

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "55555555-5555-4555-8555-555555555555";
const JOB_A = "77777777-7777-4777-8777-777777777777";
const JOB_B = "88888888-8888-4888-8888-888888888888";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
const sent: Request[] = [];

const NO_PROGRESS = {
  unannotated: 0,
  pre_labeled: 0,
  annotated: 0,
  skipped: 0,
  review_pending: 0,
  accepted: 0,
  total: 0,
};

/** Each job's counts, keyed by job id — what `/jobs/{id}/progress` answers. */
let progress: Map<string, Record<string, number>>;

/** The jobs `/batches/{id}/jobs` answers with. Mutable, so a job can vanish mid-test. */
let roster: readonly Job[];

/** The screen's own client, so a test can force the re-fetch a mutation would. */
let client: QueryClient;

beforeEach(() => {
  handlers = [];
  sent.length = 0;
  roster = [];
  progress = new Map([
    [JOB_A, { ...NO_PROGRESS, total: 2, unannotated: 2 }],
    [JOB_B, { ...NO_PROGRESS, total: 1, unannotated: 1 }],
  ]);
  writeToken("a-token");
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) {
        return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? null), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ code: "NO_STUB", message: request.url }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
  globalThis.localStorage.clear();
});

/** A thunk rather than a value where the answer has to change mid-test. */
function on(method: string, pattern: RegExp, answer: Answer | (() => Answer)): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname)
      ? typeof answer === "function"
        ? answer()
        : answer
      : undefined,
  );
}

function mount(node: ReactNode): JSX.Element {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <ApiProvider baseUrl={API} queryClient={client}>
      {node}
    </ApiProvider>
  );
}

/** Re-read what a mutation would have invalidated, and let the answers land. */
async function refetch(queryKey: readonly unknown[]): Promise<void> {
  await act(async () => {
    await client.invalidateQueries({ queryKey: [...queryKey] });
  });
}

function progressIs(jobId: string, counts: Record<string, number>): void {
  progress.set(jobId, { ...NO_PROGRESS, ...counts });
}

function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const state = (overrides.state as BatchState | undefined) ?? "in_annotation";
  return {
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state,
    schema_version: 2,
    asset_count: 3,
    progress: { ...NO_PROGRESS, total: 3, unannotated: 3 },
    allowed_actions: batchActions(state),
    promoted_asset_count: 0,
    parent_batch_id: null,
    pre_label_run: null,
    ...overrides,
  };
}

function job(id: string, assetCount: number, over: Record<string, unknown> = {}): Job {
  const state = (over.state as JobState | undefined) ?? "in_progress";
  return {
    id,
    batch_id: BATCH,
    state,
    asset_count: assetCount,
    assignee: null,
    pre_label_run: null,
    allowed_actions: jobActions(state),
    ...over,
  } as Job;
}

function asset(index: number, jobId: string): Record<string, unknown> {
  return {
    id: `asset-${index}`,
    project_id: PROJECT,
    modality: "image",
    content_hash: `${index}`.padStart(8, "0") + "deadbeef",
    width: 1280,
    height: 720,
    format: "jpeg",
    // Null, so nothing here reaches `GET /sources/{id}`: the provenance line is
    // `gallery.test.tsx`'s subject, not this file's.
    source_id: null,
    frame_index: index,
    frame_timestamp: index,
    thumbnail_hash: "cafebabe",
    ingested_at: "2026-08-01T09:00:00Z",
    job_id: jobId,
    progress: "unannotated",
    allowed_actions: assetActions("unannotated"),
    annotation_count: 0,
    min_confidence: null,
  };
}

/** Which frames each job carries. Frame numbers stay in batch order. */
const FRAMES: Record<string, readonly number[]> = { [JOB_A]: [0, 1], [JOB_B]: [2] };

/**
 * Every read this screen makes, with two jobs behind it.
 *
 * `/assets` answers **by the `job` parameter** rather than one fixed page: a
 * request that forgot the filter would otherwise be indistinguishable from one
 * that carried it.
 */
function stubs(batchOverrides: Record<string, unknown> = {}, jobs?: readonly Job[]): void {
  on("GET", /\/batches\/[^/]+$/, { status: 200, body: batch(batchOverrides) });
  on("GET", /\/batches$/, { status: 200, body: { items: [batch(batchOverrides)], total: 1 } });
  roster = jobs ?? [job(JOB_A, 2), job(JOB_B, 1)];
  on("GET", /\/jobs$/, () => ({
    status: 200,
    body: { items: roster, total: roster.length },
  }));
  handlers.push((request) => {
    const url = new URL(request.url);
    if (request.method !== "GET") return undefined;
    const forProgress = /\/jobs\/([^/]+)\/progress$/.exec(url.pathname);
    if (forProgress !== null) {
      const counts = progress.get(forProgress[1] as string);
      return counts === undefined
        ? { status: 404, body: { code: "JOB_NOT_FOUND", message: "no such job" } }
        : { status: 200, body: counts };
    }
    if (url.pathname.endsWith("/assets")) {
      const jobId = url.searchParams.get("job");
      const indexes = jobId === null ? [0, 1, 2] : (FRAMES[jobId] ?? []);
      return {
        status: 200,
        body: { total: indexes.length, items: indexes.map((at) => asset(at, jobId ?? JOB_A)) },
      };
    }
    return undefined;
  });
}

function renderGallery(): void {
  render(
    mount(
      <GalleryScreen
        projectId={PROJECT}
        batchId={BATCH}
        onOpenAsset={vi.fn()}
        onOpenJob={vi.fn()}
      />,
    ),
  );
}

/** The `/assets` requests, most recent last. */
function assetRequests(): URL[] {
  return sent
    .filter((one) => new URL(one.url).pathname.endsWith("/assets"))
    .map((one) => new URL(one.url));
}

describe("which panel opens", () => {
  it("opens exactly one panel, the first job with work left", async () => {
    progressIs(JOB_A, { total: 2, annotated: 2 });
    progressIs(JOB_B, { total: 1, unannotated: 1 });
    stubs();
    renderGallery();

    await screen.findByTestId(`job-panel-${JOB_B}`);
    expect(screen.queryByTestId(`job-panel-${JOB_A}`)).toBeNull();
    expect(screen.getByTestId(`job-header-${JOB_B}`).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId(`job-header-${JOB_A}`).getAttribute("aria-expanded")).toBe("false");
  });

  it("counts a model's first pass as work left, not as work done", async () => {
    // `pre_labeled` frames are the ones somebody has to look at next, which is
    // the whole reason the rule sums them with `unannotated`.
    progressIs(JOB_A, { total: 2, annotated: 2 });
    progressIs(JOB_B, { total: 1, pre_labeled: 1 });
    stubs();
    renderGallery();

    await screen.findByTestId(`job-panel-${JOB_B}`);
  });

  it("falls back to the first job when nothing is left", async () => {
    progressIs(JOB_A, { total: 2, annotated: 2 });
    progressIs(JOB_B, { total: 1, skipped: 1 });
    stubs();
    renderGallery();

    await screen.findByTestId(`job-panel-${JOB_A}`);
    expect(screen.queryByTestId(`job-panel-${JOB_B}`)).toBeNull();
  });

  it("opening another job closes the open one, and clicking the open header closes it", async () => {
    stubs();
    renderGallery();
    await screen.findByTestId(`job-panel-${JOB_A}`);

    await userEvent.click(screen.getByTestId(`job-header-${JOB_B}`));
    await screen.findByTestId(`job-panel-${JOB_B}`);
    expect(screen.queryByTestId(`job-panel-${JOB_A}`)).toBeNull();

    // Every panel closes: the accordion read as an index of the batch's jobs is
    // a state somebody asks for, and a control that cannot undo itself is not a
    // toggle.
    await userEvent.click(screen.getByTestId(`job-header-${JOB_B}`));
    expect(screen.queryByTestId(`job-panel-${JOB_B}`)).toBeNull();
    for (const id of [JOB_A, JOB_B]) {
      expect(screen.getByTestId(`job-header-${id}`).getAttribute("aria-expanded")).toBe("false");
    }

    await userEvent.click(screen.getByTestId(`job-header-${JOB_B}`));
    expect(await screen.findByTestId(`job-panel-${JOB_B}`)).toBeTruthy();
  });

  it("stops describing frames once nothing is open", async () => {
    stubs();
    renderGallery();
    await screen.findByTestId(`job-panel-${JOB_A}`);
    // The header's provenance line is assembled from the open panel's window.
    await waitFor(() => expect(screen.getByTestId("batch-facts").textContent).toContain("1280×720"));

    await userEvent.click(screen.getByTestId(`job-header-${JOB_A}`));
    await waitFor(() =>
      expect(screen.getByTestId("batch-facts").textContent).not.toContain("1280×720"),
    );
  });

  it("keeps the open panel open when finishing its last frame moves the default on", async () => {
    // The default is a *latch*, not a derivation: re-read every render, finishing
    // the open job's last frame would make the next job the first with work left
    // and shut the panel under the person still looking at it.
    progressIs(JOB_A, { total: 2, unannotated: 2 });
    progressIs(JOB_B, { total: 1, unannotated: 1 });
    stubs();
    renderGallery();
    await screen.findByTestId(`job-panel-${JOB_A}`);

    progressIs(JOB_A, { total: 2, annotated: 2 });
    await refetch(["jobs"]);

    expect(screen.queryByTestId(`job-panel-${JOB_A}`)).not.toBeNull();
    expect(screen.queryByTestId(`job-panel-${JOB_B}`)).toBeNull();
  });

  it("falls back to the default when the open job is no longer in the batch", async () => {
    stubs();
    renderGallery();
    await screen.findByTestId(`job-panel-${JOB_A}`);
    await userEvent.click(screen.getByTestId(`job-header-${JOB_B}`));
    await screen.findByTestId(`job-panel-${JOB_B}`);

    // A job that has stopped existing cannot stay open, and holding its id would
    // leave the screen closed over a batch that has a job. Down to one, there is
    // no accordion to hold open at all: the remaining job's frames sit flat.
    roster = [job(JOB_A, 2)];
    await refetch(["batches"]);

    expect(await screen.findByTestId("job-workspace")).toBeTruthy();
    expect(screen.queryByTestId("job-panels")).toBeNull();
    expect(screen.queryByTestId(`job-header-${JOB_B}`)).toBeNull();
  });

  it("opens nothing until every job's progress has answered", async () => {
    // A panel opened off half-read counts is a panel that flips to a different
    // job once the rest land — the wrong job's frames, then a jump. The gate sits
    // under `globalThis.fetch` *before* the client is built, because
    // `openapi-fetch` reads that reference once at `createClient()` time.
    progressIs(JOB_A, { total: 2, annotated: 2 });
    progressIs(JOB_B, { total: 1, unannotated: 1 });
    const inner = globalThis.fetch;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", async (request: Request) => {
      if (new URL(request.url).pathname === `/jobs/${JOB_B}/progress`) await held;
      return inner(request);
    });

    stubs();
    renderGallery();
    await screen.findByTestId(`job-header-${JOB_A}`);
    expect(screen.queryByTestId(`job-panel-${JOB_A}`)).toBeNull();
    expect(screen.queryByTestId(`job-panel-${JOB_B}`)).toBeNull();

    release?.();
    // And it is B that opens — the job the withheld counts turn out to name.
    await screen.findByTestId(`job-panel-${JOB_B}`);
  });
});

describe("what the open panel asks for", () => {
  it("asks for the open job's frames only, and counts its segments off its own progress", async () => {
    progressIs(JOB_A, { total: 2, annotated: 2 });
    progressIs(JOB_B, { total: 1, unannotated: 1 });
    stubs();
    renderGallery();

    const panel = within(await screen.findByTestId(`job-panel-${JOB_B}`));
    await waitFor(() => expect(assetRequests().at(-1)?.searchParams.get("job")).toBe(JOB_B));
    // One, not three: the batch holds three frames and this job holds one, so a
    // count off the batch would be the filter lying about what it filters.
    expect(panel.getByTestId("segment-all").textContent).toContain("All (1)");
    expect(panel.getByTestId(`tile-asset-2`)).toBeTruthy();
    expect(screen.queryByTestId("tile-asset-0")).toBeNull();
  });

  it("resets the segment filter when the open job changes", async () => {
    progressIs(JOB_A, { total: 2, unannotated: 1, annotated: 1 });
    progressIs(JOB_B, { total: 1, unannotated: 1 });
    stubs();
    renderGallery();

    const first = within(await screen.findByTestId(`job-panel-${JOB_A}`));
    fireEvent.click(first.getByTestId("segment-done"));
    expect(first.getByTestId("segment-done").getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(screen.getByTestId(`job-header-${JOB_B}`));
    const second = within(await screen.findByTestId(`job-panel-${JOB_B}`));
    // The filter is about the job you were looking at, and carrying it over is
    // how a person opens a job and is told it has no frames.
    expect(second.getByTestId("segment-all").getAttribute("aria-pressed")).toBe("true");
    await waitFor(() =>
      expect(assetRequests().at(-1)?.searchParams.getAll("progress")).toEqual([]),
    );
  });
});

describe("the collapsed header is the overview", () => {
  it("renders the frames, the state, the annotated count, the assignee and a bar", async () => {
    progressIs(JOB_A, { total: 2, annotated: 1, unannotated: 1 });
    stubs({}, [job(JOB_A, 2, { assignee: "Dana Reyes" }), job(JOB_B, 1)]);
    renderGallery();

    const row = await screen.findByTestId(`job-row-${JOB_A}`);
    await waitFor(() => expect(row.textContent).toContain("1 of 2 annotated"));
    expect(row.textContent).toContain("Job 1");
    expect(row.textContent).toContain("2 frames");
    expect(row.textContent).toContain("in progress");
    expect(row.textContent).toContain("Dana Reyes");
    // The bar, and only the bar: `BatchProgressBar` would draw its readout under
    // the track and say "1 of 2 annotated" a second time.
    const bar = within(row).getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(row.textContent?.match(/1 of 2 annotated/g)).toHaveLength(1);
    // The bar and the assignee are siblings of the control: a `progressbar` is
    // content a `<button>` may not hold, and it would be read out as part of the
    // button's name.
    const control = screen.getByTestId(`job-header-${JOB_A}`);
    expect(within(control).queryByRole("progressbar")).toBeNull();
    expect(control.textContent).not.toContain("Dana Reyes");
  });

  it("says an unassigned job has nobody rather than nothing", async () => {
    stubs();
    renderGallery();
    const row = await screen.findByTestId(`job-row-${JOB_B}`);
    expect(row.textContent).toContain("Unassigned");
  });

  it("points aria-controls at a panel only while that panel exists", async () => {
    // A closed panel is unmounted, so an id pointing at it would point at
    // nothing; `aria-expanded="false"` with no `aria-controls` is the honest
    // shape, and the open header names the region it controls.
    stubs();
    renderGallery();
    await screen.findByTestId(`job-panel-${JOB_A}`);
    const open = screen.getByTestId(`job-header-${JOB_A}`);
    const closed = screen.getByTestId(`job-header-${JOB_B}`);
    expect(open.getAttribute("aria-controls")).toBe(`job-panel-${JOB_A}`);
    expect(document.getElementById(`job-panel-${JOB_A}`)).not.toBeNull();
    expect(closed.getAttribute("aria-expanded")).toBe("false");
    expect(closed.hasAttribute("aria-controls")).toBe(false);
  });

  it("restores a job's filter and order when its panel reopens", async () => {
    stubs();
    renderGallery();
    await screen.findByTestId(`job-panel-${JOB_A}`);
    await userEvent.click(screen.getByTestId("segment-done"));
    await userEvent.selectOptions(screen.getByTestId("sort-order"), "confidence");
    expect(screen.getByTestId("segment-done").getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(screen.getByTestId(`job-header-${JOB_B}`));
    await screen.findByTestId(`job-panel-${JOB_B}`);
    // The other job starts from the default: what was chosen was chosen for A.
    expect(screen.getByTestId("segment-all").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByTestId("sort-order") as HTMLSelectElement).value).toBe("membership");

    await userEvent.click(screen.getByTestId(`job-header-${JOB_A}`));
    await screen.findByTestId(`job-panel-${JOB_A}`);
    expect(screen.getByTestId("segment-done").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByTestId("sort-order") as HTMLSelectElement).value).toBe("confidence");
  });

  it("moves between headers with the arrow keys", async () => {
    stubs();
    renderGallery();
    const first = await screen.findByTestId(`job-header-${JOB_A}`);
    const second = screen.getByTestId(`job-header-${JOB_B}`);

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);

    // Wraps rather than stopping: two jobs is the common case, and a dead key at
    // each end is a keyboard model a person has to remember the edges of.
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: "Home" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(second);
  });
});

describe("what stays outside the panels", () => {
  it("keeps the shared thumbnail-size control outside the panels, on the header's progress row", async () => {
    stubs();
    renderGallery();

    const panels = await screen.findByTestId("job-panels");
    const size = screen.getByTestId("density");
    // One setting for the whole screen, not one per job: how big the pictures
    // are is a preference about looking at pictures. It rides the batch's own
    // progress row, the last thing above the accordion that is about the batch.
    expect(screen.queryAllByTestId("density")).toHaveLength(1);
    expect(panels.contains(size)).toBe(false);
    expect(screen.getByTestId("batch-title").closest("header")?.contains(size)).toBe(true);
    // On the readout's line, not across the track: the row bottom-aligns, and the
    // readout is the bottom of the two-line progress block beside it.
    const row = screen.getByTestId("batch-progress-row");
    expect(row.contains(size)).toBe(true);
    expect(row.className).toContain("items-end");
  });

  it("keeps one thumbnail size across a switch of panels", async () => {
    stubs();
    renderGallery();
    await screen.findByTestId(`job-panel-${JOB_A}`);

    fireEvent.change(screen.getByTestId("density"), { target: { value: "3" } });
    await userEvent.click(screen.getByTestId(`job-header-${JOB_B}`));
    await screen.findByTestId(`job-panel-${JOB_B}`);

    expect((screen.getByTestId("density") as HTMLInputElement).value).toBe("3");
    expect(screen.getByTestId("gallery-grid").getAttribute("data-min-column")).toBe("260");
  });

  it("shows no accordion for a draft, whose frames belong to no job", async () => {
    stubs({ state: "draft", schema_version: null });
    renderGallery();

    await screen.findByTestId("tile-asset-0");
    expect(screen.queryByTestId("job-panels")).toBeNull();
    expect(screen.queryByTestId("segments")).toBeNull();
  });

  it("keeps the accordion working when one job's counts cannot be read", async () => {
    // The whole accordion used to wait for every progress read to *succeed*, so
    // one 500 left it closed over a batch whose other jobs were fine — and
    // silent, because nothing rendered the refusal either.
    progressIs(JOB_A, { total: 2, unannotated: 2 });
    on("GET", new RegExp(`/jobs/${JOB_A}/progress$`), {
      status: 500,
      body: { code: "INTERNAL_ERROR", message: "progress is unreachable" },
    });
    stubs();
    renderGallery();

    // B is the first job with counts *and* work left, so the failed one is
    // skipped rather than blocking.
    await screen.findByTestId(`job-panel-${JOB_B}`);
    expect(await screen.findByText("progress is unreachable")).toBeTruthy();
    const failed = screen.getByTestId(`job-row-${JOB_A}`);
    expect(within(failed).queryByRole("progressbar")).toBeNull();
    expect(failed.textContent).toContain("Job 1");
    expect(failed.textContent).not.toContain("annotated");

    // And the panel is still usable: it is the *numbers* the failed read cost,
    // not the filters, so the chips and the order select are drawn without them.
    await userEvent.click(screen.getByTestId(`job-header-${JOB_A}`));
    const panel = within(await screen.findByTestId(`job-panel-${JOB_A}`));
    expect(panel.getByTestId("segments")).toBeTruthy();
    expect(panel.getByTestId("sort-order")).toBeTruthy();
    expect(panel.getByTestId("segment-all").textContent).toBe("All");
  });

  it("says why the jobs could not be read, instead of an empty screen", async () => {
    on("GET", /\/batches\/[^/]+$/, { status: 200, body: batch() });
    on("GET", /\/jobs$/, {
      status: 500,
      body: { code: "INTERNAL_ERROR", message: "jobs are unreachable" },
    });
    renderGallery();

    expect(await screen.findByText("jobs are unreachable")).toBeTruthy();
    expect(screen.queryByTestId("job-panels")).toBeNull();
  });
});

describe("the default-open rule on its own", () => {
  const counts = (over: Record<string, number>) => ({ ...NO_PROGRESS, ...over });

  it("takes the first job with anything left to look at", () => {
    const jobs = [job(JOB_A, 2), job(JOB_B, 1)];
    const seen = new Map([
      [JOB_A, counts({ total: 2, annotated: 2 })],
      [JOB_B, counts({ total: 1, pre_labeled: 1 })],
    ]);
    expect(defaultOpenJob(jobs, seen)).toBe(JOB_B);
  });

  it("falls back to the first job when every one of them is settled", () => {
    const jobs = [job(JOB_A, 2), job(JOB_B, 1)];
    const seen = new Map([
      [JOB_A, counts({ total: 2, annotated: 2 })],
      [JOB_B, counts({ total: 1, skipped: 1 })],
    ]);
    expect(defaultOpenJob(jobs, seen)).toBe(JOB_A);
  });

  it("opens nothing at all while the counts are still in flight", () => {
    expect(defaultOpenJob([job(JOB_A, 2)], undefined)).toBeNull();
  });

  it("opens nothing for a batch with no jobs", () => {
    expect(defaultOpenJob([], new Map())).toBeNull();
  });
});
