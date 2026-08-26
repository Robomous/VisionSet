/**
 * The batch view, in a browser — where its riskiest claims are the only ones
 * that can be checked at all.
 *
 * ## Why this suite exists rather than more vitest
 *
 * jsdom reports every element as 0×0. A `ResizeObserver` that is never attached,
 * a grid that renders one tile per row at every width, a nested scroll container
 * — all three are invisible there, and all three are what this screen turns on.
 * **It is not a hypothetical**: a gallery can render one
 * column for a whole release while its component tests pass, because those tests
 * assert the fallback as though it were the design.
 *
 * A window scroller makes that worse. When the measured element is the scroll
 * container, a virtualizer that works is evidence the node has
 * been handed over; with `useWindowVirtualizer` it
 * virtualizes perfectly against a grid nobody ever measured. The tell is gone, so
 * the assertion lives here.
 *
 * Everything is routed under `/api/`, which is where the app sends requests in
 * development. Routing the bare paths would also intercept the *document*
 * navigation, and the failure reads as "the shell disappeared".
 */

import { expect, test, type Page, type Request } from "@playwright/test";
import { assetActions, batchActions, jobActions, type Wire } from "./_wire";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const JOB_B = "55555555-5555-4555-8555-555555555555";
const SOURCE = "44444444-4444-4444-8444-444444444444";

/** A 1x1 PNG, so a tile has real bytes rather than a broken-image box. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The fixture, and it is deliberately awkward in three ways.
 *
 * **All five domain states appear.** The four-segment toolbar folds five states,
 * and `review_pending` and `accepted` are the two a careless fold drops — a
 * fixture of unannotated-and-annotated would let that ship.
 *
 * **One frame index is four digits.** `frame 1047` truncated to `frame …` inside
 * the old 160px tile, which is the defect the index pill exists to fix, and a
 * fixture of single-digit indices cannot see it.
 *
 * **The batch's counts do not match the loaded page.** `asset_count` is 48 while
 * eight assets come back, because the segment counts must describe the batch and
 * not the window — a filter whose numbers described the hundred rows in memory
 * would be lying about the fifty thousand it is filtering.
 */
const STATES: readonly Wire["AssetProgress"][] = [
  "unannotated",
  "unannotated",
  "annotated",
  "annotated",
  "review_pending",
  "accepted",
  "skipped",
  "unannotated",
];

const INDEXES = [0, 1, 2, 3, 4, 5, 6, 1047] as const;

/**
 * The same eight frames with every one of them settled.
 *
 * Three annotated and five skipped:
 * nothing `unannotated` and nothing `review_pending`, so nothing blocks
 * completion, and a majority skipped so `Restore` has something real to act on.
 */
const SETTLED_STATES: readonly Wire["AssetProgress"][] = [
  "annotated",
  "annotated",
  "annotated",
  "skipped",
  "skipped",
  "skipped",
  "skipped",
  "skipped",
];

function assets(
  jobOf: (at: number) => string | null,
  settled = false,
  batchState: Wire["BatchState"] = "in_annotation",
  removed: ReadonlySet<string> = new Set(),
): Wire["BatchAssetPage"] {
  const all = settled ? SETTLED_STATES : STATES;
  // Derived from what the run has actually removed, never a frozen list: a stub
  // that keeps answering the same membership after a DELETE lets an
  // implementation that never sent one pass, and lets one that sent the wrong
  // ids pass just as easily.
  const kept = all
    .map((progress, at) => ({ progress, at }))
    .filter(({ at }) => !removed.has(`asset-${at}`));
  return {
    total: kept.length,
    items: kept.map(({ progress, at }) => {
      const jobId = jobOf(at);
      return {
        id: `asset-${at}`,
        project_id: PROJECT,
        modality: "image",
        content_hash: `${at}`.padStart(8, "0") + "deadbeef",
        width: 1280,
        height: 720,
        format: "png",
        source_id: SOURCE,
        frame_index: INDEXES[at],
        frame_timestamp: at,
        thumbnail_hash: "cafebabe",
        ingested_at: "2026-08-01T09:00:00Z",
        job_id: jobId,
        progress: jobId === null ? null : progress,
        // The server's own answer, and the dimension the client's old mirror
        // dropped: `asset_actions` returns `[]` for every frame of a batch that is
        // not `in_annotation`, whatever the frame's own progress is.
        allowed_actions: assetActions(jobId === null ? null : progress, { batchState }),
        // Three boxes on the one card a test names ("3 boxes"); every other state
        // carries none, which is what an unannotated or merely-reviewed frame is.
        annotation_count: progress === "annotated" ? 3 : 0,
        min_confidence: null,
      };
    }),
  };
}

const BATCH_COUNTS = {
  total: 48,
  unannotated: 30,
  pre_labeled: 0,
  annotated: 8,
  review_pending: 5,
  accepted: 1,
  skipped: 4,
} satisfies Wire["ProgressCounts"];

/** Nothing outstanding, which is the whole precondition for finishing. */
const SETTLED_COUNTS = {
  total: 48,
  unannotated: 0,
  pre_labeled: 0,
  annotated: 3,
  review_pending: 0,
  accepted: 0,
  skipped: 45,
} satisfies Wire["ProgressCounts"];

/**
 * The two jobs' counts when the fixture cuts two, each describing its own half.
 *
 * The accordion opens on the first job with `unannotated + pre_labeled` left, so
 * the split is what decides which panel a two-job run starts on — here the first,
 * with the second's frames all settled or in review.
 */
const SPLIT_COUNTS: Record<string, Wire["ProgressCounts"]> = {
  [JOB]: {
    total: 4,
    unannotated: 2,
    pre_labeled: 0,
    annotated: 2,
    review_pending: 0,
    accepted: 0,
    skipped: 0,
  },
  [JOB_B]: {
    total: 4,
    unannotated: 1,
    pre_labeled: 0,
    annotated: 0,
    review_pending: 1,
    accepted: 1,
    skipped: 1,
  },
};

interface Options {
  /** `draft` is the state with the approve CTA, and the state with no jobs. */
  readonly state?: Wire["BatchState"];
  /**
   * Cut the eight frames into two jobs, 0–3 and 4–7.
   *
   * Different frames on each side, which is what makes "only the open job's
   * tiles" a claim with content: a page that dropped the `job` filter would show
   * all eight and a stub that answered one fixed page could not tell.
   */
  readonly twoJobs?: boolean;
  /**
   * Every frame settled and nothing outstanding.
   *
   * The default fixture is deliberately mid-flight (30 of 48 unannotated), which
   * is the wrong shape for every claim about *finishing*: the Complete button is
   * withheld while work is outstanding, so a test written against the default
   * would assert against a control that is correctly disabled.
   */
  readonly settled?: boolean;
  /** The state the batch's one job is in when the page loads. */
  readonly jobState?: Wire["AnnotationJobState"];
}

async function serveApi(page: Page, sent: Request[], options: Options = {}): Promise<void> {
  const state = options.state ?? "in_annotation";
  const twoJobs = options.twoJobs === true;
  const roster = twoJobs ? [JOB, JOB_B] : [JOB];
  // A draft has no jobs at all; otherwise the second half of the fixture belongs
  // to the second job whenever there is one.
  const jobOf = (at: number): string | null =>
    state === "draft" ? null : twoJobs && at >= 4 ? JOB_B : JOB;
  const counts = options.settled === true ? SETTLED_COUNTS : BATCH_COUNTS;
  const settledStates = options.settled === true;
  // The job moves as the requests land, for the same reason `current` does: a
  // static stub would let an implementation that never sent the job transitions
  // — which is the entire defect — pass.
  let job = options.jobState ?? "in_progress";
  // A `POST /approve` moves it, so the badge afterwards is the server's answer
  // rather than something the page decided — approval is not optimistic, and a
  // static stub would let an optimistic implementation pass.
  let current = state;
  // What this run has removed, so the listing and the counts move with the
  // DELETE the same way the server's would.
  const removed = new Set<string>();
  // What a promotion moved into the trunk, read back by the batch the way the
  // server derives `promoted_asset_count` per read.
  let promoted = 0;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");

    // Answered before anything is recorded: every page load asks whether this
    // server will sign the browser in by itself, and here it will not.
    if (path === "/session") return route.fulfill({ json: { issued: false } });
    sent.push(request);

    if (request.method() === "POST" && path === `/batches/${BATCH}/approve`) {
      current = "approved";
      return route.fulfill({
        json: {
          id: BATCH,
          project_id: PROJECT,
          name: "drive-01",
          state: current,
          schema_version: 3,
          asset_count: counts.total,
          progress: counts,
          allowed_actions: batchActions(current),
          promoted_asset_count: 0,
          parent_batch_id: null,
          pre_label_run: null,
        } satisfies Wire["BatchOut"],
      });
    }
    if (path === `/batches/${BATCH}/jobs`) {
      return route.fulfill({
        json: {
          items: roster.map((id) => ({
            id,
            batch_id: BATCH,
            state: job,
            asset_count: twoJobs ? 4 : 48,
            allowed_actions: jobActions(job),
            assignee: null,
            pre_label_run: null,
          })),
          total: roster.length,
        } satisfies Wire["JobPage"],
      });
    }
    // The accordion reads every job's counts before it opens one, and the open
    // panel's segment chips are that job's rather than the batch's — so this is
    // per job, and with two jobs it is each one's own half.
    if (request.method() === "GET" && /^\/jobs\/[^/]+\/progress$/.test(path)) {
      const id = path.split("/")[2] as string;
      return route.fulfill({
        json: (twoJobs ? (SPLIT_COUNTS[id] ?? counts) : counts) satisfies Wire["ProgressCounts"],
      });
    }
    if (request.method() === "POST" && path === `/jobs/${JOB}/start`) {
      job = "in_progress";
      return route.fulfill({
        json: {
          id: JOB,
          batch_id: BATCH,
          state: job,
          asset_count: 48,
          allowed_actions: jobActions(job),
          assignee: null,
          pre_label_run: null,
        } satisfies Wire["JobOut"],
      });
    }
    if (request.method() === "POST" && path === `/jobs/${JOB}/complete`) {
      // The kernel's own gate, kept rather than stubbed away: a job may only be
      // completed from `in_progress`, so a page that skipped `start` gets the
      // 409 a real server would send instead of a silent pass.
      if (job !== "in_progress") {
        return route.fulfill({
          status: 409,
          json: { code: "INVALID_TRANSITION", message: `job cannot become completed from ${job}` },
        });
      }
      job = "completed";
      return route.fulfill({
        json: {
          id: JOB,
          batch_id: BATCH,
          state: job,
          asset_count: 48,
          allowed_actions: jobActions(job),
          assignee: null,
          pre_label_run: null,
        } satisfies Wire["JobOut"],
      });
    }
    if (request.method() === "POST" && path === `/batches/${BATCH}/complete`) {
      // And the outer gate. This is the 409 the founder saw, reproduced exactly:
      // every asset settled, one job still open, and the batch refusing.
      if (job !== "completed") {
        return route.fulfill({
          status: 409,
          json: {
            code: "BATCH_NOT_COMPLETE",
            message: "batch 'drive-01' has 1 of 1 jobs still unfinished",
          },
        });
      }
      current = "completed";
      return route.fulfill({
        json: {
          id: BATCH,
          project_id: PROJECT,
          name: "drive-01",
          state: current,
          schema_version: 3,
          asset_count: counts.total,
          progress: counts,
          allowed_actions: batchActions(current),
          promoted_asset_count: 0,
          parent_batch_id: null,
          pre_label_run: null,
        } satisfies Wire["BatchOut"],
      });
    }
    if (request.method() === "PUT" && /\/progress$/.test(path)) {
      return route.fulfill({
        json: {
          asset_id: path.split("/")[4],
          progress: "skipped",
        } satisfies Wire["AssetProgressOut"],
      });
    }
    if (path === `/projects/${PROJECT}`) {
      return route.fulfill({
        json: { id: PROJECT, name: "road-signs", description: null, thumbnail_asset_id: null, thumbnail_hash: null, created_at: null } satisfies Wire["ProjectOut"],
      });
    }
    if (path === `/batches/${BATCH}`) {
      return route.fulfill({
        json: {
          id: BATCH,
          project_id: PROJECT,
          name: "drive-01",
          state: current,
          schema_version: current === "draft" ? null : 3,
          // Follows the removals, because the server's would: a stub answering a
          // frozen count lets a page that never invalidates the batch pass, and
          // the header saying 48 over 46 tiles is exactly the stale-count shape
          // the invalidation exists to prevent.
          asset_count: counts.total - removed.size,
          progress: counts,
          allowed_actions: batchActions(current),
          promoted_asset_count: promoted,
          parent_batch_id: null,
          pre_label_run: null,
        } satisfies Wire["BatchOut"],
      });
    }
    if (request.method() === "POST" && path === `/batches/${BATCH}/promote`) {
      // Only finished work is promoted, and the kernel says so before this
      // fixture would — a page that promoted first would meet the real refusal.
      if (current !== "completed") {
        return route.fulfill({
          status: 409,
          json: { code: "BATCH_NOT_COMPLETE", message: `batch 'drive-01' is '${current}'` },
        });
      }
      promoted = counts.annotated;
      return route.fulfill({
        json: {
          items: Array.from({ length: promoted }, (_, at) => ({
            id: `asset-${at}`,
            project_id: PROJECT,
            modality: "image",
            content_hash: `${at}`.padStart(8, "0") + "deadbeef",
            width: 1280,
            height: 720,
            format: "jpeg",
            source_id: null,
            frame_index: at,
            frame_timestamp: null,
            thumbnail_hash: null,
            ingested_at: "2026-08-01T09:00:00Z",
          })),
          total: promoted,
        } satisfies Wire["AssetPage"],
      });
    }
    if (request.method() === "DELETE" && path === `/batches/${BATCH}/assets`) {
      // The kernel's own gate, kept rather than stubbed away: membership is
      // editable in `draft` and nowhere else, so a page that offers this on an
      // approved batch gets the 409 a real server would send.
      if (current !== "draft") {
        return route.fulfill({
          status: 409,
          json: {
            code: "BATCH_NOT_EDITABLE",
            message: `batch 'drive-01' is '${current}', so its membership is frozen`,
          },
        });
      }
      const asked = new URL(request.url()).searchParams.getAll("id");
      // `changed` is what was *there*, not what was asked for — idempotent both
      // ways, which is the distinction the report is built on.
      const changed = asked.filter((id) => !removed.has(id));
      for (const id of changed) removed.add(id);
      return route.fulfill({
        json: {
          batch: {
            id: BATCH,
            project_id: PROJECT,
            name: "drive-01",
            state: current,
            schema_version: null,
            asset_count: counts.total - removed.size,
            progress: counts,
            allowed_actions: batchActions(current),
            promoted_asset_count: 0,
            parent_batch_id: null,
            pre_label_run: null,
          },
          changed,
        } satisfies Wire["BatchMembershipOut"],
      });
    }
    if (path === `/batches/${BATCH}/assets`) {
      // `current`, not `state`: an approve during the test moves it, and the
      // frames' declarations move with the batch exactly as the server's would.
      const page_ = assets(jobOf, settledStates, current, removed);
      // The segment toolbar is server-side now: `progress` repeats per state and
      // narrows the page, exactly as `BatchService.asset_page` does — and so is
      // the accordion's `job`, which keeps only the frames that job carries.
      const params = new URL(request.url()).searchParams;
      const wanted = params.getAll("progress");
      const forJob = params.get("job");
      const items = page_.items
        .filter((one) => forJob === null || one.job_id === forJob)
        .filter((one) => wanted.length === 0 || wanted.includes(one.progress ?? ""));
      return route.fulfill({ json: { total: items.length, items } satisfies Wire["BatchAssetPage"] });
    }
    if (path === `/sources/${SOURCE}`) {
      return route.fulfill({
        json: {
          id: SOURCE,
          project_id: PROJECT,
          kind: "video",
          name: "video-test-480.mp4",
          registered_at: "2026-08-01T08:00:00Z",
          video: {
            codec: "h264",
            duration_seconds: 10,
            extraction_fps: 5,
            fps: 30,
            width: 1280,
            height: 720,
            ranges: [],
          },
        } satisfies Wire["SourceOut"],
      });
    }
    if (path.endsWith("/thumbnail")) {
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    }
    if (path.endsWith("/annotations")) {
      // Three boxes, so a card can say `3 boxes` — the count is per card, because
      // `BatchAssetOut` carries none.
      return route.fulfill({
        json: {
          items: [1, 2, 3].map((n) => ({
            id: `ann-${n}`,
            asset_id: "asset-2",
            label_class: "vehicle",
            geometry: { type: "bbox", x: 1, y: 1, width: 10, height: 10 },
            attributes: {},
            confidence: null,
            job_id: null,
            model_ref: null,
            provenance: "human",
            schema_version: 3,
          })),
          total: 3,
        } satisfies Wire["AnnotationPage"],
      });
    }
    return route.fulfill({ json: { items: [], total: 0 } satisfies Wire["AssetPage"] });
  });
}

async function openGallery(page: Page, sent: Request[], options: Options = {}): Promise<void> {
  await serveApi(page, sent, options);
  await page.goto(`/projects/${PROJECT}/batches/${BATCH}`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("gallery-grid")).toBeVisible();
  // And it has frames in it. Inside a job panel the grid is two round trips
  // ahead of its own rows — the jobs, then every job's counts, then the frames —
  // so an empty grid is a normal intermediate state, and the tests that read the
  // DOM in one `evaluate` with nothing to retry would sample it.
  await expect(page.getByTestId("gallery-row-0")).toBeVisible();
}

// --- the layout change, which is why this file exists ------------------------

test("the grid renders more than one column, measured in a real browser", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  // The column count, and the only place it is detectable. The viewport is
  // 1440 wide and the default density is a 200px minimum column, so a measured
  // grid is several columns and an unmeasured one is exactly 1.
  const grid = page.getByTestId("gallery-grid");
  await expect.poll(async () => Number(await grid.getAttribute("data-columns"))).toBeGreaterThan(1);

  // Not just the attribute: the tiles really are laid out side by side. An
  // attribute can be right while the CSS grid is not, and this is the claim a
  // person actually cares about.
  const first = await page.getByTestId("tile-asset-0").boundingBox();
  const second = await page.getByTestId("tile-asset-1").boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second?.y).toBeCloseTo(first?.y ?? -1, 0);
  expect(second?.x ?? 0).toBeGreaterThan(first?.x ?? 0);
});

/**
 * Wait until the tiles have stopped moving — two consecutive animation frames
 * reporting identical geometry.
 *
 * A state, not a clock, and specifically **not** the state the callers assert.
 * The wait this replaced was `tile-asset-0`'s width being greater than zero,
 * which the *previous* density already satisfied: it returned on its first tick,
 * so the measurement after it could land mid-transition and the suite reported a
 * layout defect that was one frame old. That is #511, and it was a real frame —
 * see the scenario below, which is the one that owns that claim.
 */
async function settled(page: Page): Promise<void> {
  await page.evaluate(
    async () =>
      new Promise<void>((done) => {
        const geometry = () =>
          [...document.querySelectorAll('[data-testid^="tile-"]')]
            .map((node) => {
              const box = node.getBoundingClientRect();
              return `${box.top}:${box.left}:${box.width}:${box.height}`;
            })
            .join("|");
        let last = "";
        const tick = (): void => {
          const now = geometry();
          if (now !== "" && now === last) return done();
          last = now;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

test("a density change never paints a frame with tiles overlapping", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);
  await page.getByTestId("density").fill("0");
  await settled(page);

  // The scenario below checks the layout a density change *arrives at*; this one
  // checks every frame on the way, which is a different defect and was invisible
  // to it except as a flake.
  //
  // A new row-height estimate does not displace a measurement: the rows carry the
  // virtualizer's `measureElement`, so their positions come from the cache its
  // `ResizeObserver` fills, and that observer fires a frame after the wider tiles
  // have been laid out. So for one frame the tiles were the new size while the
  // rows were still a pitch apart at the old one. Measured at step 0 → 3 before
  // the fix: row 1 at 419 with four overlapping pairs, then 553 on the next frame.
  await page.evaluate(() => {
    const win = window as unknown as { __overlaps: number[] };
    win.__overlaps = [];
    const sample = (): void => {
      const boxes = [...document.querySelectorAll('[data-testid^="tile-"]')].map((node) =>
        node.getBoundingClientRect(),
      );
      let hits = 0;
      for (let a = 0; a < boxes.length; a += 1) {
        for (let b = a + 1; b < boxes.length; b += 1) {
          const one = boxes[a]!;
          const two = boxes[b]!;
          if (
            one.bottom - two.top > 0.5 &&
            two.bottom - one.top > 0.5 &&
            one.right - two.left > 0.5 &&
            two.right - one.left > 0.5
          ) {
            hits += 1;
          }
        }
      }
      win.__overlaps.push(hits);
      if (win.__overlaps.length < 8) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  // The widest step, from the narrowest: the biggest jump the ladder can make, and
  // the one that produced the most overlap.
  await page.getByTestId("density").fill("3");
  const sampled = async (): Promise<number[]> =>
    await page.evaluate(() => (window as unknown as { __overlaps: number[] }).__overlaps);
  await expect.poll(async () => (await sampled()).length).toBe(8);

  expect(await sampled(), "a frame painted during the density change had overlapping tiles").toEqual(
    [0, 0, 0, 0, 0, 0, 0, 0],
  );
});

test("tiles never overlap, at any density", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  // The defect: the row height was estimated from `minColumn`, while the grid is
  // `auto-fill` + `1fr` and stretches tiles to whatever the leftover space makes
  // them. At few columns the real tile is far wider than the minimum, so a 4:3
  // tile was taller than the row the virtualizer had positioned for it and the
  // rows grew into each other. Measured before the fix: 37px of overlap at the
  // narrowest step, 191px at the widest — worse the bigger the thumbnails, which
  // is exactly how it was reported.
  //
  // Only a browser can see this. jsdom reports every box as 0×0, so every pair of
  // rectangles is trivially non-overlapping there.
  for (const step of ["0", "1", "2", "3"]) {
    await page.getByTestId("density").fill(step);
    await settled(page);

    const overlaps = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('[data-testid^="tile-"]')].map((node) => {
        const box = node.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
      });
      const hits: string[] = [];
      for (let a = 0; a < boxes.length; a += 1) {
        for (let b = a + 1; b < boxes.length; b += 1) {
          const one = boxes[a]!;
          const two = boxes[b]!;
          // A half-pixel of tolerance: subpixel layout can put two rectangles
          // a rounding error apart, and that is not a collision.
          const vertical = one.bottom - two.top > 0.5 && two.bottom - one.top > 0.5;
          const horizontal = one.right - two.left > 0.5 && two.right - one.left > 0.5;
          if (vertical && horizontal) hits.push(`${a}×${b}`);
        }
      }
      return hits;
    });
    expect(overlaps, `tiles overlap at density step ${step}`).toEqual([]);
  }
});

test("a row is as tall as the tiles in it, not as tall as the minimum column", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openGallery(page, sent);
  await page.getByTestId("density").fill("3");

  // The cause, stated directly so a regression names itself rather than showing
  // up as "the second row looks wrong". A row that is shorter than its own
  // content is the overlap, one step earlier.
  const gap = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid^="gallery-row-"]')];
    if (rows.length < 2) return null;
    const first = rows[0]!.getBoundingClientRect();
    const second = rows[1]!.getBoundingClientRect();
    return second.top - first.bottom;
  });
  expect(gap).not.toBeNull();
  // The same half-pixel tolerance the collision test uses, and for the same
  // reason: `getBoundingClientRect` reports fractional CSS pixels while the
  // virtualizer positions rows on the heights it measured, so two boxes can sit
  // a rounding error apart. Measured here at about -0.44px, against the 191px
  // this test exists to catch. A tolerance that admitted the defect would be
  // useless; one that refuses subpixel arithmetic would be flaky.
  expect(gap ?? -99).toBeGreaterThan(-0.5);
});

test("the grid has no scroll parent between it and the document", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  // The layout defect, stated as the thing it actually was: a `max-h-[70vh]
  // overflow-y-auto` box in the middle of the page, with the document scrolling
  // behind it. Walking the real ancestor chain and reading computed styles is the
  // only way to know there is not a second one; a class assertion would miss a
  // scroller introduced by any wrapper this screen does not own.
  const scrollers = await page.evaluate(() => {
    const grid = document.querySelector('[data-testid="gallery-grid"]');
    const found: string[] = [];
    let node = grid?.parentElement ?? null;
    while (node !== null && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
        found.push(node.className);
      }
      node = node.parentElement;
    }
    return found;
  });
  expect(scrollers).toEqual([]);
});

test("the grid re-flows when the density slider moves", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  const grid = page.getByTestId("gallery-grid");
  await expect.poll(async () => Number(await grid.getAttribute("data-columns"))).toBeGreaterThan(1);
  const before = Number(await grid.getAttribute("data-columns"));

  // Step 3 is the 260px minimum, the widest rung: strictly fewer columns in the
  // same pane. This
  // also covers the dependency that is easy to omit — `minColumn` has to be in
  // the measuring effect's deps, or the observer keeps answering for the old
  // ladder step forever.
  await page.getByTestId("density").fill("3");
  await expect.poll(async () => Number(await grid.getAttribute("data-columns"))).toBeLessThan(before);
  // The ladder is four rungs. A fifth would be reachable here and is not.
  await expect(page.getByTestId("density")).toHaveAttribute("max", "3");
});

test("the chosen density survives a reload", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  await page.getByTestId("density").fill("0");
  await expect(page.getByTestId("density")).toHaveValue("0");

  await page.reload();
  // No second sign-in: the *token* lives in `sessionStorage`, which survives a
  // reload within the tab, so the gate does not reappear. That contrast is the
  // point of the test — the density is in `localStorage` for a different reason
  // (a preference is not a credential; `data/prefs.ts` argues it), and a reload
  // is where the two would look the same if the preference had been put beside
  // the token.
  await expect(page.getByTestId("density")).toHaveValue("0");
});

// --- two steps as one --------------------------------------------------------

test("Complete and promote finishes the job, closes the batch, promotes, and says all three", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openGallery(page, sent, { settled: true });

  const composed = page.getByTestId("complete-promote-drive-01");
  await expect(composed).toHaveAttribute("data-variant", "secondary");
  await composed.click();

  // In order, and the job first: the batch refuses while its job is open.
  const line = page.getByTestId("completed-drive-01");
  await expect(line).toHaveText(
    "Completed, finishing 1 job. Promoted 3 assets to the dataset. 45 skipped frames stayed out.",
  );
  const posts = sent
    .filter((request) => request.method() === "POST")
    .map((request) => new URL(request.url()).pathname.replace(/^\/api/, ""));
  expect(posts).toEqual([
    `/jobs/${JOB}/complete`,
    `/batches/${BATCH}/complete`,
    `/batches/${BATCH}/promote`,
  ]);
  // The batch is `completed` now and declares no `complete`, so the button is
  // gone — the line that says what it did is not.
  await expect(composed).toHaveCount(0);
  await expect(page.getByTestId("batch-state")).toHaveText("completed");
  await expect(page.getByTestId("complete-promote-open-dataset-drive-01")).toBeVisible();
});

// --- one job, and several ----------------------------------------------------

test("a one-job batch draws its job flat: no accordion, one bar, the job's controls under the header", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  await expect(page.getByTestId("job-panels")).toHaveCount(0);
  await expect(page.getByTestId(/^job-header-/)).toHaveCount(0);
  const workspace = page.getByTestId("job-workspace");
  await expect(workspace).toBeVisible();
  // The batch bar is the page's one bar; the strip below it is the breakdown.
  await expect(page.getByRole("progressbar")).toHaveCount(1);
  await expect(page.getByTestId("batch-progress-row").getByRole("progressbar")).toHaveCount(1);
  await expect(workspace.getByTestId("timeline")).toBeVisible();
  // The door, Pre-label's slot and the assignee line are the job's, under the
  // header — and none of them is the page's filled control.
  await expect(workspace.getByTestId(`start-job-${JOB}`)).toHaveAttribute("data-variant", "secondary");
  await expect(workspace.getByTestId(`assignee-${JOB}`)).toContainText("Unassigned");
  await expect(page.getByTestId("gallery").locator('[data-variant="primary"]')).toHaveCount(0);
  await expect(workspace.getByTestId("segments")).toBeVisible();
  await expect(workspace.getByTestId("tile-asset-0")).toBeVisible();
});

// --- the accordion -----------------------------------------------------------

test("a two-job batch shows only the open job's tiles, and opening the other header swaps them", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openGallery(page, sent, { twoJobs: true });

  // Exactly one open. Two panels at once would be the batch-wide grid again, one
  // indent further in — the screen with two truths for the same frames.
  await expect(page.getByTestId(/^job-header-/)).toHaveCount(2);
  await expect(page.locator('[data-testid^="job-header-"][aria-expanded="true"]')).toHaveCount(1);

  // The first job is the one with work left, so it is the one that opens.
  await expect(page.getByTestId(`job-header-${JOB}`)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId(`job-panel-${JOB}`).getByTestId("tile-asset-0")).toBeVisible();
  await expect(page.getByTestId("tile-asset-4")).toHaveCount(0);

  await page.getByTestId(`job-header-${JOB_B}`).click();

  await expect(page.getByTestId(`job-panel-${JOB_B}`).getByTestId("tile-asset-4")).toBeVisible();
  await expect(page.getByTestId("tile-asset-0")).toHaveCount(0);
  await expect(page.getByTestId(`job-panel-${JOB}`)).toHaveCount(0);
  await expect(page.getByTestId(`job-header-${JOB}`)).toHaveAttribute("aria-expanded", "false");
});

// --- approval ----------------------------------------------------------------

test("a draft batch can be approved from the view it is a dead end in", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent, { state: "draft" });

  await expect(page.getByTestId("batch-state")).toHaveText("pending approval");
  await page.getByTestId("approve-batch").click();
  await expect(page.getByTestId("approve-dialog")).toBeVisible();
  await page.getByTestId("approve-submit").click();

  // The badge moves because the server said so, and the CTA goes because the
  // batch is no longer a draft. Nothing here was optimistic: approval carries a
  // partition, pins the schema and cuts the jobs, and cannot be rolled back.
  await expect(page.getByTestId("batch-state")).toHaveText("approved");
  await expect(page.getByTestId("approve-batch")).toHaveCount(0);
  expect(sent.some((one) => one.method() === "POST" && one.url().includes("/approve"))).toBe(true);
});

test("cancelling the dialog changes nothing", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent, { state: "draft" });

  await page.getByTestId("approve-batch").click();
  await page.getByTestId("approve-cancel").click();

  await expect(page.getByTestId("approve-dialog")).toHaveCount(0);
  await expect(page.getByTestId("batch-state")).toHaveText("pending approval");
  expect(sent.some((one) => one.method() === "POST")).toBe(false);
});

// --- the toolbar's four segments over five states ----------------------------

test("each segment shows the frames that belong to it and no others", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  await page.getByTestId("segment-review").click();
  // `asset-4` is the `review_pending` one. If review were folded into done this
  // segment would be empty and the fold would be invisible everywhere else.
  await expect(page.getByTestId("tile-asset-4")).toBeVisible();
  await expect(page.getByTestId("tile-asset-2")).toHaveCount(0);

  await page.getByTestId("segment-done").click();
  await expect(page.getByTestId("tile-asset-2")).toBeVisible(); // annotated
  await expect(page.getByTestId("tile-asset-5")).toBeVisible(); // accepted
  await expect(page.getByTestId("tile-asset-6")).toBeVisible(); // skipped
  await expect(page.getByTestId("tile-asset-4")).toHaveCount(0); // review_pending

  await page.getByTestId("segment-unannotated").click();
  await expect(page.getByTestId("tile-asset-0")).toBeVisible();
  await expect(page.getByTestId("tile-asset-2")).toHaveCount(0);
});

// --- the cards ---------------------------------------------------------------

test("a four-digit frame index is fully visible", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  // The defect: `frame 1047` rendered as `frame …` inside a 160px tile, because
  // the caption was `truncate`d. Text content alone would not catch it — CSS
  // ellipsis does not change `textContent` — so the width is measured too.
  const pill = page.getByTestId("index-asset-7");
  await expect(pill).toHaveText("1047");
  const clipped = await pill.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
  expect(clipped).toBe(false);
});

test("an annotated card counts its objects and the others say their state", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  await expect(page.getByTestId("state-asset-2")).toContainText("3 boxes");
  await expect(page.getByTestId("state-asset-0")).toContainText("unannotated");
  // `in review`, not the wire's `review_pending` — and drawn differently from
  // `accepted`, which the toolbar folds together with `annotated`.
  await expect(page.getByTestId("state-asset-4")).toContainText("in review");
  await expect(page.getByTestId("state-asset-5")).toContainText("accepted");
  await expect(page.getByTestId("state-asset-6")).toContainText("skipped");
});

test("every state is drawn with a shape as well as a colour", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  // Colour alone is not a status. Four dot shapes across five states, plus the
  // word on every card, is what carries it for anyone who cannot tell the accent
  // from the surface.
  const dots = await page.evaluate(() =>
    ["0", "2", "4", "5", "6"].map(
      (at) =>
        document
          .querySelector(`[data-testid="state-asset-${at}"] [data-dot]`)
          ?.getAttribute("data-dot") ?? "",
    ),
  );
  expect(dots).toEqual(["hollow", "filled", "ring", "filled", "muted"]);
});

// --- selection ---------------------------------------------------------------

test("shift-click selects a range and Escape clears it", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  await page.getByTestId("select-asset-0").click();
  await expect(page.getByTestId("bulk-count")).toHaveText("1 frame selected");

  // `locator.click` and not `page.mouse.click`: the latter silently ignores a
  // `modifiers` option and TypeScript does not catch it.
  await page.getByTestId("select-asset-3").click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("bulk-count")).toHaveText("4 frames selected");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
});

test("cmd-click adds one frame without replacing the selection", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  await page.getByTestId("select-asset-0").click();
  await page.getByTestId("select-asset-5").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByTestId("bulk-count")).toHaveText("2 frames selected");

  // And removes it again, which is the half that is easy to get wrong.
  await page.getByTestId("select-asset-5").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByTestId("bulk-count")).toHaveText("1 frame selected");
});

test("marking a selection skipped sends one request per frame", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  await page.getByTestId("select-asset-0").click();
  await page.getByTestId("select-asset-1").click({ modifiers: ["Shift"] });
  await page.getByTestId("bulk-skip").click();

  // There is no bulk endpoint, so this is N requests and the screen does not
  // pretend otherwise — which is also why a partial outcome is renderable.
  await expect
    .poll(() => sent.filter((one) => one.method() === "PUT" && one.url().includes("/progress")).length)
    .toBe(2);
});

// --- the timeline ------------------------------------------------------------

test("clicking a timeline cell brings that frame into view", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  // Narrow enough that the grid is one column and eight frames do not fit on
  // screen at once, so "scrolled into view" is a claim with content.
  await page.setViewportSize({ width: 520, height: 600 });
  await page.getByTestId("density").fill("3");

  await page.getByTestId("timeline-asset-7").click();
  await expect(page.getByTestId("tile-asset-7")).toBeInViewport();
});

test("a timeline cell names its frame and its exact state", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  // The strip is coloured by the *exact* state rather than by the toolbar's
  // grouping, and the label is what makes that reachable without colour vision.
  await expect(page.getByTestId("timeline-asset-4")).toHaveAttribute(
    "aria-label",
    "Frame 4, in review",
  );
  await expect(page.getByTestId("timeline-asset-7")).toHaveAttribute(
    "aria-label",
    "Frame 1047, unannotated",
  );
});

// --- finishing a batch ------------------------------------------------------

/** Every write the page made, as `METHOD path`, in the order the server saw them. */
function writes(sent: Request[]): string[] {
  return sent
    .filter((one) => one.method() !== "GET")
    .map((one) => `${one.method()} ${new URL(one.url()).pathname.replace(/^\/api/, "")}`);
}

test("completing a settled batch finishes its job first", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent, { settled: true });

  // The defect, end to end and in the browser it was reported from: 48 of 48
  // settled, one job still `in_progress`, and the only request the page used to
  // send was the one the server answers 409 to. The stub keeps both kernel gates,
  // so a page that skipped either link would fail here rather than pass on a
  // permissive fixture.
  await page.getByTestId("complete-drive-01").click();

  await expect
    .poll(() => writes(sent))
    .toEqual([`POST /jobs/${JOB}/complete`, `POST /batches/${BATCH}/complete`]);

  // And the batch really moved — the badge is the server's answer, not the
  // button's optimism.
  await expect(page.getByTestId("batch-state")).toHaveText("completed");
});

/**
 * The batch-state dimension, in the browser — finding F1.
 *
 * The states the old client-side mirror got wrong are `approved` and
 * `completed`: both have jobs, and `JobService.mark` refuses a write into
 * either before it looks at the frame's progress at all. The bar drew both
 * buttons enabled over frames that are individually skippable, sent one request
 * per frame, took N 409s, and said "0 moved, N refused".
 *
 * Asserted here rather than only in vitest because the claim is about what a
 * person can press: a `disabled` attribute jsdom reports and a control a browser
 * will not activate are not quite the same statement, and the sentence beside it
 * has to be visible. That browser-side claim needs only one state to stand —
 * the per-state wording lives in the gallery vitest suite, which walks both.
 */
for (const state of ["completed"] as const) {
  test(`a ${state} batch offers no bulk move, and says why`, async ({ page }) => {
    const sent: Request[] = [];
    // `settled: true` puts skipped frames in the fixture, so the *progress*
    // dimension permits a restore and only the batch does not — which is what
    // makes this a test of the dimension rather than of the frames.
    await openGallery(page, sent, { state, settled: true });

    await page.getByTestId("select-asset-3").click();
    await page.getByTestId("select-asset-4").click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByTestId("bulk-count")).toHaveText("2 frames selected");

    await expect(page.getByTestId("bulk-skip")).toBeDisabled();
    await expect(page.getByTestId("bulk-restore")).toBeDisabled();
    await expect(page.getByTestId("bulk-restore")).toHaveText(/Restore \(0\)/);

    // Prose, and a route onward where there is one. The old bar's answer was a
    // number with no reason at all.
    const said = page.getByTestId("bulk-unavailable");
    await expect(said).toBeVisible();
    await expect(said).toHaveText(/correction batch/i);

    // And nothing was sent, which is the half the user could not see.
    expect(writes(sent)).toEqual([]);
  });
}

// --- membership editing -------------------------------------------------------

test("frames can be taken out of a draft batch, and the counts follow", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent, { state: "draft" });

  // A draft rendered no selection at all until membership editing had a wire
  // surface — which put the one state where it is legal behind the one gate that
  // hid the control.
  await page.getByTestId("select-asset-0").click();
  await page.getByTestId("select-asset-1").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByTestId("bulk-remove")).toHaveText(/Remove from batch \(2\)/);
  await expect(page.getByTestId("bulk-remove")).toBeEnabled();

  await page.getByTestId("bulk-remove").click();
  // The gate is a gate: nothing is sent until the question is answered, and the
  // question states the consequence rather than asking for a nod.
  await expect(page.getByTestId("remove-consequence")).toHaveText(/stay in the project/i);
  expect(sent.filter((one) => one.method() === "DELETE")).toEqual([]);

  await page.getByTestId("remove-confirm").click();

  await expect(page.getByTestId("bulk-removed")).toHaveText(/Removed 2/);
  // The listing followed, which is the half a report alone cannot promise.
  await expect(page.getByTestId("tile-asset-0")).toHaveCount(0);
  await expect(page.getByTestId("tile-asset-1")).toHaveCount(0);
  await expect(page.getByTestId("tile-asset-2")).toBeVisible();
  // And the batch's own facts, because `asset_count` lives on `BatchOut` and a
  // header still saying 48 over 46 tiles is the stale-count shape.
  await expect(page.getByTestId("batch-facts")).toContainText("46 frames");
});
