/**
 * Curating the trunk, in a browser.
 *
 * ## Why this is here and not only in vitest
 *
 * `ui-core`'s `dataset.test.tsx` already drives the dialog, the refusal and the
 * invalidations, and it does that better than a browser can — it can read the
 * requests. What it cannot see is whether the control is *reachable*: the
 * removal lives inside a listing that did not exist until this task, on a screen
 * reached through a project tab, and "the component renders a button" and "a
 * person can press it from the app" are different claims — a screen can be
 * unreachable from inside the app for a whole release while its component tests
 * pass.
 *
 * ## The trunk is served from state, not from a literal
 *
 * The route's membership is held in a `Set` the DELETE handler mutates, so the
 * listing after the removal is the listing the *server* would send rather than a
 * second frozen fixture that agrees with the assertion by construction. A stub
 * that cannot answer differently cannot prove a refetch happened.
 *
 * Everything is routed under `/api/`, which is where the app sends requests in
 * development — routing the bare paths would intercept the document navigation
 * too, and the failure reads as "the shell disappeared".
 */

import { expect, test, type Page } from "@playwright/test";

import type { Wire } from "./_wire";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const DATASET = "22222222-2222-4222-8222-222222222222";

/** A 1x1 PNG, so a preview cell has real bytes rather than a broken-image box. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const ASSETS = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", frame_index: 0 },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", frame_index: 1 },
  { id: "aaaaaaaa-0000-4000-8000-000000000003", frame_index: 2 },
] as const;

/** One label on every member: a box, so the overlay has something to draw. */
function annotationRow(assetId: string): Wire["AnnotationOut"] {
  return {
    id: `bbbbbbbb-0000-4000-8000-${assetId.slice(-12)}`,
    asset_id: assetId,
    label_class: "sign",
    schema_version: 1,
    geometry: { type: "bbox", x: 64, y: 48, width: 320, height: 240 },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

function assetRow(asset: { id: string; frame_index: number }): Wire["DatasetAssetOut"] {
  // Every field `DatasetAssetOut` declares, nulls included. The generated shape
  // check runs before any screen renders, so an omitted field is a runtime
  // rejection and a stub answering a shape the endpoint never sends tests nothing.
  return {
    id: asset.id,
    project_id: PROJECT,
    modality: "image",
    content_hash: `${asset.frame_index}`.padStart(64, "abcdef0123456789"),
    width: 640,
    height: 480,
    format: "png",
    source_id: null,
    frame_index: asset.frame_index,
    frame_timestamp: null,
    thumbnail_hash: null,
    ingested_at: "2026-07-31T09:00:00.000000Z",
    annotation_count: 1,
    label_classes: ["sign"],
  };
}

async function serveApi(page: Page): Promise<void> {
  // The membership, and the DELETE actually takes something out of it. Widened
  // to `string`, because the ids arriving off the wire are not the literal union
  // `ASSETS` narrows to.
  const trunk = new Set<string>(ASSETS.map((asset) => asset.id));

  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");

    if (request.method() === "DELETE") {
      const assetId = path.split("/").pop() ?? "";
      trunk.delete(assetId);
      // 204 whether or not it was a member: an id that was never in the trunk
      // leaves it in the state the caller asked for.
      return route.fulfill({ status: 204, body: "" });
    }

    if (path === "/session") return route.fulfill({ json: { issued: false } });
    if (path === "/projects") {
      return route.fulfill({
        json: {
          items: [{ id: PROJECT, name: "road-signs", description: null, thumbnail_asset_id: null, thumbnail_hash: null, created_at: null }],
          total: 1,
        } satisfies Wire["ProjectPage"],
      });
    }
    if (path === `/projects/${PROJECT}`) {
      return route.fulfill({
        json: { id: PROJECT, name: "road-signs", description: null, thumbnail_asset_id: null, thumbnail_hash: null, created_at: null } satisfies Wire["ProjectOut"],
      });
    }
    if (path === `/projects/${PROJECT}/dataset`) {
      // `description` is required on `DatasetOut` and present-as-null is what the
      // server sends. Omitting it is rejected by the generated shape check at
      // `unwrap`, and the failure is quiet in a way worth writing down: every
      // query below is `enabled: datasetId !== undefined`, so one rejected body
      // leaves the stats, the trunk *and* the releases pending forever, and the
      // screen reads as three slow requests rather than as one bad stub.
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
      // Derived from the same `Set`, so the count and the listing cannot
      // disagree — and so the count moving is evidence of a refetch.
      return route.fulfill({
        json: {
          dataset_id: DATASET,
          asset_count: trunk.size,
          annotated_asset_count: 0,
          annotation_count: 0,
          classes: [],
        } satisfies Wire["DatasetStatsOut"],
      });
    }
    if (path === `/datasets/${DATASET}/assets`) {
      const items = ASSETS.filter((asset) => trunk.has(asset.id)).map(assetRow);
      return route.fulfill({
        json: { items, total: items.length } satisfies Wire["DatasetAssetPage"],
      });
    }
    const labels = path.match(new RegExp(`^/datasets/${DATASET}/assets/([^/]+)/annotations$`));
    if (labels !== null) {
      const [, assetId] = labels;
      // The third member carries a label of every one of sixty classes, so its
      // panel is taller than any viewport and has to scroll inside the dialog.
      const items = !trunk.has(assetId)
        ? []
        : assetId === ASSETS[2].id
          ? Array.from({ length: 60 }, (_, at) => ({
              ...annotationRow(assetId),
              id: `bbbbbbbb-0000-4000-8000-${String(at).padStart(12, "0")}`,
              label_class: `class-${String(at).padStart(2, "0")}`,
            }))
          : [annotationRow(assetId)];
      return route.fulfill({ json: { items, total: items.length } satisfies Wire["AnnotationPage"] });
    }
    if (path === `/projects/${PROJECT}/schema`) {
      // A schema-less project is a real answer: the overlay colours itself.
      return route.fulfill({
        status: 404,
        json: { code: "SCHEMA_NOT_FOUND", message: "no active schema" },
      });
    }
    if (path.endsWith("/thumbnail") || path.endsWith("/content")) {
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    }
    // Everything else the screen may ask for. An empty collection is a legal
    // answer to every listing this spec reaches, and none is under test.
    return route.fulfill({ json: { items: [], total: 0 } satisfies Wire["AssetPage"] });
  });
}

/**
 * The dataset on its Assets view, which is where every scenario here lives. The
 * asset count rides on the tab's own label, so "off the count" is asserted
 * there rather than on the Overview the scenarios never open.
 */
async function openDataset(page: Page): Promise<void> {
  await serveApi(page);
  await page.goto(`/projects/${PROJECT}/dataset`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("dataset-screen")).toBeVisible();
  await page.getByTestId("dataset-tab-assets").click();
  await expect(page.getByTestId("trunk-assets")).toBeVisible();
}

test("the trunk lists what is in it, and every row offers the removal", async ({ page }) => {
  await openDataset(page);

  await expect(page.getByTestId("trunk-assets")).toBeVisible();
  for (const asset of ASSETS) {
    await expect(page.getByTestId(`trunk-asset-${asset.id}`)).toBeVisible();
    await expect(page.getByTestId(`remove-${asset.id}`)).toBeVisible();
  }
});

test("removing an asset takes it out of the listing and off the count", async ({ page }) => {
  await openDataset(page);
  const [first] = ASSETS;
  await expect(page.getByTestId("dataset-tab-assets")).toContainText("3");

  await page.getByTestId(`remove-${first.id}`).click();
  await expect(page.getByTestId("remove-asset-dialog")).toBeVisible();
  await page.getByTestId("remove-asset-submit").click();

  // The row goes, and so does the dialog...
  await expect(page.getByTestId(`trunk-asset-${first.id}`)).toHaveCount(0);
  await expect(page.getByTestId("remove-asset-dialog")).toHaveCount(0);
  // ...and the count above it follows, which is the half a listing-only
  // invalidation would miss. It is derived per call by the kernel, so a stale
  // cache would keep reporting the pre-removal trunk.
  await expect(page.getByTestId("dataset-tab-assets")).toContainText("2");
  // The others are untouched: this removes one membership row, not a page.
  await expect(page.getByTestId(`trunk-asset-${ASSETS[1].id}`)).toBeVisible();
});

test("cancelling takes no action at all", async ({ page }) => {
  await openDataset(page);
  const [first] = ASSETS;

  await page.getByTestId(`remove-${first.id}`).click();
  await expect(page.getByTestId("remove-asset-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByTestId("remove-asset-dialog")).toHaveCount(0);
  // The decision is the confirmation, not the press that opened it.
  await expect(page.getByTestId(`trunk-asset-${first.id}`)).toBeVisible();
  await expect(page.getByTestId("dataset-tab-assets")).toContainText("3");
});

test("opening a tile shows the picture with its label drawn over it, in the picture's own frame", async ({
  page,
}) => {
  await openDataset(page);
  const [first] = ASSETS;

  await page.getByTestId(`open-${first.id}`).click();
  const preview = page.getByTestId("asset-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId(`preview-shape-${annotationRow(first.id).id}`)).toBeVisible();

  // The overlay is placed by the asset's dimensions and not by measuring the
  // picture, and this is the one claim jsdom cannot check: the SVG's box has to
  // be the image's box, or a coordinate lands beside the pixel it names.
  // Both rectangles read in one evaluation, so the dialog's opening animation —
  // which scales them together — cannot put a frame between the two readings.
  await expect(preview.getByTestId("preview-image")).toBeVisible();
  const [picture, overlay] = await preview.evaluate((node) =>
    ["preview-image", "preview-overlay"].map((id) => {
      const rect = node.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );
  expect(picture).not.toBeNull();
  expect(overlay).not.toBeNull();
  for (const side of ["x", "y", "width", "height"] as const) {
    expect(Math.abs((picture?.[side] ?? 0) - (overlay?.[side] ?? 0))).toBeLessThanOrEqual(1);
  }
  // And the box keeps the asset's 4:3 whatever the dialog's width.
  expect(Math.abs((picture?.width ?? 0) / (picture?.height ?? 1) - 640 / 480)).toBeLessThan(0.02);

  await page.keyboard.press("ArrowRight");
  await expect(preview.getByTestId("preview-position")).toHaveText("2 of 3 on this page");
});

test("removing from the preview takes the tile out and closes the viewer", async ({ page }) => {
  await openDataset(page);
  const [first] = ASSETS;

  await page.getByTestId(`open-${first.id}`).click();
  await page.getByTestId("preview-remove").click();
  await expect(page.getByTestId("remove-asset-dialog")).toBeVisible();
  await page.getByTestId("remove-asset-submit").click();

  await expect(page.getByTestId("asset-preview")).toHaveCount(0);
  await expect(page.getByTestId(`trunk-asset-${first.id}`)).toHaveCount(0);
  await expect(page.getByTestId("dataset-tab-assets")).toContainText("2");
});

test("a panel with more than fits scrolls inside the dialog rather than stretching it", async ({
  page,
}) => {
  await openDataset(page);
  const tall = ASSETS[2];

  await page.getByTestId(`open-${tall.id}`).click();
  const preview = page.getByTestId("asset-preview");
  await expect(preview.getByTestId("preview-class-class-59")).toBeAttached();

  const viewport = page.viewportSize();
  const dialog = await preview.boundingBox();
  expect(dialog).not.toBeNull();
  expect(dialog?.height ?? Infinity).toBeLessThanOrEqual((viewport?.height ?? 0) * 0.92 + 1);
  // The panel is the part that scrolls, and it has something to scroll.
  const panel = preview.getByTestId("preview-panel");
  const overflow = await panel.evaluate((node) => node.scrollHeight - node.clientHeight);
  expect(overflow).toBeGreaterThan(0);
  await expect(preview.getByTestId("preview-remove")).toBeVisible();
});
