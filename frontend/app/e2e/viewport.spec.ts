/**
 * The annotator's minimum viewport, in a browser (#184).
 *
 * jsdom has no widths, so the unit tests stub `matchMedia` and can only assert
 * what the component does with an answer. **This suite sets real viewport sizes**
 * and is therefore the only place the boundary itself is checked — including that
 * the floor is inclusive, which is one pixel of behaviour no stub can see.
 *
 * The other half is criterion 4: **nothing else gains a floor.** Lists, forms and
 * the gallery are usable on a phone and stay that way, so a scenario drives them
 * at 390px and asserts they render as normal.
 */

import { expect, test, type Page } from "@playwright/test";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

/** A standard iPad in portrait, and Tailwind's `md`. Kept in step by hand with
 *  `ANNOTATOR_MIN_VIEWPORT_PX`, which a scenario below asserts against the DOM. */
const FLOOR = 768;

/** iPhone 12/13/14 in portrait — the case the issue was filed about. */
const PHONE = { width: 390, height: 844 };

const NO_PROGRESS = {
  unannotated: 1,
  annotated: 0,
  skipped: 0,
  review_pending: 0,
  accepted: 0,
  total: 1,
};

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  classes: [{ name: "vehicle", geometry: "bbox", color: "#38bdf8", attributes: [] }],
};

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const ASSET = {
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
  job_id: JOB,
  progress: "unannotated",
};

async function serveApi(page: Page): Promise<void> {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/session") return route.fulfill({ json: { issued: false } });
    if (path === "/projects") {
      return route.fulfill({
        json: { items: [{ id: PROJECT, name: "road-signs", description: null }], total: 1 },
      });
    }
    if (path === `/projects/${PROJECT}`) {
      return route.fulfill({ json: { id: PROJECT, name: "road-signs", description: null } });
    }
    if (path === `/jobs/${JOB}`) {
      return route.fulfill({
        json: { id: JOB, batch_id: BATCH, state: "in_progress", asset_count: 1 },
      });
    }
    if (path === `/jobs/${JOB}/progress`) return route.fulfill({ json: NO_PROGRESS });
    if (path === `/batches/${BATCH}`) {
      return route.fulfill({
        json: {
          id: BATCH,
          project_id: PROJECT,
          name: "drive-01",
          state: "in_annotation",
          schema_version: 1,
          asset_count: 1,
          progress: NO_PROGRESS,
        },
      });
    }
    if (path.endsWith("/schema/versions/1")) return route.fulfill({ json: SCHEMA });
    if (path === `/batches/${BATCH}/assets`) {
      return route.fulfill({ json: { items: [ASSET], total: 1 } });
    }
    if (path.endsWith("/annotations")) return route.fulfill({ json: { items: [], total: 0 } });
    if (path.endsWith("/content")) return route.fulfill({ contentType: "image/png", body: PIXEL });
    return route.fulfill({ json: { items: [], total: 0 } });
  });
}

async function openAt(page: Page, url: string, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await serveApi(page);
  await page.goto(url);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
}

test("a phone gets an explanation, not a broken editor", async ({ page }) => {
  await openAt(page, `/jobs/${JOB}`, PHONE);

  const state = page.getByTestId("viewport-too-narrow");
  await expect(state).toBeVisible();
  await expect(state).toContainText(`${FLOOR}px`);

  // Not hidden — absent. `AnnotatorCanvas` measures its pane to derive the fit
  // zoom, so an editor mounted inside a hidden ancestor would come back holding a
  // zoom nobody chose the moment the window widened.
  await expect(page.getByTestId("annotation-page")).toHaveCount(0);
  await expect(page.getByTestId("annotator-canvas")).toHaveCount(0);
  await expect(page.getByTestId("tool-palette")).toHaveCount(0);
});

test("the explanation offers the way back that a phone has no rail for", async ({ page }) => {
  await openAt(page, `/jobs/${JOB}`, PHONE);

  await page.getByTestId("too-narrow-gallery").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/batches/${BATCH}$`));
});

test("the floor is inclusive: exactly at it, the editor opens", async ({ page }) => {
  // The one pixel of behaviour no stub can see. `min-width: 768px` matches at
  // 768, and a floor spelled `max-width: 767px` would be the same boundary
  // written twice and would drift the first time it moved.
  await openAt(page, `/jobs/${JOB}`, { width: FLOOR, height: 900 });

  await expect(page.getByTestId("annotation-page")).toBeVisible();
  await expect(page.getByTestId("viewport-too-narrow")).toHaveCount(0);
});

test("one pixel under it, the editor does not", async ({ page }) => {
  await openAt(page, `/jobs/${JOB}`, { width: FLOOR - 1, height: 900 });

  await expect(page.getByTestId("viewport-too-narrow")).toBeVisible();
  await expect(page.getByTestId("annotation-page")).toHaveCount(0);
});

test("it follows the viewport live, so widening the window opens the editor", async ({ page }) => {
  // The whole reason this is `matchMedia` and not a user-agent read: rotating a
  // tablet, dragging a desktop window, or opening devtools all cross this
  // boundary without changing the device.
  await openAt(page, `/jobs/${JOB}`, { width: FLOOR - 1, height: 900 });
  await expect(page.getByTestId("viewport-too-narrow")).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId("annotation-page")).toBeVisible();
  await expect(page.getByTestId("viewport-too-narrow")).toHaveCount(0);

  // …and back, without a reload. A one-shot read on mount would pass the first
  // half of this scenario and fail here.
  await page.setViewportSize({ width: FLOOR - 1, height: 900 });
  await expect(page.getByTestId("viewport-too-narrow")).toBeVisible();
});

test("nothing else gains a floor", async ({ page }) => {
  // Criterion 4. Lists, forms and the gallery are usable on a phone and stay
  // that way — a floor that spread would be a regression dressed as consistency.
  await openAt(page, "/projects", PHONE);
  await expect(page.getByTestId("projects-screen")).toBeVisible();
  await expect(page.getByTestId("viewport-too-narrow")).toHaveCount(0);

  await page.goto(`/projects/${PROJECT}/batches/${BATCH}`);
  await expect(page.getByTestId("gallery")).toBeVisible();
  await expect(page.getByTestId("viewport-too-narrow")).toHaveCount(0);
});
