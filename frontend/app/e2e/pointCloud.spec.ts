/**
 * The point-cloud view (#1048), in a real browser: a scan drawn with WebGL2 in its
 * source's declared frame, its cuboid drawn over it, an orbit that moves the
 * picture and a labels toggle that takes the cuboid away.
 *
 * The browser has to offer WebGL2, so the first thing each test does is ask it.
 * Without one the test is skipped with the reason attached, and
 * VISIONSET_REQUIRE_WEBGL=1 turns that skip into a failure — for a runner that is
 * meant to have a GPU, or SwiftShader, and must not pass by drawing nothing.
 */

import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

import { assetActions, type Wire } from "./_wire";
import { BATCH, JOB, PROJECT, openedWorld, progressStore, serveApi, type Lifecycle } from "./_wireApiStub";

const REQUIRE_ENV = "VISIONSET_REQUIRE_WEBGL";
const SOURCE = "44444444-4444-4444-8444-444444444444";
const LABEL_RGB = [0x38, 0xbd, 0xf8] as const;

const CAR: Wire["AnnotationOut"] = {
  id: "car-3d",
  asset_id: "asset-1",
  label_class: "vehicle",
  schema_version: 3,
  geometry: { type: "cuboid_3d", center: [8, 0, 0], size: [4, 2, 1.6], yaw: 0.3 },
  attributes: {},
  provenance: "import",
  model_ref: null,
  confidence: null,
  job_id: null,
};

/** A 60 m x 40 m ground grid with a car-sized lump on it, intensity rising with x. */
function scanBuffer(): { readonly body: Buffer; readonly count: number } {
  const points: [number, number, number][] = [];
  for (let x = -30; x <= 30; x += 0.5) {
    for (let y = -20; y <= 20; y += 0.5) points.push([x, y, -0.8]);
  }
  for (let x = 6; x <= 10; x += 0.2) {
    for (let y = -1; y <= 1; y += 0.2) points.push([x, y, 0.8]);
  }
  const count = points.length;
  const body = Buffer.alloc(16 + count * 16);
  body.write("VSPC", 0, "latin1");
  body.writeUInt32LE(1, 4);
  body.writeUInt32LE(count, 8);
  body.writeUInt32LE(1, 12);
  points.forEach(([x, y, z], i) => {
    body.writeFloatLE(x, 16 + i * 12);
    body.writeFloatLE(y, 16 + i * 12 + 4);
    body.writeFloatLE(z, 16 + i * 12 + 8);
    body.writeFloatLE(x + 30, 16 + count * 12 + i * 4);
  });
  return { body, count };
}

const SCAN = scanBuffer();

function scanAsset(lifecycle: Lifecycle): Wire["BatchAssetOut"] {
  return {
    id: "asset-1",
    project_id: PROJECT,
    modality: "point_cloud",
    point_cloud: {
      format: "pcd",
      point_count: SCAN.count,
      fields: ["x", "y", "z", "intensity"],
      bounds: { minimum: [-30, -20, -0.8], maximum: [30, 20, 0.8] },
    },
    content_hash: "1".repeat(8) + "abcdef",
    width: null,
    height: null,
    format: null,
    source_id: SOURCE,
    frame_index: null,
    frame_timestamp: null,
    thumbnail_hash: "ab".repeat(32),
    ingested_at: null,
    job_id: JOB,
    progress: "unannotated",
    allowed_actions: assetActions("unannotated", { batchState: lifecycle.batch, jobState: lifecycle.job }),
    annotation_count: 1,
    min_confidence: null,
  };
}

async function requireWebGl2(page: Page): Promise<void> {
  await page.goto("about:blank");
  const available = await page.evaluate(() => document.createElement("canvas").getContext("webgl2") !== null);
  if (!available && process.env[REQUIRE_ENV] === "1") {
    throw new Error(`This browser offers no WebGL2, and ${REQUIRE_ENV}=1 makes that a failure rather than a skip.`);
  }
  test.skip(!available, `This browser offers no WebGL2; set ${REQUIRE_ENV}=1 to fail instead of skipping.`);
}

/** The pinned schema with `vehicle` also accepting a cuboid, for the editor to draw with. */
const CUBOID_SCHEMA = {
  project_id: PROJECT,
  version: 3,
  classes: [
    { name: "vehicle", geometries: ["bbox", "cuboid_3d"], color: "#38bdf8", attributes: [] },
    { name: "lane", geometries: ["polygon"], color: "#f97316", attributes: [] },
  ],
} satisfies Wire["SchemaVersionOut"];

interface ScanWorld {
  /** The frame the source declares; `null` declares none. */
  readonly frame?: Wire["SourceOut"]["frame"];
  readonly schema?: Wire["SchemaVersionOut"];
}

async function openScan(page: Page, world: ScanWorld = {}): Promise<Request[]> {
  await requireWebGl2(page);
  return serveScan(page, openedWorld(), world);
}

/** The scan's job, served and opened; the stub moves `lifecycle` as the page starts things. */
async function serveScan(page: Page, lifecycle: Lifecycle, world: ScanWorld = {}): Promise<Request[]> {
  const sent: Request[] = [];
  await serveApi(page, sent, progressStore({ "asset-1": "unannotated" }), lifecycle, undefined, [CAR]);
  // Registered after the shared stub, so it is asked first and hands everything else back.
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path.endsWith("/assets") && path.startsWith("/batches")) {
      return route.fulfill({ json: { items: [scanAsset(lifecycle)], total: 1 } satisfies Wire["BatchAssetPage"] });
    }
    if (world.schema !== undefined && path.endsWith("/schema/versions/3")) {
      return route.fulfill({ json: world.schema });
    }
    if (path === `/projects/${PROJECT}/assets/asset-1/points`) {
      return route.fulfill({ contentType: "application/octet-stream", body: SCAN.body });
    }
    if (path === `/sources/${SOURCE}`) {
      return route.fulfill({
        json: {
          id: SOURCE,
          project_id: PROJECT,
          kind: "point_cloud_directory",
          name: "sweeps",
          registered_at: "2026-11-01T00:00:00Z",
          frame: world.frame === undefined ? "lidar_flu" : world.frame,
          video: null,
        } satisfies Wire["SourceOut"],
      });
    }
    return route.fallback();
  });
  await page.goto(`/jobs/${JOB}`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("annotation-page")).toBeVisible();
  return sent;
}

/** A primary drag from `from` to `to`, in pixels from the view's top-left. */
async function dragIn(page: Page, view: Locator, from: readonly [number, number], to: readonly [number, number]): Promise<void> {
  const box = await view.boundingBox();
  if (box === null) throw new Error("the view has no box");
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
}

/** A cuboid on the ground left of the car: the footprint dragged, the height raised, a click to finish. */
async function drawCuboid(page: Page, view: Locator): Promise<void> {
  const box = await view.boundingBox();
  if (box === null) throw new Error("the view has no box");
  const [cx, cy] = [box.width / 2, box.height / 2];
  await dragIn(page, view, [cx - 220, cy + 60], [cx - 100, cy + 150]);
  await page.mouse.move(box.x + cx - 100, box.y + cy + 90, { steps: 6 });
  await page.mouse.down();
  await page.mouse.up();
}

/** Where a handle of the selected box sits, in the overlay's own pixels. */
async function handleAt(page: Page, face: string): Promise<readonly [number, number]> {
  const handle = page.getByTestId(`scan-handle-${face}`);
  const x = Number(await handle.getAttribute("x"));
  const y = Number(await handle.getAttribute("y"));
  return [x, y];
}

async function drawCount(view: Locator): Promise<number> {
  return Number((await view.getAttribute("data-draws")) ?? "0");
}

/** A screenshot of the view, after the draw that `act` asks for has landed. */
async function shotAfter(view: Locator, act: () => Promise<void>): Promise<Buffer> {
  const before = await drawCount(view);
  await act();
  await expect.poll(() => drawCount(view)).toBeGreaterThan(before);
  return view.screenshot();
}

/** How many pixels differ from the corner (the stage) and how many are the label's colour. */
async function census(page: Page, png: Buffer): Promise<{ readonly content: number; readonly label: number }> {
  return page.evaluate(
    async ({ base64, rgb }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("no 2d context");
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const [br, bg, bb] = [data[0], data[1], data[2]];
      let content = 0;
      let label = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) > 24) content += 1;
        if (Math.abs(r - rgb[0]) < 24 && Math.abs(g - rgb[1]) < 24 && Math.abs(b - rgb[2]) < 24) label += 1;
      }
      return { content, label };
    },
    { base64: png.toString("base64"), rgb: [...LABEL_RGB] },
  );
}

test("a scan draws its points and its cuboid, and never asks for a calibration", async ({ page }) => {
  const sent = await openScan(page);
  const view = page.getByTestId("point-cloud-canvas");
  await expect(view).toHaveAttribute("data-status", "ready");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  await expect(view).toHaveAttribute("data-label-count", "1");
  await expect(page.getByTestId("object-count")).toHaveText("1 object");
  await expect(page.getByTestId("object-total")).toHaveText("1 object");
  await expect(page.getByTestId("point-cloud-summary")).toContainText(`${SCAN.count.toLocaleString("en-US")} points`);
  await expect(page.getByTestId("point-cloud-summary")).toContainText("lidar_flu");

  const { content, label } = await census(page, await view.screenshot());
  expect(content).toBeGreaterThan(5_000);
  expect(label).toBeGreaterThan(20);

  expect(sent.some((request) => request.url().endsWith("/calibration"))).toBe(false);
  expect(sent.some((request) => request.url().endsWith("/content"))).toBe(false);
});

test("an orbit drag and the arrow keys change the picture", async ({ page }) => {
  await openScan(page);
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  const start = await view.screenshot();

  const box = await view.boundingBox();
  if (box === null) throw new Error("the view has no box");
  const orbited = await shotAfter(view, async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 6 });
    await page.mouse.up();
  });
  expect(orbited.equals(start)).toBe(false);

  const keyed = await shotAfter(view, () => page.keyboard.press("ArrowLeft"));
  expect(keyed.equals(orbited)).toBe(false);

  await shotAfter(view, () => page.getByTestId("reset-scan-view").click());
});

test("the labels toggle takes the cuboid away and brings it back", async ({ page }) => {
  await openScan(page);
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  const toggle = page.getByTestId("toggle-scan-labels");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  const hidden = await shotAfter(view, () => toggle.click());
  await expect(view).toHaveAttribute("data-labels", "off");
  expect((await census(page, hidden)).label).toBe(0);

  const shown = await shotAfter(view, () => toggle.click());
  await expect(view).toHaveAttribute("data-labels", "on");
  expect((await census(page, shown)).label).toBeGreaterThan(20);
});

test("colour by intensity is offered, colour by rgb is not on a scan without colour", async ({ page }) => {
  await openScan(page);
  const view = page.getByTestId("point-cloud-canvas");
  await expect(view).toHaveAttribute("data-color-mode", "height");
  await expect(page.getByTestId("color-by-rgb")).toBeDisabled();
  await page.getByTestId("color-by-intensity").click();
  await expect(view).toHaveAttribute("data-color-mode", "intensity");
});

test("looking at a scan in an approved batch starts nothing, and Start annotating does", async ({ page }) => {
  // No WebGL2 needed: the batch's state is the page's, not the view's.
  const sent = await serveScan(page, { batch: "approved", job: "pending" });
  const starts = (): string[] =>
    sent
      .filter((request) => request.method() === "POST" && request.url().endsWith("/start"))
      .map((request) => new URL(request.url()).pathname.replace(/^\/api/, ""));

  const banner = page.getByTestId("readonly-banner");
  await expect(banner).toContainText("Viewing only.");
  await expect(banner).not.toContainText(/image|frame/i);
  expect(starts()).toEqual([]);

  await expect(page.getByTestId("scan-edit-toggle")).toBeDisabled();
  await expect(page.getByTestId("scan-edit-strip").locator("[data-reason]")).toHaveAttribute(
    "data-reason",
    /viewing only/,
  );

  await page.getByTestId("banner-start-batch").click();
  await expect.poll(starts).toEqual([`/batches/${BATCH}/start`, `/jobs/${JOB}/start`]);
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("skip")).toBeEnabled();
});

test("in Edit, a drawn cuboid moves, the move undoes, and the save sends the box as drawn", async ({ page }) => {
  const sent = await openScan(page, { schema: CUBOID_SCHEMA });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  const box = await view.boundingBox();
  if (box === null) throw new Error("the view has no box");
  const [cx, cy] = [box.width / 2, box.height / 2];

  await page.getByTestId("scan-edit-toggle").click();
  await expect(view).toHaveAttribute("data-editing", "on");
  await page.getByTestId("scan-tool-cuboid").click();
  await expect(page.getByTestId("scan-cuboid-class")).toContainText("vehicle");

  await drawCuboid(page, view);
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");
  await expect(view).toHaveAttribute("data-label-count", "2");
  await expect(page.getByTestId("scan-handles")).toBeVisible();
  const drawn = await handleAt(page, "top");

  // A press on the body away from every handle moves the box along the ground.
  await page.getByTestId("scan-tool-select").click();
  const [bx, by] = [cx - 160 + 18, cy + 105 + 14];
  await dragIn(page, view, [bx, by], [bx + 90, by - 10]);
  const moved = await handleAt(page, "top");
  expect(Math.hypot(moved[0] - drawn[0], moved[1] - drawn[1])).toBeGreaterThan(30);

  await page.getByTestId("scan-undo").click();
  await expect.poll(() => handleAt(page, "top")).toEqual(drawn);

  await page.getByTestId("save-and-stay").click();
  await expect(page.getByTestId("save-state")).toContainText(/saved/i);
  const posts = sent.filter((request) => request.method() === "POST" && request.url().endsWith(`/jobs/${JOB}/annotations`));
  expect(posts).toHaveLength(1);
  const body = posts[0]?.postDataJSON() as Wire["AnnotationCreate"][];
  expect(body).toHaveLength(1);
  const [created] = body;
  expect(created).toMatchObject({ asset_id: "asset-1", label_class: "vehicle", geometry: { type: "cuboid_3d", yaw: 0 } });
  const geometry = created?.geometry as Wire["Cuboid3DBody"];
  for (const side of geometry.size) expect(side).toBeGreaterThan(0.05);
  // It stands on the ground the scan was sampled on, left of the car and short of it.
  expect(geometry.center[2] - geometry.size[2] / 2).toBeCloseTo(-0.8, 1);
  expect(geometry.center[1]).toBeGreaterThan(0);
  expect(sent.some((request) => request.method() === "PATCH")).toBe(false);

  await page.reload();
  const token = page.getByTestId("token-input");
  if (await token.isVisible().catch(() => false)) {
    await token.fill("a-token");
    await page.getByTestId("token-submit").click();
  }
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");
  await expect(page.getByTestId("point-cloud-canvas")).toHaveAttribute("data-label-count", "2");
});

test("in Edit, a right drag orbits and a left drag on open ground draws nothing with the select tool", async ({ page }) => {
  await openScan(page, { schema: CUBOID_SCHEMA });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  await page.getByTestId("scan-edit-toggle").click();
  const box = await view.boundingBox();
  if (box === null) throw new Error("the view has no box");
  const start = await view.screenshot();

  const orbited = await shotAfter(view, async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 6 });
    await page.mouse.up({ button: "right" });
  });
  expect(orbited.equals(start)).toBe(false);

  await dragIn(page, view, [box.width / 2 - 200, box.height - 80], [box.width / 2 - 100, box.height - 40]);
  await expect(page.getByTestId("object-count")).toHaveText("1 object");
  await expect(page.getByTestId("save-and-stay")).toBeDisabled();
});

test("a scan whose source declares no frame cannot be edited, and says why", async ({ page }) => {
  await openScan(page, { schema: CUBOID_SCHEMA, frame: null });
  await expect(page.getByTestId("point-cloud-summary")).toContainText("no declared frame");
  const toggle = page.getByTestId("scan-edit-toggle");
  await expect(toggle).toBeDisabled();
  const reason = page.getByTestId("scan-edit-strip").locator("[data-reason]");
  await expect(reason).toHaveAttribute("data-reason", /declares no frame/);
  await reason.hover();
  await expect(page.getByRole("tooltip")).toContainText("declares no frame");
  await expect(page.getByTestId("point-cloud-canvas")).toHaveAttribute("data-editing", "off");
});

test("in Edit, the keys delete, undo, and let go of the selection", async ({ page }) => {
  await openScan(page, { schema: CUBOID_SCHEMA });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  await page.getByTestId("scan-edit-toggle").click();
  await page.getByTestId("scan-tool-cuboid").click();
  await drawCuboid(page, view);
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");
  await expect(page.getByTestId("scan-handles")).toBeVisible();

  await page.keyboard.press("Delete");
  await expect(page.getByTestId("object-count")).toHaveText("1 object");
  await expect(page.getByTestId("save-and-stay")).toBeDisabled();

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");
  await page.getByTestId("object-select-1").click();
  await expect(page.getByTestId("scan-handles")).toBeVisible();
  await page.getByTestId("point-cloud-gl").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("scan-handles")).toHaveCount(0);
  await expect(page.getByTestId("save-and-stay")).toBeEnabled();
});

test("a selected cuboid is drawn in the highlight colour instead of its class colour", async ({ page }) => {
  await openScan(page, { schema: CUBOID_SCHEMA });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  expect((await census(page, await view.screenshot())).label).toBeGreaterThan(20);

  const selected = await shotAfter(view, () => page.getByTestId("object-select-0").click());
  expect((await census(page, selected)).label).toBe(0);
});
