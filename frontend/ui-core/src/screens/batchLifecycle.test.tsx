/**
 * The approve dialog's refusal surface.
 *
 * `ApproveDialog` is otherwise tested only through its host screens, and the
 * claim this file exists for is one those tests do not make: **the rendering of a
 * refusal branches on the error `code`, and exactly one code earns a
 * translation.** `SCHEMA_NOT_FOUND` has a remedy a person can act on — define
 * labels — so it is said in their words with the way there beside it. Every
 * other code keeps the raw `{code}: {message}`, which is what a bug report
 * should quote; a dialog that reworded them all would be a second spelling of
 * the API's whole error surface.
 *
 * The refusal still comes from the server. These tests stub the *response*,
 * never the question — the approve request goes out on every path.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { ApproveDialog } from "./BatchLifecycle";
import type { Batch } from "./queries";
import { batchActions } from "../testing/wire.fixtures.js";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "55555555-5555-4555-8555-555555555555";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
const sent: Request[] = [];

beforeEach(() => {
  handlers = [];
  sent.length = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    sent.push(request);
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) {
        return Promise.resolve(
          new Response(JSON.stringify(answer.body ?? null), {
            status: answer.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }
    return Promise.resolve(
      new Response(JSON.stringify({ code: "NO_STUB", message: request.url }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
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

const DRAFT: Batch = {
  id: BATCH,
  project_id: PROJECT,
  name: "drive-01",
  state: "draft",
  schema_version: null,
  asset_count: 48,
  allowed_actions: batchActions("draft"),
  promoted_asset_count: 0,
  parent_batch_id: null,
  progress: {
    unannotated: 48,
    annotated: 0,
    skipped: 0,
    review_pending: 0,
    accepted: 0,
    total: 48,
  },
};

describe("the approve dialog's refusals", () => {
  it("says SCHEMA_NOT_FOUND in a person's words, with the way to the schema", async () => {
    on("POST", /\/approve$/, {
      status: 404,
      body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
    });
    const opened = vi.fn();
    const closed = vi.fn();
    render(mount(<ApproveDialog batch={DRAFT} onClose={closed} onOpenSchema={opened} />));

    await userEvent.click(screen.getByTestId("approve-submit"));

    const said = (await screen.findByTestId("approve-schema-missing")).textContent ?? "";
    expect(said).toContain("no labels yet");
    // The remedy, not the identifier: the code stays out of this one rendering.
    expect(said).not.toContain("SCHEMA_NOT_FOUND");
    // And the request really went out — the server refused, nothing pre-checked.
    expect(sent.some((request) => request.method === "POST")).toBe(true);

    await userEvent.click(screen.getByTestId("approve-go-schema"));
    expect(opened).toHaveBeenCalledOnce();
    // The dialog steps aside so the editor it points at is visible on arrival.
    expect(closed).toHaveBeenCalledOnce();
  });

  it("renders the sentence without a link when the host has nowhere to send anybody", async () => {
    on("POST", /\/approve$/, {
      status: 404,
      body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
    });
    render(mount(<ApproveDialog batch={DRAFT} onClose={vi.fn()} />));

    await userEvent.click(screen.getByTestId("approve-submit"));

    await screen.findByTestId("approve-schema-missing");
    expect(screen.queryByTestId("approve-go-schema")).toBeNull();
  });

  it("says every other refusal in prose too, without the remedy that is specific to one", async () => {
    // **This asserted the raw `{code}: {message}` and now asserts the opposite.**
    // A kernel identifier in front of a user is not an error message (F16); what
    // it is good for is a bug report, so it moved to the `title` and the badge
    // carries the sentence. The vocabulary is shared, so this code reads the same
    // here as it does on the ingest form and in the gallery.
    on("POST", /\/approve$/, {
      status: 409,
      body: { code: "BATCH_NOT_EDITABLE", message: "drive-01 is already approved." },
    });
    render(mount(<ApproveDialog batch={DRAFT} onClose={vi.fn()} onOpenSchema={vi.fn()} />));

    await userEvent.click(screen.getByTestId("approve-submit"));

    const error = await screen.findByTestId("approve-error");
    expect(error.textContent).toContain("can no longer be edited");
    expect(error.textContent).not.toContain("BATCH_NOT_EDITABLE");
    // The remedy link belongs to `SCHEMA_NOT_FOUND` alone — one vocabulary, and
    // a screen adds a way onward only where it genuinely has one.
    expect(screen.queryByTestId("approve-schema-missing")).toBeNull();
    expect(screen.queryByTestId("approve-go-schema")).toBeNull();
  });

  it("clears the refusal on success, closing through the ordinary path", async () => {
    on("POST", /\/approve$/, {
      status: 200,
      body: {
        ...DRAFT,
        state: "approved",
        schema_version: 3,
        allowed_actions: batchActions("approved"),
        promoted_asset_count: 0,
        parent_batch_id: null,
      },
    });
    const closed = vi.fn();
    render(mount(<ApproveDialog batch={DRAFT} onClose={closed} onOpenSchema={vi.fn()} />));

    await userEvent.click(screen.getByTestId("approve-submit"));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("approve-schema-missing")).toBeNull();
  });
});
