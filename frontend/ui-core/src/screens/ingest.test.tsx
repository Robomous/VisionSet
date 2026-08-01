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
import { IngestScreen } from "./IngestScreen";

const API = "http://visionset.test";
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
  });

  it("sends a clip with the extraction rate, chosen before anything is probed", async () => {
    on("POST", /\/sources\/video$/, { status: 201, body: VIDEO_SOURCE });

    render(mount(<IngestScreen projectId={PROJECT} />));
    await choose([pick("drive.mp4", "video/mp4")]);

    // The rate field appears only for a clip, and it is decided *now* — the probe
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
    expect(error.textContent).toContain("UNSUPPORTED_MEDIA");
  });
});

describe("launching a run", () => {
  it("offers only draft batches, because anything else is refused at the launch", async () => {
    on("GET", /\/batches$/, {
      status: 200,
      body: {
        items: [
          { id: "b1", project_id: PROJECT, name: "open", state: "draft", schema_version: null, asset_count: 4, progress: {} },
          { id: "b2", project_id: PROJECT, name: "frozen", state: "in_annotation", schema_version: 1, asset_count: 9, progress: {} },
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

    expect((await screen.findByTestId("start-error")).textContent).toContain("BATCH_NOT_EDITABLE");
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
    await waitFor(() => expect(screen.getByTestId("run-state").textContent).toBe("completed"));
    expect(screen.queryByTestId("resume-ingest")).toBeNull();
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
