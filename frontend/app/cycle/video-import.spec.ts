/**
 * A clip becomes a batch of frames, in a browser, against a real server — and the
 * clip itself never leaves the browser.
 *
 * `visionset server` serves the built bundle and the real API over the real kernel
 * and a real SQLite file, exactly as `cycle.spec.ts` does; **no media binary exists
 * anywhere in this run**, on either side — see `tests/scripts/no_server_video_decode.test.mjs`
 * for the gate that keeps it that way. The clips are `frontend/media/test-fixtures/`,
 * encoded once by mediabunny's own `Output` inside this repository's Chromium, and
 * they are decoded here by the same WebCodecs implementation. That is the whole
 * point of the feature and therefore of this file: the decoder is the browser's,
 * the server holds none, and there is no server-side fallback to fall back to.
 *
 * ## Why this is a second file rather than a step in `cycle.spec.ts`
 *
 * That walk is a *sequence* — project, schema, ingest, annotate, promote, export —
 * and every step consumes the last one's output, which is why it is one test. What
 * is asserted here is orthogonal to all of it: four independent claims about one
 * screen, each of which wants its own empty project and its own clean request log.
 * Threading them through a five-minute walk would make each failure arrive with
 * twenty steps of unrelated context in front of it. `cycle.spec.ts` says in its own
 * header that the browser-to-batch walk has a spec of its own; this is it.
 *
 * `cycle/` and not `e2e/`, because there is nothing to assert here without a real
 * kernel: the batch, the asset count after content-addressed de-duplication, the
 * source's recorded extraction policy and the staged-session lifetime are all
 * kernel answers. `e2e/` stubs the API and runs against `vite` with no server
 * behind it, so every one of those would be a fixture agreeing with itself.
 * `playwright.cycle.config.ts` has `testDir: "./cycle"`, so this file needs no
 * change to it — including its port, which `e2e-ports.ts` derives per worktree.
 *
 * ## The network is the subject, not the scenery
 *
 * The claim "the video is never uploaded" cannot be proved by looking at URLs: a
 * whole-file upload posted to `/video-imports/{id}/frames` would pass any check
 * that trusts a route name. So every body that leaves the page is captured and
 * **accounted for**:
 *
 *  - no field's bytes hash to the clip's digest, and no text body carries the clip
 *    base64- or hex-encoded;
 *  - nothing, at request level or field level, declares a `video/*` content type;
 *  - every body is either JSON that parses, or a form whose fields are exactly
 *    `files` fields whose own bytes open and close as JPEG plus one `descriptors`
 *    field that parses to the frame descriptors those bytes describe.
 *
 * Nothing else is permitted to travel, so a reintroduced upload fails all three
 * whatever route it is addressed to and whatever field it is hidden in.
 *
 * ### Why the bodies are recorded in the page rather than off `page.on("request")`
 *
 * Because Chromium does not hand a multipart upload's body to the inspector:
 * `request.postDataBuffer()` answers `null` for exactly the requests this file
 * exists to look inside, which makes every assertion over it quietly vacuous — an
 * earlier draft of this file passed that way, against nothing. So `fetch` is
 * wrapped in an init script that records what it was *given* and then calls the
 * real one. That is an observer, not a mock: no response is synthesized and
 * nothing is short-circuited, and `page.on("request")` still runs beside it as the
 * independent count that proves nothing slipped past the wrapper.
 *
 * A size threshold deliberately is not one of the checks, and the reason is worth
 * recording: these fixtures are 842 bytes, which is *smaller* than one bounded chunk
 * of the frames they are cut into. Byte length cannot separate the two here, so
 * the digest does it instead — and it is the stronger claim anyway, because it
 * holds at any fixture size.
 */

import { expect, test, type APIRequestContext, type Page, type Request } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { FRAME_CHUNK_SIZE, expectedFrames } from "@visionset/media";

import { emptyWorkspace } from "./_workspace";

const CYCLE_DIR = process.env["VISIONSET_CYCLE_DIR"] ?? "";

/** Written by `scripts/cycle_server.sh`, which minted it once. */
function token(): string {
  return readFileSync(path.join(CYCLE_DIR, "token"), "utf8").trim();
}

/** Committed, generated in-browser, and read from the repository rather than copied. */
const FIXTURES = path.resolve(import.meta.dirname, "..", "..", "media", "test-fixtures");

const MANIFEST = JSON.parse(readFileSync(path.join(FIXTURES, "manifest.json"), "utf8")) as {
  width: number;
  height: number;
  fps: number;
  frames: number;
};

const CLIP = path.join(FIXTURES, "vp8.webm");
const GARBAGE = path.join(FIXTURES, "garbage.webm");

/** The clip's own bytes, and the three shapes they could have travelled in. */
const CLIP_BYTES = readFileSync(CLIP);
const CLIP_DIGEST = createHash("sha256").update(CLIP_BYTES).digest("hex");
const CLIP_BASE64 = CLIP_BYTES.toString("base64");
const CLIP_HEX = CLIP_BYTES.toString("hex");

/**
 * The clip's real duration, from the generator that wrote it: eight frames at
 * eight frames per second. `@visionset/media`'s own Chromium suite pins the
 * decoder to this to three decimals, and the walk below re-checks it against what
 * *this* decoder reported before using it for anything.
 */
const DURATION = MANIFEST.frames / MANIFEST.fps;

/**
 * What a JPEG's own bytes look like at each end: `FF D8` opening it, the next
 * marker immediately after, and `FF D9` closing it. Read off the payload rather
 * than off its declared type, because a part's content type is whatever the page
 * put in the form and proves nothing about what it is carrying.
 */
const JPEG_HEAD = /^ffd8ff/;
const JPEG_TAIL = "ffd9";

/**
 * Cut at the clip's own rate, so every grid point lands on a distinct source frame.
 *
 * It is the one rate at which the asset count is the frame count: ingest is
 * content-addressed, so a rate above the source's would resolve several grid points
 * to the same sample, emit byte-identical frames and collapse them into one asset —
 * which the screen says on the outcome and which is true, but is not a number this
 * walk could derive from the grid alone.
 */
const WALK_RATE = MANIFEST.fps;

/** What extraction will emit, from the clip's real duration and the chosen rate. */
const WALK_FRAMES = expectedFrames([], DURATION, WALK_RATE);

/** Above the server's 32-part ceiling, so the chunk bound has to do some work. */
const CHUNKED_RATE = 40;

const CHUNKED_FRAMES = expectedFrames([], DURATION, CHUNKED_RATE);

/** Long enough that a cancel lands in the middle of it rather than after it. */
const CANCEL_RATE = 400;

test.beforeEach(async ({ request }) => {
  await emptyWorkspace(request, token());
});

// --- what left the page ------------------------------------------------------

/** One field of a form body: a text field, or a blob recorded by shape and digest. */
interface Field {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  /** First eight bytes, hex — enough to say what a payload *is*. */
  readonly head: string;
  /** Last two bytes, hex: an encoding's own end marker, which a prefix cannot fake. */
  readonly tail: string;
  readonly digest: string;
  readonly text: string | null;
}

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly contentType: string;
  /** A non-form body, verbatim. */
  readonly text: string | null;
  readonly fields: Field[];
  /** An abort tore the clone down before it could be read. */
  readonly unreadable: boolean;
}

interface Log {
  /** What the page asked `fetch` to send, bodies included. */
  sent(): Promise<Sent[]>;
  /** What Chromium saw go out — the independent count, and the URLs. */
  readonly seen: { method: string; path: string }[];
}

/**
 * Record every body this page sends, and watch the wire beside it.
 *
 * Installed before the first navigation: the init script has to be in place before
 * the bundle takes its own reference to `fetch`.
 */
async function watch(page: Page): Promise<Log> {
  const seen: { method: string; path: string }[] = [];
  page.on("request", (request: Request) => {
    seen.push({ method: request.method(), path: new URL(request.url()).pathname });
  });

  await page.addInitScript(() => {
    const sent: unknown[] = [];
    Object.assign(window, { __sent: sent });
    const native = window.fetch.bind(window);
    const hex = (buffer: ArrayBuffer): string =>
      [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      // A clone, always: `openapi-fetch` hands `fetch` a single `Request`, and the
      // body is a one-shot stream. Reading the copy leaves the original — signal
      // and all — to go out exactly as the product built it.
      const probe = input instanceof Request ? input.clone() : new Request(input, init);
      const fields: unknown[] = [];
      let text: string | null = null;
      let unreadable = false;
      try {
        if (probe.method !== "GET" && probe.method !== "HEAD") {
          if (/multipart\/form-data/i.test(probe.headers.get("content-type") ?? "")) {
            for (const [name, value] of (await probe.formData()).entries()) {
              if (typeof value === "string") {
                fields.push({
                  name,
                  type: "",
                  size: value.length,
                  head: "",
                  tail: "",
                  digest: "",
                  text: value,
                });
              } else {
                const bytes = await value.arrayBuffer();
                fields.push({
                  name,
                  type: value.type,
                  size: bytes.byteLength,
                  head: hex(bytes.slice(0, 8)),
                  tail: hex(bytes.slice(Math.max(0, bytes.byteLength - 2))),
                  digest: hex(await crypto.subtle.digest("SHA-256", bytes)),
                  text: null,
                });
              }
            }
          } else {
            const body = await probe.text();
            text = body === "" ? null : body;
          }
        }
      } catch {
        // An abort can tear the clone down mid-read. Recorded as such rather than
        // silently counted as a body with nothing in it.
        unreadable = true;
      }
      sent.push({
        method: probe.method,
        path: new URL(probe.url, location.href).pathname,
        contentType: probe.headers.get("content-type") ?? "",
        text,
        fields,
        unreadable,
      });
      return native(input, init);
    };
  });

  return {
    seen,
    sent: () => page.evaluate(() => (window as unknown as { __sent: Sent[] }).__sent),
  };
}

const isFrames = (pathname: string): boolean => /^\/video-imports\/[^/]+\/frames$/.test(pathname);

/**
 * The whole point of the file: nothing that travelled was, or contained, the clip.
 *
 * Four independent claims, because each one fails differently. The digest catches
 * the bytes under any field name; the content type catches a `File` appended to a
 * form; the accounting catches a body this suite has no vocabulary for at all,
 * which is what a new upload path looks like from here; and the count catches an
 * upload that never went through `fetch`.
 */
async function expectNoClipUpload(log: Log): Promise<void> {
  const sent = await log.sent();

  // Nothing slipped past the recorder: the mutations Chromium saw are exactly the
  // ones the wrapper saw, in order. Without this, everything below is vacuous.
  const label = (one: { method: string; path: string }): string => `${one.method} ${one.path}`;
  expect(sent.filter((one) => one.method !== "GET").map(label).sort()).toEqual(
    log.seen
      .filter((one) => one.method !== "GET" && one.method !== "OPTIONS")
      .map(label)
      .sort(),
  );

  for (const one of sent) {
    const where = `${one.method} ${one.path}`;
    // The one gap in the accounting, stated rather than hidden: a request the
    // cancel aborted mid-read. Its siblings are checked, and it carried the same
    // chunk of the same loop.
    if (one.unreadable) continue;
    expect(/video\//i.test(one.contentType), `${where} declared ${one.contentType}`).toBe(false);

    if (one.text !== null) {
      const body = one.text;
      expect(() => JSON.parse(body), `${where} sent a body that is not JSON`).not.toThrow();
      expect(body.includes(CLIP_BASE64), `${where} carried the clip base64`).toBe(false);
      expect(body.includes(CLIP_HEX), `${where} carried the clip hex-encoded`).toBe(false);
    }

    for (const field of one.fields) {
      expect(/video\//i.test(field.type), `${where} field "${field.name}" is ${field.type}`).toBe(
        false,
      );
      expect(field.digest, `${where} field "${field.name}" is the clip itself`).not.toBe(
        CLIP_DIGEST,
      );
      if (field.name === "files") {
        const why = `${where} uploaded a "files" field that is not a JPEG`;
        expect(field.type, why).toBe("image/jpeg");
        expect(field.head, why).toMatch(JPEG_HEAD);
        expect(field.tail, why).toBe(JPEG_TAIL);
      } else {
        expect(field.name, `${where} carried an unexpected field`).toBe("descriptors");
        expect(field.text, `${where} descriptors were binary`).not.toBeNull();
        expect(() => JSON.parse(field.text ?? "")).not.toThrow();
      }
    }
  }

  // The route the server-side decoder used to live behind. It is deleted, and a
  // screen that quietly fell back to it would say so here.
  expect(log.seen.filter((one) => one.path.includes("/sources/video"))).toEqual([]);
}

/** Every `/frames` request is a bounded chunk, and together they are the whole grid. */
async function expectBoundedChunks(log: Log, frames: number): Promise<void> {
  const requests = (await log.sent()).filter((one) => one.method === "POST" && isFrames(one.path));
  expect(requests.length, "no frames were posted").toBe(
    log.seen.filter((one) => isFrames(one.path)).length,
  );
  expect(requests.length).toBeGreaterThan(0);

  const counts = requests.map((one) => one.fields.filter((field) => field.name === "files").length);
  // The server's own ceiling (`routes/video_imports.py`), restated as the claim a
  // single whole-extraction request would break.
  for (const count of counts) expect(count).toBeLessThanOrEqual(32);
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(frames);
  expect(counts).toEqual(
    Array.from({ length: Math.ceil(frames / FRAME_CHUNK_SIZE) }, (_, index) =>
      Math.min(FRAME_CHUNK_SIZE, frames - index * FRAME_CHUNK_SIZE),
    ),
  );
  // Descriptors are checked against the grid rather than against the count, so a
  // chunking that dropped or repeated a frame fails here even though it uploaded
  // the right number of parts.
  const ordinals = requests.flatMap((one) => {
    const field = one.fields.find((each) => each.name === "descriptors");
    return JSON.parse(field?.text ?? "[]") as { ordinal: number }[];
  });
  expect(ordinals.map((one) => one.ordinal)).toEqual(
    Array.from({ length: frames }, (_, index) => index),
  );
}

// --- helpers -----------------------------------------------------------------

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${token()}` };
}

/** A project made through the API, opened on Ingest through its real route. */
async function projectAtIngest(
  page: Page,
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const created = await request.post("/projects", { headers: bearer(), data: { name } });
  expect(created.ok(), `POST /projects answered ${created.status()}`).toBe(true);
  const { id } = (await created.json()) as { id: string };
  await page.goto(`./projects/${id}/ingest`);
  await expect(page.getByTestId("ingest-screen")).toBeVisible();
  return id;
}

/**
 * Record every value the progress line ever shows.
 *
 * Polling it cannot prove movement — an import of a one-second clip is over in
 * well under a poll interval, so a reading taken "partway" is a race with no
 * winner. An observer installed before the click sees every render instead, which
 * is what turns "it ended at 8 of 8" into "it counted up to 8 of 8".
 */
async function watchProgress(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { __progress: seen });
    const read = (): void => {
      const line = document.querySelector('[data-testid="import-progress"]')?.textContent ?? "";
      if (line !== "" && line !== seen[seen.length - 1]) seen.push(line);
    };
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

/** The materialized counts the progress line showed, in the order it showed them. */
async function progressCounts(page: Page): Promise<number[]> {
  const readings = await page.evaluate(
    () => (window as unknown as { __progress: string[] }).__progress,
  );
  return readings.map((line) => Number(/^(\d+) of/.exec(line)?.[1]));
}

/** What the progress line says right now, as a number. */
async function progressNow(page: Page): Promise<number> {
  const line = (await page.getByTestId("import-progress").textContent()) ?? "";
  return Number(/^(\d+) of/.exec(line)?.[1]);
}

// --- the walk ----------------------------------------------------------------

test("a clip is inspected, cut and imported here, and never uploaded", async ({ page, request }) => {
  const log = await watch(page);

  await page.goto("./");
  await expect(page.getByTestId("app-rail")).toBeVisible();

  await test.step("create a project and reach Ingest, by clicking", async () => {
    await expect(page.getByTestId("home-first-run")).toBeVisible();
    await page.getByTestId("home-create-project").click();
    await page.getByTestId("project-name").fill("browser-video-import");
    await page.getByTestId("create-submit").click();
    await expect(page.getByTestId("project-screen")).toBeVisible();
    // A project with no assets carries Ingest in the navigation's action slot,
    // which is the road a person actually takes here.
    await page.getByTestId("go-ingest").click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/ingest$/);
  });

  await test.step("the decoder reads the clip, and the report says what it found", async () => {
    await page.getByTestId("file-input").setInputFiles(CLIP);
    await expect(page.getByTestId("chosen")).toHaveText("vp8.webm");

    // Every fact below comes off the container through WebCodecs. None of it can
    // be inferred from `.webm`, which is the whole argument for reading it: a
    // `.webm` holding VP9 and a `.webm` holding AV1 differ on the only question
    // that matters, and `garbage.webm` holds no container at all.
    const report = page.getByTestId("clip-report");
    await expect(report).toContainText("WebM");
    await expect(report).toContainText("vp8");
    await expect(report).toContainText(`${MANIFEST.width}×${MANIFEST.height}`);
    await expect(report).toContainText(`${DURATION.toFixed(1)} s`);
    await expect(report).toContainText(`${MANIFEST.fps.toFixed(2)} fps`);
    // And the one fact that is a property of this browser rather than of the file.
    await expect(page.getByTestId("clip-decodable")).toHaveText("can decode it");
    await expect(page.getByTestId("clip-refusal")).toHaveCount(0);
  });

  await test.step("choose a rate and a stored size", async () => {
    await page.getByTestId("extraction-fps").fill(String(WALK_RATE));
    // Ten steps of five, on the real `input[type=range]`, because a value set
    // without the keyboard is not the control being used.
    for (let step = 0; step < 10; step++) await page.getByTestId("scale-percent").press("ArrowLeft");
    await expect(page.getByTestId("stored-size")).toHaveText(
      `${MANIFEST.width}×${MANIFEST.height} → 32×32 · 50%`,
    );

    await page.getByTestId("batch-name").fill("clip-batch");
    await expect(page.getByTestId("selection-readout")).toHaveText("Whole clip");
    // The screen's own estimate, against the grid arithmetic it shares with the
    // kernel — read here before anything has been decoded.
    await expect(page.getByTestId("frames-estimate")).toHaveText(String(WALK_FRAMES));
  });

  await test.step("import, and watch the count climb to the end", async () => {
    await watchProgress(page);
    await page.getByTestId("start-video-import").click();

    await expect(page.getByTestId("import-outcome")).toBeVisible();
    await expect(page.getByTestId("import-progress")).toHaveText(
      `${WALK_FRAMES} of ${WALK_FRAMES} frames`,
    );
    await expect(page.getByTestId("import-error")).toHaveCount(0);
    await expect(page.getByTestId("commit-error")).toHaveCount(0);

    // It rose, and never fell back. Asserted as a shape rather than as an exact list
    // of renders, because how many of them React coalesces is React's business.
    //
    // It deliberately does NOT assert an intermediate value here. The count means
    // frames the sink has *taken*, not frames decoded — that is the whole point of
    // reporting it, since a number that ran ahead of the uploads would tell someone
    // their import was further along than it was. Frames reach the sink a chunk at a
    // time, and this clip is `WALK_FRAMES` = 8 against a `FRAME_CHUNK_SIZE` of 8, so
    // one chunk carries all of it and `0 → 8` is the correct painting. The clip that
    // spans several chunks is where climbing through the middle is a real claim, and
    // that is where it is asserted.
    const counted = await progressCounts(page);
    expect(counted.at(-1)).toBe(WALK_FRAMES);
    expect(counted).toEqual([...counted].sort((a, b) => a - b));
    expect(new Set(counted).size).toBe(counted.length);
    expect(WALK_FRAMES).toBeLessThanOrEqual(FRAME_CHUNK_SIZE);
  });

  await test.step("the batch holds one asset per grid point", async () => {
    await expect(page.getByTestId("import-outcome")).toContainText("clip-batch");
    await page.getByTestId("open-batch").click();
    await expect(page.getByTestId("gallery")).toBeVisible();
    await expect(page.getByTestId("batch-title")).toHaveText("clip-batch");
    // `WALK_RATE` is the clip's own rate, so every grid point is a different
    // source frame and content-addressing collapses nothing.
    await expect(page.getByTestId(/^tile-/)).toHaveCount(WALK_FRAMES);
  });

  await test.step("a frame says where it came from and how it was cut", async () => {
    // On screen first: the source's name, the count, the rate it was cut at and
    // the size it is stored at — assembled from the assets, not from the batch.
    const facts = page.getByTestId("batch-facts");
    await expect(facts).toContainText("vp8.webm");
    await expect(facts).toContainText(`${WALK_FRAMES} frames · ${WALK_RATE} fps`);
    await expect(facts).toContainText("32×32");

    // And in the kernel, which is what survives a reload: the whole extraction
    // policy the source's identity is made of.
    const projectId = /\/projects\/([0-9a-f-]{36})\//.exec(new URL(page.url()).pathname)?.[1];
    const sources = await request.get(`/projects/${projectId}/sources`, { headers: bearer() });
    const listed = (await sources.json()) as { items: { id: string; name: string }[] };
    expect(listed.items.map((one) => one.name)).toEqual(["vp8.webm"]);

    const source = await request.get(`/sources/${listed.items[0].id}`, { headers: bearer() });
    const provenance = (await source.json()) as {
      kind: string;
      video: Record<string, unknown> | null;
    };
    expect(provenance.kind).toBe("video");
    expect(provenance.video).toMatchObject({
      codec: "vp8",
      width: MANIFEST.width,
      height: MANIFEST.height,
      extraction_fps: WALK_RATE,
      scale_percent: 50,
      // Empty is the canonical spelling of "the whole clip".
      ranges: [],
    });
    expect(provenance.video?.["duration_seconds"]).toBeCloseTo(DURATION, 3);
    expect(provenance.video?.["fps"]).toBeCloseTo(MANIFEST.fps, 1);
  });

  await test.step("nothing that travelled was the clip", async () => {
    // What the decoder measured, taken off the wire rather than off the screen,
    // and checked against the duration the fixture was written with. Everything
    // derived from `DURATION` above rests on this.
    const started = (await log.sent()).find(
      (one) => one.method === "POST" && /^\/projects\/[^/]+\/video-imports$/.test(one.path),
    );
    expect(started, "no video import was opened").toBeDefined();
    const opened = JSON.parse(started?.text ?? "{}") as {
      display_name: string;
      extraction_fps: number;
      metadata: { duration_seconds: number };
    };
    expect(opened.display_name).toBe("vp8.webm");
    expect(opened.extraction_fps).toBe(WALK_RATE);
    expect(opened.metadata.duration_seconds).toBeCloseTo(DURATION, 3);

    await expectNoClipUpload(log);
    await expectBoundedChunks(log, WALK_FRAMES);
  });
});

test("an extraction larger than the server's ceiling arrives in bounded chunks", async ({
  page,
  request,
}) => {
  const log = await watch(page);
  await projectAtIngest(page, request, "chunked-video-import");

  await page.getByTestId("file-input").setInputFiles(CLIP);
  await expect(page.getByTestId("clip-decodable")).toHaveText("can decode it");
  await page.getByTestId("extraction-fps").fill(String(CHUNKED_RATE));
  await expect(page.getByTestId("frames-estimate")).toHaveText(String(CHUNKED_FRAMES));

  await watchProgress(page);
  await page.getByTestId("start-video-import").click();
  await expect(page.getByTestId("import-outcome")).toBeVisible();
  await expect(page.getByTestId("import-progress")).toHaveText(
    `${CHUNKED_FRAMES} of ${CHUNKED_FRAMES} frames`,
  );

  // This extraction spans several chunks, so "the count climbed through the middle"
  // is a claim with content here in a way it is not for a clip that fits in one. A
  // screen that sat at `0 of 40` and then painted `40 of 40` fails this.
  const counted = await progressCounts(page);
  expect(counted.at(-1)).toBe(CHUNKED_FRAMES);
  expect(counted).toEqual([...counted].sort((a, b) => a - b));
  expect(counted.filter((seen) => seen > 0 && seen < CHUNKED_FRAMES).length).toBeGreaterThan(0);

  // More than 32 frames, so a single whole-extraction request is both writable and
  // refused by the server — the case the bound exists for, and the one a smaller
  // import could never tell apart from an unbounded one.
  expect(CHUNKED_FRAMES).toBeGreaterThan(32);
  await expectNoClipUpload(log);
  await expectBoundedChunks(log, CHUNKED_FRAMES);
});

test("cancelling mid-import leaves no batch, and no staged session either", async ({
  page,
  request,
}) => {
  const log = await watch(page);
  const imports: string[] = [];
  page.on("response", (response) => {
    if (/^\/projects\/[^/]+\/video-imports$/.test(new URL(response.url()).pathname)) {
      void response
        .json()
        .then((body: { id: string }) => imports.push(body.id))
        .catch(() => undefined);
    }
  });

  const projectId = await projectAtIngest(page, request, "cancelled-video-import");

  await page.getByTestId("file-input").setInputFiles(CLIP);
  await expect(page.getByTestId("clip-decodable")).toHaveText("can decode it");
  // A rate high enough that the import is still running when the click lands.
  await page.getByTestId("extraction-fps").fill(String(CANCEL_RATE));
  await page.getByTestId("start-video-import").click();

  // Wait for a chunk to have actually reached the server, so what is cancelled is
  // an import with frames staged against it rather than one that has not started —
  // the state the durable session exists to make safe.
  await page.waitForResponse((response) => isFrames(new URL(response.url()).pathname));
  const discarded = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" && /\/video-imports\//.test(response.url()),
  );
  await page.getByTestId("cancel-video-import").click();
  const partway = await progressNow(page);
  await discarded;

  // The import is over, nothing was committed, and the person who pressed Cancel is
  // told they cancelled. Where the abort lands must not change that: against a real
  // server it almost always lands *during* a frame upload, so the sink's `fetch`
  // rejects with `AbortError` before the worker's `done` ever arrives — and the
  // materializer resolves with the partial result anyway rather than reporting the
  // caller's own cancel back to them as a failed import.
  await expect(page.getByTestId("import-cancelled")).toBeVisible();
  await expect(page.getByTestId("import-error")).toHaveCount(0);
  await expect(page.getByTestId("cancel-video-import")).toHaveCount(0);
  await expect(page.getByTestId("import-outcome")).toHaveCount(0);

  // It stopped short: the frames it got to are fewer than the frames it was for.
  expect(partway).toBeGreaterThan(0);
  expect(partway).toBeLessThan(expectedFrames([], DURATION, CANCEL_RATE));

  // No asset and no batch reached the project. A batch holding a fraction of a clip is
  // undetectable downstream, which is why frames are staged rather than ingested
  // as they arrive.
  const batches = await request.get(`/projects/${projectId}/batches`, { headers: bearer() });
  expect((await batches.json()) as { total: number }).toMatchObject({ total: 0 });

  // And the session ended rather than staying open over staged bytes nobody will
  // ever claim. `aborted` is final and carries no batch — there is no edge back.
  expect(imports).toHaveLength(1);
  const session = await request.get(`/video-imports/${imports[0]}`, { headers: bearer() });
  expect(session.ok(), `GET the session answered ${session.status()}`).toBe(true);
  expect((await session.json()) as { state: string; batch_id: string | null }).toMatchObject({
    state: "aborted",
    batch_id: null,
  });

  await expectNoClipUpload(log);
});

test("a file that is not a container is refused here, with no server to fall back on", async ({
  page,
  request,
}) => {
  const log = await watch(page);
  await projectAtIngest(page, request, "refused-video-import");

  await page.getByTestId("file-input").setInputFiles(GARBAGE);
  const refusal = page.getByTestId("clip-refusal");
  await expect(refusal).toHaveAttribute("data-refusal", "unparsable-container");
  await expect(refusal).toContainText("This file's container could not be parsed");
  // The extension said `.webm` and the decoder disagreed, which is the point.
  await expect(page.getByTestId("clip-decodable")).toHaveText("cannot decode it");

  // No remedy that does not exist is offered, and none is reachable: there is no
  // server-side decoder to hand it to, so the refusal is the end of the road.
  await expect(page.getByTestId("start-video-import")).toBeDisabled();
  await expect(page.getByTestId("register-source")).toHaveCount(0);
  // Nothing was opened and nothing was sent: a refusal this screen reached on its
  // own, with no round trip to ask a second opinion.
  expect(log.seen.filter((one) => one.path.includes("video-import"))).toEqual([]);
  expect((await log.sent()).filter((one) => one.method !== "GET")).toEqual([]);
});
