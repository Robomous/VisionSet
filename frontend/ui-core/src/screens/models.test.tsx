/**
 * The Models page: what it offers, what it refuses to offer, and why.
 *
 * Five claims here that nothing else in the suite makes:
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
 * 4. **What a card says, and which filter shows it, is the wire's too.** The
 *    labels, the origin mark and the dropdowns come off the listing, and the
 *    tests that matter are the ones with nowhere obvious to put a card: two
 *    abilities on one connection, a value this build has no name for, and a
 *    connection that has not declared anything at all. A card no filter reaches
 *    is a connection nobody can download, edit or delete.
 * 5. **What the form may offer is the installation's**, served rather than
 *    compiled in — so the model field is a query, with the three states a query
 *    has. None of them is a disabled control: it says it is reading, it renders
 *    the refusal as prose, or it says nothing is offered by name — and the last
 *    two leave the free model id and revision fields in place, because a model
 *    id typed by hand needs no catalog at all.
 *
 * The requests are stubbed, never the questions: every mutation goes out on the
 * path that reaches it, and the refusals come back from the stub.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { ConnectionRow, ModelsScreen, bytes, sourceLine } from "./ModelsScreen";
import { CONNECTION_POLL_MS, type Connection } from "../data/inferenceQueries";
import { PageStatusOutlet, PageStatusProvider } from "../patterns/PageStatus";
import { renderWithData } from "../testing/dataHarness";

// Spelled here rather than read from a module: the catalog is the server's
// answer now, and a fixture that imported the ids it then asserts on would be
// proving the screen agrees with itself.
const SAM_BASE_PLUS = "facebook/sam2.1-hiera-base-plus";
const SAM_BASE_PLUS_COMMIT = "b7320756a13354e7530a63935656d35b2f91a290";
const SAM_BASE_PLUS_HINT = "base-plus — the balanced default";
const SAM3 = "facebook/sam3";
const SAM3_COMMIT = "3c879f39826c281e95690f02c7821c4de09afae7";
const SAM3_HINT = "wants a GPU";
const SAM3_NOTE =
  "Meta publishes these weights under the SAM License and grants access by request.";
const SAM3_URL = "https://huggingface.co/facebook/sam3";
const DINO_TINY = "IDEA-Research/grounding-dino-tiny";
const DINO_TINY_HINT = "tiny — fastest, comfortable on a CPU";

/** An answer that never arrives, which is what a slow server is to a query. */
const NEVER = Symbol("never");

type Answer = { status: number; body?: unknown };
// A handler may answer now, later (a promise the test settles), or never.
let handlers: ((request: Request) => Answer | Promise<Answer> | typeof NEVER | undefined)[] = [];
const sent: Request[] = [];

function respond(answer: Answer): Response {
  return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? null), {
    status: answer.status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  handlers = [];
  sent.length = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    sent.push(request);
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer === NEVER) return new Promise<Response>(() => undefined);
      if (answer !== undefined) {
        return answer instanceof Promise ? answer.then(respond) : Promise.resolve(respond(answer));
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

/**
 * The screen as the app mounts it: inside a status provider, with the outlet the
 * shell's status bar puts at its left edge. What the list adds up to is said
 * there and nowhere on the page, so a test that reads a count renders it here —
 * and a screen mounted without the pair says none of it (see the test for that).
 */
function renderModels(): ReturnType<typeof renderWithData> {
  return renderWithData(
    <PageStatusProvider>
      <ModelsScreen />
      <PageStatusOutlet />
    </PageStatusProvider>,
  );
}

/** Press a model's name, which opens its sheet — where it is managed. */
async function openSheet(name: string): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId(`open-${name}`));
  return screen.findByTestId("model-sheet");
}

/** Close the sheet by Escape and wait for it to be gone. */
async function closeSheet(): Promise<void> {
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByTestId("model-sheet")).toBeNull());
}

/** The sheet's one `<button>` for an action, by its test id. */
function button(sheet: HTMLElement, testId: string): HTMLButtonElement {
  return within(sheet).getByTestId(testId) as HTMLButtonElement;
}

function on(method: string, pattern: RegExp, answer: Answer): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname) ? answer : undefined,
  );
}

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "sam2-local",
    connection_type: "local",
    model_id: SAM_BASE_PLUS,
    model_revision: SAM_BASE_PLUS_COMMIT,
    device: "cuda",
    precision: "fp16",
    endpoint_url: null,
    provider_id: "sam",
    credential_env: null,
    origin: "huggingface",
    setup_state: "not_set_up",
    allowed_actions: ["download_weights", "update", "update_model", "delete"],
    // Not optional on the wire, so not optional here: the generated runtime
    // check refuses a response missing it, and a stub that omitted one rendered
    // this screen's error card in every case — which reads as a component bug.
    capabilities: [],
    produces: [],
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
 * What the server answers for the installed drivers.
 *
 * Spelled in full, and every field required — the generated runtime check
 * refuses a response missing one, which renders this screen's error card in
 * every case and reads exactly like a component bug rather than a stub bug.
 */
const SERVED: unknown = {
  items: [
    {
      provider_id: "sam",
      families: {
        sam2: "point_suggest",
        sam2_video: "point_suggest",
        sam3_video: "point_suggest",
      },
      curated: [
        {
          provider_id: "sam",
          model_id: SAM_BASE_PLUS,
          model_revision: SAM_BASE_PLUS_COMMIT,
          family: "sam2_video",
          capability: "point_suggest",
          hint: SAM_BASE_PLUS_HINT,
          access_note: null,
          access_url: null,
        },
        {
          provider_id: "sam",
          model_id: SAM3,
          model_revision: SAM3_COMMIT,
          family: "sam3_video",
          capability: "point_suggest",
          hint: SAM3_HINT,
          access_note: SAM3_NOTE,
          access_url: SAM3_URL,
        },
      ],
    },
    {
      provider_id: "grounding-dino",
      families: { "grounding-dino": "text_detect" },
      curated: [
        {
          provider_id: "grounding-dino",
          model_id: DINO_TINY,
          model_revision: "a2bb814dd30d776dcf7e30523b00659f4f141c71",
          family: "grounding-dino",
          capability: "text_detect",
          hint: DINO_TINY_HINT,
          access_note: null,
          access_url: null,
        },
      ],
    },
  ],
  total: 2,
};

function catalog(body: unknown = SERVED, status = 200): void {
  on("GET", /\/inference\/providers$/, { status, body });
}

/** The catalog request a slow server has not answered yet, and will not. */
function catalogHangs(): void {
  handlers.push(providersOnly(() => NEVER));
}

/**
 * A catalog answer the test releases by hand.
 *
 * The only way to write the sequence that leaked a model between openings: the
 * dialog has to be discarded while the request is in flight, and the answer has
 * to land after it.
 */
function catalogOnCue(): () => void {
  let release = (): void => undefined;
  const served = new Promise<Answer>((settle) => {
    release = () => settle({ status: 200, body: SERVED });
  });
  handlers.push(providersOnly(() => served));
  return release;
}

/** A handler that answers the providers route and passes everything else on. */
function providersOnly(
  answer: () => Answer | Promise<Answer> | typeof NEVER,
): (request: Request) => Answer | Promise<Answer> | typeof NEVER | undefined {
  return (request) =>
    request.method === "GET" && new URL(request.url).pathname.endsWith("/inference/providers")
      ? answer()
      : undefined;
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
  errorCode: string | null = null,
): IntegrityCheck {
  return {
    job_id: "55555555-5555-4555-8555-555555555555",
    state,
    files_read: read,
    files_total: total,
    error,
    error_code: errorCode,
  };
}

function downloadOf(
  state: WeightDownload["state"],
  done: number,
  total: number | null,
  error: string | null = null,
  errorCode: string | null = null,
): WeightDownload {
  return {
    job_id: "44444444-4444-4444-8444-444444444444",
    state,
    bytes_done: done,
    bytes_total: total,
    error,
    error_code: errorCode,
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
    error_code: null,
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
      model_id: SAM_BASE_PLUS,
      model_revision: SAM_BASE_PLUS_COMMIT,
      total_bytes: totalBytes,
      file_count: fileCount,
    },
  });
}

// --- the list ------------------------------------------------------------------

it("invites a first connection rather than apologising for having none", async () => {
  listing([]);
  renderModels();
  expect(await screen.findByText("Connect a model to enable auto-labeling")).not.toBeNull();
  expect(
    screen.getByText(
      "VisionSet never downloads models on its own — you choose what runs and where. Start with Add model.",
    ),
  ).not.toBeNull();
  // No button of its own: the header's Add model is the one way in.
  expect(screen.getAllByRole("button", { name: /add model/i })).toHaveLength(1);
  expect(screen.getByTestId("new-connection")).not.toBeNull();
  expect(screen.queryByTestId("models-count")).toBeNull();
});

it("renders a failed listing as a refusal rather than as an empty list", async () => {
  on("GET", /^\/inference\/connections$/, {
    status: 503,
    body: { code: "SERVICE_UNAVAILABLE", message: "The workspace is busy." },
  });
  renderModels();
  await waitFor(() => expect(screen.queryByTestId("models-grid")).toBeNull());
  expect(screen.queryByText("Connect a model to enable auto-labeling")).toBeNull();
});

it("says the status in words as well as in a token", async () => {
  listing([connection(), connection({ id: "b", name: "remote", setup_state: "ready" })]);
  renderModels();
  const rows = await screen.findAllByTestId("connection-status");
  expect(rows[0].textContent).toContain("Not set up");
  expect(rows[1].textContent).toContain("Ready");
});

it("shows the model and its revision the way a person reads them", async () => {
  listing([connection()]);
  renderModels();
  // One line in one cell — the revision a muted span inside it, so the text is
  // read whole off the cell rather than found as a single text node.
  const reference = await screen.findByTestId("model-reference");
  expect(reference.textContent).toBe(`${SAM_BASE_PLUS} @ ${SAM_BASE_PLUS_COMMIT}`);
  expect(reference.getAttribute("title")).toBe(`${SAM_BASE_PLUS} @ ${SAM_BASE_PLUS_COMMIT}`);
  expect(reference.firstElementChild?.textContent).toBe(` @ ${SAM_BASE_PLUS_COMMIT}`);
});

it("carries no filter until a list could be long enough to need one", async () => {
  listing([connection()]);
  renderModels();
  await screen.findByTestId("models-grid");
  expect(screen.queryByTestId("connection-filter")).toBeNull();
});

it("filters by name and keeps saying how many it hid", async () => {
  const many = Array.from({ length: 24 }, (_, index) =>
    connection({ id: `id-${index}`, name: index === 3 ? "needle" : `hay-${index}` }),
  );
  listing(many);
  renderModels();
  await userEvent.type(await screen.findByTestId("connection-filter"), "need");
  expect(screen.getByTestId("models-count").textContent).toBe("1 of 24 models");
  expect(screen.getByTestId("connection-needle")).not.toBeNull();
});

it("names the search box for what it filters", async () => {
  listing(Array.from({ length: 24 }, (_, index) => connection({ id: `id-${index}`, name: `hay-${index}` })));
  renderModels();

  const filter = await screen.findByRole("searchbox", { name: "Filter connections" });
  expect(filter).toBe(screen.getByTestId("connection-filter"));
  expect(within(screen.getByTestId("model-filters")).getByTestId("connection-filter")).toBe(filter);
});

it("is one table, headed by its columns, with each connection a row of its one body", async () => {
  listing([connection({ id: "a", name: "one" }), connection({ id: "b", name: "two", setup_state: "ready", allowed_actions: ["update", "delete"] })]);
  renderModels();

  const grid = await screen.findByRole("table", { name: "Models" });
  expect(grid).toBe(screen.getByTestId("models-grid"));
  expect(
    within(grid)
      .getAllByRole("columnheader")
      .map((header) => header.textContent),
  ).toEqual(["Model", "Weights", "Origin", "What it does", "Runs on", "State", "Details"]);
  // A connection is one `<tr>` of the grid's single `<tbody>`, and the screen has
  // no cards.
  expect(grid.querySelectorAll("tbody")).toHaveLength(1);
  for (const name of ["one", "two"]) {
    const row = screen.getByTestId(`connection-${name}`);
    expect(row.tagName).toBe("TR");
    expect(grid.querySelector("tbody")?.contains(row)).toBe(true);
  }
  expect(document.querySelector('[data-slot="card"]')).toBeNull();
  // Nothing in the grid is a menu, a download button or a second row per model.
  expect(grid.querySelectorAll("tbody > tr")).toHaveLength(2);
  expect(screen.queryByTestId("actions-one")).toBeNull();
  expect(screen.queryByTestId("download-weights")).toBeNull();
  expect(screen.queryByTestId("connection-detail")).toBeNull();
});

it("counts what it lists once, in the status bar, as a status", async () => {
  listing([
    connection({ id: "a", name: "one" }),
    connection({ id: "b", name: "two", setup_state: "ready", allowed_actions: ["update", "delete"] }),
    connection({ id: "c", name: "three", setup_state: "ready", allowed_actions: ["update", "delete"] }),
  ]);
  renderModels();

  const count = await screen.findByTestId("models-count");
  expect(count.textContent).toBe("3 models");
  // Said in the status bar's outlet, a polite status region — and nowhere on the page.
  const status = screen.getByTestId("page-status");
  expect(status.getAttribute("role")).toBe("status");
  expect(status.contains(count)).toBe(true);
  expect(screen.getByTestId("models-screen").contains(count)).toBe(false);
  // Over the rows shown: two of the three are ready, one still needs setting up.
  expect(screen.getByTestId("models-ready").textContent).toBe("2 ready");
  expect(screen.getByTestId("models-waiting").textContent).toBe("1 not set up");
  // The only count: no totals table under the rows.
  expect(screen.queryByTestId("models-grid-totals")).toBeNull();
  expect(screen.queryByRole("table", { name: "Models, totals" })).toBeNull();
  expect(screen.getAllByRole("table")).toHaveLength(1);
});

it("says none of its counts when no status bar is there to say them in", async () => {
  // The facts are a summary of the page, never the only place something is said:
  // a host that mounts the screen without an outlet loses the summary and nothing else.
  listing([connection({ id: "a", name: "one" }), connection({ id: "b", name: "two", setup_state: "ready" })]);
  renderWithData(<ModelsScreen />);

  await screen.findByTestId("models-grid");
  expect(screen.getByTestId("connection-one")).not.toBeNull();
  for (const id of ["models-count", "models-ready", "models-waiting", "filter-count", "models-grid-totals"]) {
    expect(screen.queryByTestId(id)).toBeNull();
  }
});

it("says nothing is waiting when every model shown is ready", async () => {
  listing([
    connection({ id: "a", name: "one", setup_state: "ready", allowed_actions: ["update", "delete"] }),
    connection({ id: "b", name: "two", setup_state: "ready", allowed_actions: ["update", "delete"] }),
  ]);
  renderModels();

  expect((await screen.findByTestId("models-ready")).textContent).toBe("2 ready");
  expect(screen.queryByTestId("models-waiting")).toBeNull();
});

it("speaks of a single model in the singular", async () => {
  listing([connection({ setup_state: "ready", allowed_actions: ["update", "delete"] })]);
  renderModels();

  expect((await screen.findByTestId("models-count")).textContent).toBe("1 model");
  expect(screen.getByTestId("models-ready").textContent).toBe("1 ready");
});

it("counts what the filter left, of everything, in the header", async () => {
  listing(varied());
  renderModels();
  await screen.findByTestId("models-grid");
  expect(screen.getByTestId("models-count").textContent).toBe("4 models");
  expect(screen.getByTestId("models-ready").textContent).toBe("3 ready");
  expect(screen.getByTestId("models-waiting").textContent).toBe("1 not set up");

  await choose("filter-capability", "Text prompts");

  expect(screen.getByTestId("models-count").textContent).toBe("2 of 4 models");
  // The tallies follow the rows shown, not the whole list: both text-prompt
  // models are ready, so nothing shown is waiting.
  expect(screen.getByTestId("models-ready").textContent).toBe("2 ready");
  expect(screen.queryByTestId("models-waiting")).toBeNull();
  // One count, not one in the toolbar and another under the rows.
  expect(screen.queryByTestId("filter-count")).toBeNull();
  expect(screen.queryByTestId("models-grid-totals")).toBeNull();
});

it("says nothing matches in a row of the table, not outside it", async () => {
  const many = Array.from({ length: 24 }, (_, index) =>
    connection({ id: `id-${index}`, name: `hay-${index}`, setup_state: "ready", allowed_actions: ["update", "delete"] }),
  );
  listing(many);
  renderModels();
  await userEvent.type(await screen.findByTestId("connection-filter"), "zzz");

  const none = await screen.findByTestId("filtered-out");
  expect(none.tagName).toBe("TD");
  expect(screen.getByTestId("models-grid").contains(none)).toBe(true);
  // It spans the grid, whatever the number of columns.
  expect(none.getAttribute("colspan")).toBe("7");
  expect(screen.getByTestId("models-count").textContent).toBe("0 of 24 models");
  // Nothing shown, so nothing to call ready or waiting.
  expect(screen.queryByTestId("models-ready")).toBeNull();
  expect(screen.queryByTestId("models-waiting")).toBeNull();
});

// --- one card per connection, and what it says -------------------------------

/** Every field a card can show, filled — the fixture the omission tests subtract from. */
function full(): Connection {
  return connection({
    name: "sam2-full",
    setup_state: "ready",
    capabilities: ["point_suggest", "text_detect"],
    produces: ["bbox", "polygon"],
    device: "cuda",
    precision: "fp16",
    allowed_actions: ["download_weights", "check_integrity", "update", "delete"],
  });
}

/** A connection's row is a `<tr>`, which only means something inside a `<table>`. */
function card(node: ReactNode): ReactNode {
  return (
    <table>
      <tbody>{node}</tbody>
    </table>
  );
}

it("renders every field a full connection carries, along one row", async () => {
  renderWithData(card(<ConnectionRow connection={full()} onOpen={() => undefined} />));
  const shown = await screen.findByTestId("connection-sam2-full");
  expect(shown.tagName).toBe("TR");
  // The name is the row's one real control, in the first cell, with no card
  // title around it: a button that opens the model's sheet.
  const name = within(shown).getByTestId("open-sam2-full");
  expect(name.tagName).toBe("BUTTON");
  expect(name.textContent).toBe("sam2-full");
  expect(name.id).toBe("model-open-11111111-1111-4111-8111-111111111111");
  expect(name.closest("td")).toBe(shown.querySelector("tr > td"));
  expect(within(shown).getByTestId("model-reference").textContent).toBe(
    `${SAM_BASE_PLUS} @ ${SAM_BASE_PLUS_COMMIT}`,
  );
  // Where the weights come from: a plain name, and the origin's one colour — a
  // small mark beside it.
  expect(within(shown).getByTestId("connection-origin").textContent).toBe("Hugging Face");
  expect(shown.getAttribute("data-origin")).toBe("huggingface");
  expect(within(shown).getByTestId("connection-origin").firstElementChild?.className).toMatch(/\bbg-origin-hub\b/);
  // Product prose, every declared ability in the wire's order, then what it
  // writes in the shared plural prose — quiet square labels, no coloured chips.
  expect(
    within(shown)
      .getAllByTestId("ability-label")
      .map((label) => label.textContent),
  ).toEqual(["Suggests from clicks", "Finds what you name", "writes boxes or polygons"]);
  expect(within(shown).getByTestId("connection-source").textContent).toBe("Local · cuda · fp16");
  expect(within(shown).getByTestId("connection-status").textContent).toBe("Ready");
  // A run that did not fail leaves no note beside the word.
  expect(within(shown).queryByTestId("connection-failed-note")).toBeNull();
  // The row is read, not operated: no download control, no size, no menu and
  // nothing under it — what can be done to the model is in its sheet.
  expect(within(shown).queryByTestId("download-weights")).toBeNull();
  expect(within(shown).queryByTestId("connection-size-known")).toBeNull();
  expect(within(shown).queryByTestId("connection-detail")).toBeNull();
  expect(within(shown).queryByTestId("actions-sam2-full")).toBeNull();
  // The last cell is the chevron that says the row opens: decoration, not a word.
  const cells = [...shown.querySelectorAll("tr > td")];
  expect(cells).toHaveLength(7);
  expect(cells[6]?.textContent).toBe("");
  expect(cells[6]?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
});

it("omits every line whose datum is null rather than drawing a placeholder", async () => {
  // A fresh local connection: no ability yet, nothing it writes, no run, and a
  // row that says so by saying nothing in those slots.
  renderWithData(
    card(
      <ConnectionRow
        connection={connection({ allowed_actions: ["download_weights", "update", "delete"] })}
        onOpen={() => undefined}
      />,
    ),
  );
  const shown = await screen.findByTestId("connection-sam2-local");
  expect(within(shown).queryByTestId("connection-abilities")).toBeNull();
  expect(within(shown).queryByTestId("download-progress")).toBeNull();
  expect(within(shown).queryByTestId("integrity-progress")).toBeNull();
  expect(within(shown).getByTestId("connection-status").textContent).toBe("Not set up");
  // The State cell is the word and nothing else: no failure to note, and no
  // download button below Ready — that is the sheet's, with the cost beside it.
  const setup = within(shown).getByTestId("connection-setup");
  expect(within(setup).queryByTestId("connection-failed-note")).toBeNull();
  expect(within(setup).queryByTestId("download-weights")).toBeNull();
  expect(within(shown).queryByTestId("connection-size-known")).toBeNull();
  expect(within(shown).queryByTestId("connection-size-checking")).toBeNull();
  expect(within(shown).queryByTestId("connection-detail")).toBeNull();
  // And the cost is not asked for by a row: only an open sheet needs it.
  expect(sent.some((one) => one.url.includes("download-size"))).toBe(false);
});

it("reads an http connection's source as its kind and its host, with nothing invented", async () => {
  renderWithData(
    card(
      <ConnectionRow
        connection={connection({
          name: "remote-seg",
          connection_type: "http",
          device: null,
          precision: null,
          endpoint_url: "https://models.example/v1/predict",
          setup_state: "ready",
          allowed_actions: ["test_endpoint", "update", "delete"],
        })}
        onOpen={() => undefined}
      />,
    ),
  );
  const shown = await screen.findByTestId("connection-remote-seg");
  expect(within(shown).getByTestId("connection-source").textContent).toBe("HTTP · models.example");
});

it("renders a kind this build has never seen without rearranging the line", () => {
  // The source line is an open axis: a third member arrives as its raw value
  // followed by whatever it declares, in the same slots the two known kinds use.
  const newer = connection({
    connection_type: "edge" as unknown as Connection["connection_type"],
    device: "npu",
    precision: null,
    endpoint_url: null,
  });
  expect(sourceLine(newer)).toBe("edge · npu");
  expect(sourceLine(connection({ endpoint_url: "not a url", device: null, precision: null }))).toBe(
    "Local · not a url",
  );
});

it("shows a capability this build has no name for as its raw value, never dropped", async () => {
  renderWithData(
    card(
      <ConnectionRow
        connection={connection({
          setup_state: "ready",
          capabilities: ["depth_estimate"],
          produces: ["depth_map"] as unknown as Connection["produces"],
        })}
        onOpen={() => undefined}
      />,
    ),
  );
  const shown = await screen.findByTestId("connection-sam2-local");
  expect(
    within(shown)
      .getAllByTestId("ability-label")
      .map((label) => label.textContent),
  ).toEqual(["depth_estimate", "writes depth_map"]);
});

it("marks a row's origin with its own colour, and names it plainly", async () => {
  listing([
    connection({ id: "a", name: "hub", origin: "huggingface" }),
    connection({ id: "b", name: "own", origin: "custom" }),
    connection({ id: "c", name: "registry", origin: "robomous" }),
  ]);
  renderModels();
  const hub = await screen.findByTestId("connection-hub");
  const markOf = (row: HTMLElement): Element | null => within(row).getByTestId("connection-origin").firstElementChild;
  expect(markOf(hub)?.className).toMatch(/\bbg-origin-hub\b/);
  expect(markOf(hub)?.className).not.toMatch(/border-l-/);
  expect(hub.getAttribute("data-origin")).toBe("huggingface");
  expect(within(hub).getByTestId("connection-origin").textContent).toBe("Hugging Face");
  const own = screen.getByTestId("connection-own");
  expect(markOf(own)?.className).toMatch(/\bbg-origin-custom\b/);
  expect(within(own).getByTestId("connection-origin").textContent).toBe("Customized");
  const registry = screen.getByTestId("connection-registry");
  expect(markOf(registry)?.className).toMatch(/\bbg-origin-robomous\b/);
  expect(within(registry).getByTestId("connection-origin").textContent).toBe("Robomous");
  // The mark is decoration: the word beside it says it.
  expect(markOf(hub)?.getAttribute("aria-hidden")).toBe("true");
});

it("never grows a line under a connection: its row is the whole of it, and a run or a failure is read in the State cell", async () => {
  const ready = { setup_state: "ready" as const, allowed_actions: ["update", "delete"] as Connection["allowed_actions"] };
  listing([
    // Ready, no run, no failure: nothing to add to its row.
    connection({ id: "a", name: "quiet", ...ready }),
    // Not set up, with nothing wrong: the cost is the sheet's, so there is
    // nothing under the row.
    connection({ id: "b", name: "waiting" }),
    // Ready, with a check reading its files: the run takes the State cell's
    // place, so it adds nothing under the row.
    connection({
      id: "c",
      name: "reading",
      ...ready,
      allowed_actions: ["check_integrity", "update", "delete"],
      integrity_check: checkOf("running", 2, 5),
    }),
    // Ready, with a download that failed: the row only says there is something to
    // read; the sentence and the retry are the sheet's.
    connection({ id: "d", name: "failed", ...ready, download: downloadOf("failed", 0, null, "the connection was lost") }),
  ]);
  sizeIs(1_200_000_000);
  renderModels();

  const quiet = await screen.findByTestId("connection-quiet");
  expect(quiet.tagName).toBe("TR");
  expect(within(quiet).queryByTestId("connection-detail")).toBeNull();
  expect(within(quiet).queryByTestId("connection-failed-note")).toBeNull();

  const waiting = screen.getByTestId("connection-waiting");
  expect(within(waiting).queryByTestId("connection-detail")).toBeNull();
  expect(within(waiting).queryByTestId("connection-size")).toBeNull();

  // A run is read in the State cell, never under the row.
  const reading = screen.getByTestId("connection-reading");
  expect(within(reading).queryByTestId("connection-detail")).toBeNull();
  expect(within(within(reading).getByTestId("connection-setup")).getByTestId("integrity-progress")).not.toBeNull();

  // A failure is a short note beside the word: no prose and no row of its own.
  const failed = screen.getByTestId("connection-failed");
  expect(within(failed).queryByTestId("connection-detail")).toBeNull();
  expect(within(failed).queryByTestId("download-error")).toBeNull();
  expect(within(within(failed).getByTestId("connection-setup")).getByTestId("connection-failed-note")).not.toBeNull();

  // One row per connection, in one body, and no row between them.
  expect(screen.getByTestId("models-grid").querySelectorAll("tbody > tr")).toHaveLength(4);
  expect(screen.getByTestId("models-grid").querySelectorAll("tbody")).toHaveLength(1);
  // Nothing was priced for a row on its own.
  expect(sent.some((one) => one.url.includes("download-size"))).toBe(false);
});

it("leaves a failure note beside the state's word, and the sentence to the sheet", async () => {
  const ready = { setup_state: "ready" as const, allowed_actions: ["download_weights", "check_integrity", "update", "delete"] as Connection["allowed_actions"] };
  listing([
    // A transfer that failed before the weights were here.
    connection({ id: "a", name: "download-failed", download: downloadOf("failed", 0, null, "the connection was lost") }),
    // At Ready a download is the missing-files check, so its failure is a failed check.
    connection({ id: "b", name: "recheck-failed", ...ready, download: downloadOf("failed", 0, null, "the connection was lost") }),
    // A failed integrity check is a failed check at either state.
    connection({ id: "c", name: "integrity-failed", ...ready, integrity_check: checkOf("failed", 4, 9, "the hub did not answer") }),
    connection({ id: "d", name: "fine", ...ready }),
  ]);
  renderModels();

  const note = (name: string): HTMLElement | null =>
    within(within(screen.getByTestId(`connection-${name}`)).getByTestId("connection-setup")).queryByTestId("connection-failed-note");
  await screen.findByTestId("connection-fine");
  expect(note("download-failed")?.textContent).toBe("Download failed");
  expect(note("recheck-failed")?.textContent).toBe("Check failed");
  expect(note("integrity-failed")?.textContent).toBe("Check failed");
  expect(note("fine")).toBeNull();
  // The state's word stays: a failed run is a note beside it, not a replacement.
  expect(within(screen.getByTestId("connection-download-failed")).getByTestId("connection-status").textContent).toBe("Not set up");
  expect(within(screen.getByTestId("connection-recheck-failed")).getByTestId("connection-status").textContent).toBe("Ready");
  // The row never says why: the sentence and the retry are one press away.
  expect(screen.queryByTestId("download-error")).toBeNull();
  expect(screen.queryByTestId("integrity-error")).toBeNull();
});

it("shows a ready connection's endpoint test in its sheet, and leaves the row as it was", async () => {
  listing([connection({ name: "remote-seg", connection_type: "http", device: null, precision: null, endpoint_url: "https://models.example/predict", setup_state: "ready", allowed_actions: ["test_endpoint", "update", "delete"] })]);
  let release = (): void => undefined;
  const served = new Promise<Answer>((settle) => {
    release = () => settle({ status: 200, body: connection({ name: "remote-seg", setup_state: "ready" }) });
  });
  handlers.push((request) =>
    request.method === "POST" && /\/test-endpoint$/.test(new URL(request.url).pathname) ? served : undefined,
  );
  renderModels();
  const row = await screen.findByTestId("connection-remote-seg");
  expect(within(row).queryByTestId("connection-detail")).toBeNull();

  const sheet = await openSheet("remote-seg");
  await userEvent.click(within(sheet).getByTestId("action-test-endpoint"));

  // Pending is a few words under the button that asked, in the sheet's setup
  // section; the row still says Ready and grew nothing.
  const pending = await within(sheet).findByTestId("test-endpoint-pending");
  expect(pending.textContent).toBe("Asking the endpoint…");
  expect(within(sheet).getByTestId("model-setup").contains(pending)).toBe(true);
  expect(within(sheet).getByTestId("model-setup").contains(within(sheet).getByTestId("connection-status"))).toBe(true);
  expect(within(row).queryByTestId("test-endpoint-pending")).toBeNull();
  expect(within(row).getByTestId("connection-status").textContent).toBe("Ready");
  expect(within(row).queryByTestId("connection-detail")).toBeNull();

  release();
  await waitFor(() => expect(within(sheet).queryByTestId("test-endpoint-pending")).toBeNull());
  expect(within(sheet).getByTestId("test-endpoint-ok").textContent).toBe("The endpoint answered.");
  expect(within(row).queryByTestId("connection-detail")).toBeNull();
});

it("gives a refused endpoint test a sentence in the sheet, which is prose and not progress", async () => {
  listing([connection({ name: "remote-seg", connection_type: "http", device: null, precision: null, endpoint_url: "https://models.example/predict", setup_state: "ready", allowed_actions: ["test_endpoint", "update", "delete"] })]);
  on("POST", /\/test-endpoint$/, {
    status: 502,
    body: { code: "ENDPOINT_UNREACHABLE", message: "The endpoint did not answer." },
  });
  renderModels();
  const row = await screen.findByTestId("connection-remote-seg");
  expect(within(row).queryByTestId("connection-detail")).toBeNull();

  const sheet = await openSheet("remote-seg");
  await userEvent.click(within(sheet).getByTestId("action-test-endpoint"));

  expect((await within(sheet).findByTestId("test-endpoint-error")).textContent).toContain("The endpoint did not answer.");
  expect(within(sheet).queryByTestId("test-endpoint-ok")).toBeNull();
  // Nothing about it on the row.
  expect(within(row).queryByTestId("test-endpoint-error")).toBeNull();
  expect(within(row).queryByTestId("connection-detail")).toBeNull();
});

it("puts the name, the weights, the origin and the abilities each in their own cell, with a dash for no abilities", async () => {
  listing([
    connection({ id: "a", name: "plain", setup_state: "ready", allowed_actions: ["update", "delete"] }),
    connection({ id: "b", name: "able", setup_state: "ready", capabilities: ["point_suggest"], allowed_actions: ["update", "delete"] }),
  ]);
  renderModels();

  const plain = await screen.findByTestId("connection-plain");
  const cells = [...plain.querySelectorAll("tr > td")];
  expect(cells).toHaveLength(7);
  expect(cells[0]?.textContent).toBe("plain");
  expect(within(cells[1] as HTMLElement).getByTestId("model-reference")).not.toBeNull();
  expect(within(cells[2] as HTMLElement).getByTestId("connection-origin")).not.toBeNull();
  // Nothing declared: a dash where the labels would be, never an empty cell.
  expect(cells[3]?.textContent).toBe("—");
  expect(within(plain).queryByTestId("connection-abilities")).toBeNull();
  expect(within(cells[4] as HTMLElement).getByTestId("connection-source")).not.toBeNull();
  expect(within(cells[5] as HTMLElement).getByTestId("connection-status")).not.toBeNull();
  // The last cell is the chevron: it says the row opens, and is no control of its own.
  expect(within(cells[6] as HTMLElement).queryByRole("button")).toBeNull();
  expect(cells[6]?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

  const able = screen.getByTestId("connection-able");
  expect(within(able).getByTestId("connection-abilities").getAttribute("aria-label")).toBe("What it does");
  expect(within(able).getByTestId("connection-abilities").getAttribute("title")).toBe("Suggests from clicks");
});

it("asks for the download size when a sheet opens, and only below Ready", async () => {
  listing([
    connection({ id: "a", name: "fresh" }),
    connection({
      id: "b",
      name: "done",
      setup_state: "ready",
      model_id: "other/model",
      model_revision: "deadbeef",
      allowed_actions: ["update", "delete"],
    }),
  ]);
  sizeIs(1_200_000_000);
  renderModels();
  await screen.findByTestId("connection-fresh");
  // The list alone prices nothing.
  expect(sent.some((one) => one.url.includes("download-size"))).toBe(false);

  const fresh = await openSheet("fresh");
  // The cost is a sentence above the button that incurs it, said before pressing.
  const known = await within(fresh).findByTestId("connection-size-known");
  expect(known.textContent).toBe("Downloads 1.2 GB across 3 files. Nothing is fetched until you ask.");
  expect(within(fresh).getByTestId("connection-size").contains(known)).toBe(true);
  const download = button(fresh, "download-weights");
  expect(within(fresh).getByRole("button", { name: "Download weights" })).toBe(download);
  // One request, for the one pair the open sheet carries.
  const asked = sent.filter((one) => one.url.includes("download-size"));
  expect(asked).toHaveLength(1);
  expect(asked[0]?.url).toContain(encodeURIComponent(SAM_BASE_PLUS));

  await closeSheet();
  const done = await openSheet("done");
  expect(within(done).queryByTestId("connection-size")).toBeNull();
  expect(within(done).queryByTestId("connection-size-known")).toBeNull();
  expect(sent.filter((one) => one.url.includes("download-size"))).toHaveLength(1);
});

it("says the size is being read, and then that it cannot be", async () => {
  listing([connection()]);
  // Never answered: the read stays pending, and nothing stands in for it.
  handlers.push((request) =>
    new URL(request.url).pathname === "/inference/download-size" ? new Promise<Answer>(() => undefined) : undefined,
  );
  renderModels();

  const sheet = await openSheet("sam2-local");
  expect((await within(sheet).findByTestId("connection-size-checking")).textContent).toBe("Reading the download size…");
  expect(within(sheet).queryByTestId("connection-size-known")).toBeNull();
  expect(within(sheet).queryByTestId("connection-size-unavailable")).toBeNull();
  // Not knowing the cost is no reason to withhold the action (design principle 9).
  expect(button(sheet, "download-weights").disabled).toBe(false);
});

it("shows a connection serving two abilities once, and edits the one connection", async () => {
  listing([full()]);
  catalog();
  renderModels();
  await screen.findByTestId("models-grid");
  expect(screen.getAllByTestId("connection-sam2-full")).toHaveLength(1);
  const sheet = await openSheet("sam2-full");
  expect(within(sheet).getAllByTestId("action-edit")).toHaveLength(1);
  await userEvent.click(await screen.findByTestId("action-edit"));
  expect(value(await screen.findByTestId("connection-name"))).toBe("sam2-full");
});

// --- the filters -----------------------------------------------------------------

/** Open one filter dropdown and pick the option whose label matches. */
async function choose(filter: string, option: string | RegExp): Promise<void> {
  await userEvent.click(screen.getByTestId(filter));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

/** A workspace with something to choose on every dimension. */
function varied(): Connection[] {
  return [
    connection({ id: "a", name: "suggest", setup_state: "ready", capabilities: ["point_suggest"] }),
    connection({ id: "b", name: "detect", setup_state: "ready", capabilities: ["text_detect"] }),
    connection({ id: "c", name: "fresh" }),
    connection({
      id: "d",
      name: "remote",
      connection_type: "http",
      origin: "custom",
      device: null,
      precision: null,
      endpoint_url: "https://models.example/predict",
      setup_state: "ready",
      capabilities: ["text_detect"],
      allowed_actions: ["test_endpoint", "update", "delete"],
    }),
  ];
}

it("offers no dropdown while there is nothing to choose", async () => {
  // One connection: one origin, one ability at most, one kind, one state. A
  // dropdown whose every choice shows the same card is a control in a useless
  // state, so none is on screen — and neither is the row they would sit in.
  listing([connection()]);
  renderModels();
  await screen.findByTestId("models-grid");
  expect(screen.queryByTestId("model-filters")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("offers a dropdown per dimension with a choice to make, each at All, in the page's order", async () => {
  listing(varied());
  renderModels();
  const filters = await screen.findByTestId("model-filters");
  const triggers = within(filters).getAllByRole("combobox");
  // Each pill reads its dimension and then its choice, and is named by the
  // dimension alone — through the label that is there for a screen reader.
  expect(triggers.map((trigger) => trigger.textContent)).toEqual(["OriginAll", "AbilityAll", "RunsAll", "StateAll"]);
  expect(triggers.map((trigger) => trigger.getAttribute("data-testid"))).toEqual([
    "filter-origin",
    "filter-capability",
    "filter-kind",
    "filter-state",
  ]);
  for (const name of ["Origin", "Ability", "Runs", "State"]) {
    expect(within(filters).getByRole("combobox", { name })).not.toBeNull();
  }
  // Nothing narrowed, so nothing to clear, and the header says how many there
  // are rather than how many are shown.
  expect(screen.queryByTestId("clear-filters")).toBeNull();
  expect(screen.queryByTestId("filter-count")).toBeNull();
  expect(screen.getByTestId("models-count").textContent).toBe("4 models");
});

it("offers only the dimensions the workspace varies on", async () => {
  // Two abilities, everything else alike: one dropdown, and it is Ability.
  listing([
    connection({ id: "a", name: "suggest", setup_state: "ready", capabilities: ["point_suggest"] }),
    connection({ id: "b", name: "detect", setup_state: "ready", capabilities: ["text_detect"] }),
  ]);
  renderModels();
  const filters = await screen.findByTestId("model-filters");
  expect(within(filters).getAllByRole("combobox")).toHaveLength(1);
  expect(screen.getByTestId("filter-capability")).not.toBeNull();
  expect(screen.queryByTestId("filter-origin")).toBeNull();
  expect(screen.queryByTestId("filter-kind")).toBeNull();
  expect(screen.queryByTestId("filter-state")).toBeNull();
});

it("lists only the values on the page, named in a person's words", async () => {
  listing(varied());
  renderModels();
  await userEvent.click(await screen.findByTestId("filter-capability"));
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "All",
    "Point prompts",
    "Text prompts",
  ]);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByTestId("filter-origin"));
  // Robomous is a name this build knows and nothing on the page carries: not offered.
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "All",
    "Hugging Face",
    "Customized",
  ]);
  await userEvent.keyboard("{Escape}");
});

it("narrows the grid to the ability chosen, and All brings everything back", async () => {
  listing(varied());
  renderModels();
  await screen.findByTestId("models-grid");
  const cards = /^connection-(suggest|detect|fresh|remote)$/;
  expect(screen.getAllByTestId(cards)).toHaveLength(4);

  await choose("filter-capability", "Point prompts");
  expect(screen.getByTestId("filter-capability").textContent).toBe("AbilityPoint prompts");
  expect(screen.getByTestId("filter-capability").getAttribute("data-chosen")).toBe("true");
  expect(screen.getByTestId("connection-suggest")).not.toBeNull();
  expect(screen.queryByTestId("connection-detect")).toBeNull();
  // A connection that has declared nothing answers All and no other choice.
  expect(screen.queryByTestId("connection-fresh")).toBeNull();
  // The count says what the filter left, of everything.
  expect(screen.getByTestId("models-count").textContent).toBe("1 of 4 models");

  await choose("filter-capability", "All");
  expect(screen.getAllByTestId(cards)).toHaveLength(4);
});

it("combines the dropdowns, and Clear puts every one back to All", async () => {
  listing(varied());
  renderModels();
  await screen.findByTestId("models-grid");
  const cards = /^connection-(suggest|detect|fresh|remote)$/;

  await choose("filter-capability", "Text prompts");
  expect(screen.getAllByTestId(cards)).toHaveLength(2);
  await choose("filter-kind", "HTTP");
  expect(screen.getAllByTestId(cards).map((card) => card.dataset.testid)).toEqual([
    "connection-remote",
  ]);
  await choose("filter-state", "Not set up");
  // No endpoint is waiting for weights: the combination, not any one choice,
  // is what left nothing — and every choice on offer is one some card answers,
  // so an empty result is only ever the combination.
  expect(screen.getByTestId("filtered-out").textContent).toBe("Nothing here matches the filter.");
  expect(screen.getByTestId("models-count").textContent).toBe("0 of 4 models");

  await userEvent.click(screen.getByTestId("clear-filters"));
  expect(screen.getAllByTestId(cards)).toHaveLength(4);
  expect(screen.queryByTestId("clear-filters")).toBeNull();
});

it("keeps a connection that has declared nothing on the page, and its remedy one press away", async () => {
  // The commonest state on this screen: capability is read off weights, so a
  // connection whose download has not run declares none. A page organised by
  // capability that dropped it would hide the very row whose sheet holds the fix.
  listing([connection()]);
  renderModels();
  const waiting = await screen.findByTestId("connection-sam2-local");
  expect(within(waiting).queryByTestId("download-weights")).toBeNull();

  const sheet = await openSheet("sam2-local");
  expect(within(sheet).getByTestId("download-weights")).not.toBeNull();
  // Nothing declared, and the sheet says why rather than drawing a blank.
  expect(within(sheet).getByTestId("sheet-abilities").textContent).toContain("Known once the weights are here");
});

it("offers an ability this build has no name for, from the value itself", async () => {
  // The response check used to refuse the whole listing over one unrecognised member, so
  // the generic rendering was unreachable through the network and only a unit test reached
  // it. This is that path end to end: a stubbed listing, the real client, the real check.
  listing([
    connection({ setup_state: "ready", capabilities: ["depth_estimate"] }),
    connection({ id: "b", name: "other", setup_state: "ready", capabilities: ["text_detect"] }),
  ]);
  renderModels();
  await screen.findByTestId("models-grid");
  await userEvent.click(screen.getByTestId("filter-capability"));
  const generic = await screen.findByRole("option", { name: "depth_estimate" });
  expect(generic.dataset.known).toBe("false");
  await userEvent.click(generic);
  expect(screen.getByTestId("connection-sam2-local")).not.toBeNull();
  expect(screen.queryByTestId("connection-other")).toBeNull();
});

it("says nothing matches rather than inviting mid-filter", async () => {
  const many = Array.from({ length: 24 }, (_, index) =>
    connection({
      id: `id-${index}`,
      name: index === 3 ? "needle" : `hay-${index}`,
      setup_state: "ready",
      capabilities: [index % 2 === 0 ? "text_detect" : "point_suggest"],
    }),
  );
  listing(many);
  renderModels();
  await userEvent.type(await screen.findByTestId("connection-filter"), "need");
  // `needle` is index 3: a point-prompt model. Text prompts leaves nothing.
  await choose("filter-capability", "Text prompts");

  expect(screen.getByTestId("filtered-out").textContent).toBe("Nothing here matches the filter.");
  // And the count is what both filters left, of everything.
  expect(screen.getByTestId("models-count").textContent).toBe("0 of 24 models");
});

it("falls back to All when the value chosen stops being declared", async () => {
  // An endpoint re-asked, a model moved: the value a choice stood for can leave
  // the workspace while it is chosen. The choice is kept and reads as All, so
  // the page never shows nothing under a choice that is not there.
  let hosted = connection({
    name: "remote-seg",
    connection_type: "http",
    origin: "custom",
    device: null,
    precision: null,
    endpoint_url: "https://models.example/predict",
    setup_state: "ready",
    capabilities: ["depth_estimate"],
    allowed_actions: ["test_endpoint", "update", "delete"],
  });
  const other = connection({ id: "b", name: "other", setup_state: "ready", capabilities: ["point_suggest"] });
  handlers.push((request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path.endsWith("/connections")) {
      return { status: 200, body: { items: [hosted, other], total: 2 } };
    }
    if (request.method === "POST" && path.endsWith("/test-endpoint")) {
      hosted = { ...hosted, capabilities: ["point_suggest"] };
      return { status: 200, body: hosted };
    }
    return undefined;
  });
  renderModels();
  await screen.findByTestId("models-grid");
  await choose("filter-capability", "depth_estimate");
  expect(screen.getByTestId("connection-remote-seg")).not.toBeNull();
  expect(screen.queryByTestId("connection-other")).toBeNull();

  await openSheet("remote-seg");
  await userEvent.click(await screen.findByTestId("action-test-endpoint"));
  // Both now answer point prompts: one ability, so the dropdown itself is gone,
  // and the choice it held reads as All.
  await waitFor(() => expect(screen.queryByTestId("filter-capability")).toBeNull());
  expect(screen.getByTestId("connection-remote-seg")).not.toBeNull();
  expect(screen.getByTestId("connection-other")).not.toBeNull();
});

// --- what the wire declares, and only that -------------------------------------

it("offers Download weights only where the wire declares it", async () => {
  listing([connection()]);
  renderModels();
  const sheet = await openSheet("sam2-local");
  expect(within(sheet).getByTestId("download-weights")).not.toBeNull();
  // The row itself carries no download button.
  expect(within(screen.getByTestId("connection-sam2-local")).queryByTestId("download-weights")).toBeNull();
});

it("does not offer Download weights when the wire withholds it", async () => {
  // The identical `setup_state`, so a screen deriving the action from the row's
  // state would still render the button here. Only reading `allowed_actions`
  // gets this right.
  listing([connection({ allowed_actions: ["update", "delete"] })]);
  renderModels();
  const sheet = await openSheet("sam2-local");
  // The sheet is open and says what it can: the absence is the wire's.
  expect(within(sheet).getByTestId("action-edit")).not.toBeNull();
  expect(within(sheet).queryByTestId("download-weights")).toBeNull();
  expect(within(sheet).queryByTestId("connection-size")).toBeNull();
});

it("offers neither edit nor delete when neither is declared", async () => {
  listing([connection({ allowed_actions: [] })]);
  renderModels();
  const sheet = await openSheet("sam2-local");
  expect(within(sheet).getByTestId("model-setup")).not.toBeNull();
  expect(within(sheet).queryByTestId("action-edit")).toBeNull();
  expect(within(sheet).queryByTestId("action-delete")).toBeNull();
  // No overflow menu anywhere: the row has none to offer and the sheet none to need.
  expect(screen.queryByTestId("actions-sam2-local")).toBeNull();
  expect(within(sheet).queryAllByRole("button").map((one) => one.textContent)).toEqual(["Close"]);
});

it("offers each of Edit and Delete only where the wire declares it", async () => {
  listing([
    connection({ id: "a", name: "only-edit", setup_state: "ready", allowed_actions: ["update"] }),
    connection({ id: "b", name: "only-delete", setup_state: "ready", allowed_actions: ["delete"] }),
    connection({ id: "c", name: "both", setup_state: "ready", allowed_actions: ["update", "delete"] }),
  ]);
  renderModels();

  const editOnly = await openSheet("only-edit");
  expect(within(editOnly).getByTestId("action-edit")).not.toBeNull();
  expect(within(editOnly).queryByTestId("action-delete")).toBeNull();
  await closeSheet();

  const deleteOnly = await openSheet("only-delete");
  expect(within(deleteOnly).getByTestId("action-delete")).not.toBeNull();
  expect(within(deleteOnly).queryByTestId("action-edit")).toBeNull();
  await closeSheet();

  const both = await openSheet("both");
  expect(within(both).getByTestId("action-edit")).not.toBeNull();
  expect(within(both).getByTestId("action-delete")).not.toBeNull();
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
  renderModels();
  await openSheet("sam2-local");
  await userEvent.click(await screen.findByTestId("download-weights"));
  const shown = await screen.findByTestId("download-error");
  // Withheld from the vocabulary on purpose, so the kernel's sentence is the
  // prose — and the code is not rendered beside it.
  expect(shown.textContent).toContain('pip install "visionset[local-inference]"');
  expect(shown.textContent).not.toContain("LOCAL_INFERENCE_UNAVAILABLE");
});

it("says a mapped download refusal in the vocabulary's sentence, with no code beside it", async () => {
  listing([connection()]);
  on("POST", /\/download$/, {
    status: 409,
    body: {
      code: "INFERENCE_CONNECTION_NOT_DOWNLOADABLE",
      message: "inference connection 11111111-1111-4111-8111-111111111111 is http; nothing to download",
    },
  });
  renderModels();
  await openSheet("sam2-local");
  await userEvent.click(await screen.findByTestId("download-weights"));
  const shown = await screen.findByTestId("download-error");
  expect(shown.textContent).toContain("runs elsewhere, so there are no weights to fetch");
  expect(shown.textContent).not.toContain("INFERENCE_CONNECTION_NOT_DOWNLOADABLE");
  expect(shown.textContent).not.toContain("11111111-1111-4111-8111-111111111111");
});

it("shows a transfer nobody on this page started", async () => {
  // The whole point of the download living on the connection. Nothing is clicked
  // here: the screen mounts onto a workspace where a download is already running,
  // which is what a reload, a second tab, or a return visit looks like — and what
  // used to render as `Not set up` beside a button somebody had already pressed.
  listing([connection({ download: downloadOf("running", 400_000_000, 1_600_000_000) })]);
  renderModels();

  const shown = await screen.findByTestId("download-progress-prose");
  expect(shown.textContent).toBe("400.0 MB of 1.6 GB · 25%");
  expect(screen.getByTestId("download-progress-bar").getAttribute("aria-valuenow")).toBe("25");
  // And it did so without asking about a job at all.
  expect(sent.some((one) => one.url.includes("/background-jobs/"))).toBe(false);
});

it("names the queue rather than drawing a bar that has not moved", async () => {
  listing([connection({ download: downloadOf("queued", 0, null) })]);
  renderModels();

  expect((await screen.findByTestId("download-progress-prose")).textContent).toBe("Queued for a worker");
  // A worker has not touched it, so there is no total either.
  expect(screen.queryByTestId("download-progress-bar")).toBeNull();
});

it("names the phase after the bytes rather than sitting full", async () => {
  // A download ends by reading what arrived and recording the connection ready,
  // so every byte can be here while the job is still running. A full bar with no
  // sentence reads as a stall.
  listing([connection({ download: downloadOf("running", 1_600_000_000, 1_600_000_000) })]);
  renderModels();

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
  renderModels();

  const shown = await screen.findByTestId("download-progress-prose");
  expect(shown.textContent).toBe("700.0 MB so far · size unknown");
  expect(screen.queryByTestId("download-progress-bar")).toBeNull();
});

it("a download of nothing is settling, not a size that could not be read", async () => {
  // The built-in stand-in has no weights, so its total is a **measured** zero.
  // `total > 0` used to answer both "is it known" and "can it be divided by",
  // which put a sentence about a failed lookup in front of a lookup that
  // succeeded. Nought of nought is every byte, so the honest phase is the one a
  // finished transfer is in.
  listing([connection({ download: downloadOf("running", 0, 0) })]);
  renderModels();

  const shown = await screen.findByTestId("download-progress-prose");
  expect(shown.textContent).toContain("Checking what arrived");
  expect(shown.textContent).not.toContain("size unknown");
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

  renderModels();
  await waitFor(() =>
    expect(screen.getByTestId("connection-status").textContent).toContain("Ready"),
  );

  const first = reads;
  await new Promise((done) => setTimeout(done, CONNECTION_POLL_MS * 2));
  expect(reads).toBe(first);
  // Nor was the catalog ever asked for. It is the connection form's read, and
  // the form is arranged to exist only while its dialog is open - a claim only a
  // request log can hold, because the browser suite stubs that route for every
  // scenario and would answer a stray request without complaining.
  expect(sent.some((one) => one.url.includes("/inference/providers"))).toBe(false);
});

it("shows no progress for a connection that has never been downloaded", async () => {
  listing([connection()]);
  renderModels();
  await screen.findByTestId("models-grid");
  expect(screen.queryByTestId("download-progress")).toBeNull();
});

// --- creating ------------------------------------------------------------------

it("asks where the model runs before asking anything else", async () => {
  listing([]);
  catalog();
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  expect(await screen.findByTestId("choose-type")).not.toBeNull();
  expect(screen.queryByTestId("connection-name")).toBeNull();
});

it("pins the offered revision rather than asking anybody to type one", async () => {
  listing([]);
  catalog();
  sizeIs(1_200_000_000);
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  await waitFor(() =>
    expect(screen.getByTestId("connection-model").textContent).toContain(SAM_BASE_PLUS),
  );
  // An offer carries its own revision, so there is nothing to type and nothing
  // left showing a branch name.
  expect(screen.queryByTestId("connection-revision")).toBeNull();
  const asked = sent.find((one) => one.url.includes("download-size"));
  expect(asked!.url).toContain(encodeURIComponent(SAM_BASE_PLUS_COMMIT));
});

it("shows the download size before anything is confirmed", async () => {
  listing([]);
  catalog();
  sizeIs(1_200_000_000, 4);
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  expect((await screen.findByTestId("size-known")).textContent).toContain("1.2 GB");
  expect(screen.getByTestId("size-known").textContent).toContain("4 files");
  // Nothing has been created and nothing has been fetched at this point.
  expect(sent.some((one) => one.method === "POST")).toBe(false);
});

it("keeps the local form usable when the size cannot be read, quoting the refusal without its code", async () => {
  listing([]);
  catalog();
  on("GET", /^\/inference\/download-size$/, {
    status: 500,
    body: {
      code: "LOCAL_INFERENCE_UNAVAILABLE",
      message:
        'running a model locally needs the local-inference extra. Install it with: pip install "visionset[local-inference]"',
    },
  });
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  const shown = await screen.findByTestId("size-unavailable");
  // Withheld from REFUSAL_PROSE on purpose: the message carries its own remedy,
  // and a mapped sentence would delete the one actionable thing it says. Only
  // the code badge goes.
  expect(shown.textContent).toContain('pip install "visionset[local-inference]"');
  expect(shown.textContent).not.toContain("LOCAL_INFERENCE_UNAVAILABLE");
  // Principle 9: the form is not disabled by not knowing. Creating downloads
  // nothing, so the unknown size is information rather than a gate.
  await userEvent.type(screen.getByTestId("connection-name"), "sam2");
  expect((screen.getByTestId("connection-submit") as HTMLButtonElement).disabled).toBe(false);
});

it("asks for no size at all for an http connection", async () => {
  listing([]);
  catalog();
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-http"));
  await screen.findByTestId("connection-endpoint");
  expect(sent.some((one) => one.url.includes("download-size"))).toBe(false);
});

it("sends only the fields the chosen kind carries", async () => {
  listing([]);
  catalog();
  const bodies: unknown[] = [];
  handlers.push((request) => {
    if (request.method !== "POST" || !request.url.endsWith("/inference/connections")) return;
    return { status: 201, body: connection() };
  });
  on("GET", /^\/inference\/download-size$/, { status: 200, body: null });
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-http"));
  await userEvent.type(await screen.findByTestId("connection-name"), "remote");
  await userEvent.type(screen.getByTestId("connection-custom-model"), "some/model");
  await userEvent.type(screen.getByTestId("connection-revision"), "abc123");
  await userEvent.type(screen.getByTestId("connection-endpoint"), "https://example.invalid");
  await userEvent.type(screen.getByTestId("connection-credential-env"), "ACME_TOKEN");
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
  expect(body.credential_env).toBe("ACME_TOKEN");
});

it("says the credential field takes a variable's name and never the secret", async () => {
  listing([]);
  catalog();
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-http"));
  await screen.findByTestId("connection-credential-env");
  expect(screen.getByText(/The name of an environment variable, not the secret/)).not.toBeNull();
  // No field takes the secret itself: the decision is a variable's name, and a
  // password input here would be the plain-storage option nobody chose.
  expect(screen.queryByLabelText(/token|api key|secret/i)).toBeNull();
  expect(screen.queryByTestId("connection-credential-env")?.getAttribute("type")).not.toBe(
    "password",
  );
});

it("keeps what was typed when a create is refused", async () => {
  listing([]);
  catalog();
  on("POST", /^\/inference\/connections$/, {
    status: 409,
    body: { code: "ENTITY_ALREADY_EXISTS", message: "That name is taken." },
  });
  renderModels();
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

it("says which connection name is taken, in its stored casing, not as an identifier", async () => {
  listing([]);
  catalog();
  on("POST", /^\/inference\/connections$/, {
    status: 409,
    body: {
      code: "INFERENCE_CONNECTION_NAME_TAKEN",
      message: "an inference connection named 'Remote' already exists",
    },
  });
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-http"));
  await userEvent.type(await screen.findByTestId("connection-name"), "remote");
  await userEvent.type(screen.getByTestId("connection-custom-model"), "some/model");
  await userEvent.type(screen.getByTestId("connection-revision"), "abc123");
  await userEvent.type(screen.getByTestId("connection-endpoint"), "https://example.invalid");
  await userEvent.click(screen.getByTestId("connection-submit"));
  const shown = await screen.findByTestId("connection-error");
  expect(shown.textContent).toContain("an inference connection named 'Remote' already exists");
  expect(shown.textContent).not.toContain("INFERENCE_CONNECTION_NAME_TAKEN");
});

// --- the served catalog, and the fields that are closed sets --------------------

it("opens a new local connection on the model the installation offers by default", async () => {
  listing([]);
  catalog();
  renderModels();

  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(screen.getByTestId("choose-local"));

  // Not in the same tick as the kind: the catalog is a query, and the field says
  // so until it can answer.
  await waitFor(() =>
    expect(screen.getByTestId("connection-model").textContent).toContain(SAM_BASE_PLUS),
  );
});

it("builds the model list from what the wire served, under this build's own headings", async () => {
  // The headings are this build's copy over the abilities the wire named: a
  // driver declares which ability it serves and never how it is named on screen.
  listing([]);
  catalog();
  renderModels();

  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(screen.getByTestId("choose-local"));
  await userEvent.click(await screen.findByTestId("connection-model"));

  expect(screen.getByText("Segment — click to mask")).not.toBeNull();
  expect(screen.getByText("Detect — describe in text")).not.toBeNull();
  expect(screen.getByRole("option", { name: new RegExp(DINO_TINY) })).not.toBeNull();
});

it("marks only the gated offers in the model list", async () => {
  listing([]);
  catalog();
  renderModels();

  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(screen.getByTestId("choose-local"));
  await userEvent.click(await screen.findByTestId("connection-model"));

  const gated = screen.getAllByTestId("gated-badge");
  expect(gated).toHaveLength(1);
  expect(
    screen.getByRole("option", { name: new RegExp(SAM3) }).contains(gated[0]!),
  ).toBe(true);
});

it("says the catalog is being read rather than showing a dead control", async () => {
  listing([]);
  // An answer that never arrives, which is what a slow server looks like. A stub
  // that refused instead would be testing the refusal, and a disabled grey select
  // is precisely what neither state may render.
  catalogHangs();
  renderModels();

  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(screen.getByTestId("choose-local"));

  expect(await screen.findByTestId("catalog-loading")).not.toBeNull();
  expect(screen.queryByTestId("connection-model")).toBeNull();
  // And no free model id field either, which is the state's other half rather
  // than an accident of the seeding order. Nothing is known yet about what is
  // offered, so a field for typing an id would be inviting somebody to answer a
  // question the server is still answering - and it would move under whatever
  // they had typed the moment the list landed.
  expect(screen.queryByTestId("connection-custom-model")).toBeNull();
});

it("renders a refusal as prose when the catalog cannot be read, and leaves the form usable", async () => {
  listing([]);
  catalog({ code: "WORKSPACE_BUSY", message: "The workspace is busy." }, 503);
  renderModels();

  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(screen.getByTestId("choose-local"));

  const refusal = await screen.findByTestId("catalog-unavailable");
  expect(refusal.textContent).toContain("busy");
  // Prose, not an empty select — and the form still works: a model id typed by
  // hand needs no catalog at all, so not knowing what is offered is not a reason
  // to stop somebody configuring a connection.
  expect(screen.queryByTestId("connection-model")).toBeNull();
  expect(screen.getByTestId("connection-custom-model")).not.toBeNull();
  // And another attempt is offered rather than being a reload away, which is what
  // buys the query its `retry: false`.
  expect(within(refusal).getByRole("button", { name: "Try again" })).not.toBeNull();
});

it("invites an installation with nothing to offer, rather than showing an empty list", async () => {
  listing([]);
  catalog({ items: [], total: 0 });
  renderModels();

  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(screen.getByTestId("choose-local"));

  const empty = await screen.findByTestId("catalog-empty");
  expect(empty.textContent).toContain("driver");
  expect(screen.getByTestId("connection-custom-model")).not.toBeNull();
});

it("opens a reused dialog on nothing a discarded session left behind", async () => {
  // A local session abandoned while the catalog was still in flight, and the
  // answer landing after it. The form that opens next is a different connection
  // and an HTTP one: it names whatever somebody else's endpoint runs, so a model
  // id it did not ask for is one nobody typed and nothing on screen explains.
  listing([]);
  const serve = catalogOnCue();
  renderModels();

  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(screen.getByTestId("choose-local"));
  await screen.findByTestId("catalog-loading");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByTestId("connection-dialog")).toBeNull());

  serve();

  await userEvent.click(screen.getByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-http"));

  expect(value(await screen.findByTestId("connection-custom-model"))).toBe("");
  expect(value(screen.getByTestId("connection-revision"))).toBe("");
});

it("lands a successful retry on the offers it just read", async () => {
  // What the control promises. The catalog refused, so the form is on its free
  // fields; the retry then works, and leaving it on an empty Custom would make
  // the select it just filled the only way forward.
  listing([]);
  let asked = 0;
  handlers.push(
    providersOnly(() => {
      asked += 1;
      return asked === 1
        ? { status: 503, body: { code: "WORKSPACE_BUSY", message: "The workspace is busy." } }
        : { status: 200, body: SERVED };
    }),
  );
  renderModels();

  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(screen.getByTestId("choose-local"));
  const refusal = await screen.findByTestId("catalog-unavailable");
  await userEvent.click(within(refusal).getByRole("button", { name: "Try again" }));

  await waitFor(() =>
    expect(screen.getByTestId("connection-model").textContent).toContain(SAM_BASE_PLUS),
  );
  expect(screen.queryByTestId("connection-custom-model")).toBeNull();
});

it("keeps a model id typed while the catalog was refusing", async () => {
  // The other side of the retry: the sentinel is only re-seeded where nobody has
  // put anything under it. A model id typed by hand is a decision, and a list
  // arriving afterwards is not a reason to discard one.
  listing([]);
  let asked = 0;
  handlers.push(
    providersOnly(() => {
      asked += 1;
      return asked === 1
        ? { status: 503, body: { code: "WORKSPACE_BUSY", message: "The workspace is busy." } }
        : { status: 200, body: SERVED };
    }),
  );
  renderModels();

  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(screen.getByTestId("choose-local"));
  const refusal = await screen.findByTestId("catalog-unavailable");
  await userEvent.type(screen.getByTestId("connection-custom-model"), "someone/else");
  await userEvent.click(within(refusal).getByRole("button", { name: "Try again" }));

  const model = await screen.findByTestId("connection-model");
  await waitFor(() => expect(model.textContent).toContain("Custom"));
  expect(value(screen.getByTestId("connection-custom-model"))).toBe("someone/else");
});

it("shows a stored connection as the offer it names", async () => {
  // The edit form used to resolve the stored pair against a constant, in the tick
  // the dialog opened. It resolves against a served list now, which arrives after
  // it — and the select must land on the offer rather than on Custom.
  listing([connection({ model_id: SAM_BASE_PLUS, model_revision: SAM_BASE_PLUS_COMMIT })]);
  catalog();
  renderModels();

  await openSheet("sam2-local");
  await userEvent.click(await screen.findByTestId("action-edit"));

  await waitFor(() =>
    expect(screen.getByTestId("connection-model").textContent).toContain(SAM_BASE_PLUS),
  );
});

it("stacks each option: the id on one line, what it is for on the next", async () => {
  listing([]);
  catalog();
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));

  // The closed trigger first, which is where the squash was visible: it shows the
  // selected option's own two lines rather than a second copy of the layout.
  await waitFor(() =>
    expect(screen.getByTestId("connection-model").textContent).toContain(SAM_BASE_PLUS),
  );
  const trigger = screen.getByTestId("connection-model");
  const triggerMeta = trigger.querySelector(".text-muted-foreground");
  expect(triggerMeta?.textContent).toContain(SAM_BASE_PLUS_HINT);
  // The id keeps the line to itself — the whole point of the restructure.
  expect(triggerMeta?.textContent).not.toContain(SAM_BASE_PLUS);

  await userEvent.click(trigger);
  for (const [modelId, hint] of [
    [SAM_BASE_PLUS, SAM_BASE_PLUS_HINT],
    [SAM3, SAM3_HINT],
    [DINO_TINY, DINO_TINY_HINT],
  ]) {
    const option = screen.getByRole("option", { name: new RegExp(modelId!) });
    expect(option.querySelector(".text-muted-foreground")?.textContent).toBe(hint);
  }
  // Including Custom, so no row in the list is a different height from its
  // neighbours.
  const custom = screen.getByRole("option", { name: /Custom model/ });
  expect(custom.querySelector(".text-muted-foreground")).not.toBeNull();
});

it("states a model's access requirement while it is being chosen, not when it is downloaded", async () => {
  // Principle 9, on the one offer that carries a requirement: a gated model
  // refuses its own download with a sentence naming the remedy, and by the time
  // that arrives somebody has chosen a model, created a connection and pressed a
  // button. This is the same fact while the choice is still open.
  listing([]);
  catalog();
  sizeIs(1_200_000_000);
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  await waitFor(() =>
    expect(screen.getByTestId("connection-model").textContent).toContain(SAM_BASE_PLUS),
  );

  // The form opens on an entry anybody can fetch, so there is nothing to say.
  expect(screen.queryByTestId("model-access")).toBeNull();

  await userEvent.click(screen.getByTestId("connection-model"));
  await userEvent.click(screen.getByRole("option", { name: new RegExp(SAM3) }));

  const line = await screen.findByTestId("model-access");
  expect(line.textContent).toContain(SAM3_NOTE);
  expect(line.querySelector("a")?.getAttribute("href")).toBe(SAM3_URL);
  // Nothing has been created and nothing has been fetched: the requirement is on
  // screen strictly before either becomes possible.
  expect(sent.some((one) => one.method === "POST")).toBe(false);
});

it("drops the access line again when the choice moves back to an open model", async () => {
  // The line describes the current choice rather than the dialog's history. One
  // left behind would tell somebody a model they are not using needs approval,
  // which is the same defect as never showing it, pointed the other way.
  listing([]);
  catalog();
  sizeIs(1_200_000_000);
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));

  await userEvent.click(await screen.findByTestId("connection-model"));
  await userEvent.click(screen.getByRole("option", { name: new RegExp(SAM3) }));
  expect(await screen.findByTestId("model-access")).not.toBeNull();

  await userEvent.click(screen.getByTestId("connection-model"));
  await userEvent.click(screen.getByRole("option", { name: new RegExp(SAM_BASE_PLUS) }));
  expect(screen.queryByTestId("model-access")).toBeNull();
});

it("keeps saying a model needs access when it is pinned to another commit", async () => {
  // An access gate belongs to the repository, not to the revision: choosing a
  // different commit of the same model does not exempt anybody from its terms.
  // The line is therefore looked up by model id alone, where the select's own
  // "is this the offered entry" test compares both halves — a distinction no
  // other test in this file could see, and the reason this one exists.
  listing([
    connection({
      name: "pinned-elsewhere",
      model_id: SAM3,
      model_revision: "0000000000000000000000000000000000000000",
      allowed_actions: ["update", "update_model", "delete"],
    }),
  ]);
  catalog();
  sizeIs(1_200_000_000);
  renderModels();
  await openSheet("pinned-elsewhere");
  await userEvent.click(await screen.findByTestId("action-edit"));

  const line = await screen.findByTestId("model-access");
  expect(line.textContent).toContain(SAM3_NOTE);
});

it("curates without restricting: Custom reveals the free model and revision", async () => {
  listing([]);
  catalog();
  sizeIs(1_200_000_000);
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  // Once the list is on screen, so this is the offered state hiding the free
  // fields rather than the loading state hiding them.
  const select = await screen.findByTestId("connection-model");
  await waitFor(() => expect(select.textContent).toContain(SAM_BASE_PLUS));
  expect(screen.queryByTestId("connection-custom-model")).toBeNull();

  await userEvent.click(select);
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
  catalog();
  sizeIs(1_200_000_000);
  renderModels();
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
  catalog();
  sizeIs(1_200_000_000);
  const posted: Record<string, unknown>[] = [];
  handlers.push((request) => {
    if (request.method !== "POST" || !request.url.endsWith("/inference/connections")) return;
    return { status: 201, body: connection() };
  });
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  await userEvent.type(await screen.findByTestId("connection-name"), "sam2");
  // The model half of the pair arrives with the catalog, and the form is not
  // complete until it has.
  await waitFor(() =>
    expect(screen.getByTestId("connection-model").textContent).toContain(SAM_BASE_PLUS),
  );

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
  catalog();
  sizeIs(1_200_000_000);
  on("POST", /^\/inference\/connections$/, {
    status: 422,
    body: {
      code: "INFERENCE_CONNECTION_INVALID",
      message: "fp16 is not available on cpu; cpu runs in fp32",
    },
  });
  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  await userEvent.type(await screen.findByTestId("connection-name"), "sam2");
  await waitFor(() =>
    expect(screen.getByTestId("connection-model").textContent).toContain(SAM_BASE_PLUS),
  );
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
  catalog();
  sizeIs(1_200_000_000);
  renderModels();
  await openSheet("sam2-local");
  await userEvent.click(await screen.findByTestId("action-edit"));
  expect((await screen.findByTestId("connection-device")).textContent).toContain("cuda:1");
});

it("shows an offered model at another revision as a custom connection", async () => {
  // The pair is the identity. A row naming an offered model at a revision no
  // driver pins is not that entry, and showing it as one would misreport which
  // weights it runs.
  listing([
    connection({
      model_revision: "0000000000000000000000000000000000000000",
      allowed_actions: ["download_weights", "update", "update_model", "delete"],
    }),
  ]);
  catalog();
  sizeIs(1_200_000_000);
  renderModels();
  await openSheet("sam2-local");
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

  renderModels();
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
});

it("shows a download that failed on a declared error as its sentence, never its code", async () => {
  // The job settled under the same code the request path answers, and that code
  // is withheld from the vocabulary on purpose — the kernel's own sentence is
  // the remedy — so the sentence shows and the identifier does not.
  listing([
    connection({
      download: downloadOf(
        "failed",
        0,
        null,
        'running a model locally needs the local-inference extra. Install it with: pip install "visionset[local-inference]"',
        "LOCAL_INFERENCE_UNAVAILABLE",
      ),
    }),
  ]);
  renderModels();

  // The row only notes that something failed; the sentence is in the sheet.
  const row = await screen.findByTestId("connection-sam2-local");
  expect(within(row).getByTestId("connection-failed-note").textContent).toBe("Download failed");
  expect(within(row).queryByText(/pip install/)).toBeNull();

  const sheet = await openSheet("sam2-local");
  const shown = within(sheet).getByTestId("download-error");
  expect(shown.textContent).toContain('pip install "visionset[local-inference]"');
  expect(shown.textContent).not.toContain("LOCAL_INFERENCE_UNAVAILABLE");
});

it("surfaces a failed download as prose in the sheet, and leaves the same action as the retry", async () => {
  // Read off the row, so a transfer that died while nobody was watching still has
  // its sentence when somebody comes back to the screen. The row notes it and
  // the sheet says it; nothing but the press that opens the sheet is clicked.
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
  renderModels();

  const row = await screen.findByTestId("connection-sam2-local");
  expect(within(row).getByTestId("connection-failed-note").textContent).toBe("Download failed");
  // The never-half-ready invariant, at the layer a person reads it: the row still
  // says Not set up, beside the note.
  expect(within(row).getByTestId("connection-status").textContent).toContain("Not set up");

  const sheet = await openSheet("sam2-local");
  const shown = within(sheet).getByTestId("download-error");
  // A sentence: the worker's raw message gets its full stop before the remedy.
  expect(shown.textContent).toContain("the connection was lost. Nothing is half-installed");
  // What happened, and what to do about it — including that nothing is half done.
  expect(shown.textContent).toContain("still Not set up");
  expect(shown.textContent).toContain("Retry the download to resume from what arrived.");
  expect(within(sheet).getByTestId("connection-status").textContent).toContain("Not set up");
  // The retry *is* the action: no second control appeared, and this one is live.
  expect(within(sheet).getAllByTestId("download-weights")).toHaveLength(1);
  const retry = button(sheet, "download-weights");
  expect(retry.disabled).toBe(false);
  expect(retry.textContent).toContain("Retry download");
  expect(within(sheet).queryByRole("button", { name: "Download weights" })).toBeNull();
});

it("offers the completeness check in the sheet once a connection is ready", async () => {
  listing([
    connection({ setup_state: "ready", allowed_actions: ["download_weights", "update", "delete"] }),
  ]);
  renderModels();
  await screen.findByTestId("models-grid");
  // Neither on the row: there is nothing to fetch, only something to check.
  expect(screen.queryByTestId("download-weights")).toBeNull();
  expect(screen.queryByTestId("action-verify-weights")).toBeNull();

  const sheet = await openSheet("sam2-local");
  expect(within(sheet).queryByTestId("download-weights")).toBeNull();
  expect(button(sheet, "action-verify-weights").textContent).toContain("Check for missing files");
  // A set-up local model says what the checks are for, before one is pressed.
  expect(within(sheet).getByTestId("model-setup").textContent).toContain("The weights are on this machine.");
});

it("does not offer the completeness check when the wire withholds the action", async () => {
  // The same `setup_state`, so a screen deriving the button from the row's state
  // would still render it. Only `allowed_actions` gets this right.
  listing([connection({ setup_state: "ready", allowed_actions: ["update", "delete"] })]);
  renderModels();
  const sheet = await openSheet("sam2-local");
  await within(sheet).findByTestId("action-edit");
  expect(within(sheet).queryByTestId("action-verify-weights")).toBeNull();
});

it("runs the same request for the completeness check as for Download weights", async () => {
  listing([
    connection({ setup_state: "ready", allowed_actions: ["download_weights", "update", "delete"] }),
  ]);
  on("POST", /\/download$/, { status: 202, body: job("queued") });
  on("GET", /^\/background-jobs\/job-1$/, { status: 200, body: job("succeeded", 1, 1) });
  renderModels();
  await openSheet("sam2-local");
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
  renderModels();
  await openSheet("sam2-local");

  expect((await screen.findByTestId("action-verify-weights")).textContent).toContain(
    "Check for missing files",
  );
  expect((await screen.findByTestId("action-check-integrity")).textContent).toContain(
    "Check files are undamaged",
  );
  expect(screen.queryByText("Verify weights")).toBeNull();
  // Each is a plain button now, side by side in the sheet's setup section.
  expect(screen.getByRole("button", { name: "Check for missing files" })).toBe(screen.getByTestId("action-verify-weights"));
  expect(screen.getByRole("button", { name: "Check files are undamaged" })).toBe(screen.getByTestId("action-check-integrity"));
});

it("sends the integrity check to its own route, not to the download", async () => {
  listing([connection({ setup_state: "ready", allowed_actions: READY_BOTH })]);
  on("POST", /\/check-integrity$/, { status: 202, body: job("queued") });
  on("GET", /^\/background-jobs\/job-1$/, { status: 200, body: job("succeeded", 4, 4) });
  renderModels();
  await openSheet("sam2-local");
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

it("says a refused integrity check in the vocabulary's sentence, with no code beside it", async () => {
  listing([connection({ setup_state: "ready", allowed_actions: READY_BOTH })]);
  on("POST", /\/check-integrity$/, {
    status: 409,
    body: {
      code: "INFERENCE_CONNECTION_NOT_SET_UP",
      message: "inference connection 11111111-1111-4111-8111-111111111111 has no weights to check",
    },
  });
  renderModels();
  await openSheet("sam2-local");
  await userEvent.click(await screen.findByTestId("action-check-integrity"));

  const shown = await screen.findByTestId("integrity-error");
  expect(shown.textContent).toContain("not set up yet");
  expect(shown.textContent).not.toContain("INFERENCE_CONNECTION_NOT_SET_UP");
  expect(shown.textContent).not.toContain("11111111-1111-4111-8111-111111111111");
});

it("does not offer the integrity check when the wire withholds it", async () => {
  // The same `setup_state` as the row above, so a screen deriving the item from
  // the state would still render it. `allowed_actions` is the only source.
  listing([
    connection({ setup_state: "ready", allowed_actions: ["download_weights", "update", "delete"] }),
  ]);
  renderModels();
  await openSheet("sam2-local");
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
      allowed_actions: ["download_weights", "update", "update_model", "delete"],
      integrity_check: checkOf(
        "failed",
        9,
        9,
        "1 file does not match (model.safetensors). The damaged copies have been removed",
      ),
    }),
  ]);

  renderModels();

  const row = await screen.findByTestId("connection-sam2-local");
  expect(within(row).getByTestId("connection-status").textContent).toContain("Not set up");
  expect(within(row).getByTestId("connection-failed-note").textContent).toBe("Check failed");

  const sheet = await openSheet("sam2-local");
  const shown = within(sheet).getByTestId("integrity-error");
  expect(shown.textContent).toContain("model.safetensors");
  // What was done, and what to do — the remedy is the action the sheet now has.
  expect(shown.textContent).toContain("removed");
  expect(shown.textContent).toContain(
    "Download the weights again: with the bad files gone, it is a real transfer rather than a cache hit.",
  );
  expect(within(sheet).getByTestId("connection-status").textContent).toContain("Not set up");
  expect(button(sheet, "download-weights").disabled).toBe(false);
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
  renderModels();

  expect((await screen.findByTestId("integrity-progress-prose")).textContent).toBe(
    "2 of 9 files · 22%",
  );
  expect(screen.queryByTestId("download-progress")).toBeNull();
});

it("withdraws the download while a check is reading the same files", async () => {
  // The three controls act on one cache, so a live run of either kind takes all
  // of them out of reach. Not a bare disabled control: the label says which run
  // is holding them, which is the check rather than anything this row started.
  listing([
    connection({
      setup_state: "ready",
      allowed_actions: READY_BOTH,
      integrity_check: checkOf("running", 2, 9),
    }),
  ]);
  renderModels();
  await openSheet("sam2-local");

  const verify = (await screen.findByTestId("action-verify-weights")) as HTMLButtonElement;
  const check = (await screen.findByTestId("action-check-integrity")) as HTMLButtonElement;
  expect(verify.disabled).toBe(true);
  expect(check.disabled).toBe(true);
  expect(verify.textContent).toContain("Reading every file");
  expect(check.textContent).toContain("Reading every file");
  // And the sheet says what is holding them, and that leaving does not stop it.
  const setup = screen.getByTestId("model-setup");
  expect(within(setup).getByTestId("integrity-progress")).not.toBeNull();
  expect(setup.textContent).toContain("Runs on the server — closing this or leaving the page does not stop it.");
});

it("withdraws the check while a download is running", async () => {
  // The same rule in the other direction. At `ready` a download is the
  // completeness check, so the label somebody reads is "Checking…" — the
  // vocabulary the row already uses for that reading of `download_weights`.
  listing([
    connection({
      setup_state: "ready",
      allowed_actions: READY_BOTH,
      download: downloadOf("running", 1, 4),
    }),
  ]);
  renderModels();
  await openSheet("sam2-local");

  const check = (await screen.findByTestId("action-check-integrity")) as HTMLButtonElement;
  expect(check.disabled).toBe(true);
  expect(check.textContent).toContain("Checking");
  expect((screen.getByTestId("action-verify-weights") as HTMLButtonElement).disabled).toBe(true);
  expect(within(screen.getByTestId("model-setup")).getByTestId("download-progress").textContent).toContain("Checking");
});

it("shows the check in the State cell in place of the badge, and takes the download out of reach in the sheet", async () => {
  // The not-yet-set-up reading of the same rule. The row shows the run in the
  // State cell, named for what it is doing — the check, rather than a download
  // this row never started — and the sheet's own button is disabled, never absent.
  listing([
    connection({
      setup_state: "not_set_up",
      allowed_actions: ["download_weights", "update", "update_model", "delete"],
      integrity_check: checkOf("running", 2, 9),
    }),
  ]);
  renderModels();

  const run = await screen.findByTestId("integrity-progress");
  const setup = screen.getByTestId("connection-setup");
  expect(setup.contains(run)).toBe(true);
  expect(run.textContent).toContain("Reading every file");
  expect(screen.getByTestId("integrity-progress-bar").getAttribute("aria-label")).toBe("Checking files are undamaged");
  // Instead of the badge, not beside it.
  expect(screen.queryByTestId("connection-status")).toBeNull();
  expect(screen.queryByTestId("download-weights")).toBeNull();
  expect(screen.queryByTestId("connection-detail")).toBeNull();

  const sheet = await openSheet("sam2-local");
  const download = button(sheet, "download-weights");
  expect(download.disabled).toBe(true);
  expect(download.textContent).toContain("Reading every file…");
  // No price is asked for while a run holds the files.
  expect(within(sheet).queryByTestId("connection-size")).toBeNull();
});

it("shows a download's run in the State cell in place of the badge and the button", async () => {
  listing([
    connection({
      setup_state: "not_set_up",
      allowed_actions: ["download_weights", "update", "update_model", "delete"],
      download: downloadOf("running", 400_000_000, 1_600_000_000),
    }),
  ]);
  sizeIs(1_600_000_000);
  renderModels();

  const run = await screen.findByTestId("download-progress");
  expect(screen.getByTestId("connection-setup").contains(run)).toBe(true);
  expect(run.textContent).toContain("Downloading");
  expect(screen.getByTestId("download-progress-bar").getAttribute("aria-label")).toBe("Downloading weights");
  expect(screen.queryByTestId("download-weights")).toBeNull();
  expect(screen.queryByTestId("connection-status")).toBeNull();
  expect(screen.queryByTestId("connection-size-known")).toBeNull();
  expect(screen.queryByTestId("connection-detail")).toBeNull();

  // The sheet shows the same run, and withdraws the download rather than
  // hiding it: the label names what is happening.
  const sheet = await openSheet("sam2-local");
  expect(within(within(sheet).getByTestId("model-setup")).getByTestId("download-progress").textContent).toContain("Downloading");
  const download = button(sheet, "download-weights");
  expect(download.disabled).toBe(true);
  expect(download.textContent).toContain("Downloading…");
  expect(within(sheet).queryByTestId("connection-size")).toBeNull();
});

it("names a ready connection's download as a check for missing files", async () => {
  listing([
    connection({
      setup_state: "ready",
      allowed_actions: READY_BOTH,
      download: downloadOf("running", 1, 4),
    }),
  ]);
  renderModels();

  const run = await screen.findByTestId("download-progress");
  expect(run.textContent).toContain("Checking");
  expect(run.textContent).not.toContain("Downloading");
  expect(screen.getByTestId("download-progress-bar").getAttribute("aria-label")).toBe("Checking for missing files");
});

it("shows Starting… in the sheet between pressing Download and the wire bringing the job back", async () => {
  listing([connection()]);
  sizeIs(1_200_000_000);
  let release = (): void => undefined;
  const served = new Promise<Answer>((settle) => {
    release = () => settle({ status: 500, body: { code: "LOCAL_INFERENCE_UNAVAILABLE", message: "needs the extra." } });
  });
  handlers.push((request) =>
    request.method === "POST" && /\/download$/.test(new URL(request.url).pathname) ? served : undefined,
  );
  renderModels();

  const sheet = await openSheet("sam2-local");
  await userEvent.click(await within(sheet).findByTestId("download-weights"));

  const starting = await within(sheet).findByTestId("run-starting");
  expect(within(sheet).getByTestId("model-setup").contains(starting)).toBe(true);
  expect(within(sheet).getByTestId("run-starting-prose").textContent).toBe("Starting…");
  expect(within(sheet).getByTestId("model-setup").textContent).toContain(
    "Runs on the server — closing this or leaving the page does not stop it.",
  );
  // The button stays, disabled and named for what is happening, so it cannot be
  // pressed twice; and the price is no longer on offer.
  const download = button(sheet, "download-weights");
  expect(download.disabled).toBe(true);
  expect(download.textContent).toContain("Downloading…");
  expect(within(sheet).queryByTestId("connection-size")).toBeNull();
  // Only the sheet knows a request is out: the row has not been told by the wire.
  expect(within(screen.getByTestId("connection-sam2-local")).queryByTestId("run-starting")).toBeNull();
  expect(within(screen.getByTestId("connection-sam2-local")).getByTestId("connection-status").textContent).toBe("Not set up");

  release();
  // A refusal answers the request: the panel is gone, and the button is back as the retry.
  expect(await within(sheet).findByTestId("download-error")).not.toBeNull();
  expect(within(sheet).queryByTestId("run-starting")).toBeNull();
  const retry = button(sheet, "download-weights");
  expect(retry.disabled).toBe(false);
  expect(retry.textContent).toContain("Retry download");
});

it("shows the size's refusal in the sheet, and still offers the download", async () => {
  listing([connection()]);
  on("GET", /^\/inference\/download-size$/, {
    status: 500,
    body: { code: "LOCAL_INFERENCE_UNAVAILABLE", message: 'running a model locally needs the local-inference extra. Install it with: pip install "visionset[local-inference]"' },
  });
  renderModels();

  const sheet = await openSheet("sam2-local");
  const unavailable = await within(sheet).findByTestId("connection-size-unavailable");
  expect(unavailable.textContent).toContain('pip install "visionset[local-inference]"');
  expect(unavailable.textContent).not.toContain("LOCAL_INFERENCE_UNAVAILABLE");
  expect(within(sheet).getByTestId("connection-size").contains(unavailable)).toBe(true);
  expect(button(sheet, "download-weights").disabled).toBe(false);
  expect(within(sheet).queryByTestId("connection-size-known")).toBeNull();
  // Said once, in the sheet: the row has no place for it.
  expect(within(screen.getByTestId("connection-sam2-local")).queryByTestId("connection-size-unavailable")).toBeNull();
});

it("offers everything again once neither run is live", async () => {
  // The positive path the three above are the absence of: a settled record must
  // not go on withdrawing the controls, or a connection whose check finished
  // could never be asked for anything.
  listing([
    connection({
      setup_state: "ready",
      allowed_actions: READY_BOTH,
      download: downloadOf("succeeded", 4, 4),
      integrity_check: checkOf("succeeded", 9, 9),
    }),
  ]);
  renderModels();
  await openSheet("sam2-local");

  const verify = (await screen.findByTestId("action-verify-weights")) as HTMLButtonElement;
  const check = (await screen.findByTestId("action-check-integrity")) as HTMLButtonElement;
  expect(verify.disabled).toBe(false);
  expect(check.disabled).toBe(false);
  expect(verify.textContent).toContain("Check for missing files");
  expect(check.textContent).toContain("Check files are undamaged");
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
  renderModels();

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
  renderModels();

  expect((await screen.findByTestId("integrity-progress-prose")).textContent).toBe("Queued for a worker");
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
  renderModels();

  expect((await screen.findByTestId("integrity-progress-prose")).textContent).toBe(
    "Reading the file list…",
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
  renderModels();
  await screen.findByTestId("models-grid");

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

  renderModels();
  expect((await screen.findByTestId("integrity-progress-prose")).textContent).toContain("44%");

  await waitFor(() => expect(screen.queryByTestId("integrity-progress")).toBeNull(), {
    timeout: 5_000,
  });
  expect(sent.some((one) => one.url.includes("/background-jobs/"))).toBe(false);

  const settled = reads;
  await new Promise((done) => setTimeout(done, CONNECTION_POLL_MS * 1.5));
  expect(reads).toBe(settled);
});

// --- editing and deleting ------------------------------------------------------

it("edits without offering to change the kind", async () => {
  listing([connection({ setup_state: "ready", allowed_actions: ["update", "delete"] })]);
  catalog();
  renderModels();
  await openSheet("sam2-local");
  await userEvent.click(await screen.findByTestId("action-edit"));
  expect(value(await screen.findByTestId("connection-name"))).toBe("sam2-local");
  expect(screen.queryByTestId("choose-type")).toBeNull();
});

it("shows a set-up connection's model as a fact, and offers no field that would move it", async () => {
  // Read off the declaration: a ready row does not declare `update_model`, so
  // the select, the custom id and the revision are not on the form — the
  // reference is stated where the choice used to be, with the remedy beside
  // it — while name, device and precision stay editable. Nothing here decides
  // that a ready row is fixed; the wire did.
  listing([
    connection({
      setup_state: "ready",
      capabilities: ["point_suggest"],
      allowed_actions: ["download_weights", "check_integrity", "update", "delete"],
    }),
  ]);
  catalog();
  renderModels();
  await openSheet("sam2-local");
  await userEvent.click(await screen.findByTestId("action-edit"));
  const fixed = await screen.findByTestId("connection-model-fixed");
  expect(fixed.textContent).toBe(`${SAM_BASE_PLUS} @ ${SAM_BASE_PLUS_COMMIT}`);
  expect(screen.getByText(/Add a new model to run a different one/)).not.toBeNull();
  expect(screen.queryByTestId("connection-model")).toBeNull();
  expect(screen.queryByTestId("connection-custom-model")).toBeNull();
  expect(screen.queryByTestId("connection-revision")).toBeNull();
  expect(screen.getByTestId("connection-name")).not.toBeNull();
  expect(screen.getByTestId("connection-device")).not.toBeNull();
  expect(screen.getByTestId("connection-precision")).not.toBeNull();
});

it("offers the model fields on a connection still waiting for its weights", async () => {
  // The same form, on a row that declares `update_model`: the select is there,
  // and the reference it resolves to is the stored pair.
  listing([connection({ model_id: SAM_BASE_PLUS, model_revision: SAM_BASE_PLUS_COMMIT })]);
  catalog();
  renderModels();
  await openSheet("sam2-local");
  await userEvent.click(await screen.findByTestId("action-edit"));
  await waitFor(() =>
    expect(screen.getByTestId("connection-model").textContent).toContain(SAM_BASE_PLUS),
  );
  expect(screen.queryByTestId("connection-model-fixed")).toBeNull();
});

it("sends the unchanged reference with a rename of a set-up connection", async () => {
  // The whole shape travels on every edit and a mention is not a move: the
  // server compares values, so the fixed reference rides along unchanged.
  listing([
    connection({
      setup_state: "ready",
      capabilities: ["point_suggest"],
      allowed_actions: ["download_weights", "check_integrity", "update", "delete"],
    }),
  ]);
  catalog();
  const patches: Request[] = [];
  handlers.push((request) => {
    if (request.method !== "PATCH") return;
    patches.push(request);
    return { status: 200, body: connection({ name: "renamed", setup_state: "ready" }) };
  });
  renderModels();
  await openSheet("sam2-local");
  await userEvent.click(await screen.findByTestId("action-edit"));
  const name = await screen.findByTestId("connection-name");
  await userEvent.clear(name);
  await userEvent.type(name, "renamed");
  await userEvent.click(screen.getByTestId("connection-submit"));
  await waitFor(() => expect(patches).toHaveLength(1));
  const body = await patches[0]!.clone().json();
  expect(body.name).toBe("renamed");
  expect(body.model_id).toBe(SAM_BASE_PLUS);
  expect(body.model_revision).toBe(SAM_BASE_PLUS_COMMIT);
});

it("sends an edit carrying only the fields ConnectionUpdate declares", async () => {
  // `ConnectionUpdate` forbids unknown fields and has no `connection_type` —
  // the kind is not editable — so a PATCH that echoed the whole form back is a
  // 422 nobody asked for. The create body is the one that carries the kind, and
  // the case below proves it still does, so this is not passing on a client
  // that stopped sending it anywhere.
  listing([connection({ setup_state: "ready", allowed_actions: READY_BOTH })]);
  catalog();
  handlers.push((request) =>
    request.method === "PATCH" ? { status: 200, body: connection() } : undefined,
  );

  renderModels();
  await openSheet("sam2-local");
  await userEvent.click(await screen.findByTestId("action-edit"));
  await userEvent.click(await screen.findByTestId("connection-submit"));

  const patch = await waitFor(() => {
    const found = sent.find((request) => request.method === "PATCH");
    expect(found).toBeDefined();
    return found!;
  });
  expect(Object.keys(await patch.clone().json()).sort()).toEqual([
    "credential_env",
    "device",
    "endpoint_url",
    "model_id",
    "model_revision",
    "name",
    "precision",
    // Declared by `ConnectionUpdate`, so it travels on an edit too: null means
    // *leave this alone*, and a re-pin from one offered checkpoint to another
    // carries the new owner across.
    "provider_id",
  ]);
});

it("sends a create carrying the kind, which only the create model declares", async () => {
  listing([]);
  catalog();
  handlers.push((request) =>
    request.method === "POST" ? { status: 201, body: connection() } : undefined,
  );

  renderModels();
  await userEvent.click(await screen.findByTestId("new-connection"));
  await userEvent.click(await screen.findByTestId("choose-local"));
  await userEvent.type(await screen.findByTestId("connection-name"), "sam2-local");
  await waitFor(() =>
    expect(screen.getByTestId("connection-model").textContent).toContain(SAM_BASE_PLUS),
  );
  await userEvent.click(await screen.findByTestId("connection-submit"));

  const post = await waitFor(() => {
    const found = sent.find((request) => request.method === "POST");
    expect(found).toBeDefined();
    return found!;
  });
  expect(await post.clone().json()).toMatchObject({ connection_type: "local" });
});

it("states the blast radius of a delete accurately", async () => {
  listing([connection()]);
  renderModels();
  await openSheet("sam2-local");
  await userEvent.click(await screen.findByTestId("action-delete"));
  expect(await screen.findByText("Annotations keep their model provenance; only this configuration is removed.")).not.toBeNull();
});

it("renders a refused delete in words, not as an identifier", async () => {
  listing([connection()]);
  on("DELETE", /\/inference\/connections\//, {
    status: 404,
    body: {
      code: "INFERENCE_CONNECTION_NOT_FOUND",
      message: "inference connection 99999999-9999-4999-8999-999999999999 not found in workspace /tmp/ws",
    },
  });
  renderModels();
  await openSheet("sam2-local");
  await userEvent.click(await screen.findByTestId("action-delete"));
  await userEvent.click(await screen.findByTestId("delete-connection-submit"));
  const shown = await screen.findByTestId("delete-connection-error");
  expect(shown.textContent).toContain("That model connection is no longer on record.");
  expect(shown.textContent).not.toContain("INFERENCE_CONNECTION_NOT_FOUND");
  expect(shown.textContent).not.toContain("workspace");
});

// --- the model sheet ------------------------------------------------------------

it("opens the sheet from anywhere on the row, and gives focus back to the name when it closes", async () => {
  listing([connection({ id: "a", name: "alpha" }), connection({ id: "b", name: "beta" })]);
  renderModels();
  const row = await screen.findByTestId("connection-alpha");
  expect(screen.queryByTestId("model-sheet")).toBeNull();

  // The pointer's way in: a press on any cell of the row, not only on the name.
  await userEvent.click(within(row).getByTestId("model-reference"));
  const sheet = await screen.findByTestId("model-sheet");
  expect(within(sheet).getByRole("heading", { name: "alpha" })).not.toBeNull();
  expect(screen.queryByRole("heading", { name: "beta" })).toBeNull();

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByTestId("model-sheet")).toBeNull());
  expect(document.activeElement).toBe(screen.getByTestId("open-alpha"));
  expect(document.activeElement?.id).toBe("model-open-a");

  // The keyboard's: the name is a real button, and the same sheet opens from it
  // — once, not twice, though the press also reaches the row.
  await userEvent.click(screen.getByTestId("open-beta"));
  expect(await screen.findAllByTestId("model-sheet")).toHaveLength(1);
  expect(within(screen.getByTestId("model-sheet")).getByRole("heading", { name: "beta" })).not.toBeNull();
  await closeSheet();
  expect(document.activeElement).toBe(screen.getByTestId("open-beta"));
});

it("opens the sheet from the keyboard on the name", async () => {
  listing([connection()]);
  renderModels();
  const name = await screen.findByTestId("open-sam2-local");
  name.focus();
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByTestId("model-sheet")).not.toBeNull();
  await closeSheet();
  expect(document.activeElement).toBe(name);
});

it("heads the sheet with the name and the weights, and says everything the row truncates", async () => {
  listing([full()]);
  renderModels();
  const sheet = await openSheet("sam2-full");

  expect(within(sheet).getByRole("heading", { name: "sam2-full" })).not.toBeNull();
  // The description is what the connection *is*: the model id, whole.
  expect(within(sheet).getByTestId("sheet-weights").textContent).toBe(SAM_BASE_PLUS);
  // The model section: the revision in full, where the weights come from, where
  // they run, and every ability on one list.
  expect(within(sheet).getByTestId("sheet-revision").textContent).toContain(SAM_BASE_PLUS_COMMIT);
  expect(within(sheet).getByText("Hugging Face")).not.toBeNull();
  expect(within(sheet).getByTestId("sheet-runs").lastElementChild?.textContent).toBe("Local · cuda · fp16");
  expect(
    within(within(sheet).getByTestId("sheet-abilities"))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Suggests from clicks", "Finds what you name", "writes boxes or polygons"]);
  // A local connection has no endpoint to say.
  expect(within(sheet).queryByText("Endpoint")).toBeNull();
  // Setup first: the state's word, and what a set-up model's two checks are.
  expect(within(within(sheet).getByTestId("model-setup")).getByRole("heading", { name: "Setup" })).not.toBeNull();
  expect(within(within(sheet).getByTestId("model-setup")).getByTestId("connection-status").textContent).toBe("Ready");
});

it("says an http connection's endpoint in full, and its runs-on line without a device it does not carry", async () => {
  listing([hosted({ capabilities: ["text_detect"] })]);
  renderModels();
  const row = await screen.findByTestId("connection-remote-seg");
  // The row holds the host; the sheet holds the whole address.
  expect(within(row).getByTestId("connection-source").textContent).toBe("HTTP · models.example");

  const sheet = await openSheet("remote-seg");
  expect(within(sheet).getByText("Endpoint")).not.toBeNull();
  expect(within(sheet).getByText("https://models.example/predict")).not.toBeNull();
  expect(within(sheet).getByTestId("sheet-runs").lastElementChild?.textContent).toBe("HTTP");
  expect(within(sheet).getByTestId("sheet-abilities").textContent).toContain("Finds what you name");
  // No file action for a model with no files; the endpoint's test is the one.
  expect(within(sheet).queryByTestId("download-weights")).toBeNull();
  expect(within(sheet).queryByTestId("action-verify-weights")).toBeNull();
  expect(within(sheet).queryByTestId("action-check-integrity")).toBeNull();
  expect(within(sheet).getByTestId("action-test-endpoint")).not.toBeNull();
});

it("says a set-up model that declares nothing as a sentence, never as a blank", async () => {
  listing([connection({ setup_state: "ready", allowed_actions: ["update", "delete"] })]);
  renderModels();
  const sheet = await openSheet("sam2-local");
  expect(within(sheet).getByTestId("sheet-abilities").textContent).toContain("Nothing declared.");
  expect(within(sheet).queryByRole("list", { name: "What it does" })).toBeNull();
});

it("shows the sheet the live row on every poll, so a run started elsewhere is watched there too", async () => {
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
  renderModels();

  const sheet = await openSheet("sam2-local");
  expect(within(within(sheet).getByTestId("model-setup")).getByTestId("download-progress-prose").textContent).toContain("50%");
  expect(within(sheet).getByTestId("download-weights").textContent).toContain("Downloading…");

  // The transfer ends under an open sheet: the panel goes, the badge turns Ready
  // and the download's reading becomes the missing-files check.
  await waitFor(
    () => expect(within(sheet).getByTestId("connection-status").textContent).toContain("Ready"),
    { timeout: 5_000 },
  );
  expect(within(sheet).queryByTestId("download-progress")).toBeNull();
  expect(within(sheet).queryByTestId("download-weights")).toBeNull();
  expect((within(sheet).getByTestId("action-verify-weights") as HTMLButtonElement).disabled).toBe(false);
});

it("keeps a run going on the server when the sheet is closed, and still shows it on the row", async () => {
  listing([connection({ download: downloadOf("running", 400_000_000, 1_600_000_000) })]);
  renderModels();
  const sheet = await openSheet("sam2-local");
  expect(within(sheet).getByTestId("model-setup").textContent).toContain(
    "Runs on the server — closing this or leaving the page does not stop it.",
  );
  await closeSheet();

  // Closing sent nothing: no cancel, no pause — only the sheet's view went.
  expect(sent.some((one) => one.method !== "GET")).toBe(false);
  expect(within(screen.getByTestId("connection-setup")).getByTestId("download-progress-prose").textContent).toBe("400.0 MB of 1.6 GB · 25%");
});

it("removes a deleted connection from the list and closes its sheet", async () => {
  let rows: Connection[] = [connection({ id: "a", name: "doomed" }), connection({ id: "b", name: "kept" })];
  handlers.push((request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path.endsWith("/connections")) {
      return { status: 200, body: { items: rows, total: rows.length } };
    }
    if (request.method === "DELETE" && /\/inference\/connections\/a$/.test(path)) {
      rows = rows.filter((row) => row.id !== "a");
      return { status: 204 };
    }
    return undefined;
  });
  renderModels();

  const sheet = await openSheet("doomed");
  await userEvent.click(within(sheet).getByTestId("action-delete"));
  expect((await screen.findByTestId("delete-connection-dialog")).textContent).toContain("Delete doomed?");
  await userEvent.click(screen.getByTestId("delete-connection-submit"));

  await waitFor(() => expect(screen.queryByTestId("connection-doomed")).toBeNull());
  await waitFor(() => expect(screen.queryByTestId("model-sheet")).toBeNull());
  await waitFor(() => expect(screen.queryByTestId("delete-connection-dialog")).toBeNull());
  expect(screen.getByTestId("connection-kept")).not.toBeNull();
  expect(sent.some((one) => one.method === "DELETE" && one.url.endsWith("/inference/connections/a"))).toBe(true);
  // And the status bar's count follows the list.
  expect(screen.getByTestId("models-count").textContent).toBe("1 model");
});

it("keeps the sheet open under a delete that was cancelled", async () => {
  listing([connection()]);
  renderModels();
  const sheet = await openSheet("sam2-local");
  await userEvent.click(within(sheet).getByTestId("action-delete"));
  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByTestId("delete-connection-dialog")).toBeNull());
  expect(screen.getByTestId("model-sheet")).not.toBeNull();
  expect(sent.some((one) => one.method === "DELETE")).toBe(false);
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

// --- asking an endpoint what it answers -----------------------------------------

/** Everything an http connection declares before anybody asked its endpoint. */
const HTTP_ACTIONS: Connection["allowed_actions"] = ["test_endpoint", "update", "delete"];

function hosted(overrides: Partial<Connection> = {}): Connection {
  return connection({
    id: "hosted-1",
    name: "remote-seg",
    connection_type: "http",
    device: null,
    precision: null,
    endpoint_url: "https://models.example/predict",
    provider_id: null,
    credential_env: null,
    origin: "custom",
    setup_state: "ready",
    allowed_actions: HTTP_ACTIONS,
    capabilities: [],
    ...overrides,
  });
}

it("opens an http edit on the credential variable the row names", async () => {
  listing([hosted({ credential_env: "ACME_TOKEN" })]);
  catalog();
  renderModels();
  await openSheet("remote-seg");
  await userEvent.click(await screen.findByTestId("action-edit"));
  expect((await screen.findByTestId("connection-credential-env")).getAttribute("value")).toBe(
    "ACME_TOKEN",
  );
});

it("offers Test endpoint exactly where the wire declares it", async () => {
  listing([hosted(), connection({ setup_state: "ready", allowed_actions: READY_BOTH })]);
  renderModels();
  await openSheet("remote-seg");
  expect((await screen.findByTestId("action-test-endpoint")).textContent).toContain("Test endpoint");
  await closeSheet();
  const local = await openSheet("sam2-local");
  expect(within(local).getByTestId("action-check-integrity")).not.toBeNull();
  expect(screen.queryByTestId("action-test-endpoint")).toBeNull();
});

it("sends the test to its own route and re-reads the list", async () => {
  listing([hosted()]);
  on("POST", /\/test-endpoint$/, {
    status: 200,
    body: hosted({ capabilities: ["point_suggest"], provider_id: "http" }),
  });
  renderModels();
  await openSheet("remote-seg");
  await userEvent.click(await screen.findByTestId("action-test-endpoint"));
  await waitFor(() =>
    expect(sent.some((one) => one.method === "POST" && one.url.endsWith("/test-endpoint"))).toBe(true),
  );
  await waitFor(() =>
    expect(sent.filter((one) => one.method === "GET" && one.url.includes("/inference/connections")).length).toBeGreaterThan(1),
  );
});

it("says it is asking while the request is in flight, and stops once it lands", async () => {
  // An unreachable host can hold this open for a real connect timeout, so the
  // sheet says it twice — on the button, which cannot be pressed again, and in a
  // line under it — and the test releases the answer by hand the way
  // `catalogOnCue` releases a slow catalog answer.
  listing([hosted()]);
  let release = (): void => undefined;
  const served = new Promise<Answer>((settle) => {
    release = () => settle({ status: 200, body: hosted({ capabilities: ["point_suggest"], provider_id: "http" }) });
  });
  handlers.push((request) =>
    request.method === "POST" && /\/test-endpoint$/.test(new URL(request.url).pathname)
      ? served
      : undefined,
  );
  renderModels();
  await openSheet("remote-seg");
  await userEvent.click(await screen.findByTestId("action-test-endpoint"));

  const hint = await screen.findByTestId("test-endpoint-pending");
  expect(hint.textContent).toContain("Asking the endpoint…");
  const asking = screen.getByTestId("action-test-endpoint") as HTMLButtonElement;
  expect(asking.disabled).toBe(true);
  expect(asking.textContent).toContain("Asking the endpoint…");

  release();
  await waitFor(() => expect(screen.queryByTestId("test-endpoint-pending")).toBeNull());
  expect((screen.getByTestId("action-test-endpoint") as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByTestId("action-test-endpoint").textContent).toContain("Test endpoint");
  expect(screen.getByTestId("test-endpoint-ok").textContent).toBe("The endpoint answered.");
});

it("renders an endpoint that did not answer as the server's sentence, not a code", async () => {
  listing([hosted()]);
  on("POST", /\/test-endpoint$/, {
    status: 502,
    body: {
      code: "INFERENCE_ENDPOINT_UNAVAILABLE",
      message: "endpoint https://models.example/predict could not be reached: connection refused",
    },
  });
  renderModels();
  await openSheet("remote-seg");
  await userEvent.click(await screen.findByTestId("action-test-endpoint"));
  const notice = await screen.findByTestId("test-endpoint-error");
  expect(notice.textContent).toContain("could not be reached");
  expect(notice.textContent).not.toContain("INFERENCE_ENDPOINT_UNAVAILABLE");
});
