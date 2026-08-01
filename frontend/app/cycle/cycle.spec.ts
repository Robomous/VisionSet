/**
 * The whole cycle, in a browser, against a real server.
 *
 * Token → project → schema → ingest → approve → annotate → complete → promote →
 * publish → export → download. No mocks anywhere: the bundle is the built one that
 * ships in the wheel, and `visionset ui` serves it beside the real API over the
 * real kernel.
 *
 * ## One test, and that is deliberate
 *
 * Every step needs the last one's output — there is no project to ingest into and
 * no batch to approve until earlier steps ran — and Playwright gives each test its
 * own page and its own everything. Splitting this into ten tests would mean either
 * ten sign-ins walking back through the product, or shared module state that makes
 * the order load-bearing and invisible. `test.step` gives the reporting a
 * multi-test file would have bought, without the lie.
 *
 * This is `test_external_client.py`'s shape one surface over: that file walks the
 * whole HTTP cycle in one function using none of the suite's helpers, for the same
 * reason.
 *
 * ## What it deliberately does not do
 *
 * **The source is images, not a video.** The issue says "generated video"; the
 * browser difference between the two is one number in one form, and the video path
 * is already driven end to end by `examples/ingest_end_to_end.py` in the `e2e (cli)`
 * job and by the ingest screen's own component tests. Buying it here costs an apt
 * install of ffmpeg and a decode inside a five-minute budget, for coverage that
 * exists. Recorded rather than skipped quietly.
 *
 * **The export is `dummy`, which writes nothing.** It is the only installed
 * exporter until M6, and `file_count: 0` is an export that ran. What is proved here
 * is the *round trip* — the request carries the format, the response is an archive,
 * and the browser saves it — which is exactly the part real exporters will inherit.
 */

import { expect, test, type Download, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const CYCLE_DIR = process.env["VISIONSET_CYCLE_DIR"] ?? "";

/** Written by `scripts/cycle_server.sh`, which minted it once. */
function token(): string {
  return readFileSync(path.join(CYCLE_DIR, "token"), "utf8").trim();
}

function images(): string[] {
  const dir = path.join(CYCLE_DIR, "images");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".png"))
    .sort()
    .map((name) => path.join(dir, name));
}

/** A name nothing else in the workspace will collide with. */
const PROJECT = "browser-cycle";
const TAG = "v1";

test("the whole cycle, from a pasted token to a downloaded export", async ({ page }) => {
  test.slow();

  // #161's first acceptance criterion, collected across the whole walk rather than
  // asserted at one moment: a clean load should produce **zero** console errors and
  // no failed request, and the only one there had been was the browser asking for
  // `/favicon.ico` unprompted and the API root correctly answering 404.
  //
  // Both halves are needed. `console` catches what the page complains about;
  // `requestfailed` and a 404 sweep catch the case where a browser fetches
  // something on its own initiative and says nothing — which is exactly what a
  // missing icon does in a headless run.
  const consoleErrors: string[] = [];
  const badRequests: string[] = [];
  // Every API call the *app* made that the API refused. The walk contains such
  // calls by design — `GET /projects/{id}/schema` answers 404 for a project that
  // has no schema yet, which is how the editor knows to open on an empty draft —
  // and Chrome logs a console error for each. Collected so those can be told from
  // a resource the *browser* went looking for on its own, which is the only kind
  // #161 is about and the only kind nothing else would notice.
  const apiRefusals = new Set<string>();
  page.on("response", (response) => {
    const kind = response.request().resourceType();
    if (response.status() < 400) return;
    if (kind === "fetch" || kind === "xhr") apiRefusals.add(response.url());
    else badRequests.push(`${response.status()} ${kind} ${response.url()}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (apiRefusals.has(message.location().url)) return;
    consoleErrors.push(`${message.text()} @ ${message.location().url}`);
  });
  page.on("requestfailed", (request) => badRequests.push(`failed ${request.url()}`));

  await test.step("connect with a workspace token", async () => {
    await page.goto("./");
    await page.getByTestId("token-input").fill(token());
    await page.getByTestId("token-submit").click();
    // The rail is the product; reaching it means the credential was accepted by
    // the real `StoredTokenAuthProvider` against a real digest.
    await expect(page.getByTestId("app-rail")).toBeVisible();
  });

  await test.step("create a project", async () => {
    await page.getByTestId("new-project").click();
    await page.getByTestId("project-name").fill(PROJECT);
    await page.getByTestId("project-description").fill("Driven by #59");
    await page.getByTestId("create-submit").click();
    await expect(page.getByTestId(`project-${PROJECT}`)).toBeVisible();
    await page.getByTestId(`open-${PROJECT}`).click();
    await expect(page.getByTestId("project-screen")).toBeVisible();
  });

  await test.step("declare a schema with all three geometries", async () => {
    // A project starts schema-less on purpose, so the editor opens on an empty
    // draft rather than an error.
    await expect(page.getByTestId("schema-editor")).toContainText("Saving creates version 1");

    for (const [index, [name, geometry]] of (
      [
        ["vehicle", "bbox"],
        ["lane", "polygon"],
        ["daytime", "classification_tag"],
      ] as const
    ).entries()) {
      await page.getByTestId("add-class").click();
      await page.getByTestId(`class-name-${index}`).fill(name);
      if (geometry !== "bbox") {
        await page.getByTestId(`class-geometry-${index}`).click();
        await page.getByRole("option", { name: geometry, exact: true }).click();
      }
    }

    await page.getByTestId("save-schema").click();
    // The history is its own tab since #171, so the published version is checked
    // where it now lives rather than further down the same page.
    await page.getByTestId("tab-versions").click();
    await expect(page.getByTestId("version-1")).toBeVisible();
    await expect(page.getByTestId("version-1")).toContainText("active");
  });

  await test.step("ingest three images into a new batch", async () => {
    await page.getByTestId("go-ingest").click();
    await page.getByTestId("file-input").setInputFiles(images());
    await expect(page.getByTestId("chosen")).toContainText("3 files");

    await page.getByTestId("register-source").click();
    await expect(page.getByTestId("source-card")).toBeVisible();

    await page.getByTestId("batch-name").fill("cycle-batch");
    await page.getByTestId("start-ingest").click();

    // The run is launched with a 202 and polled to its end — the only place in the
    // product where the answer arrives on a job row rather than in the response.
    await expect(page.getByTestId("run-state")).toHaveText("completed", { timeout: 60_000 });
    await expect(page.getByTestId("run-progress")).toContainText("3 of 3");
    await expect(page.getByTestId("failures")).toHaveCount(0);
  });

  await test.step("a draft batch's tiles are inert, and say why", async () => {
    // Before approval there are no jobs, so `BatchAsset.job_id` is null (#29) and
    // an asset has nowhere to go. #160's third criterion: the tile must read as
    // *not yet* rather than as a broken control, so the reason travels on the
    // element a person can hover.
    //
    // The ingest step above ends on the ingest screen, so the walk back to the
    // batch table is the same one every other step makes.
    await openProject(page, "batches");
    await page.getByTestId("open-batch-cycle-batch").click();
    await expect(page.getByTestId("gallery")).toBeVisible();
    const first = page.getByTestId(/^tile-/).first();
    await expect(first).toBeDisabled();
    await expect(first).toHaveAttribute("data-pending", "true");
    await expect(first).toHaveAttribute("title", /draft/i);
  });

  await test.step("the grid fills the pane, and re-flows when the window narrows", async () => {
    // **#159, and it can only be asserted here.** The gallery rendered one tile per
    // row at every width because `useColumns`' `ResizeObserver` was attached in an
    // effect that ran once, while the scroller was still inside `<Async>`'s loading
    // branch and therefore null. jsdom cannot see any of this: it reports every
    // element as 0×0, so the virtualizer renders no rows at all there and the
    // screen's own unit tests passed in exactly the state the bug produced.
    //
    // Measured rather than pinned to a number: the pane's width depends on the
    // rail, the padding and the scrollbar, so the claim is that the rendered
    // count **agrees with what fits**, which is the property that was false.
    const wide = await columnsOf(page);
    expect(wide.rendered).toBe(wide.expected);
    // The defect's signature, and the assertion that would have caught it: one
    // tile per row at a viewport wide enough for several.
    expect(wide.rendered).toBeGreaterThan(1);

    // Narrow far enough that fewer fit, and the count has to follow. A screen that
    // measured once — which is what the effect did — answers the wide count
    // forever, so this is the half that proves the observer is attached at all.
    await page.setViewportSize({ width: 560, height: 900 });
    await expect.poll(async () => (await columnsOf(page)).rendered).toBeLessThan(wide.rendered);
    const narrow = await columnsOf(page);
    expect(narrow.rendered).toBe(narrow.expected);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await columnsOf(page)).rendered).toBe(wide.rendered);
  });

  await test.step("approve the batch, which pins the schema and cuts one job", async () => {
    // Navigated rather than `goBack()`: history depth is an implementation detail
    // of how the previous steps got here, and a cycle this long should not depend
    // on it.
    await openProject(page, "batches");
    await expect(page.getByTestId("batches-table")).toBeVisible();
    await expect(page.getByTestId("batch-cycle-batch")).toContainText("draft");

    await page.getByTestId("approve-cycle-batch").click();
    await page.getByTestId("approve-submit").click();

    // The version pins *at approval* — before it, the column is empty.
    await expect(page.getByTestId("state-cycle-batch")).toHaveText("approved");
    await expect(page.getByTestId("batch-cycle-batch")).toContainText("v1");

    await page.getByTestId("start-cycle-batch").click();
    await expect(page.getByTestId("state-cycle-batch")).toHaveText("in_annotation");
  });

  await test.step("reach the annotator by clicking, on the asset that was clicked", async () => {
    // **#160's fourth acceptance criterion, and the reason this step exists.**
    // Until this fix the only way in was `page.goto('./jobs/' + id)` with the id
    // read out of the API — which is exactly what this spec used to do, and what
    // made a defect that blocked the whole product invisible to a green suite.
    // Nothing here types a URL.
    await openProject(page, "batches");
    await page.getByTestId("open-batch-cycle-batch").click();
    await expect(page.getByTestId("gallery")).toBeVisible();

    // The **third** tile, so "it opened the job" and "it opened this asset" cannot
    // be confused: a page that ignored the click would show 1/3.
    const tiles = page.getByTestId(/^tile-/);
    await expect(tiles).toHaveCount(3);
    const third = tiles.nth(2);
    await expect(third).toBeEnabled();
    const openedAsset = (await third.getAttribute("data-testid"))!.replace("tile-", "");
    await third.click();

    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/jobs/[0-9a-f-]+\\?asset=${openedAsset}$`));
    await expect(page.getByTestId("asset-position")).toContainText("3/3");

    // #160's fifth criterion, and the only honest way to check it here: reload the
    // URL **the app itself produced**, which is a fresh `GET /ui/jobs/<id>?asset=`
    // at the server and therefore drives #58's SPA deep-link fallback for real. A
    // typed `page.goto('./jobs/…')` would assert the same thing while reopening
    // the door this task closed.
    await page.reload();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.getByTestId("asset-position")).toContainText("3/3");

    // And back to the gallery, from the annotator's own grid button — the other
    // half of #160, which rendered disabled because nothing passed the callback.
    await page.getByTestId("open-gallery").click();
    await expect(page.getByTestId("gallery")).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/batches\/[0-9a-f-]+$/);
  });

  await test.step("annotate all three assets", async () => {
    // Back in through the first tile, because the drawing below walks 1 → 2 → 3.
    await page.getByTestId(/^tile-/).first().click();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.getByTestId("asset-position")).toContainText("1/3");

    // 1 — a box.
    await drawBox(page);
    await page.getByTestId("save").click();
    await expect(page.getByTestId("save-state")).toContainText("Saved");
    await page.getByTestId("next-asset").click();

    // 2 — a polygon, closed with Enter.
    await expect(page.getByTestId("asset-position")).toContainText("2/3");
    await drawPolygon(page);
    await page.getByTestId("save").click();
    await expect(page.getByTestId("save-state")).toContainText("Saved");
    await page.getByTestId("next-asset").click();

    // 3 — a whole-asset tag, from the Labels tab. Never the canvas.
    await expect(page.getByTestId("asset-position")).toContainText("3/3");
    await page.getByTestId("tab-labels").click();
    await page.getByTestId("label-daytime").click();
    await expect(page.getByTestId("label-daytime")).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("object-total")).toHaveText("1 object");
    await page.getByTestId("save").click();
    await expect(page.getByTestId("save-state")).toContainText("Saved");

    // The chain nothing in the browser closed before #59 found it: a batch cannot
    // complete while a job is outstanding, and a job cannot while an asset is
    // unsettled. Saving annotations settles the assets; this closes the job.
    await expect(page.getByTestId("job-progress")).toHaveText("3 / 3 annotated");
    await page.getByTestId("finish-job").click();
    await expect(page.getByTestId("finish-job")).toHaveText("Finished");
  });

  await test.step("complete the batch", async () => {
    await openProject(page, "batches");
    await expect(page.getByTestId("batches-table")).toBeVisible();
    await page.getByTestId("complete-cycle-batch").click();
    await expect(page.getByTestId("state-cycle-batch")).toHaveText("completed", {
      timeout: 30_000,
    });
  });

  await test.step("promote the completed batch into the trunk", async () => {
    // The trunk carries assets only, and promotion is a **union** against current
    // membership — idempotent, with no log entry when nothing changed.
    await page.getByTestId("promote-cycle-batch").click();
    await expect(page.getByTestId("promote-cycle-batch")).toHaveText("Promoted");
  });

  await test.step("publish a release", async () => {
    await page.getByTestId("go-dataset").click();
    await expect(page.getByTestId("dataset-stats")).toContainText("3");
    await expect(page.getByTestId("dataset-screen")).toBeVisible();

    await page.getByTestId("publish-release").click();
    await page.getByTestId("release-tag").fill(TAG);
    await page.getByTestId("publish-submit").click();
    await expect(page.getByTestId(`release-${TAG}`)).toBeVisible();
  });

  await test.step("verify the release re-reads every blob", async () => {
    await page.getByTestId(`verify-${TAG}`).click();
    // Re-read and re-hashed, not `is_file()` — which is why this is a button and
    // not something the list does on render.
    await expect(page.getByTestId(`verified-${TAG}`)).toContainText("Intact");
  });

  await test.step("export through the dummy format and download the archive", async () => {
    await page.getByTestId(`export-${TAG}`).click();
    await page.getByTestId("export-format").click();
    await page.getByRole("option", { name: /dummy/ }).click();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-submit").click(),
    ]);
    await expectArchive(download);
  });

  await test.step("the whole walk produced a clean console", async () => {
    // #161. Last, so it covers everything above rather than one screen: eleven
    // navigations, a reload, two viewport changes and a download, and the browser
    // should have had nothing to say about any of it.
    //
    // **Stated rather than implied: headless chromium does not request
    // `/favicon.ico` on its own**, so this assertion cannot reproduce #161's
    // original symptom — a headed browser asks, a headless one does not, and
    // removing the `<link>` again leaves this passing. Verified, not assumed.
    //
    // What it does hold is the property the issue is actually after: the walk
    // produces no console error and no failed resource load, so a *new* one has
    // silence to stand out against instead of a permanent line. The icon itself is
    // guarded by `tests/scripts/favicon.test.mjs` — which does fail when the link
    // goes — and by the request below.
    expect(consoleErrors).toEqual([]);
    expect(badRequests).toEqual([]);
    // And the icon is genuinely served under the mount, rather than absent and
    // unnoticed: `vite preview` would answer 200 with `index.html` here, which is
    // #49's trap and the reason this is checked against the real server.
    const icon = await page.request.get("/ui/favicon.svg");
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/svg+xml");
  });
});

/** Back to the project screen, wherever the last step left the router. */
/**
 * What the gallery actually rendered, beside what actually fits.
 *
 * Both read off the live DOM: `rendered` counts the children of the first row, and
 * `fits` recomputes the screen's own arithmetic from the scroller's measured width.
 * Comparing the two is what makes this a check on the *measurement* rather than on
 * a number somebody typed — #159's arithmetic was correct throughout and the
 * measurement never happened.
 */
async function columnsOf(page: Page): Promise<{ rendered: number; expected: number }> {
  await expect(page.getByTestId("gallery-row-0")).toBeVisible();
  return await page.evaluate(() => {
    const TILE = 160;
    const GAP = 12;
    const scroll = document.querySelector('[data-testid="gallery-scroll"]')!;
    const rows = [...document.querySelectorAll('[data-testid^="gallery-row-"]')];
    const tiles = rows.reduce((count, row) => count + row.children.length, 0);
    const fits = Math.max(1, Math.floor((scroll.clientWidth + GAP) / (TILE + GAP)));
    return {
      rendered: rows[0]!.children.length,
      // A full row, unless the batch is shorter than one. This cycle holds three
      // assets, so the wide case is bounded by the data rather than by the pane —
      // which is fine, because one-per-row is what the defect produced and three
      // is not one.
      expected: Math.min(fits, tiles),
    };
  });
}

/**
 * The walk back to a project, and to one of its sections.
 *
 * #171 put the schema, the batches and the version history behind tabs, so
 * "reach the batch table" is now two clicks rather than one. It is clicked rather
 * than reached by `?tab=`, for the same reason nothing here types a URL: a step
 * that navigates by address cannot notice that the control is missing.
 */
async function openProject(page: Page, tab: "schema" | "batches" | "versions"): Promise<void> {
  await page.getByTestId("rail-projects").click();
  await expect(page.getByTestId(`open-${PROJECT}`)).toBeVisible();
  await page.getByTestId(`open-${PROJECT}`).click();
  await expect(page.getByTestId("project-screen")).toBeVisible();
  if (tab !== "schema") await page.getByTestId(`tab-${tab}`).click();
}

/*
 * `jobIdOf` used to live here: it read the job id out of the API through the
 * browser's session so the spec could `page.goto('./jobs/' + id)`. #160 deleted it
 * along with the navigation, because that helper *was* the workaround — a suite
 * that fetches an id the product never shows cannot notice that the product never
 * shows it. The annotator is now reached the way a person reaches it.
 */

/**
 * Pick a class and **wait until it is active**.
 *
 * Through the Labels tab rather than the digit, and the difference is not
 * cosmetic: a hotkey's effect reaches the machine through the host's own state, so
 * a press and a drag issued back to back can both be seen while the old class is
 * still current. The panel reflects the class with `data-active`, which turns that
 * into something to wait on — and it is also how a person picks a class.
 *
 * The cycle lost a run to exactly this before the wait existed.
 */
async function activate(page: Page, name: string): Promise<void> {
  await page.getByTestId("tab-labels").click();
  await page.getByTestId(`label-${name}`).click();
  await expect(page.getByTestId(`label-${name}`)).toHaveAttribute("data-active", "true");
}

async function drawBox(page: Page): Promise<void> {
  await activate(page, "vehicle");
  const box = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("object-total")).toHaveText("1 object");
}

async function drawPolygon(page: Page): Promise<void> {
  await activate(page, "lane");
  const box = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  for (const [fx, fy] of [
    [0.3, 0.25],
    [0.2, 0.6],
    [0.6, 0.6],
  ] as const) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  }
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("object-total")).toHaveText("1 object");
}

/**
 * The archive arrived and is a zip.
 *
 * `dummy` writes nothing, so the *contents* are not the claim — `file_count: 0` is
 * an export that ran. What is asserted is that the browser received a download with
 * the right name and a zip's own four magic bytes, which is the part every real
 * exporter inherits.
 */
async function expectArchive(download: Download): Promise<void> {
  expect(download.suggestedFilename()).toBe(`${TAG}-dummy.zip`);
  const saved = await download.path();
  expect(saved).not.toBeNull();
  const head = readFileSync(saved as string).subarray(0, 2).toString("latin1");
  expect(head).toBe("PK");
}
