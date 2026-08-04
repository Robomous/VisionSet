/**
 * The annotation page, against a stubbed API.
 *
 * `#59` drives the whole cycle against a **real server**; this suite is narrower and
 * earlier: it asserts the page's own contract — what it reads, what a save sends,
 * and what the top bar does — with the API held still, so a failure names the page
 * rather than the stack under it.
 *
 * Everything is routed under `/api/`, which is where the app sends requests in
 * development. Routing the bare paths would also intercept the *document*
 * navigation, and the failure reads as "the shell disappeared" — #53 learned that
 * one the slow way.
 */

import { expect, test, type Page, type Request } from "@playwright/test";
import { assetActions, batchActions, jobActions } from "./_wire";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

const SCHEMA = {
  project_id: PROJECT,
  version: 3,
  classes: [
    { name: "vehicle", geometry: "bbox", color: "#38bdf8", attributes: [] },
    { name: "lane", geometry: "polygon", color: "#f97316", attributes: [] },
  ],
};

function asset(
  index: number,
  progress: string,
  batchState = "in_annotation",
): Record<string, unknown> {
  return {
    id: `asset-${index}`,
    project_id: PROJECT,
    modality: "image",
    content_hash: `${index}`.repeat(8) + "abcdef",
    width: 640,
    height: 480,
    format: "png",
    source_id: null,
    frame_index: index,
    frame_timestamp: null,
    thumbnail_hash: null,
    ingested_at: null,
    job_id: JOB,
    progress,
    // Threaded from the batch, because that is what the server does:
    // `asset_actions` returns `[]` for every frame of a batch that is not
    // `in_annotation`, whatever the frame's own progress is. Without it a mock
    // would declare `annotate` on a completed batch and the read-only mode this
    // suite is about would never be exercised.
    allowed_actions: assetActions(progress, { batchState }),
  };
}

/** A 1x1 PNG, so the canvas has real pixels to lay out. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The stub's progress, which a `PUT` actually moves.
 *
 * Every other piece of this stub is static, and that is right for a suite about
 * what the page *sends*. Progress is the exception because #187 is a claim about
 * what the page *shows afterwards*: a `PUT` the server accepts and a listing that
 * keeps answering the old value is exactly the state the defect looked like from
 * the user's side, and a static stub would reproduce the bug rather than the fix.
 */
function progressStore(seed: Readonly<Record<string, string>>): Map<string, string> {
  return new Map(Object.entries(seed));
}

/**
 * The lifecycle half of the stub (#299): batch and job state that the two `start`
 * POSTs actually move, on `progressStore`'s reasoning. The default is everything
 * already open, which is what every scenario before #299 entered with; the
 * approved-batch scenarios are claims about the moves the page itself makes on
 * open, and a stub whose state never moved would reproduce the bug rather than
 * the fix.
 */
interface Lifecycle {
  batch: string;
  job: string;
  /** When set, `POST /batches/{id}/start` refuses 409 with this code instead. */
  refuseBatchStart?: string;
}

function openedWorld(): Lifecycle {
  return { batch: "in_annotation", job: "in_progress" };
}

async function serveApi(
  page: Page,
  sent: Request[],
  progress: Map<string, string> = progressStore({ "asset-1": "unannotated", "asset-2": "annotated" }),
  lifecycle: Lifecycle = openedWorld(),
): Promise<void> {
  const stored: Record<string, unknown>[] = [];
  const batchBody = (): Record<string, unknown> => ({
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state: lifecycle.batch,
    schema_version: 3,
    asset_count: 2,
    allowed_actions: batchActions(lifecycle.batch),
    progress: {
      unannotated: 2,
      annotated: 0,
      skipped: 0,
      review_pending: 0,
      accepted: 0,
      total: 2,
    },
  });
  const jobBody = (): Record<string, unknown> => ({
    id: JOB,
    batch_id: BATCH,
    state: lifecycle.job,
    asset_count: 2,
    allowed_actions: jobActions(lifecycle.job, { batchState: lifecycle.batch }),
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");

    // Answered before anything is recorded: every page load asks whether this
    // server will sign the browser in by itself (#179), and here it will not —
    // this suite is about the annotation page, and it reaches it with a token.
    if (path === "/session") return route.fulfill({ json: { issued: false } });

    sent.push(request);

    if (path === `/jobs/${JOB}/start` && request.method() === "POST") {
      lifecycle.job = "in_progress";
      return route.fulfill({ json: jobBody() });
    }
    if (path === `/jobs/${JOB}`) {
      return route.fulfill({ json: jobBody() });
    }
    if (path === `/batches/${BATCH}/start` && request.method() === "POST") {
      if (lifecycle.refuseBatchStart !== undefined) {
        return route.fulfill({
          status: 409,
          json: { code: lifecycle.refuseBatchStart, message: "the stub refuses" },
        });
      }
      lifecycle.batch = "in_annotation";
      return route.fulfill({ json: batchBody() });
    }
    if (path === `/batches/${BATCH}`) {
      return route.fulfill({ json: batchBody() });
    }
    if (path.endsWith("/schema/versions/3")) return route.fulfill({ json: SCHEMA });
    if (path.endsWith("/assets") && path.startsWith("/batches")) {
      return route.fulfill({
        json: {
          items: [
            asset(1, progress.get("asset-1") ?? "unannotated", lifecycle.batch),
            asset(2, progress.get("asset-2") ?? "annotated", lifecycle.batch),
          ],
          total: 2,
        },
      });
    }
    if (path.endsWith("/annotations") && request.method() === "GET") {
      return route.fulfill({ json: { items: stored, total: stored.length } });
    }
    if (path.endsWith("/annotations") && request.method() === "POST") {
      // Kept, and stamped with a server id — the kernel mints its own and the page
      // refetches to learn them (`jobQueries.ts`). A stub that answered an empty
      // list would leave the page permanently dirty and "Saved" unreachable, which
      // says nothing about the product.
      const body = JSON.parse(request.postData() ?? "[]") as Record<string, unknown>[];
      body.forEach((one, at) =>
        stored.push({
          ...one,
          id: `server-${stored.length + at}`,
          asset_id: "asset-1",
          schema_version: 3,
          attributes: {},
          provenance: "human",
          model_ref: null,
          confidence: null,
        }),
      );
      return route.fulfill({ status: 201, json: { items: stored, total: stored.length } });
    }
    if (path.endsWith("/progress") && request.method() === "GET") {
      return route.fulfill({
        json: {
          unannotated: 2,
          annotated: 0,
          skipped: 0,
          review_pending: 0,
          accepted: 0,
          total: 2,
        },
      });
    }
    if (path.endsWith("/progress") && request.method() === "PUT") {
      const assetId = path.split("/").at(-2) ?? "";
      const body = JSON.parse(request.postData() ?? "{}") as { progress?: string };
      if (body.progress !== undefined) progress.set(assetId, body.progress);
      // `AssetProgressOut`, not `{}`. The route answers where the asset now is, and a
      // stub that answered an empty object was describing a response the endpoint has
      // never sent — the exact habit #225 makes impossible.
      return route.fulfill({
        status: 200,
        json: { asset_id: assetId, progress: progress.get(assetId) ?? "unannotated" },
      });
    }
    if (path.endsWith("/content")) {
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    }
    if (path === "/projects") return route.fulfill({ json: { items: [], total: 0 } });
    return route.fulfill({ status: 500, json: { code: "NO_STUB", message: path } });
  });
}

async function openJob(
  page: Page,
  sent: Request[],
  progress?: Map<string, string>,
  lifecycle?: Lifecycle,
): Promise<void> {
  await serveApi(page, sent, progress, lifecycle);
  await page.goto(`/jobs/${JOB}`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("annotation-page")).toBeVisible();
}

test("the page loads the job's assets, its pinned schema and its progress", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await expect(page.getByTestId("asset-position")).toContainText("1/2");
  await expect(page.getByTestId("job-progress")).toHaveText("0 / 2 annotated");

  // The **pinned** version, not the project's active schema. A batch pins at
  // approval and never moves, so asking for the active one is asking a different
  // question — and the answer would offer classes the API then refuses.
  const paths = sent.map((r) => new URL(r.url()).pathname);
  expect(paths.some((p) => p.endsWith("/schema/versions/3"))).toBe(true);
  expect(paths.some((p) => p.endsWith("/schema"))).toBe(false);

  // …and the asset's pixels came through the client, not an <img src>: every route
  // but /health needs `Authorization: Bearer`, which an <img> cannot send.
  const content = sent.find((r) => r.url().endsWith("/content"));
  expect(await content?.headerValue("authorization")).toBe("Bearer a-token");
});

test("Save is inert until something changes, then sends exactly the new annotation", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await expect(page.getByTestId("save")).toBeDisabled();
  await expect(page.getByTestId("save-state")).toContainText("Saved");

  // Draw one box: digit 1 is `vehicle`, the pinned schema's first class.
  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByTestId("save-state")).toContainText("unsaved");
  await expect(page.getByTestId("object-total")).toHaveText("1 object");

  await page.getByTestId("save").click();
  await expect.poll(() => sent.filter((r) => r.method() === "POST").length).toBeGreaterThan(0);

  const post = sent.find((r) => r.method() === "POST" && r.url().endsWith("/annotations"));
  const body = JSON.parse(post?.postData() ?? "[]") as Record<string, unknown>[];
  expect(body).toHaveLength(1);
  expect(body[0]["label_class"]).toBe("vehicle");
  // `toAnnotationCreate` drops the client-minted id and the provisional schema
  // version: the kernel mints one and stamps the other.
  expect(body[0]["id"]).toBeUndefined();
  expect(body[0]["schema_version"]).toBeUndefined();

  // Only creates — nothing was updated or deleted, so nothing else was sent.
  expect(sent.filter((r) => r.method() === "PATCH")).toHaveLength(0);
  expect(sent.filter((r) => r.method() === "DELETE")).toHaveLength(0);
});

/** The two opening moves this page sends, in the order they were sent. */
function startsSent(sent: Request[]): string[] {
  return sent
    .filter((request) => request.method() === "POST" && request.url().endsWith("/start"))
    .map((request) => new URL(request.url()).pathname.replace(/^\/api/, ""));
}

/**
 * #299. The workspace routes into the annotator from an *approved* batch — the
 * gallery's `Start annotating`, every tile, a pasted URL — and nothing on that
 * path pressed the batch table's own `Start`. So the page makes both opening
 * moves itself, in their one legal order. Before this, the job start was refused
 * `BATCH_NOT_IN_ANNOTATION` silently and the first Save answered the raw code.
 */
test("opening a job in an approved batch starts the batch, then the job, and a save lands", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, { batch: "approved", job: "pending" });

  await expect.poll(() => startsSent(sent)).toEqual([
    `/batches/${BATCH}/start`,
    `/jobs/${JOB}/start`,
  ]);

  // …and the page is actually usable afterwards: draw one box, save, and the
  // bar answers Saved rather than a code — the exact gesture the defect refused.
  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-state")).toContainText("Saved");
});

test("a refused opening move is sent once, never looped, and its code is on the bar", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, {
    batch: "approved",
    job: "pending",
    refuseBatchStart: "BATCH_NOT_IN_ANNOTATION",
  });

  // The move was attempted and refused…
  await expect.poll(() => startsSent(sent)).toEqual([`/batches/${BATCH}/start`]);

  // …and the refusal surfaces where the save-state lives, before anybody has
  // saved — the page must never look inert about a batch it could not open.
  await expect(page.getByTestId("save-state")).toContainText("BATCH_NOT_IN_ANNOTATION");

  // Force a run of re-renders, then look at the wire. The old effect's bail flags
  // were all false again after a refusal, so every one of these renders re-sent
  // the refused POST.
  //
  // **This used to force them by drawing a box, and cannot any more**: a batch
  // whose start was refused is still `approved`, so its frames declare no
  // `annotate` and the canvas is read-only — which is the point of F2 and is a
  // strictly better answer than a page that draws work it can never save. The
  // zoom is the re-render that survives read-only, because it moves the
  // viewport and not the document, and `onViewChange` fires on every notch.
  const zoomIn = page.getByTestId("zoom-in");
  for (let notch = 0; notch < 8; notch += 1) await zoomIn.click();
  // The renders really happened, and the bar keeps the refusal.
  await expect(page.getByTestId("zoom-readout")).not.toHaveText("100%");
  await expect(page.getByTestId("save-state")).toContainText("BATCH_NOT_IN_ANNOTATION");

  // Once — and the job's own start never fired at all, because the batch never
  // reached `in_annotation` for it to be legal in.
  expect(startsSent(sent)).toEqual([`/batches/${BATCH}/start`]);
});

test("Accept is offered only where the kernel's machine allows the move", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "annotated", "asset-2": "review_pending" }));

  // **Asset 1 is `annotated`, and this used to assert Accept was enabled here.**
  // It is not a legal move: `ASSET_PROGRESS_TRANSITIONS` gives `annotated` three
  // exits — `unannotated`, `skipped`, `review_pending` — and `accepted` is not
  // among them. The button was offering a refusal, and the refusal was one of the
  // silent ones (F3), so pressing it did nothing at all and said nothing about it.
  //
  // The gate is the wire's `allowed_actions` now, which the kernel derives from
  // that same table, so this cannot be got wrong again by reading the table twice.
  await expect(page.getByTestId("accept")).toBeDisabled();

  await page.getByTestId("next-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  // Asset 2 is `review_pending`, which is the one state `accepted` is reachable
  // from — the reviewer's half of the machine.
  await expect(page.getByTestId("accept")).toBeEnabled();
});

test("the zoom buttons drive the same stage mod+0 resets", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const readout = page.getByTestId("zoom-readout");
  // Waited for, not read: `onViewChange` fires in an effect after mount, so the
  // readout is `—` until the fit is announced. Reading it straight away passes on a
  // quiet machine and fails under load, which is what this scenario did once.
  await expect(readout).toHaveText(/%$/);
  const fitted = (await readout.textContent()) ?? "";

  await page.getByTestId("zoom-in").click();
  await expect(readout).not.toHaveText(fitted);

  await page.getByTestId("fit").click();
  await expect(readout).toHaveText(fitted);

  // …and the chord reaches the same implementation, which is why `mod+0` stays
  // intercepted by the adapter rather than forwarded to the host.
  await page.getByTestId("zoom-in").click();
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("ControlOrMeta+0");
  await expect(readout).toHaveText(fitted);
});

test("Skip settles the asset and advances", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await page.getByTestId("skip").click();
  await expect.poll(() => sent.filter((r) => r.method() === "PUT").length).toBeGreaterThan(0);

  const put = sent.find((r) => r.method() === "PUT");
  expect(JSON.parse(put?.postData() ?? "{}")).toEqual({ progress: "skipped" });
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
});

/**
 * #187: a skipped asset used to be a dead end.
 *
 * The kernel is right and was never the problem — `progress_after_annotating`
 * moves an asset only between `unannotated` and `annotated`, because `skipped` is
 * a person's decision and drawing a box does not contradict a decision. What was
 * missing is the door the kernel names: `ASSET_PROGRESS_TRANSITIONS` allows
 * exactly one exit from `skipped`, and nothing in the browser took it. So a user
 * could label a skipped asset, watch `Save` succeed, and lose the work at
 * promotion — `PROMOTABLE_PROGRESS` excludes `skipped`.
 */
test("a skipped asset says so, and the page offers the kernel's one way out", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "skipped", "asset-2": "annotated" }));

  // 1. It says so — visibly, not by the absence of something.
  await expect(page.getByTestId("asset-progress")).toHaveText("skipped");

  // 2. …and the way back is offered where the decision was made, in place of Skip.
  await expect(page.getByTestId("skip")).toHaveCount(0);
  await page.getByTestId("unskip").click();

  await expect.poll(() => sent.filter((r) => r.method() === "PUT").length).toBeGreaterThan(0);
  const put = sent.find((r) => r.method() === "PUT");
  // Spelled the way the kernel spells it. `skipped -> unannotated` is the only
  // edge out; anything else would be asking for a refusal.
  expect(JSON.parse(put?.postData() ?? "{}")).toEqual({ progress: "unannotated" });

  // 3. Reversing a decision is about *this* asset, so it does not advance the way
  //    settling one does — the user came back here to work on it.
  await expect(page.getByTestId("asset-position")).toContainText("1/2");

  // 4. …and the page reflects what actually changed: Skip is offered again, and
  //    `Accept` stays disabled because `unannotated` is not where that move is
  //    legal. The gate is the kernel's and is not loosened to paper over this.
  await expect(page.getByTestId("asset-progress")).toHaveText("unannotated");
  await expect(page.getByTestId("skip")).toBeVisible();
  await expect(page.getByTestId("accept")).toBeDisabled();
});

test("a skipped asset cannot be drawn on at all, and the page says how to get it back", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "skipped", "asset-2": "annotated" }));

  // **This scenario used to assert the opposite — that drawing on a skipped frame
  // saved.** It did, and that was the hole: `PROMOTABLE_PROGRESS` excludes
  // `skipped`, so the labels were stored and then dropped at promotion, with
  // every layer agreeing because each half was separately valid. #304 closed it
  // in the kernel (`WRITABLE_PROGRESS`, 409 `ASSET_NOT_WRITABLE`); this closes it
  // in the browser, so the work is never drawn rather than drawn and refused.
  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();

  // Nothing was drawn, so there is nothing to save and no request to send. That
  // is the guarantee `readOnly` on the canvas exists for: a host that only greyed
  // out the Save would still have a box on the screen and no way to keep it.
  await expect(page.getByTestId("object-total")).toHaveText("0 objects");
  await expect(page.getByTestId("save")).toBeDisabled();
  expect(sent.filter((r) => r.method() === "POST" && r.url().includes("/annotations"))).toEqual([]);

  // And the way back is one click, on the same bar.
  await expect(page.getByTestId("asset-progress")).toHaveText("skipped");
  await expect(page.getByTestId("skipped-notice")).toBeVisible();
  await expect(page.getByTestId("unskip")).toBeEnabled();
});

/**
 * Read-only mode, which did not exist — audit finding F2.
 *
 * The batch is `completed`, so the kernel declares nothing on any of its frames
 * and every write it could send would answer 409. What shipped instead was a
 * fully live editor: the canvas drew, the palette armed tools, the panel deleted
 * objects, and the first Save rendered `BATCH_NOT_IN_ANNOTATION` as a raw badge —
 * with navigation blocked while dirty, because `go()` commits first. The only way
 * out was to undo your own work.
 */
test("a completed batch opens as a viewer, and says so", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, { batch: "completed", job: "completed" });

  const banner = page.getByTestId("readonly-banner");
  await expect(banner).toBeVisible();
  // Prose with a route onward, not a code. The forward-only correction model is
  // the answer to "then how do I fix this frame".
  await expect(banner).toContainText(/viewing only/i);
  await expect(banner).toContainText(/correction batch/i);

  // Every control that writes is out, and the palette is gone entirely — a tool
  // palette over a canvas that cannot be drawn on explains nothing.
  await expect(page.getByTestId("save")).toBeDisabled();
  await expect(page.getByTestId("skip")).toBeDisabled();
  await expect(page.getByTestId("accept")).toBeDisabled();
  await expect(page.getByTestId("tool-palette")).toHaveCount(0);
});

test("a completed batch's canvas cannot be drawn on, however hard it is asked", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, { batch: "completed", job: "completed" });

  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  // A class hotkey, then a full drag — the exact gesture that draws a box.
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();

  // The claim, and the reason `readOnly` is a prop on the engine rather than a
  // convention in the host: pointer input goes straight into the machine, so a
  // greyed-out toolbar would not have stopped this.
  await expect(page.getByTestId("object-total")).toHaveText("0 objects");
  await expect(page.getByTestId("save")).toBeDisabled();
  expect(sent.filter((r) => r.method() === "POST" && r.url().includes("/annotations"))).toEqual([]);
});

test("a viewer can still navigate between frames, because a read-only mode you cannot move in is a screenshot", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, { batch: "completed", job: "completed" });

  await expect(page.getByTestId("asset-position")).toContainText("1/2");
  await page.getByTestId("next-asset").click();
  // Never blocked: nothing can be dirty, so `go()`'s commit-first is a no-op
  // rather than a save that rejects and swallows the navigation with it.
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  await page.getByTestId("prev-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("1/2");
});

/** The reserved slots, drawn so the bar is the shape the design shows. */
test("the versioning controls are present and disabled, not absent", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);
  await expect(page.getByTestId("version-select")).toBeDisabled();
  await expect(page.getByTestId("merge")).toBeDisabled();
});

/**
 * #183: the annotation page owns the viewport.
 *
 * Every other route in the product is a list or a form, and the shell's padded,
 * `max-w-7xl` container is right for those. The annotator is the one screen
 * somebody sits in front of for an hour, and boxing it costs more than looks:
 * `fitToViewport` derives the zoom from `getBoundingClientRect` on the pane, so a
 * pane the shell has shrunk means every asset opens smaller than it needs to and
 * the tolerance constants — all in *screen* pixels, divided by zoom — are applied
 * at a zoom nobody chose.
 */

/** Viewport width minus the rail, which is what the page is entitled to. */
async function paneWidth(page: Page): Promise<number> {
  const rail = await page.getByTestId("app-rail").boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  return width - (rail?.width ?? 0);
}

test("the annotation page fills the viewport beside the rail, with no cap and no padding", async ({
  page,
}) => {
  // Wider than `max-w-7xl` (1280px), so the cap is a real constraint rather than
  // one that happens not to bite. At the suite's default 1440 the content area is
  // 1200 and the cap never engages — which is exactly how this defect survived.
  await page.setViewportSize({ width: 1800, height: 900 });

  const sent: Request[] = [];
  await openJob(page, sent);

  const box = await page.getByTestId("annotation-page").boundingBox();
  expect(box).not.toBeNull();
  // No gutters: the page is everything to the right of the rail.
  expect(box!.width).toBeCloseTo(await paneWidth(page), 0);
  // No padding above the top bar either.
  expect(box!.y).toBe(0);
  expect(box!.height).toBe(900);
});

test("nothing on the annotation page scrolls the document", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // `h-screen` inside a `py-6` container made the document 948px tall in a 900px
  // window, so the canvas's own badge was cut off and the whole page scrolled.
  const scrolls = await page.evaluate(() => ({
    vertical: document.documentElement.scrollHeight > window.innerHeight,
    horizontal: document.documentElement.scrollWidth > window.innerWidth,
  }));
  expect(scrolls).toEqual({ vertical: false, horizontal: false });

  // The badge pinned to the bottom-left of the canvas pane is on screen, which is
  // the symptom a user actually reported.
  const badge = await page.getByTestId("object-total").boundingBox();
  expect(badge).not.toBeNull();
  expect(badge!.y + badge!.height).toBeLessThanOrEqual(900);
});

test("collapsing the rail reflows the annotation page to the new width", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // Expanded first: a fresh session starts collapsed (#200), and this scenario is
  // about what collapsing gives back. Measuring from the default would measure
  // the same 180px in the other direction and read as the page shrinking.
  await page.getByTestId("rail-collapse").click();
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "false");

  const before = (await page.getByTestId("annotation-page").boundingBox())!;
  await page.getByTestId("rail-collapse").click();
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "true");

  const after = (await page.getByTestId("annotation-page").boundingBox())!;
  // The whole 180px the rail gave back — 240px expanded, 60px collapsed, the
  // tokens three things have to agree on.
  //
  // Before the fix this was **128**, which is the defect stating itself: at 1440
  // the expanded pane is 1200 and `max-w-7xl` never engages, but collapsing frees
  // enough width for the cap to start biting, so the page grew by less than the
  // rail released and the difference went into gutters.
  expect(after.width - before.width).toBeCloseTo(180, 0);
  expect(after.width).toBeCloseTo(await paneWidth(page), 0);
});

test("every other route keeps the padded, capped container", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });

  const sent: Request[] = [];
  await serveApi(page, sent);
  await page.goto("/projects");
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  const main = page.locator("main");
  await expect(main).toBeVisible();
  const box = (await main.boundingBox())!;
  const inner = (await main.locator("> div").first().boundingBox())!;

  // The pane is still the full width beside the rail…
  expect(box.width).toBeCloseTo(await paneWidth(page), 0);
  // …and the *content* inside it is capped at 7xl and inset on both axes, which
  // is right for a list and is what must not move. Measured against the pane's
  // own origin, because the padding lives inside `<main>` rather than above it.
  expect(inner.width).toBeLessThanOrEqual(1280);
  expect(inner.x - box.x).toBeGreaterThan(0);
  expect(inner.y - box.y).toBeGreaterThan(0);
});

/**
 * The rail is continuous across the two panes, whatever the route tree looks like.
 *
 * Splitting a shell into two layout routes is the kind of change that quietly
 * costs local state, and #183 introduced exactly that shape. This asserts the
 * property rather than the structure — deliberately, because the structure turns
 * out not to decide it: two sibling `<Route element={<AppShell />}>` branches are
 * reconciled into one instance and preserve the state too. What must not regress
 * is the user-visible half, and that is what is written down here.
 */
test("the rail keeps its collapsed state when the pane changes", async ({ page }) => {
  const sent: Request[] = [];
  // Start inside the **full-bleed** pane, so both crossings below are real.
  await openJob(page, sent);

  // Expanded, which since #200 is the state that is *not* the default — so what
  // survives the crossing below is a choice somebody made rather than the value
  // a freshly mounted shell would have produced anyway. That makes this a
  // stricter scenario than it was, not a looser one.
  await page.getByTestId("rail-collapse").click();
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "false");

  // Full-bleed → padded, by a client-side navigation. A reload would remount
  // everything and prove nothing about the route tree.
  await page.getByTestId("rail-projects").click();
  await expect(page.locator("main .max-w-7xl")).toBeVisible();
  await expect(page.getByTestId("annotation-page")).toHaveCount(0);
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "false");

  // …and back the other way.
  await page.goBack();
  await expect(page.getByTestId("annotation-page")).toBeVisible();
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "false");
});

/**
 * #189: `?` used to be *claimed* rather than absent.
 *
 * The page passed `onHostAction={(name) => name === TOGGLE_HELP}`. Returning
 * `true` means **the host handled this action**, so pressing `?` — a real binding
 * in `core/input/bindings.ts` — was consumed and then discarded. The user got
 * nothing, and the engine had been told the request was served, so nothing else
 * could pick it up.
 */
test("? opens the shortcut sheet, and ? closes it again", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();

  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
});

test("Escape closes the shortcut sheet", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
});

test("the sheet lists the engine's own bindings, and the schema's class hotkeys", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("?");
  const sheet = page.getByTestId("shortcut-sheet");
  await expect(sheet).toBeVisible();

  // Engine rows, addressed by the chord they were registered under — which is
  // what makes this a claim about the registry rather than about this markup.
  for (const chord of ["escape", "enter", "delete", "backspace", "mod+z", "mod+shift+z", "mod+a", "mod+0", "?", "v"]) {
    await expect(sheet.locator(`[data-chord="${chord}"]`)).toHaveCount(1);
  }

  // …and the class hotkeys are the *pinned schema's* two classes, in authored
  // order, with no third digit invented.
  const classes = sheet.getByTestId("shortcut-class-rows");
  await expect(classes.locator("[data-chord]")).toHaveCount(2);
  await expect(classes.locator('[data-chord="1"]')).toContainText("vehicle");
  await expect(classes.locator('[data-chord="2"]')).toContainText("lane");

  // The chords deliberately left to the browser are stated rather than omitted.
  await expect(sheet.getByTestId("shortcut-unbound")).toContainText("C");
  await expect(sheet.getByTestId("shortcut-unbound")).toContainText("V");
});

/**
 * #185: the surround was the rail's near-black navy.
 *
 * The canvas pane was `bg-sidebar-strong` (`#111827`) — the only dark surface in
 * the product outside the rail, so the page read as a different application. It
 * also cost accuracy rather than only looks: a dark surround shifts the perceived
 * contrast and colour of the photograph inside it, on a tool whose whole job is
 * looking closely at pixels.
 */

/** `rgb(r, g, b)` as three numbers, so a colour can be reasoned about. */
function channels(colour: string): readonly number[] {
  return (colour.match(/\d+/g) ?? []).slice(0, 3).map(Number);
}

test("the canvas surround is a light neutral, not the rail's dark chrome", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const stage = await page
    .getByTestId("canvas-stage")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  const rail = await page
    .getByTestId("app-rail")
    .evaluate((node) => getComputedStyle(node).backgroundColor);

  // Light: every channel well above the midpoint. `#111827` fails all three.
  expect(channels(stage).every((value) => value > 200)).toBe(true);
  // Neutral: no channel dominates, so the picture is judged against grey.
  expect(Math.max(...channels(stage)) - Math.min(...channels(stage))).toBeLessThan(24);
  // …and it is emphatically not the rail's treatment, which stays dark.
  expect(stage).not.toBe(rail);
  expect(channels(rail).every((value) => value < 80)).toBe(true);
});

/**
 * A guard on the *new* value rather than a regression test — the dark surround
 * passed this one, being obviously distinguishable from white.
 *
 * What it rejects is the tempting wrong fix: reaching for an existing surface
 * token. `background` and `card` are `#ffffff`, and `muted` is `#f6f8fa`, whose
 * closest channel is five short of white — so an asset with white borders would
 * bleed into its own surround. Measured against a minimum gap of ten, which
 * `muted` fails and `stage` (`#e1e6eb`, gap 20) clears.
 */
test("the surround is distinguishable from the page and from a white image edge", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const [stage, body] = await Promise.all([
    page.getByTestId("canvas-stage").evaluate((node) => getComputedStyle(node).backgroundColor),
    page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ]);

  // The asset is drawn on white in this stub, and the page behind it is white
  // too. A surround equal to either would hide where the picture ends.
  expect(stage).not.toBe(body);
  const gap = Math.min(...channels(body).map((value, at) => value - channels(stage)[at]));
  expect(gap).toBeGreaterThanOrEqual(10);
});

/**
 * The third acceptance criterion, and also a guard rather than a regression test:
 * a dark surround passed it too. It fails if a later change makes the stage equal
 * to `muted`, which is what the badge is filled with.
 */
test("what is drawn on the surround stays legible against it", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const stage = await page
    .getByTestId("canvas-stage")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  const badge = await page
    .getByTestId("object-total")
    .evaluate((node) => getComputedStyle(node).backgroundColor);

  // The `0 objects` badge is pinned to the pane's bottom-left and sits directly
  // on the surround — the one piece of chrome that does.
  expect(badge).not.toBe(stage);
});

/**
 * #188: the space between a tab bar and its content was applied twice.
 *
 * `AnnotatorPanel` was a `flex flex-col gap-3` and `TabsContent` carries its own
 * `mt-3`. A flex gap and the child's margin add, so the tabs floated 24px above
 * the content they switch — about twice what the rhythm asks for.
 *
 * The rule is now that **the primitive owns it**: `TabsContent`'s margin is the
 * one declaration, and a consumer adds no gap of its own. That direction rather
 * than the other because it makes the primitive self-sufficient — a `Tabs` that
 * is not a flex column at all still spaces correctly, and a consumer cannot
 * forget something it never had to know.
 */

/** The measured distance between the tab bar and the panel below it, in pixels. */
async function tabGap(page: Page, root: string): Promise<number> {
  const scope = page.getByTestId(root);
  const list = await scope.locator('[role="tablist"]').boundingBox();
  // The active one: Radix keeps every panel mounted and hides the rest, so an
  // unscoped selector resolves to all of them.
  const panel = await scope.locator('[role="tabpanel"][data-state="active"]').boundingBox();
  if (list === null || panel === null) throw new Error(`no tablist/tabpanel under ${root}`);
  return panel.y - (list.y + list.height);
}

test("the annotator panel's tabs sit one rhythm step above their content", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // `mt-3` — 0.75rem at the 14px base, so 12px. Measured rather than asserted
  // against a class string, because the defect was two rules adding up and a
  // class assertion would have seen both of them and been satisfied.
  expect(await tabGap(page, "annotator-panel")).toBeCloseTo(12, 0);
});

test("the project view's tabs use the same one rule", async ({ page }) => {
  const sent: Request[] = [];
  await serveApi(page, sent);
  await page.goto(`/projects/${PROJECT}`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  // Checked at the same time as the panel, per the issue: the same doubling is
  // possible wherever a `Tabs` sits in a gapped flex column. This one was already
  // right, and asserting it is what stops a later layout tidy-up from adding a
  // gap here and rediscovering #188 on a different screen.
  await expect(page.getByTestId("project-tabs")).toBeVisible();
  expect(await tabGap(page, "project-tabs")).toBeCloseTo(12, 0);
});

/**
 * The tool palette (#198).
 *
 * The absence these cover is not "a control is missing" but "the primary gesture
 * does nothing": the page opens with no active class, `toolFor` answers `select`,
 * and a drag draws nothing. Every scenario below therefore starts from the page as
 * it opens and reaches the canvas **through the palette** — the digit row and the
 * Labels tab are already covered elsewhere and both worked while this was broken.
 */

/** The stage's rect, which is what a drag's coordinates are taken against. */
async function stageBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.getByTestId("annotator-canvas").boundingBox();
  if (box === null) throw new Error("no canvas");
  return box;
}

test("the palette is on the page as it opens, with select the tool you are in", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const palette = page.getByTestId("tool-palette");
  await expect(palette).toBeVisible();

  // The schema declares one bbox class and one polygon class, so exactly three
  // tools plus help. A tag or a `polyline` would add neither.
  await expect(page.getByTestId("tool-select")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("tool-bbox")).toHaveAttribute("data-active", "false");
  await expect(page.getByTestId("tool-polygon")).toHaveAttribute("data-active", "false");
  await expect(page.getByTestId("tool-help")).toBeVisible();
});

test("pressing the box tool and dragging draws an object, from the page as it opens", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // Nothing drawn, and — the part that was broken — no class chosen by anything
  // other than the palette below.
  await expect(page.getByTestId("object-total")).toHaveText("0 objects");

  await page.getByTestId("tool-bbox").click();
  // A palette press reaches the machine through `AnnotatorCanvas`'s `tool-changed`
  // effect, which lands a tick after the state change, so the drag waits on the
  // button's own report rather than on a timer.
  await expect(page.getByTestId("tool-bbox")).toHaveAttribute("data-active", "true");

  const box = await stageBox(page);
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByTestId("object-total")).toHaveText("1 object");
  // And it is in the Objects panel, carrying the class the box tool activated.
  await expect(page.getByTestId("object-count")).toHaveText("1 object");
  await expect(page.getByTestId("annotator-panel")).toContainText("vehicle");
});

test("pressing the polygon tool and clicking draws a polygon", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await page.getByTestId("tool-polygon").click();
  await expect(page.getByTestId("tool-polygon")).toHaveAttribute("data-active", "true");

  const box = await stageBox(page);
  const at = (fx: number, fy: number): [number, number] => [
    box.x + box.width * fx,
    box.y + box.height * fy,
  ];
  for (const [x, y] of [at(0.35, 0.3), at(0.25, 0.55), at(0.5, 0.55)]) {
    await page.mouse.click(x, y);
  }
  // Enter closes the ring — the close a keyboard can always reach, and the one
  // `drawTriangle` uses in the showcase suite.
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("object-total")).toHaveText("1 object");
  await expect(page.getByTestId("annotator-panel")).toContainText("lane");
});

test("the palette reports the tool whatever moved the class", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // The tool is derived and never stored, so the digit row and the Labels tab
  // must light the same button the palette's own press does. A palette holding
  // its own idea of the tool is the pair v1 spent two mechanisms keeping in step.
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("2");
  await expect(page.getByTestId("tool-polygon")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("tool-select")).toHaveAttribute("data-active", "false");

  await page.getByTestId("tab-labels").click();
  await page.getByTestId("label-vehicle").click();
  await expect(page.getByTestId("tool-bbox")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("tool-polygon")).toHaveAttribute("data-active", "false");
});

test("pressing a tool leaves the keyboard alive", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // The claim: the palette refuses the focus a `mousedown` would otherwise take.
  // If it did not, every chord would be dead until the user clicked back on the
  // picture — and the failure is silent, which is how #47 found the same class of
  // bug from the other direction.
  await page.getByTestId("annotator-root").focus();
  await page.getByTestId("tool-bbox").click();

  await page.keyboard.press("2");
  await expect(page.getByTestId("tool-polygon")).toHaveAttribute("data-active", "true");
});

test("the palette's help entry opens the shortcut sheet", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
  await page.getByTestId("tool-help").click();
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
});
