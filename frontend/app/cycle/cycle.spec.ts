/**
 * The whole cycle, in a browser, against a real server.
 *
 * Token → project → schema → ingest → approve → annotate → complete → promote →
 * publish → export → download. No mocks anywhere: the bundle is the built one that
 * ships in the wheel, and `visionset server` serves it beside the real API over the
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

import { expect, test, type Download, type Page, type TestInfo } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { saveNow } from "../e2e/_frame";
import { emptyWorkspace } from "./_workspace";

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

const TAG = "v1";

/**
 * The reserved model id that resolves to this build's own no-op segmenter.
 *
 * Spelled here rather than imported from the Python that defines it, because
 * that string is a contract between the two halves and a suite importing it
 * from one of them could never notice the two disagreeing. `test_stub_provider`
 * holds the other end.
 */
const STUB_MODEL_ID = "visionset/stub-segmenter";

/** What the connection is called on screen, so a refusal can be read. */
const STAND_IN = "built-in stand-in";

/**
 * What the same connection is called after the walk edits it.
 *
 * A second constant rather than a literal at the call site, because a rename
 * moves two test ids at once — the row is `connection-{name}` and its menu
 * trigger is `actions-{name}` — so the new name is read in three places and a
 * typo in one of them fails as a timeout rather than as a mismatch.
 */
const REPINNED = "built-in stand-in, repinned";

/**
 * A project name nothing else in the workspace will collide with — **including
 * this same spec on another repetition**.
 *
 * A project name is unique per workspace, case-insensitively, and a fixed
 * literal here used to make `--repeat-each` useless: the workspace outlived a
 * repetition, so repeat 2 died on `POST /projects → 409` before reaching
 * anything the suite is about. The connection name had the same problem one
 * screen later and nobody had noticed it, which is the argument against curing
 * a collision one name at a time.
 *
 * Neither needs curing now. Every attempt begins on an empty workspace — see
 * the `beforeEach` below — so no name in this walk collides with a name from
 * another attempt, and none of them has to move.
 *
 * The suffix stays anyway, and is unconditional, because it costs nothing and
 * it makes a failure message name the attempt it came from. That is worth more
 * now than it was: a retry can finally produce a second, *different* failure,
 * and two reports that name the same project are two reports somebody has to
 * tell apart by hand.
 */
function projectFor(info: TestInfo): string {
  return `browser-cycle-${info.repeatEachIndex}-${info.retry}`;
}

/**
 * Every attempt starts on an empty workspace — a retry included, and every
 * repetition of `--repeat-each`.
 *
 * On the first attempt of a freshly built workspace this deletes nothing and
 * costs two reads. It exists for the second: the workspace is rebuilt once per
 * *server* start, not once per attempt, so without this a retry inherits the
 * previous attempt's projects and dies on Home's first-run invitation — an
 * assertion about the workspace, three steps in, unrelated to whatever actually
 * failed.
 *
 * Unconditional rather than guarded on `retry`, because a repair that only runs
 * on the rare attempt has the same property as the defect it repairs: nothing
 * exercises it until the day it matters. Run every time, its two reads are
 * proved by every run of this suite.
 */
test.beforeEach(async ({ request }) => {
  await emptyWorkspace(request, token());
});

test("the whole cycle, from opening the app to a downloaded export", async ({ page }, info) => {
  test.slow();

  const PROJECT = projectFor(info);

  // Collected across the whole walk rather than
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
  // Every API call the *app* made that the API refused, exempted from the
  // console assertion because the walk contains refused calls by design —
  // `GET /projects/{id}/schema` answers 404 for a project that has no schema
  // yet, which is how the editor knows to open on an empty draft — and Chrome
  // logs a console error for each; a resource the *browser* went looking for
  // on its own still stands out. The set is keyed by URL because that is what
  // a console message's location carries; the list is keyed by route and
  // status because that is what a person can check, and it is pinned in the
  // final step. Without the list the exemption is unbounded: any route, any
  // status, silently tolerated.
  const apiRefusals = new Set<string>();
  const refusedApiCalls: string[] = [];
  // Requests the *app* issued that the network stack reported as aborted.
  // Asserted rather than ignored — see the final step for why they are not
  // `badRequests` and what the one expected member of this list is.
  const abortedApiCalls: string[] = [];
  // Whether the curated model's size could be read on *this* installation, taken
  // from what the form actually rendered. The probe reaches a hub through the
  // optional local-inference runtime, so it answers 500 on an installation
  // without it and 200 on one with it — and both are the product working. Read
  // rather than assumed, because the two inference CI jobs install differently
  // and a developer's machine matches neither.
  let curatedSizeRefused = false;
  page.on("response", (response) => {
    const kind = response.request().resourceType();
    if (response.status() < 400) return;
    if (kind === "fetch" || kind === "xhr") {
      apiRefusals.add(response.url());
      // The path without its query, which is the part that identifies the route.
      // A download-size query carries a model id and a revision that move with
      // the catalog, and pinning those would fail on a bumped revision rather
      // than on a refusal.
      refusedApiCalls.push(
        `${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`,
      );
      return;
    }
    badRequests.push(`${response.status()} ${kind} ${response.url()}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (apiRefusals.has(message.location().url)) return;
    consoleErrors.push(`${message.text()} @ ${message.location().url}`);
  });
  page.on("requestfailed", (request) => {
    // **The reason, not just the URL.** A bare `failed <url>` cannot tell a
    // resource the browser could not fetch from a call that completed and whose
    // empty body stream the network stack then tore down, and those want
    // opposite responses. Splitting them here is what lets each be asserted for
    // what it is instead of one of them being quietly tolerated.
    const reason = request.failure()?.errorText ?? "unknown";
    const kind = request.resourceType();
    if ((kind === "fetch" || kind === "xhr") && reason === "net::ERR_ABORTED") {
      const path = new URL(request.url()).pathname;
      // A GET of image bytes torn down mid-flight is the app *cancelling*, not
      // abandoning: `AssetImage` and `AssetThumbnail` abort their transfer when
      // the consumer unmounts (#572), so a walk that navigates while frames and
      // tiles are still loading produces these by design, in numbers that
      // depend on timing. Every other aborted call stays pinned below.
      if (request.method() === "GET" && /\/(thumbnail|content)$/.test(path)) return;
      abortedApiCalls.push(`${request.method()} ${path}`);
      return;
    }
    badRequests.push(`failed ${reason} ${request.url()}`);
  });

  await test.step("open the app, which asks for nothing", async () => {
    await page.goto("./");
    // The browser session against the real thing: `visionset server`
    // on this machine, a browser, and the product — nothing typed, nothing
    // pasted, no token anywhere in this step.
    await expect(page.getByTestId("app-rail")).toBeVisible();
    await expect(page.getByTestId("token-input")).toHaveCount(0);
  });

  await test.step("and a minted token still opens it too", async () => {
    // The credential a third party uses, exercised in the one place a browser can
    // still reach the form. The session cookie is *still in the jar* while this
    // runs, so it is also the proof that the bearer header is tried first.
    await page.getByTestId("rail-sign-out").click();
    await page.getByTestId("token-input").fill(token());
    await page.getByTestId("token-submit").click();
    // The rail is the product; reaching it means the credential was accepted by
    // the real `StoredTokenAuthProvider` against a real digest.
    await expect(page.getByTestId("app-rail")).toBeVisible();
  });

  await test.step("create a project", async () => {
    // From Home's first-run invitation rather than from the project list, and
    // that is the honest route here: this workspace was created seconds ago, so
    // `/` is exactly the state that invitation exists for. It opens the same
    // dialog the list's own button does — one component, two callers — which is
    // why every field below is unchanged.
    await expect(page.getByTestId("home-first-run")).toBeVisible();
    await page.getByTestId("home-create-project").click();
    await page.getByTestId("project-name").fill(PROJECT);
    await page.getByTestId("project-description").fill("Driven by #59");
    await page.getByTestId("create-submit").click();
    // Straight into it: a project is made in order to do something with
    // it, so the list it was made from is never the destination. The route is
    // asserted as well as the screen, because "the callback fired" and "the app
    // turned it into a URL" are two claims and only the second survives a
    // reload.
    await expect(page.getByTestId("project-screen")).toBeVisible();
    // A new project opens on its default section, spelled in the URL.
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/overview$/);
    await expect(page.getByTestId("project-title")).toHaveText(PROJECT);
  });

  await test.step("declare a schema with all four geometries", async () => {
    /*
     * A brand-new project opens on Overview, on **one** invitation chosen from
     * its real state — no schema and no
     * images, so the invitation is the classes one and it is the page's only
     * filled button. This is the first-run path a person actually walks, so the
     * run walks it: the CTA, not the tab bar.
     *
     * The header's Ingest is asserted outlined here rather than in a unit test
     * because "exactly one filled button on the page" is a claim about the whole
     * composed screen, and the header lives outside the panel that owns the
     * invitation.
     */
    await expect(page.getByTestId("overview-empty")).toBeVisible();
    await expect(page.getByTestId("first-run")).toHaveAttribute(
      "data-invitation",
      "classes-first",
    );
    await expect(page.locator("button.bg-primary")).toHaveCount(1);
    await expect(page.getByTestId("go-ingest")).not.toHaveClass(/bg-primary/);
    // And the retired checklist is gone rather than merely dismissed.
    await expect(page.getByTestId("journey-checklist")).toHaveCount(0);

    await page.getByTestId("first-run-cta").click();
    await expect(page.getByTestId("nav-schema")).toHaveAttribute("aria-current", "page");

    // A project starts schema-less on purpose, so the editor opens on an empty
    // draft rather than an error.
    await expect(page.getByTestId("schema-editor")).toContainText("Saving creates version 1");

    for (const [index, [name, geometry]] of (
      [
        ["vehicle", "bbox"],
        ["lane", "polygon"],
        ["daytime", "classification_tag"],
        // The picker offers it because the API accepts it and the lane
        // exporters need it — not because anything draws one. Declaring it here
        // is the schema editor's half of that, against a real `create_version`
        // that would answer `UnsupportedGeometry` if the kernel disagreed.
        ["centerline", "polyline"],
      ] as const
    ).entries()) {
      await page.getByTestId("add-class").click();
      await page.getByTestId(`class-name-${index}`).fill(name);
      if (geometry !== "bbox") {
        // Tick the wanted shape *before* clearing the default, which is also the
        // only order the control permits: a class never passes through accepting
        // nothing, so the last ticked box refuses to come off.
        await page.getByTestId(`class-geometry-${index}-${geometry}`).click();
        await page.getByTestId(`class-geometry-${index}-bbox`).click();
      }
    }

    /*
     * One class, two shapes, against a real `create_version` (#584).
     *
     * The whole point of a geometry set is that a class labelled as a box on some
     * frames and as an outline on others is one class — and the only place that
     * can be shown end to end is here, where the kernel actually judges the
     * document. `vehicle` keeps its box and gains a polygon.
     */
    await page.locator('[data-row="0"] button').first().click();
    await page.getByTestId("class-geometry-0-polygon").click();
    await expect(page.getByTestId("class-geometry-0-bbox")).toBeChecked();
    await expect(page.getByTestId("class-geometry-0-polygon")).toBeChecked();

    /*
     * The draft survives leaving the section, in a real DOM.
     *
     * jsdom cannot carry this claim on its own: the mechanism is the open
     * section being the only one mounted, and "the component really was
     * destroyed and rebuilt" is a statement about a browser's own
     * reconciliation. Four unsaved classes is also the largest thing this cycle
     * ever has to lose, and losing it here would be silent — the run would carry
     * on and publish version 1 with whatever survived.
     */
    await page.getByTestId("nav-overview").click();
    await expect(page.getByTestId("schema-editor")).toHaveCount(0);
    await page.getByTestId("nav-schema").click();
    for (const name of ["vehicle", "lane", "daytime", "centerline"]) {
      await expect(page.getByTestId("class-list")).toContainText(name);
    }

    /*
     * And the draft survives a **reload**, which is a claim about the server
     * rather than about React.
     *
     * The tab-switch check above proves only that state held above the tabs
     * outlived a component being destroyed — everything it asserts is still true
     * of a draft that never leaves the browser. A reload discards the whole
     * page, so four unsaved classes coming back can only mean the server was
     * holding them: the editor autosaves each edit through
     * `PUT .../schema/drafts/curated` and seeds from `GET` on the way back up.
     * That is the promise this feature exists to make, and jsdom cannot make it
     * — there "reload" is a remount against a stub, which proves the stub.
     *
     * Nothing has been published at this point, so a version-1 fallback cannot
     * be what answers: the project is still schema-less, and anything on screen
     * after this reload came out of the draft.
     */
    await page.reload();
    await expect(page.getByTestId("schema-editor")).toContainText("Saving creates version 1");
    for (const name of ["vehicle", "lane", "daytime", "centerline"]) {
      await expect(page.getByTestId("class-list")).toContainText(name);
    }
    // The two shapes on `vehicle` survive too, so what came back is the draft as
    // edited rather than a re-seed from the four names alone.
    await page.locator('[data-row="0"] button').first().click();
    await expect(page.getByTestId("class-geometry-0-bbox")).toBeChecked();
    await expect(page.getByTestId("class-geometry-0-polygon")).toBeChecked();

    await page.getByTestId("save-schema").click();
    // The history nests inside the Schema tab now: it is a view *of* the schema
    // rather than a peer of it, so the published version is checked further down
    // the page it belongs to rather than in a fourth tab.
    await expect(page.getByTestId("version-history")).toBeVisible();
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
    await expect(page.getByTestId("run-state")).toHaveText("Done", { timeout: 60_000 });
    await expect(page.getByTestId("run-progress")).toContainText("3 of 3");
    await expect(page.getByTestId("failures")).toHaveCount(0);
  });

  await test.step("the finished run names the batch it filled, and opens it", async () => {
    // **The only test anywhere that drives the settled run's own route onward.**
    // Walking back through the project to find the batch instead would be a suite
    // finding it by another road, which cannot notice that the screen offers none.
    await expect(page.getByTestId("run-outcome")).toContainText("cycle-batch");
    await page.getByTestId("open-batch").click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/batches\/[0-9a-f-]+$/);
  });

  await test.step("a draft batch's tiles have nowhere to go, and say why", async () => {
    // Before approval there are no jobs, so `BatchAsset.job_id` is null and
    // an asset has nowhere to go. The tile is not one big disabled button,
    // because selecting a frame in a draft is legitimate — it is opening one that
    // is not. So what is asserted is the *capability*, not the control's tag.
    await expect(page.getByTestId("gallery")).toBeVisible();
    const first = page.getByTestId(/^tile-/).first();
    await expect(first).toHaveAttribute("data-pending", "true");
    // No route into the annotator, and the reason on the card itself — which is
    // the element a pointer is over wherever it lands. The explanation lives on
    // the tile rather than in a caption row beside it.
    await expect(first.getByTestId(/^open-/)).toHaveCount(0);
    await expect(first).toHaveAttribute("title", /draft/i);

    // **Selection is offered.** A draft is the one
    // state where `edit_membership` is legal, so "every action one could offer is
    // unavailable before jobs exist" is false — and a gate that hid the bar would
    // be hiding the one state it is for. Against a real server, so the batch's own
    // `allowed_actions` is the kernel's answer rather than a fixture's.
    await first.getByTestId(/^select-/).click();
    await expect(page.getByTestId("bulk-remove")).toBeEnabled();
    // The progress moves stay dead here, for their own reason: no jobs, so no
    // progress to move.
    await expect(page.getByTestId("bulk-skip")).toBeDisabled();
    await page.getByTestId("bulk-clear").click();
  });

  await test.step("the grid fills the pane, and re-flows when the window narrows", async () => {
    // **The column count, and it can only be asserted here.** A gallery renders
    // one tile per row at every width if `useColumns`' `ResizeObserver` is attached
    // in an effect that runs once, while the scroller is still inside `<Async>`'s
    // loading branch and therefore null. jsdom cannot see any of this: it reports
    // every element as 0×0, so the virtualizer renders no rows at all there and the
    // screen's own unit tests pass in exactly the state the bug produces.
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
    await openProject(page, PROJECT, "batches");
    await expect(page.getByTestId("batches-table")).toBeVisible();
    await expect(page.getByTestId("batch-cycle-batch")).toContainText("pending approval");

    await page.getByTestId("approve-cycle-batch").click();
    await page.getByTestId("approve-submit").click();

    // The version pins *at approval* — before it, the column is empty.
    await expect(page.getByTestId("state-cycle-batch")).toHaveText("approved");
    await expect(page.getByTestId("batch-cycle-batch")).toContainText("v1");

    await page.getByTestId("start-cycle-batch").click();
    await expect(page.getByTestId("state-cycle-batch")).toHaveText("in progress");
  });

  await test.step("reach the annotator by clicking, on the asset that was clicked", async () => {
    // **The annotator is reached by clicking, and that is the reason this step
    // exists.** `page.goto('./jobs/' + id)` with the id read out of the API makes
    // a defect that blocks the whole product invisible to a green suite.
    // Nothing here types a URL.
    await openProject(page, PROJECT, "batches");
    await page.getByTestId("open-batch-cycle-batch").click();
    await expect(page.getByTestId("gallery")).toBeVisible();

    // The **third** tile, so "it opened the job" and "it opened this asset" cannot
    // be confused: a page that ignored the click would show 1/3.
    //
    // A press on the thumbnail *selects* — the grid has shift-ranges and a bulk
    // bar, and a gallery where the only click opens cannot express a multi-frame
    // action — so opening has its own labelled control on the tile. It is always
    // visible rather than hover-gated, which a touch device would never reach.
    // What matters is that the annotator is reachable **by clicking**, with no id
    // read out of the API and no URL typed.
    const tiles = page.getByTestId(/^tile-/);
    await expect(tiles).toHaveCount(3);
    const third = tiles.nth(2);
    await expect(third).not.toHaveAttribute("data-pending", "true");
    const openedAsset = (await third.getAttribute("data-testid"))!.replace("tile-", "");
    await third.getByTestId(`open-${openedAsset}`).click();

    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/jobs/[0-9a-f-]+\\?asset=${openedAsset}$`));
    await expect(page.getByTestId("asset-position")).toContainText("3/3");

    // The only honest way to check the deep link: reload the
    // URL **the app itself produced**, which is a fresh `GET /app/jobs/<id>?asset=`
    // at the server and therefore drives the SPA deep-link fallback for real. A
    // typed `page.goto('./jobs/…')` would assert the same thing while reopening
    // the door this task closed.
    await page.reload();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.getByTestId("asset-position")).toContainText("3/3");

    // The grid button switches frames without leaving: an overlay over the
    // workspace, the URL unmoved, and Escape returning to exactly the frame that
    // was on screen.
    const inTheEditor = page.url();
    await page.getByTestId("open-gallery").click();
    await expect(page.getByTestId("frame-gallery")).toBeVisible();
    expect(page.url()).toBe(inTheEditor);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("frame-gallery")).toHaveCount(0);
    await expect(page.getByTestId("asset-position")).toContainText("3/3");

    // And back to the gallery, from the arrow. Leaving is still a thing you can
    // do; it is not the only way to look at your own frames.
    await page.getByTestId("back").click();
    await expect(page.getByTestId("gallery")).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/batches\/[0-9a-f-]+$/);
  });

  await test.step("set up a connection to the built-in stand-in", async () => {
    /*
     * **Auto-labeling had no coverage against a real server at all**, which is
     * how a defect that made every suggestion a 500 passed a full green run.
     * The obstacle was always the weights: the models that answer a point
     * prompt are gigabytes and one of them is gated, so no scenario could fetch
     * one on a runner.
     *
     * `visionset/stub-segmenter` is the shipped no-op that closes it — the
     * `dummy` exporter's decision, which this same walk already exports
     * through. Every hop below is the product's own: the form, the download
     * action, the connection's lifecycle. Only the thing at the far end
     * predicts nothing.
     */
    await page.getByTestId("rail-models").click();
    await expect(page.getByTestId("models-screen")).toBeVisible();

    await page.getByTestId("new-connection").click();
    await page.getByTestId("choose-local").click();
    await page.getByTestId("connection-name").fill(STAND_IN);

    // Through **Custom model**, which is the point of it not being in the
    // curated list: nobody choosing a model is offered a segmenter that cannot
    // segment, and anybody who needs it can still name it.
    //
    // The trigger only exists once the real `/inference/providers` read has
    // answered — wait for it rather than racing the click against that request.
    await expect(page.getByTestId("connection-model")).toBeVisible();

    // Whether the select lands on a curated model, or falls back to Custom
    // model with an empty id, is a catalog fact `connection-model` being
    // visible does not settle: `defaultEntry` seeds the first entry that
    // answers a point prompt, but returns `undefined` when none does, and
    // `DownloadSizeLine` renders nothing for an empty id — so the wait below
    // would die on a bare, undiagnosable timeout on such an installation.
    // Assert the seed landed on a curated model before waiting on the price
    // probe only a curated model triggers.
    await expect(page.getByTestId("connection-model")).not.toHaveText(/Custom model/);

    // Let the seeded model's size probe settle before moving off it: clicking
    // through the select faster than that request resolves leaves the
    // refusal landing at whatever point the dialog happens to unmount, which
    // is the difference between a pinned list and a flaky one. Waiting is
    // also what makes the answer readable — `size-known` and
    // `size-unavailable` are the form's own two outcomes, and the final step
    // expects a refusal from this route exactly when the second one is what
    // rendered.
    const sizeLine = page.getByTestId(/^size-(known|unavailable)$/);
    await expect(sizeLine).toBeVisible();
    curatedSizeRefused = (await sizeLine.getAttribute("data-testid")) === "size-unavailable";

    await page.getByTestId("connection-model").click();
    await page.getByRole("option", { name: /Custom model/ }).click();
    await page.getByTestId("connection-custom-model").fill(STUB_MODEL_ID);
    await page.getByTestId("connection-revision").fill("stub");
    await page.getByTestId("connection-submit").click();

    // Born not set up, like every local connection, and made ready by the same
    // action — the lifecycle here is the real one, not a shortcut written for a
    // suite. What is different is only that there is nothing to fetch.

    // Read inside the row rather than off the screen. Both ids live inside a
    // connection's own row, so an unscoped read is sound only while the
    // workspace holds exactly one — and Playwright's strict mode then refuses
    // the locator, naming the selector instead of the assumption.
    const row = page.getByTestId(`connection-${STAND_IN}`);
    await expect(row.getByTestId("connection-status")).toContainText(/not set up/i);
    await row.getByTestId("download-weights").click();
    await expect(row.getByTestId("connection-status")).toContainText(/ready/i, {
      timeout: 15_000,
    });

    /*
     * One connection, asserted rather than assumed.
     *
     * The suggest panel further down names this connection in a sentence and
     * offers a picker from two upwards, so a second connection breaks that
     * assertion as a *missing string* — pointing at the suggest panel while the
     * cause is an extra row on this screen. Stated here, where the count is
     * decided, a violation names the count.
     *
     * The source line is what is counted because it is unconditional inside a
     * card, while the download button appears only before setup.
     */
    await expect(page.getByTestId("connection-source")).toHaveCount(1);
  });

  await test.step("a click in the editor comes back as a shape, from a real server", async () => {
    /*
     * The gap this walk existed around. Everything here is real: a real
     * `POST /inference/suggest`, the real route, the real mask pipeline turning
     * a grid of pixels into a polygon, and the real editor putting it in the
     * document. The annotator's own suite stubs this request outright, which is
     * correct for what that suite tests and is exactly why it could not notice.
     *
     * The suggestion is **taken back before the step ends**, so the counts every
     * later step asserts — the trunk's, the release's — are the counts the
     * hand-drawn work produced. What is being claimed here is that a click
     * reaches a model and comes back as a shape, not that a stand-in's square
     * belongs in somebody's dataset.
     */
    await openProject(page, PROJECT, "batches");
    await page.getByTestId("open-batch-cycle-batch").click();
    const firstTile = page.getByTestId(/^tile-/).first();
    const firstAsset = (await firstTile.getAttribute("data-testid"))!.replace("tile-", "");
    await firstTile.getByTestId(`open-${firstAsset}`).click();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.getByTestId("object-total")).toHaveText("0 objects");

    // A class first: the suggestion is a shape and a shape needs one, which is
    // the whole reason the model is never asked to name anything.
    await activate(page, "vehicle");
    await page.getByTestId("tool-suggest").click();

    // One connection, so the panel names it in a sentence rather than offering a
    // picker — `suggest-connection-select` appears from two upwards.
    await expect(page.getByTestId("suggest-connection")).toContainText(STAND_IN);
    await expect(page.getByTestId("suggest-idle")).toBeVisible();

    const canvas = (await page.getByTestId("annotator-canvas").boundingBox())!;
    await page.getByTestId("annotator-root").focus();
    await page.mouse.click(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5);

    // The shape came back and rendered. Generous, because this is the one
    // request in the walk that crosses a model boundary — a cold provider is
    // built on the first ask.
    await expect(page.getByTestId("suggest-shown")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("suggestion-shape")).toBeVisible();

    // Accepting is what puts it in the document, and the count is what says so.
    await page.getByTestId("suggest-accept").click();
    await expect(page.getByTestId("object-total")).toHaveText("1 object");

    // And taken back, so nothing downstream inherits it. Undo rather than a
    // delete: it is one gesture, and it also asserts that an accepted
    // suggestion is an ordinary edit rather than something the history cannot
    // reach.
    await page.getByTestId("annotator-root").focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.getByTestId("object-total")).toHaveText("0 objects");
    await expect(page.getByTestId("save-state")).not.toContainText("Saving");

    // Back to the gallery, because the step after this one starts there. A step
    // that leaves the walk somewhere its successor does not expect fails in the
    // successor, which is a long way from the line that caused it.
    await page.getByTestId("back").click();
    await expect(page.getByTestId("gallery")).toBeVisible();
  });

  await test.step("annotate all three assets", async () => {
    // Back in through the first tile, because the drawing below walks 1 → 2 → 3.
    // Through its `Open` control, for the reason above: a press on the thumbnail
    // selects.
    const firstTile = page.getByTestId(/^tile-/).first();
    const firstAsset = (await firstTile.getAttribute("data-testid"))!.replace("tile-", "");
    await firstTile.getByTestId(`open-${firstAsset}`).click();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.getByTestId("asset-position")).toContainText("1/3");
    // The batch's pin, named on the screen. Not the project's active
    // version — they are the same number here because nothing has published
    // since approval, and the point is that the annotator says which one it is
    // judged against, because the pin is movable.
    await expect(page.getByTestId("pinned-schema")).toHaveText("v1");

    // And it answers the question it raises. Nothing about the project's
    // active version is fetched until this is pressed — the rule
    // `annotate.spec.ts` pins from the other side — so the popover is the only
    // place in the editor where that read is legitimate. Here the pin *is* the
    // active version, because nothing has published since approval.
    await page.getByTestId("pinned-schema").click();
    await expect(page.getByTestId("pin-current")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pin-popover")).toHaveCount(0);

    // 1 — a box.
    await drawBox(page);
    await saveNow(page);
    await expect(page.getByTestId("save-state")).toContainText("Saved");
    await page.getByTestId("next-asset").click();

    // 2 — a polygon, closed with Enter.
    await expect(page.getByTestId("asset-position")).toContainText("2/3");
    await drawPolygon(page);
    await saveNow(page);
    await expect(page.getByTestId("save-state")).toContainText("Saved");
    await page.getByTestId("next-asset").click();

    // 3 — a whole-asset tag, from the panel's chip strip. Never the canvas: a tag
    // is not a shape, so no tool and no gesture reaches one.
    await expect(page.getByTestId("asset-position")).toContainText("3/3");
    await page.getByTestId("tag-chip-daytime").click();
    await expect(page.getByTestId("tag-chip-daytime")).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("tag-count")).toHaveText("1 assigned");
    // And it is counted where it is assigned, not where shapes are counted: a tag
    // renders in neither canvas layer, so a badge on the picture reading
    // `1 object` was a number nothing on screen could account for.
    await expect(page.getByTestId("object-total")).toHaveText("0 objects");
    await expect(page.getByTestId("object-count")).toHaveText("0 objects");
    await expect(page.getByTestId("objects-empty")).toHaveText("Nothing drawn yet.");
    await saveNow(page);
    await expect(page.getByTestId("save-state")).toContainText("Saved");

    // 3a — a lane, written the way lanes are actually written.
    //
    // **This is the point of shipping a geometry an agent writes.** The workflow
    // it exists for is *an agent pre-labels lanes and a person reviews them
    // here*. So the
    // lane arrives over the REST API, with the same credential the app is
    // holding, and everything after this line is the person's half of that.
    //
    // The job comes off the URL and **the asset comes off the page**, which is
    // the distinction this step was written wrong once: the asset travels as a
    // query parameter that names where the annotator was *entered*, and
    // `next-asset` moves the frame without rewriting it. Reading `?asset=` here
    // addressed frame 1 while standing on frame 3, and every assertion that
    // followed still passed — the lane really was written, really did render, and
    // really was on the wrong picture. `data-asset` is what the page says about
    // itself.
    const origin = new URL(page.url()).origin;
    const jobId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
    const assetId = await page.getByTestId("annotation-page").getAttribute("data-asset");
    const written = await page.request.post(
      `${origin}/jobs/${jobId}/annotations`,
      {
        headers: { Authorization: `Bearer ${token()}` },
        data: [
          {
            asset_id: assetId,
            label_class: "centerline",
            geometry: {
              type: "polyline",
              // Ascending Y, which is what a lane looks like and what TuSimple
              // would require of it at export.
              points: [
                [8, 6],
                [24, 30],
                [40, 58],
              ],
            },
            attributes: {},
            provenance: "model",
            model_ref: "cycle-spec@1",
            confidence: 0.8,
          },
        ],
      },
    );
    expect(written.status()).toBe(201);
    expect((await written.json()).items[0].geometry.type).toBe("polyline");

    // 3b — the lane is on the page a person is looking at. Loaded afresh rather
    // than refetched in place, because the assertion worth making is that the
    // *stored* annotation renders, not that an optimistic update did. The asset
    // is named explicitly so the entry point and the frame agree.
    await page.goto(`./jobs/${jobId}?asset=${assetId}`);
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    // One: the lane. The tag on this frame is not an object, and the count says so.
    await expect(page.getByTestId("object-total")).toHaveText("1 object");
    // Still assigned, and still counted in its own region — excluding it from the
    // objects is not the same as losing it.
    await expect(page.getByTestId("tag-chip-daytime")).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("tag-count")).toHaveText("1 assigned");
    // The row names the shape, which is what tells two annotations of one class
    // apart now that a class accepts a set.
    await expect(page.getByTestId("object-row-0")).toContainText("1. centerline · polyline");
    // Drawn as an open path. `<polyline>` and not `<polygon>` is the whole
    // difference between a lane and a closed ring, and it is the one thing a unit
    // test over the document model structurally cannot see.
    // Scoped to the committed layer's own group rather than to `svg polyline`:
    // `TransientLayer` draws a `<polyline>` too, for the polygon being dragged.
    await expect(page.locator("[data-annotation-id] polyline")).toHaveCount(1);
    await expect(page.locator("[data-annotation-id] polyline")).toHaveAttribute("fill", "none");
    // Row **0**, where it used to be row 1: the tag on this frame took the first
    // number, and does not any more.
    await expect(page.getByTestId("object-row-1")).toHaveCount(0);

    // 3c — the lane tool is live, and it is live off a schema this server sent.
    //
    // A **disabled** polyline button with a sentence explaining why lanes can only
    // be written by an agent is what this replaces, and it is worth keeping at this
    // level rather than
    // only in `e2e/polyline.spec.ts`: the strip is built from `drawableGeometry`
    // over the *pinned* schema, so what is asserted here is that a real
    // `SchemaVersionOut` — round-tripped through the API and the generated client —
    // still yields the tool. The drawing behaviour itself is that spec's, against
    // the showcase, where a session can be walked without disturbing this one.
    const laneTool = page.getByTestId("tool-polyline");
    await expect(laneTool).not.toHaveAttribute("aria-disabled", /.*/);
    await laneTool.click();
    await expect(laneTool).toHaveAttribute("data-active", "true");
    // Back to select, so the rest of the walk starts where it used to.
    await page.getByTestId("tool-select").click();

    /*
     * 3a-bis — #381: **a version published anywhere moves this batch's pin, and
     * nobody presses re-pin.**
     *
     * This is the only run that can show it. The unit suites stub the publish, so
     * they can assert what the client sent and rendered; whether the *server*
     * moved the pin in the same transaction is a fact about `SchemaService`, and
     * this is the one place that service is real. Before #381 the pin stayed at
     * v1 here and the new class was invisible in this batch until somebody found
     * the re-pin — which is the dead end the issue was reopened for.
     *
     * Published through the API rather than the Schema tab because the claim is
     * about the kernel, not about a screen: leaving the editor and coming back
     * would test navigation as well, and the Schema tab publishing *at all* is
     * already covered above. The extra class is never drawn, and
     * `DatasetStats.per_class` lists only classes with annotations, so nothing
     * downstream counts it.
     */
    const job = await page.request.get(`${origin}/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    const batchId = (await job.json()).batch_id;
    const batch = await page.request.get(`${origin}/batches/${batchId}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    const beforePin = (await batch.json()).schema_version;
    const projectId = (await batch.json()).project_id;

    // The whole contract plus one — `create_version` takes the entire class list,
    // so a class left out is a class removed, and reading the active version is
    // how this stays an *additive* change rather than an accidental narrowing.
    const active = await page.request.get(`${origin}/projects/${projectId}/schema`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    const current = (await active.json()).classes;

    const grown = await page.request.post(`${origin}/projects/${projectId}/schema/versions`, {
      headers: { Authorization: `Bearer ${token()}` },
      data: {
        classes: [
          ...current,
          { name: "pedestrian", geometries: ["bbox"] },
          // A long name and every shape at once, for the row measurement below.
          // In *this* publish rather than one of its own: the step after asserts
          // `v${beforePin + 2}`, so an extra version here would move a number
          // that is checking something else. #596
          {
            name: "pedestrian crossing",
            geometries: ["bbox", "polygon", "polyline", "classification_tag"],
          },
          // The control for it: the *same* three chips against a short name, which
          // must stay on one line. Without it, "the long row wrapped" is satisfied
          // by a layout that wraps every row — and a fixed flex basis would do
          // exactly that while passing every assertion about the long one.
          { name: "van", geometries: ["bbox", "polygon", "polyline"] },
        ],
        provenance: "curated",
      },
    });
    expect(grown.status()).toBe(201);
    const publication = await grown.json();
    expect(publication.published.version).toBe(beforePin + 1);
    // The response names what it moved, which is what stops a publish being a
    // silent side effect.
    expect(publication.advanced_batches).toContain(batchId);

    await page.reload();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.getByTestId("pinned-schema")).toHaveText(`v${beforePin + 1}`);
    // And the class it brought is drawable here, which is the whole point.
    await expect(page.getByTestId("class-row-pedestrian")).toBeVisible();

    /*
     * #596 — which side of a class row gives way, measured rather than asserted.
     *
     * A four-shape class used to render its whole set beside the name — 176px of
     * a ~240px row — and the name is `flex-1`, so it took what was left: **34px,
     * two characters of it**. The row's identity was the first thing to go.
     *
     * The first answer shortened the *set* to `box +3`. The set is now a row of
     * chips, and every one of them is a press target, so shortening it is no
     * longer available: what gives instead is the row's **height**. The name has a
     * flex floor to push against and the chips wrap under it.
     *
     * Here rather than in `e2e/`, and that is not a preference: the demo schema
     * those scenarios run against has no multi-shape class at all, and inflating a
     * fixture the whole suite asserts on to make room for this would be the more
     * expensive change. This walk publishes real classes anyway.
     *
     * jsdom cannot answer it — there is no layout — so the vitest half asserts the
     * *structure* (`dataDisplay.test.tsx`) and this asserts the pixels.
     */
    const crossing = page.getByTestId("class-row-pedestrian crossing-name");
    await expect(crossing).toBeVisible();
    const fit = await crossing.evaluate((el) => ({
      shown: el.clientWidth,
      needed: el.scrollWidth,
    }));
    expect(fit.needed).toBeGreaterThan(0);
    // Not truncated at all: the name takes what it needs. Against the original
    // layout this reads ~34 of ~130.
    expect(fit.shown).toBeGreaterThanOrEqual(fit.needed - 1);

    // The chips went to a second line to pay for it, which is the whole
    // mechanism — a row that stayed one line tall here would mean the name won
    // its width by truncating a control instead.
    const row = page.getByTestId("class-row-pedestrian crossing");
    const rowBox = await row.boundingBox();
    const nameBox = await crossing.boundingBox();
    // The **last** chip, because the claim below is about the right edge.
    const chipBox = await page
      .getByTestId("class-row-pedestrian crossing-shape-polyline")
      .boundingBox();
    expect(rowBox).not.toBeNull();
    expect(nameBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    // Taller than the 36px an unwrapped row stands at.
    expect(rowBox!.height).toBeGreaterThan(36);
    // The chips are *below* the name, not beside it.
    expect(chipBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height);
    // And they end where every other row's chips end. The name spans the first
    // line, so its right edge is the column every unwrapped row aligns to; a
    // wrapped line that started under the name instead would read as a different
    // kind of row.
    const chipRight = chipBox!.x + chipBox!.width;
    const nameRight = nameBox!.x + nameBox!.width;
    expect(Math.abs(chipRight - nameRight)).toBeLessThanOrEqual(1);

    // Every shape is a chip, and the tag is not among them: a tag has no canvas
    // gesture, and the Tags section below is where this class is tagged.
    for (const shape of ["bbox", "polygon", "polyline"]) {
      await expect(
        page.getByTestId(`class-row-pedestrian crossing-shape-${shape}`),
      ).toBeVisible();
    }
    await expect(
      page.getByTestId("class-row-pedestrian crossing-shape-classification_tag"),
    ).toHaveCount(0);

    // The control: `van` carries the same three chips and a short name, and stays
    // on one line. This is what separates "the row wrapped because it had to" from
    // "every row wraps" — the second passes every assertion above.
    const van = (await page.getByTestId("class-row-van").boundingBox())!;
    expect(van.height).toBeLessThanOrEqual(36);
    const vanName = (await page.getByTestId("class-row-van-name").boundingBox())!;
    const vanChip = (await page.getByTestId("class-row-van-shape-polyline").boundingBox())!;
    // Beside the name, not under it.
    expect(vanChip.x).toBeGreaterThan(vanName.x);
    expect(Math.abs(vanChip.y - vanName.y)).toBeLessThan(vanName.height);

    /*
     * 3a-ter — **the annotator's own add-a-class door, which is now two calls.**
     *
     * `runAddClass` was save → publish → re-pin, and #381 took the third away: the
     * publish moves the pin itself. Nothing anywhere exercised this door in a
     * browser — `annotate.spec.ts` only asserts it is *absent* in read-only mode,
     * and the demo it runs against has no project behind it — so its whole
     * coverage was unit tests against stubs. That is the shape of gap that hid the
     * per-batch diff defect, which is why it is closed here rather than argued
     * about.
     *
     * The request log is the assertion that matters: a `/repin` call would mean
     * the step is still being made by the client.
     */
    const posted: string[] = [];
    const record = (request: import("@playwright/test").Request): void => {
      if (request.method() === "POST") posted.push(new URL(request.url()).pathname);
    };
    page.on("request", record);

    await page.getByTestId("tool-add-class").click();
    await expect(page.getByTestId("add-class-dialog")).toBeVisible();
    await page.getByTestId("class-name-new").fill("cyclist");
    await page.getByTestId("add-class-submit").click();
    await expect(page.getByTestId("add-class-dialog")).toHaveCount(0);
    await expect(page.getByTestId("class-row-cyclist")).toBeVisible();
    page.off("request", record);

    // One publish, and it goes **through the draft**: the dialog banks its classes
    // into the `annotation` draft with a PUT and then publishes that revision, so
    // what reaches the schema is what the draft holds rather than whatever the
    // component happened to be carrying. A direct `/schema/versions` POST from
    // here would mean the dialog had gone back to publishing its own local state.
    expect(
      posted.filter((path) => path.endsWith("/schema/drafts/annotation/publish")),
    ).toHaveLength(1);
    expect(posted.filter((path) => path.endsWith("/schema/versions"))).toHaveLength(0);
    expect(posted.filter((path) => path.endsWith("/repin"))).toHaveLength(0);
    // The pin followed anyway, which is the whole of what the third call used to
    // do — and the class the dialog armed is drawable on this frame.
    await expect(page.getByTestId("pinned-schema")).toHaveText(`v${beforePin + 2}`);

    // 3b — the review round-trip, on the frame we are already standing on.
    //
    // **This is the half of the progress machine that had no door** (audit F24):
    // `annotated -> review_pending -> accepted` are legal kernel edges the
    // browser offered no way to make, so the gallery's "In review" segment could
    // only be filled through the API and `accepted` was unreachable by clicking.
    // Run here, against the real kernel, because the two things worth proving are
    // that the moves are accepted and that an `accepted` asset still settles the
    // job and still promotes — `SETTLED_PROGRESS` and `PROMOTABLE_PROGRESS` both
    // include it, and a suite of stubs cannot check that.
    await page.getByTestId("submit-for-review").click();
    await expect(page.getByTestId("asset-progress")).toHaveAttribute("data-progress", "review_pending");
    // A frame out for review is not writable, and the banner names the way back.
    await expect(page.getByTestId("readonly-banner")).toContainText(/return it to the annotator/i);

    await page.getByTestId("accept").click();
    await expect(page.getByTestId("asset-progress")).toHaveAttribute("data-progress", "accepted");

    // The chain the browser has to close: a batch cannot
    // complete while a job is outstanding, and a job cannot while an asset is
    // unsettled. Saving annotations settles the assets; this closes the job.
    //
    // `accepted` is settled, so the count below still reads 3 of 3 — "annotated"
    // here means *past unannotated*, which is the only reading that does not go
    // backwards when a frame is accepted.
    await expect(page.getByTestId("job-progress")).toHaveText("3 / 3 annotated");
    await page.getByTestId("finish-job").click();
    await expect(page.getByTestId("finish-job")).toHaveText("Finished");

    /*
     * The job's own gate, against the real kernel and in place — no reload, no
     * navigation.
     *
     * The batch is still `in_annotation` here (the next step is what completes
     * it), which is exactly the case the batch gate cannot cover: `JobService`
     * does not cascade upward. What moves is `asset_actions` reading the job's
     * state, so the declarations this mutation invalidates come back empty and
     * the page re-derives its mode from them. A stub can be made to say that;
     * only this walk proves the kernel does.
     *
     * Worth stating about the frame we are standing on: it was already a viewer
     * a moment ago, because `accepted` is not writable — and `Finish job` was
     * still on the bar, which is why it could be pressed at all. That is the
     * rule kept deliberately when the frame's own verbs left the read-only mode:
     * `complete` is the job's declaration, not the frame's.
     */
    await expect(page.getByTestId("readonly-banner")).toContainText(/this job is finished/i);
    // The strip stays and carries navigation only (#576): the hand is not a
    // drawing tool, and a viewer moving around a finished job still needs it.
    await expect(page.getByTestId("tool-select")).toHaveCount(0);
    await expect(page.getByTestId("tool-hand")).toHaveCount(1);
    await expect(page.getByTestId("class-region")).toHaveCount(0);
    await expect(page.getByTestId("save-and-next")).toHaveCount(0);

    // Every frame, not only the one it was pressed on — and navigation is what
    // proves it, which is also half the decision: only editing dies.
    await page.getByTestId("prev-asset").click();
    await expect(page.getByTestId("asset-position")).toHaveText("2/3");
    await expect(page.getByTestId("readonly-banner")).toContainText(/this job is finished/i);
    await expect(page.getByTestId("tool-select")).toHaveCount(0);
    await expect(page.getByTestId("tool-hand")).toHaveCount(1);
  });

  await test.step("complete the batch", async () => {
    await openProject(page, PROJECT, "batches");
    await expect(page.getByTestId("batches-table")).toBeVisible();
    await page.getByTestId("complete-cycle-batch").click();
    await expect(page.getByTestId("state-cycle-batch")).toHaveText("completed", {
      timeout: 30_000,
    });
  });

  await test.step("the completed batch reopens as a viewer, from the tile and the address bar", async () => {
    /*
     * The step a stubbed run cannot take: every earlier read-only claim runs
     * against stubs, so nothing proves that a *real* completed batch — whose
     * asset declarations the kernel computes — reopens as a viewer. The two
     * entries below are the two roads in: the gallery tile, and a reload of the
     * job URL with no cache to inherit.
     */
    await page.getByTestId("open-batch-cycle-batch").click();
    await expect(page.getByTestId("gallery")).toBeVisible();
    const tiles = page.getByTestId(/^tile-/);
    await expect(tiles).toHaveCount(3);
    const assetId = (await tiles.first().getAttribute("data-testid"))!.replace("tile-", "");
    await tiles.first().getByTestId(`open-${assetId}`).click();
    await expect(page.getByTestId("annotation-page")).toBeVisible();

    await expect(page.getByTestId("readonly-banner")).toContainText(/viewing only/i);
    await expect(page.getByTestId("banner-create-correction")).toBeVisible();
    await expect(page.getByTestId("tool-select")).toHaveCount(0);
    await expect(page.getByTestId("tool-hand")).toHaveCount(1);
    // The classes region leaves the viewer entirely — and the add-a-class doors
    // go with it rather than being disabled.
    await expect(page.getByTestId("class-region")).toHaveCount(0);

    // A full draw gesture writes nothing and dirties nothing.
    const canvas = page.getByTestId("annotator-canvas");
    const box = (await canvas.boundingBox())!;
    await page.getByTestId("annotator-root").focus();
    await page.keyboard.press("1");
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId("save-state")).toContainText("Saved");

    // The address bar is the second entry: a cold load of the same job answers
    // the same mode, with nothing inherited from the session above.
    await page.reload();
    await expect(page.getByTestId("readonly-banner")).toContainText(/viewing only/i);

    await openProject(page, PROJECT, "batches");
    await expect(page.getByTestId("batches-table")).toBeVisible();
  });

  await test.step("promote the completed batch into the trunk", async () => {
    // The trunk carries assets only, and promotion is a **union** against current
    // membership — idempotent, with no log entry when nothing changed.
    //
    // **This used to assert the button's label flipped to "Promoted", and that
    // was the whole of the feedback.** A label flip is not a report: it could not
    // say how many assets moved, it could not tell a first press from a repeat,
    // and it made a second press look forbidden when it is merely a no-op.
    // Promotion is not a transition either, so nothing else on the row could
    // move — which is how a working call came to read as a broken button.
    await page.getByTestId("promote-cycle-batch").click();

    const said = page.getByTestId("promoted-cycle-batch");
    await expect(said).toBeVisible({ timeout: 30_000 });
    // Three assets annotated in the step above, and every one of them promotable.
    await expect(said).toHaveText(/Promoted 3 assets/);
    // The button stays a button, so the batch can be promoted again after a
    // curator removes something.
    await expect(page.getByTestId("promote-cycle-batch")).toHaveText(/Promote/);
  });

  await test.step("the trunk count survives a reload, which the response cannot", async () => {
    // The other half of making promotion observable: the response says what *this
    // press* did and is gone on the next render, while `promoted_asset_count` is
    // derived per read and is still right in a session that did no promoting.
    await page.reload();
    await expect(page.getByTestId("batches-table")).toBeVisible();
    await expect(page.getByTestId("promoted-count-cycle-batch")).toHaveText(
      /3 of 3 in the dataset/,
    );
  });

  await test.step("correct the completed batch, forward-only", async () => {
    /*
     * **The end of the forward-only story** (audit G6), against the real kernel.
     *
     * A completed batch has no exit and none is coming, so the product's answer
     * to "this frame is wrong" is a new batch over the same frames recording
     * where it came from. Three surfaces had been saying so while nothing could
     * create one; this is the control they were pointing at.
     *
     * Run here rather than against stubs because the two claims worth making are
     * about the kernel: that the parent is genuinely untouched, and that the
     * child pins the project's *active* schema at its own approval rather than
     * inheriting the parent's.
     */
    await page.getByTestId("correct-cycle-batch").click();
    await expect(page.getByTestId("correction-dialog")).toBeVisible();
    // The suggested name is the parent's, so the ordinary case costs no typing.
    await expect(page.getByTestId("correction-name")).toHaveValue(/cycle-batch/);
    await page.getByTestId("correction-submit").click();

    // It navigates to the correction it just made, and that batch says what it
    // corrects. One hop: the child names its parent, and a reader walks the
    // chain for the origin.
    await expect(page.getByTestId("gallery")).toBeVisible();
    await expect(page.getByTestId("correction-of")).toContainText("Correction of cycle-batch");
    await expect(page.getByTestId("batch-state")).toHaveText("pending approval");

    // And the parent has not moved — which is the whole point of correcting
    // forward instead of reopening.
    await openProject(page, PROJECT, "batches");
    await expect(page.getByTestId("state-cycle-batch")).toHaveText("completed");
    await expect(page.getByTestId("promoted-count-cycle-batch")).toHaveText(
      /3 of 3 in the dataset/,
    );
  });

  await test.step("delete a batch, and watch the trunk not move", async () => {
    /*
     * **Deleting a batch, against the real kernel** — the half a stubbed run
     * cannot make.
     *
     * Two claims, and both are about the server's own answer rather than about
     * this client's rendering. First: what the overflow offers is
     * `allowed_actions` as the kernel computed it, so the completed parent shows
     * the item **disabled with its reason** while a draft shows it live. Second,
     * and the one worth a real database: deleting a batch over frames that are
     * already in the trunk takes **nothing** out of it — annotations hang off
     * assets, so the unit of work goes and the work stays.
     *
     * The subject is a second correction, cut and then thrown away, so the walk
     * below still has the first one to carry on with.
     */
    await expect(page.getByTestId("batch-overflow-cycle-batch")).toBeVisible();
    await page.getByTestId("batch-overflow-cycle-batch").click();
    const withheld = page.getByTestId("delete-batch-cycle-batch");
    await expect(withheld).toBeVisible();
    await expect(withheld).toHaveAttribute("data-disabled", "");
    await expect(page.getByTestId("delete-withheld-cycle-batch")).toContainText(
      "correction batch",
    );
    await page.keyboard.press("Escape");

    await page.getByTestId("correct-cycle-batch").click();
    await page.getByTestId("correction-name").fill("doomed");
    await page.getByTestId("correction-submit").click();
    await expect(page.getByTestId("gallery")).toBeVisible();

    // From the gallery, which is the mount whose subject stops existing — so it
    // must land on the Batches tab rather than on its own dead URL.
    await page.getByTestId("batch-overflow-doomed").click();
    await page.getByTestId("delete-batch-doomed").click();
    await expect(page.getByTestId("delete-batch-dialog")).toContainText("The annotations stay.");
    await page.getByTestId("delete-batch-submit").click();

    await expect(page.getByTestId("batches-table")).toBeVisible();
    await expect(page.getByTestId("batch-doomed")).toHaveCount(0);
    // The parent, its promotion and the trunk are all exactly where they were.
    await expect(page.getByTestId("state-cycle-batch")).toHaveText("completed");
    await expect(page.getByTestId("promoted-count-cycle-batch")).toHaveText(
      /3 of 3 in the dataset/,
    );
  });

  await test.step("publish a release", async () => {
    // **A tab, reached in one press.** It was behind the header's overflow menu,
    // which is where a destination goes when the navigation has no room for it —
    // and the trunk is the product's central object, so that was the wrong shape
    // rather than a tidy one.
    await page.getByTestId("nav-dataset").click();
    await expect(page.getByTestId("dataset-stats")).toContainText("3");
    await expect(page.getByTestId("dataset-screen")).toBeVisible();

    // A lane is counted like any other annotation. `DatasetStats.per_class`
    // is derived per call from what the trunk actually holds, so a geometry the
    // counter did not know about would simply be absent — and absent reads as "no
    // lanes were labelled", which is the failure mode worth an assertion.
    await expect(page.getByTestId("class-count-centerline")).toContainText("1");

    await page.getByTestId("publish-release").click();
    await page.getByTestId("release-tag").fill(TAG);
    await page.getByTestId("publish-submit").click();
    // The new release lands on the Releases view; the dialog was opened from
    // the header, which every view shares.
    await page.getByTestId("dataset-tab-releases").click();
    await expect(page.getByTestId(`release-${TAG}`)).toBeVisible();
  });

  await test.step("verify the release re-reads every blob", async () => {
    await page.getByTestId(`verify-${TAG}`).click();
    // Re-read and re-hashed, not `is_file()` — which is why this is a button and
    // not something the list does on render.
    await expect(page.getByTestId(`verified-${TAG}`)).toContainText("Intact");
  });

  await test.step("walk the correction through, and watch the trunk follow it", async () => {
    /*
     * **Trunk supersession, end to end** (audit G5, settled 2026-08). The policy
     * is asset-level replacement with corrections seeded on approval, and every
     * claim in it is about what a person *sees*, so this is where it is proved.
     *
     * The correction batch was created several steps up; `v1` has since been
     * published and verified. What follows is the rest of the story: approve it,
     * find the earlier round's labels already drawn, change them, promote, and
     * check that the trunk moved while the release did not.
     *
     * The three assertions worth naming in advance, because each of them failed
     * before this task or could not be made at all:
     *
     * 1. the correction's frames read as **annotated with N boxes**, not
     *    "Unannotated" — they were `unannotated` while displaying labels, which
     *    is the lie the seeding rule removes;
     * 2. a box deleted here is **gone from the trunk**, class and all —
     *    replacement rather than accumulation, which is what makes deletion
     *    expressible at all; and
     * 3. an asset the correction left alone still shows the parent round's
     *    labels, so replacement is per asset and not collateral.
     *
     * What is *not* here: editing a label in place, which needs two classes of
     * one geometry and this schema has none. It is pinned in
     * `tests/kernel/test_trunk_supersession.py` instead, where a reclass through
     * `AnnotationService.update` is one line.
     */
    await openProject(page, PROJECT, "batches");
    // `defaultCorrectionName` built this, and the dialog above was submitted
    // with it untouched. Spelled out rather than read back off the row so a
    // rename of the suggestion is a failure here rather than a silent pass.
    const CORRECTION = "cycle-batch — correction";
    await expect(page.getByTestId(`state-${CORRECTION}`)).toHaveText("pending approval");

    await page.getByTestId(`approve-${CORRECTION}`).click();
    await page.getByTestId("approve-submit").click();
    await expect(page.getByTestId(`state-${CORRECTION}`)).toHaveText("approved");
    // The child pins the project's *active* version at its own approval rather
    // than inheriting the parent's. They are the same number here — **v3**, after
    // the two additive publishes above, both of which moved the parent onto them
    // as well — so the claim this makes is that it pinned, not that it copied.
    // Distinguishing the two needs a parent that is *behind*, which only a
    // narrowing version can produce, and that belongs to the kernel suite rather
    // than to a walk through the app.
    await expect(page.getByTestId(`batch-${CORRECTION}`)).toContainText("v3");
    await page.getByTestId(`start-${CORRECTION}`).click();
    await expect(page.getByTestId(`state-${CORRECTION}`)).toHaveText("in progress");

    await page.getByTestId(`open-batch-${CORRECTION}`).click();
    await expect(page.getByTestId("gallery")).toBeVisible();

    // (1) Seeded. Nothing was copied to make this true — annotations hang off an
    // `asset_id`, so the labels were already on these frames; what approval
    // added is the honest progress. A tile only counts its boxes once its
    // progress says there are some to count, which is exactly why the old
    // `unannotated` was not a cosmetic problem.
    const tiles = page.getByTestId(/^tile-/);
    await expect(tiles).toHaveCount(3);
    const corrected = (await tiles.first().getAttribute("data-testid"))!.replace("tile-", "");
    const untouched = (await tiles.nth(2).getAttribute("data-testid"))!.replace("tile-", "");
    await expect(page.getByTestId(`state-${corrected}`)).toContainText("1 box");
    // The third frame carries the tag and the lane from the parent round.
    await expect(page.getByTestId(`state-${untouched}`)).toContainText("2 boxes");

    await tiles.first().getByTestId(`open-${corrected}`).click();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    // The parent's box, drawn, selectable and deletable — on a job that has
    // written nothing of its own.
    await expect(page.getByTestId("object-total")).toHaveText("1 object");
    await expect(page.getByTestId("object-row-0")).toContainText("vehicle");

    await page.getByTestId("object-delete-0").click();
    await expect(page.getByTestId("object-total")).toHaveText("0 objects");
    // And something of the correction's own, so the frame stays settled and the
    // trunk has an addition to show as well as a removal.
    await drawPolygon(page);
    await saveNow(page);
    await expect(page.getByTestId("save-state")).toContainText("Saved");

    // Out to the end of the job, because **Finish job renders on the
    // last frame only** — it is the filled slot there, and `Save and next` is the
    // filled slot everywhere else. Walking there is not incidental to this step:
    // it is the same save-first advance a person makes, over frames this
    // correction round left alone.
    await page.getByTestId("next-asset").click();
    await expect(page.getByTestId("asset-position")).toContainText("2/3");
    await page.getByTestId("next-asset").click();
    await expect(page.getByTestId("asset-position")).toContainText("3/3");

    await page.getByTestId("finish-job").click();
    await expect(page.getByTestId("finish-job")).toHaveText("Finished");

    await openProject(page, PROJECT, "batches");
    await page.getByTestId(`complete-${CORRECTION}`).click();
    await expect(page.getByTestId(`state-${CORRECTION}`)).toHaveText("completed", {
      timeout: 30_000,
    });

    // Promotion moves membership and nothing else, and these three frames are
    // already members — so the honest report is *nothing new*, not "promoted 3".
    // The labels moved when they were saved, which is the live half of the
    // policy and the part that surprises.
    await page.getByTestId(`promote-${CORRECTION}`).click();
    await expect(page.getByTestId(`promoted-${CORRECTION}`)).toHaveText(
      /Already in the dataset/,
      { timeout: 30_000 },
    );

    await page.getByTestId("nav-dataset").click();
    await expect(page.getByTestId("dataset-screen")).toBeVisible();
    // (2) The deleted box is gone from the trunk — and `vehicle` was the only one
    // of its class, so the row goes with it. `DatasetStats.per_class` lists only
    // classes that appear, which is what makes absence the assertable outcome.
    await expect(page.getByTestId("class-count-vehicle")).toHaveCount(0);
    // The correction's own polygon arrived beside the parent's.
    await expect(page.getByTestId("class-count-lane")).toContainText("2");
    // (3) The frame nobody opened still carries what the first round left.
    await expect(page.getByTestId("class-count-daytime")).toContainText("1");
    await expect(page.getByTestId("class-count-centerline")).toContainText("1");
    // Membership never moved: replacement is about labels, not about who is in.
    await expect(page.getByTestId("dataset-stats")).toContainText("3");

    // And the release is exactly where it was left. Its manifest is a frozen
    // blob and its hash is the contract, so a correction cannot reach back into
    // one already published — checked through `verify`, which re-reads and
    // re-hashes every blob rather than trusting the row it is compared against.
    // Re-entered through the navigation, so the dataset opened on Overview; the
    // release's controls live on its Releases view.
    await page.getByTestId("dataset-tab-releases").click();
    await page.getByTestId(`verify-${TAG}`).click();
    await expect(page.getByTestId(`verified-${TAG}`)).toContainText("Intact");
  });

  await test.step("export through the dummy format and download the archive", async () => {
    await page.getByTestId(`export-${TAG}`).click();
    await page.getByTestId("export-format").click();

    // The five lane plugins, discovered by the *running server* through the
    // real entry-point group rather than by an import in a test — and each
    // declaring itself lossy, which is the one thing the picker shows about a
    // format before you choose it. A lane format that arrived silently unmarked
    // would let somebody export a release believing nothing was dropped.
    for (const lane of [/tusimple/, /culane/, /openlane-2d/]) {
      await expect(page.getByRole("option", { name: lane })).toContainText("(lossy)");
    }

    await page.getByRole("option", { name: /dummy/ }).click();

    // **Three requests behind one click.** The launch answers 202 with
    // a job id, the screen polls `/background-jobs/{id}` until it succeeds, and
    // only then fetches the artifact and saves it. The assertion is unchanged
    // because the *outcome* is unchanged — which is the point of waiting on the
    // download event rather than on any of the steps that produce it.
    //
    // It is also the only place the whole queue runs for real: a spawned worker
    // opens this workspace, resolves the `dummy` exporter through the entry-point
    // group, and writes into `exports/`. Every other test of that path runs the
    // handler inline.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-submit").click(),
    ]);
    await expectArchive(download);
  });

  await test.step("edit the connection, and watch the row answer for it", async () => {
    /*
     * A stub cannot referee this body, because it is written by whoever wrote
     * the body — only a real server, checking the request against
     * `ConnectionUpdate`, can catch a field the dialog serialises but the
     * schema forbids. Two edits, because the kernel compares the model
     * reference rather than asking whether it was supplied: a rename carries
     * that reference too, so only a real PATCH tells apart the repin that must
     * undo setup from the rename that must not. Last in the walk and nothing
     * is put back, since no later step reads this connection.
     */
    // The export dialog is still up, and deliberately: it holds the outcome so
    // the badge can announce it once the poll has stopped, which means it closes
    // the way every other dialog here does rather than on its own. So this step
    // starts by doing what the person who has just taken the download does. The
    // walk dismisses a dialog this way once already, in the delete step.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("export-dialog")).toHaveCount(0);

    await page.getByTestId("rail-models").click();
    await expect(page.getByTestId("models-screen")).toBeVisible();
    // Two locators because the row's id is its name and the rename moves it.
    const before = page.getByTestId(`connection-${STAND_IN}`);
    const after = page.getByTestId(`connection-${REPINNED}`);
    await expect(before.getByTestId("connection-status")).toContainText(/ready/i);

    // A rename, which sends the model reference the row already has. That it is
    // *accepted* is the half that would have caught a PATCH carrying the kind;
    // that the row is still ready afterwards is the half that catches a server
    // reading "supplied" as "moved".
    await page.getByTestId(`actions-${STAND_IN}`).click();
    await page.getByTestId("action-edit").click();
    await page.getByTestId("connection-name").fill(REPINNED);
    await page.getByTestId("connection-submit").click();

    // The dialog closes only on success — a refusal leaves it open holding what
    // was typed — so its absence is the first thing that says the server took
    // the body.
    await expect(page.getByTestId("connection-dialog")).toHaveCount(0);
    await expect(after).toBeVisible();
    await expect(after.getByTestId("connection-status")).toContainText(/ready/i);

    // And a reference that really does move. The revision is free text on a
    // connection — the commit-hash rule belongs to catalog entries, which is why
    // the setup step above could pin this one to `stub` at all.
    await page.getByTestId(`actions-${REPINNED}`).click();
    await page.getByTestId("action-edit").click();
    await expect(page.getByTestId("connection-revision")).toBeVisible();
    await page.getByTestId("connection-revision").fill("stub-repinned");
    await page.getByTestId("connection-submit").click();

    await expect(page.getByTestId("connection-dialog")).toHaveCount(0);
    await expect(after.getByTestId("connection-status")).toContainText(/not set up/i);

    // The remedy is offered on the row it happened to, which is the other half
    // of what "undoes its setup" is allowed to mean.
    await expect(after.getByTestId("download-weights")).toBeVisible();
  });

  await test.step("the whole walk produced a clean console", async () => {
    // Last, so it covers everything above rather than one screen — every
    // navigation, reload, viewport change and download the walk performs — and
    // the browser should have had nothing to say about any of it.
    //
    // **Stated rather than implied: headless chromium does not request
    // `/favicon.ico` on its own**, so this assertion cannot reproduce the original
    // symptom — a headed browser asks, a headless one does not, and
    // removing the `<link>` leaves this passing. Verified, not assumed.
    //
    // What it does hold is the property the issue is actually after: the walk
    // produces no console error and no failed resource load, so a *new* one has
    // silence to stand out against instead of a permanent line. The icon itself is
    // guarded by `tests/scripts/favicon.test.mjs` — which does fail when the link
    // goes — and by the request below.
    expect(consoleErrors).toEqual([]);
    expect(badRequests).toEqual([]);

    /*
     * **The aborted API calls, pinned rather than filtered away.**
     *
     * Both entries answer `204 No Content`, and Chromium reports every such
     * request as `net::ERR_ABORTED` — there is no body for the renderer to read,
     * so the network stack tears the stream down and files it as cancelled.
     * Measured, not assumed, for the first one: the deletion is committed (the
     * `vehicle` class disappeared from the trunk two steps up), `save-state`
     * read `Saved`, and the POST that follows it in `useSaveAnnotations` only
     * fires after the DELETE's `await` resolves. It is bookkeeping, not a
     * failure.
     *
     * `DELETE /batches/{id}` is the second `204` this client
     * sends; the step that calls it asserts the batch is gone from the table and
     * the trunk did not move, which is what "committed" means there. The
     * annotation delete had no coverage before this walk at all, because nothing
     * in the browser had ever deleted an annotation.
     *
     * Asserted as an exact list, in walk order: a *third* aborted call, or one on
     * another route, is the shape of a request the app really did abandon, and
     * that is worth failing on.
     *
     * Deliberate cancellations are the one exclusion, made at the collection
     * site: image-byte GETs (`/content`, `/thumbnail`) are aborted on unmount
     * on purpose (#572), and how many of them a walk produces is a matter of
     * navigation timing, not correctness.
     */
    expect(abortedApiCalls).toEqual([
      expect.stringMatching(/^DELETE .*\/batches\/[0-9a-f-]+$/),
      expect.stringMatching(/^DELETE .*\/annotations$/),
    ]);
    /*
     * **The refused API calls, pinned rather than merely tolerated.**
     *
     * Six 404s, all of them a screen asking for a document that does not exist
     * yet: `GET /projects/{id}/schema` and its curated draft sibling are the
     * schema editor's, opening on an empty draft for a project nobody has
     * given a schema; the annotation draft pair belongs to the annotator's
     * add-a-class dialog, gated on `addingClass` the same way. The walk asks
     * each pair twice — a mount, then the remount or `page.reload()` that
     * follows — because a saved draft is written straight into the cache
     * rather than invalidated, so writing one never triggers a second read by
     * itself. The project's id changes per run, so each is matched rather
     * than compared.
     *
     * The seventh entry is conditional on the installation, and is the reason this
     * list is worth pinning at all. `GET /inference/download-size` prices the
     * curated model the connection form seeds itself with, and reading that price
     * needs the optional local-inference runtime — so it answers 500 wherever the
     * extra is absent, which is what `browser cycle (chromium)` installs, and 200
     * wherever it is present. `curatedSizeRefused` carries what the form rendered,
     * so the expectation follows the installation instead of guessing at it.
     *
     * Anything else — a route that starts refusing, a 404 that becomes a 500, a
     * second refusal from a route allowed one — fails here with its method, its
     * path and its status in the message. Before this list existed every one of
     * them was added to a set, exempted from the console assertion, and never
     * looked at again.
     */
    const schema = /^GET \/projects\/[0-9a-f-]+\/schema 404$/;
    const curatedDraft = /^GET \/projects\/[0-9a-f-]+\/schema\/drafts\/curated 404$/;
    const annotationDraft = /^GET \/projects\/[0-9a-f-]+\/schema\/drafts\/annotation 404$/;
    expect(refusedApiCalls).toEqual([
      expect.stringMatching(schema),
      expect.stringMatching(curatedDraft),
      expect.stringMatching(schema),
      expect.stringMatching(curatedDraft),
      ...(curatedSizeRefused ? ["GET /inference/download-size 500"] : []),
      expect.stringMatching(annotationDraft),
      expect.stringMatching(annotationDraft),
    ]);
    // And the icon is genuinely served under the mount, rather than absent and
    // unnoticed: `vite preview` would answer 200 with `index.html` here, which is
    // the reason this is checked against the real server.
    const icon = await page.request.get("/app/favicon.svg");
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
 * a number somebody typed. The arithmetic is never the part that breaks; the
 * measurement is.
 */
async function columnsOf(page: Page): Promise<{ rendered: number; expected: number }> {
  await expect(page.getByTestId("gallery-row-0")).toBeVisible();
  return await page.evaluate(() => {
    const GAP = 12;
    // There is no nested scroller — the document scrolls — so the pane
    // is the grid itself, and the tile size is the density slider's rather than a
    // constant. `data-min-column` is the layout's *input*; `rendered` is its
    // output. Reading the count off `data-columns` would assert the value against
    // itself.
    const grid = document.querySelector('[data-testid="gallery-grid"]')!;
    const tile = Number(grid.getAttribute("data-min-column"));
    const rows = [...document.querySelectorAll('[data-testid^="gallery-row-"]')];
    const tiles = rows.reduce((count, row) => count + row.children.length, 0);
    const fits = Math.max(1, Math.floor((grid.clientWidth + GAP) / (tile + GAP)));
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
 * The schema, the batches and the dataset are sections of the project, so
 * "reach the batch table" is two clicks rather than one. It is clicked rather
 * than reached by its URL, for the same reason nothing here types a URL: a step
 * that navigates by address cannot notice that the control is missing.
 */
async function openProject(
  page: Page,
  project: string,
  section: "schema" | "batches" | "dataset",
): Promise<void> {
  await page.getByTestId("rail-projects").click();
  await expect(page.getByTestId(`open-${project}`)).toBeVisible();
  await page.getByTestId(`open-${project}`).click();
  await expect(page.getByTestId("project-screen")).toBeVisible();
  await page.getByTestId(`nav-${section}`).click();
}

/*
 * There is deliberately no `jobIdOf` helper reading the job id out of the API so
 * the spec can `page.goto('./jobs/' + id)`. That helper *is* the workaround — a
 * suite that fetches an id the product never shows cannot notice that the product
 * never shows it. The annotator is reached the way a person reaches it.
 */

/**
 * Pick a class and **wait until it is active**.
 *
 * Through the panel's class list rather than the digit, and the difference is
 * not cosmetic: a hotkey's effect reaches the machine through the host's own state,
 * so a press and a drag issued back to back can both be seen while the old class is
 * still current. The row marks itself selected, which turns that into something to
 * wait on — and it is also how a person picks a class.
 *
 * The cycle lost a run to exactly this before the wait existed.
 *
 * The list lives in the side panel; the reason for the wait is the same wherever
 * it is.
 */
async function activate(page: Page, name: string): Promise<void> {
  // The **name**, not the row. Once a class accepts more than one shape its armed
  // row carries a shape picker, and a click on the row's centre lands on whichever
  // control happens to be there — which for a long enough name is a shape segment,
  // switching the tool while `data-selected` below still reads true.
  await page.getByTestId(`class-row-${name}-name`).click();
  await expect(page.getByTestId(`class-row-${name}`)).toHaveAttribute("data-selected", "true");
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
