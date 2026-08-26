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

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import {
  ApproveAndStartButton,
  CompleteAndPromoteButton,
  OutcomeNextStep,
} from "./ComposedTransitions";
import type { Batch } from "./queries";
import { batchActions } from "../testing/wire.fixtures.js";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "55555555-5555-4555-8555-555555555555";
const JOB = "77777777-7777-4777-8777-777777777777";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
const sent: Request[] = [];
const bodies = new Map<Request, string>();

beforeEach(() => {
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

const SCHEMA = { project_id: PROJECT, version: 3, classes: [] };
function schemaExists(exists: boolean): void {
  on(
    "GET",
    /\/projects\/[^/]+\/schema$/,
    exists
      ? { status: 200, body: SCHEMA }
      : { status: 404, body: { code: "SCHEMA_NOT_FOUND", message: "none yet" } },
  );
}

describe("Approve and start", () => {
  const approved = batch({ state: "approved", schema_version: 3 });
  const started = batch({ state: "in_annotation", schema_version: 3 });

  it("approves as one job, then starts, and says both landed", async () => {
    schemaExists(true);
    on("POST", /\/approve$/, { status: 200, body: approved });
    on("POST", /\/start$/, { status: 200, body: started });
    render(mount(<ApproveAndStartButton batch={batch()} projectId={PROJECT} />));

    await userEvent.click(await screen.findByTestId("approve-start-drive-01"));

    await waitFor(() =>
      expect(posts()).toEqual([`/batches/${BATCH}/approve`, `/batches/${BATCH}/start`]),
    );
    // One job for the whole batch, said outright rather than left to a default.
    const approve = sent.find((r) => r.method === "POST")!;
    expect(JSON.parse(bodies.get(approve) ?? "")).toEqual({ partition: { kind: "single" } });
    const line = await screen.findByTestId("approved-drive-01");
    await waitFor(() =>
      expect(line.textContent).toBe("Approved against v3, and open for annotation."),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the approval on screen and says the refusal beneath it when the start is refused", async () => {
    schemaExists(true);
    on("POST", /\/approve$/, { status: 200, body: approved });
    on("POST", /\/start$/, {
      status: 409,
      body: { code: "INVALID_TRANSITION", message: "batch 'drive-01' is 'approved'" },
    });
    render(mount(<ApproveAndStartButton batch={batch()} projectId={PROJECT} />));

    await userEvent.click(await screen.findByTestId("approve-start-drive-01"));

    const said = await screen.findByTestId("approve-start-error-drive-01");
    expect(said.textContent).toContain("This has already moved on");
    expect(said.textContent).not.toContain("INVALID_TRANSITION");
    // The first step's outcome is not replaced by the second step's refusal:
    // the batch is `approved`, and the line is what says so.
    expect(screen.getByTestId("approved-drive-01").textContent).toBe("Approved against v3.");
  });

  it("says a refused approval in words, and starts nothing", async () => {
    schemaExists(true);
    on("POST", /\/approve$/, {
      status: 409,
      body: { code: "EMPTY_BATCH", message: "batch 'drive-01' has no assets" },
    });
    render(mount(<ApproveAndStartButton batch={batch()} projectId={PROJECT} />));

    await userEvent.click(await screen.findByTestId("approve-start-drive-01"));

    const said = await screen.findByTestId("approve-start-error-drive-01");
    expect(said.textContent).toContain("This batch has no frames");
    expect(posts()).toEqual([`/batches/${BATCH}/approve`]);
    expect(screen.queryByTestId("approved-drive-01")).toBeNull();
  });

  it("is not offered without an active schema to pin", async () => {
    schemaExists(false);
    render(mount(<ApproveAndStartButton batch={batch()} projectId={PROJECT} />));
    await waitFor(() => expect(sent.some((r) => r.url.endsWith("/schema"))).toBe(true));
    expect(screen.queryByTestId("approve-start-drive-01")).toBeNull();
  });

  it("is not offered on a batch that does not declare approve", async () => {
    schemaExists(true);
    render(mount(<ApproveAndStartButton batch={started} projectId={PROJECT} />));
    await waitFor(() => expect(sent.some((r) => r.url.endsWith("/schema"))).toBe(true));
    expect(screen.queryByTestId("approve-start-drive-01")).toBeNull();
  });
});

describe("Complete and promote", () => {
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

  it("completes, then promotes, and says what the press moved", async () => {
    on("GET", /\/jobs$/, { status: 200, body: { items: [job], total: 1 } });
    on("POST", /\/complete$/, { status: 200, body: completed });
    on("POST", /\/promote$/, { status: 200, body: assets(3) });
    const openDataset = vi.fn();
    render(
      mount(
        <CompleteAndPromoteButton
          batch={settled}
          projectId={PROJECT}
          onOpenDataset={openDataset}
        />,
      ),
    );

    await userEvent.click(screen.getByTestId("complete-promote-drive-01"));

    await waitFor(() =>
      expect(posts()).toEqual([`/batches/${BATCH}/complete`, `/batches/${BATCH}/promote`]),
    );
    const line = await screen.findByTestId("completed-drive-01");
    await waitFor(() =>
      expect(line.textContent).toBe("Completed. Promoted 3 assets to the dataset."),
    );
    await userEvent.click(screen.getByTestId("complete-promote-open-dataset-drive-01"));
    expect(openDataset).toHaveBeenCalledOnce();
  });

  it("keeps the completion on screen and says the refusal beneath it when promotion is refused", async () => {
    on("GET", /\/jobs$/, { status: 200, body: { items: [job], total: 1 } });
    on("POST", /\/complete$/, { status: 200, body: completed });
    on("POST", /\/promote$/, {
      status: 409,
      body: { code: "BATCH_NOT_COMPLETE", message: "batch 'drive-01' is 'in_annotation'" },
    });
    render(mount(<CompleteAndPromoteButton batch={settled} projectId={PROJECT} />));

    await userEvent.click(screen.getByTestId("complete-promote-drive-01"));

    const said = await screen.findByTestId("complete-promote-error-drive-01");
    expect(said.textContent).toContain("still unfinished");
    expect(said.textContent).not.toContain("BATCH_NOT_COMPLETE");
    expect(screen.getByTestId("completed-drive-01").textContent).toBe("Completed.");
    expect(screen.queryByTestId("complete-promote-open-dataset-drive-01")).toBeNull();
  });

  it("is withheld while frames are outstanding, as Complete is", () => {
    render(
      mount(
        <CompleteAndPromoteButton
          batch={batch({ state: "in_annotation", schema_version: 3 })}
          projectId={PROJECT}
        />,
      ),
    );
    expect((screen.getByTestId("complete-promote-drive-01") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("is not offered on a batch that does not declare complete", () => {
    render(mount(<CompleteAndPromoteButton batch={completed} projectId={PROJECT} />));
    expect(screen.queryByTestId("complete-promote-drive-01")).toBeNull();
  });
});

describe("the ingest outcome's next step", () => {
  function draft(): void {
    on("GET", /\/batches\/[^/]+$/, { status: 200, body: batch() });
  }

  it("fills Approve and start when the project has a schema, and steps Open batch down", async () => {
    schemaExists(true);
    draft();
    render(
      mount(
        <OutcomeNextStep projectId={PROJECT} batchId={BATCH} onOpenBatch={vi.fn()} />,
      ),
    );
    const composed = await screen.findByTestId("approve-start-drive-01");
    expect(composed.dataset.variant).toBe("primary");
    expect(screen.getByTestId("open-batch").dataset.variant).toBe("secondary");
    expect(screen.queryByTestId("approve-needs-schema")).toBeNull();
  });

  it("says what approving needs when there is no schema, and keeps Open batch filled", async () => {
    schemaExists(false);
    draft();
    const openSchema = vi.fn();
    render(
      mount(
        <OutcomeNextStep
          projectId={PROJECT}
          batchId={BATCH}
          onOpenBatch={vi.fn()}
          onOpenSchema={openSchema}
        />,
      ),
    );
    const remedy = await screen.findByTestId("approve-needs-schema");
    expect(remedy.textContent).toContain("Approving needs a schema");
    await userEvent.click(screen.getByTestId("approve-needs-schema-go"));
    expect(openSchema).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("approve-start-drive-01")).toBeNull();
    expect(screen.getByTestId("open-batch").dataset.variant).toBe("primary");
  });

  it("offers what it always did when the schema read fails for another reason", async () => {
    on("GET", /\/projects\/[^/]+\/schema$/, {
      status: 500,
      body: { code: "INTERNAL_ERROR", message: "schema is unreachable" },
    });
    draft();
    render(
      mount(
        <OutcomeNextStep projectId={PROJECT} batchId={BATCH} onOpenBatch={vi.fn()} />,
      ),
    );
    await waitFor(() => expect(sent.some((r) => r.url.endsWith("/schema"))).toBe(true));
    expect(screen.queryByTestId("approve-needs-schema")).toBeNull();
    expect(screen.queryByTestId("approve-start-drive-01")).toBeNull();
    expect(screen.getByTestId("open-batch").dataset.variant).toBe("primary");
  });

  it("keeps the approval line when the batch moves on under it", async () => {
    schemaExists(true);
    let state: "draft" | "in_annotation" = "draft";
    handlers.push((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === `/batches/${BATCH}`)
        return { status: 200, body: batch({ state, schema_version: state === "draft" ? null : 3 }) };
      return undefined;
    });
    on("POST", /\/approve$/, { status: 200, body: batch({ state: "approved", schema_version: 3 }) });
    handlers.push((request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/start")) {
        state = "in_annotation";
        return { status: 200, body: batch({ state, schema_version: 3 }) };
      }
      return undefined;
    });
    render(
      mount(
        <OutcomeNextStep projectId={PROJECT} batchId={BATCH} onOpenBatch={vi.fn()} />,
      ),
    );

    await userEvent.click(await screen.findByTestId("approve-start-drive-01"));

    const line = await screen.findByTestId("approved-drive-01");
    await waitFor(() =>
      expect(line.textContent).toBe("Approved against v3, and open for annotation."),
    );
    // The batch no longer declares approve, so the button is gone — and the line
    // that says why is still here.
    await waitFor(() => expect(screen.queryByTestId("approve-start-drive-01")).toBeNull());
    expect(screen.getByTestId("approved-drive-01")).toBeTruthy();
  });
});
