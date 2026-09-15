/**
 * Browser video import, against a stubbed `fetch` and a fake media runtime.
 *
 * Three things can only be checked here.
 *
 * **No runtime, no control.** A host that offers no materializer must see no
 * video anything — not a disabled button, not a dropzone that says it takes
 * clips. The absence is the assertion.
 *
 * **The refusals are specific and offer no fallback.** Every member of
 * `VideoRefusal` has prose of its own naming a remedy that exists, and none of
 * them may promise a server-side decoder, because there is not one.
 *
 * **A cancel unwinds both halves.** Aborting the materializer alone would leave
 * staged frames on the server that nothing will ever claim, so the session is
 * deleted too — and the commit that would have turned them into assets never
 * happens.
 */

import { fireEvent, screen, waitFor, type RenderResult } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type JSX, type ReactNode } from "react";
import type {
  FrameSink,
  VideoInspection,
  VideoMaterializer,
  VideoRefusal,
  VideoSelection,
} from "@visionset/media";

import { IngestScreen } from "./IngestScreen";
import { VisionSetMediaProvider } from "../media/VisionSetMediaProvider";
import type { VisionSetMediaRuntime } from "../media/port";
import { renderWithData } from "../testing/dataHarness";
import { batchActions } from "../testing/wire.fixtures.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const IMPORT = "55555555-5555-4555-8555-555555555555";
const BATCH = "44444444-4444-4444-8444-444444444444";

/** `wait` parks the answer until a test lets it go — see `park`. */
type Answer = { status: number; body?: unknown; wait?: Promise<void> };
type Handler = (request: Request) => Answer | undefined;

let handlers: Handler[] = [];
const sent: Request[] = [];
const bodies = new Map<Request, string>();

beforeEach(() => {
  handlers = [];
  sent.length = 0;
  bodies.clear();
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    if (request.method !== "GET") bodies.set(request, await request.clone().text());
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) {
        if (answer.wait !== undefined) await answer.wait;
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

/**
 * Like `on`, but the answer parks until the returned release is called — the only
 * way to observe the screen *during* a request rather than after it.
 */
function park(method: string, pattern: RegExp, answer: Answer): () => void {
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  handlers.unshift((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname)
      ? { ...answer, wait: parked }
      : undefined,
  );
  return release;
}

const SESSION = {
  id: IMPORT,
  project_id: PROJECT,
  source_id: SOURCE,
  state: "open",
  expected_frame_count: 10,
  received_frame_count: 0,
  batch_id: null,
  started_at: "2026-09-14T00:00:00.000000Z",
  updated_at: "2026-09-14T00:00:00.000000Z",
};

const COMMITTED_BATCH = {
  id: BATCH,
  project_id: PROJECT,
  name: "drive.mp4",
  state: "draft",
  schema_version: null,
  asset_count: 10,
  progress: {
    unannotated: 10,
    pre_labeled: 0,
    annotated: 0,
    review_pending: 0,
    accepted: 0,
    skipped: 0,
    total: 10,
  },
  allowed_actions: batchActions("draft"),
  promoted_asset_count: 0,
  parent_batch_id: null,
  pre_label_run: null,
};

const READABLE: VideoInspection = {
  fileName: "drive.mp4",
  container: "mp4",
  codec: "avc1.640028",
  displayWidth: 1920,
  displayHeight: 1080,
  rotation: 0,
  durationSeconds: 10,
  sourceFps: 29.97,
  decodable: true,
};

function refused(refusal: VideoRefusal, over: Partial<VideoInspection> = {}): VideoInspection {
  return {
    fileName: "weird.mkv",
    container: "",
    codec: "",
    displayWidth: 0,
    displayHeight: 0,
    rotation: 0,
    durationSeconds: 0,
    sourceFps: null,
    decodable: false,
    refusal,
    ...over,
  };
}

interface Recording {
  readonly runtime: VisionSetMediaRuntime;
  readonly sinks: { projectId: string; importId: string }[];
  /** What the decoder was told to walk. The server counted from the same choice. */
  selection: VideoSelection | null;
  /** Resolves the in-flight `materialize`. Set once one is running. */
  release: (() => void) | null;
  aborted: boolean;
}

/**
 * A runtime whose `materialize` parks until the test lets it go.
 *
 * Built once per test and never inside a render: the flow's inspection effect
 * depends on the materializer's identity, so a runtime rebuilt each render would
 * re-inspect forever.
 */
function fakeRuntime(
  inspection: VideoInspection,
  options: { fail?: unknown } = {},
): Recording {
  const record: Recording = {
    runtime: null as unknown as VisionSetMediaRuntime,
    sinks: [],
    selection: null,
    release: null,
    aborted: false,
  };
  const materializer: VideoMaterializer = {
    name: "fake/1.0.0",
    inspect: () => Promise.resolve(inspection),
    materialize: async (_file, selection, _sink, opts) => {
      record.selection = selection;
      opts?.onProgress?.({ materialized: 0, expected: 10 });
      await new Promise<void>((resolve) => {
        record.release = resolve;
      });
      record.aborted = opts?.signal?.aborted === true;
      if (options.fail !== undefined) throw options.fail;
      opts?.onProgress?.({ materialized: 10, expected: 10 });
      return { materialized: 10, expected: 10, skipped: [] };
    },
  };
  const sink: FrameSink = { append: () => Promise.resolve() };
  return Object.assign(record, {
    runtime: {
      materializer,
      createFrameSink: (target: { projectId: string; importId: string }) => {
        record.sinks.push(target);
        return sink;
      },
    },
  });
}

function mount(runtime: VisionSetMediaRuntime | undefined, ui?: ReactNode): RenderResult {
  return renderWithData(
    <VisionSetMediaProvider {...(runtime === undefined ? {} : { runtime })}>
      {ui ?? <IngestScreen projectId={PROJECT} onOpenBatch={vi.fn()} />}
    </VisionSetMediaProvider>,
  );
}

function clip(name = "drive.mp4"): File {
  return new File(["bytes"], name, { type: "video/mp4" });
}

async function choose(file: File): Promise<void> {
  await userEvent.upload(screen.getByTestId("file-input"), file);
}

describe("a host with no media runtime", () => {
  beforeEach(() => {
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
  });

  it("offers no video control at all, and never says a clip could be uploaded", async () => {
    mount(undefined);
    expect(screen.getByTestId("dropzone").textContent).toContain("Drop images here");
    expect(screen.getByTestId("dropzone").textContent).not.toContain("video");

    // A clip dropped anyway stays in the image flow: there is no decoder here,
    // and there is no server-side one to fall back to either.
    await choose(clip());
    expect(screen.queryByTestId("clip-report")).toBeNull();
    expect(screen.getByTestId("register-source")).not.toBeNull();
  });
});

describe("reading the clip", () => {
  beforeEach(() => {
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
  });

  it("reports the container and codec the decoder found, not the extension", async () => {
    // `.mkv` says nothing about what is inside, so the panel states what was
    // actually read — and that this browser can decode it.
    const found = { ...READABLE, container: "matroska", codec: "vp09.00.10.08" };
    mount(fakeRuntime(found).runtime);
    await choose(new File(["bytes"], "clip.mkv", { type: "video/x-matroska" }));

    const report = await screen.findByTestId("clip-report");
    expect(report.textContent).toContain("matroska");
    expect(report.textContent).toContain("vp09.00.10.08");
    expect(screen.getByTestId("clip-decodable").textContent).toContain("can decode it");
  });

  it("names a variable-rate clip as variable rather than inventing a number", async () => {
    mount(fakeRuntime({ ...READABLE, sourceFps: null }).runtime);
    await choose(clip());
    expect((await screen.findByTestId("clip-report")).textContent).toContain("variable");
  });

  const cases: readonly [VideoRefusal, string][] = [
    ["no-video-track", "no video track"],
    ["unparsable-container", "could not be parsed"],
    ["undecodable-codec", "cannot decode"],
    ["unsupported-browser", "no video decoder"],
  ];

  for (const [refusal, phrase] of cases) {
    it(`refuses ${refusal} in its own words, with no server to fall back on`, async () => {
      mount(fakeRuntime(refused(refusal, { codec: "av01.0.05M.08" })).runtime);
      await choose(clip());

      const notice = await screen.findByTestId("clip-refusal");
      expect(notice.dataset.refusal).toBe(refusal);
      expect(notice.textContent?.toLowerCase()).toContain(phrase);
      // Never a fallback: the server holds no decoder, so promising one would
      // send somebody to look for a path that was deleted.
      expect(notice.textContent).not.toContain("server");
      expect(notice.textContent).not.toContain("ingested whole");
      // And nothing may be started from a refusal.
      expect((screen.getByTestId("start-video-import") as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByTestId("extraction-fps")).toBeNull();
    });
  }

  it("names the codec it cannot decode, because that is what makes the remedy real", async () => {
    mount(fakeRuntime(refused("undecodable-codec", { container: "mp4", codec: "av01.0.05M.08" })).runtime);
    await choose(clip());
    expect((await screen.findByTestId("clip-refusal")).textContent).toContain("av01.0.05M.08");
  });
});

describe("choosing where the frames land", () => {
  const draft = {
    id: BATCH,
    project_id: PROJECT,
    name: "night drive",
    state: "draft",
    schema_version: null,
    asset_count: 4,
    progress: COMMITTED_BATCH.progress,
    allowed_actions: batchActions("draft"),
    promoted_asset_count: 0,
    parent_batch_id: null,
    pre_label_run: null,
  };

  beforeEach(() => {
    on("GET", /\/batches$/, {
      status: 200,
      body: {
        items: [
          draft,
          {
            ...draft,
            id: "b2",
            name: "frozen",
            state: "in_annotation",
            allowed_actions: batchActions("in_annotation"),
          },
          // A batch the wire says can be asked for nothing. Its *state* still
          // reads "draft", which is exactly what a client re-deriving legality
          // would offer.
          { ...draft, id: "b3", name: "sealed", allowed_actions: [] },
        ],
        total: 3,
      },
    });
    on("POST", /\/video-imports$/, { status: 201, body: SESSION });
    on("DELETE", /\/video-imports\//, { status: 204 });
  });

  async function ready(): Promise<Recording> {
    const fake = fakeRuntime(READABLE);
    mount(fake.runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");
    return fake;
  }

  it("offers only draft batches, because anything else is refused at the start", async () => {
    await ready();
    await userEvent.click(screen.getByTestId("target-batch"));

    expect(screen.queryByRole("option", { name: /night drive/ })).not.toBeNull();
    // A batch past `draft` answers 409 `BATCH_NOT_EDITABLE` at `start`, before
    // any decoding, so offering it would be offering a refusal.
    expect(screen.queryByRole("option", { name: /frozen/ })).toBeNull();
  });

  it("reads the offer off `edit_membership`, never off the batch's state", async () => {
    await ready();
    await userEvent.click(screen.getByTestId("target-batch"));

    // `state === "draft"` is the mirror `FrameGrid` was rewritten to remove: it
    // reproduces one dimension of the kernel's rule and drops whatever else the
    // kernel weighed, and the dropped part is invisible until somebody meets it.
    expect(screen.queryByRole("option", { name: /sealed/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /night drive/ })).not.toBeNull();
  });

  it("sends the chosen batch instead of a name, and hides the name field", async () => {
    const fake = await ready();
    await userEvent.click(screen.getByTestId("target-batch"));
    await userEvent.click(screen.getByRole("option", { name: /night drive/ }));
    expect(screen.queryByTestId("batch-name")).toBeNull();

    await userEvent.click(screen.getByTestId("start-video-import"));
    await waitFor(() => expect(fake.release).not.toBeNull());

    const request = sent.find((one) => one.url.endsWith("/video-imports") && one.method === "POST");
    const body = JSON.parse(bodies.get(request as Request) as string) as Record<string, unknown>;
    expect(body.batch_id).toBe(BATCH);
    expect(body.batch_name).toBeUndefined();
  });
});

describe("importing a clip", () => {
  beforeEach(() => {
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /\/video-imports$/, { status: 201, body: SESSION });
    on("POST", /\/video-imports\/.*\/commit$/, { status: 200, body: COMMITTED_BATCH });
    on("DELETE", /\/video-imports\//, { status: 204 });
  });

  function startBody(): Record<string, unknown> {
    const request = sent.find((one) => one.url.endsWith("/video-imports") && one.method === "POST");
    return JSON.parse(bodies.get(request as Request) as string) as Record<string, unknown>;
  }

  it("opens a session carrying metadata and the cut, and no video bytes", async () => {
    const fake = fakeRuntime(READABLE);
    mount(fake.runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");
    await userEvent.click(screen.getByTestId("start-video-import"));

    await waitFor(() => expect(fake.release).not.toBeNull());
    // JSON, not multipart: there is nothing binary to carry.
    expect(startBody()).toEqual({
      display_name: "drive.mp4",
      metadata: {
        width: 1920,
        height: 1080,
        fps: 29.97,
        duration_seconds: 10,
        codec: "avc1.640028",
      },
      extraction_fps: 1,
      // Whole clip canonicalizes to the empty selection — one spelling, the one
      // a caller who selected nothing already has.
      ranges: [],
      scale_percent: 100,
      // From the materializer itself, never a literal typed on the screen.
      materializer: "fake/1.0.0",
    });
    // The sink is built for the session that was just opened, and by the host.
    expect(fake.sinks).toEqual([{ projectId: PROJECT, importId: IMPORT }]);
  });

  it("sends no source rate at all for a variable-rate clip", async () => {
    // The extraction rate is a different thing, and standing it in here would
    // write a fact about the file that the file does not have.
    const fake = fakeRuntime({ ...READABLE, sourceFps: null });
    mount(fake.runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");
    await userEvent.click(screen.getByTestId("start-video-import"));

    await waitFor(() => expect(fake.release).not.toBeNull());
    expect((startBody().metadata as Record<string, unknown>).fps).toBeNull();
  });

  it("commits when the materialization finishes, and names the batch it made", async () => {
    const fake = fakeRuntime(READABLE);
    mount(fake.runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");
    await userEvent.click(screen.getByTestId("start-video-import"));

    await waitFor(() => expect(fake.release).not.toBeNull());
    expect((await screen.findByTestId("import-progress")).textContent).toContain("of 10");
    fake.release?.();

    const outcome = await screen.findByTestId("import-outcome");
    expect(outcome.textContent).toContain("drive.mp4");
    expect(sent.some((one) => one.url.endsWith("/commit"))).toBe(true);
  });

  it("aborts the materializer and the session together on a cancel", async () => {
    const fake = fakeRuntime(READABLE);
    mount(fake.runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");
    await userEvent.click(screen.getByTestId("start-video-import"));
    await waitFor(() => expect(fake.release).not.toBeNull());

    await userEvent.click(screen.getByTestId("cancel-video-import"));
    fake.release?.();

    await screen.findByTestId("import-cancelled");
    // Both halves: the decoder saw the abort, and the staged frames are gone.
    expect(fake.aborted).toBe(true);
    await waitFor(() =>
      expect(sent.some((one) => one.method === "DELETE" && one.url.includes("/video-imports/"))).toBe(
        true,
      ),
    );
    // And nothing was turned into assets.
    expect(sent.some((one) => one.url.endsWith("/commit"))).toBe(false);
  });

  it("discards the session when the materialization fails, and says what went wrong", async () => {
    const fake = fakeRuntime(READABLE, { fail: new Error("the sink refused a chunk") });
    mount(fake.runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");
    await userEvent.click(screen.getByTestId("start-video-import"));
    await waitFor(() => expect(fake.release).not.toBeNull());
    fake.release?.();

    // A decoder's own sentence, not the vocabulary's "check the connection":
    // the thing that failed was not the server.
    const stopped = await screen.findByTestId("import-error");
    expect(stopped.textContent).toContain("the sink refused a chunk");
    expect(stopped.textContent).not.toContain("connection");
    await waitFor(() =>
      expect(sent.some((one) => one.method === "DELETE" && one.url.includes("/video-imports/"))).toBe(
        true,
      ),
    );
    expect(sent.some((one) => one.url.endsWith("/commit"))).toBe(false);
  });

  it("surfaces a refused commit rather than claiming a batch", async () => {
    handlers.length = 0;
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
    on("POST", /\/video-imports$/, { status: 201, body: SESSION });
    on("POST", /\/video-imports\/.*\/commit$/, {
      status: 409,
      body: {
        code: "VIDEO_IMPORT_INCOMPLETE",
        message: "Three of the frames this import expects never arrived.",
      },
    });
    on("DELETE", /\/video-imports\//, { status: 204 });

    const fake = fakeRuntime(READABLE);
    mount(fake.runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");
    await userEvent.click(screen.getByTestId("start-video-import"));
    await waitFor(() => expect(fake.release).not.toBeNull());
    fake.release?.();

    expect((await screen.findByTestId("commit-error")).textContent).toContain("never arrived");
    expect(screen.queryByTestId("import-outcome")).toBeNull();
  });

  /** The whole clip is ten seconds wide over two hundred pixels: one second, ten pixels. */
  function measureTrack(): HTMLElement {
    const track = screen.getByTestId("range-track");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 40,
      width: 200,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    return track;
  }

  it("carries the chosen rate and scale into the session, not the defaults", async () => {
    const fake = fakeRuntime(READABLE);
    mount(fake.runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");

    await userEvent.clear(screen.getByTestId("extraction-fps"));
    await userEvent.type(screen.getByTestId("extraction-fps"), "2");
    fireEvent.change(screen.getByTestId("scale-percent"), { target: { value: "50" } });
    // The readout states what will be stored before anything is decoded.
    expect(screen.getByTestId("stored-size").textContent).toContain("960×540");

    await userEvent.click(screen.getByTestId("start-video-import"));
    await waitFor(() => expect(fake.release).not.toBeNull());

    expect(startBody().extraction_fps).toBe(2);
    expect(startBody().scale_percent).toBe(50);
    // And the decoder walks the same choice: the server counts the frames it
    // expects from this body, so a materializer told something else would leave
    // the commit refusing an import that can never complete.
    expect(fake.selection).toEqual({ extractionFps: 2, ranges: [], scalePercent: 50 });
  });

  it("carries the timeline selection, canonicalized the way the server counts it", async () => {
    const fake = fakeRuntime(READABLE);
    mount(fake.runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");

    const track = measureTrack();
    fireEvent.pointerDown(track, { clientX: 20 });
    fireEvent.pointerMove(track, { clientX: 100 });
    fireEvent.pointerUp(track, { clientX: 100 });

    // [1, 5) at one frame per second is four grid points.
    expect(screen.getByTestId("frames-estimate").textContent?.trim()).toContain("4");
    expect(screen.getByTestId("selection-readout").textContent).toContain("0:01–0:05");

    await userEvent.click(screen.getByTestId("start-video-import"));
    await waitFor(() => expect(fake.release).not.toBeNull());

    // Merged, not raw: the materializer walks these bounds directly, so an
    // overlapping pair would decode the overlap twice and disagree with the
    // count the server made from the same list.
    expect(startBody().ranges).toEqual([{ start_seconds: 1, end_seconds: 5 }]);
    expect(fake.selection?.ranges).toEqual([{ startSeconds: 1, endSeconds: 5 }]);
  });

  it("cannot start an import of a clip whose duration the container did not carry", async () => {
    // A container the decoder parses but cannot time. Every comparison with NaN
    // is false, so `expected === 0` waved this through — to a session posting
    // `duration_seconds: null`, since JSON has no NaN, for a raw 422.
    mount(fakeRuntime({ ...READABLE, durationSeconds: Number.NaN }).runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");

    expect((screen.getByTestId("start-video-import") as HTMLButtonElement).disabled).toBe(true);
    // And nothing on the screen says `NaN` at somebody.
    expect(screen.getByTestId("selection-readout").textContent).not.toContain("NaN");
    expect(screen.getByTestId("frames-estimate").textContent).not.toContain("NaN");
    expect(screen.getByTestId("step-1").textContent).not.toContain("NaN");
  });

  it("aborts the run the screen was navigated away from, session and all", async () => {
    const fake = fakeRuntime(READABLE);
    const view = mount(fake.runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");
    await userEvent.click(screen.getByTestId("start-video-import"));
    await waitFor(() => expect(fake.release).not.toBeNull());

    // Any route change out of the ingest screen. Nothing else stops the run:
    // the sink would go on POSTing chunks into a screen nobody can see, and the
    // commit would then put a batch in the project that no progress, no cancel
    // and no outcome ever described.
    view.unmount();
    fake.release?.();

    await waitFor(() => expect(fake.aborted).toBe(true));
    await waitFor(() =>
      expect(
        sent.some((one) => one.method === "DELETE" && one.url.includes("/video-imports/")),
      ).toBe(true),
    );
    expect(sent.some((one) => one.url.endsWith("/commit"))).toBe(false);
  });

  it("stops offering a cancel once the commit is in flight, and says why", async () => {
    const releaseCommit = park("POST", /\/video-imports\/.*\/commit$/, {
      status: 200,
      body: COMMITTED_BATCH,
    });
    const fake = fakeRuntime(READABLE);
    mount(fake.runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");
    await userEvent.click(screen.getByTestId("start-video-import"));
    await waitFor(() => expect(fake.release).not.toBeNull());
    fake.release?.();

    // Decoding is done and the one transaction that makes the assets is running.
    // A live Cancel here aborts a controller nobody is listening to: the commit
    // lands anyway and the person who asked to throw the work away is handed the
    // batch. Disabled with the reason beside it instead.
    const button = await waitFor(() => {
      const found = screen.getByTestId("cancel-video-import") as HTMLButtonElement;
      expect(found.disabled).toBe(true);
      return found;
    });
    expect(screen.getByTestId("import-card").textContent).toContain("Too late to cancel");
    fireEvent.click(button);

    releaseCommit();
    await screen.findByTestId("import-outcome");
    // The click changed nothing, in either direction: no session was discarded
    // behind the batch that was just made.
    expect(screen.queryByTestId("import-cancelled")).toBeNull();
    expect(sent.some((one) => one.method === "DELETE")).toBe(false);
  });

  it("cannot start an import at a rate the request could not carry", async () => {
    mount(fakeRuntime(READABLE).runtime);
    await choose(clip());
    await screen.findByTestId("clip-report");

    const button = (): HTMLButtonElement =>
      screen.getByTestId("start-video-import") as HTMLButtonElement;
    expect(button().disabled).toBe(false);

    // `<input type="number">` reports a rejected keystroke as an empty string, so
    // a blank is reachable by typing, not only by pasting — and `NaN > 0` is false.
    await userEvent.clear(screen.getByTestId("extraction-fps"));
    expect(button().disabled).toBe(true);

    await userEvent.type(screen.getByTestId("extraction-fps"), "2");
    expect(button().disabled).toBe(false);
    expect(screen.getByTestId("frames-estimate").textContent).toContain("20");
  });
});

describe("a host that does not memoize its runtime", () => {
  beforeEach(() => {
    on("GET", /\/batches$/, { status: 200, body: { items: [], total: 0 } });
  });

  it("reads the clip once, however many times the host rebuilds its runtime", async () => {
    let inspected = 0;

    // The obvious inline spelling, and the one `@visionset/media`'s port is
    // published for: a fresh runtime object, holding a fresh materializer, on
    // every render this host does. The OSS app memoizes, so only a second host
    // meets this — which is precisely the case the package exists to serve.
    function Host(): JSX.Element {
      const [tick, setTick] = useState(0);
      const runtime: VisionSetMediaRuntime = {
        materializer: {
          name: "fake/1.0.0",
          inspect: () => {
            inspected += 1;
            return Promise.resolve(READABLE);
          },
          materialize: () => Promise.resolve({ materialized: 0, expected: 0, skipped: [] }),
        },
        createFrameSink: () => ({ append: () => Promise.resolve() }),
      };
      return (
        <VisionSetMediaProvider runtime={runtime}>
          <button type="button" data-testid="host-render" onClick={() => setTick(tick + 1)}>
            {tick}
          </button>
          <IngestScreen projectId={PROJECT} />
        </VisionSetMediaProvider>
      );
    }

    renderWithData(<Host />);
    await choose(clip());
    await screen.findByTestId("clip-report");
    expect(inspected).toBe(1);

    fireEvent.change(screen.getByTestId("scale-percent"), { target: { value: "50" } });
    await userEvent.click(screen.getByTestId("host-render"));
    await userEvent.click(screen.getByTestId("host-render"));

    // No second worker, and — the part a person would actually feel — the cut
    // they chose is still theirs. Re-running the inspection resets it.
    expect(inspected).toBe(1);
    expect(screen.getByTestId("stored-size").textContent).toContain("960×540");
  });
});
