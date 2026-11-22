/**
 * The project's section toolbar: where it is, where it is not, and what it
 * becomes below `lg`.
 *
 * Everything here is a browser fact. Which layout renders is a `matchMedia`
 * answer, so a jsdom test sees the wide one whatever the CSS says; and "one
 * filled control per view" is a claim about a computed colour, not a class
 * string — a `bg-primary` that Tailwind never compiled would pass a class
 * assertion and paint nothing.
 */

import { expect, test, type Page } from "@playwright/test";
import { assetActions, batchActions, jobActions, projectDigest, type Wire } from "./_wire";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const DATASET = "44444444-4444-4444-8444-444444444444";
const JOB = "33333333-3333-4333-8333-333333333333";
const OTHER_JOB = "55555555-5555-4555-8555-555555555555";

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

/** A panel of the open batch's jobs accordion, waiting to be started. */
function pendingJob(id: string): Wire["JobOut"] {
  return {
    id,
    batch_id: BATCH,
    state: "pending",
    assignee: null,
    asset_count: 3,
    allowed_actions: jobActions("pending"),
    pre_label_run: null,
  };
}

/** The project's one image, as the Images section's paged read answers it. */
const PROJECT_ASSET = {
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
} satisfies Wire["AssetOut"];

/**
 * One project, one open batch, and the jobs cut from it — enough for every route
 * this suite visits. The job ids decide where the `Annotate` control lands.
 */
async function serveApi(page: Page, jobs: readonly string[] = [JOB]): Promise<void> {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");

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
          pre_label_run: null,
        } satisfies Wire["JobOut"],
      });
    }
    if (path === `/batches/${BATCH}/jobs`) {
      return route.fulfill({
        json: { items: jobs.map(pendingJob), total: jobs.length } satisfies Wire["JobPage"],
      });
    }
    // Every job in the roster, not only the one the annotator opens: the
    // accordion holds its panels shut until all of their counts have answered.
    if (/^\/jobs\/[^/]+\/progress$/.test(path)) {
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
            },
          ],
          total: 1,
        } satisfies Wire["BatchAssetPage"],
      });
    }
    // The Images section's one read: every asset of the project, paged.
    if (path === `/projects/${PROJECT}/assets`) {
      return route.fulfill({
        json: { items: [PROJECT_ASSET], total: 1 } satisfies Wire["AssetPage"],
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

/**
 * The same cold open, held until the open batch's jobs have been answered.
 *
 * Where the `Annotate` control lands is decided by that answer, and its absence
 * is not a failure but the fallback — the gallery. So a test that clicks before
 * it arrives proves nothing either way. Nothing is fetched until the token is
 * accepted, which is why the wait can be armed before the submit.
 */
async function openWithJobs(page: Page, url: string, jobs: readonly string[]): Promise<void> {
  await serveApi(page, jobs);
  await page.goto(url);
  await page.getByTestId("token-input").fill("a-token");
  const answered = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(`/batches/${BATCH}/jobs`),
  );
  await page.getByTestId("token-submit").click();
  await answered;
  await expect(page.getByTestId("go-annotate")).toBeVisible();
}

const SECTIONS = ["overview", "images", "schema", "dataset"] as const;

/** The one heading each section carries for the outline, in the words its tab uses. */
const HEADINGS = { overview: "Overview", images: "Images", schema: "Classes", dataset: "Dataset" } as const;

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
  test(`at lg and above the toolbar renders on ${section}, with one filled control`, async ({
    page,
  }) => {
    await openCold(page, `/projects/${PROJECT}/${section}`);
    await expect(page.getByTestId("project-screen")).toBeVisible();

    const nav = page.getByTestId("project-nav");
    await expect(nav).toBeVisible();
    await expect(page.getByTestId(`nav-${section}`)).toHaveAttribute("aria-current", "page");
    // The tab strip is not merely hidden at this width; it is not rendered.
    await expect(page.getByTestId("project-tabs")).toHaveCount(0);

    // The toolbar holds controls only: the sections, what the open section
    // offers, and the overflow. Add images is a button where images are the
    // subject (Overview, Images) and the overflow's first entry elsewhere; the
    // project has a batch open, so Annotate — the Overview's alone — is the one
    // filled control there. The identity is the open-project tab above the
    // toolbar: no eyebrow line is drawn over the content, and no way out,
    // because the toolbar, the tabs and the rail are it.
    const imagesSubject = section === "overview" || section === "images";
    await expect(nav.getByTestId("go-annotate")).toHaveCount(section === "overview" ? 1 : 0);
    await expect(nav.getByTestId("go-ingest")).toHaveCount(imagesSubject ? 1 : 0);
    await expect(nav.getByTestId("project-menu")).toBeVisible();
    await expect(nav.getByTestId("project-menu")).toHaveAccessibleName("Project actions");
    await expect(page.getByTestId("project-identity")).toHaveCount(0);
    await expect(page.getByTestId("project-title")).toHaveCount(0);
    await expect(page.getByTestId("chip-version")).toHaveCount(0);
    await expect(page.getByTestId("back-link")).toHaveCount(0);
    await expect(page.getByTestId(`open-tab-${PROJECT}`)).toContainText("road-signs");
    // It spans the pane — everything right of the rail — so it lines up with the
    // open-project tabs above it rather than with the capped content column.
    const rail = (await page.getByTestId("app-rail").boundingBox())!;
    const bar = (await nav.boundingBox())!;
    expect(bar.x).toBeCloseTo(rail.x + rail.width, 0);
    expect(bar.width).toBeCloseTo((page.viewportSize()?.width ?? 0) - rail.width, 0);

    // No section header: the tab is the title to the eye, and one heading
    // names the section to the outline. Counted as painted, not class-asserted.
    await expect(page.getByTestId("section-header")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(HEADINGS[section]);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    // Never in a section's content, and never both a button and a menu entry.
    await expect(page.getByTestId("go-ingest")).toHaveCount(imagesSubject ? 1 : 0);
    expect(await filledControls(page)).toBe(1);
  });
}

/** What the toolbar says about the open section, after the tabs; Images says nothing. */
const META = {
  overview: "0% labeled · 0 annotations",
  images: null,
  schema: "Version 4 in force",
  dataset: "No releases yet",
} as const;

for (const section of SECTIONS) {
  test(`the toolbar's one line about ${section} is ${META[section] === null ? "absent" : `"${META[section]}"`}`, async ({
    page,
  }) => {
    await openCold(page, `/projects/${PROJECT}/${section}`);
    const nav = page.getByTestId("project-nav");
    await expect(nav).toBeVisible();
    const meta = META[section];
    if (meta === null) {
      // The counts are the last thing the toolbar settles on: after them the
      // absence is an answer rather than a pending query.
      await expect(page.getByTestId("nav-images")).toContainText("1");
      await expect(page.getByTestId("section-meta")).toHaveCount(0);
    } else {
      await expect(nav.getByTestId("section-meta")).toHaveText(meta);
      await expect(page.getByTestId("section-meta")).toHaveCount(1);
    }
  });
}

test("the toolbar offers the four sections in the order work happens in, under their labels", async ({
  page,
}) => {
  await openCold(page, `/projects/${PROJECT}/overview`);
  const nav = page.getByTestId("project-nav");
  await expect(nav).toBeVisible();
  // `schema` is what URLs, the CLI and the API call Classes; the label is the
  // product's word for it. Batches have no section: they are listed on the Overview.
  // Each tab may carry its count beside the name ("Images1"), so the name leads.
  await expect(nav.locator('[data-testid^="nav-"]')).toHaveText([
    /^Overview$/,
    /^Images\d*$/,
    /^Classes\d*$/,
    /^Dataset\d*$/,
  ]);
  await expect(page.getByTestId("nav-images")).toHaveAttribute("href", `/projects/${PROJECT}/images`);
  await expect(page.getByTestId("nav-batches")).toHaveCount(0);
});

test("the old Batches section address redirects to the Overview, which lists the batches", async ({
  page,
}) => {
  await openCold(page, `/projects/${PROJECT}/batches`);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/overview$`));
  await expect(page.getByTestId("nav-overview")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("overview-batches")).toBeVisible();
  await expect(page.getByTestId("batches-screen")).toHaveCount(0);
});

test("with a batch open, Add images is secondary and sits in the toolbar before Annotate, once, on the overview", async ({
  page,
}) => {
  await openCold(page, `/projects/${PROJECT}/overview`);
  const nav = page.getByTestId("project-nav");
  await expect(nav.getByTestId("go-annotate")).toBeVisible();
  // The toolbar is the only place Add images lives: outline, and before the
  // filled Annotate. The Batches panel does not repeat it.
  const add = nav.getByTestId("go-ingest");
  await expect(add).toBeVisible();
  await expect(page.getByTestId("go-ingest")).toHaveCount(1);
  await expect(add).not.toHaveClass(/bg-primary/);
  await expect(nav.getByTestId("go-annotate")).toHaveClass(/bg-primary/);
  const addBox = (await add.boundingBox())!;
  const annotateBox = (await nav.getByTestId("go-annotate").boundingBox())!;
  expect(addBox.x + addBox.width).toBeLessThanOrEqual(annotateBox.x + 1);
  await expect(page.getByTestId("overview-batches").getByTestId("go-ingest")).toHaveCount(0);
});

test("on the Images section Add images is the toolbar's one filled control, and Annotate is not offered", async ({
  page,
}) => {
  await openCold(page, `/projects/${PROJECT}/images`);
  const nav = page.getByTestId("project-nav");
  await expect(page.getByTestId("images-screen")).toBeVisible();
  // Annotate is the Overview's, where the batches are listed.
  await expect(nav.getByTestId("go-annotate")).toHaveCount(0);
  await expect(nav.getByTestId("go-ingest")).toHaveClass(/bg-primary/);
  await expect(page.getByTestId("go-ingest")).toHaveCount(1);
  await expect(page.getByTestId("images-screen").getByTestId("go-ingest")).toHaveCount(0);
  await expect(page.getByTestId("images-ingest")).toHaveCount(0);
  expect(await filledControls(page)).toBe(1);
});

for (const section of ["schema", "dataset"] as const) {
  test(`on ${section} Add images is the overflow's first entry, not a button, and it goes to the ingest flow`, async ({
    page,
  }) => {
    await openCold(page, `/projects/${PROJECT}/${section}`);
    const nav = page.getByTestId("project-nav");
    await expect(page.getByTestId(`nav-${section}`)).toHaveAttribute("aria-current", "page");
    await expect(nav.getByTestId("go-ingest")).toHaveCount(0);
    await expect(page.getByTestId("go-ingest")).toHaveCount(0);

    await nav.getByTestId("project-menu").click();
    const item = page.getByTestId("menu-ingest");
    await expect(item).toHaveText("Add images");
    // First of the menu, ahead of Rename and Delete project.
    await expect(page.getByRole("menuitem").first()).toHaveAttribute("data-testid", "menu-ingest");
    await expect(page.getByTestId("delete-project")).toHaveText("Delete project");

    await item.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/ingest$`));
  });
}

test("with no batch open, Add images is the toolbar's filled control, and still the only one", async ({
  page,
}) => {
  await serveApi(page);
  // Registered after `serveApi`, so it answers first: nothing is open for annotation.
  await page.route(`**/api/projects/${PROJECT}/batches`, (route) =>
    route.fulfill({ json: { items: [], total: 0 } satisfies Wire["BatchPage"] }),
  );
  await page.goto(`/projects/${PROJECT}/images`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  const nav = page.getByTestId("project-nav");
  await expect(nav.getByTestId("go-ingest")).toBeVisible();
  await expect(nav.getByTestId("go-annotate")).toHaveCount(0);
  await expect(page.getByTestId("go-ingest")).toHaveCount(1);
  await expect(nav.getByTestId("go-ingest")).toHaveClass(/bg-primary/);
});

test("Add images in the toolbar goes to the ingest flow", async ({ page }) => {
  await openCold(page, `/projects/${PROJECT}/overview`);
  await page.getByTestId("project-nav").getByTestId("go-ingest").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/ingest$`));
  await expect(page.getByRole("heading", { level: 1, name: "Add images" })).toBeVisible();
});

test("the Images section lists every image of the project, with the total stated, in a pane that fits the window", async ({ page }) => {
  await openCold(page, `/projects/${PROJECT}/images`);
  await expect(page.getByTestId("images-screen")).toBeVisible();
  // The section bar names the page; the heading is for whoever navigates by headings.
  await expect(page.getByRole("heading", { level: 1, name: "Images" })).toBeAttached();
  await expect(page.getByTestId("images-sheet").getByTestId("image-asset-1")).toBeVisible();
  await expect(page.getByTestId("images-count")).toHaveText("1 image");
  // An app pane, not a document: only the grid scrolls.
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0);
});

/** Two sources of the project, the second a clip, and the images each produced. */
const FOLDER = "66666666-6666-4666-8666-666666666666";
const CLIP = "77777777-7777-4777-8777-777777777777";

/**
 * Serves the project's sources and an asset listing that honours `source_id`,
 * recording every `source_id` it was asked for. Registered after `serveApi`, so
 * it answers first.
 */
async function serveSources(page: Page): Promise<string[]> {
  const asked: string[] = [];
  const source = (id: string, name: string, kind: "image_directory" | "video"): Wire["SourceOut"] => ({
    id,
    project_id: PROJECT,
    kind,
    name,
    registered_at: "2026-08-01T08:00:00Z",
    video: null,
  });
  const frame = (id: string, from: string): Wire["AssetOut"] => ({
    ...PROJECT_ASSET,
    id,
    source_id: from,
    frame_index: from === CLIP ? 30 : null,
    frame_timestamp: from === CLIP ? 65 : null,
  });
  const held = [frame("asset-1", FOLDER), frame("asset-2", FOLDER), frame("asset-3", CLIP)];
  await page.route(`**/api/projects/${PROJECT}/sources`, (route) =>
    route.fulfill({
      json: {
        items: [source(FOLDER, "Camera drop", "image_directory"), source(CLIP, "Walkthrough.mp4", "video")],
        total: 2,
      } satisfies Wire["SourcePage"],
    }),
  );
  await page.route(`**/api/projects/${PROJECT}/assets?**`, (route) => {
    const only = new URL(route.request().url()).searchParams.get("source_id");
    if (only !== null) asked.push(only);
    const items = only === null ? held : held.filter((one) => one.source_id === only);
    return route.fulfill({ json: { items, total: items.length } satisfies Wire["AssetPage"] });
  });
  return asked;
}

test("the Images section groups by source, and a source's name narrows the page to it", async ({ page }) => {
  await serveApi(page);
  const asked = await serveSources(page);
  await page.goto(`/projects/${PROJECT}/images`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  // Each source is asked for by its own id, and heads its own section.
  await expect(page.getByRole("button", { name: "Show only Camera drop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show only Walkthrough.mp4" })).toBeVisible();
  await expect(page.getByTestId("images-source-menu")).toHaveAttribute("aria-label", "Source: All sources");
  await expect(page.getByTestId("images-source-line")).toHaveText("3 images from 2 sources");
  await expect(page.getByTestId("images-sheet").getByRole("option")).toHaveCount(3);
  expect(asked).toEqual(expect.arrayContaining([FOLDER, CLIP]));

  await page.getByRole("button", { name: "Show only Walkthrough.mp4" }).click();
  await expect(page.getByTestId("images-source-menu")).toHaveAttribute("aria-label", "Source: Walkthrough.mp4");
  await expect(page.getByTestId("images-sheet").getByRole("option")).toHaveCount(1);
  await expect(page.getByTestId("image-asset-3")).toBeVisible();

  // And back, from the menu.
  await page.getByTestId("images-source-menu").click();
  await page.getByRole("menuitemradio", { name: /All sources/ }).click();
  await expect(page.getByTestId("images-sheet").getByRole("option")).toHaveCount(3);
});

test("the selected image sits beside the grid, the arrows walk it, and one toggle focuses it and brings it back", async ({ page }) => {
  await serveApi(page);
  await serveSources(page);
  await page.goto(`/projects/${PROJECT}/images`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  await page.getByTestId("image-asset-3").click();
  const detail = page.getByTestId("image-detail");
  await expect(detail.getByTestId("image-detail-position")).toHaveText("3 of 3");
  await expect(detail.getByTestId("image-facts")).toContainText("Walkthrough.mp4");
  await expect(detail.getByTestId("image-facts")).toContainText("1:05");
  await expect(page.getByTestId("image-asset-3")).toBeFocused();

  // Selection and focus move together, across the boundary between sources.
  await page.keyboard.press("ArrowLeft");
  await expect(detail.getByTestId("image-detail-position")).toHaveText("2 of 3");
  await expect(detail.getByTestId("image-facts")).toContainText("Camera drop");
  await expect(page.getByTestId("image-asset-2")).toBeFocused();

  // The control that expands is the control that collapses, in the same place.
  const toggle = page.getByTestId("image-focus-toggle");
  const before = await toggle.boundingBox();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-label", "Back to grid");
  expect(await toggle.boundingBox()).toEqual(before);
  await expect(page.getByTestId("image-detail-picture")).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", "Focus on image");
});

test("an Images section with nothing in it offers Add images, and it goes to the ingest flow", async ({
  page,
}) => {
  await serveApi(page);
  // Registered after `serveApi`, so it answers first: the project has no images.
  await page.route(`**/api/projects/${PROJECT}/assets**`, (route) =>
    route.fulfill({ json: { items: [], total: 0 } satisfies Wire["AssetPage"] }),
  );
  await page.goto(`/projects/${PROJECT}/images`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  await expect(page.getByText("No images yet")).toBeVisible();
  await page.getByTestId("images-ingest").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/ingest$`));
  await expect(page.getByRole("heading", { level: 1, name: "Add images" })).toBeVisible();
});

test("the filled control opens the open batch's one job", async ({ page }) => {
  await openWithJobs(page, `/projects/${PROJECT}/overview`, [JOB]);
  await page.getByTestId("go-annotate").click();
  await expect(page.getByTestId("annotation-page")).toBeVisible();
  // The job is the identity; the control names no frame, and the annotator then
  // writes the frame it opened on into the address, as it does after any walk.
  await expect(page).toHaveURL(new RegExp(`/jobs/${JOB}(\\?asset=[^&]+)?$`));
});

test("with more than one job the filled control lands on the gallery, where a job is chosen", async ({
  page,
}) => {
  await openWithJobs(page, `/projects/${PROJECT}/overview`, [JOB, OTHER_JOB]);
  await page.getByTestId("go-annotate").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/batches/${BATCH}$`));
  await expect(page.getByTestId("gallery")).toBeVisible();
  // Both jobs are offered, one panel each; only the open one carries a door,
  // which is why the count is of headers rather than of `start-job-*`.
  await expect(page.getByTestId("job-panels").getByTestId(/^job-header-/)).toHaveCount(2);
});

test("the toolbar frames the ingest flow and the batch gallery too, without a filled control of its own", async ({
  page,
}) => {
  // Everything that belongs to one project lives inside the same navigation;
  // only the annotator, which needs the whole screen, stands outside it.
  await openCold(page, `/projects/${PROJECT}/batches/${BATCH}`);
  await expect(page.getByTestId("gallery")).toBeVisible();
  const nav = page.getByTestId("project-nav");
  await expect(nav).toBeVisible();
  // A batch is opened from the Overview, where batches are listed, so the
  // Overview is lit.
  await expect(page.getByTestId("nav-overview")).toHaveAttribute("aria-current", "page");
  // The gallery heads itself, with its one way out — up to the Overview — so the
  // frame draws no eyebrow above it.
  await expect(page.getByTestId("project-identity")).toHaveCount(0);
  await expect(page.getByTestId("back-link")).toHaveText("Overview");
  // The gallery owns its dominant action; the toolbar offers none beside it.
  await expect(nav.getByTestId("go-annotate")).toHaveCount(0);
  await expect(nav.getByTestId("go-ingest")).toHaveCount(0);

  await page.goto(`/projects/${PROJECT}/ingest`);
  await expect(page.getByTestId("ingest-screen")).toBeVisible();
  await expect(page.getByTestId("project-nav")).toBeVisible();
  // An ingest is the project's, not any one section's: nothing is lit.
  await expect(page.locator('[data-testid^="nav-"][aria-current="page"]')).toHaveCount(0);
});

test("the toolbar is absent from every route that is not the project's", async ({ page }) => {
  await openCold(page, "/");
  await expect(page.getByTestId("app-rail")).toBeVisible();
  await expect(page.getByTestId("project-nav")).toHaveCount(0);

  await page.goto("/projects");
  await expect(page.getByTestId("open-road-signs")).toBeVisible();
  await expect(page.getByTestId("project-nav")).toHaveCount(0);

  await page.goto("/models");
  await expect(page.getByTestId("app-rail")).toBeVisible();
  await expect(page.getByTestId("project-nav")).toHaveCount(0);

  await page.goto(`/jobs/${JOB}`);
  await expect(page.getByTestId("annotation-page")).toBeVisible();
  await expect(page.getByTestId("project-nav")).toHaveCount(0);
});

test("below lg the tab strip renders and the toolbar does not, with nothing lost", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await openCold(page, `/projects/${PROJECT}/overview`);
  await expect(page.getByTestId("overview-batches")).toBeVisible();

  await expect(page.getByTestId("project-nav")).toHaveCount(0);
  await expect(page.getByTestId("project-tabs")).toBeVisible();
  await expect(page.getByTestId("nav-overview")).toHaveAttribute("aria-selected", "true");

  // Narrower still, the strip's own tabs can no longer all fit: it scrolls
  // within its own row instead of widening the page (#754).
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await page.setViewportSize({ width: 900, height: 800 });

  // No eyebrow above the strip (the open-project tab names the project), and
  // Add images, the filled control and the overflow beside the tabs: everything
  // the toolbar offers, in a row.
  await expect(page.getByTestId("project-identity")).toHaveCount(0);
  await expect(page.getByTestId("go-ingest")).toHaveCount(1);
  await expect(page.getByTestId("go-annotate")).toBeVisible();
  await expect(page.getByTestId("project-menu")).toBeVisible();
  expect(await filledControls(page)).toBe(1);

  // And the strip navigates: the URL moves with the tab.
  await page.getByTestId("nav-dataset").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/dataset$`));
  await expect(page.getByTestId("dataset-screen")).toBeVisible();
});

test("the toolbar's items are real links, so the section has an address before it is pressed", async ({
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

/**
 * The product's responsive floor, asserted rather than eyeballed.
 *
 * A page that scrolls sideways is a defect; a *local* scroller that does not
 * widen the page is not, and this file's own strip is deliberately one. So the
 * assertion is on the document, which is the thing a user drags.
 *
 * Every width here caught something real: the schema's action row came to 460px
 * and overflowed to about 500px, the dataset tabs could not shrink past their
 * labels and counts, and the gallery's batch actions and its state filter each
 * widened the page on their own. A regression in any of them is a sideways
 * scrollbar on a screen somebody works in all day.
 *
 * One test per route rather than one sweep: fifteen navigations in a single test
 * runs past the suite's 20s budget, and a timeout reads as "the floor is broken"
 * when it means "the test did too much".
 */
const FLOOR_WIDTHS = [320, 375, 480] as const;

for (const route of [...SECTIONS, "batches-detail"] as const) {
  const path =
    route === "batches-detail"
      ? `/projects/${PROJECT}/batches/${BATCH}`
      : `/projects/${PROJECT}/${route}`;

  test(`${route} does not scroll the document sideways at the responsive floor`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: FLOOR_WIDTHS[0], height: 800 });
    await openCold(page, path);
    await expect(page.getByTestId("project-tabs")).toBeVisible();

    for (const width of FLOOR_WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await page.evaluate(() => {
        const de = document.documentElement;
        return de.scrollWidth - de.clientWidth;
      });
      expect(overflow, `${path} at ${width}px scrolls the document sideways`).toBeLessThanOrEqual(
        0,
      );
    }
  });
}
