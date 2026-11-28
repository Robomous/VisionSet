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
 * ## What it deliberately does not do
 *
 * **The source is images, not a video.** The issue says "generated video"; video is
 * now a browser capability rather than a server one, so the two paths no longer share
 * a pipeline to sample here at all. Decoding is covered where it happens —
 * `@visionset/media`'s own Chromium suite and the ingest screen's component tests —
 * and the whole browser-to-batch walk has its own spec. Buying a real decode inside
 * this five-minute budget would re-test that for coverage that already exists.
 * Recorded rather than skipped quietly.
 *
 * **The export is addressed to a target, and the archive is opened.** The release
 * holds a box, a polygon and a polyline; `yolo11` takes the first two and drops the
 * third, so the walk meets the real lossy consent — the sentence naming the target
 * and the count — before the archive arrives, and then reads `data.yaml` out of
 * the download to see the class map the trainer would.
 *
 * **And once more through a pre-processing recipe.** Written from the release's
 * Export section in the recipe's modal, and chosen there; the second archive is opened
 * for the report that names the recipe under its hash and for the train
 * fold's augmented variant beside its source.
 */

import { expect, test, type Download, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { focusCanvas, saveNow } from "../e2e/_frame";
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

/** The recipe the walk writes, named on the second export and in its report. */
const RECIPE = "yolo-640";

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
 * moves two test ids at once — the connection's row is `connection-{name}` and the
 * name that opens its sheet is `open-{name}` — so the new name is read in three places and a
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
 * previous attempt's projects and dies on the project list's empty state — an
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
  // The job's own address, noted while it is reached by clicking. A *finished* job's card in
  // the batch panel says "Done" and has no door, so the viewer a completed batch reopens as is
  // reached by address alone; the road in is still the one the app itself produced.
  let jobAddress = "";
  // The app's calls still in flight. A reload or a typed address tears down
  // whatever the page is reading or writing, and the aborted list below pins
  // every torn-down call as one the *app* abandoned — so the walk lets the page
  // fall quiet before it throws the page away, and what the list still catches
  // is the app's own doing.
  const inFlight = new Set<Request>();
  page.on("request", (request) => {
    const kind = request.resourceType();
    if (kind === "fetch" || kind === "xhr") inFlight.add(request);
  });
  page.on("requestfinished", (request) => inFlight.delete(request));
  page.on("requestfailed", (request) => inFlight.delete(request));
  const settled = (): Promise<void> => quiet(inFlight);
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
    // From the project list, which is where `/` lands: there is no Home page.
    await expect(page.getByTestId("projects-screen")).toBeVisible();
    await page.getByTestId("new-project").click();
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
    // The open-project tab names it; no eyebrow line is drawn over the content.
    await expect(page.getByTestId(/^open-tab-[0-9a-f-]{36}$/)).toContainText(PROJECT);
    await expect(page.getByTestId("project-title")).toHaveCount(0);
  });

  await test.step("declare a schema with all four geometries", async () => {
    /*
     * A brand-new project opens on Overview, on **one** invitation chosen from
     * its real state — no schema and no images, so the invitation is the ingest
     * one, and the page's only filled button is the toolbar's Add images. The other
     * order is a link beneath it, and this run walks that link rather than the
     * tab bar: a schema first is the road the invitation names as not taken,
     * and the walk proves it is a real road.
     *
     * The count is asserted here rather than in a unit test because "exactly
     * one filled button on the page" is a claim about the whole composed screen,
     * and the header lives outside the panel that owns the invitation.
     */
    await expect(page.getByTestId("overview-empty")).toBeVisible();
    await expect(page.getByTestId("first-run")).toHaveAttribute(
      "data-invitation",
      "ingest-first",
    );
    await expect(page.locator("button.bg-primary")).toHaveCount(1);
    // An empty Overview has no batches band, so the invitation's Add images is the one.
    await expect(page.getByTestId("overview-ingest")).toHaveClass(/bg-primary/);
    // And the retired checklist is gone rather than merely dismissed.
    await expect(page.getByTestId("journey-checklist")).toHaveCount(0);

    await page.getByTestId("first-run-alt").click();
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
        // Press the wanted shape *before* clearing the default, which is also the
        // only order the control permits: a class never passes through accepting
        // nothing, so the last pressed toggle refuses to come off.
        await page.getByTestId(`class-geometry-${index}-${geometry}`).click();
        await page.getByTestId(`class-geometry-${index}-bbox`).click();
      }
      // New class opened the class sheet on a blank class, with focus in its name.
      // Nothing is in the draft until it is submitted, which also puts it away
      // before the next class is added.
      await page.getByTestId("class-sheet-done").click();
      await expect(page.getByTestId("class-sheet")).toHaveCount(0);
    }

    /*
     * One class, two shapes, against a real `create_version` (#584).
     *
     * The whole point of a geometry set is that a class labelled as a box on some
     * frames and as an outline on others is one class — and the only place that
     * can be shown end to end is here, where the kernel actually judges the
     * document. `vehicle` keeps its box and gains a polygon.
     */
    await page.getByTestId("class-card-0").click();
    await page.getByTestId("class-geometry-0-polygon").click();
    await expect(page.getByTestId("class-geometry-0-bbox")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("class-geometry-0-polygon")).toHaveAttribute("aria-pressed", "true");
    // The shape reaches the draft on Save, not on the click.
    await page.getByTestId("class-sheet-done").click();
    await expect(page.getByTestId("class-sheet")).toHaveCount(0);

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
    await settled();
    await page.reload();
    await expect(page.getByTestId("schema-editor")).toContainText("Saving creates version 1");
    for (const name of ["vehicle", "lane", "daytime", "centerline"]) {
      await expect(page.getByTestId("class-list")).toContainText(name);
    }
    // The two shapes on `vehicle` survive too, so what came back is the draft as
    // edited rather than a re-seed from the four names alone.
    await page.getByTestId("class-card-0").click();
    await expect(page.getByTestId("class-geometry-0-bbox")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("class-geometry-0-polygon")).toHaveAttribute("aria-pressed", "true");
    // Nothing was changed, so Save just closes the dialog.
    await page.getByTestId("class-sheet-done").click();
    await expect(page.getByTestId("class-sheet")).toHaveCount(0);

    // The draft holds four classes the project has never published, so the
    // commit bar is up, offering version 1.
    await expect(page.getByTestId("commit-bar")).toHaveAttribute("data-state", "up");
    await page.getByTestId("save-schema").click();
    // Published, the draft matches the version in force and the bar goes down.
    // The history is a view *of* the schema rather than a peer of it: one press
    // away in the section's band, not a fourth tab.
    await expect(page.getByTestId("commit-bar")).toHaveAttribute("data-state", "down");
    await expect(page.getByTestId("open-history")).toHaveAttribute("aria-label", /version 1/);
    await page.getByTestId("open-history").click();
    await expect(page.getByTestId("version-history")).toBeVisible();
    await expect(page.getByTestId("version-1")).toBeVisible();
    await expect(page.getByTestId("version-1")).toContainText("Active");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("history-sheet")).toHaveCount(0);
  });

  await test.step("ingest three images into a new batch", async () => {
    // Add images is a button on Overview and Images; from Classes, where the
    // schema was just saved, it is the overflow's first entry.
    await page.getByTestId("project-menu").click();
    await page.getByTestId("menu-ingest").click();
    // A dialog over the section it was asked from, held open by the address.
    await expect(page.getByRole("dialog", { name: "Add images" })).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/schema\?add=images$/);
    await page.getByTestId("file-input").setInputFiles(images());
    await expect(page.getByTestId("chosen")).toContainText("3 images");

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
    await expect(page.getByTestId("run-outcome")).toContainText("“cycle-batch” is ready, as a draft");
    // The batch's own count, not the run's: content addressing could have made
    // it fewer than the files read.
    await expect(page.getByTestId("run-outcome")).toContainText("It holds 3 images.");
    // The project declared a schema before this ingest, so the step's filled
    // control is the approval, made in place — and *Open* sits on the outcome
    // beside it. The walk keeps to the panel's road below, which is the one
    // that exercises the batch's own approve dialog.
    await expect(page.getByTestId("approve-open")).toHaveAttribute("data-variant", "default");
    await expect(page.getByTestId("ingest-another")).toBeVisible();
    await expect(page.getByTestId("approve-needs-schema")).toHaveCount(0);
    await page.getByTestId("open-batch").click();
    // A batch has no page of its own: it opens in the Overview's panel, so "Open"
    // lands on the Overview with the batch it names already open — and the
    // dialog closes on the way, since the address no longer holds it.
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/overview\?batch=[0-9a-f-]+$/);
    await expect(page.getByRole("dialog", { name: "Add images" })).toHaveCount(0);
    await expect(page.getByTestId("batch-sheet").getByRole("heading", { level: 2, name: "cycle-batch" })).toBeVisible();
  });

  await test.step("a draft batch's panel offers approval, and has no jobs to open", async () => {
    // Before approval there are no jobs, so there is nowhere to annotate: the panel
    // says so and offers the one step that cuts them. What it offers is the batch's
    // own `allowed_actions` as the kernel computed them — against a real server, so the
    // draft's declarations are the kernel's answer rather than a fixture's.
    const panel = page.getByTestId("batch-sheet");
    await expect(panel.getByTestId("batch-phase")).toHaveText("Draft");
    await expect(panel.getByTestId("batch-sheet-jobs")).toContainText("No jobs yet");
    await expect(panel.getByTestId(/^batch-sheet-job-/)).toHaveCount(0);
    await expect(panel.getByTestId("approve-batch")).toBeVisible();
    // No route into the annotator, and nothing to start, complete or promote yet.
    await expect(panel.getByTestId("sheet-annotate")).toHaveCount(0);
    await expect(panel.getByTestId("start-batch")).toHaveCount(0);
    await expect(panel.getByTestId("complete-cycle-batch")).toHaveCount(0);
    await expect(panel.getByTestId("promote-cycle-batch")).toHaveCount(0);
  });

  await test.step("approve the batch, which pins the schema and cuts one job", async () => {
    // Navigated rather than `goBack()`: history depth is an implementation detail
    // of how the previous steps got here, and a cycle this long should not depend
    // on it.
    await openProject(page, PROJECT, "overview");
    await expect(page.getByTestId("overview-batches")).toBeVisible();
    const row = page.getByTestId("overview-batch-cycle-batch");
    await expect(row).toContainText("Draft");
    await expect(page.getByTestId("batch-sheet")).toHaveCount(0);
    // A draft's row opens its approval, not its panel: approving is the one thing a
    // draft is opened for. Opening it moves nothing and navigates nowhere.
    await row.locator("[data-row-open]").click();
    await expect(page.getByTestId("approve-dialog")).toBeVisible();
    await expect(page.getByTestId("batch-sheet")).toHaveCount(0);
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/overview$/);
    // Switched off: the next step drives the panel's own Start annotating.
    await page.getByTestId("approve-start").click();
    await page.getByTestId("approve-submit").click();
    // Approved, the panel opens on the batch, at its next step.
    const panel = page.getByTestId("batch-sheet");
    await expect(panel.getByRole("heading", { level: 2, name: "cycle-batch" })).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/overview\?batch=[0-9a-f-]+$/);
    await expect(panel.getByTestId("batch-phase")).toHaveText("Approved");

    await panel.getByTestId("start-batch").click();
    await expect(panel.getByTestId("batch-phase")).toHaveText("Labeling");

    // The version pins *at approval* — the Overview's row now names it, and the
    // batch reads as being labeled.
    await openProject(page, PROJECT, "overview");
    await expect(row).toContainText("Labeling");
    await expect(row).toContainText("v1");
  });

  await test.step("the panel's Annotate is the way in: the one job opens, and the arrow comes back to the batch", async () => {
    // Only the way in is driven here: the cycle server has no `text_detect` model,
    // so the pre-label half of the panel's controls is exercised against the
    // server suite.
    await openBatch(page, PROJECT, "cycle-batch");
    const panel = page.getByTestId("batch-sheet");
    // The panel's top bar holds the batch's moves. The closing move, *Complete*, is
    // not declared while frames are still to do, so it is withheld with its count.
    await expect(panel.getByTestId("complete-cycle-batch")).toBeDisabled();
    // Approved with no partition, the batch has one job: one card, nobody holding it.
    const jobs = panel.getByTestId("batch-sheet-jobs");
    await expect(jobs.getByTestId(/^batch-sheet-job-/)).toHaveCount(1);
    await expect(jobs.getByTestId("batch-sheet-job-Job 1")).toContainText("Unassigned");
    // The forward step — the one the panel opens on — is Annotate while there is work
    // left; every control in the bar is quiet. With exactly one job it goes straight
    // into the editor.
    const annotate = panel.getByTestId("sheet-annotate");
    await expect(annotate).toHaveAttribute("data-autofocus", "");
    await annotate.click();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    // The job names no frame, so it opens on its first — and the annotator then
    // writes the frame it is showing into the address, as it does after any
    // walk, which is why `?asset=` may already be there.
    await expect(page.getByTestId("asset-position")).toContainText("1/3");
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+(\?asset=[0-9a-f-]+)?$/);
    // The arrow goes up to the batch, which is the Overview with its panel open.
    await page.getByTestId("back").click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/overview\?batch=[0-9a-f-]+$/);
    await expect(page.getByTestId("batch-sheet").getByRole("heading", { level: 2, name: "cycle-batch" })).toBeVisible();
  });

  await test.step("reach the annotator by clicking, on the frame that was chosen", async () => {
    // **The annotator is reached by clicking, and that is the reason this step
    // exists.** `page.goto('./jobs/' + id)` with the id read out of the API makes
    // a defect that blocks the whole product invisible to a green suite.
    // Nothing here types a URL.
    await openBatch(page, PROJECT, "cycle-batch");
    await page.getByTestId("batch-sheet").getByTestId("sheet-annotate").click();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.getByTestId("asset-position")).toContainText("1/3");

    // The grid button switches frames without leaving: an overlay over the
    // workspace, the URL unmoved, and Escape returning to exactly the frame that
    // was on screen.
    const inTheEditor = page.url();
    await page.getByTestId("open-gallery").click();
    await expect(page.getByTestId("frame-gallery")).toBeVisible();
    expect(page.url()).toBe(inTheEditor);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("frame-gallery")).toHaveCount(0);
    await expect(page.getByTestId("asset-position")).toContainText("1/3");

    // The **third** frame, so "it opened the job" and "it opened this frame" cannot
    // be confused: a page that ignored the click would still show 1/3. By its
    // position, through the overlay's own tile, because the batch no longer shows its
    // frames anywhere but here.
    await page.getByTestId("open-gallery").click();
    await page.getByRole("button", { name: /^Frame 3,/ }).click();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.getByTestId("asset-position")).toContainText("3/3");
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+\?asset=[0-9a-f-]+$/);
    const chosen = new URL(page.url()).searchParams.get("asset");

    // The only honest way to check the deep link: reload the
    // URL **the app itself produced**, which is a fresh `GET /app/jobs/<id>?asset=`
    // at the server and therefore drives the SPA deep-link fallback for real. A
    // typed `page.goto('./jobs/…')` would assert the same thing while reopening
    // the door this task closed.
    await settled();
    await page.reload();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.getByTestId("asset-position")).toContainText("3/3");
    expect(new URL(page.url()).searchParams.get("asset")).toBe(chosen);

    // And back to the batch, from the arrow. Leaving is still a thing you can
    // do; it is not the only way to look at your own frames.
    await page.getByTestId("back").click();
    await expect(page.getByTestId("batch-sheet").getByRole("heading", { level: 2, name: "cycle-batch" })).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/overview\?batch=[0-9a-f-]+$/);
  });

  await test.step("set up a connection to the built-in stand-in", async () => {
    /*
     * **Auto-labeling had no coverage against a real server at all**, which is
     * how a defect that made every suggestion a 500 passed a full green run.
     * The obstacle was always the weights: the models that answer a point
     * prompt are gigabytes and one of them is gated, so no scenario could fetch
     * one on a runner.
     *
     * `visionset/stub-segmenter` is the shipped no-op that closes it. Every
     * hop below is the product's own: the form, the download action, the
     * connection's lifecycle. Only the thing at the far end predicts nothing.
     */
    await putAwayPanel(page);
    await page.getByTestId("rail-models").click();
    await expect(page.getByTestId("models-screen")).toBeVisible();

    await page.getByTestId("new-connection").click();
    await page.getByTestId("connection-name").fill(STAND_IN);

    // Through **Custom model**, which is the point of it not being in the
    // curated list: nobody choosing a model is offered a segmenter that cannot
    // segment, and anybody who needs it can still name it.
    //
    // The list only exists once the real `/inference/providers` read has
    // answered — wait for it rather than racing the click against that request.
    await expect(page.getByTestId("connection-model")).toBeVisible();

    // Whether the list lands on a curated model, or falls back to Custom
    // model with an empty id, is a catalog fact `connection-model` being
    // visible does not settle: `defaultEntry` seeds the first entry that
    // answers a point prompt, but returns `undefined` when none does, and
    // the size line renders nothing for an empty id — so the wait below
    // would die on a bare, undiagnosable timeout on such an installation.
    // Assert the seed landed on a curated model before waiting on the price
    // probe only a curated model triggers.
    await expect(
      page.getByTestId("connection-model").getByRole("radio", { checked: true }),
    ).not.toHaveText(/Custom model/);

    // Let the seeded model's size probe settle before moving off it: clicking
    // through the list faster than that request resolves leaves the
    // refusal landing at whatever point the dialog happens to unmount, which
    // is the difference between a pinned list and a flaky one. Waiting is
    // also what makes the answer readable — `size-known` and
    // `size-unavailable` are the form's own two outcomes, and the final step
    // expects a refusal from this route exactly when the second one is what
    // rendered.
    const sizeLine = page.getByTestId(/^size-(known|unavailable)$/);
    await expect(sizeLine).toBeVisible();
    curatedSizeRefused = (await sizeLine.getAttribute("data-testid")) === "size-unavailable";

    await page.getByTestId("model-option-custom").click();
    await page.getByTestId("connection-custom-model").fill(STUB_MODEL_ID);
    await page.getByTestId("connection-revision").fill("stub");
    await page.getByTestId("connection-submit").click();

    // Born not set up, like every local connection, and made ready by the same
    // action — the lifecycle here is the real one, not a shortcut written for a
    // suite. What is different is only that there is nothing to fetch.

    // Read inside the card rather than off the screen. Both ids live inside a
    // connection's own card, so an unscoped read is sound only while the
    // workspace holds exactly one — and Playwright's strict mode then refuses
    // the locator, naming the selector instead of the assumption.
    const card = page.getByTestId(`connection-${STAND_IN}`);
    await expect(card.getByTestId("connection-status")).toContainText(/not set up/i);
    // The download is the model sheet's: the row is read, and its name opens
    // the sheet where the connection is set up.
    await card.getByTestId(`open-${STAND_IN}`).click();
    await expect(page.getByTestId("model-sheet")).toBeVisible();
    await page.getByTestId("download-weights").click();
    await expect(card.getByTestId("connection-status")).toContainText(/ready/i, {
      timeout: 15_000,
    });
    // The sheet is a modal layer over the page: put it away before the walk moves on.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("model-sheet")).toHaveCount(0);

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
     * row, while the download button is the sheet's and appears only before setup.
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
    await openBatch(page, PROJECT, "cycle-batch");
    await page.getByTestId("batch-sheet").getByTestId("sheet-annotate").click();
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
    await expect(page.getByTestId("save-state").filter({ hasText: /unsaved|Saving/ })).toHaveCount(0);

    // Back to the batch, because the step after this one starts there. A step
    // that leaves the walk somewhere its successor does not expect fails in the
    // successor, which is a long way from the line that caused it.
    await page.getByTestId("back").click();
    await expect(page.getByTestId("batch-sheet").getByRole("heading", { level: 2, name: "cycle-batch" })).toBeVisible();
  });

  await test.step("annotate all three assets", async () => {
    // Back in through the panel's Annotate, which opens on the first frame, because the
    // drawing below walks 1 → 2 → 3.
    await page.getByTestId("batch-sheet").getByTestId("sheet-annotate").click();
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
    await page.getByTestId("save-and-next").click();

    // 2 — a polygon, closed with Enter.
    await expect(page.getByTestId("asset-position")).toContainText("2/3");
    await drawPolygon(page);
    await saveNow(page);
    await expect(page.getByTestId("save-state")).toContainText("Saved");
    await page.getByTestId("save-and-next").click();

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
    // Next moves the frame without rewriting it. Reading `?asset=` here
    // addressed frame 1 while standing on frame 3, and every assertion that
    // followed still passed — the lane really was written, really did render, and
    // really was on the wrong picture. `data-asset` is what the page says about
    // itself.
    const origin = new URL(page.url()).origin;
    const jobId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
    jobAddress = `./jobs/${jobId}`;
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
    await settled();
    await page.goto(`./jobs/${jobId}?asset=${assetId}`);
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    // One: the lane. The tag on this frame is not an object, and the count says so.
    await expect(page.getByTestId("object-total")).toHaveText("1 object");
    // Still assigned, and still counted in its own region — excluding it from the
    // objects is not the same as losing it.
    await expect(page.getByTestId("tag-chip-daytime")).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("tag-count")).toHaveText("1 assigned");
    // The row is the class and its number; the shape is named only for a class
    // accepting more than one, where it is what tells two rows apart.
    await expect(page.getByTestId("object-row-0")).toContainText("centerline");
    await expect(page.getByTestId("object-row-0")).toContainText("#1");
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

    // 3d — a person marks the lane's middle vertex occluded, saves, and the mark
    // survives a reload: the visibility went to the server and came back, rather
    // than living in the browser's document. The release exported further down
    // carries it into OpenLane 2D.
    await page.getByTestId("object-select-0").click();
    await expect(page.getByTestId("vertex-occluded-count")).toHaveText("Not recorded");
    await page.getByTestId("vertex-toggle-1").focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("vertex-toggle-1")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-annotation-id] polyline[data-occluded="true"]')).toHaveCount(1);
    await saveNow(page);
    await expect(page.getByTestId("save-state")).toContainText("Saved");

    await settled();
    await page.reload();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.locator('[data-annotation-id] polyline[data-occluded="true"]')).toHaveCount(1);
    await page.getByTestId("object-select-0").click();
    await expect(page.getByTestId("vertex-toggle-1")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("vertex-occluded-count")).toHaveText("1 occluded");
    const stored = await page.request.get(`${origin}/jobs/${jobId}/assets/${assetId}/annotations`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    expect(stored.status()).toBe(200);
    const lane = (await stored.json()).items.find(
      (one: { geometry: { type: string } }) => one.geometry.type === "polyline",
    );
    expect(lane.geometry.visibility).toEqual([2, 1, 2]);
    await focusCanvas(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("vertex-region")).toHaveCount(0);

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

    await settled();
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

    // The class region's `+` — the rail no longer carries one.
    await page.getByTestId("class-add").click();
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
    // browser offered no way to make, so `review_pending` could only be
    // reached through the API and `accepted` was unreachable by clicking.
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
    // `accepted` is settled, so the count below still reads 3 of 3 — the readout
    // counts `SETTLED_PROGRESS`, which does not go backwards when a frame is
    // accepted. Read as `3 / 3`; the spaces are margins.
    await expect(page.getByTestId("job-progress")).toHaveAttribute("data-settled", "3");
    await expect(page.getByTestId("job-progress")).toHaveText("3/3");
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
    await openBatch(page, PROJECT, "cycle-batch");
    // Completing alone, so the walk can add to the dataset as its own step: the
    // confirmation's switch is turned off, and the press asks first.
    await page.getByTestId("complete-cycle-batch").click();
    await page.getByTestId("complete-add").setChecked(false);
    await page.getByTestId("complete-submit").click();
    // Completed, and not yet in the dataset: nothing has been promoted.
    await expect(page.getByTestId("batch-sheet").getByTestId("batch-phase")).toHaveText("Completed", {
      timeout: 30_000,
    });
  });

  await test.step("the completed batch reopens as a viewer, from the job's address", async () => {
    /*
     * The step a stubbed run cannot take: every earlier read-only claim runs
     * against stubs, so nothing proves that a *real* completed batch — whose
     * asset declarations the kernel computes — reopens as a viewer.
     *
     * The batch is read in its panel first, then the job is entered by the address
     * the app itself produced earlier in this walk: a finished job's card in the panel
     * says "Done" and offers no door, and the panel's *Annotate* is for work that is
     * still to do. The second road below, a reload with no cache to inherit, is as
     * before.
     */
    await openBatch(page, PROJECT, "cycle-batch");
    await expect(page.getByTestId("batch-sheet").getByTestId("batch-phase")).toHaveText("Completed");
    await expect(page.getByTestId("sheet-annotate")).toHaveCount(0);
    await settled();
    await page.goto(jobAddress);
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
    await expect(page.getByTestId("save-state")).toHaveCount(0);

    // The address bar is the second entry: a cold load of the same job answers
    // the same mode, with nothing inherited from the session above.
    await settled();
    await page.reload();
    await expect(page.getByTestId("readonly-banner")).toContainText(/viewing only/i);

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
    await openBatch(page, PROJECT, "cycle-batch");
    await page.getByTestId("promote-cycle-batch").click();

    const said = page.getByTestId("promoted-cycle-batch");
    await expect(said).toBeVisible({ timeout: 30_000 });
    // Three assets annotated in the step above, and every one of them promotable.
    await expect(said).toHaveText(/Added 3 \w+ to the dataset/);
    // The control keeps its place and its report, even though the batch is now
    // wholly in the dataset; a curator removing something brings it back.
    await expect(page.getByTestId("promote-cycle-batch")).toHaveAccessibleName("Add to dataset");
  });

  await test.step("the trunk count survives a reload, which the response cannot", async () => {
    // The other half of making promotion observable: the response says what *this
    // press* did and is gone on the next render, while `promoted_asset_count` is
    // derived per read and is still right in a session that did no promoting.
    await settled();
    await page.reload();
    // The open batch is the address's, so the reload lands on the same panel — and every
    // image of the batch is in the trunk, which is what the phase says now.
    await expect(page.getByTestId("batch-sheet").getByRole("heading", { level: 2, name: "cycle-batch" })).toBeVisible();
    await expect(page.getByTestId("batch-sheet").getByTestId("batch-phase")).toHaveText("In dataset");
    // Wholly in the dataset: *Add to dataset* is not offered, and the In dataset property counts all three.
    await expect(page.getByTestId("promote-cycle-batch")).toHaveCount(0);
    await expect(
      page.getByTestId("batch-sheet-more").locator("div", { has: page.locator("dt", { hasText: /^In dataset$/ }) }).locator("dd"),
    ).toHaveText(/^3 \w+$/);
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

    // The panel moves to the correction it just made, and that batch's row says what
    // it corrects: the Overview names a correction for its parent. One hop: the
    // child's name carries its parent's, and a reader walks the chain for the origin.
    const panel = page.getByTestId("batch-sheet");
    await expect(panel.getByRole("heading", { level: 2, name: "cycle-batch — correction" })).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/overview\?batch=[0-9a-f-]+$/);
    await expect(panel.getByTestId("batch-phase")).toHaveText("Draft");

    // And the parent has not moved — which is the whole point of correcting
    // forward instead of reopening. Still every image in the trunk.
    await openBatch(page, PROJECT, "cycle-batch");
    await expect(page.getByTestId("batch-sheet").getByTestId("batch-phase")).toHaveText("In dataset");
    // Wholly in the dataset: *Add to dataset* is not offered, and the In dataset property counts all three.
    await expect(page.getByTestId("promote-cycle-batch")).toHaveCount(0);
    await expect(
      page.getByTestId("batch-sheet-more").locator("div", { has: page.locator("dt", { hasText: /^In dataset$/ }) }).locator("dd"),
    ).toHaveText(/^3 \w+$/);
  });

  await test.step("delete a batch, and watch the trunk not move", async () => {
    /*
     * **Deleting a batch, against the real kernel** — the half a stubbed run
     * cannot make.
     *
     * Two claims, and both are about the server's own answer rather than about
     * this client's rendering. First: what the panel offers is
     * `allowed_actions` as the kernel computed it, so the completed parent —
     * which can never be deleted — draws its Delete disabled, with the reason,
     * while a draft shows it live. Second,
     * and the one worth a real database: deleting a batch over frames that are
     * already in the trunk takes **nothing** out of it — annotations hang off
     * assets, so the unit of work goes and the work stays.
     *
     * The subject is a second correction, cut and then thrown away, so the walk
     * below still has the first one to carry on with.
     */
    // A completed batch has no exit in the kernel's transitions and never declares
    // `delete`, so its panel withholds Delete with the reason; Correct is its way forward.
    await expect(page.getByTestId("correct-cycle-batch")).toBeVisible();
    const withheld = page.getByTestId("delete-batch-cycle-batch");
    await expect(withheld).toBeVisible();
    await expect(withheld).toBeDisabled();
    await withheld.focus();
    await expect(page.getByRole("tooltip").filter({ hasText: "correction batch" }).first()).toBeVisible();

    await page.getByTestId("correct-cycle-batch").click();
    await page.getByTestId("correction-name").fill("doomed");
    await page.getByTestId("correction-submit").click();
    await expect(
      page.getByTestId("batch-sheet").getByRole("heading", { level: 2, name: "doomed — correction" }),
    ).toBeVisible();

    // From the panel, whose subject stops existing — so it must close, and take its
    // `?batch=` with it, rather than be left pointing at a batch that is gone.
    await page.getByTestId("delete-batch-doomed").click();
    await expect(page.getByTestId("delete-batch-dialog")).toContainText("The annotations stay.");
    await page.getByTestId("delete-batch-submit").click();

    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/overview$/);
    await expect(page.getByTestId("batch-sheet")).toHaveCount(0);
    await expect(page.getByTestId("overview-batches")).toBeVisible();
    await expect(page.getByTestId("overview-batch-cycle-batch")).toBeVisible();
    await expect(page.getByTestId("overview-batch-doomed — correction")).toHaveCount(0);
    // The parent, its promotion and the trunk are all exactly where they were.
    await openBatch(page, PROJECT, "cycle-batch");
    await expect(page.getByTestId("batch-sheet").getByTestId("batch-phase")).toHaveText("In dataset");
    // Wholly in the dataset: *Add to dataset* is not offered, and the In dataset property counts all three.
    await expect(page.getByTestId("promote-cycle-batch")).toHaveCount(0);
    await expect(
      page.getByTestId("batch-sheet-more").locator("div", { has: page.locator("dt", { hasText: /^In dataset$/ }) }).locator("dd"),
    ).toHaveText(/^3 \w+$/);
  });

  await test.step("publish a release", async () => {
    // **A tab, reached in one press.** It was behind the header's overflow menu,
    // which is where a destination goes when the navigation has no room for it —
    // and the trunk is the product's central object, so that was the wrong shape
    // rather than a tidy one.
    await putAwayPanel(page);
    await page.getByTestId("nav-dataset").click();
    await expect(page.getByTestId("kpi-images")).toContainText("3");
    await expect(page.getByTestId("dataset-screen")).toBeVisible();

    // A lane is counted like any other annotation. `DatasetStats.per_class`
    // is derived per call from what the trunk actually holds, so a geometry the
    // counter did not know about would simply be absent — and absent reads as "no
    // lanes were labelled", which is the failure mode worth an assertion.
    await expect(classRow(page, "centerline")).toContainText("1");

    await page.getByTestId("publish-release").click();
    await page.getByTestId("release-tag").fill(TAG);
    // With folds, at the dialog's own fractions. Augmentation is written for
    // the train fold only, so the recipe export further down needs a release
    // that has one — and 0.7 of three assets puts two there.
    await page.getByTestId("use-split").check();
    await expect(page.getByTestId("split-hint")).toContainText("same seed gives the same folds");
    await page.getByTestId("publish-submit").click();
    // The new release joins the version list; opening it there puts its facts
    // at the top of the column. The dialog was opened from the project bar.
    await page.getByTestId(`version-${TAG}`).click();
    await expect(page.getByTestId(`release-${TAG}`)).toBeVisible();
  });

  await test.step("verify the release re-reads every blob", async () => {
    await page.getByTestId(`verify-${TAG}`).click();
    // Re-read and re-hashed, not `is_file()` — which is why this is a button and
    // not something the list does on render. The answer is the integrity row's state.
    await expect(page.getByTestId("state-integrity")).toHaveText("Intact");
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
    // `defaultCorrectionName` built this, and the dialog above was submitted
    // with it untouched. Spelled out rather than read back off the row so a
    // rename of the suggestion is a failure here rather than a silent pass.
    const CORRECTION = "cycle-batch — correction";
    await openBatch(page, PROJECT, CORRECTION, { correction: true, draft: true });
    await expect(page.getByTestId("batch-sheet").getByTestId("batch-phase")).toHaveText("Draft");

    await page.getByTestId("approve-batch").click();
    // "Start annotating now" is on by default: one press approves it and opens its jobs.
    await expect(page.getByTestId("approve-start")).toBeChecked();
    await page.getByTestId("approve-submit").click();
    await expect(page.getByTestId("batch-sheet").getByTestId("batch-phase")).toHaveText("Labeling");
    // The child pins the project's *active* version at its own approval rather
    // than inheriting the parent's. They are the same number here — **v3**, after
    // the two additive publishes above, both of which moved the parent onto them
    // as well — so the claim this makes is that it pinned, not that it copied.
    // Distinguishing the two needs a parent that is *behind*, which only a
    // narrowing version can produce, and that belongs to the kernel suite rather
    // than to a walk through the app.
    await openProject(page, PROJECT, "overview");
    await expect(page.getByTestId(`overview-batch-${CORRECTION}`)).toContainText("v3");
    await openBatch(page, PROJECT, CORRECTION, { correction: true });
    await expect(page.getByTestId("batch-sheet").getByTestId("batch-phase")).toHaveText("Labeling");
    await expect(page.getByTestId("start-batch")).toHaveCount(0);

    // (1) Seeded. Nothing was copied to make this true — annotations hang off an
    // `asset_id`, so the labels were already on these frames; what approval
    // added is the honest progress. The editor shows them on the first frame, and
    // again on the third below, where the tile counts the old grid drew are read off
    // the frames themselves.
    await page.getByTestId("batch-sheet").getByTestId("sheet-annotate").click();
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
    // last frame only** — it is the filled slot there, and `Next` is the
    // filled slot everywhere else. Walking there is not incidental to this step:
    // it is the same save-first advance a person makes, over frames this
    // correction round left alone.
    await page.getByTestId("save-and-next").click();
    await expect(page.getByTestId("asset-position")).toContainText("2/3");
    await page.getByTestId("save-and-next").click();
    await expect(page.getByTestId("asset-position")).toContainText("3/3");
    // The third frame carries the tag and the lane from the parent round, untouched by
    // this one: the lane is the one object, and the tag is assigned.
    await expect(page.getByTestId("object-total")).toHaveText("1 object");
    await expect(page.getByTestId("tag-count")).toHaveText("1 assigned");

    await page.getByTestId("finish-job").click();
    await expect(page.getByTestId("finish-job")).toHaveText("Finished");

    await openBatch(page, PROJECT, CORRECTION, { correction: true });
    await page.getByTestId(`complete-${CORRECTION}`).click();
    // The switch keeps its last answer, so say this one's: Complete and add to the dataset.
    await page.getByTestId("complete-add").setChecked(true);
    await page.getByTestId("complete-submit").click();
    // A correction's frames are trunk members already, so the batch reads as in
    // the dataset the moment it completes: the phase is about membership.
    await expect(page.getByTestId("batch-sheet").getByTestId("batch-phase")).toHaveText("In dataset", {
      timeout: 30_000,
    });

    // Promotion moves membership and nothing else, and these three frames are
    // already members — so the honest report is *nothing new*, not "added 3".
    // The labels moved when they were saved, which is the live half of the
    // policy and the part that surprises.
    await expect(page.getByTestId(`completed-${CORRECTION}`)).toHaveText(
      /Already in the dataset/,
      { timeout: 30_000 },
    );

    await putAwayPanel(page);
    await page.getByTestId("nav-dataset").click();
    await expect(page.getByTestId("dataset-screen")).toBeVisible();
    // (2) The deleted box is gone from the trunk — and `vehicle` was the only one
    // of its class, so it has none left. The class is still declared, so its row
    // stays and says so: a declared class nobody labelled is the gap to see.
    await expect(classRow(page, "vehicle")).toContainText("—");
    await expect(classRow(page, "vehicle").getByRole("button")).toBeDisabled();
    // The correction's own polygon arrived beside the parent's.
    await expect(classRow(page, "lane")).toContainText("2");
    // (3) The frame nobody opened still carries what the first round left.
    await expect(classRow(page, "daytime")).toContainText("1");
    await expect(classRow(page, "centerline")).toContainText("1");
    // Membership never moved: replacement is about labels, not about who is in.
    await expect(page.getByTestId("kpi-images")).toContainText("3");

    // And the release is exactly where it was left. Its manifest is a frozen
    // blob and its hash is the contract, so a correction cannot reach back into
    // one already published — checked through `verify`, which re-reads and
    // re-hashes every blob rather than trusting the row it is compared against.
    // Re-entered through the navigation, so the dataset opened on its working
    // copy; the release's controls are its facts, at the top of the column.
    await page.getByTestId(`version-${TAG}`).click();
    await page.getByTestId(`verify-${TAG}`).click();
    await expect(page.getByTestId("state-integrity")).toHaveText("Intact");
  });

  await test.step("export for yolo11, consent to the polyline it drops, and download", async () => {
    // A release's export is a section of its facts, open with the rest.
    await expect(page.getByTestId("section-export")).toBeVisible();
    await page.getByTestId("export-target").click();

    // The catalog the *running server* derived through the real entry-point
    // group, under its three headings. The lane plugins have no task vocabulary,
    // so their second line is the geometry they carry — which is the one thing
    // the picker says about them before you choose, and what tells somebody a
    // lane format will not take their boxes.
    const listbox = page.getByRole("listbox");
    await expect(listbox.getByRole("group").first()).toContainText("Ultralytics YOLO");
    await expect(listbox).toContainText("Community YOLO");
    await expect(listbox).toContainText("Other formats");
    for (const lane of [/tusimple/, /culane/, /openlane-2d/]) {
      await expect(page.getByRole("option", { name: lane })).toContainText("polyline");
    }
    // The retired alias is a format the route still accepts, never a target.
    await expect(page.getByRole("option", { name: /^yolo$/ })).toHaveCount(0);

    await page.getByRole("option", { name: /YOLO11/ }).click();
    await expect(page.getByTestId("lossy-hint")).toHaveAccessibleName(/YOLO11/);

    // The release holds a `centerline` polyline and a tag beside its boxes;
    // YOLO11 writes a tag only when nothing else is exported, so both are
    // dropped and the launch is refused with the report and the banner
    // says what the target accepts and what this release loses — the kernel's
    // counts, in the kernel's order, not the browser's.
    await page.getByTestId("export-submit").click();
    const consent = page.getByTestId("lossy-consent");
    await expect(consent).toContainText("YOLO11 accepts boxes, tags, keypoints and polygons");
    await expect(consent).toContainText("1 polyline would be dropped");
    await expect(consent).toContainText("1 tag would be dropped");
    await expect(consent.getByTestId("lossy-classes")).toContainText("centerline");
    await expect(page.getByTestId("export-submit")).toBeDisabled();
    await consent.getByTestId("lossy-checkbox").check();

    // **Three requests behind one click.** The launch answers 202 with
    // a job id, the screen polls `/background-jobs/{id}` until it succeeds, and
    // only then fetches the artifact and saves it — which is the point of waiting
    // on the download event rather than on any of the steps that produce it.
    //
    // It is also the only place the whole queue runs for real: a spawned worker
    // opens this workspace, resolves the target's exporter through the
    // entry-point group, and writes into `exports/`. Every other test of that
    // path runs the handler inline.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-submit").click(),
    ]);
    await expectArchive(download);
  });

  await test.step("write a recipe on its one page", async () => {
    /*
     * The stage between a release and the files a trainer reads, driven the
     * way a person drives it: the export's New recipe, the modal's one page,
     * *Create recipe*. Every hop is real — the target catalog the modal seeds its
     * resize from, and the `POST` that stores the recipe. The modal's own
     * tests stub both, which is right for them and is why they cannot notice
     * a catalog whose hints the size field does not take.
     */
    // A recipe is written where it is used: the "+" beside the Export section's
    // Recipe field opens a new one in a modal over the page.
    await expect(page.getByTestId("section-export")).toBeVisible();
    await page.getByTestId("recipe-new").click();
    const modal = page.getByTestId("recipe-dialog");
    await expect(modal.getByTestId("recipe-editor")).toBeVisible();
    await expect(modal.getByTestId("recipe-title")).toHaveText("New recipe");

    // The model first, because choosing one applies its hints: YOLO11's say
    // letterbox to 640, and the resize fills in rather than being
    // typed. Asserted rather than typed over, since the hints are the
    // catalog's answer and a wrong one would be worth failing on.
    await modal.getByTestId("recipe-target").click();
    await page.getByRole("option", { name: /YOLO11/ }).click();
    await modal.getByTestId("recipe-name").fill(RECIPE);
    // Not yet exported, so nothing says it was.
    await expect(modal.getByTestId("recipe-used-by")).toHaveCount(0);

    await expect(modal.getByTestId("resize-letterbox")).toHaveAttribute("data-state", "on");
    await expect(modal.getByTestId("resize-width")).toHaveValue("640");
    await expect(modal.getByTestId("resize-height")).toHaveValue("640");

    // One augmentation; switching the first one on makes one variant, which is
    // the spec's own rule rather than a default.
    await modal.getByTestId("augment-hflip").click();
    await expect(modal.getByTestId("augment-variants-1")).toHaveAttribute("aria-checked", "true");
    // The release it was opened from is counted: every asset once, and the
    // training fold once more for the one variant — two, as the archive below
    // finds.
    await expect(modal.getByTestId("recipe-tally-added")).toContainText("+2");
    await expect(modal.getByTestId("recipe-tally-written")).toContainText("5");

    await modal.getByTestId("recipe-save").click();
    await expect(modal.getByTestId("recipe-saved")).toContainText(`${RECIPE} is ready`);
    await modal.getByTestId("recipe-saved-done").click();
    await expect(modal).toHaveCount(0);
    // Stored, and chosen: a recipe written from the export is the one it runs.
    await expect(page.getByTestId("export-recipe")).toHaveText(RECIPE);
  });

  await test.step("export through the recipe, and find its variant in the archive", async () => {
    /*
     * The same section, one more choice: the recipe select, which offers
     * No recipe and the project's recipes by name. The consent question is asked
     * again — a recipe changes nothing about what the target drops — and the
     * archive that comes back is read for the two things a recipe promises:
     * the report names the recipe under its hash, and the train fold carries
     * a variant beside its source, label and all. This is the only place the
     * whole chain runs for real: the queue, the worker, the resize and the
     * augmentation drivers, and the format laying the variant out where a
     * trainer will find it.
     */
    // Still on YOLO11, and the recipe just written is chosen.
    await expect(page.getByTestId("export-target")).toContainText("YOLO11");
    await expect(page.getByTestId("export-recipe")).toHaveText(RECIPE);

    await page.getByTestId("export-submit").click();
    const consent = page.getByTestId("lossy-consent");
    await expect(consent).toContainText("1 polyline would be dropped");
    await consent.getByTestId("lossy-checkbox").check();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-submit").click(),
    ]);
    await expectRecipeArchive(download);
  });

  await test.step("delete the recipe, and watch the list and the count answer", async () => {
    /*
     * The last verb a recipe has, after the export that needed it has run:
     * the chosen recipe's Edit recipe and Delete behind its "⋯", the
     * confirmation, the real `DELETE`, and the select no longer naming it.
     */
    // The export's outcome stays in its section; the chosen recipe's Edit recipe
    // opens its modal over the page.
    await page.getByTestId("recipe-actions").click();
    await page.getByTestId("recipe-edit").click();
    const modal = page.getByTestId("recipe-dialog");
    await expect(modal.getByTestId("recipe-editor")).toBeVisible();
    // The export that just ran, read back from the queue as the recipe's usage.
    await expect(modal.getByTestId("recipe-used-by")).toHaveText(`The ${TAG} YOLO11 export`);
    // Nothing changed, so closing asks nothing, and Delete is a menu away.
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await page.getByTestId("recipe-actions").click();
    await page.getByTestId("recipe-delete").click();
    await expect(page.getByTestId("delete-recipe-dialog")).toContainText(`Delete ${RECIPE}?`);
    await page.getByTestId("delete-recipe-submit").click();

    await expect(page.getByTestId("delete-recipe-dialog")).toHaveCount(0);
    // The export falls back to no recipe, and the select no longer offers it.
    await expect(page.getByTestId("export-recipe")).toHaveText("No recipe");
    await page.getByTestId("export-recipe").click();
    await expect(page.getByTestId(`recipe-row-${RECIPE}`)).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  await test.step("export for openlane-2d, and find the occluded vertex in the archive", async () => {
    // The one lane format with a per-point slot, so the mark set in the editor
    // at 3d is read back out of the bytes the browser saved: OpenLane writes
    // occluded as 0 and everything else as 1.
    // The export is inline in the release's facts, so the release is what is opened.
    await page.getByTestId(`version-${TAG}`).click();
    await expect(page.getByTestId("section-export")).toBeVisible();
    await page.getByTestId("export-target").click();
    await page.getByRole("option", { name: /openlane-2d/ }).click();

    // Everything but the lane is dropped, so the consent question comes first.
    // Its list names every class this target drops — the longest the walk meets —
    // and the checkbox and submit are still reached by pointer (#1020).
    await page.getByTestId("export-submit").click();
    const consent = page.getByTestId("lossy-consent");
    await expect(consent).toContainText("openlane-2d accepts polylines only");
    const checkbox = consent.getByTestId("lossy-checkbox");
    await checkbox.click();
    await expect(checkbox).toBeChecked();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-submit").click(),
    ]);
    await expectOpenLaneArchive(download);
  });

  await test.step("edit the connection, and watch the row answer for it", async () => {
    /*
     * A stub cannot referee this body, because it is written by whoever wrote
     * the body — only a real server, checking the request against
     * `ConnectionUpdate`, can catch a field the dialog serialises but the
     * schema forbids. A rename carries the model reference the row already
     * has, and the kernel compares rather than asks whether it was supplied —
     * so only a real PATCH proves a rename of a set-up connection is not read
     * as the retarget it now refuses. The second half is the declaration
     * itself: a set-up row does not declare `update_model`, and only a real
     * kernel's answer can show the form reading that rather than a stub's
     * transcription. Last in the walk and nothing is put back, since no later
     * step reads this connection.
     */
    await putAwayPanel(page);
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
    await page.getByTestId(`open-${STAND_IN}`).click();
    await expect(page.getByTestId("model-sheet")).toBeVisible();
    await page.getByTestId("action-edit").click();
    await page.getByTestId("connection-name").fill(REPINNED);
    await page.getByTestId("connection-submit").click();

    // The dialog closes only on success — a refusal leaves it open holding what
    // was typed — so its absence is the first thing that says the server took
    // the body.
    await expect(page.getByTestId("connection-dialog")).toHaveCount(0);
    await expect(after).toBeVisible();
    await expect(after.getByTestId("connection-status")).toContainText(/ready/i);
    // The sheet that opened the edit is still open under it, and now carries the new name.
    await expect(page.getByTestId("model-sheet").getByRole("heading", { name: REPINNED })).toBeVisible();

    // And the model is now a fact: the real kernel withholds `update_model`
    // from a set-up row, so the form states the reference where the choice
    // used to be and offers no field that would move it — while the name it
    // just changed is still there to change again.
    await page.getByTestId("action-edit").click();
    await expect(page.getByTestId("connection-model-fixed")).toBeVisible();
    await expect(page.getByTestId("connection-revision")).toHaveCount(0);
    await expect(page.getByTestId("connection-custom-model")).toHaveCount(0);
    await expect(page.getByTestId("connection-name")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("connection-dialog")).toHaveCount(0);
    await expect(after.getByTestId("connection-status")).toContainText(/ready/i);
    // Escape closes the layer on top, so the sheet is still there: put it away too.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("model-sheet")).toHaveCount(0);
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
     * The walk's `204 No Content` answers — `DELETE /batches/{id}`, the
     * annotation delete and the recipe delete — used to be reported by Chromium
     * as `net::ERR_ABORTED`, because there is no body for the renderer to read
     * and the network stack filed the torn-down stream as cancelled. The
     * Chromium that Playwright 1.64 ships reports them as completed, so the list
     * is empty. Measured, not assumed: the server still logs all three as
     * `204`, and the steps that send them assert the effect (the batch gone from
     * the table, the `vehicle` class gone from the trunk, the recipe view back at
     * its invitation).
     *
     * Asserted as an exact list: an aborted call is the shape of a request the
     * app really did abandon, and that is worth failing on.
     *
     * Deliberate cancellations are the one exclusion, made at the collection
     * site: image-byte GETs (`/content`, `/thumbnail`) are aborted on unmount
     * on purpose (#572), and how many of them a walk produces is a matter of
     * navigation timing, not correctness.
     */
    expect(abortedApiCalls).toEqual([]);
    /*
     * **The refused API calls, pinned rather than merely tolerated.**
     *
     * The 404s are all a screen asking for a document that does not exist
     * yet. The curated draft is the schema editor's, opening on an empty draft
     * for a project nobody has given a schema; the annotation draft pair
     * belongs to the annotator's add-a-class dialog, gated on `addingClass` the
     * same way. The walk asks each pair twice — a mount, then the remount or
     * `page.reload()` that follows — because a saved draft is written straight
     * into the cache rather than invalidated, so writing one never triggers a
     * second read by itself. The curated draft is asked twice more: Add images
     * is a dialog over the section it was opened from, and the walk opens it
     * from Classes, so the editor stays mounted under it — and the ingest
     * refreshes the project once at its launch and once when it settles, which
     * re-asks the editor's answered 404 each time. The project's id changes per
     * run, so each is matched rather than compared.
     *
     * `GET /projects/{id}/schema` is the one counted loosely. Every part of the
     * project that names its classes reads it — the bar's Classes count, the
     * Overview's class rail, the editor — and a 404 is not cached as an answer,
     * so each mount before the first schema exists asks again. How many mounts
     * that is depends on how fast the walk clicks, so the list holds at least
     * the editor's two, and nothing but this route is let vary.
     *
     * The `download-size` entry is conditional on the installation, and is the reason this
     * list is worth pinning at all. `GET /inference/download-size` prices the
     * curated model the connection form seeds itself with, and reading that price
     * needs the optional local-inference runtime — so it answers 500 wherever the
     * extra is absent, which is what `browser cycle (chromium)` installs, and 200
     * wherever it is present. `curatedSizeRefused` carries what the form rendered,
     * so the expectation follows the installation instead of guessing at it.
     *
     * The last three entries are the export's own 409, once per export: each
     * first launch is made without `allow_lossy` — two to `yolo11`, which drops
     * the release's polyline, and one to `openlane-2d`, which keeps only the
     * polyline — so the refusal is the consent question itself, the one refusal
     * in the walk a person is meant to see. Exactly one per export, because the
     * retry carries the flag; the second export names a recipe, which changes
     * nothing about what the target drops and so asks the same question again.
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
    const lossyLaunch = /^POST \/releases\/[0-9a-f-]+\/export 409$/;
    expect(refusedApiCalls.filter((call) => schema.test(call)).length).toBeGreaterThanOrEqual(2);
    expect(refusedApiCalls.filter((call) => !schema.test(call))).toEqual([
      expect.stringMatching(curatedDraft),
      expect.stringMatching(curatedDraft),
      // The ingest's launch and settle, with Classes still mounted under Add images.
      expect.stringMatching(curatedDraft),
      expect.stringMatching(curatedDraft),
      ...(curatedSizeRefused ? ["GET /inference/download-size 500"] : []),
      expect.stringMatching(annotationDraft),
      expect.stringMatching(annotationDraft),
      expect.stringMatching(lossyLaunch),
      expect.stringMatching(lossyLaunch),
      expect.stringMatching(lossyLaunch),
    ]);
    // And the icon is genuinely served under the mount, rather than absent and
    // unnoticed: `vite preview` would answer 200 with `index.html` here, which is
    // the reason this is checked against the real server.
    const icon = await page.request.get("/app/favicon.svg");
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/svg+xml");
  });
});

/**
 * Resolves once no call is in flight and none has started for 300ms — long
 * enough for a save's answer to start the reads it invalidates.
 */
async function quiet(inFlight: ReadonlySet<Request>): Promise<void> {
  const deadline = Date.now() + 15_000;
  let since = Date.now();
  while (Date.now() < deadline) {
    if (inFlight.size > 0) since = Date.now();
    else if (Date.now() - since >= 300) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`still in flight after 15s: ${[...inFlight].map((request) => request.url()).join(", ")}`);
}

/**
 * A class's row in the Dataset's working copy: its name, its annotation count
 * and its share, the way the Overview draws them. A class nobody labelled keeps
 * its row, with a dash for the share and nothing to open.
 */
function classRow(page: Page, name: string): Locator {
  return page.getByTestId("dataset-stats").getByTestId(`overview-class-${name}`);
}

/**
 * A batch's panel is modal: the rail and the section nav are under its scrim, so a
 * step that leaves for another screen puts the panel away first, as a person would.
 */
async function putAwayPanel(page: Page): Promise<void> {
  // The address says whether a panel is open even before it has drawn (arriving back
  // from the annotator, it opens a beat after the route does).
  if (/[?&]batch=/.test(page.url())) {
    await expect(page.getByTestId("batch-sheet")).toBeVisible();
    await page.getByTestId("batch-close").click();
    await expect(page.getByTestId("batch-sheet")).toHaveCount(0);
  }
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
  section: "overview" | "images" | "schema" | "dataset",
): Promise<void> {
  // The job annotator owns the whole viewport and has no rail: its own back
  // arrow is the way out, and it saves on the way.
  if (await page.getByTestId("annotation-page").isVisible()) {
    await page.getByTestId("back").click();
    await expect(page.getByTestId("annotation-page")).toHaveCount(0);
  }
  await putAwayPanel(page);
  await page.getByTestId("rail-projects").click();
  await expect(page.getByTestId(`open-${project}`)).toBeVisible();
  await page.getByTestId(`open-${project}`).click();
  await expect(page.getByTestId("project-screen")).toBeVisible();
  await page.getByTestId(`nav-${section}`).click();
}

/**
 * A batch opened the way a person opens one: from the Overview's Batches table —
 * batches have no section of their own — by pressing its row, which opens it in the
 * panel beside the table. Every batch action (approve, start, complete, promote,
 * correct, delete) is made in that panel's top bar, and the address gains
 * `?batch=` so the panel survives a reload.
 *
 * The panel stays on the Overview, so there is no page to arrive at: what is
 * waited for is the panel's heading naming the batch asked for.
 */
async function openBatch(
  page: Page,
  project: string,
  name: string,
  { correction = false, draft = false }: { readonly correction?: boolean; readonly draft?: boolean } = {},
): Promise<void> {
  await openProject(page, project, "overview");
  await expect(page.getByTestId("overview-batches")).toBeVisible();
  // The panel labels a correction batch "<name> — correction" unless its own name
  // already ends that way, and its row and heading carry that label rather than the
  // batch's own name. (The bar's controls are keyed by the batch's own name.)
  const label = correction && !name.endsWith("— correction") ? `${name} — correction` : name;
  if (draft) {
    // A draft's row opens its approval, so its panel is the row menu's Details.
    await page.getByTestId(`batch-menu-${label}`).click();
    await page.getByTestId("menu-details").click();
  } else {
    await page.getByTestId(`overview-batch-${label}`).locator("[data-row-open]").click();
  }
  await expect(page.getByTestId("batch-sheet").getByRole("heading", { level: 2, name: label })).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/overview\?batch=[0-9a-f-]+$/);
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
 * The archive arrived, is a zip, and carries the descriptor a trainer reads first.
 *
 * The download is named for the target, and `data.yaml` inside it maps class ids
 * to the schema's names in schema order — the shape `ultralytics` writes and the
 * one thing that decides whether a training run reads the labels as the right
 * classes. Read out of the bytes the browser saved rather than off the server's
 * disk, because the download is what a person has.
 */
async function expectArchive(download: Download): Promise<void> {
  expect(download.suggestedFilename()).toBe(`${TAG}-yolo11.zip`);
  const saved = await download.path();
  expect(saved).not.toBeNull();
  const archive = readFileSync(saved as string);
  expect(archive.subarray(0, 2).toString("latin1")).toBe("PK");

  const descriptor = zipEntry(archive, "data.yaml").toString("utf8");
  expect(descriptor).toMatch(/^names:$/m);
  expect(descriptor).toMatch(/^\s+0: "vehicle"$/m);
  expect(descriptor).toMatch(/^\s+1: "lane"$/m);
}

/**
 * The archive of the second export: the same target, through the recipe.
 *
 * Two things a recipe promises, both read out of the bytes the browser saved.
 * The report at the archive's root carries `preprocessing` — the recipe by name,
 * by value, and under the hash an export snapshots it as — and the train fold
 * carries variant 1 of a source beside that source: `images/train/<hash>-aug1.png`
 * with `labels/train/<hash>-aug1.txt`, the layout `ultralytics` reads labels
 * from by substituting one path segment. The report's mapping traces the
 * variant back to its source hash, which is what makes the file name checkable
 * rather than merely present.
 */
async function expectRecipeArchive(download: Download): Promise<void> {
  expect(download.suggestedFilename()).toBe(`${TAG}-yolo11.zip`);
  const saved = await download.path();
  expect(saved).not.toBeNull();
  const archive = readFileSync(saved as string);
  const entries = zipEntries(archive);

  const report = JSON.parse(zipEntry(archive, "visionset-export-report.json").toString("utf8"));
  expect(report.target).toBe("yolo11");
  expect(report.preprocessing.recipe_name).toBe(RECIPE);
  expect(report.preprocessing.recipe_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(report.preprocessing.spec.variants_per_asset).toBe(1);

  const variants = report.preprocessing.mapping.filter(
    (row: { variant: number }) => row.variant === 1,
  );
  // Two of three assets are in the train fold under the published split, and
  // each of them gets exactly one variant.
  expect(variants).toHaveLength(2);
  for (const variant of variants) {
    expect(variant.file).toBe(`images/train/${variant.source_content_hash}-aug1.png`);
    expect(entries.has(variant.file)).toBe(true);
    expect(entries.has(`labels/train/${variant.source_content_hash}-aug1.txt`)).toBe(true);
  }
  expect([...entries.keys()].filter((name) => /^labels\/train\/[0-9a-f]{64}-aug1\.txt$/.test(name)))
    .toHaveLength(2);
}

/** The OpenLane 2D archive: the lane's middle vertex, occluded at 3d, is written 0. */
async function expectOpenLaneArchive(download: Download): Promise<void> {
  expect(download.suggestedFilename()).toBe(`${TAG}-openlane-2d.zip`);
  const saved = await download.path();
  expect(saved).not.toBeNull();
  const archive = readFileSync(saved as string);
  const labels = [...zipEntries(archive).keys()].filter((name) => /^labels\/.+\.json$/.test(name));
  expect(labels.length).toBeGreaterThan(0);
  const lines = labels.flatMap(
    (name) =>
      JSON.parse(zipEntry(archive, name).toString("utf8")).lane_lines as {
        uv: number[][];
        visibility: number[];
      }[],
  );
  expect(lines).toHaveLength(1);
  expect(lines[0].uv).toHaveLength(3);
  expect(lines[0].visibility).toEqual([1, 0, 1]);
}

/** Where an entry's bytes are in a zip, and how they were written. */
interface ZipEntry {
  readonly method: number;
  readonly compressed: number;
  readonly local: number;
}

/**
 * What a zip holds, by name — enough of the format to read a descriptor.
 *
 * Walks the central directory from the end-of-central-directory record, which
 * is where a zip says what it holds. Stored and deflated entries are the two
 * `shutil.make_archive` writes; `zipEntry` inflates one from its local header.
 */
function zipEntries(archive: Buffer): Map<string, ZipEntry> {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== 0x06054b50) end -= 1;
  expect(end, "end-of-central-directory record").toBeGreaterThanOrEqual(0);
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
    const method = archive.readUInt16LE(offset + 10);
    const compressed = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.set(name, { method, compressed, local });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipEntry(archive: Buffer, name: string): Buffer {
  const entry = zipEntries(archive).get(name);
  if (entry === undefined) throw new Error(`${name} is not in the archive`);
  const { method, compressed, local } = entry;
  expect(archive.readUInt32LE(local)).toBe(0x04034b50);
  const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
  const bytes = archive.subarray(start, start + compressed);
  return method === 8 ? inflateRawSync(bytes) : Buffer.from(bytes);
}
