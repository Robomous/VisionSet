/**
 * The batch view, in a browser — where #284's riskiest claims are the only ones
 * that can be checked at all.
 *
 * ## Why this suite exists rather than more vitest
 *
 * jsdom reports every element as 0×0. A `ResizeObserver` that is never attached,
 * a grid that renders one tile per row at every width, a nested scroll container
 * — all three are invisible there, and all three are what this change touches.
 * **#159 is the precedent and it is not a hypothetical**: the gallery rendered one
 * column for the whole beta while its component tests passed, because those tests
 * asserted the fallback as though it were the design.
 *
 * #284 made that worse before it made it better. The measured element used to be
 * the scroll container, so a virtualizer that worked was evidence the node had
 * been handed over; the scroller is now the **window**, and `useWindowVirtualizer`
 * virtualizes perfectly against a grid nobody ever measured. The tell is gone, so
 * the assertion moves here.
 *
 * Everything is routed under `/api/`, which is where the app sends requests in
 * development. Routing the bare paths would also intercept the *document*
 * navigation, and the failure reads as "the shell disappeared" — #53 learned that
 * one the slow way.
 */

import { expect, test, type Page, type Request } from "@playwright/test";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
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
const STATES = [
  "unannotated",
  "unannotated",
  "annotated",
  "annotated",
  "review_pending",
  "accepted",
  "skipped",
  "unannotated",
] as const;

const INDEXES = [0, 1, 2, 3, 4, 5, 6, 1047] as const;

function assets(jobId: string | null): Record<string, unknown> {
  return {
    total: STATES.length,
    items: STATES.map((progress, at) => ({
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
    })),
  };
}

const BATCH_COUNTS = {
  total: 48,
  unannotated: 30,
  annotated: 8,
  review_pending: 5,
  accepted: 1,
  skipped: 4,
};

interface Options {
  /** `draft` is the state with the approve CTA, and the state with no jobs. */
  readonly state?: string;
}

async function serveApi(page: Page, sent: Request[], options: Options = {}): Promise<void> {
  const state = options.state ?? "in_annotation";
  const jobId = state === "draft" ? null : JOB;
  // A `POST /approve` moves it, so the badge afterwards is the server's answer
  // rather than something the page decided — approval is not optimistic, and a
  // static stub would let an optimistic implementation pass.
  let current = state;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");

    // Answered before anything is recorded: every page load asks whether this
    // server will sign the browser in by itself (#179), and here it will not.
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
          asset_count: BATCH_COUNTS.total,
          progress: BATCH_COUNTS,
        },
      });
    }
    if (request.method() === "PUT" && /\/progress$/.test(path)) {
      return route.fulfill({ json: { asset_id: path.split("/")[4], progress: "skipped" } });
    }
    if (path === `/projects/${PROJECT}`) {
      return route.fulfill({ json: { id: PROJECT, name: "road-signs", description: null } });
    }
    if (path === `/batches/${BATCH}`) {
      return route.fulfill({
        json: {
          id: BATCH,
          project_id: PROJECT,
          name: "drive-01",
          state: current,
          schema_version: current === "draft" ? null : 3,
          asset_count: BATCH_COUNTS.total,
          progress: BATCH_COUNTS,
        },
      });
    }
    if (path === `/batches/${BATCH}/assets`) return route.fulfill({ json: assets(jobId) });
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
          },
        },
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
            model_ref: null,
            provenance: "human",
            schema_version: 3,
          })),
          total: 3,
        },
      });
    }
    return route.fulfill({ json: { items: [], total: 0 } });
  });
}

async function openGallery(page: Page, sent: Request[], options: Options = {}): Promise<void> {
  await serveApi(page, sent, options);
  await page.goto(`/projects/${PROJECT}/batches/${BATCH}`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("gallery-grid")).toBeVisible();
}

// --- the layout change, which is why this file exists ------------------------

test("the grid renders more than one column, measured in a real browser", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  // #159's actual defect, and the only place it is detectable. The viewport is
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

  // Step 4 is the 320px minimum: strictly fewer columns in the same pane. This
  // also covers the dependency that is easy to omit — `minColumn` has to be in
  // the measuring effect's deps, or the observer keeps answering for the old
  // ladder step forever.
  await page.getByTestId("density").fill("4");
  await expect.poll(async () => Number(await grid.getAttribute("data-columns"))).toBeLessThan(before);
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

test("a batch past draft is never offered approval", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent, { state: "in_annotation" });

  // Absent, not disabled — there is no route back to draft, and an action that
  // would be refused is an action that should not be drawn.
  await expect(page.getByTestId("batch-state")).toHaveText("in progress");
  await expect(page.getByTestId("approve-batch")).toHaveCount(0);
});

test("the header states what the batch is and how far it has got", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  // Every one of these is derived, because `BatchOut` carries none of them.
  await expect(page.getByTestId("batch-facts")).toContainText("video-test-480.mp4");
  await expect(page.getByTestId("batch-facts")).toContainText("48 frames · 5 fps");
  await expect(page.getByTestId("batch-facts")).toContainText("1280×720");
  // 48 total less 30 unannotated. "Annotated" is everything past unannotated, so
  // the bar cannot go backwards when a frame is accepted.
  await expect(page.getByTestId("progress-readout")).toContainText("18 of 48 annotated (38%)");
});

// --- the toolbar's four segments over five states ----------------------------

test("the segments count the batch, and every state lands in exactly one", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  await expect(page.getByTestId("segment-all")).toHaveText("All (48)");
  await expect(page.getByTestId("segment-unannotated")).toHaveText("Unannotated (30)");
  await expect(page.getByTestId("segment-review")).toHaveText("In review (5)");
  // 8 annotated + 1 accepted + 4 skipped. The two a four-way fold drops silently
  // are `review_pending` (its own segment) and `accepted` (inside Done).
  await expect(page.getByTestId("segment-done")).toHaveText("Done (13)");

  const counts = await Promise.all(
    ["unannotated", "review", "done"].map(async (one) => {
      const text = (await page.getByTestId(`segment-${one}`).textContent()) ?? "";
      return Number(/\((\d+)\)/.exec(text)?.[1] ?? 0);
    }),
  );
  expect(counts.reduce((sum, one) => sum + one, 0)).toBe(BATCH_COUNTS.total);
});

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
  // `modifiers` option and TypeScript does not catch it (#48 found that by
  // watching a refusal pass while its sibling failed).
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

test("a draft batch cannot mark anything skipped, and says why", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent, { state: "draft" });

  await page.getByTestId("select-asset-0").click();
  // `job_id` is null exactly while the batch is a draft, because a draft has no
  // jobs — so there is nothing to move progress on, and sending anything would
  // be fifty 404s.
  await expect(page.getByTestId("bulk-skip")).toBeDisabled();
  await expect(page.getByTestId("bulk-unavailable")).toBeVisible();
});

// --- the timeline ------------------------------------------------------------

test("clicking a timeline cell brings that frame into view", async ({ page }) => {
  const sent: Request[] = [];
  await openGallery(page, sent);

  // Narrow enough that the grid is one column and eight frames do not fit on
  // screen at once, so "scrolled into view" is a claim with content.
  await page.setViewportSize({ width: 520, height: 600 });
  await page.getByTestId("density").fill("4");

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
