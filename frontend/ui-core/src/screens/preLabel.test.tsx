/**
 * The gallery's pre-labeling control: gated on the batch's own declaration,
 * narrowed to connections that answer words, and honest about a refusal.
 *
 * Reuses the fetch-stub harness `gallery.test.tsx` established — `on`, `mount`,
 * a `handlers` array consulted in registration order — rather than inventing a
 * second shape for the same job. `batchActions` comes from the shared
 * `wire.fixtures.js` transcription so a `renderGallery` batch is one the server
 * could really have sent.
 */

import { QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { GalleryScreen } from "./GalleryScreen";
import { batchActions } from "../testing/wire.fixtures.js";
import type { Connection } from "../data/inferenceQueries";
import type { components } from "../generated/api";

type BatchState = components["schemas"]["BatchState"];

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "55555555-5555-4555-8555-555555555555";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
const sent: Request[] = [];

beforeEach(() => {
  handlers = [];
  sent.length = 0;
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
});

function on(method: string, pattern: RegExp, answer: Answer): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname) ? answer : undefined,
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

const NO_PROGRESS = {
  unannotated: 0,
  annotated: 0,
  skipped: 0,
  review_pending: 0,
  accepted: 0,
  total: 0,
};

function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const state = (overrides.state as BatchState | undefined) ?? "in_annotation";
  return {
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state: "in_annotation",
    schema_version: 3,
    asset_count: 48,
    progress: { ...NO_PROGRESS, total: 48, unannotated: 48 },
    allowed_actions: batchActions(state),
    promoted_asset_count: 0,
    parent_batch_id: null,
    pre_label_run: null,
    ...overrides,
  };
}

/** A full `ConnectionOut`, on `inference.test.tsx`'s fixture — every field the check reads. */
function connectionOf(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "detector",
    connection_type: "local",
    model_id: "some/grounding-model",
    model_revision: "main",
    device: "cuda",
    precision: "fp16",
    endpoint_url: null,
    setup_state: "ready",
    allowed_actions: ["update", "delete"],
    capabilities: ["text_detect"],
    download: null,
    integrity_check: null,
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

const DETECTOR = connectionOf({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "grounding-dino",
  capabilities: ["text_detect"],
});
const SEGMENTER = connectionOf({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "sam2-local",
  capabilities: ["point_suggest"],
});

/** A full `BackgroundJobOut` — every field `checkPreLabelBatch` requires. */
function backgroundJobOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    type: "annotation.pre_label",
    state: "queued",
    attempt: 1,
    cancel_requested: false,
    created_at: "2026-08-17T09:00:00Z",
    started_at: null,
    finished_at: null,
    error: null,
    failures: [],
    processed: 0,
    total: null,
    result: {},
    ...overrides,
  };
}

/** A full `PreLabelRunOut` — every field `checkGetBatch` requires, `BatchOut.pre_label_run`. */
function preLabelRunOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: "88888888-8888-4888-8888-888888888888",
    state: "cancelled",
    assets_processed: 12,
    assets_total: 48,
    error: null,
    stopped_early: true,
    assets_labeled: 9,
    regions_discarded: 0,
    ...overrides,
  };
}

/** The exact prose the kernel writes for each refusal `pre-label` can answer. */
const REFUSAL_MESSAGE: Record<string, string> = {
  SCHEMA_HAS_NO_DETECTABLE_CLASS:
    "schema version 3 declares no class that a box can be written as, so a detector has " +
    "nowhere to put what it finds; add a class whose geometries include bbox, or pre-label " +
    "a batch pinned to one that has",
  UNSUPPORTED_PROMPT:
    "connection 'sam2-local' runs a model that answers places rather than words, so it " +
    "cannot be asked what is in a picture; use a connection whose model declares text_detect",
  BATCH_NOT_IN_ANNOTATION: "batch 'drive-01' is not in annotation",
};

function refuses(status: number, code: string): Answer {
  return { status, body: { code, message: REFUSAL_MESSAGE[code] ?? `${code} refused` } };
}

interface Extra {
  readonly connections?: readonly Connection[];
  readonly counts?: { readonly unannotated: number; readonly total: number };
  readonly preLabel?: Answer;
}

function renderGallery(batchOverrides: Record<string, unknown> = {}, extra: Extra = {}): void {
  const counts = extra.counts;
  on("GET", /\/batches\/[^/]+$/, {
    status: 200,
    body: batch({
      ...batchOverrides,
      ...(counts === undefined
        ? {}
        : { progress: { ...NO_PROGRESS, total: counts.total, unannotated: counts.unannotated } }),
    }),
  });
  on("GET", /\/assets$/, { status: 200, body: { total: 0, items: [] } });
  const connections = extra.connections ?? [DETECTOR];
  on("GET", /\/inference\/connections$/, {
    status: 200,
    body: { items: connections, total: connections.length },
  });
  on("POST", /\/pre-label$/, extra.preLabel ?? { status: 202, body: backgroundJobOf() });

  render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
}

it("offers pre-labeling only when the batch declares it", async () => {
  renderGallery({ allowed_actions: ["pre_label", "complete"] });
  expect(await screen.findByRole("button", { name: /pre-label/i })).not.toBeNull();
});

it("does not offer it when the batch does not declare it", async () => {
  renderGallery({ allowed_actions: ["complete"] });
  await screen.findByRole("heading", { level: 1 });
  expect(screen.queryByRole("button", { name: /pre-label/i })).toBeNull();
});

it("offers only connections that answer words", async () => {
  renderGallery({ allowed_actions: ["pre_label"] }, { connections: [DETECTOR, SEGMENTER] });
  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));
  await userEvent.click(await screen.findByLabelText(/model/i));

  expect(screen.getByRole("option", { name: new RegExp(DETECTOR.name) })).not.toBeNull();
  expect(screen.queryByRole("option", { name: new RegExp(SEGMENTER.name) })).toBeNull();
  // Closed rather than left open: Radix's focus scope schedules its own cleanup,
  // and leaving the popover open races that timer against `cleanup()`.
  await userEvent.keyboard("{Escape}");
});

it("names what the confidence number measures", async () => {
  renderGallery({ allowed_actions: ["pre_label"] });
  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));

  expect(await screen.findByText(/prompt affinity/i)).not.toBeNull();
  const input = screen.getByTestId("prelabel-confidence") as HTMLInputElement;
  expect(input.value).toBe("0.35");
});

it("says how many assets the run will touch", async () => {
  renderGallery({ allowed_actions: ["pre_label"] }, { counts: { unannotated: 412, total: 500 } });
  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));

  expect(await screen.findByText(/412 of 500/)).not.toBeNull();
});

it("shows the refusal rather than swallowing it", async () => {
  renderGallery({ allowed_actions: ["pre_label"] }, { preLabel: refuses(409, "SCHEMA_HAS_NO_DETECTABLE_CLASS") });
  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));
  await userEvent.click(await screen.findByRole("button", { name: /start/i }));

  expect(await screen.findByText(/no class that a box can be written as/i)).not.toBeNull();
});

it("shows the places-not-words refusal too, in the kernel's own sentence", async () => {
  renderGallery({ allowed_actions: ["pre_label"] }, { preLabel: refuses(422, "UNSUPPORTED_PROMPT") });
  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));
  await userEvent.click(await screen.findByRole("button", { name: /start/i }));

  expect(await screen.findByText(/answers places rather than words/i)).not.toBeNull();
});

it("says nothing answers text prompts yet, when nothing does", async () => {
  renderGallery({ allowed_actions: ["pre_label"] }, { connections: [] });
  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));

  expect(await screen.findByTestId("prelabel-no-connections")).not.toBeNull();
  // No dead control beside the explanation: a select with nothing to choose
  // from is worse than no select at all.
  expect(screen.queryByTestId("prelabel-model")).toBeNull();
});

it("disables the start press for a prompt affinity outside 0 to 1", async () => {
  renderGallery({ allowed_actions: ["pre_label"] });
  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));

  const confidence = await screen.findByTestId("prelabel-confidence");
  await userEvent.clear(confidence);
  await userEvent.type(confidence, "1.5");

  const submit = screen.getByRole("button", { name: /start/i }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
});

it("disables the start press when the confidence field is cleared", async () => {
  // `Number("")` is `0`, a value inside the valid range, so an emptied field
  // must be refused on its own rather than falling through as a valid `0` —
  // which would silently post a floor that writes every region the model
  // returns.
  renderGallery({ allowed_actions: ["pre_label"] });
  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));

  const confidence = await screen.findByTestId("prelabel-confidence");
  await userEvent.clear(confidence);

  const submit = screen.getByRole("button", { name: /start/i }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
});

it("sends the chosen model and the typed confidence, not a default nobody set", async () => {
  renderGallery({ allowed_actions: ["pre_label"] });
  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));

  const confidence = screen.getByTestId("prelabel-confidence");
  await userEvent.clear(confidence);
  await userEvent.type(confidence, "0.5");
  await userEvent.click(await screen.findByRole("button", { name: /start/i }));

  await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
  const post = sent.find((r) => r.method === "POST" && r.url.endsWith("/pre-label"));
  const body = JSON.parse(await post!.clone().text());
  expect(body).toEqual({ connection_id: DETECTOR.id, minimum_confidence: 0.5 });
});

/**
 * The second invalidation, driven across a real poll transition.
 *
 * The only piece of logic in this dialog nothing else in the suite proves:
 * `PreLabelDialog`'s own `useEffect` re-invalidates the batch and its assets
 * when the polled job *settles*, guarded so it fires once. Answering the
 * final state on the first read (`dataset.test.tsx`'s `exportWith` does
 * exactly that) would never exercise the guard at all — the job has to
 * genuinely move `queued` -> `running` -> `succeeded` across sequential
 * polls, which needs a counter-based stub and fake timers to cross the
 * `DEFAULT_POLL_MS` interval without a real two-second wait per tick.
 */
it("invalidates the batch a second time only once the polled job settles, and only once", async () => {
  vi.useFakeTimers();
  try {
    renderGallery({ allowed_actions: ["pre_label"] });

    // Three different bodies for the same route, in call order — the shape
    // no existing fixture in this suite provides, and the one thing that
    // actually exercises the `settled` guard.
    const jobAt = [
      backgroundJobOf({ state: "queued" }),
      backgroundJobOf({ state: "running", processed: 2, total: 5 }),
      backgroundJobOf({ state: "succeeded", processed: 5, total: 5 }),
    ];
    let poll = 0;
    handlers.push((request) => {
      if (request.method !== "GET" || !/\/background-jobs\//.test(new URL(request.url).pathname)) {
        return undefined;
      }
      const body = jobAt[Math.min(poll, jobAt.length - 1)];
      poll += 1;
      return { status: 200, body };
    });

    // `screen.findByRole` and `userEvent` both wait on the *native*
    // `setTimeout`, unaware that it is now fake; `fireEvent` is synchronous
    // and needs no timer at all, and `vi.waitFor` pumps the fake clock on
    // every check it makes, which is what lets React Query's own
    // `setTimeout(fn, 0)` notification (`notifyManager`) actually fire.
    //
    // Waiting for *enabled*, not merely present: the submit button renders
    // immediately but stays `disabled` until `useConnections` resolves and
    // picks a default candidate, and a click on a disabled native button is
    // a silent no-op rather than a refusal to render one.
    async function press(name: RegExp): Promise<void> {
      const button = await vi.waitFor(() => {
        const found = screen.queryByRole("button", { name }) as HTMLButtonElement | null;
        if (found === null) throw new Error(`button ${name} not yet rendered`);
        if (found.disabled) throw new Error(`button ${name} still disabled`);
        return found;
      });
      fireEvent.click(button);
    }

    await press(/pre-label/i);
    await press(/start/i);

    const batchGets = () =>
      sent.filter((r) => r.method === "GET" && new URL(r.url).pathname === `/batches/${BATCH}`).length;

    // The launch's own invalidation (on the 202) plus the first poll read,
    // "queued" — nothing about the settle-time invalidation has run yet.
    await vi.waitFor(() => expect(poll).toBeGreaterThanOrEqual(1));
    const afterLaunch = batchGets();

    // One interval: queued -> running. Still not settled, so the guard must
    // not have fired.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(poll).toBe(2));
    expect(batchGets()).toBe(afterLaunch);

    // The second interval: running -> succeeded. This is the transition the
    // `settled` guard exists for, and the batch and its assets should be
    // re-read because of it.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(poll).toBe(3));
    await vi.waitFor(() => expect(batchGets()).toBe(afterLaunch + 1));

    // Further ticks: `isSettled` stops the poll itself, and even if it did
    // not, the guard would not fire a second time.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(poll).toBe(3);
    expect(batchGets()).toBe(afterLaunch + 1);
  } finally {
    vi.useRealTimers();
  }
});

/**
 * The four-mode redesign: a Start that cannot be a no-op, a Done that says
 * what happened and points forward, and a segment filter it can actually set.
 */

it("disables the start press when nothing untouched remains", async () => {
  renderGallery({ allowed_actions: ["pre_label"] }, { counts: { unannotated: 0, total: 48 } });
  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));

  const submit = (await screen.findByTestId("prelabel-submit")) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
});

it("says there is nothing left to run, rather than a count of zero", async () => {
  renderGallery({ allowed_actions: ["pre_label"] }, { counts: { unannotated: 0, total: 48 } });
  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));

  expect(await screen.findByText(/nothing left for a run to touch/i)).not.toBeNull();
  expect(screen.queryByText(/0 of 48/)).toBeNull();
});

it("offers Review these frames once a run succeeds, and sets the segment filter", async () => {
  on("GET", /\/background-jobs\//, {
    status: 200,
    body: backgroundJobOf({
      state: "succeeded",
      processed: 48,
      total: 48,
      result: {
        assets_labeled: 48,
        annotations_written: 120,
        regions_discarded: 0,
        assets_skipped: 0,
        stopped_early: false,
      },
    }),
  });
  renderGallery({ allowed_actions: ["pre_label"] });

  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));
  await userEvent.click(await screen.findByRole("button", { name: /start/i }));

  const review = await screen.findByRole("button", { name: /review these frames/i });
  // The run just finished: re-running it is not the primary action any more.
  expect(screen.queryByRole("button", { name: /^start$/i })).toBeNull();
  await userEvent.click(review);

  expect(screen.getByTestId("segment-review").getAttribute("aria-pressed")).toBe("true");
});

it("says how many regions a run discarded, in words, when it discarded any", async () => {
  on("GET", /\/background-jobs\//, {
    status: 200,
    body: backgroundJobOf({
      state: "succeeded",
      result: {
        assets_labeled: 40,
        annotations_written: 90,
        regions_discarded: 3,
        assets_skipped: 0,
        stopped_early: false,
      },
    }),
  });
  renderGallery({ allowed_actions: ["pre_label"] });

  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));
  await userEvent.click(await screen.findByRole("button", { name: /start/i }));

  const discarded = await screen.findByTestId("prelabel-discarded");
  expect(discarded.textContent).toMatch(/3 regions/);
});

it("says nothing about discarded regions when a run discarded none", async () => {
  on("GET", /\/background-jobs\//, {
    status: 200,
    body: backgroundJobOf({
      state: "succeeded",
      result: {
        assets_labeled: 40,
        annotations_written: 90,
        regions_discarded: 0,
        assets_skipped: 0,
        stopped_early: false,
      },
    }),
  });
  renderGallery({ allowed_actions: ["pre_label"] });

  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));
  await userEvent.click(await screen.findByRole("button", { name: /start/i }));

  await screen.findByRole("button", { name: /review these frames/i });
  expect(screen.queryByTestId("prelabel-discarded")).toBeNull();
  expect(screen.queryByText(/^0$/)).toBeNull();
});

/**
 * Reopening the dialog with no job id of its own: `BatchOut.pre_label_run` is
 * the only way it can know what happened, on `ConnectionJob`'s reasoning for a
 * connection's download. Three prior outcomes, three verbs — none of them
 * `Start`.
 */

it("on reopen after a cancelled run, states the prior outcome and offers Continue", async () => {
  renderGallery(
    {
      allowed_actions: ["pre_label"],
      pre_label_run: preLabelRunOf({
        state: "cancelled",
        assets_processed: 12,
        assets_total: 48,
        stopped_early: true,
        assets_labeled: 9,
      }),
    },
    { counts: { unannotated: 36, total: 48 } },
  );

  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));

  expect(await screen.findByText(/laboured over 12 of 48 assets and stopped/i)).not.toBeNull();
  expect(await screen.findByText(/36 assets remain untouched/i)).not.toBeNull();
  expect(screen.queryByRole("button", { name: /^start$/i })).toBeNull();

  const resume = (await screen.findByRole("button", { name: /^continue$/i })) as HTMLButtonElement;
  // Asserted directly: a disabled native button silently no-ops a click, so
  // clicking it and finding nothing happened would pass whether or not it was
  // actually enabled.
  expect(resume.disabled).toBe(false);
});

it("on reopen after a failed run, shows the handler's error and offers Try again", async () => {
  renderGallery(
    {
      allowed_actions: ["pre_label"],
      pre_label_run: preLabelRunOf({
        state: "failed",
        assets_processed: 5,
        assets_total: 48,
        error: "the model server is unreachable",
        stopped_early: null,
        assets_labeled: null,
        regions_discarded: null,
      }),
    },
    { counts: { unannotated: 43, total: 48 } },
  );

  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));

  expect(await screen.findByText("the model server is unreachable")).not.toBeNull();
  expect(await screen.findByText(/reached 5 of 48 assets before stopping/i)).not.toBeNull();
  expect(screen.queryByRole("button", { name: /^start$/i })).toBeNull();

  const retry = (await screen.findByRole("button", { name: /try again/i })) as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
});

it("on reopen after a complete run, disables Start with its reason adjacent and offers Review", async () => {
  renderGallery(
    {
      allowed_actions: ["pre_label"],
      pre_label_run: preLabelRunOf({
        state: "succeeded",
        assets_processed: 48,
        assets_total: 48,
        error: null,
        stopped_early: false,
        assets_labeled: 48,
        regions_discarded: 0,
      }),
    },
    { counts: { unannotated: 0, total: 48 } },
  );

  await userEvent.click(await screen.findByRole("button", { name: /pre-label/i }));

  const start = (await screen.findByTestId("prelabel-submit")) as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  const reason = await screen.findByTestId("prelabel-blocked-reason");
  expect(reason.textContent).toMatch(/pre-labeled/i);

  const review = await screen.findByRole("button", { name: /review these frames/i });
  await userEvent.click(review);
  expect(screen.getByTestId("segment-review").getAttribute("aria-pressed")).toBe("true");
});
