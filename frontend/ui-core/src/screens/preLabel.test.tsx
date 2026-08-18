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
import { render, screen, waitFor } from "@testing-library/react";
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
