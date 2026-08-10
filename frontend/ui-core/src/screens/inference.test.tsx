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
import { InferenceScreen, bytes } from "./InferenceScreen";
import { CURATED_MODELS, DEFAULT_MODEL } from "./inferenceCatalog";
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
    model_id: DEFAULT_MODEL.modelId,
    model_revision: DEFAULT_MODEL.revision,
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
      model_id: DEFAULT_MODEL.modelId,
      model_revision: DEFAULT_MODEL.revision,
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
    await screen.findByText(`${DEFAULT_MODEL.modelId} @ ${DEFAULT_MODEL.revision}`),
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

it("pre-fills the local form with the default curated model, pinned", async () => {
  listing([]);
  sizeIs(1_200_000_000);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  expect((await screen.findByTestId("connection-model")).textContent).toContain(
    DEFAULT_MODEL.modelId,
  );
  // A curated entry carries its own revision, so there is nothing to type and
  // nothing left showing a branch name.
  expect(screen.queryByTestId("connection-revision")).toBeNull();
  const asked = sent.find((one) => one.url.includes("download-size"));
  expect(asked!.url).toContain(encodeURIComponent(DEFAULT_MODEL.revision));
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
  await userEvent.type(screen.getByTestId("connection-custom-model"), "some/model");
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
  await userEvent.type(screen.getByTestId("connection-custom-model"), "some/model");
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

// --- the curated list, and the fields that are closed sets ----------------------

it("offers every curated model, grouped, from the one module that holds them", async () => {
  listing([]);
  sizeIs(1_200_000_000);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  await userEvent.click(await screen.findByTestId("connection-model"));

  // Derived from the catalog rather than listed here: a model id spelled out in
  // this file would be a second source, which is exactly what the module exists
  // to prevent.
  for (const group of CURATED_MODELS) {
    expect(screen.getByText(group.label)).not.toBeNull();
    for (const model of group.models) {
      const option = screen.getByRole("option", { name: new RegExp(model.modelId) });
      expect(option.textContent).toContain(bytes(model.totalBytes));
      expect(option.textContent).toContain(model.hint);
    }
  }
});

it("stacks each option: the id on one line, what it costs on the next (#472)", async () => {
  listing([]);
  sizeIs(1_200_000_000);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));

  // The closed trigger first, which is where the squash was visible: it shows the
  // selected option's own two lines rather than a second copy of the layout.
  const trigger = await screen.findByTestId("connection-model");
  const triggerMeta = trigger.querySelector(".text-muted-foreground");
  expect(trigger.textContent).toContain(DEFAULT_MODEL.modelId);
  expect(triggerMeta?.textContent).toContain(DEFAULT_MODEL.hint);
  // The id keeps the line to itself — the whole point of the restructure.
  expect(triggerMeta?.textContent).not.toContain(DEFAULT_MODEL.modelId);

  await userEvent.click(trigger);
  for (const group of CURATED_MODELS) {
    for (const model of group.models) {
      const option = screen.getByRole("option", { name: new RegExp(model.modelId) });
      const meta = option.querySelector(".text-muted-foreground");
      expect(meta?.textContent).toBe(`${bytes(model.totalBytes)} · ${model.hint}`);
    }
  }
  // Including Custom, so no row in the list is a different height from its
  // neighbours.
  const custom = screen.getByRole("option", { name: /Custom model/ });
  expect(custom.querySelector(".text-muted-foreground")).not.toBeNull();
});

it("curates without restricting: Custom reveals the free model and revision", async () => {
  listing([]);
  sizeIs(1_200_000_000);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  expect(screen.queryByTestId("connection-custom-model")).toBeNull();

  await userEvent.click(await screen.findByTestId("connection-model"));
  await userEvent.click(screen.getByRole("option", { name: /Custom model/ }));

  const model = await screen.findByTestId("connection-custom-model");
  await userEvent.clear(model);
  await userEvent.type(model, "someone/else");
  await userEvent.clear(screen.getByTestId("connection-revision"));
  await userEvent.type(screen.getByTestId("connection-revision"), "deadbeef");
  expect(value(model)).toBe("someone/else");
  expect(value(screen.getByTestId("connection-revision"))).toBe("deadbeef");
});

it("offers half precision only where an adapter would honour it", async () => {
  listing([]);
  sizeIs(1_200_000_000);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));

  // A CPU connection: `fp16` is dropped by both adapters, so it is not on offer
  // and the field says why rather than leaving the absence to be guessed at.
  await userEvent.click(await screen.findByTestId("connection-precision"));
  expect(screen.queryByRole("option", { name: "fp16" })).toBeNull();
  expect(screen.getByRole("option", { name: "fp32" })).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByTestId("precision-hint").textContent).toContain("CUDA only");

  await userEvent.click(screen.getByTestId("connection-device"));
  await userEvent.click(screen.getByRole("option", { name: "cuda" }));
  await userEvent.click(screen.getByTestId("connection-precision"));
  expect(screen.getByRole("option", { name: "fp16" })).not.toBeNull();
});

it("moves the precision with the device rather than leaving a refused pair", async () => {
  listing([]);
  sizeIs(1_200_000_000);
  const posted: Record<string, unknown>[] = [];
  handlers.push((request) => {
    if (request.method !== "POST" || !request.url.endsWith("/inference/connections")) return;
    return { status: 201, body: connection() };
  });
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  await userEvent.type(await screen.findByTestId("connection-name"), "sam2");

  await userEvent.click(screen.getByTestId("connection-device"));
  await userEvent.click(screen.getByRole("option", { name: "cuda" }));
  await userEvent.click(screen.getByTestId("connection-precision"));
  await userEvent.click(screen.getByRole("option", { name: "fp16" }));
  // Back to the CPU, where `fp16` is not a thing the kernel accepts.
  await userEvent.click(screen.getByTestId("connection-device"));
  await userEvent.click(screen.getByRole("option", { name: "cpu" }));

  await userEvent.click(screen.getByTestId("connection-submit"));
  await waitFor(() => expect(sent.some((one) => one.method === "POST")).toBe(true));
  const body = JSON.parse(await sent.find((one) => one.method === "POST")!.clone().text());
  posted.push(body as Record<string, unknown>);
  expect(body.device).toBe("cpu");
  expect(body.precision).toBe("fp32");
});

it("renders the kernel's refusal of a pair it disagrees with, as prose", async () => {
  // The form offers only what works; this is the other half of the same rule —
  // the kernel is the authority, and whatever it refuses reaches a person in the
  // words the kernel wrote. Nothing here is computed client-side.
  listing([]);
  sizeIs(1_200_000_000);
  on("POST", /^\/inference\/connections$/, {
    status: 422,
    body: {
      code: "INFERENCE_CONNECTION_INVALID",
      message: "fp16 is not available on cpu; cpu runs in fp32",
    },
  });
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  await userEvent.type(await screen.findByTestId("connection-name"), "sam2");
  await userEvent.click(screen.getByTestId("connection-submit"));
  expect((await screen.findByTestId("connection-error")).textContent).toContain(
    "fp16 is not available on cpu",
  );
});

it("shows a stored device the form does not offer instead of rewriting it", async () => {
  // `cuda:1` is a device the kernel accepts and a form cannot enumerate — how
  // many GPUs this machine has is not something the list can know. Opening the
  // edit form must not quietly reassign the row to `cuda`.
  listing([
    connection({ setup_state: "ready", device: "cuda:1", allowed_actions: ["update", "delete"] }),
  ]);
  sizeIs(1_200_000_000);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await userEvent.click(await screen.findByTestId("action-edit"));
  expect((await screen.findByTestId("connection-device")).textContent).toContain("cuda:1");
});

it("shows a curated model at another revision as a custom connection", async () => {
  // The pair is the identity. A row naming a curated model at a revision the
  // list does not pin is not that entry, and showing it as one would misreport
  // which weights it runs.
  listing([
    connection({
      model_revision: "0000000000000000000000000000000000000000",
      setup_state: "ready",
      allowed_actions: ["update", "delete"],
    }),
  ]);
  sizeIs(1_200_000_000);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await userEvent.click(await screen.findByTestId("action-edit"));
  expect(value(await screen.findByTestId("connection-revision"))).toBe(
    "0000000000000000000000000000000000000000",
  );
  expect((screen.getByTestId("connection-model")).textContent).toContain("Custom");
});

// --- the download's whole life --------------------------------------------------

it("refreshes the row when the job finishes, with no reload", async () => {
  // The bug this closes: the `202` invalidated the list, and nothing invalidated
  // it again when the work actually finished — so the row sat at `Not set up`
  // until the page was reloaded.
  let ready = false;
  handlers.push((request) => {
    if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/connections")) return;
    const row = ready
      ? connection({ setup_state: "ready", allowed_actions: ["download_weights", "update", "delete"] })
      : connection();
    return { status: 200, body: { items: [row], total: 1 } };
  });
  on("POST", /\/download$/, { status: 202, body: job("queued") });
  handlers.push((request) => {
    if (!request.url.includes("/background-jobs/")) return;
    // The job settles, and the row it moved is what the next listing answers.
    ready = true;
    return { status: 200, body: job("succeeded", 1, 1) };
  });

  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("download-weights"));
  await waitFor(() =>
    expect(screen.getByTestId("connection-status").textContent).toContain("Ready"),
  );
  // And the row's control follows the state it is now in.
  expect(screen.queryByTestId("download-weights")).toBeNull();
});

it("surfaces a failed download as prose, and leaves the same action as the retry", async () => {
  listing([connection()]);
  on("POST", /\/download$/, { status: 202, body: job("queued") });
  on("GET", /^\/background-jobs\/job-1$/, {
    status: 200,
    body: {
      ...(job("failed") as Record<string, unknown>),
      error: "could not fetch facebook/sam2.1-hiera-base-plus at b73207: the connection was lost",
    },
  });
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("download-weights"));

  const shown = await screen.findByTestId("download-error");
  expect(shown.textContent).toContain("the connection was lost");
  // What happened, and what to do about it — including that nothing is half done.
  expect(shown.textContent).toContain("still Not set up");
  expect(shown.textContent).toContain("resumes");
  // The never-half-ready invariant, at the layer a person reads it.
  expect(screen.getByTestId("connection-status").textContent).toContain("Not set up");
  // The retry *is* the action: no second control appeared, and this one is live.
  const retry = screen.getByTestId("download-weights") as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  expect(screen.queryByText(/retry/i)).toBeNull();
});

it("offers the completeness check in the overflow once a connection is ready", async () => {
  listing([
    connection({ setup_state: "ready", allowed_actions: ["download_weights", "update", "delete"] }),
  ]);
  render(mount(<InferenceScreen />));
  await screen.findByTestId("connections-table");
  // Not the prominent control — there is nothing to fetch, only something to check.
  expect(screen.queryByTestId("download-weights")).toBeNull();

  await userEvent.click(screen.getByTestId("actions-sam2-local"));
  expect(await screen.findByTestId("action-verify-weights")).not.toBeNull();
});

it("does not offer the completeness check when the wire withholds the action", async () => {
  // The same `setup_state`, so a screen deriving the item from the row's state
  // would still render it. Only `allowed_actions` gets this right.
  listing([connection({ setup_state: "ready", allowed_actions: ["update", "delete"] })]);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await screen.findByTestId("action-edit");
  expect(screen.queryByTestId("action-verify-weights")).toBeNull();
});

it("runs the same request for the completeness check as for Download weights", async () => {
  listing([
    connection({ setup_state: "ready", allowed_actions: ["download_weights", "update", "delete"] }),
  ]);
  on("POST", /\/download$/, { status: 202, body: job("queued") });
  on("GET", /^\/background-jobs\/job-1$/, { status: 200, body: job("succeeded", 1, 1) });
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await userEvent.click(await screen.findByTestId("action-verify-weights"));
  await waitFor(() =>
    expect(
      sent.some((one) => one.method === "POST" && one.url.endsWith("/download")),
    ).toBe(true),
  );
});

// --- the integrity check, and keeping it apart from the other one --------------

/** Everything a ready local connection declares. Typed off `Connection`, so a
 *  renamed action is a type error here rather than a string that still compiles. */
const READY_BOTH: Connection["allowed_actions"] = [
  "download_weights",
  "check_integrity",
  "update",
  "delete",
];

it("names the two checks by what each one proves", async () => {
  // The bug being closed is a labelling one: **Verify weights** covered both
  // readings and could only be honest about one. A download reads an index and
  // finds what is absent; only a full re-read finds what is present and wrong.
  listing([connection({ setup_state: "ready", allowed_actions: READY_BOTH })]);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));

  expect((await screen.findByTestId("action-verify-weights")).textContent).toContain(
    "Check for missing files",
  );
  expect((await screen.findByTestId("action-check-integrity")).textContent).toContain(
    "Check files are undamaged",
  );
  expect(screen.queryByText("Verify weights")).toBeNull();
});

it("sends the integrity check to its own route, not to the download", async () => {
  listing([connection({ setup_state: "ready", allowed_actions: READY_BOTH })]);
  on("POST", /\/check-integrity$/, { status: 202, body: job("queued") });
  on("GET", /^\/background-jobs\/job-1$/, { status: 200, body: job("succeeded", 4, 4) });
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await userEvent.click(await screen.findByTestId("action-check-integrity"));

  await waitFor(() =>
    expect(sent.some((one) => one.method === "POST" && one.url.endsWith("/check-integrity"))).toBe(
      true,
    ),
  );
  // Two actions, two requests: a check that fell through to the download route
  // would look identical on screen and prove nothing about the files.
  expect(sent.some((one) => one.url.endsWith("/download"))).toBe(false);
});

it("does not offer the integrity check when the wire withholds it", async () => {
  // The same `setup_state` as the row above, so a screen deriving the item from
  // the state would still render it. `allowed_actions` is the only source.
  listing([
    connection({ setup_state: "ready", allowed_actions: ["download_weights", "update", "delete"] }),
  ]);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await screen.findByTestId("action-verify-weights");
  expect(screen.queryByTestId("action-check-integrity")).toBeNull();
});

it("lands the row at Not set up when a check finds damage, and says what was done", async () => {
  // The other direction, and the reason the settle-invalidation has to cover it:
  // the row's whole meaning changes.
  let damaged = false;
  handlers.push((request) => {
    if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/connections")) return;
    const row = damaged
      ? connection({
          setup_state: "not_set_up",
          allowed_actions: ["download_weights", "update", "delete"],
        })
      : connection({ setup_state: "ready", allowed_actions: READY_BOTH });
    return { status: 200, body: { items: [row], total: 1 } };
  });
  on("POST", /\/check-integrity$/, { status: 202, body: job("queued") });
  handlers.push((request) => {
    if (!request.url.includes("/background-jobs/")) return;
    damaged = true;
    return {
      status: 200,
      body: {
        ...(job("failed") as Record<string, unknown>),
        error: "1 file does not match (model.safetensors). The damaged copies have been removed",
      },
    };
  });

  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await userEvent.click(await screen.findByTestId("action-check-integrity"));

  const shown = await screen.findByTestId("integrity-error");
  expect(shown.textContent).toContain("model.safetensors");
  // What was done, and what to do — the remedy is the action the row now has.
  expect(shown.textContent).toContain("removed");
  expect(shown.textContent).toContain("real transfer");
  await waitFor(() =>
    expect(screen.getByTestId("connection-status").textContent).toContain("Not set up"),
  );
  expect(await screen.findByTestId("download-weights")).not.toBeNull();
});

it("keeps a running check from reading as a running download", async () => {
  // Two independent polls. One shared run state would light both controls, and
  // the slow one would look like the fast one having stalled.
  listing([connection({ setup_state: "ready", allowed_actions: READY_BOTH })]);
  on("POST", /\/check-integrity$/, { status: 202, body: job("queued") });
  on("GET", /^\/background-jobs\/job-1$/, { status: 200, body: job("running", 2, 9) });
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await userEvent.click(await screen.findByTestId("action-check-integrity"));

  expect((await screen.findByTestId("integrity-progress")).textContent).toContain("2 of 9");
  expect(screen.queryByTestId("download-progress")).toBeNull();
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
