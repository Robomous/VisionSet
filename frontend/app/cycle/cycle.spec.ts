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
 * A project name nothing else in the workspace will collide with — **including
 * this same spec on another repetition**.
 *
 * A project name is unique per workspace, case-insensitively, and the workspace
 * outlives a repetition: `scripts/cycle_server.sh` rebuilds it once per *server
 * start*, and `--repeat-each` reuses that one server. So the fixed literal that
 * used to live here made the flag useless — repeat 2 died on
 * `POST /projects → 409`, a wall standing in front of everything the suite is
 * about, and the only way to run the cycle twice was two whole invocations at
 * about ninety seconds of rebuild each.
 *
 * `repeatEachIndex` **and `retry`**, because a retry is the same repetition run
 * again into the same workspace. #314 scoped only the first, and #281's run is
 * where that showed: a genuine failure left its project behind, the retry died
 * on `POST /projects → 409`, and the report named the 409 — turning one readable
 * failure into two unreadable ones, which is the exact wall the scoping was
 * added to remove. The workspace really is fresh per invocation (the script
 * `rm -rf`s it before `init`) and `workers: 1` means two repetitions never
 * overlap, so those two indices are the whole of the uniqueness needed.
 *
 * The suffix is unconditional rather than omitted on the first, so every run's
 * names have one shape and a failure message reads the same way whether or not
 * somebody passed the flag.
 *
 * The project is the only name that has to move, and that is worth stating so
 * the next collision is looked for rather than assumed: a release tag is unique
 * per dataset, a batch name is not unique at all, and a source's idempotency key
 * `(project, kind, path, fps)` leads with the project. All three are already
 * scoped by a project that is new.
 */
function projectFor(info: TestInfo): string {
  return `browser-cycle-${info.repeatEachIndex}-${info.retry}`;
}

test("the whole cycle, from opening the app to a downloaded export", async ({ page }, info) => {
  test.slow();

  const PROJECT = projectFor(info);

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
  // Requests the *app* issued that the network stack reported as aborted.
  // Asserted rather than ignored — see the final step for why they are not
  // `badRequests` and what the one expected member of this list is.
  const abortedApiCalls: string[] = [];
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
  page.on("requestfailed", (request) => {
    // **The reason, not just the URL.** A bare `failed <url>` cannot tell a
    // resource the browser could not fetch from a call that completed and whose
    // empty body stream the network stack then tore down, and those want
    // opposite responses. Splitting them here is what lets each be asserted for
    // what it is instead of one of them being quietly tolerated.
    const reason = request.failure()?.errorText ?? "unknown";
    const kind = request.resourceType();
    if ((kind === "fetch" || kind === "xhr") && reason === "net::ERR_ABORTED") {
      abortedApiCalls.push(`${request.method()} ${new URL(request.url()).pathname}`);
      return;
    }
    badRequests.push(`failed ${reason} ${request.url()}`);
  });

  await test.step("open the app, which asks for nothing", async () => {
    await page.goto("./");
    // #179's first acceptance criterion, against the real thing: `visionset server`
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
    await page.getByTestId("new-project").click();
    await page.getByTestId("project-name").fill(PROJECT);
    await page.getByTestId("project-description").fill("Driven by #59");
    await page.getByTestId("create-submit").click();
    // Straight into it (#387): a project is made in order to do something with
    // it, so the list it was made from is never the destination. The route is
    // asserted as well as the screen, because "the callback fired" and "the app
    // turned it into a URL" are two claims and only the second survives a
    // reload.
    await expect(page.getByTestId("project-screen")).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}(\?|$)/);
    await expect(page.getByTestId("project-title")).toHaveText(PROJECT);
  });

  await test.step("declare a schema with all four geometries", async () => {
    // A brand-new project opens on Overview since #210, and its empty state is
    // the honest first thing to see — there is no data to describe yet. The
    // schema is a tab away.
    await expect(page.getByTestId("overview-empty")).toBeVisible();
    await page.getByTestId("tab-schema").click();

    // A project starts schema-less on purpose, so the editor opens on an empty
    // draft rather than an error.
    await expect(page.getByTestId("schema-editor")).toContainText("Saving creates version 1");

    for (const [index, [name, geometry]] of (
      [
        ["vehicle", "bbox"],
        ["lane", "polygon"],
        ["daytime", "classification_tag"],
        // #223. The picker offers it because the API accepts it and the lane
        // exporters need it — not because anything draws one. Declaring it here
        // is the schema editor's half of that, against a real `create_version`
        // that would answer `UnsupportedGeometry` if the kernel disagreed.
        ["centerline", "polyline"],
      ] as const
    ).entries()) {
      await page.getByTestId("add-class").click();
      await page.getByTestId(`class-name-${index}`).fill(name);
      if (geometry !== "bbox") {
        await page.getByTestId(`class-geometry-${index}`).click();
        await page.getByRole("option", { name: geometry, exact: true }).click();
      }
    }

    /*
     * The draft survives leaving the tab, in a real DOM (#389).
     *
     * jsdom cannot carry this claim on its own: the mechanism is Radix
     * unmounting inactive `TabsContent`, and "the component really was destroyed
     * and rebuilt" is a statement about a browser's own reconciliation. Four
     * unsaved classes is also the largest thing this cycle ever has to lose, and
     * losing it here would be silent — the run would carry on and publish
     * version 1 with whatever survived.
     */
    await page.getByTestId("tab-overview").click();
    await expect(page.getByTestId("schema-editor")).toHaveCount(0);
    await page.getByTestId("tab-schema").click();
    for (const name of ["vehicle", "lane", "daytime", "centerline"]) {
      await expect(page.getByTestId("class-list")).toContainText(name);
    }

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
    // **#181, and this is the only test anywhere that drives the route the fix
    // wires.** The run used to reach `completed` and end the page: this step
    // walked back through the project to find the batch, which is the same shape
    // as the `jobIdOf` helper #160 deleted — a suite that finds the batch by
    // another road cannot notice that the screen offers none.
    await expect(page.getByTestId("run-outcome")).toContainText("cycle-batch");
    await page.getByTestId("open-batch").click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/batches\/[0-9a-f-]+$/);
  });

  await test.step("a draft batch's tiles have nowhere to go, and say why", async () => {
    // Before approval there are no jobs, so `BatchAsset.job_id` is null (#29) and
    // an asset has nowhere to go. #160's third criterion still holds and its
    // spelling changed with #284: the tile is no longer one big disabled button,
    // because selecting a frame in a draft is legitimate — it is opening one that
    // is not. So what is asserted is the *capability*, not the control's tag.
    await expect(page.getByTestId("gallery")).toBeVisible();
    const first = page.getByTestId(/^tile-/).first();
    await expect(first).toHaveAttribute("data-pending", "true");
    // No route into the annotator, and the reason on the card itself — which is
    // the element a pointer is over wherever it lands. That last assertion is the
    // pre-#284 spelling, restored: the explanation went back onto the tile when
    // the caption row that had been carrying it went away.
    await expect(first.getByTestId(/^open-/)).toHaveCount(0);
    await expect(first).toHaveAttribute("title", /draft/i);

    // **Selection is offered, and it was not until #281.** A draft is the one
    // state where `edit_membership` is legal, so "every action one could offer is
    // unavailable before jobs exist" stopped being true the moment membership
    // editing reached the wire — and the gate that hid the bar was hiding the one
    // state it is for. Against a real server, so the batch's own
    // `allowed_actions` is the kernel's answer rather than a fixture's.
    await first.getByTestId(/^select-/).click();
    await expect(page.getByTestId("bulk-remove")).toBeEnabled();
    // The progress moves stay dead here, for their own reason: no jobs, so no
    // progress to move.
    await expect(page.getByTestId("bulk-skip")).toBeDisabled();
    await page.getByTestId("bulk-clear").click();
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
    // **#160's fourth acceptance criterion, and the reason this step exists.**
    // Until this fix the only way in was `page.goto('./jobs/' + id)` with the id
    // read out of the API — which is exactly what this spec used to do, and what
    // made a defect that blocked the whole product invisible to a green suite.
    // Nothing here types a URL.
    await openProject(page, PROJECT, "batches");
    await page.getByTestId("open-batch-cycle-batch").click();
    await expect(page.getByTestId("gallery")).toBeVisible();

    // The **third** tile, so "it opened the job" and "it opened this asset" cannot
    // be confused: a page that ignored the click would show 1/3.
    //
    // The control changed with #284 and the criterion did not. A press on the
    // thumbnail now *selects* — the grid grew shift-ranges and a bulk bar, and a
    // gallery where the only click opens cannot express a multi-frame action — so
    // opening moved to its own labelled control on the tile. It is always visible
    // rather than hover-gated, which a touch device would never reach. What #160
    // asked for is that the annotator is reachable **by clicking**, with no id
    // read out of the API and no URL typed, and that is what this does.
    const tiles = page.getByTestId(/^tile-/);
    await expect(tiles).toHaveCount(3);
    const third = tiles.nth(2);
    await expect(third).not.toHaveAttribute("data-pending", "true");
    const openedAsset = (await third.getAttribute("data-testid"))!.replace("tile-", "");
    await third.getByTestId(`open-${openedAsset}`).click();

    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/jobs/[0-9a-f-]+\\?asset=${openedAsset}$`));
    await expect(page.getByTestId("asset-position")).toContainText("3/3");

    // #160's fifth criterion, and the only honest way to check it here: reload the
    // URL **the app itself produced**, which is a fresh `GET /app/jobs/<id>?asset=`
    // at the server and therefore drives #58's SPA deep-link fallback for real. A
    // typed `page.goto('./jobs/…')` would assert the same thing while reopening
    // the door this task closed.
    await page.reload();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.getByTestId("asset-position")).toContainText("3/3");

    // The grid button switches frames without leaving (#390): an overlay over the
    // workspace, the URL unmoved, and Escape returning to exactly the frame that
    // was on screen.
    const inTheEditor = page.url();
    await page.getByTestId("open-gallery").click();
    await expect(page.getByTestId("frame-gallery")).toBeVisible();
    expect(page.url()).toBe(inTheEditor);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("frame-gallery")).toHaveCount(0);
    await expect(page.getByTestId("asset-position")).toContainText("3/3");

    // And back to the gallery, from the arrow — the other half of #160, which
    // rendered disabled because nothing passed the callback. Leaving is still a
    // thing you can do; it just stopped being the only way to look at your own
    // frames.
    await page.getByTestId("back").click();
    await expect(page.getByTestId("gallery")).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/batches\/[0-9a-f-]+$/);
  });

  await test.step("annotate all three assets", async () => {
    // Back in through the first tile, because the drawing below walks 1 → 2 → 3.
    // Through its `Open` control, for the reason above: a press on the thumbnail
    // selects since #284.
    const firstTile = page.getByTestId(/^tile-/).first();
    const firstAsset = (await firstTile.getAttribute("data-testid"))!.replace("tile-", "");
    await firstTile.getByTestId(`open-${firstAsset}`).click();
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.getByTestId("asset-position")).toContainText("1/3");
    // The batch's pin, named on the screen (#232). Not the project's active
    // version — they are the same number here because nothing has published
    // since approval, and the point is that the annotator says which one it is
    // judged against, since #229 made the pin movable.
    await expect(page.getByTestId("pinned-schema")).toHaveText("v1");

    // And it answers the question it raises (#368). Nothing about the project's
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
    await expect(page.getByTestId("object-total")).toHaveText("1 object");
    await saveNow(page);
    await expect(page.getByTestId("save-state")).toContainText("Saved");

    // 3a — a lane, written the way lanes are actually written (#223).
    //
    // **This is the whole point of shipping the geometry without a tool.** There
    // is no polyline drawing tool (#342), and the workflow the geometry exists
    // for is *an agent pre-labels lanes and a person reviews them here*. So the
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
    await expect(page.getByTestId("object-total")).toHaveText("2 objects");
    // Drawn as an open path. `<polyline>` and not `<polygon>` is the whole
    // difference between a lane and a closed ring, and it is the one thing a unit
    // test over the document model structurally cannot see.
    // Scoped to the committed layer's own group rather than to `svg polyline`:
    // `TransientLayer` draws a `<polyline>` too, for the polygon being dragged.
    await expect(page.locator("[data-annotation-id] polyline")).toHaveCount(1);
    await expect(page.locator("[data-annotation-id] polyline")).toHaveAttribute("fill", "none");
    // Reachable from the object list, which is the only way to reach it: a canvas
    // press cannot select an open path in 0.1.0 (`geometryContains` refuses).
    await expect(page.getByTestId("object-row-1")).toContainText("centerline");

    // 3c — the tool strip says why there is no lane tool, rather than showing a
    // gap. Disabled-with-reason: absent and not-yet-available must not look the
    // same, and only one of them is true here.
    const laneTool = page.getByTestId("tool-polyline");
    await expect(laneTool).toHaveAttribute("aria-disabled", "true");
    await expect(laneTool).toHaveAttribute("aria-label", /0\.2/);

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

    // The chain nothing in the browser closed before #59 found it: a batch cannot
    // complete while a job is outstanding, and a job cannot while an asset is
    // unsettled. Saving annotations settles the assets; this closes the job.
    //
    // `accepted` is settled, so the count below still reads 3 of 3 — "annotated"
    // here means *past unannotated*, which is the only reading that does not go
    // backwards when a frame is accepted.
    await expect(page.getByTestId("job-progress")).toHaveText("3 / 3 annotated");
    await page.getByTestId("finish-job").click();
    await expect(page.getByTestId("finish-job")).toHaveText("Finished");
  });

  await test.step("complete the batch", async () => {
    await openProject(page, PROJECT, "batches");
    await expect(page.getByTestId("batches-table")).toBeVisible();
    await page.getByTestId("complete-cycle-batch").click();
    await expect(page.getByTestId("state-cycle-batch")).toHaveText("completed", {
      timeout: 30_000,
    });
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

  await test.step("publish a release", async () => {
    // **A tab, reached in one press.** It was behind the header's overflow menu,
    // which is where a destination goes when the navigation has no room for it —
    // and the trunk is the product's central object, so that was the wrong shape
    // rather than a tidy one.
    await page.getByTestId("tab-dataset").click();
    await expect(page.getByTestId("dataset-stats")).toContainText("3");
    await expect(page.getByTestId("dataset-screen")).toBeVisible();

    // #223: a lane is counted like any other annotation. `DatasetStats.per_class`
    // is derived per call from what the trunk actually holds, so a geometry the
    // counter did not know about would simply be absent — and absent reads as "no
    // lanes were labelled", which is the failure mode worth an assertion.
    await expect(page.getByTestId("class-count-centerline")).toContainText("1");

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
    // than inheriting the parent's. They are the same number here because
    // nothing has published since — the claim is that it pinned, not that it
    // copied.
    await expect(page.getByTestId(`batch-${CORRECTION}`)).toContainText("v1");
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

    await page.getByTestId("tab-dataset").click();
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
    await page.getByTestId(`verify-${TAG}`).click();
    await expect(page.getByTestId(`verified-${TAG}`)).toContainText("Intact");
  });

  await test.step("export through the dummy format and download the archive", async () => {
    await page.getByTestId(`export-${TAG}`).click();
    await page.getByTestId("export-format").click();

    // #223's five lane plugins, discovered by the *running server* through the
    // real entry-point group rather than by an import in a test — and each
    // declaring itself lossy, which is the one thing the picker shows about a
    // format before you choose it. A lane format that arrived silently unmarked
    // would let somebody export a release believing nothing was dropped.
    for (const lane of [/tusimple/, /culane/, /openlane-2d/]) {
      await expect(page.getByRole("option", { name: lane })).toContainText("(lossy)");
    }

    await page.getByRole("option", { name: /dummy/ }).click();

    // **Three requests behind one click, since #328.** The launch answers 202 with
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

    /*
     * **The one aborted API call, pinned rather than tolerated.**
     *
     * `DELETE /jobs/{id}/annotations` answers `204 No Content`, and Chromium
     * reports the request as `net::ERR_ABORTED` — there is no body for the
     * renderer to read, so the network stack tears the stream down and files it
     * as cancelled. Measured, not assumed: the deletion is committed (the
     * `vehicle` class disappeared from the trunk two steps up), `save-state`
     * read `Saved`, and the POST that follows it in `useSaveAnnotations` only
     * fires after the DELETE's `await` resolves. It is bookkeeping, not a
     * failure.
     *
     * It had no coverage before this walk because nothing in the browser had
     * ever deleted an annotation — the correction story is the first thing that
     * does, and it is the repo's only `204` fetch.
     *
     * Asserted as an exact list rather than filtered away: a *second* aborted
     * call, or one on another route, is the shape of a request the app really
     * did abandon, and that is worth failing on.
     */
    expect(abortedApiCalls).toEqual([expect.stringMatching(/^DELETE .*\/annotations$/)]);
    // And the icon is genuinely served under the mount, rather than absent and
    // unnoticed: `vite preview` would answer 200 with `index.html` here, which is
    // #49's trap and the reason this is checked against the real server.
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
 * a number somebody typed — #159's arithmetic was correct throughout and the
 * measurement never happened.
 */
async function columnsOf(page: Page): Promise<{ rendered: number; expected: number }> {
  await expect(page.getByTestId("gallery-row-0")).toBeVisible();
  return await page.evaluate(() => {
    const GAP = 12;
    // #284 removed the nested scroller — the document scrolls now — so the pane
    // is the grid itself, and the tile size is the density slider's rather than a
    // constant. `data-min-column` is the layout's *input*; `rendered` is its
    // output. Reading the count off `data-columns` would assert the value against
    // itself, which is #159's mistake in a new costume.
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
 * #171 put the schema, the batches and the version history behind tabs, so
 * "reach the batch table" is now two clicks rather than one. It is clicked rather
 * than reached by `?tab=`, for the same reason nothing here types a URL: a step
 * that navigates by address cannot notice that the control is missing.
 */
async function openProject(
  page: Page,
  project: string,
  tab: "schema" | "batches" | "dataset",
): Promise<void> {
  await page.getByTestId("rail-projects").click();
  await expect(page.getByTestId(`open-${project}`)).toBeVisible();
  await page.getByTestId(`open-${project}`).click();
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
 * Through the top bar's class field rather than the digit, and the difference is
 * not cosmetic: a hotkey's effect reaches the machine through the host's own state,
 * so a press and a drag issued back to back can both be seen while the old class is
 * still current. The field prints the class it is holding, which turns that into
 * something to wait on — and it is also how a person picks a class.
 *
 * The cycle lost a run to exactly this before the wait existed.
 */
async function activate(page: Page, name: string): Promise<void> {
  await page.getByTestId("class-field-trigger").click();
  await page.getByTestId(`class-field-option-${name}`).click();
  await expect(page.getByTestId("class-field-name")).toHaveText(name);
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
