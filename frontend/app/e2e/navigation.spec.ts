/**
 * The way back out of every sub-view, and the addresses a project answers.
 *
 * ## Every scenario navigates by URL, and that is the whole method
 *
 * The defect this suite exists for is that five sub-views offered no way out at
 * all and the sixth offered `navigate(-1)`. A scenario that clicked its way in
 * would find history pointing at the right place and would pass over the top of
 * both — which is exactly what `annotate.spec.ts`'s existing back scenario did.
 *
 * So each one does `page.goto` straight to the sub-view, signs in there, and
 * presses the control. With an empty history there is nowhere for `navigate(-1)`
 * to go, so only a **structural** parent can satisfy these.
 *
 * The destinations themselves are `routes.tsx`'s `PARENT` table, and
 * `docs/content/ui/navigation.md` is the prose. `ui-core`'s `navigation.test.tsx`
 * holds the half a component test can see — that each screen draws its way out
 * and calls back.
 *
 * ## The claim that lives here and nowhere else
 *
 * That a way out reaches the right **URL**, which `ui-core` cannot know because
 * it imports no router.
 */

import { expect, test, type Page } from "@playwright/test";
import { assetActions, batchActions, jobActions, projectDigest, type Wire } from "./_wire";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const DATASET = "44444444-4444-4444-8444-444444444444";
const JOB = "33333333-3333-4333-8333-333333333333";

const NO_PROGRESS = {
  unannotated: 0,
  pre_labeled: 0,
  annotated: 0,
  skipped: 0,
  review_pending: 0,
  accepted: 0,
  total: 0,
} satisfies Wire["ProgressCounts"];

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  classes: [{ name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] }],
} satisfies Wire["SchemaVersionOut"];

/** A 1x1 PNG, so the annotator has real pixels to lay out. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * One stub for five screens, keyed on the path alone.
 *
 * Everything is static: this suite asks one question — where does the way out
 * go? — and nothing about it depends on state moving.
 */
const BATCH_OUT = {
  id: BATCH,
  project_id: PROJECT,
  name: "drive-01",
  state: "in_annotation",
  allowed_actions: batchActions("in_annotation", { settled: false }),
  modalities: ["image"],
  promoted_asset_count: 0,
  parent_batch_id: null,
  pre_label_run: null,
  schema_version: 1,
  asset_count: 1,
  progress: { ...NO_PROGRESS, unannotated: 1, total: 1 },
} satisfies Wire["BatchOut"];

async function serveApi(page: Page): Promise<void> {
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");

    if (path === "/session") return route.fulfill({ json: { issued: false } });
    if (path === "/projects") {
      return route.fulfill({
        json: {
          items: [{ id: PROJECT, name: "road-signs", description: null, thumbnail_asset_id: null, thumbnail_hash: null, created_at: null, digest: projectDigest() }],
          total: 1,
        } satisfies Wire["ProjectPage"],
      });
    }
    if (path === `/projects/${PROJECT}`) {
      return route.fulfill({
        json: { id: PROJECT, name: "road-signs", description: null, thumbnail_asset_id: null, thumbnail_hash: null, created_at: null } satisfies Wire["ProjectOut"],
      });
    }
    if (path === `/projects/${PROJECT}/schema`) return route.fulfill({ json: SCHEMA });
    if (path === `/projects/${PROJECT}/schema/versions/1`) return route.fulfill({ json: SCHEMA });
    if (path === `/projects/${PROJECT}/dataset`) {
      return route.fulfill({
        json: {
          id: DATASET,
          project_id: PROJECT,
          name: "road-signs",
          description: null,
        } satisfies Wire["DatasetOut"],
      });
    }
    if (path === `/datasets/${DATASET}/stats`) {
      return route.fulfill({
        json: {
          dataset_id: DATASET,
          asset_count: 0,
          annotated_asset_count: 0,
          annotation_count: 0,
          classes: [],
        } satisfies Wire["DatasetStatsOut"],
      });
    }
    if (path === `/jobs/${JOB}`) {
      return route.fulfill({
        json: {
          id: JOB,
          batch_id: BATCH,
          state: "in_progress",
          asset_count: 1,
          allowed_actions: jobActions("in_progress"),
          assignee: null,
          pre_label_run: null,
        } satisfies Wire["JobOut"],
      });
    }
    if (path === `/jobs/${JOB}/progress`) {
      return route.fulfill({
        json: { ...NO_PROGRESS, unannotated: 1, total: 1 } satisfies Wire["ProgressCounts"],
      });
    }
    if (path === `/projects/${PROJECT}/batches`) {
      return route.fulfill({ json: { items: [BATCH_OUT], total: 1 } satisfies Wire["BatchPage"] });
    }
    if (path === `/batches/${BATCH}`) return route.fulfill({ json: BATCH_OUT });
    if (path === `/batches/${BATCH}/assets`) {
      return route.fulfill({
        json: {
          items: [
            {
              id: "asset-1",
              project_id: PROJECT,
              modality: "image",
              point_cloud: null,
              content_hash: "abcdef01abcdef01",
              width: 640,
              height: 480,
              format: "png",
              source_id: null,
              frame_index: 0,
              frame_timestamp: null,
              thumbnail_hash: null,
              ingested_at: null,
              job_id: JOB,
              progress: "unannotated",
              allowed_actions: assetActions("unannotated"),
              annotation_count: 0,
              min_confidence: null,
              withheld_actions: [],
              observed: [],
            },
          ],
          total: 1,
        } satisfies Wire["BatchAssetPage"],
      });
    }
    // The project's own counts. The catch-all below answers every
    // *collection* with an empty page, which is the wrong document for this one —
    // and a stub answering a shape the endpoint never sends tests nothing.
    if (path === `/projects/${PROJECT}/stats`) {
      return route.fulfill({
        json: {
          project_id: PROJECT,
          asset_count: 1,
          annotated_asset_count: 0,
          annotation_count: 0,
          class_count: 1,
          annotated_pct: 0,
          classes: [],
          // Null is what the endpoint sends for a project whose assets
          // predate v0.1.0, and for one holding none. Present, not omitted:
          // a stub answering a shape the endpoint never sends tests nothing.
          last_ingest_at: null,
        } satisfies Wire["ProjectStatsOut"],
      });
    }
    if (path.endsWith("/annotations")) {
      return route.fulfill({ json: { items: [], total: 0 } satisfies Wire["AnnotationPage"] });
    }
    if (path.endsWith("/content")) return route.fulfill({ contentType: "image/png", body: PIXEL });
    // Everything else a screen may ask for: an empty collection is a legal answer
    // to every listing this suite reaches, and none of them is what is under test.
    return route.fulfill({ json: { items: [], total: 0 } satisfies Wire["AssetPage"] });
  });
}

/**
 * Open a sub-view **cold** — no clicking through, so `window.history` has one
 * entry and `navigate(-1)` has nowhere to go.
 */
async function openCold(page: Page, url: string): Promise<void> {
  await serveApi(page);
  await page.goto(url);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
}

/**
 * The old ingest page's address, kept as a promise.
 *
 * Add images was a page under the project, with a way out of its own. It is a
 * dialog over the project now, so there is no page to leave: the address lands on
 * the Overview with the dialog open, and closing it is the way out — onto the
 * section it was opened over, not into an empty history.
 */
test("the old ingest URL opens Add images over the Overview, and closing it stays there", async ({ page }) => {
  await openCold(page, `/projects/${PROJECT}/ingest`);

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/overview\\?add=images$`));
  const dialog = page.getByRole("dialog", { name: "Add images" });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("nav-overview")).toHaveAttribute("aria-current", "page");

  await page.getByTestId("add-images-close").click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/overview$`));
  await expect(page.getByTestId("project-screen")).toBeVisible();
});

/**
 * The annotator, which is the one that fails today under this method.
 *
 * It had a back button all along, wired to `navigate(-1)`. Reached by clicking a
 * tile that resolves to the batch; reached cold — a pasted link, a reload, a
 * bookmark — it has nowhere to go at all. This is the scenario that says so.
 */
test("the annotator returns to its batch from a cold open, not into an empty history", async ({
  page,
}) => {
  await openCold(page, `/jobs/${JOB}`);
  await expect(page.getByTestId("annotation-page")).toBeVisible();

  await page.getByTestId("back").click();
  // The batch is a panel on the Overview, so "back to the batch" is the Overview with
  // that batch open — and the panel is really there, not just the address.
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/overview\\?batch=${BATCH}$`));
  await expect(page.getByTestId("batch-sheet").getByRole("heading", { level: 2, name: "drive-01" })).toBeVisible();
  await expect(page.getByTestId("nav-overview")).toHaveAttribute("aria-current", "page");
});

test("the annotator's grid button stays in the editor and the URL does not move", async ({
  page,
}) => {
  // Two controls, two meanings: the arrow means *up* and goes to the
  // batch; the grid means *show me the other frames* and opens an overlay over
  // the workspace. They used to share a destination, which made looking at your
  // own frames an exit — the trip `DESIGN.md` principle 10 exists to prevent.
  //
  // The URL is the assertion, and it is asserted in a browser because that is
  // where a route change is a real thing rather than a callback nobody called.
  await openCold(page, `/jobs/${JOB}`);
  await expect(page.getByTestId("annotation-page")).toBeVisible();
  const before = page.url();

  await page.getByTestId("open-gallery").click();

  await expect(page.getByTestId("frame-gallery")).toBeVisible();
  expect(page.url()).toBe(before);
  // The editor is still mounted underneath, which is the other half of "no
  // navigation": nothing was torn down and nothing has to be rebuilt on the way
  // back.
  await expect(page.getByTestId("annotation-page")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("frame-gallery")).toHaveCount(0);
  expect(page.url()).toBe(before);
});

test("a batch's old URL redirects to its panel on the Overview, and says which batch it is", async ({
  page,
}) => {
  // A batch had a page of its own at this address; a bookmark of it is a promise, so it
  // lands where the batch now is. A pasted link must still say which batch it is —
  // the panel's heading is that, with no row to have remembered pressing.
  await openCold(page, `/projects/${PROJECT}/batches/${BATCH}`);

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/overview\\?batch=${BATCH}$`));
  const panel = page.getByTestId("batch-sheet");
  await expect(panel).toHaveAttribute("aria-label", "Batch");
  await expect(panel.getByRole("heading", { level: 2, name: "drive-01" })).toBeVisible();
  // The Overview is lit and showing its batches: the batch is a thing on it, not a
  // place of its own — so there is no page to leave, and no gallery.
  await expect(page.getByTestId("nav-overview")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("overview-batches")).toBeVisible();
  await expect(page.getByTestId("back-link")).toHaveCount(0);
  await expect(page.getByTestId("gallery")).toHaveCount(0);
});

test("Add images names the project it adds to", async ({ page }) => {
  // The dialog stands over the project, so it says which one — the name, not
  // "this project", once the project has answered.
  await openCold(page, `/projects/${PROJECT}/ingest`);
  await expect(page.getByRole("dialog", { name: "Add images" })).toContainText("to road-signs");
});

test("a section has no way out of its own: the toolbar, the tabs and the rail are it", async ({ page }) => {
  await openCold(page, `/projects/${PROJECT}/overview`);
  await expect(page.getByTestId("project-screen")).toBeVisible();
  await expect(page.getByTestId("back-link")).toHaveCount(0);
});

/**
 * The dataset's old address, kept as a promise — and now its own again.
 *
 * It was `/projects/:id/dataset` — a route reachable only through an overflow
 * menu, an Overview link, and the last step of an onboarding checklist. That is
 * three indirect doors onto the product's central object, which is what made it
 * a first-class thing nobody could find. It became a tab behind `?tab=dataset`
 * with the old URL redirecting; with sections as path segments the old URL *is*
 * the section, and the promise is kept by the route rather than by a bounce.
 */
test("the dataset's old URL is the Dataset section itself", async ({ page }) => {
  await openCold(page, `/projects/${PROJECT}/dataset`);

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/dataset$`));
  await expect(page.getByTestId("dataset-screen")).toBeVisible();
  // And the navigation knows where it is.
  await expect(page.getByTestId("nav-dataset")).toHaveAttribute("aria-current", "page");
});

test("a bookmarked ?tab=versions lands on Schema, with the history one press away", async ({
  page,
}) => {
  // The history was a fourth tab — a read-only view *of* the second, offered as
  // a peer of it, which is how "Schema history" and "Releases" became confusable
  // enough that one of them had to be renamed. It nests inside Schema. And
  // `?tab=` itself is an old address now: the section is a path segment, so the
  // whole query form redirects, old links being the promise they always were.
  await openCold(page, `/projects/${PROJECT}?tab=versions`);

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/schema$`));
  await expect(page.getByTestId("schema-editor")).toBeVisible();
  // The history is the section's sheet, opened from its band.
  await page.getByTestId("open-history").click();
  await expect(page.getByTestId("version-history")).toBeVisible();
  // Versions is gone from the navigation, which is the half that matters: a
  // redirect that left the entry in place would have moved nothing.
  await expect(page.getByTestId("nav-versions")).toHaveCount(0);
});

test("a ?tab= address keeps its other query parameters across the redirect", async ({ page }) => {
  await openCold(page, `/projects/${PROJECT}?tab=schema&ref=mail`);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/schema\\?ref=mail$`));
  await expect(page.getByTestId("schema-editor")).toBeVisible();
});

test("the old Batches section address, and ?tab=batches, land on the Overview", async ({ page }) => {
  // `batches` was a bookmarkable section until its list moved onto the Overview;
  // old links keep landing where the batches now are.
  await openCold(page, `/projects/${PROJECT}/batches`);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/overview$`));
  await expect(page.getByTestId("nav-overview")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("overview-batches")).toBeVisible();
  await expect(page.getByTestId("batches-screen")).toHaveCount(0);

  await page.goto(`/projects/${PROJECT}?tab=batches`);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/overview$`));
  await expect(page.getByTestId("overview-batches")).toBeVisible();
});

test("the dataset is one press from every other section", async ({ page }) => {
  // The navigation rule this task exists for: the trunk is the
  // product's central object and must be reachable in one click from any project
  // section. It used to take an overflow menu.
  await openCold(page, `/projects/${PROJECT}`);
  await expect(page.getByTestId("project-screen")).toBeVisible();

  for (const from of ["nav-overview", "nav-images", "nav-schema"]) {
    await page.getByTestId(from).click();
    await expect(page.getByTestId("nav-dataset")).toBeVisible();
  }
  await page.getByTestId("nav-dataset").click();
  await expect(page.getByTestId("dataset-screen")).toBeVisible();
});
