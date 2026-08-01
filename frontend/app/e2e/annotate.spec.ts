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

function asset(index: number, progress: string): Record<string, unknown> {
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
    job_id: JOB,
    progress,
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

async function serveApi(
  page: Page,
  sent: Request[],
  progress: Map<string, string> = progressStore({ "asset-1": "unannotated", "asset-2": "annotated" }),
): Promise<void> {
  const stored: Record<string, unknown>[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");

    // Answered before anything is recorded: every page load asks whether this
    // server will sign the browser in by itself (#179), and here it will not —
    // this suite is about the annotation page, and it reaches it with a token.
    if (path === "/session") return route.fulfill({ json: { issued: false } });

    sent.push(request);

    if (path === `/jobs/${JOB}`) {
      return route.fulfill({
        json: { id: JOB, batch_id: BATCH, state: "in_progress", asset_count: 2 },
      });
    }
    if (path === `/batches/${BATCH}`) {
      return route.fulfill({
        json: {
          id: BATCH,
          project_id: PROJECT,
          name: "drive-01",
          state: "in_annotation",
          schema_version: 3,
          asset_count: 2,
          progress: {
            unannotated: 2,
            annotated: 0,
            skipped: 0,
            review_pending: 0,
            accepted: 0,
            total: 2,
          },
        },
      });
    }
    if (path.endsWith("/schema/versions/3")) return route.fulfill({ json: SCHEMA });
    if (path.endsWith("/assets") && path.startsWith("/batches")) {
      return route.fulfill({
        json: {
          items: [
            asset(1, progress.get("asset-1") ?? "unannotated"),
            asset(2, progress.get("asset-2") ?? "annotated"),
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
      return route.fulfill({ status: 200, json: {} });
    }
    if (path.endsWith("/content")) {
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    }
    if (path === "/projects") return route.fulfill({ json: { items: [], total: 0 } });
    return route.fulfill({ status: 500, json: { code: "NO_STUB", message: path } });
  });
}

async function openJob(page: Page, sent: Request[], progress?: Map<string, string>): Promise<void> {
  await serveApi(page, sent, progress);
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

test("Accept is offered only where the kernel's machine allows the move", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // Asset 1 is `unannotated`: `accepted` is not reachable from there, so offering
  // it would be offering a refusal.
  await expect(page.getByTestId("accept")).toBeDisabled();

  await page.getByTestId("next-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  // Asset 2 is `annotated`, which is where the move is legal.
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
  await expect(page.getByTestId("asset-progress")).toHaveText("Skipped");

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
  await expect(page.getByTestId("asset-progress")).toHaveText("Unannotated");
  await expect(page.getByTestId("skip")).toBeVisible();
  await expect(page.getByTestId("accept")).toBeDisabled();
});

test("annotating a skipped asset saves, and the page says why the counter did not move", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "skipped", "asset-2": "annotated" }));

  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();

  await page.getByTestId("save").click();
  await expect.poll(() => sent.filter((r) => r.method() === "POST").length).toBeGreaterThan(0);

  // The save really happened — this was never the broken half.
  await expect(page.getByTestId("save-state")).toContainText("Saved");
  // What was broken is that nothing said why the asset is still skipped and the
  // counter did not move. Now the page does, and the way out is one click away.
  await expect(page.getByTestId("asset-progress")).toHaveText("Skipped");
  await expect(page.getByTestId("skipped-notice")).toBeVisible();
  await expect(page.getByTestId("unskip")).toBeVisible();
});

/** The reserved slots, drawn so the bar is the shape the design shows. */
test("the versioning controls are present and disabled, not absent", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);
  await expect(page.getByTestId("version-select")).toBeDisabled();
  await expect(page.getByTestId("merge")).toBeDisabled();
});
