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

  await page.getByTestId("rail-collapse").click();
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "true");

  // Full-bleed → padded, by a client-side navigation. A reload would remount
  // everything and prove nothing about the route tree.
  await page.getByTestId("rail-projects").click();
  await expect(page.locator("main .max-w-7xl")).toBeVisible();
  await expect(page.getByTestId("annotation-page")).toHaveCount(0);
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "true");

  // …and back the other way.
  await page.goBack();
  await expect(page.getByTestId("annotation-page")).toBeVisible();
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "true");
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
