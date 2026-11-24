/**
 * Two steps behind one control, and what the control says when the second
 * step refuses.
 *
 * The claim these tests make is about *rendering*, not about the kernel: the
 * two requests go out in order, the first step's outcome stays on screen as a
 * line, and a refusal of the second step is said beneath it in the shared
 * vocabulary rather than in its place. The refusal itself still comes from the
 * server — every path here stubs the answer, never the question.
 */

import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CompleteBatchButton,
} from "./ComposedTransitions";
import type { Batch } from "./queries";
import { renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { batchActions } from "../testing/wire.fixtures.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "55555555-5555-4555-8555-555555555555";
const JOB = "77777777-7777-4777-8777-777777777777";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
const sent: Request[] = [];
const bodies = new Map<Request, string>();

beforeEach(() => {
  // The confirmation's Switch and the tooltips measure themselves through it.
  stubResizeObserver();
  handlers = [];
  sent.length = 0;
  bodies.clear();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    sent.push(request);
    if (request.method !== "GET") bodies.set(request, await request.clone().text());
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) {
        return new Response(JSON.stringify(answer.body ?? null), {
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

afterEach(() => vi.unstubAllGlobals());

function on(method: string, pattern: RegExp, answer: Answer): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname) ? answer : undefined,
  );
}

const NO_PROGRESS = {
  unannotated: 0,
  pre_labeled: 0,
  annotated: 0,
  skipped: 0,
  review_pending: 0,
  accepted: 0,
  total: 0,
};

function batch(overrides: Partial<Batch> = {}): Batch {
  const state = overrides.state ?? "draft";
  return {
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state,
    schema_version: null,
    asset_count: 3,
    progress: { ...NO_PROGRESS, unannotated: 3, total: 3 },
    allowed_actions: batchActions(state),
    promoted_asset_count: 0,
    parent_batch_id: null,
    pre_label_run: null,
    ...overrides,
  } as Batch;
}

function posts(): string[] {
  return sent.filter((r) => r.method === "POST").map((r) => new URL(r.url).pathname);
}

describe("Complete, and maybe add to the dataset", () => {
  const settled = batch({
    state: "in_annotation",
    schema_version: 3,
    progress: { ...NO_PROGRESS, annotated: 3, total: 3 },
    promoted_asset_count: 3,
  });
  const completed = batch({
    state: "completed",
    schema_version: 3,
    progress: settled.progress,
    promoted_asset_count: 3,
  });
  const job = {
    id: JOB,
    batch_id: BATCH,
    state: "completed",
    asset_count: 3,
    assignee: null,
    pre_label_run: null,
    allowed_actions: [],
  };
  const assets = (count: number) => ({
    items: Array.from({ length: count }, (_, at) => ({
      id: `asset-${at}`,
      project_id: PROJECT,
      modality: "image",
      point_cloud: null,
      content_hash: `${at}`.padStart(8, "0") + "deadbeef",
      width: 1,
      height: 1,
      format: "jpeg",
      source_id: null,
      frame_index: at,
      frame_timestamp: null,
      thumbnail_hash: null,
      ingested_at: "2026-08-01T09:00:00Z",
    })),
    total: count,
  });

  /** The switch remembers its last answer for the session, so each test says its own. */
  async function openConfirm(wantAdd: boolean): Promise<void> {
    await userEvent.click(screen.getByTestId("complete-drive-01"));
    const toggle = await screen.findByTestId("complete-add");
    if ((toggle.getAttribute("aria-checked") === "true") !== wantAdd) await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe(String(wantAdd));
  }

  it("asks first: pressing Complete opens the confirmation and sends nothing", async () => {
    renderWithData(<CompleteBatchButton batch={settled} projectId={PROJECT} />);

    await userEvent.click(screen.getByTestId("complete-drive-01"));

    const confirm = await screen.findByTestId("complete-confirm");
    expect(confirm.textContent).toContain("Complete this batch?");
    expect(confirm.textContent).toContain("Add the labeled images to the dataset");
    expect(posts()).toEqual([]);
  });

  it("with the switch on, completes then promotes, and says what the press moved", async () => {
    on("GET", /\/jobs$/, { status: 200, body: { items: [job], total: 1 } });
    on("POST", /\/complete$/, { status: 200, body: completed });
    on("POST", /\/promote$/, { status: 200, body: assets(3) });
    const openDataset = vi.fn();
    renderWithData(<CompleteBatchButton batch={settled} projectId={PROJECT} onOpenDataset={openDataset} />);

    await openConfirm(true);
    await userEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() =>
      expect(posts()).toEqual([`/batches/${BATCH}/complete`, `/batches/${BATCH}/promote`]),
    );
    const line = await screen.findByTestId("completed-drive-01");
    await waitFor(() =>
      expect(line.textContent).toBe("Completed. Added 3 assets to the dataset."),
    );
    await userEvent.click(screen.getByTestId("complete-promote-open-dataset-drive-01"));
    expect(openDataset).toHaveBeenCalledOnce();
  });

  it("with the switch off, completes and nothing else, and says nothing is in the dataset yet", async () => {
    on("GET", /\/jobs$/, { status: 200, body: { items: [job], total: 1 } });
    on("POST", /\/complete$/, { status: 200, body: completed });
    renderWithData(<CompleteBatchButton batch={settled} projectId={PROJECT} onOpenDataset={vi.fn()} />);

    await openConfirm(false);
    await userEvent.click(screen.getByTestId("complete-submit"));

    const line = await screen.findByTestId("completed-drive-01");
    expect(line.textContent).toBe("Completed. Nothing is in the dataset yet.");
    expect(posts()).toEqual([`/batches/${BATCH}/complete`]);
    expect(screen.queryByTestId("complete-promote-open-dataset-drive-01")).toBeNull();
  });

  it("sends nothing when Cancel is pressed", async () => {
    renderWithData(<CompleteBatchButton batch={settled} projectId={PROJECT} />);

    await openConfirm(true);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByTestId("complete-confirm")).toBeNull());
    expect(posts()).toEqual([]);
    expect(screen.queryByTestId("completed-drive-01")).toBeNull();
  });

  it("keeps the completion on screen and says the refusal beneath it when promotion is refused", async () => {
    on("GET", /\/jobs$/, { status: 200, body: { items: [job], total: 1 } });
    on("POST", /\/complete$/, { status: 200, body: completed });
    on("POST", /\/promote$/, {
      status: 409,
      body: { code: "BATCH_NOT_COMPLETE", message: "batch 'drive-01' is 'in_annotation'" },
    });
    renderWithData(<CompleteBatchButton batch={settled} projectId={PROJECT} />);

    await openConfirm(true);
    await userEvent.click(screen.getByTestId("complete-submit"));

    const said = await screen.findByTestId("complete-promote-error-drive-01");
    expect(said.textContent).toContain("still unfinished");
    expect(said.textContent).not.toContain("BATCH_NOT_COMPLETE");
    expect(screen.getByTestId("completed-drive-01").textContent).toBe("Completed.");
    expect(screen.queryByTestId("complete-promote-open-dataset-drive-01")).toBeNull();
  });

  it("is withheld while frames are outstanding, and the count is the tooltip's reason", async () => {
    renderWithData(
      <CompleteBatchButton batch={batch({ state: "in_annotation", schema_version: 3 })} projectId={PROJECT} />,
    );
    const control = screen.getByTestId("complete-drive-01") as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-label")).toBe("Complete batch");
    // A disabled button fires no focus event, so the reason hangs off its focusable wrapper.
    await userEvent.tab();
    expect((await screen.findAllByText("3 frames still to annotate or skip")).length).toBeGreaterThan(0);
    await userEvent.click(control);
    expect(screen.queryByTestId("complete-confirm")).toBeNull();
  });

  it("is not offered on a batch that does not declare complete", () => {
    renderWithData(<CompleteBatchButton batch={completed} projectId={PROJECT} />);
    expect(screen.queryByTestId("complete-drive-01")).toBeNull();
  });
});
