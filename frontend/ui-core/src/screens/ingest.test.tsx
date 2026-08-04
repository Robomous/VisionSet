/**
 * The ingest flow, success and failure, against a stubbed `fetch`.
 *
 * Two things here can only be checked this way.
 *
 * **The multipart encoding.** `openapi-fetch` JSON-encodes a body by default and
 * has no idea a `File` is special, so a request without a `bodySerializer` sends
 * `[object File]` and the server answers 422 about a field that looks correct.
 * The type system is no help — the generated body type is `string` for a binary
 * part — so the only place that bug is visible is in the request that went out.
 *
 * **The per-file report.** `IngestFailureKind` exists so a report can be
 * *grouped*: `unsupported` is operator noise, `corrupt` is data loss. A table that
 * rendered fifty rows in arrival order would make finding the second kind the
 * reader's problem.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { probeClip } from "./clipProbe";
import { IngestScreen } from "./IngestScreen";
import { batchActions, datasetOf } from "../testing/wire.fixtures.js";

// The browser-side clip read is substituted whole. The default — a promise that
// never settles — is exactly what the real module does under jsdom, which has no
// media pipeline; tests that want an estimate resolve it explicitly.
vi.mock("./clipProbe", () => ({
  probeClip: vi.fn(() => new Promise(() => {})),
}));

const API = "http://visionset.test";
// `ProgressCounts` is six counters and the server always sends all six.
const NO_PROGRESS = {
  unannotated: 0,
  annotated: 0,
  review_pending: 0,
  accepted: 0,
  skipped: 0,
  total: 0,
} as const;

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

type Answer = { status: number; body?: unknown };
type Handler = (request: Request) => Answer | undefined;

let handlers: Handler[] = [];
const sent: Request[] = [];
/**
 * Bodies are consumed by the time an assertion runs, so they are read up front.
 *
 * Read by *attempting* `formData()` rather than by inspecting `content-type`:
 * `openapi-fetch` deletes that header when a `bodySerializer` returns a
 * `FormData`, because only the browser can write the multipart boundary. So the
 * header on a multipart request is absent, and branching on it puts every upload
 * down the JSON path.
 */
const bodies = new Map<Request, FormData | string>();

async function readBody(request: Request): Promise<FormData | string> {
  try {
    return await request.clone().formData();
  } catch {
    return await request.text();
  }
}

/**
 * `instanceof FormData` is **not** usable here.
 *
 * vitest's jsdom environment leaves Node's undici `Request` in place while
 * providing jsdom's `FormData`, so `request.formData()` answers with undici's
 * class and the check fails against a value that is, in every way that matters, a
 * `FormData`. Duck-typing is the honest test of what a caller can do with it.
 */
function isFormData(value: unknown): value is FormData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FormData).getAll === "function"
  );
}

beforeEach(() => {
  handlers = [];
  sent.length = 0;
  bodies.clear();
  writeToken("a-token");
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    if (request.method !== "GET") bodies.set(request, await readBody(request));
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) {
        return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? null), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(
      JSON.stringify({ code: "NO_STUB", message: `${request.method} ${request.url}` }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
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

const VIDEO_SOURCE = {
  id: SOURCE,
  project_id: PROJECT,
  kind: "video",
  name: "drive.mp4",
  registered_at: "2026-07-31T00:00:00.000000Z",
  video: {
    width: 1920,
    height: 1080,
    fps: 29.97,
    duration_seconds: 12.5,
    codec: "h264",
    extraction_fps: 2,
  },
};

const IMAGE_SOURCE = {
  id: SOURCE,
  project_id: PROJECT,
  kind: "image_directory",
  name: "photos",
  registered_at: "2026-07-31T00:00:00.000000Z",
  video: null,
};

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB,
    source_id: SOURCE,
    state: "completed",
    error: null,
    batch_id: "44444444-4444-4444-8444-444444444444",
    batch_name: "drive.mp4",
    processed: 25,
    total: 25,
    failures: [],
    ...overrides,
  };
}

function pick(name: string, type: string): File {
  return new File(["bytes"], name, { type });
}

async function choose(files: readonly File[]): Promise<void> {
  await userEvent.upload(screen.getByTestId("file-input"), [...files]);
}

describe("registering a source", () => {
  beforeEach(() => {
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
  });

  it("sends images as one multipart part each, not as a JSON body", async () => {
    on("POST", /\/sources\/images$/, { status: 201, body: IMAGE_SOURCE });

    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("a.png", "image/png"), pick("b.png", "image/png")]);
    await userEvent.click(screen.getByTestId("register-source"));

    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    const request = sent.find((r) => r.method === "POST");
    const form = bodies.get(request as Request);
    // A `FormData` at all is the claim: without a `bodySerializer`, `openapi-fetch`
    // JSON-encodes the body and the server answers 422 about a field that looks
    // correct. The type system cannot see it — a binary part types as `string`.
    expect(isFormData(form)).toBe(true);
    // Repeated under one name, because that is what `list[UploadFile]` reads. A
    // single part holding an array is silently one file with a stringified name.
    expect((form as FormData).getAll("files")).toHaveLength(2);
    // And the source is named (#245): blank field, so the suggestion — the first
    // file's *stem*, because "a.png" is a file and "a" is a thing you can call a
    // source. Without a name the server would call it by the upload's digest.
    expect((form as FormData).get("name")).toBe("a");
  });

  it("sends a clip with the extraction rate, chosen before anything is probed", async () => {
    on("POST", /\/sources\/video$/, { status: 201, body: VIDEO_SOURCE });

    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("drive.mp4", "video/mp4")]);

    // The rate lives in the selection panel and is decided *now* — the probe
    // does not exist yet, because `extraction_fps` is part of what the source is.
    await userEvent.clear(screen.getByTestId("extraction-fps"));
    await userEvent.type(screen.getByTestId("extraction-fps"), "2");
    await userEvent.click(screen.getByTestId("register-source"));

    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    const form = bodies.get(sent.find((r) => r.method === "POST") as Request) as FormData;
    expect(form.get("extraction_fps")).toBe("2");
    // The clip rides under `file` — singular, unlike the images' repeated `files`,
    // because `register_video_source` takes one `UploadFile`.
    //
    // A clip states no name (#245): its filename already is one, and the wire
    // does not take the parameter on the video route.
    expect(form.has("name")).toBe(false);

    // Its *contents* are not asserted, and that is a limit of the harness rather
    // than a gap in the claim: jsdom's `File` and undici's `FormData` are two
    // realms, so a real `File` appended here is coerced to a string exactly as a
    // jsdom `FormData` was before `vitest.setup.ts` reconciled that pair. The bug
    // this test exists for — no `bodySerializer`, so the body is JSON — is caught
    // by the body being a `FormData` at all.
    expect(form.has("file")).toBe(true);
  });

  it("shows the probe only after registering, which is the only time it exists", async () => {
    on("POST", /\/sources\/video$/, { status: 201, body: VIDEO_SOURCE });

    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("drive.mp4", "video/mp4")]);
    expect(screen.queryByTestId("probe")).toBeNull();

    await userEvent.click(screen.getByTestId("register-source"));

    const probe = await screen.findByTestId("probe");
    expect(probe.textContent).toContain("29.97");
    expect(probe.textContent).toContain("1920×1080");
    // Duration × extraction rate, which is what the run will actually produce.
    expect(probe.textContent).toContain("25");
  });

  it("renders a refusal with its code rather than a bare failure", async () => {
    on("POST", /\/sources\/images$/, {
      status: 422,
      body: { code: "UNSUPPORTED_MEDIA", message: "notes.txt is not an image." },
    });

    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("notes.txt", "text/plain")]);
    await userEvent.click(screen.getByTestId("register-source"));

    const error = await screen.findByTestId("register-error");
    // The server's own sentence, which is already written for a person — the
    // vocabulary has no entry for this code precisely because it could not
    // improve on one naming the file. What is gone is the identifier in front
    // of it (F16).
    expect(error.textContent).toContain("notes.txt is not an image.");
    expect(error.textContent).not.toContain("UNSUPPORTED_MEDIA");
  });
});

/**
 * The selection panel: what was chosen, read back before anything uploads.
 *
 * The rate went inline → modal (#234) → inline (#243), and what survives every
 * arrangement is the pair of claims here: the rate exists only for a clip, and a
 * rate the request could not carry disables the registration — with the
 * explanation adjacent, which is what made the inline return legal under
 * `DESIGN.md` principle 9.
 */
describe("the selection panel", () => {
  beforeEach(() => {
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
  });

  it("reads the choice back with a way out that costs nothing", async () => {
    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("a.png", "image/png"), pick("b.png", "image/png")]);

    const selection = screen.getByTestId("selection");
    expect(within(selection).getByTestId("chosen").textContent).toBe("2 files");
    expect(selection.textContent).toContain("images");
    // A bunch reads back its contents, not only its count.
    expect(within(selection).getByTestId("selection-names").textContent).toContain("a.png");
    expect(within(selection).getByTestId("selection-names").textContent).toContain("b.png");
    // Images have no rate, anywhere — not a hidden field, not a dialog.
    expect(screen.queryByTestId("extraction-fps")).toBeNull();

    await userEvent.click(screen.getByTestId("clear-files"));
    expect(screen.queryByTestId("selection")).toBeNull();
    expect(sent.some((r) => r.method === "POST")).toBe(false);
    // And the flow is back at its start, dropzone included.
    expect(screen.getByTestId("file-input")).not.toBeNull();
  });

  it("previews three names of a large bunch and counts the rest", async () => {
    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose(
      ["p0", "p1", "p2", "p3", "p4"].map((name) => pick(`${name}.png`, "image/png")),
    );

    const names = screen.getByTestId("selection-names");
    expect(names.textContent).toContain("p0.png");
    expect(names.textContent).toContain("p2.png");
    // Recognition, not inventory: the fourth name is a count, not a row.
    expect(names.textContent).not.toContain("p3.png");
    expect(names.textContent).toContain("+2 more");
    expect(screen.getByTestId("chosen").textContent).toBe("5 files");
  });

  it("names the source from the field, and suggests the first file's stem", async () => {
    on("POST", /\/sources\/images$/, { status: 201, body: IMAGE_SOURCE });

    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("a.png", "image/png"), pick("b.png", "image/png")]);

    const field = screen.getByTestId("source-name") as HTMLInputElement;
    // The placeholder is what a blank submits — the batch-name pattern.
    expect(field.placeholder).toBe("a");

    await userEvent.type(field, "vacation shots");
    await userEvent.click(screen.getByTestId("register-source"));

    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    const form = bodies.get(sent.find((r) => r.method === "POST") as Request) as FormData;
    expect(form.get("name")).toBe("vacation shots");
  });

  it("offers no name field for a clip, whose filename already is one", async () => {
    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("drive.mp4", "video/mp4")]);
    expect(screen.queryByTestId("source-name")).toBeNull();
  });

  it("shows the rate for a clip, with the second-source consequence beside it", async () => {
    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("drive.mp4", "video/mp4")]);

    const selection = screen.getByTestId("selection");
    expect(within(selection).getByTestId("extraction-fps")).not.toBeNull();
    expect(selection.textContent).toContain("second source");
    expect((screen.getByTestId("extraction-fps") as HTMLInputElement).value).toBe("1");
  });

  it("cannot register a clip whose rate is unusable, and says so next door", async () => {
    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("drive.mp4", "video/mp4")]);

    const button = (): HTMLButtonElement =>
      screen.getByTestId("register-source") as HTMLButtonElement;
    expect(button().disabled).toBe(false);

    // `<input type="number">` reports a rejected keystroke as an empty string,
    // so a blank is reachable by typing, not only by pasting.
    await userEvent.clear(screen.getByTestId("extraction-fps"));
    expect(button().disabled).toBe(true);

    await userEvent.type(screen.getByTestId("extraction-fps"), "0");
    expect(button().disabled).toBe(true);

    await userEvent.clear(screen.getByTestId("extraction-fps"));
    await userEvent.type(screen.getByTestId("extraction-fps"), "2");
    expect(button().disabled).toBe(false);
  });

  it("estimates the frames from the browser's own read of the clip", async () => {
    vi.mocked(probeClip).mockResolvedValueOnce({ durationSeconds: 47.7 });

    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("drive.mp4", "video/mp4")]);

    // floor(47.7 × 1) — the same arithmetic as the probe card's "Frames
    // expected", so the estimate and the registered answer can only differ by
    // what the two probes measured, never by rounding.
    expect((await screen.findByTestId("frames-estimate")).textContent).toContain("47");
    expect(screen.getByTestId("selection").textContent).toContain("47.7 s");

    // It tracks the typed rate: floor(47.7 × 2) = 95, which a `round` would
    // also answer — but floor(47.7 × 1) = 47 is 48 under `round`, so the pair
    // pins the spelling.
    await userEvent.clear(screen.getByTestId("extraction-fps"));
    await userEvent.type(screen.getByTestId("extraction-fps"), "2");
    expect(screen.getByTestId("frames-estimate").textContent).toContain("95");

    // No usable rate, no estimate — a number computed from garbage is worse
    // than none.
    await userEvent.clear(screen.getByTestId("extraction-fps"));
    expect(screen.queryByTestId("frames-estimate")).toBeNull();
  });

  it("degrades to no estimate when the browser cannot read the clip", async () => {
    // The default mock never settles, which is also jsdom's real behaviour —
    // no media pipeline, so `loadedmetadata` never fires.
    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("drive.mp4", "video/mp4")]);

    expect(screen.queryByTestId("frames-estimate")).toBeNull();
    // The estimate is advisory: not having one must not block registration.
    expect((screen.getByTestId("register-source") as HTMLButtonElement).disabled).toBe(false);
  });
});

/**
 * The choreography: three steps, exactly one active (#243).
 *
 * The claims here are about what is and is not *mounted*, because that is what
 * changed: the old layout kept every card fully live at once, so a user could
 * swap the files in step 1 while step 2 still described the old ones. `data-state`
 * is asserted rather than any class, and the absence of controls is asserted
 * rather than their styling — a dimmed-but-live dropzone would pass a style
 * check and still have the bug.
 */
describe("one step at a time", () => {
  beforeEach(() => {
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /\/sources\/images$/, { status: 201, body: IMAGE_SOURCE });
    on("POST", /\/ingest-jobs$/, { status: 202, body: job({ state: "running", processed: 0 }) });
    on("GET", /\/ingest-jobs\//, { status: 200, body: job({ state: "running", batch_id: null }) });
  });

  function state(step: string): string | undefined {
    return screen.getByTestId(step).dataset.state;
  }

  it("opens with the road ahead visible and only the first step live", async () => {
    render(mount(<IngestScreen projectId={PROJECT} />));

    expect(state("step-1")).toBe("active");
    expect(state("step-2")).toBe("upcoming");
    expect(state("step-3")).toBe("upcoming");
    // Upcoming steps say what they will ask; they do not render controls.
    expect(screen.getByTestId("step-2").textContent).toContain("target batch");
    expect(screen.queryByTestId("source-card")).toBeNull();
    expect(screen.queryByTestId("run-card")).toBeNull();
  });

  it("registering collapses step 1 to a summary with no live controls", async () => {
    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("a.png", "image/png")]);
    await userEvent.click(screen.getByTestId("register-source"));
    await screen.findByTestId("source-card");

    expect(state("step-1")).toBe("complete");
    expect(state("step-2")).toBe("active");
    expect(screen.getByTestId("step-1-summary").textContent).toContain("a.png");
    // The hole the collapse closes: no dropzone and no register button remain,
    // so the selection cannot drift out from under the source card.
    expect(screen.queryByTestId("file-input")).toBeNull();
    expect(screen.queryByTestId("register-source")).toBeNull();
  });

  it("change files walks back to a clean first step", async () => {
    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("a.png", "image/png")]);
    await userEvent.click(screen.getByTestId("register-source"));
    await screen.findByTestId("source-card");

    // The back lives in step 2's own footer and names the step it returns to.
    await userEvent.click(screen.getByTestId("back-to-files"));

    expect(state("step-1")).toBe("active");
    expect(state("step-2")).toBe("upcoming");
    expect(screen.queryByTestId("source-card")).toBeNull();
    expect(screen.queryByTestId("selection")).toBeNull();
    expect(screen.getByTestId("file-input")).not.toBeNull();
  });

  it("shortens a digest-named source instead of printing 64 hex characters", async () => {
    // A staged upload of images is named by its content digest — the server
    // stages parts under `uploads/<digest>/` and `SourceOut.name` is that
    // directory's basename. The full string survives in `title`; the visible
    // text does not shout hex at the user. The naming itself is a recorded
    // cross-surface wart (#245), not this screen's to fix.
    const digest = "4a3192814961e3d8b7f84a79dedfd8ecd7aaab876b0630cdcdf7536b3ad352c6";
    handlers.length = 0;
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /\/sources\/images$/, {
      status: 201,
      body: { ...IMAGE_SOURCE, name: digest },
    });
    on("POST", /\/ingest-jobs$/, {
      status: 202,
      body: job({ state: "running", processed: 0, batch_name: digest }),
    });
    on("GET", /\/ingest-jobs\//, { status: 200, body: job({ batch_name: digest }) });

    render(mount(<IngestScreen projectId={PROJECT} onOpenBatch={vi.fn()} />));
    await choose([pick("a.png", "image/png")]);
    await userEvent.click(screen.getByTestId("register-source"));
    await screen.findByTestId("source-card");

    expect(screen.getByTestId("source-card").textContent).toContain("4a319281…");
    expect(screen.getByTestId("source-card").textContent).not.toContain(digest);

    await userEvent.click(screen.getByTestId("start-ingest"));
    const outcome = await screen.findByTestId("run-outcome");
    expect(outcome.textContent).toContain("4a319281…");
    expect(outcome.textContent).not.toContain(digest);
    expect(screen.getByTestId("step-2-summary").textContent).not.toContain(digest);
  });

  it("launching collapses step 2 and hands the flow to the run", async () => {
    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("a.png", "image/png")]);
    await userEvent.click(screen.getByTestId("register-source"));
    await screen.findByTestId("source-card");
    await userEvent.click(screen.getByTestId("start-ingest"));

    await screen.findByTestId("run-card");
    expect(state("step-2")).toBe("complete");
    expect(state("step-3")).toBe("active");
    // The summary names what was decided: this source, into this batch.
    expect(screen.getByTestId("step-2-summary").textContent).toContain("photos");
    expect(screen.queryByTestId("start-ingest")).toBeNull();
    expect(screen.queryByTestId("target-batch")).toBeNull();
    // A run in flight cannot be un-launched, so no back control of any kind
    // survives the launch — a back that cancels nothing would be a lie.
    expect(screen.queryByTestId("back-to-files")).toBeNull();
    expect(screen.queryByTestId("rerun-source")).toBeNull();
  });
});

describe("launching a run", () => {
  it("offers only draft batches, because anything else is refused at the launch", async () => {
    on("GET", /\/batches$/, {
      status: 200,
      body: {
        items: [
          { id: "b1", project_id: PROJECT, name: "open", state: "draft", schema_version: null, asset_count: 4, progress: NO_PROGRESS, allowed_actions: batchActions("draft"), promoted_asset_count: 0, parent_batch_id: null },
          { id: "b2", project_id: PROJECT, name: "frozen", state: "in_annotation", schema_version: 1, asset_count: 9, progress: NO_PROGRESS, allowed_actions: batchActions("in_annotation"), promoted_asset_count: 0, parent_batch_id: null },
        ],
        total: 2,
      },
    });
    on("POST", /\/sources\/images$/, { status: 201, body: IMAGE_SOURCE });

    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("a.png", "image/png")]);
    await userEvent.click(screen.getByTestId("register-source"));
    await screen.findByTestId("source-card");

    await userEvent.click(screen.getByTestId("target-batch"));
    expect(screen.queryByRole("option", { name: /open/ })).not.toBeNull();
    // A batch past `draft` answers 409 `BATCH_NOT_EDITABLE`, so offering it would
    // be offering a refusal.
    expect(screen.queryByRole("option", { name: /frozen/ })).toBeNull();
  });

  it("names a new batch after the source when nobody typed one", async () => {
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /\/sources\/images$/, { status: 201, body: IMAGE_SOURCE });
    on("POST", /\/ingest-jobs$/, { status: 202, body: job({ state: "running" }) });
    on("GET", /\/ingest-jobs\//, { status: 200, body: job() });

    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("a.png", "image/png")]);
    await userEvent.click(screen.getByTestId("register-source"));
    await screen.findByTestId("source-card");
    await userEvent.click(screen.getByTestId("start-ingest"));

    await waitFor(() => expect(sent.some((r) => r.url.endsWith("/ingest-jobs"))).toBe(true));
    const request = sent.find((r) => r.url.endsWith("/ingest-jobs") && r.method === "POST");
    expect(JSON.parse(bodies.get(request as Request) as string)).toEqual({
      batch_name: "photos",
    });
  });

  it("surfaces a synchronous launch refusal on the form, not on a job", async () => {
    // #28's rule: anything the request can refuse is refused before a job row
    // exists — so there is nothing to poll and the message belongs here.
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /\/sources\/images$/, { status: 201, body: IMAGE_SOURCE });
    on("POST", /\/ingest-jobs$/, {
      status: 409,
      body: { code: "BATCH_NOT_EDITABLE", message: "That batch is already in annotation." },
    });

    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("a.png", "image/png")]);
    await userEvent.click(screen.getByTestId("register-source"));
    await screen.findByTestId("source-card");
    await userEvent.click(screen.getByTestId("start-ingest"));

    expect((await screen.findByTestId("start-error")).textContent).toContain(
      "can no longer be edited",
    );
    expect(screen.queryByTestId("run-card")).toBeNull();
  });
});

describe("watching a run", () => {
  beforeEach(() => {
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /\/sources\/images$/, { status: 201, body: IMAGE_SOURCE });
    on("POST", /\/ingest-jobs$/, { status: 202, body: job({ state: "running", processed: 0 }) });
  });

  async function launch(): Promise<void> {
    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("a.png", "image/png")]);
    await userEvent.click(screen.getByTestId("register-source"));
    await screen.findByTestId("source-card");
    await userEvent.click(screen.getByTestId("start-ingest"));
  }

  it("shows processed of total for a directory", async () => {
    on("GET", /\/ingest-jobs\//, { status: 200, body: job({ processed: 12, total: 25 }) });
    await launch();
    expect((await screen.findByTestId("run-progress")).textContent).toBe("12 of 25");
  });

  it("shows a count and no denominator for a clip, because there is none", async () => {
    // `VideoMetadata` carries no frame count by design, so an extraction has no
    // total until it is over. A bar that invented one would be a lie with a
    // percentage on it.
    on("GET", /\/ingest-jobs\//, { status: 200, body: job({ processed: 7, total: null }) });
    await launch();
    expect((await screen.findByTestId("run-progress")).textContent).toBe("7 extracted");
  });

  it("groups the per-file report by kind, and leads with the one that is data loss", async () => {
    on("GET", /\/ingest-jobs\//, {
      status: 200,
      body: job({
        processed: 3,
        total: 5,
        failures: [
          { name: "/srv/data/photos/notes.txt", kind: "unsupported", reason: "not an image" },
          { name: "/srv/data/photos/truncated.jpg", kind: "corrupt", reason: "unexpected end of file" },
        ],
      }),
    });
    await launch();

    const failures = await screen.findByTestId("failures");
    expect(within(failures).getByTestId("corrupt-count").textContent).toContain("1 corrupt");
    expect(within(failures).getByTestId("unsupported-count").textContent).toContain(
      "1 unsupported",
    );
    // Corrupt first: an unsupported file is operator noise and a corrupt one is
    // data loss, which is the whole reason the kind exists.
    expect(within(failures).getByTestId("failure-0").textContent).toContain("truncated.jpg");

    // And the name is rendered defensively. For a *directory* ingest,
    // `IngestFailure.name` is the full server path — a known kernel inconsistency,
    // deliberately left alone — so an absolute path from somebody else's machine
    // must not land in the table. The full string stays in `title`.
    expect(within(failures).getByTestId("failure-0").textContent).not.toContain("/srv/data");
    expect(within(failures).getByTestId("failure-0").querySelector("[title]")?.getAttribute("title")).toBe(
      "/srv/data/photos/truncated.jpg",
    );
  });

  it("offers a resume only for a failed run, and says what a resume is", async () => {
    on("GET", /\/ingest-jobs\//, {
      status: 200,
      body: job({ state: "failed", error: "ffmpeg is not installed", processed: 0 }),
    });
    await launch();

    await screen.findByTestId("run-error");
    const resume = screen.getByTestId("resume-ingest");
    expect(resume).not.toBeNull();
    // `failed → running` is the kernel's first backward edge. `running → running`
    // is deliberately absent, so a stuck job has no button here at all.
    expect(screen.getByTestId("run-card").textContent).toContain("a redo, not a skip");
  });

  it("has no resume for a completed run", async () => {
    on("GET", /\/ingest-jobs\//, { status: 200, body: job() });
    await launch();
    await waitFor(() => expect(screen.getByTestId("run-state").textContent).toBe("Done"));
    expect(screen.queryByTestId("resume-ingest")).toBeNull();
  });

  /**
   * A refused resume, which is a different fact from the run's own error (F9).
   *
   * `resume.isError` was read nowhere, and the `run-error` alert a few lines up
   * shows the *job row's* stored cause — so a rejected resume left the old
   * failure on screen unchanged and the button re-enabled. Nothing distinguished
   * "the resume was refused" from "the press did nothing", which is why the two
   * assertions below are about them being told apart.
   */
  it("says a refused resume was refused, and does not disguise it as the run's own error", async () => {
    on("GET", /\/ingest-jobs\//, {
      status: 200,
      body: job({ state: "failed", error: "ffmpeg is not installed", processed: 0 }),
    });
    on("POST", /\/resume$/, {
      status: 409,
      body: { code: "INVALID_TRANSITION", message: "job cannot become running from completed" },
    });
    await launch();

    await userEvent.click(await screen.findByTestId("resume-ingest"));

    const said = (await screen.findByTestId("resume-error")).textContent ?? "";
    expect(said).toContain("already moved on");
    expect(said).not.toContain("INVALID_TRANSITION");
    // Two different things went wrong and the screen says both. The run's own
    // cause is still there, unchanged and still about the run.
    expect(screen.getByTestId("run-error").textContent).toContain("ffmpeg is not installed");
  });
});

/**
 * #181: a settled run used to be a dead end.
 *
 * The card reached `completed` and the screen went inert — no route to the batch
 * it had just filled, and `Start ingest` stayed `disabled` for the rest of the
 * page's life. Ingest is the product's entry point, so a terminal state naming
 * no next step leaves a first-time user guessing where their assets went.
 *
 * The batch id is what makes the button conditional rather than decorative:
 * `enqueue` stores only an id it was *handed*, which is null for a run creating
 * its own batch, and the row learns the real one in the transaction that
 * completes the job. So "offer it when there is one" is a live branch, not
 * defensive programming.
 */
describe("what a settled run offers next", () => {
  beforeEach(() => {
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /\/sources\/images$/, { status: 201, body: IMAGE_SOURCE });
    on("POST", /\/ingest-jobs$/, { status: 202, body: job({ state: "running", processed: 0 }) });
  });

  async function launch(node: JSX.Element): Promise<void> {
    render(mount(node));
    await choose([pick("a.png", "image/png")]);
    await userEvent.click(screen.getByTestId("register-source"));
    await screen.findByTestId("source-card");
    await userEvent.click(screen.getByTestId("start-ingest"));
  }

  it("names the batch a completed run filled and offers to open it", async () => {
    on("GET", /\/ingest-jobs\//, { status: 200, body: job() });
    const open = vi.fn();
    await launch(<IngestScreen projectId={PROJECT} onOpenBatch={open} />);

    const outcome = await screen.findByTestId("run-outcome");
    expect(outcome.textContent).toContain("drive.mp4");
    await userEvent.click(screen.getByTestId("open-batch"));
    // The id, not the name — the route is `/projects/{id}/batches/{id}`, and the
    // name is a label a user typed that two batches may share.
    expect(open).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
  });

  it("offers nothing to open while the run is still going", async () => {
    // There is nothing to open yet: a run creating its own batch has no id on
    // the row until the transaction that completes it.
    on("GET", /\/ingest-jobs\//, { status: 200, body: job({ state: "running", batch_id: null }) });
    await launch(<IngestScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);

    await screen.findByTestId("run-progress");
    expect(screen.queryByTestId("run-outcome")).toBeNull();
    expect(screen.queryByTestId("open-batch")).toBeNull();
  });

  it("degrades to no button when the run reached no batch", async () => {
    on("GET", /\/ingest-jobs\//, {
      status: 200,
      body: job({ state: "failed", batch_id: null, error: "ffmpeg is not installed" }),
    });
    await launch(<IngestScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);

    const outcome = await screen.findByTestId("run-outcome");
    expect(outcome.textContent).toContain("never reached a batch");
    expect(screen.queryByTestId("open-batch")).toBeNull();
    // The remedy for this one is the resume that is already there.
    expect(screen.getByTestId("resume-ingest")).not.toBeNull();
  });

  it("degrades to no button when the host passed nowhere to go", async () => {
    on("GET", /\/ingest-jobs\//, { status: 200, body: job() });
    await launch(<IngestScreen projectId={PROJECT} />);

    // `ui-core` may not import a router, so navigation is the shell's to supply
    // — and a host with no route for a batch still gets the outcome.
    expect((await screen.findByTestId("run-outcome")).textContent).toContain("drive.mp4");
    expect(screen.queryByTestId("open-batch")).toBeNull();
  });

  it("still says where the assets that landed went when the run reported failures", async () => {
    on("GET", /\/ingest-jobs\//, {
      status: 200,
      body: job({
        processed: 3,
        total: 5,
        failures: [
          { name: "notes.txt", kind: "unsupported", reason: "not an image" },
          { name: "truncated.jpg", kind: "corrupt", reason: "unexpected end of file" },
        ],
      }),
    });
    await launch(<IngestScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);

    const outcome = await screen.findByTestId("run-outcome");
    expect(outcome.textContent).toContain("What this run managed to read");
    expect(outcome.textContent).toContain("drive.mp4");
    expect(screen.getByTestId("open-batch")).not.toBeNull();
    // Both at once, which is the argument against redirecting on completion: the
    // report is exactly what a partial run needs read.
    expect(screen.getByTestId("failures")).not.toBeNull();
  });

  it("walks back to step 2 with the same source, for a run into another batch", async () => {
    on("GET", /\/ingest-jobs\//, { status: 200, body: job() });
    await launch(<IngestScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);
    await screen.findByTestId("run-outcome");

    await userEvent.click(screen.getByTestId("rerun-source"));

    // Step 2 again, with the *registered* source — nothing was re-uploaded and
    // step 1 stays collapsed, because the point is reusing the decision.
    expect(screen.getByTestId("step-2").dataset.state).toBe("active");
    expect(screen.getByTestId("step-1").dataset.state).toBe("complete");
    expect(screen.getByTestId("step-3").dataset.state).toBe("upcoming");
    expect(screen.queryByTestId("run-card")).toBeNull();
    expect(screen.getByTestId("source-card").textContent).toContain("photos");
    expect(
      sent.filter((r) => r.method === "POST" && r.url.endsWith("/sources/images")),
    ).toHaveLength(1);

    // And the second launch is real.
    await userEvent.click(screen.getByTestId("start-ingest"));
    await waitFor(() =>
      expect(
        sent.filter((r) => r.method === "POST" && r.url.endsWith("/ingest-jobs")),
      ).toHaveLength(2),
    );
  });

  it("goes back to a clean form, so a second source is ingestable without a reload", async () => {
    on("GET", /\/ingest-jobs\//, { status: 200, body: job() });
    await launch(<IngestScreen projectId={PROJECT} onOpenBatch={vi.fn()} />);
    await screen.findByTestId("run-outcome");

    await userEvent.click(screen.getByTestId("ingest-another"));
    expect(screen.queryByTestId("run-card")).toBeNull();
    expect(screen.queryByTestId("source-card")).toBeNull();
    expect(screen.queryByTestId("chosen")).toBeNull();

    // And the whole flow runs again on the same page, which is the claim: the
    // launch used to stay `disabled` for the rest of the page's life.
    await choose([pick("b.png", "image/png")]);
    await userEvent.click(screen.getByTestId("register-source"));
    await screen.findByTestId("source-card");
    expect((screen.getByTestId("start-ingest") as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByTestId("start-ingest"));

    await waitFor(() =>
      expect(
        sent.filter((r) => r.method === "POST" && r.url.endsWith("/ingest-jobs")),
      ).toHaveLength(2),
    );
  });
});

describe("the labels foreshadowing banner (#290)", () => {
  /** The readiness sources beside the screen's own project and batches reads. */
  function withSchema(exists: boolean): void {
    // `SchemaForeshadow` reads `useProjectReadiness`, which reaches the dataset
    // and its releases for the journey's last step — so both have to be answered
    // or readiness stays `null` and the banner never renders, which looks
    // exactly like the banner being wrong.
    on("GET", /^\/projects\/[^/]+\/dataset$/, {
      status: 200,
      body: datasetOf(PROJECT, "22222222-2222-4222-8222-222222222222"),
    });
    on("GET", /\/releases$/, { status: 200, body: { items: [], total: 0 } });
    on(
      "GET",
      /^\/projects\/[^/]+\/schema$/,
      exists
        ? { status: 200, body: { project_id: PROJECT, version: 1, classes: [] } }
        : { status: 404, body: { code: "SCHEMA_NOT_FOUND", message: "none yet" } },
    );
    on("GET", /\/stats$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        asset_count: 0,
        annotated_asset_count: 0,
        annotation_count: 0,
        class_count: 0,
        annotated_pct: 0,
        classes: [],
        last_ingest_at: null,
      },
    });
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
  }

  it("warns while the project has no labels, and the link goes to the schema", async () => {
    withSchema(false);
    const opened = vi.fn();
    render(mount(<IngestScreen projectId={PROJECT} onOpenSchema={opened} />));

    const banner = await screen.findByTestId("schema-foreshadow");
    // Foreshadowing, not a gate: ingest itself stays fully usable.
    expect(banner.textContent).toContain("You can ingest now");
    expect(screen.getByTestId("dropzone")).not.toBeNull();
    await userEvent.click(screen.getByTestId("foreshadow-schema"));
    expect(opened).toHaveBeenCalledOnce();
  });

  it("says nothing once a schema exists", async () => {
    withSchema(true);
    render(mount(<IngestScreen projectId={PROJECT} onOpenSchema={vi.fn()} />));

    await waitFor(() =>
      expect(sent.some((request) => request.url.endsWith("/schema"))).toBe(true),
    );
    await waitFor(() =>
      expect(sent.some((request) => request.url.endsWith("/stats"))).toBe(true),
    );
    expect(screen.queryByTestId("schema-foreshadow")).toBeNull();
  });
});
