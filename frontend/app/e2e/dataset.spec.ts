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

import { expect, test, type Locator, type Page } from "@playwright/test";

import { projectDigest, type Wire } from "./_wire";

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
    point_cloud: null,
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
    class_counts: [{ label_class: "sign", annotations: 1 }],
    promoted_at: "2026-08-01T09:00:00.000000Z",
    promoted_by_batch_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    release_tags: ["v0.1"],
  };
}

const RELEASE: Wire["ReleaseOut"] = {
  id: "cccccccc-0000-4000-8000-000000000001",
  dataset_id: DATASET,
  tag: "v1",
  annotation_count: 3,
  asset_count: 3,
  created_at: "2026-07-31T09:00:00.000000Z",
  manifest_hash: "0".repeat(64),
  schema_version: 1,
  split: null,
  visionset_version: "0.0.1",
};

const LANE_TARGET: Wire["ExportTargetOut"] = {
  name: "openlane-2d",
  label: "openlane-2d",
  family: "openlane",
  format: "openlane",
  geometries: ["polyline"],
  tasks: [],
  hints: { augmentation_common: false, trainer_resizes: false },
};

const LANE_FORMAT: Wire["FormatOut"] = {
  name: "openlane",
  lossy: true,
  geometries: ["polyline"],
  degraded_geometries: [],
  modalities: ["image"],
  targets: ["openlane-2d"],
};

/**
 * The longest consent list the dialog has to hold: a target that keeps one
 * geometry, against a schema with dozens of classes it drops. Every one is a
 * line in the alert, so this is the refusal that outgrows a laptop viewport.
 */
const DROPPED = Array.from({ length: 40 }, (_, at) => ({
  label_class: `class-${String(at).padStart(2, "0")}`,
  geometry: "bbox",
  status: "excluded",
  annotations: 10 + at,
  assets: 3,
  reason: "openlane-2d accepts polylines only",
}));

const LOSSY_REFUSAL = {
  code: "LOSSY_EXPORT_NOT_CONSENTED",
  message: "openlane cannot express bbox annotations for openlane-2d.",
  detail: {
    compatibility: {
      release_id: RELEASE.id,
      format: "openlane",
      target: "openlane-2d",
      compatible: false,
      format_is_lossy: true,
      excluded_annotations: DROPPED.reduce((sum, one) => sum + one.annotations, 0),
      excluded_assets: 3,
      degraded_annotations: 0,
      degraded_assets: 0,
      dropped_modalities: [],
      untagged_assets: 0,
      classes: DROPPED,
    },
  },
};

/** The consented export, already finished: the first poll answers `succeeded`. */
const EXPORT_JOB = {
  id: "cccccccc-0000-4000-8000-000000000001",
  type: "export",
  state: "succeeded",
  attempt: 1,
  cancel_requested: false,
  created_at: "2026-01-01T00:00:00Z",
  started_at: "2026-01-01T00:00:00Z",
  finished_at: "2026-01-01T00:00:01Z",
  error: null,
  error_code: null,
  failures: [],
  processed: 1,
  total: 1,
  result: {},
} satisfies Wire["BackgroundJobOut"];

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
    if (path === `/datasets/${DATASET}/releases`) {
      return route.fulfill({ json: { items: [RELEASE], total: 1 } satisfies Wire["ReleasePage"] });
    }
    if (path === "/export-targets") {
      return route.fulfill({ json: { items: [LANE_TARGET], total: 1 } satisfies Wire["ExportTargetPage"] });
    }
    if (path === "/formats") {
      return route.fulfill({ json: { items: [LANE_FORMAT], total: 1 } satisfies Wire["FormatPage"] });
    }
    if (path === `/releases/${RELEASE.id}/export` && request.method() === "POST") {
      if (new URL(request.url()).searchParams.get("allow_lossy") !== "true") {
        return route.fulfill({ status: 409, json: LOSSY_REFUSAL });
      }
      return route.fulfill({ status: 202, json: EXPORT_JOB });
    }
    if (path === `/background-jobs/${EXPORT_JOB.id}`) {
      return route.fulfill({ json: EXPORT_JOB });
    }
    if (path === `/background-jobs/${EXPORT_JOB.id}/artifact`) {
      return route.fulfill({ contentType: "application/zip", body: Buffer.from("PK") });
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
 * The dataset on its working copy, which is what the section opens on and where
 * every scenario here lives. The image count rides on the working copy's own
 * row in the version list, so "off the count" is asserted there.
 */
async function openDataset(page: Page): Promise<void> {
  await serveApi(page);
  await page.goto(`/projects/${PROJECT}/dataset`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("dataset-screen")).toBeVisible();
  await expect(page.getByTestId("trunk-assets")).toBeVisible();
}

test("the trunk lists what is in it, and every image offers the removal once it is open", async ({ page }) => {
  await openDataset(page);

  await expect(page.getByTestId("trunk-assets")).toBeVisible();
  for (const asset of ASSETS) {
    await expect(page.getByTestId(`open-${asset.id}`)).toBeVisible();
    // The removal lives with the image being read, in the detail beside the wall.
    await page.getByTestId(`open-${asset.id}`).click();
    await expect(page.getByTestId("preview-remove")).toBeVisible();
  }
});

test("removing an asset takes it out of the listing and off the count", async ({ page }) => {
  await openDataset(page);
  const [first] = ASSETS;
  await expect(page.getByTestId("version-working")).toContainText("3");

  await page.getByTestId(`open-${first.id}`).click();
  await page.getByTestId("preview-remove").click();
  await expect(page.getByTestId("remove-asset-dialog")).toBeVisible();
  await page.getByTestId("remove-asset-submit").click();

  // The row goes, and so does the dialog...
  await expect(page.getByTestId(`open-${first.id}`)).toHaveCount(0);
  await expect(page.getByTestId("remove-asset-dialog")).toHaveCount(0);
  // ...and the count above it follows, which is the half a listing-only
  // invalidation would miss. It is derived per call by the kernel, so a stale
  // cache would keep reporting the pre-removal trunk.
  await expect(page.getByTestId("version-working")).toContainText("2");
  // The others are untouched: this removes one membership row, not a page.
  await expect(page.getByTestId(`open-${ASSETS[1].id}`)).toBeVisible();
});

test("cancelling takes no action at all", async ({ page }) => {
  await openDataset(page);
  const [first] = ASSETS;

  await page.getByTestId(`open-${first.id}`).click();
  await page.getByTestId("preview-remove").click();
  await expect(page.getByTestId("remove-asset-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByTestId("remove-asset-dialog")).toHaveCount(0);
  // The decision is the confirmation, not the press that opened it.
  await expect(page.getByTestId(`open-${first.id}`)).toBeVisible();
  await expect(page.getByTestId("version-working")).toContainText("3");
});

test("opening a tile shows the picture with its label drawn over it, in the picture's own frame", async ({
  page,
}) => {
  await openDataset(page);
  const [first] = ASSETS;

  await page.getByTestId(`open-${first.id}`).click();
  const preview = page.getByTestId("image-detail");
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId(`preview-shape-${annotationRow(first.id).id}`)).toBeVisible();

  // The overlay is placed by the asset's dimensions and not by measuring the
  // picture, and this is the one claim jsdom cannot check: the SVG's box has to
  // be the image's box, or a coordinate lands beside the pixel it names.
  // Both rectangles read in one evaluation, so nothing can put a frame between
  // the two readings.
  await expect(preview.getByTestId("image-detail-picture")).toBeVisible();
  const [picture, overlay] = await preview.evaluate((node) =>
    ["image-detail-picture", "preview-overlay"].map((id) => {
      const rect = node.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );
  expect(picture).not.toBeNull();
  expect(overlay).not.toBeNull();
  for (const side of ["x", "y", "width", "height"] as const) {
    expect(Math.abs((picture?.[side] ?? 0) - (overlay?.[side] ?? 0))).toBeLessThanOrEqual(1);
  }
  // And the box keeps the asset's 4:3 whatever the detail's width.
  expect(Math.abs((picture?.width ?? 0) / (picture?.height ?? 1) - 640 / 480)).toBeLessThan(0.02);

  // The wall's arrows walk the selection, and the detail follows it.
  await page.keyboard.press("ArrowRight");
  await expect(preview.getByTestId("image-detail-position")).toHaveText("2 of 3");
});

test("removing from the detail takes the tile out and closes the detail", async ({ page }) => {
  await openDataset(page);
  const [first] = ASSETS;

  await page.getByTestId(`open-${first.id}`).click();
  await page.getByTestId("preview-remove").click();
  await expect(page.getByTestId("remove-asset-dialog")).toBeVisible();
  await page.getByTestId("remove-asset-submit").click();

  await expect(page.getByTestId("image-detail")).toHaveCount(0);
  await expect(page.getByTestId(`open-${first.id}`)).toHaveCount(0);
  await expect(page.getByTestId("version-working")).toContainText("2");
});

test("a member with more than fits scrolls inside the detail rather than stretching it", async ({
  page,
}) => {
  await openDataset(page);
  const tall = ASSETS[2];

  await page.getByTestId(`open-${tall.id}`).click();
  const preview = page.getByTestId("image-detail");
  await expect(preview.getByTestId("preview-class-class-59")).toBeAttached();

  const viewport = page.viewportSize();
  const pane = await preview.boundingBox();
  expect(pane).not.toBeNull();
  // The detail is fitted to the window: it never grows past it to hold its content.
  expect(pane?.height ?? Infinity).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
  // What scrolls is the facts under the picture, between the detail's head and its foot.
  const scroller = preview.getByTestId("image-detail-facts");
  const overflow = await scroller.evaluate((node) => node.scrollHeight - node.clientHeight);
  expect(overflow).toBeGreaterThan(0);
  await expect(preview.getByTestId("preview-remove")).toBeVisible();
});

/** A release's export form: the last section of the version's facts, open to begin with. */
async function openReleaseExport(page: Page): Promise<Locator> {
  await page.getByTestId(`version-${RELEASE.tag}`).click();
  const form = page.getByTestId("export-form");
  await expect(form).toBeVisible();
  return form;
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
  { width: 390, height: 560 },
]) {
  test(`the lossy consent is reachable by pointer at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openDataset(page);
    const form = await openReleaseExport(page);
    await form.getByTestId("export-target").click();
    await page.getByRole("option", { name: /openlane-2d/ }).click();
    await form.getByTestId("export-submit").click();

    const consent = form.getByTestId("lossy-consent");
    await expect(consent.getByTestId("lossy-classes").getByRole("listitem")).toHaveCount(DROPPED.length);

    // The box keeps the height its content needs: nothing squeezes it until the
    // list and checkbox spill past its background.
    const overflow = await consent.evaluate((node) => node.scrollHeight - node.clientHeight);
    expect(overflow).toBeLessThanOrEqual(0);
    const consentBox = await consent.boundingBox();
    const checkboxBox = await consent.getByTestId("lossy-checkbox").boundingBox();
    expect(consentBox).not.toBeNull();
    expect(checkboxBox).not.toBeNull();
    expect((checkboxBox?.y ?? Infinity) + (checkboxBox?.height ?? 0)).toBeLessThanOrEqual(
      (consentBox?.y ?? 0) + (consentBox?.height ?? 0),
    );

    const submit = form.getByTestId("export-submit");
    await expect(submit).toBeDisabled();

    // A real pointer click: Playwright scrolls the box into view first, and a
    // click it cannot land fails rather than falling back to the keyboard.
    const checkbox = consent.getByTestId("lossy-checkbox");
    await checkbox.click();
    await expect(checkbox).toBeInViewport({ ratio: 1 });
    await expect(checkbox).toBeChecked();
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport({ ratio: 1 });
    await expect(submit).toBeEnabled();
    await submit.click({ trial: true });
  });
}

test("a consent covers the one export it was given for", async ({ page }) => {
  await openDataset(page);
  const form = await openReleaseExport(page);
  await form.getByTestId("export-target").click();
  await page.getByRole("option", { name: /openlane-2d/ }).click();

  const submit = form.getByTestId("export-submit");
  await submit.click();
  await form.getByTestId("lossy-checkbox").click();
  await expect(submit).toHaveText(/Export anyway/);
  const download = page.waitForEvent("download");
  await submit.click();
  await download;
  await expect(page.getByTestId("export-job-state")).toHaveText("Downloaded");

  await expect(submit).toHaveText(/^Export$/);
  await submit.click();
  await expect(form.getByTestId("lossy-consent")).toBeVisible();
  await expect(form.getByTestId("lossy-checkbox")).not.toBeChecked();
  await expect(submit).toBeDisabled();
});

for (const [from, to] of [
  [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ],
  [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ],
] as const) {
  test(`an export in progress survives a resize from ${from.width} to ${to.width} wide`, async ({ page }) => {
    await page.setViewportSize(from);
    await openDataset(page);
    const form = await openReleaseExport(page);
    await form.getByTestId("export-target").click();
    await page.getByRole("option", { name: /openlane-2d/ }).click();
    await form.getByTestId("export-submit").click();
    await form.getByTestId("lossy-checkbox").click();

    await page.setViewportSize(to);

    // The section is moved across the breakpoint, not remounted, so nothing
    // chosen or consented to is lost.
    const after = page.getByTestId("export-form");
    await expect(after.getByTestId("export-target")).toHaveText(/openlane-2d/);
    await expect(after.getByTestId("lossy-checkbox")).toBeChecked();
    await expect(after.getByTestId("export-submit")).toBeEnabled();
  });
}
