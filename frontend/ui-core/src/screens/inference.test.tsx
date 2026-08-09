/**
 * The Inference section: what it offers, what it refuses to offer, and why.
 *
 * Three claims here that nothing else in the suite makes:
 *
 * 1. **Availability is the wire's.** Every row below declares its own
 *    `allowed_actions`, and the tests that matter are the ones where a declared
 *    action is missing: `Download weights` is not a fact this screen derives from
 *    `setup_state`, it is a fact the server states. A screen that computed it
 *    would be the hand-mirror `ui-capabilities` bans.
 * 2. **The size is read before anything is fetched**, and a machine that cannot
 *    read it says so *in the server's own words* — the install command reaches a
 *    person only if the client stops rewriting the refusal.
 * 3. **The form stays usable when the size is unknown** (design principle 9).
 *    Creating a connection downloads nothing, so not knowing what a download
 *    would cost is not a reason to prevent one being configured.
 *
 * The requests are stubbed, never the questions: every mutation goes out on the
 * path that reaches it, and the refusals come back from the stub.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { InferenceScreen, SUGGESTED_MODEL, SUGGESTED_REVISION, bytes } from "./InferenceScreen";
import type { Connection } from "../data/inferenceQueries";

const API = "http://visionset.test";

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
          new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? null), {
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

function value(node: HTMLElement): string {
  return (node as HTMLInputElement).value;
}

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

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "sam2-local",
    connection_type: "local",
    model_id: SUGGESTED_MODEL,
    model_revision: SUGGESTED_REVISION,
    device: "cuda",
    precision: "fp16",
    endpoint_url: null,
    setup_state: "not_set_up",
    allowed_actions: ["download_weights", "update", "delete"],
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
    ...overrides,
  } as Connection;
}

function listing(rows: readonly Connection[]): void {
  on("GET", /^\/inference\/connections$/, {
    status: 200,
    body: { items: rows, total: rows.length },
  });
}

function job(state: string, processed = 0, total: number | null = null): unknown {
  return {
    id: "job-1",
    type: "download_weights",
    state,
    processed,
    total,
    failures: [],
    error: null,
    result: {},
    cancel_requested: false,
    attempt: 1,
    created_at: "2026-08-08T00:00:00Z",
    started_at: null,
    finished_at: null,
  };
}

function sizeIs(totalBytes: number, fileCount = 3): void {
  on("GET", /^\/inference\/download-size$/, {
    status: 200,
    body: {
      model_id: SUGGESTED_MODEL,
      model_revision: SUGGESTED_REVISION,
      total_bytes: totalBytes,
      file_count: fileCount,
    },
  });
}

// --- the list ------------------------------------------------------------------

it("invites a first connection rather than apologising for having none", async () => {
  listing([]);
  render(mount(<InferenceScreen />));
  expect(await screen.findByText("Connect a model to enable auto-labeling")).not.toBeNull();
  expect(
    screen.getByText(
      "VisionSet never downloads models on its own — you choose what runs and where.",
    ),
  ).not.toBeNull();
});

it("renders a failed listing as a refusal rather than as an empty list", async () => {
  on("GET", /^\/inference\/connections$/, {
    status: 503,
    body: { code: "SERVICE_UNAVAILABLE", message: "The workspace is busy." },
  });
  render(mount(<InferenceScreen />));
  await waitFor(() => expect(screen.queryByTestId("connections-table")).toBeNull());
  expect(screen.queryByText("Connect a model to enable auto-labeling")).toBeNull();
});

it("says the status in words as well as in a token", async () => {
  listing([connection(), connection({ id: "b", name: "remote", setup_state: "ready" })]);
  render(mount(<InferenceScreen />));
  const rows = await screen.findAllByTestId("connection-status");
  expect(rows[0].textContent).toContain("Not set up");
  expect(rows[1].textContent).toContain("Ready");
});

it("shows the model and its revision the way a person reads them", async () => {
  listing([connection()]);
  render(mount(<InferenceScreen />));
  expect(
    await screen.findByText(`${SUGGESTED_MODEL} @ ${SUGGESTED_REVISION}`),
  ).not.toBeNull();
});

it("carries no filter until a list could be long enough to need one", async () => {
  listing([connection()]);
  render(mount(<InferenceScreen />));
  await screen.findByTestId("connections-table");
  expect(screen.queryByTestId("connection-filter")).toBeNull();
});

it("filters by name and keeps saying how many it hid", async () => {
  const many = Array.from({ length: 24 }, (_, index) =>
    connection({ id: `id-${index}`, name: index === 3 ? "needle" : `hay-${index}` }),
  );
  listing(many);
  render(mount(<InferenceScreen />));
  await userEvent.type(await screen.findByTestId("connection-filter"), "need");
  expect(screen.getByTestId("filter-count").textContent).toContain("1 of 24");
  expect(screen.getByTestId("connection-needle")).not.toBeNull();
});

// --- what the wire declares, and only that -------------------------------------

it("offers Download weights only where the wire declares it", async () => {
  listing([connection()]);
  render(mount(<InferenceScreen />));
  expect(await screen.findByTestId("download-weights")).not.toBeNull();
});

it("does not offer Download weights when the wire withholds it", async () => {
  // The identical `setup_state`, so a screen deriving the action from the row's
  // state would still render the button here. Only reading `allowed_actions`
  // gets this right.
  listing([connection({ allowed_actions: ["update", "delete"] })]);
  render(mount(<InferenceScreen />));
  await screen.findByTestId("connections-table");
  expect(screen.queryByTestId("download-weights")).toBeNull();
});

it("offers no overflow at all when neither edit nor delete is declared", async () => {
  listing([connection({ allowed_actions: [] })]);
  render(mount(<InferenceScreen />));
  await screen.findByTestId("connections-table");
  expect(screen.queryByTestId("actions-sam2-local")).toBeNull();
});

it("renders a refused download as prose carrying the install command", async () => {
  listing([connection()]);
  on("POST", /\/download$/, {
    status: 500,
    body: {
      code: "LOCAL_INFERENCE_UNAVAILABLE",
      message:
        'running a model locally needs the local-inference extra. Install it with: pip install "visionset[local-inference]"',
    },
  });
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("download-weights"));
  const shown = await screen.findByTestId("download-error");
  expect(shown.textContent).toContain("LOCAL_INFERENCE_UNAVAILABLE");
  expect(shown.textContent).toContain('pip install "visionset[local-inference]"');
});

it("watches the job a download hands back", async () => {
  listing([connection()]);
  on("POST", /\/download$/, { status: 202, body: job("queued") });
  on("GET", /^\/background-jobs\/job-1$/, { status: 200, body: job("running", 2, 5) });
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("download-weights"));
  expect((await screen.findByTestId("download-progress")).textContent).toContain("2 of 5");
});

// --- creating ------------------------------------------------------------------

it("asks where the model runs before asking anything else", async () => {
  listing([]);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  expect(await screen.findByTestId("choose-type")).not.toBeNull();
  expect(screen.queryByTestId("connection-name")).toBeNull();
});

it("pre-fills the local form with the suggested model", async () => {
  listing([]);
  sizeIs(1_200_000_000);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  expect(value(await screen.findByTestId("connection-model"))).toBe(SUGGESTED_MODEL);
  expect(value(screen.getByTestId("connection-revision"))).toBe(SUGGESTED_REVISION);
});

it("shows the download size before anything is confirmed", async () => {
  listing([]);
  sizeIs(1_200_000_000, 4);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  expect((await screen.findByTestId("size-known")).textContent).toContain("1.2 GB");
  expect(screen.getByTestId("size-known").textContent).toContain("4 files");
  // Nothing has been created and nothing has been fetched at this point.
  expect(sent.some((one) => one.method === "POST")).toBe(false);
});

it("keeps the local form usable when the size cannot be read, and quotes the refusal", async () => {
  listing([]);
  on("GET", /^\/inference\/download-size$/, {
    status: 500,
    body: {
      code: "LOCAL_INFERENCE_UNAVAILABLE",
      message:
        'running a model locally needs the local-inference extra. Install it with: pip install "visionset[local-inference]"',
    },
  });
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  const shown = await screen.findByTestId("size-unavailable");
  expect(shown.textContent).toContain('pip install "visionset[local-inference]"');
  // Principle 9: the form is not disabled by not knowing. Creating downloads
  // nothing, so the unknown size is information rather than a gate.
  await userEvent.type(screen.getByTestId("connection-name"), "sam2");
  expect((screen.getByTestId("connection-submit") as HTMLButtonElement).disabled).toBe(false);
});

it("asks for no size at all for an http connection", async () => {
  listing([]);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-http"));
  await screen.findByTestId("connection-endpoint");
  expect(sent.some((one) => one.url.includes("download-size"))).toBe(false);
});

it("sends only the fields the chosen kind carries", async () => {
  listing([]);
  const bodies: unknown[] = [];
  handlers.push((request) => {
    if (request.method !== "POST" || !request.url.endsWith("/inference/connections")) return;
    return { status: 201, body: connection() };
  });
  on("GET", /^\/inference\/download-size$/, { status: 200, body: null });
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-http"));
  await userEvent.type(await screen.findByTestId("connection-name"), "remote");
  await userEvent.type(screen.getByTestId("connection-model"), "some/model");
  await userEvent.type(screen.getByTestId("connection-revision"), "abc123");
  await userEvent.type(screen.getByTestId("connection-endpoint"), "https://example.invalid");
  await userEvent.click(screen.getByTestId("connection-submit"));
  await waitFor(() =>
    expect(sent.filter((one) => one.method === "POST").length).toBeGreaterThan(0),
  );
  const posted = sent.find((one) => one.method === "POST");
  const body = JSON.parse(await posted!.clone().text()) as Record<string, unknown>;
  bodies.push(body);
  // The domain refuses an http connection carrying a device, so a form that sent
  // everything it held would turn a field somebody switched away from into a 422.
  expect(body.device).toBeNull();
  expect(body.precision).toBeNull();
  expect(body.endpoint_url).toBe("https://example.invalid");
});

it("keeps what was typed when a create is refused", async () => {
  listing([]);
  on("POST", /^\/inference\/connections$/, {
    status: 409,
    body: { code: "ENTITY_ALREADY_EXISTS", message: "That name is taken." },
  });
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-http"));
  await userEvent.type(await screen.findByTestId("connection-name"), "remote");
  await userEvent.type(screen.getByTestId("connection-model"), "some/model");
  await userEvent.type(screen.getByTestId("connection-revision"), "abc123");
  await userEvent.type(screen.getByTestId("connection-endpoint"), "https://example.invalid");
  await userEvent.click(screen.getByTestId("connection-submit"));
  expect((await screen.findByTestId("connection-error")).textContent).toContain("That name is taken.");
  expect(value(screen.getByTestId("connection-name"))).toBe("remote");
});

it("has no credential field, because where a secret lives is still open", async () => {
  listing([]);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-http"));
  await screen.findByTestId("connection-endpoint");
  expect(screen.queryByLabelText(/credential|token|api key|secret/i)).toBeNull();
});

// --- editing and deleting ------------------------------------------------------

it("edits without offering to change the kind", async () => {
  listing([connection({ setup_state: "ready", allowed_actions: ["update", "delete"] })]);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await userEvent.click(await screen.findByTestId("action-edit"));
  expect(value(await screen.findByTestId("connection-name"))).toBe("sam2-local");
  expect(screen.queryByTestId("choose-type")).toBeNull();
});

it("states the blast radius of a delete accurately", async () => {
  listing([connection()]);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await userEvent.click(await screen.findByTestId("action-delete"));
  expect(await screen.findByText("Annotations keep their model provenance; only this configuration is removed.")).not.toBeNull();
});

it("renders a refused delete rather than closing over it", async () => {
  listing([connection()]);
  on("DELETE", /\/inference\/connections\//, {
    status: 404,
    body: { code: "INFERENCE_CONNECTION_NOT_FOUND", message: "It is already gone." },
  });
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await userEvent.click(await screen.findByTestId("action-delete"));
  await userEvent.click(await screen.findByTestId("delete-connection-submit"));
  expect((await screen.findByTestId("delete-connection-error")).textContent).toContain("It is already gone.");
});

// --- the number itself ----------------------------------------------------------

it("says bytes the way a publisher quotes them", () => {
  // Decimal, so the figure matches the one on the model's own page rather than
  // being the same download described with a smaller number.
  expect(bytes(0)).toBe("0 B");
  expect(bytes(999)).toBe("999 B");
  expect(bytes(1_000)).toBe("1.0 kB");
  expect(bytes(1_200_000_000)).toBe("1.2 GB");
});
