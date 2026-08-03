/**
 * The way back out of every sub-view (#199).
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
 * The parents themselves are `routes.tsx`'s `PARENT` table, and `DESIGN.md`'s
 * **Navigation rules** is the prose. `ui-core`'s `navigation.test.tsx` holds the
 * other half — that each screen draws the control and calls back — which a
 * component test can see and a URL cannot.
 */

import { expect, test, type Page } from "@playwright/test";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const DATASET = "44444444-4444-4444-8444-444444444444";
const JOB = "33333333-3333-4333-8333-333333333333";

const NO_PROGRESS = {
  unannotated: 0,
  annotated: 0,
  skipped: 0,
  review_pending: 0,
  accepted: 0,
  total: 0,
};

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  classes: [{ name: "vehicle", geometry: "bbox", color: "#38bdf8", attributes: [] }],
};

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
async function serveApi(page: Page): Promise<void> {
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");

    if (path === "/session") return route.fulfill({ json: { issued: false } });
    if (path === "/projects") {
      return route.fulfill({ json: { items: [{ id: PROJECT, name: "road-signs", description: null }], total: 1 } });
    }
    if (path === `/projects/${PROJECT}`) {
      return route.fulfill({ json: { id: PROJECT, name: "road-signs", description: null } });
    }
    if (path === `/projects/${PROJECT}/schema`) return route.fulfill({ json: SCHEMA });
    if (path === `/projects/${PROJECT}/schema/versions/1`) return route.fulfill({ json: SCHEMA });
    if (path === `/projects/${PROJECT}/dataset`) {
      return route.fulfill({ json: { id: DATASET, project_id: PROJECT, name: "road-signs" } });
    }
    if (path === `/datasets/${DATASET}/stats`) {
      return route.fulfill({
        json: {
          dataset_id: DATASET,
          asset_count: 0,
          annotated_asset_count: 0,
          annotation_count: 0,
          classes: [],
        },
      });
    }
    if (path === `/jobs/${JOB}`) {
      return route.fulfill({ json: { id: JOB, batch_id: BATCH, state: "in_progress", asset_count: 1 } });
    }
    if (path === `/jobs/${JOB}/progress`) return route.fulfill({ json: { ...NO_PROGRESS, unannotated: 1, total: 1 } });
    if (path === `/batches/${BATCH}`) {
      return route.fulfill({
        json: {
          id: BATCH,
          project_id: PROJECT,
          name: "drive-01",
          state: "in_annotation",
          schema_version: 1,
          asset_count: 1,
          progress: { ...NO_PROGRESS, unannotated: 1, total: 1 },
        },
      });
    }
    if (path === `/batches/${BATCH}/assets`) {
      return route.fulfill({
        json: {
          items: [
            {
              id: "asset-1",
              project_id: PROJECT,
              modality: "image",
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
            },
          ],
          total: 1,
        },
      });
    }
    // The project's own counts (#207). The catch-all below answers every
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
        },
      });
    }
    if (path.endsWith("/annotations")) return route.fulfill({ json: { items: [], total: 0 } });
    if (path.endsWith("/content")) return route.fulfill({ contentType: "image/png", body: PIXEL });
    // Everything else a screen may ask for: an empty collection is a legal answer
    // to every listing this suite reaches, and none of them is what is under test.
    return route.fulfill({ json: { items: [], total: 0 } });
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

/** #199's audit table, as data. The control is one testid on every padded screen. */
const SUBVIEWS = [
  {
    name: "the project",
    url: `/projects/${PROJECT}`,
    ready: "project-screen",
    parent: /\/projects$/,
  },
  {
    name: "ingest",
    url: `/projects/${PROJECT}/ingest`,
    ready: "ingest-screen",
    parent: new RegExp(`/projects/${PROJECT}$`),
  },
  {
    name: "the batch gallery",
    url: `/projects/${PROJECT}/batches/${BATCH}`,
    ready: "gallery",
    // Back to the tab the batch was on, not to the project's default section:
    // landing on Schema after leaving a batch is landing somewhere you were not.
    parent: new RegExp(`/projects/${PROJECT}\\?tab=batches$`),
  },
  {
    name: "the dataset",
    url: `/projects/${PROJECT}/dataset`,
    ready: "dataset-screen",
    parent: new RegExp(`/projects/${PROJECT}$`),
  },
] as const;

for (const view of SUBVIEWS) {
  test(`${view.name} returns to its parent from a cold open`, async ({ page }) => {
    await openCold(page, view.url);
    await expect(page.getByTestId(view.ready)).toBeVisible();

    await page.getByTestId("back-link").click();
    await expect(page).toHaveURL(view.parent);
  });
}

/**
 * The annotator, which is the one that fails today under this method.
 *
 * It had a back button all along, wired to `navigate(-1)`. Reached by clicking a
 * tile that resolves to the gallery; reached cold — a pasted link, a reload, a
 * bookmark — it has nowhere to go at all. This is the scenario that says so.
 */
test("the annotator returns to its batch from a cold open, not into an empty history", async ({
  page,
}) => {
  await openCold(page, `/jobs/${JOB}`);
  await expect(page.getByTestId("annotation-page")).toBeVisible();

  await page.getByTestId("back").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/batches/${BATCH}$`));
});

test("the annotator's grid button goes to the same place the arrow does", async ({ page }) => {
  // Two controls, one destination, deliberately: the arrow means *up* and the
  // grid means *show me the grid*, and they coincide because the annotator's
  // parent is the grid. `DESIGN.md`'s top bar draws both.
  await openCold(page, `/jobs/${JOB}`);
  await expect(page.getByTestId("annotation-page")).toBeVisible();

  await page.getByTestId("open-gallery").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/batches/${BATCH}$`));
});

test("the batch gallery says which batch it is showing", async ({ page }) => {
  // The one page in the product with no header at all before #199: a grid of
  // thumbnails and a count, legible only if you remembered which tile you pressed
  // — and unreadable entirely on a pasted link.
  await openCold(page, `/projects/${PROJECT}/batches/${BATCH}`);
  await expect(page.getByTestId("batch-title")).toHaveText("drive-01");
});

test("the way out names the project it goes to", async ({ page }) => {
  // "Back" alone is a promise about history. Naming the destination is a promise
  // about structure, which is the one the control can keep.
  await openCold(page, `/projects/${PROJECT}/ingest`);
  await expect(page.getByTestId("back-link")).toContainText("road-signs");
});

test("the project's own way out names the list, not a project", async ({ page }) => {
  // One level up from a project is `Projects`, and it is the one sub-view whose
  // parent has a fixed name rather than one that has to load.
  await openCold(page, `/projects/${PROJECT}`);
  await expect(page.getByTestId("back-link")).toContainText("Projects");
});
