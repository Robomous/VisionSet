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
 * 4. **Where a connection appears is the wire's too.** Sections come off
 *    `capabilities`, and the tests that matter are the ones with nowhere obvious
 *    to put a row: two abilities on one connection, an ability nothing consumes
 *    yet, and a connection that has not declared anything at all. A row in no
 *    section is a connection nobody can download, edit or delete.
 *
 * The requests are stubbed, never the questions: every mutation goes out on the
 * path that reaches it, and the refusals come back from the stub.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { CapabilitySection, InferenceScreen, bytes } from "./InferenceScreen";
import { CURATED_MODELS, DEFAULT_MODEL } from "./inferenceCatalog";
import { sectionsOf } from "./inferenceSections";
import { CONNECTION_POLL_MS, type Connection } from "../data/inferenceQueries";

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
    // Not optional on the wire, so not optional here: the generated runtime
    // check refuses a response missing it, and a stub that omitted one rendered
    // this screen's error card in every case — which reads as a component bug.
    capabilities: [],
    // Also not optional on the wire, and `null` is their ordinary value: nobody
    // has ever asked this connection to fetch or to re-read anything.
    download: null,
    integrity_check: null,
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

/**
 * The transfer a connection reports, as the wire spells it.
 *
 * A helper rather than a literal per test for `connection`'s reason: every field
 * is required on the wire, and the generated runtime check refuses a response
 * missing one — which renders as this screen's error card and reads as a
 * component bug rather than as a stub that lied.
 */
type WeightDownload = NonNullable<Connection["download"]>;
type IntegrityCheck = NonNullable<Connection["integrity_check"]>;

function checkOf(
  state: IntegrityCheck["state"],
  read: number,
  total: number | null,
  error: string | null = null,
): IntegrityCheck {
  return {
    job_id: "55555555-5555-4555-8555-555555555555",
    state,
    files_read: read,
    files_total: total,
    error,
  };
}

function downloadOf(
  state: WeightDownload["state"],
  done: number,
  total: number | null,
  error: string | null = null,
): WeightDownload {
  return {
    job_id: "44444444-4444-4444-8444-444444444444",
    state,
    bytes_done: done,
    bytes_total: total,
    error,
  };
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
  await waitFor(() => expect(screen.queryByTestId("connection-sections")).toBeNull());
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
  await screen.findByTestId("connection-sections");
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

// --- organised by what a connection enables ------------------------------------

it("puts a connection under the ability its weights declare", async () => {
  listing([
    connection({
      setup_state: "ready",
      capabilities: ["point_suggest"],
      allowed_actions: ["update", "delete"],
    }),
  ]);
  render(mount(<InferenceScreen />));

  const suggest = await screen.findByTestId("section-point_suggest");
  expect(within(suggest).getByTestId("connection-sam2-local")).not.toBeNull();
  expect(
    within(screen.getByTestId("section-text_detect")).queryByTestId("connection-sam2-local"),
  ).toBeNull();
});

it("names the surface that uses an ability, not the models that serve it", async () => {
  listing([connection({ setup_state: "ready", capabilities: ["point_suggest"] })]);
  render(mount(<InferenceScreen />));
  expect((await screen.findByTestId("section-point_suggest")).textContent).toContain(
    "suggest tool",
  );
});

it("shows a connection serving two abilities under both, and edits the one connection", async () => {
  listing([
    connection({
      setup_state: "ready",
      capabilities: ["point_suggest", "text_detect"],
      allowed_actions: ["update", "delete"],
    }),
  ]);
  render(mount(<InferenceScreen />));

  const detect = await screen.findByTestId("section-text_detect");
  expect(
    within(screen.getByTestId("section-point_suggest")).getByTestId("connection-sam2-local"),
  ).not.toBeNull();
  // The detail surface is the screen's rather than the section's, so acting from
  // the second copy of a row opens the dialog for the same connection.
  await userEvent.click(within(detect).getByTestId("actions-sam2-local"));
  await userEvent.click(await screen.findByTestId("action-edit"));
  expect(value(await screen.findByTestId("connection-name"))).toBe("sam2-local");
});

it("keeps a connection that has declared nothing visible, beside its remedy", async () => {
  // The commonest state on this screen: capability is read off weights, so a
  // connection whose download has not run declares none. A dashboard organised by
  // capability that dropped it would hide the very row whose button fixes that.
  listing([connection()]);
  render(mount(<InferenceScreen />));

  const waiting = await screen.findByTestId("section-undeclared");
  expect(within(waiting).getByTestId("connection-sam2-local")).not.toBeNull();
  expect(within(waiting).getByTestId("download-weights")).not.toBeNull();
});

it("invites a first connection per ability rather than leaving a gap", async () => {
  listing([connection({ setup_state: "ready", capabilities: ["text_detect"] })]);
  render(mount(<InferenceScreen />));

  const suggest = await screen.findByTestId("section-point_suggest");
  expect(within(suggest).getByText("Add a connection the suggest tool can use")).not.toBeNull();
  expect(
    within(suggest).getByRole("button", { name: "Add a point-prompt connection" }),
  ).not.toBeNull();
});

it("describes an ability nothing consumes yet, and offers no way into it", async () => {
  // Principle 9 from the other side. The missing half is the surface that would
  // ask, so there is nothing here somebody could press to get one — and an
  // invitation to configure a connection nothing can use is that same offer.
  listing([connection({ setup_state: "ready", capabilities: ["point_suggest"] })]);
  render(mount(<InferenceScreen />));

  const detect = await screen.findByTestId("section-text_detect");
  expect(within(detect).getByTestId("section-nothing").textContent).toContain(
    "nowhere to be used yet",
  );
  expect(within(detect).queryAllByRole("button")).toEqual([]);
});

it("answers what to do next exactly once, however many sections are on screen", async () => {
  // The count, from both sides (`DESIGN.md`): a section CTA shipped as `primary`
  // would put a filled button on the page for every ability nothing serves yet.
  // The workspace below is chosen so an invitation is actually on screen — the
  // sweep says nothing about a rule whose control never rendered.
  listing([connection({ setup_state: "ready", capabilities: ["text_detect"] })]);
  render(mount(<InferenceScreen />));
  await screen.findByRole("button", { name: "Add a point-prompt connection" });

  expect(document.body.querySelectorAll("button.bg-primary")).toHaveLength(1);
});

it("says a section has no matches rather than inviting mid-filter", async () => {
  const many = Array.from({ length: 24 }, (_, index) =>
    connection({
      id: `id-${index}`,
      name: index === 3 ? "needle" : `hay-${index}`,
      setup_state: "ready",
      capabilities: ["text_detect"],
    }),
  );
  listing(many);
  render(mount(<InferenceScreen />));
  await userEvent.type(await screen.findByTestId("connection-filter"), "need");

  const suggest = screen.getByTestId("section-point_suggest");
  expect(within(suggest).getByTestId("section-filtered-out")).not.toBeNull();
  // What somebody typed is not an occasion to invite them to configure anything.
  expect(within(suggest).queryAllByRole("button")).toEqual([]);
});

it("renders an ability this build has no copy for from the value itself", async () => {
  // It cannot arrive through a listing: the generated response check is an exact
  // `oneOf` over the two shipped members, so a row carrying anything else is
  // refused before a renderer sees it. The section is therefore asserted
  // directly — the rule belongs to the layer that draws a value rather than to
  // the one that decides whether it may arrive.
  const row = connection({
    setup_state: "ready",
    capabilities: ["depth_estimate"] as unknown as Connection["capabilities"],
    allowed_actions: ["update", "delete"],
  });
  const generic = sectionsOf([row]).find((section) => section.key === "depth_estimate")!;

  render(
    mount(
      <CapabilitySection
        section={generic}
        filtering={false}
        onAdd={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    ),
  );

  const section = await screen.findByTestId("section-depth_estimate");
  expect(section.getAttribute("data-known")).toBe("false");
  expect(within(section).getByText("depth_estimate")).not.toBeNull();
  expect(within(section).getByTestId("connection-sam2-local")).not.toBeNull();
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
  await screen.findByTestId("connection-sections");
  expect(screen.queryByTestId("download-weights")).toBeNull();
});

it("offers no overflow at all when neither edit nor delete is declared", async () => {
  listing([connection({ allowed_actions: [] })]);
  render(mount(<InferenceScreen />));
  await screen.findByTestId("connection-sections");
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

it("shows a transfer nobody on this page started", async () => {
  // The whole point of the download living on the connection. Nothing is clicked
  // here: the screen mounts onto a workspace where a download is already running,
  // which is what a reload, a second tab, or a return visit looks like — and what
  // used to render as `Not set up` beside a button somebody had already pressed.
  listing([connection({ download: downloadOf("running", 400_000_000, 1_600_000_000) })]);
  render(mount(<InferenceScreen />));

  const shown = await screen.findByTestId("download-progress-prose");
  expect(shown.textContent).toBe("400.0 MB of 1.6 GB · 25%");
  expect(screen.getByTestId("download-progress-bar").getAttribute("aria-valuenow")).toBe("25");
  // And it did so without asking about a job at all.
  expect(sent.some((one) => one.url.includes("/background-jobs/"))).toBe(false);
});

it("names the queue rather than drawing a bar that has not moved", async () => {
  listing([connection({ download: downloadOf("queued", 0, null) })]);
  render(mount(<InferenceScreen />));

  expect((await screen.findByTestId("download-progress-prose")).textContent).toContain("Queued");
  // A worker has not touched it, so there is no total either.
  expect(screen.queryByTestId("download-bar")).toBeNull();
});

it("names the phase after the bytes rather than sitting full", async () => {
  // A download ends by reading what arrived and recording the connection ready,
  // so every byte can be here while the job is still running. A full bar with no
  // sentence reads as a stall.
  listing([connection({ download: downloadOf("running", 1_600_000_000, 1_600_000_000) })]);
  render(mount(<InferenceScreen />));

  expect((await screen.findByTestId("download-progress-prose")).textContent).toBe(
    "Checking what arrived…",
  );
  expect(screen.getByTestId("download-progress-bar").getAttribute("data-phase")).toBe("settling");
});

it("draws no bar when the published size could not be read", async () => {
  // Sizing reaches the hub's listing and the transfer reaches its files, so one
  // can fail while the other runs. `Progress` renders an indeterminate value as
  // an empty track, which would read as 0% — a lie in the one case where the
  // truth is "this is going, and nobody can say how far".
  listing([connection({ download: downloadOf("running", 700_000_000, null) })]);
  render(mount(<InferenceScreen />));

  const shown = await screen.findByTestId("download-progress-prose");
  expect(shown.textContent).toContain("700.0 MB so far");
  expect(shown.textContent).toContain("could not be read");
  expect(screen.queryByTestId("download-bar")).toBeNull();
});

it("never re-reads a list nothing is moving in", async () => {
  // The other half of the conditional poll, and the half a browser cannot be
  // asked about: asserting that nothing happens over an interval means waiting on
  // a clock, which `tests/scripts/e2e_discipline` forbids in a spec for the
  // reason it gives. Here the request log is the state, and jsdom's scheduler is
  // not the thing under test.
  let reads = 0;
  handlers.push((request) => {
    if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/connections")) return;
    reads += 1;
    return {
      status: 200,
      body: {
        items: [connection({ setup_state: "ready", allowed_actions: ["update", "delete"] })],
        total: 1,
      },
    };
  });

  render(mount(<InferenceScreen />));
  await waitFor(() =>
    expect(screen.getByTestId("connection-status").textContent).toContain("Ready"),
  );

  const first = reads;
  await new Promise((done) => setTimeout(done, CONNECTION_POLL_MS * 2));
  expect(reads).toBe(first);
}, 15_000);

it("shows no progress for a connection that has never been downloaded", async () => {
  listing([connection()]);
  render(mount(<InferenceScreen />));
  await screen.findByTestId("connection-sections");
  expect(screen.queryByTestId("download-progress")).toBeNull();
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

it("follows a transfer to its end with no reload and no click", async () => {
  // The bug this closes twice over: the `202` invalidated the list and nothing
  // invalidated it again when the work finished, so the row sat at `Not set up`
  // until somebody reloaded — and the only thing watching was a job id this page
  // had to have launched itself.
  //
  // Now the list re-reads itself while the wire says a transfer is live, and
  // stops when it says one is not. The screen never asks about a job.
  let reads = 0;
  handlers.push((request) => {
    if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/connections")) return;
    reads += 1;
    const row =
      reads < 2
        ? connection({ download: downloadOf("running", 800_000_000, 1_600_000_000) })
        : connection({
            setup_state: "ready",
            allowed_actions: ["download_weights", "update", "delete"],
            download: downloadOf("succeeded", 1_600_000_000, 1_600_000_000),
          });
    return { status: 200, body: { items: [row], total: 1 } };
  });

  render(mount(<InferenceScreen />));
  expect((await screen.findByTestId("download-progress-prose")).textContent).toContain("50%");

  await waitFor(
    () => expect(screen.getByTestId("connection-status").textContent).toContain("Ready"),
    { timeout: 5_000 },
  );
  // The bar goes with the transfer: the row's own status is the success treatment.
  expect(screen.queryByTestId("download-progress")).toBeNull();
  expect(screen.queryByTestId("download-weights")).toBeNull();
  expect(sent.some((one) => one.url.includes("/background-jobs/"))).toBe(false);

  // And the poll stops, rather than re-reading a list nothing is moving.
  const settled = reads;
  await new Promise((done) => setTimeout(done, CONNECTION_POLL_MS * 1.5));
  expect(reads).toBe(settled);
}, 15_000);

it("surfaces a failed download as prose, and leaves the same action as the retry", async () => {
  // Read off the row, so a transfer that died while nobody was watching still has
  // its sentence when somebody comes back to the screen. Nothing is clicked here.
  listing([
    connection({
      download: downloadOf(
        "failed",
        300_000_000,
        1_600_000_000,
        "could not fetch facebook/sam2.1-hiera-base-plus at b73207: the connection was lost",
      ),
    }),
  ]);
  render(mount(<InferenceScreen />));

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
  await screen.findByTestId("connection-sections");
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
  // Read off the row and with nothing clicked, so a check that found damage while
  // the tab was closed still explains itself. The verdict is `setup_state`, which
  // moved before the job said so; the sentence is the check's.
  listing([
    connection({
      setup_state: "not_set_up",
      allowed_actions: ["download_weights", "update", "delete"],
      integrity_check: checkOf(
        "failed",
        9,
        9,
        "1 file does not match (model.safetensors). The damaged copies have been removed",
      ),
    }),
  ]);

  render(mount(<InferenceScreen />));

  const shown = await screen.findByTestId("integrity-error");
  expect(shown.textContent).toContain("model.safetensors");
  // What was done, and what to do — the remedy is the action the row now has.
  expect(shown.textContent).toContain("removed");
  expect(shown.textContent).toContain("real transfer");
  expect(screen.getByTestId("connection-status").textContent).toContain("Not set up");
  expect(await screen.findByTestId("download-weights")).not.toBeNull();
});

it("keeps a running check from reading as a running download", async () => {
  // Two records on one row, counting different things. One shared shape would
  // put a file count where gigabytes belong, or the reverse.
  listing([
    connection({
      setup_state: "ready",
      allowed_actions: READY_BOTH,
      integrity_check: checkOf("running", 2, 9),
    }),
  ]);
  render(mount(<InferenceScreen />));

  expect((await screen.findByTestId("integrity-progress-prose")).textContent).toBe(
    "2 of 9 files · 22%",
  );
  expect(screen.queryByTestId("download-progress")).toBeNull();
});

it("shows a check nobody on this page started", async () => {
  // The shipped bug's shape, one action over: the job id lived in a component, so
  // only the mount that pressed the menu item could see a run reading gigabytes.
  // A check started from a terminal was invisible to every browser.
  listing([
    connection({
      setup_state: "ready",
      allowed_actions: READY_BOTH,
      integrity_check: checkOf("running", 400, 1_000),
    }),
  ]);
  render(mount(<InferenceScreen />));

  expect((await screen.findByTestId("integrity-progress-prose")).textContent).toBe(
    "400 of 1,000 files · 40%",
  );
  expect(screen.getByTestId("integrity-progress-bar").getAttribute("aria-valuenow")).toBe("40");
  // And it asked about no job at all.
  expect(sent.some((one) => one.url.includes("/background-jobs/"))).toBe(false);
});

it("names the queue rather than drawing a bar for a check that has not started", async () => {
  listing([
    connection({
      setup_state: "ready",
      allowed_actions: READY_BOTH,
      integrity_check: checkOf("queued", 0, null),
    }),
  ]);
  render(mount(<InferenceScreen />));

  expect((await screen.findByTestId("integrity-progress-prose")).textContent).toContain("Queued");
  expect(screen.queryByTestId("integrity-progress-bar")).toBeNull();
});

it("names the listing read a check makes before its first file", async () => {
  // A check learns its total from the hub, which it reads first. Short, real, and
  // an empty track would read as 0% of a number nobody has yet.
  listing([
    connection({
      setup_state: "ready",
      allowed_actions: READY_BOTH,
      integrity_check: checkOf("running", 0, null),
    }),
  ]);
  render(mount(<InferenceScreen />));

  expect((await screen.findByTestId("integrity-progress-prose")).textContent).toContain(
    "publishes",
  );
  expect(screen.queryByTestId("integrity-progress-bar")).toBeNull();
});

it("stops showing a check once it has passed", async () => {
  // A pass leaves the row exactly where it was, and `Ready` is the whole of the
  // success treatment — a settled record is not something to draw a bar for.
  listing([
    connection({
      setup_state: "ready",
      allowed_actions: READY_BOTH,
      integrity_check: checkOf("succeeded", 9, 9),
    }),
  ]);
  render(mount(<InferenceScreen />));
  await screen.findByTestId("connection-sections");

  expect(screen.queryByTestId("integrity-progress")).toBeNull();
  expect(screen.queryByTestId("integrity-error")).toBeNull();
  expect(screen.getByTestId("connection-status").textContent).toContain("Ready");
});

it("polls while a check is live, and stops when it settles", async () => {
  let reads = 0;
  handlers.push((request) => {
    if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/connections")) return;
    reads += 1;
    const row =
      reads < 2
        ? connection({
            setup_state: "ready",
            allowed_actions: READY_BOTH,
            integrity_check: checkOf("running", 4, 9),
          })
        : connection({
            setup_state: "ready",
            allowed_actions: READY_BOTH,
            integrity_check: checkOf("succeeded", 9, 9),
          });
    return { status: 200, body: { items: [row], total: 1 } };
  });

  render(mount(<InferenceScreen />));
  expect((await screen.findByTestId("integrity-progress-prose")).textContent).toContain("44%");

  await waitFor(() => expect(screen.queryByTestId("integrity-progress")).toBeNull(), {
    timeout: 5_000,
  });
  expect(sent.some((one) => one.url.includes("/background-jobs/"))).toBe(false);

  const settled = reads;
  await new Promise((done) => setTimeout(done, CONNECTION_POLL_MS * 1.5));
  expect(reads).toBe(settled);
}, 15_000);

// --- editing and deleting ------------------------------------------------------

it("edits without offering to change the kind", async () => {
  listing([connection({ setup_state: "ready", allowed_actions: ["update", "delete"] })]);
  render(mount(<InferenceScreen />));
  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await userEvent.click(await screen.findByTestId("action-edit"));
  expect(value(await screen.findByTestId("connection-name"))).toBe("sam2-local");
  expect(screen.queryByTestId("choose-type")).toBeNull();
});

it("lands an edited row at Not set up without a reload", async () => {
  // The declaration is a cached answer, and this edit changes it: repinning the
  // connection to another revision sends it back for a download, so the row's
  // whole meaning changes underneath a screen that is already showing it. The
  // list invalidation on a successful PATCH is what carries that across.
  let edited = false;
  handlers.push((request) => {
    if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/connections")) return;
    const row = edited
      ? connection({
          model_revision: "beefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
          setup_state: "not_set_up",
          allowed_actions: ["download_weights", "update", "delete"],
        })
      : connection({
          // Pinned to a revision the curated list does not name, so the form
          // offers the revision as a field to edit rather than as a fixed pair.
          model_revision: "0000000000000000000000000000000000000000",
          setup_state: "ready",
          capabilities: ["point_suggest"],
          allowed_actions: READY_BOTH,
        });
    return { status: 200, body: { items: [row], total: 1 } };
  });
  handlers.push((request) => {
    if (request.method !== "PATCH") return;
    edited = true;
    return { status: 200, body: connection({ setup_state: "not_set_up" }) };
  });
  sizeIs(1_200_000_000);

  render(mount(<InferenceScreen />));
  expect((await screen.findByTestId("connection-status")).textContent).toContain("Ready");

  await userEvent.click(await screen.findByTestId("actions-sam2-local"));
  await userEvent.click(await screen.findByTestId("action-edit"));
  const revision = await screen.findByTestId("connection-revision");
  await userEvent.clear(revision);
  await userEvent.type(revision, "beefbeefbeefbeefbeefbeefbeefbeefbeefbeef");
  await userEvent.click(await screen.findByTestId("connection-submit"));

  await waitFor(() =>
    expect(screen.getByTestId("connection-status").textContent).toContain("Not set up"),
  );
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
