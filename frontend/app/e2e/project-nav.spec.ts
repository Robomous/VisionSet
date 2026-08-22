/**
 * The project's navigation column: where it is, where it is not, and what it
 * collapses to.
 *
 * Everything here is a browser fact. Which layout renders is a `matchMedia`
 * answer, so a jsdom test sees the wide one whatever the CSS says; and "one
 * filled control per view" is a claim about a computed colour, not a class
 * string — a `bg-primary` that Tailwind never compiled would pass a class
 * assertion and paint nothing.
 */

import { expect, test, type Page } from "@playwright/test";
import { assetActions, batchActions, jobActions, type Wire } from "./_wire";

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
  version: 4,
  classes: [{ name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] }],
} satisfies Wire["SchemaVersionOut"];

const OPEN_BATCH = {
  id: BATCH,
  project_id: PROJECT,
  name: "drive-01",
  state: "in_annotation",
  allowed_actions: batchActions("in_annotation"),
  promoted_asset_count: 0,
  parent_batch_id: null,
  pre_label_run: null,
  schema_version: 4,
  asset_count: 1,
  progress: { ...NO_PROGRESS, unannotated: 1, total: 1 },
} satisfies Wire["BatchOut"];

/** A 1x1 PNG, so the annotator has real pixels to lay out. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** One project, one open batch, one job — enough for every route this suite visits. */
async function serveApi(page: Page): Promise<void> {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");

    if (path === "/session") return route.fulfill({ json: { issued: false } });
    if (path === "/projects") {
      return route.fulfill({
        json: {
          items: [{ id: PROJECT, name: "road-signs", description: null, thumbnail_asset_id: null, thumbnail_hash: null }],
          total: 1,
        } satisfies Wire["ProjectPage"],
      });
    }
    if (path === `/projects/${PROJECT}`) {
      return route.fulfill({
        json: { id: PROJECT, name: "road-signs", description: null, thumbnail_asset_id: null, thumbnail_hash: null } satisfies Wire["ProjectOut"],
      });
    }
    if (path === `/projects/${PROJECT}/schema`) return route.fulfill({ json: SCHEMA });
    if (path === `/projects/${PROJECT}/schema/versions/4`) return route.fulfill({ json: SCHEMA });
    if (path === `/projects/${PROJECT}/batches`) {
      return route.fulfill({ json: { items: [OPEN_BATCH], total: 1 } satisfies Wire["BatchPage"] });
    }
    if (path === `/projects/${PROJECT}/dataset`) {
      return route.fulfill({
        json: { id: DATASET, project_id: PROJECT, name: "road-signs", description: null } satisfies Wire["DatasetOut"],
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
          last_ingest_at: null,
        } satisfies Wire["ProjectStatsOut"],
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
        } satisfies Wire["JobOut"],
      });
    }
    if (path === `/jobs/${JOB}/progress`) {
      return route.fulfill({
        json: { ...NO_PROGRESS, unannotated: 1, total: 1 } satisfies Wire["ProgressCounts"],
      });
    }
    if (path === `/batches/${BATCH}`) return route.fulfill({ json: OPEN_BATCH });
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
              allowed_actions: assetActions("unannotated"),
              annotation_count: 0,
              min_confidence: null,
            },
          ],
          total: 1,
        } satisfies Wire["BatchAssetPage"],
      });
    }
    if (path.endsWith("/annotations")) {
      return route.fulfill({ json: { items: [], total: 0 } satisfies Wire["AnnotationPage"] });
    }
    if (path.endsWith("/content")) return route.fulfill({ contentType: "image/png", body: PIXEL });
    return route.fulfill({ json: { items: [], total: 0 } satisfies Wire["AssetPage"] });
  });
}

async function openCold(page: Page, url: string): Promise<void> {
  await serveApi(page);
  await page.goto(url);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
}

const SECTIONS = ["overview", "schema", "batches", "dataset"] as const;

/**
 * How many visible controls are filled with the `primary` token, by computed
 * colour. The token's resolved value is read off a probe painted with it, so the
 * comparison is between two strings the same engine produced; a hidden element
 * is not on the page and is not counted.
 */
async function filledControls(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--primary)";
    document.body.append(probe);
    const primary = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [...document.querySelectorAll<HTMLElement>("button, a, [role='button']")].filter(
      (element) =>
        element.getClientRects().length > 0 && getComputedStyle(element).backgroundColor === primary,
    ).length;
  });
}

for (const section of SECTIONS) {
  test(`at lg and above the column renders on ${section}, with one filled control`, async ({
    page,
  }) => {
    await openCold(page, `/projects/${PROJECT}/${section}`);
    await expect(page.getByTestId("project-screen")).toBeVisible();

    const nav = page.getByTestId("project-nav");
    await expect(nav).toBeVisible();
    await expect(page.getByTestId(`nav-${section}`)).toHaveAttribute("aria-current", "page");
    // The tab strip is not merely hidden at this width; it is not rendered.
    await expect(page.getByTestId("project-tabs")).toHaveCount(0);

    // The identity travels with the navigation: the way out, the name, the chip,
    // and Annotate as the one filled control — the project has a batch open.
    await expect(nav.getByTestId("project-back")).toContainText("Projects");
    await expect(nav.getByTestId("project-title")).toHaveText("road-signs");
    await expect(nav.getByTestId("chip-version")).toHaveText("v4 active");
    await expect(nav.getByTestId("go-annotate")).toBeVisible();
    await expect(nav.getByTestId("project-menu")).toBeVisible();

    // The section's own header, with its secondary actions. Measured rather than
    // class-asserted: the claim is about what is painted.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    // Overview and Batches carry a secondary Ingest beside Annotate; it must not
    // count as a second filled control.
    expect(await filledControls(page)).toBe(1);
  });
}

test("the column frames the ingest flow and the batch gallery too, without a filled control of its own", async ({
  page,
}) => {
  // Everything that belongs to one project lives inside the same navigation;
  // only the annotator, which needs the whole screen, stands outside it.
  await openCold(page, `/projects/${PROJECT}/batches/${BATCH}`);
  await expect(page.getByTestId("gallery")).toBeVisible();
  const nav = page.getByTestId("project-nav");
  await expect(nav).toBeVisible();
  // A batch belongs to Batches, so Batches is lit.
  await expect(page.getByTestId("nav-batches")).toHaveAttribute("aria-current", "page");
  await expect(nav.getByTestId("project-title")).toHaveText("road-signs");
  // The gallery owns its dominant action; the column offers none beside it.
  await expect(nav.getByTestId("go-annotate")).toHaveCount(0);
  await expect(nav.getByTestId("go-ingest")).toHaveCount(0);

  await page.goto(`/projects/${PROJECT}/ingest`);
  await expect(page.getByTestId("ingest-screen")).toBeVisible();
  await expect(page.getByTestId("project-nav")).toBeVisible();
  // An ingest is the project's, not any one section's: nothing is lit.
  await expect(page.locator('[data-testid^="nav-"][aria-current="page"]')).toHaveCount(0);
});

test("the column is absent from every route that is not the project's", async ({ page }) => {
  await openCold(page, "/");
  await expect(page.getByTestId("app-rail")).toBeVisible();
  await expect(page.getByTestId("project-nav")).toHaveCount(0);

  await page.goto("/projects");
  await expect(page.getByTestId("open-road-signs")).toBeVisible();
  await expect(page.getByTestId("project-nav")).toHaveCount(0);

  await page.goto("/inference");
  await expect(page.getByTestId("app-rail")).toBeVisible();
  await expect(page.getByTestId("project-nav")).toHaveCount(0);

  await page.goto(`/jobs/${JOB}`);
  await expect(page.getByTestId("annotation-page")).toBeVisible();
  await expect(page.getByTestId("project-nav")).toHaveCount(0);
});

test("below lg the tab strip renders and the column does not, with nothing lost", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await openCold(page, `/projects/${PROJECT}/batches`);
  await expect(page.getByTestId("batches-screen")).toBeVisible();

  await expect(page.getByTestId("project-nav")).toHaveCount(0);
  await expect(page.getByTestId("project-tabs")).toBeVisible();
  await expect(page.getByTestId("nav-batches")).toHaveAttribute("aria-selected", "true");

  // The identity row above the strip: what the column showed, in a row.
  await expect(page.getByTestId("project-back")).toContainText("Projects");
  await expect(page.getByTestId("project-title")).toHaveText("road-signs");
  await expect(page.getByTestId("chip-version")).toHaveText("v4 active");
  await expect(page.getByTestId("go-annotate")).toBeVisible();
  await expect(page.getByTestId("project-menu")).toBeVisible();
  expect(await filledControls(page)).toBe(1);

  // And the strip navigates: the URL moves with the tab.
  await page.getByTestId("nav-dataset").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/dataset$`));
  await expect(page.getByTestId("dataset-screen")).toBeVisible();
});

test("the column's items are real links, so the section has an address before it is pressed", async ({
  page,
}) => {
  await openCold(page, `/projects/${PROJECT}/overview`);
  await expect(page.getByTestId("project-nav")).toBeVisible();

  await expect(page.getByTestId("nav-schema")).toHaveAttribute("href", `/projects/${PROJECT}/schema`);
  await page.getByTestId("nav-schema").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/schema$`));
  await expect(page.getByTestId("schema-editor")).toBeVisible();
  await expect(page.getByTestId("nav-schema")).toHaveAttribute("aria-current", "page");
});
