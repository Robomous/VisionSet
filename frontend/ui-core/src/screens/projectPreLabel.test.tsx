/**
 * The Batches tab's project-wide launch: offered off the wire, the checklist
 * defaults to what has work, and the POST carries exactly what was checked.
 *
 * Reuses the fetch-stub harness `preLabel.test.tsx` established — `on`, `mount`,
 * a `handlers` array consulted in registration order — copied rather than shared,
 * so the two suites stay independent files.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { BatchesScreen } from "./BatchesScreen";
import { batchActions } from "../testing/wire.fixtures.js";
import type { Connection } from "../data/inferenceQueries";

const API = "http://api.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OPEN = "22222222-2222-4222-8222-222222222222";
const OPEN_EMPTY = "33333333-3333-4333-8333-333333333333";
const DRAFT = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";

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
  pre_labeled: 0,
  annotated: 0,
  skipped: 0,
  review_pending: 0,
  accepted: 0,
  total: 0,
};

/** A full `ConnectionOut`, on `models.test.tsx`'s fixture — every field the check reads. */
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
    provider_id: "sam",
    credential_env: null,
    origin: "huggingface",
    setup_state: "ready",
    allowed_actions: ["update", "delete"],
    capabilities: ["text_detect"],
    produces: ["bbox", "polygon"],
    download: null,
    integrity_check: null,
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

function batch(id: string, name: string, state: "in_annotation" | "draft", unannotated: number) {
  return {
    id,
    project_id: PROJECT,
    name,
    state,
    schema_version: state === "draft" ? null : 1,
    asset_count: 10,
    progress: { ...NO_PROGRESS, total: 10, unannotated },
    allowed_actions: batchActions(state),
    promoted_asset_count: 0,
    parent_batch_id: null,
    pre_label_run: null,
  };
}

/**
 * A full `PreLabelPlanOut`, answered from the selection the request carries the
 * way the server does: `produces` is the selection, and a polygon-only class is
 * left out once polygons are.
 */
function planFor(request: Request): Answer {
  const selected = new URL(request.url).searchParams.getAll("geometries");
  const produces = selected.length === 0 ? ["bbox", "polygon"] : selected;
  const lane = produces.includes("polygon") ? [] : [{ name: "lane", reasons: ["no_producible_geometry"] }];
  return {
    status: 200,
    body: {
      schema_version: 1,
      asked_classes: produces.includes("polygon") ? ["person", "lane"] : ["person"],
      produces,
      excluded_classes: [{ name: "vehicle", reasons: ["required_attribute"] }, ...lane],
    },
  };
}

function stubBatches(items: unknown[], connections: readonly Connection[] = [connectionOf()]): void {
  on("GET", new RegExp(`/projects/${PROJECT}/batches$`), {
    status: 200,
    body: { items, total: items.length },
  });
  on("GET", /\/inference\/connections$/, {
    status: 200,
    body: { items: connections, total: connections.length },
  });
  handlers.push((request) =>
    request.method === "GET" && /\/pre-label$/.test(new URL(request.url).pathname)
      ? planFor(request)
      : undefined,
  );
}

function renderBatches(): void {
  render(mount(<BatchesScreen projectId={PROJECT} onOpenBatch={() => undefined} />));
}

/** The text an element renders, for the assertions jest-dom would otherwise carry. */
function textOf(element: HTMLElement): string {
  return element.textContent ?? "";
}

it("offers the project launch only when some batch declares pre_label", async () => {
  stubBatches([batch(DRAFT, "draft-01", "draft", 0)]);
  renderBatches();
  await screen.findByTestId("batches-table");
  expect(screen.queryByTestId("project-prelabel")).toBeNull();
});

it("checks every open batch with untouched assets by default and posts exactly those", async () => {
  stubBatches([
    batch(OPEN, "drive-01", "in_annotation", 8),
    batch(OPEN_EMPTY, "drive-02", "in_annotation", 0),
    batch(DRAFT, "draft-01", "draft", 0),
  ]);
  on("POST", new RegExp(`/projects/${PROJECT}/batches/pre-label$`), {
    status: 202,
    body: {
      items: [
        {
          batch_id: OPEN,
          batch_name: "drive-01",
          joined: false,
          job: {
            id: JOB,
            type: "annotation.pre_label",
            state: "queued",
            processed: 0,
            total: 8,
            failures: [],
            error: null,
            error_code: null,
            result: {},
            cancel_requested: false,
            attempt: 0,
            created_at: "2026-08-21T00:00:00Z",
            started_at: null,
            finished_at: null,
          },
        },
      ],
      total: 1,
    },
  });
  renderBatches();
  await userEvent.click(await screen.findByTestId("project-prelabel"));
  const dialog = await screen.findByTestId("project-prelabel-dialog");
  expect(dialog).toBeTruthy();
  expect((screen.getByTestId(`prelabel-pick-${OPEN}`) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByTestId(`prelabel-pick-${OPEN_EMPTY}`) as HTMLInputElement).checked).toBe(
    false,
  );
  expect(screen.queryByTestId(`prelabel-pick-${DRAFT}`)).toBeNull();
  expect(screen.getByText(/8 untouched/)).toBeTruthy();

  await userEvent.click(screen.getByTestId("project-prelabel-start"));

  const posted = sent.find(
    (request) => request.method === "POST" && request.url.endsWith("/batches/pre-label"),
  );
  expect(posted).toBeDefined();
  expect(await posted!.clone().json()).toEqual({
    connection_id: connectionOf().id,
    minimum_confidence: 0.35,
    batch_ids: [OPEN],
    geometries: ["bbox", "polygon"],
  });
  const result = await screen.findByTestId("project-prelabel-result");
  expect(textOf(result)).toMatch(/drive-01/);
  expect(textOf(result)).toMatch(/queued/i);
});

it("cannot start with nothing checked", async () => {
  stubBatches([batch(OPEN, "drive-01", "in_annotation", 8)]);
  renderBatches();
  await userEvent.click(await screen.findByTestId("project-prelabel"));
  await screen.findByTestId("project-prelabel-dialog");

  const start = (): HTMLButtonElement =>
    screen.getByTestId("project-prelabel-start") as HTMLButtonElement;
  // Waited for rather than asserted straight away, so what follows cannot pass
  // for the connection's reason: Start is dead while `useConnections` is still
  // in flight, whatever is checked.
  await waitFor(() => expect(start().disabled).toBe(false));

  await userEvent.click(screen.getByTestId(`prelabel-pick-${OPEN}`));
  expect(start().disabled).toBe(true);

  await userEvent.click(screen.getByTestId(`prelabel-pick-${OPEN}`));
  expect(start().disabled).toBe(false);
});

it("renders a refusal as prose", async () => {
  stubBatches([batch(OPEN, "drive-01", "in_annotation", 8)]);
  on("POST", new RegExp(`/projects/${PROJECT}/batches/pre-label$`), {
    status: 409,
    body: {
      code: "SCHEMA_HAS_NO_DETECTABLE_CLASS",
      message:
        "batch 'drive-01': schema version 1 declares no class that a box can be written as",
    },
  });
  renderBatches();
  await userEvent.click(await screen.findByTestId("project-prelabel"));
  await screen.findByTestId("project-prelabel-dialog");
  await userEvent.click(screen.getByTestId("project-prelabel-start"));
  const refusal = await screen.findByTestId("project-prelabel-error");
  expect(textOf(refusal)).toMatch(/drive-01/);
  expect(textOf(refusal)).toMatch(/no class that a box can be written as/);
});

it("marks a batch whose remembered run is live", async () => {
  stubBatches([
    {
      ...batch(OPEN, "drive-01", "in_annotation", 8),
      pre_label_run: {
        job_id: JOB,
        state: "running",
        assets_processed: 3,
        assets_total: 8,
        error: null,
        error_code: null,
        stopped_early: null,
        assets_labeled: null,
        regions_discarded: null,
        regions_out_of_bounds: null,
        annotations_replaced: null,
      },
    },
  ]);
  renderBatches();
  expect(await screen.findByTestId(`prelabel-live-${OPEN}`)).toBeTruthy();
});

// --- what each run would ask for and write, and which shapes ---------------------

it("names what each batch's run would ask for and write, beside the batch", async () => {
  stubBatches([
    batch(OPEN, "drive-01", "in_annotation", 8),
    batch(OPEN_EMPTY, "drive-02", "in_annotation", 0),
  ]);
  renderBatches();
  await userEvent.click(await screen.findByTestId("project-prelabel"));
  await screen.findByTestId("project-prelabel-dialog");

  const asked = await screen.findAllByTestId("prelabel-asked-classes");
  expect(asked).toHaveLength(2);
  expect(textOf(asked[0]!)).toBe("Asks for person, lane.");
  expect(textOf(screen.getAllByTestId("prelabel-produces")[0]!)).toBe("Writes boxes or polygons.");
  expect(textOf(screen.getAllByTestId("prelabel-excluded-classes")[0]!)).toBe(
    "Not asked for: vehicle (requires an attribute a prediction cannot supply).",
  );
});

it("offers a ticked checkbox per shape, re-reads every plan for the selection, and posts it", async () => {
  stubBatches([batch(OPEN, "drive-01", "in_annotation", 8)]);
  on("POST", new RegExp(`/projects/${PROJECT}/batches/pre-label$`), {
    status: 202,
    body: { items: [], total: 0 },
  });
  renderBatches();
  await userEvent.click(await screen.findByTestId("project-prelabel"));
  await screen.findByTestId("project-prelabel-dialog");
  const boxes = (await screen.findByTestId("prelabel-shape-bbox")) as HTMLInputElement;
  const polygons = screen.getByTestId("prelabel-shape-polygon") as HTMLInputElement;
  expect(boxes.checked).toBe(true);
  expect(polygons.checked).toBe(true);
  await screen.findByTestId("prelabel-asked-classes");

  await userEvent.click(polygons);

  await waitFor(() =>
    expect(textOf(screen.getByTestId("prelabel-produces"))).toBe("Writes boxes."),
  );
  expect(textOf(screen.getByTestId("prelabel-excluded-classes"))).toContain(
    "lane (no shape this model produces)",
  );

  await userEvent.click(screen.getByTestId("project-prelabel-start"));
  const posted = sent.find(
    (request) => request.method === "POST" && request.url.endsWith("/batches/pre-label"),
  );
  expect(posted).toBeDefined();
  expect(((await posted!.clone().json()) as { geometries: unknown }).geometries).toEqual(["bbox"]);
});

it("cannot start with no shape ticked, and says why", async () => {
  stubBatches([batch(OPEN, "drive-01", "in_annotation", 8)]);
  renderBatches();
  await userEvent.click(await screen.findByTestId("project-prelabel"));
  await screen.findByTestId("project-prelabel-dialog");
  const start = (): HTMLButtonElement =>
    screen.getByTestId("project-prelabel-start") as HTMLButtonElement;
  await waitFor(() => expect(start().disabled).toBe(false));

  await userEvent.click(screen.getByTestId("prelabel-shape-bbox"));
  await userEvent.click(screen.getByTestId("prelabel-shape-polygon"));

  expect(start().disabled).toBe(true);
  expect(textOf(await screen.findByTestId("prelabel-shapes-error"))).toMatch(/at least one shape/i);
});

it("shows no shape control for a model that writes one shape, and sends no selection", async () => {
  stubBatches(
    [batch(OPEN, "drive-01", "in_annotation", 8)],
    [connectionOf({ produces: ["bbox"] })],
  );
  on("POST", new RegExp(`/projects/${PROJECT}/batches/pre-label$`), {
    status: 202,
    body: { items: [], total: 0 },
  });
  renderBatches();
  await userEvent.click(await screen.findByTestId("project-prelabel"));
  await screen.findByTestId("project-prelabel-dialog");
  await screen.findByTestId("prelabel-asked-classes");

  expect(screen.queryByTestId("prelabel-shapes")).toBeNull();
  await userEvent.click(screen.getByTestId("project-prelabel-start"));
  const posted = sent.find(
    (request) => request.method === "POST" && request.url.endsWith("/batches/pre-label"),
  );
  expect(await posted!.clone().json()).toEqual({
    connection_id: connectionOf().id,
    minimum_confidence: 0.35,
    batch_ids: [OPEN],
  });
});

it("will not start while a checked batch's plan is refused, and names it", async () => {
  stubBatches([
    batch(OPEN, "drive-01", "in_annotation", 8),
    batch(OPEN_EMPTY, "drive-02", "in_annotation", 0),
  ]);
  handlers.unshift((request) =>
    request.method === "GET" &&
    /\/pre-label$/.test(new URL(request.url).pathname) &&
    request.url.includes(OPEN)
      ? {
          status: 409,
          body: {
            code: "SCHEMA_HAS_NO_DETECTABLE_CLASS",
            message: "schema version 1 declares no class that a box can be written as",
          },
        }
      : undefined,
  );
  renderBatches();
  await userEvent.click(await screen.findByTestId("project-prelabel"));
  await screen.findByTestId("project-prelabel-dialog");

  expect(textOf(await screen.findByTestId("prelabel-plan-error"))).toMatch(
    /no class that a box can be written as/,
  );
  const start = (): HTMLButtonElement =>
    screen.getByTestId("project-prelabel-start") as HTMLButtonElement;
  expect(start().disabled).toBe(true);
  expect(textOf(screen.getByTestId("project-prelabel-blocked"))).toMatch(/drive-01/);

  // Unchecking the refused batch lifts the block, and checking the other keeps it up.
  await userEvent.click(screen.getByTestId(`prelabel-pick-${OPEN}`));
  await userEvent.click(screen.getByTestId(`prelabel-pick-${OPEN_EMPTY}`));
  await waitFor(() => expect(start().disabled).toBe(false));
});

