/**
 * The point-cloud view (#1048), in a real browser: a scan drawn with WebGL2 in its
 * source's declared frame, its cuboid drawn over it, an orbit that moves the
 * picture and a labels toggle that takes the cuboid away.
 *
 * The browser has to offer WebGL2, so the first thing each test does is ask it.
 * Without one the test is skipped with the reason attached, and
 * VISIONSET_REQUIRE_WEBGL=1 turns that skip into a failure — for a runner that is
 * meant to have a GPU, or SwiftShader, and must not pass by drawing nothing. CI's
 * `annotator e2e (chromium)` job sets it.
 */

import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

import { assetActions, type Wire } from "./_wire";
import { BATCH, JOB, PROJECT, openedWorld, progressStore, serveApi, type Lifecycle, type TrackWorld } from "./_wireApiStub";

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

interface ScanBuffer {
  readonly body: Buffer;
  readonly count: number;
}

/** A 60 m x 40 m ground grid with a car-sized lump on it, intensity rising with x. */
function scanBuffer(): ScanBuffer {
  const points: [number, number, number][] = [];
  for (let x = -30; x <= 30; x += 0.5) {
    for (let y = -20; y <= 20; y += 0.5) points.push([x, y, -0.8]);
  }
  for (let x = 6; x <= 10; x += 0.2) {
    for (let y = -1; y <= 1; y += 0.2) points.push([x, y, 0.8]);
  }
  return bufferOf(points);
}

/** The ground rising at 1 in 10 from x = 0 onwards. */
function rampHeight(x: number): number {
  return x > 0 ? -0.8 + 0.1 * x : -0.8;
}

/** The same 60 m x 40 m grid, flat for x <= 0 and a ramp beyond. */
function rampBuffer(): ScanBuffer {
  const points: [number, number, number][] = [];
  for (let x = -30; x <= 30; x += 0.5) {
    for (let y = -20; y <= 20; y += 0.5) points.push([x, y, rampHeight(x)]);
  }
  return bufferOf(points);
}

function bufferOf(points: readonly (readonly [number, number, number])[]): ScanBuffer {
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

function scanAsset(lifecycle: Lifecycle, id = "asset-1"): Wire["BatchAssetOut"] {
  return {
    id,
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
    withheld_actions: [],
    observed: [],
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

/** The same schema with `lane` accepting a 3D polyline. */
const POLYLINE_SCHEMA = {
  ...CUBOID_SCHEMA,
  classes: [
    CUBOID_SCHEMA.classes[0],
    { name: "lane", geometries: ["polygon", "polyline_3d"], color: "#f97316", attributes: [] },
  ],
} satisfies Wire["SchemaVersionOut"];

interface ScanWorld {
  /** The frame the source declares; `null` declares none. */
  readonly frame?: Wire["SourceOut"]["frame"];
  readonly schema?: Wire["SchemaVersionOut"];
  /** The points served; absent, the ground grid with a car on it. */
  readonly scan?: ScanBuffer;
  /** While `failing` holds, the source request is refused. */
  readonly source?: { failing: boolean };
  /** The source as a `point_cloud_sequence` of two scans, asset-1 and asset-2, with these tracks. */
  readonly tracks?: TrackWorld;
  /** The labels stored before the page opens; absent, the one car on asset-1. */
  readonly seeded?: readonly Wire["AnnotationOut"][];
}

async function openScan(page: Page, world: ScanWorld = {}): Promise<Request[]> {
  await requireWebGl2(page);
  return serveScan(page, openedWorld(), world);
}

/** The scan's job, served and opened; the stub moves `lifecycle` as the page starts things. */
async function serveScan(page: Page, lifecycle: Lifecycle, world: ScanWorld = {}): Promise<Request[]> {
  const sent: Request[] = [];
  const scans = world.tracks === undefined ? ["asset-1"] : ["asset-1", "asset-2"];
  const progress = progressStore(Object.fromEntries(scans.map((id) => [id, "unannotated" as const])));
  await serveApi(page, sent, progress, lifecycle, undefined, world.seeded ?? [CAR], undefined, undefined, world.tracks);
  // Registered after the shared stub, so it is asked first and hands everything else back.
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path.endsWith("/assets") && path.startsWith("/batches")) {
      const items = scans.map((id) => scanAsset(lifecycle, id));
      return route.fulfill({ json: { items, total: items.length } satisfies Wire["BatchAssetPage"] });
    }
    if (world.schema !== undefined && path.endsWith("/schema/versions/3")) {
      return route.fulfill({ json: world.schema });
    }
    if (scans.some((id) => path === `/projects/${PROJECT}/assets/${id}/points`)) {
      return route.fulfill({ contentType: "application/octet-stream", body: (world.scan ?? SCAN).body });
    }
    if (path === `/sources/${SOURCE}`) {
      if (world.source?.failing === true) {
        return route.fulfill({ status: 503, json: { code: "WORKSPACE_BUSY", message: "busy" } });
      }
      return route.fulfill({
        json: {
          id: SOURCE,
          project_id: PROJECT,
          kind: world.tracks === undefined ? "point_cloud_directory" : "point_cloud_sequence",
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

/**
 * A cuboid on the ground left of the car: its length dragged up the screen, roughly forward, the
 * width set to the right of that edge with a click, the height raised, a click to finish.
 */
async function drawCuboid(page: Page, view: Locator): Promise<void> {
  const box = await view.boundingBox();
  if (box === null) throw new Error("the view has no box");
  const [cx, cy] = [box.width / 2, box.height / 2];
  await dragIn(page, view, [cx - 220, cy + 150], [cx - 220, cy + 60]);
  await page.mouse.move(box.x + cx - 100, box.y + cy + 105, { steps: 6 });
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.move(box.x + cx - 160, box.y + cy + 40, { steps: 6 });
  await page.mouse.down();
  await page.mouse.up();
}

/** Where a handle of the selected box sits, in the overlay's own pixels. */
async function handleAt(page: Page, face: string, prefix = "scan"): Promise<readonly [number, number]> {
  const handle = page.getByTestId(`${prefix}-handle-${face}`);
  const x = Number(await handle.getAttribute("x"));
  const y = Number(await handle.getAttribute("y"));
  return [x, y];
}

/** A point on the selected box's body, halfway between its top and back handles, which the opening view always sees. */
async function bodyPoint(page: Page): Promise<readonly [number, number]> {
  const top = await handleAt(page, "top");
  const back = await handleAt(page, "back");
  return [(top[0] + back[0]) / 2 + 5, (top[1] + back[1]) / 2 + 5];
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


/**
 * The cuboid as the server was last told it: autosave may store a box mid-edit and
 * send the rest as an update under the server's id, so the newest write that
 * carries a cuboid is the box as it was left.
 */
function lastCuboidSent(sent: readonly Request[]): Wire["Cuboid3DBody"] {
  const writes = sent.filter(
    (request) =>
      (request.method() === "POST" || request.method() === "PATCH") &&
      request.url().endsWith(`/jobs/${JOB}/annotations`),
  );
  for (const request of [...writes].reverse()) {
    const rows = request.postDataJSON() as { readonly geometry?: { readonly type?: string } }[];
    const cuboid = rows.find((row) => row.geometry?.type === "cuboid_3d");
    if (cuboid !== undefined) return cuboid.geometry as Wire["Cuboid3DBody"];
  }
  throw new Error("no cuboid was sent");
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
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).locator('[aria-current="page"]')).toHaveText("Job · 1 scan");

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
  const [bx, by] = await bodyPoint(page);
  await dragIn(page, view, [bx, by], [bx + 90, by - 10]);
  const moved = await handleAt(page, "top");
  expect(Math.hypot(moved[0] - drawn[0], moved[1] - drawn[1])).toBeGreaterThan(30);

  await page.getByTestId("tool-undo").click();
  await expect.poll(() => handleAt(page, "top")).toEqual(drawn);

  // Autosave may already have stored part of the work; mod+s sends the rest now.
  await page.getByTestId("point-cloud-gl").focus();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  const posts = sent.filter((request) => request.method() === "POST" && request.url().endsWith(`/jobs/${JOB}/annotations`));
  expect(posts).toHaveLength(1);
  const body = posts[0]?.postDataJSON() as Wire["AnnotationCreate"][];
  expect(body).toHaveLength(1);
  const [created] = body;
  expect(created).toMatchObject({ asset_id: "asset-1", label_class: "vehicle", geometry: { type: "cuboid_3d" } });
  const geometry = lastCuboidSent(sent);
  // It starts along its length drag, which ran up the screen, close to forward.
  expect(Math.abs(geometry.yaw)).toBeLessThan(0.5);
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

test("in Edit, pulling the back face out lengthens the box, the far faces offer no handle, and the toolbar leaves the keys on the view", async ({ page }) => {
  await openScan(page, { schema: CUBOID_SCHEMA });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  await page.getByTestId("scan-edit-toggle").click();
  await page.getByTestId("scan-tool-cuboid").click();
  await drawCuboid(page, view);
  await expect(page.getByTestId("scan-handles")).toBeVisible();
  await page.getByTestId("scan-tool-select").click();
  // Seen from behind and above, the box's front and bottom faces are turned away and offer no handle.
  await expect(page.getByTestId("scan-handle-back")).toBeVisible();
  await expect(page.getByTestId("scan-handle-top")).toBeVisible();
  for (const face of ["front", "bottom"]) await expect(page.getByTestId(`scan-handle-${face}`)).toHaveCount(0);

  // Down the screen is the back face's outward side from the opening view.
  const back = await handleAt(page, "back");
  const topBefore = await handleAt(page, "top");
  await dragIn(page, view, [back[0] + 5, back[1] + 5], [back[0] + 5, back[1] + 65]);

  const pulled = await handleAt(page, "back");
  expect(pulled[1] - back[1]).toBeGreaterThan(30);
  // The front face held still, so the top face's centre moved less far.
  const topAfter = await handleAt(page, "top");
  expect(topAfter[1] - topBefore[1]).toBeGreaterThan(5);
  expect(topAfter[1] - topBefore[1]).toBeLessThan(pulled[1] - back[1]);

  await page.getByTestId("tool-undo").click();
  await expect.poll(() => handleAt(page, "back")).toEqual(back);
  await expect(page.getByTestId("point-cloud-gl")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => handleAt(page, "back")).toEqual(pulled);
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
  // Nothing was drawn, so there is nothing to save and no save to report.
  await expect(page.getByTestId("save-state")).toHaveCount(0);
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

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");
  // A row click leaves focus on the view, so its keys act on the row's label.
  await page.getByTestId("object-select-1").click();
  await expect(page.getByTestId("scan-handles")).toBeVisible();
  await expect(page.getByTestId("point-cloud-gl")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("scan-handles")).toHaveCount(0);
  // The undone delete is work again, and the bar says so.
  await expect(page.getByTestId("save-state")).toBeVisible();

  await page.getByTestId("object-select-1").click();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("object-count")).toHaveText("1 object");
});

test("in Edit, a footprint drawn after picking the class sets its width and finishes its height with Enter", async ({ page }) => {
  const sent = await openScan(page, { schema: CUBOID_SCHEMA });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  await page.getByTestId("scan-edit-toggle").click();
  await page.getByTestId("scan-tool-cuboid").click();
  await page.getByTestId("scan-cuboid-class").focus();

  const box = await view.boundingBox();
  if (box === null) throw new Error("the view has no box");
  const [cx, cy] = [box.width / 2, box.height / 2];
  await dragIn(page, view, [cx - 220, cy + 150], [cx - 220, cy + 60]);
  await expect(page.getByTestId("scan-width-hint")).toBeVisible();
  await page.mouse.move(box.x + cx - 100, box.y + cy + 105, { steps: 6 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("scan-width-hint")).toHaveCount(0);
  await expect(page.getByTestId("scan-height-hint")).toBeVisible();
  await page.mouse.move(box.x + cx - 160, box.y + cy + 40, { steps: 6 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");
  await expect(page.getByTestId("scan-height-hint")).toHaveCount(0);

  await expect(page.getByTestId("point-cloud-gl")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  const geometry = lastCuboidSent(sent);
  expect(geometry.type).toBe("cuboid_3d");
  expect(geometry.size[2]).toBeGreaterThan(0.05);
});

test("a selected cuboid is drawn in the highlight colour instead of its class colour", async ({ page }) => {
  await openScan(page, { schema: CUBOID_SCHEMA });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  expect((await census(page, await view.screenshot())).label).toBeGreaterThan(20);

  const selected = await shotAfter(view, () => page.getByTestId("object-select-0").click());
  expect((await census(page, selected)).label).toBe(0);
});

/** The centre of a handle of the selected box, in its overlay's pixels. */
async function handleCentre(page: Page, face: string, prefix: string): Promise<readonly [number, number]> {
  const [x, y] = await handleAt(page, face, prefix);
  return [x + 5, y + 5];
}

async function yawHandle(page: Page): Promise<readonly [number, number]> {
  const knob = page.getByTestId("scan-top-yaw-handle");
  return [Number(await knob.getAttribute("cx")), Number(await knob.getAttribute("cy"))];
}

test("in Edit, the top-down view pulls a face and turns the yaw, the perspective view follows, and the save sends both", async ({ page }) => {
  const sent = await openScan(page, { schema: CUBOID_SCHEMA });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  await expect(page.getByTestId("scan-top-down")).toHaveCount(0);

  await page.getByTestId("scan-edit-toggle").click();
  const top = page.getByTestId("scan-top-down-canvas");
  await expect(top).toHaveAttribute("data-editing", "on");
  await expect(top).toHaveAttribute("data-scan-view", "top-down");
  await expect.poll(() => drawCount(top)).toBeGreaterThan(0);
  await expect(top).toHaveAttribute("data-label-count", "1");
  const box = await top.boundingBox();
  if (box === null) throw new Error("the top-down view has no box");
  const [cx, cy] = [box.width / 2, box.height / 2];

  // A footprint on open ground left of the scan's centre, wider than it is long: its length
  // dragged forward up the screen, its width set to the right, then Enter for the width and the height.
  await page.getByTestId("scan-tool-cuboid").click();
  await dragIn(page, top, [cx - 140, cy + 60], [cx - 140, cy + 20]);
  await page.mouse.move(box.x + cx - 60, box.y + cy + 40, { steps: 4 });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");
  await expect(view).toHaveAttribute("data-label-count", "2");
  await expect(top).toHaveAttribute("data-label-count", "2");
  await expect(page.getByTestId("scan-top-handles")).toBeVisible();
  await expect(page.getByTestId("scan-top-handle-top")).toHaveCount(0);
  await expect(page.getByTestId("scan-handles")).toBeVisible();
  await page.getByTestId("scan-tool-select").click();

  // The front face pulled further forward, which the top-down view draws up the screen.
  const front = await handleCentre(page, "front", "scan-top");
  const back = await handleCentre(page, "back", "scan-top");
  expect(front[1]).toBeLessThan(back[1]);
  // The perspective view sees the box from behind: its top handle shows the pull.
  const perspectiveTop = await handleAt(page, "top", "scan");
  await page.mouse.move(box.x + front[0], box.y + front[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + front[0], box.y + front[1] - 80, { steps: 8 });
  // Mid-drag, before anything is committed, the perspective view's handle has moved with it.
  await expect.poll(async () => {
    const [x, y] = await handleAt(page, "top", "scan");
    return Math.hypot(x - perspectiveTop[0], y - perspectiveTop[1]);
  }).toBeGreaterThan(5);
  await page.mouse.up();
  const pulled = await handleCentre(page, "front", "scan-top");
  expect(front[1] - pulled[1]).toBeGreaterThan(60);
  expect(await handleCentre(page, "back", "scan-top")).toEqual(back);

  // The yaw handle swept a quarter turn counter-clockwise about the footprint's centre.
  const knob = await yawHandle(page);
  const left = await handleCentre(page, "left", "scan-top");
  const right = await handleCentre(page, "right", "scan-top");
  const centre = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2] as const;
  const [dx, dy] = [knob[0] - centre[0], knob[1] - centre[1]];
  await page.mouse.move(box.x + knob[0], box.y + knob[1]);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    const angle = (step / 10) * (Math.PI / 2);
    // Counter-clockwise on a screen whose y runs down.
    const [rx, ry] = [dx * Math.cos(angle) + dy * Math.sin(angle), -dx * Math.sin(angle) + dy * Math.cos(angle)];
    await page.mouse.move(box.x + centre[0] + rx, box.y + centre[1] + ry);
  }
  await page.mouse.up();
  const turned = await yawHandle(page);
  expect(turned[0]).toBeLessThan(centre[0] - 10);

  await page.getByTestId("tool-undo").click();
  await expect.poll(() => yawHandle(page)).toEqual(knob);
  await page.getByTestId("tool-redo").click();
  await expect.poll(() => yawHandle(page)).toEqual(turned);

  // Autosave may already have stored part of the work; mod+s sends the rest now.
  await page.getByTestId("point-cloud-gl").focus();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  const posts = sent.filter((request) => request.method() === "POST" && request.url().endsWith(`/jobs/${JOB}/annotations`));
  expect(posts).toHaveLength(1);
  const geometry = lastCuboidSent(sent);
  expect(geometry.type).toBe("cuboid_3d");
  expect(geometry.yaw).toBeCloseTo(Math.PI / 2, 1);
  // Forward was pulled out: the box is longer along its heading than across it, as drawn it was not.
  expect(geometry.size[0]).toBeGreaterThan(geometry.size[1]);
  expect(geometry.center[1]).toBeGreaterThan(0);

  await page.reload();
  const token = page.getByTestId("token-input");
  if (await token.isVisible().catch(() => false)) {
    await token.fill("a-token");
    await page.getByTestId("token-submit").click();
  }
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");
});

test("in Edit, a cuboid drawn by a drag at an angle starts at the drag's yaw", async ({ page }) => {
  const sent = await openScan(page, { schema: CUBOID_SCHEMA });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  await page.getByTestId("scan-edit-toggle").click();
  const top = page.getByTestId("scan-top-down-canvas");
  await expect.poll(() => drawCount(top)).toBeGreaterThan(0);
  const box = await top.boundingBox();
  if (box === null) throw new Error("the top-down view has no box");
  const [cx, cy] = [box.width / 2, box.height / 2];

  // Forward runs up the top-down screen and left to the left: 30 degrees from forward towards left.
  const angle = Math.PI / 6;
  const from = [cx - 100, cy + 60] as const;
  const to = [from[0] - 70 * Math.sin(angle), from[1] - 70 * Math.cos(angle)] as const;
  await page.getByTestId("scan-tool-cuboid").click();
  await dragIn(page, top, from, to);
  await page.mouse.move(box.x + to[0] + 40 * Math.cos(angle), box.y + to[1] - 40 * Math.sin(angle), { steps: 4 });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");

  await page.getByTestId("point-cloud-gl").focus();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  const geometry = lastCuboidSent(sent);
  expect(geometry.yaw).toBeCloseTo(angle, 1);
  expect(geometry.size[0]).toBeGreaterThan(geometry.size[1]);
});

async function vertexAt(page: Page, index: number, prefix = "scan-top"): Promise<readonly [number, number]> {
  const vertex = page.getByTestId(`${prefix}-vertex-${index}`);
  return [Number(await vertex.getAttribute("cx")), Number(await vertex.getAttribute("cy"))];
}

async function signInAgain(page: Page): Promise<void> {
  const token = page.getByTestId("token-input");
  if (await token.isVisible().catch(() => false)) {
    await token.fill("a-token");
    await page.getByTestId("token-submit").click();
  }
}

test("in Edit, a polyline drawn on the ground saves, and a dragged vertex saves only that label", async ({ page }) => {
  const sent = await openScan(page, { schema: POLYLINE_SCHEMA });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);

  await page.getByTestId("scan-edit-toggle").click();
  const top = page.getByTestId("scan-top-down-canvas");
  await expect.poll(() => drawCount(top)).toBeGreaterThan(0);
  await page.getByTestId("scan-tool-polyline").click();
  await expect(page.getByTestId("scan-polyline-class")).toContainText("lane");
  await expect(page.getByTestId("scan-polyline-hint")).toBeVisible();
  // The hint keeps to one line of its own instead of squeezing the tools beside it.
  expect((await page.getByTestId("scan-polyline-hint").boundingBox())?.height).toBeLessThan(24);

  const box = await top.boundingBox();
  if (box === null) throw new Error("the top-down view has no box");
  const [cx, cy] = [box.width / 2, box.height / 2];
  // Behind the car, on open ground, three clicks and Enter.
  for (const [x, y] of [[cx - 160, cy + 60], [cx - 100, cy + 80], [cx - 40, cy + 60]] as const) {
    await page.mouse.click(box.x + x, box.y + y);
  }
  await expect(page.getByTestId("scan-top-draft-vertex-2")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");
  await expect(top).toHaveAttribute("data-label-count", "2");
  await expect(page.getByTestId("scan-top-vertex-2")).toBeVisible();

  await page.getByTestId("point-cloud-gl").focus();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  const posts = sent.filter((request) => request.method() === "POST" && request.url().endsWith(`/jobs/${JOB}/annotations`));
  expect(posts).toHaveLength(1);
  const [created] = posts[0]?.postDataJSON() as Wire["AnnotationCreate"][];
  expect(created).toMatchObject({ asset_id: "asset-1", label_class: "lane", geometry: { type: "polyline_3d" } });
  const drawn = created?.geometry as Wire["Polyline3DBody"];
  expect(drawn.points).toHaveLength(3);
  // Every vertex sits on the ground the scan was sampled on; visibility is left out, so it stays unknown.
  for (const point of drawn.points) expect(point[2]).toBeCloseTo(-0.8, 1);
  expect(drawn.visibility).toBeUndefined();

  await page.reload();
  await signInAgain(page);
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");

  await page.getByTestId("scan-edit-toggle").click();
  await expect.poll(() => drawCount(top)).toBeGreaterThan(0);
  await page.getByTestId("object-select-1").click();
  await expect(page.getByTestId("scan-top-vertex-2")).toBeVisible();
  const first = await vertexAt(page, 0);
  const before = await vertexAt(page, 2);
  await dragIn(page, top, before, [before[0] + 60, before[1] - 40]);
  const moved = await vertexAt(page, 2);
  expect(Math.hypot(moved[0] - before[0], moved[1] - before[1])).toBeGreaterThan(40);
  expect(await vertexAt(page, 0)).toEqual(first);

  const writesBefore = sent.length;
  await page.getByTestId("point-cloud-gl").focus();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  const writes = sent.slice(writesBefore).filter((request) => request.url().includes("/annotations"));
  expect(writes.filter((request) => request.method() === "POST" || request.method() === "DELETE")).toHaveLength(0);
  const patches = sent.filter((request) => request.method() === "PATCH");
  expect(patches).toHaveLength(1);
  const updated = patches[0]?.postDataJSON() as Wire["AnnotationUpdate"][];
  // Only the polyline: the cuboid beside it is not re-sent.
  expect(updated).toHaveLength(1);
  const geometry = updated[0]?.geometry as Wire["Polyline3DBody"];
  expect(geometry.points).toHaveLength(3);
  expect(geometry.points.slice(0, 2)).toEqual(drawn.points.slice(0, 2));
  expect(geometry.points[2]).not.toEqual(drawn.points[2]);
  expect(geometry.points[2]?.[2]).toBeCloseTo(-0.8, 1);

  await page.reload();
  await signInAgain(page);
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");
  await page.getByTestId("scan-edit-toggle").click();
  await page.getByTestId("object-select-1").click();
  await expect.poll(() => vertexAt(page, 2)).toEqual(moved);
});

test("in Edit, the wheel zooms the top-down view about the point under the pointer", async ({ page }) => {
  await openScan(page, { schema: CUBOID_SCHEMA });
  await page.getByTestId("scan-edit-toggle").click();
  const top = page.getByTestId("scan-top-down-canvas");
  await expect.poll(() => drawCount(top)).toBeGreaterThan(0);
  await page.getByTestId("object-select-0").click();
  await expect(page.getByTestId("scan-top-handle-front")).toBeVisible();
  const box = await top.boundingBox();
  if (box === null) throw new Error("the top-down view has no box");

  // The car sits off the view's centre, so a zoom about the centre would carry it away.
  const front = await handleCentre(page, "front", "scan-top");
  expect(Math.hypot(front[0] - box.width / 2, front[1] - box.height / 2)).toBeGreaterThan(30);
  const cursor = [Math.round(front[0]), Math.round(front[1])] as const;
  const span = async (): Promise<number> => {
    const [a, b] = [await handleCentre(page, "front", "scan-top"), await handleCentre(page, "back", "scan-top")];
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  };
  const before = await span();
  // About the cursor, the handle's offset from it scales with the zoom and nothing else.
  const offCourse = async (): Promise<number> => {
    const scale = (await span()) / before;
    const [x, y] = await handleCentre(page, "front", "scan-top");
    return Math.hypot(x - (cursor[0] + (front[0] - cursor[0]) * scale), y - (cursor[1] + (front[1] - cursor[1]) * scale));
  };
  await page.mouse.move(box.x + cursor[0], box.y + cursor[1]);

  for (let step = 0; step < 4; step += 1) await page.mouse.wheel(0, -200);
  await expect.poll(span).toBeGreaterThan(before * 2);
  expect(await offCourse()).toBeLessThan(1.5);

  for (let step = 0; step < 8; step += 1) await page.mouse.wheel(0, 200);
  await expect.poll(span).toBeLessThan(before);
  expect(await offCourse()).toBeLessThan(1.5);
});

test("at the 768 px floor, the status tag and object count cover none of the scan's own chrome", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openScan(page, { schema: CUBOID_SCHEMA });
  await page.getByTestId("scan-edit-toggle").click();
  await expect.poll(() => drawCount(page.getByTestId("scan-top-down-canvas"))).toBeGreaterThan(0);
  // The cuboid tool widens the strip with its class pick, so it wraps onto a row of its own.
  await page.getByTestId("scan-tool-cuboid").click();

  const status = page.getByTestId("object-total").locator("xpath=../..");
  for (const id of ["point-cloud-summary", "scan-edit-strip", "scan-top-down"]) {
    const [a, b] = [await status.boundingBox(), await page.getByTestId(id).boundingBox()];
    if (a === null || b === null) throw new Error(`no box for ${id}`);
    const overlaps = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect(overlaps, `the status column overlaps ${id}`).toBe(false);
  }

  // Wide enough for the views side by side, the column keeps to the perspective one.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(async () => {
    const [a, b] = [await status.boundingBox(), await page.getByTestId("scan-perspective").boundingBox()];
    return a !== null && b !== null && a.x + a.width <= b.x + b.width;
  }).toBe(true);
});

test("in Edit, polyline vertices drawn across a ramp take the ramp's height, and the flat part's", async ({ page }) => {
  const sent = await openScan(page, { schema: POLYLINE_SCHEMA, scan: rampBuffer() });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  await page.getByTestId("scan-edit-toggle").click();
  const top = page.getByTestId("scan-top-down-canvas");
  await expect.poll(() => drawCount(top)).toBeGreaterThan(0);
  await page.getByTestId("scan-tool-polyline").click();

  const box = await top.boundingBox();
  if (box === null) throw new Error("the top-down view has no box");
  const [cx, cy] = [box.width / 2, box.height / 2];
  // Forward reads up the screen: one vertex on the flat part, two up the ramp.
  for (const [x, y] of [[cx, cy + 80], [cx + 10, cy - 40], [cx + 20, cy - 120]] as const) {
    await page.mouse.click(box.x + x, box.y + y);
  }
  await expect(page.getByTestId("scan-top-draft-vertex-2")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");

  await page.getByTestId("point-cloud-gl").focus();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  const post = sent.find((request) => request.method() === "POST" && request.url().endsWith(`/jobs/${JOB}/annotations`));
  const [created] = post?.postDataJSON() as Wire["AnnotationCreate"][];
  const { points } = created?.geometry as Wire["Polyline3DBody"];
  expect(points).toHaveLength(3);
  for (const [x, , z] of points) expect(Math.abs(z - rampHeight(x))).toBeLessThan(0.1);
  expect(points[0]?.[0]).toBeLessThan(0);
  expect(points[2]?.[2]).toBeGreaterThan(points[1]?.[2] ?? Infinity);
  expect(points[2]?.[2]).toBeGreaterThan(-0.3);
});

test("in Edit, undo while a polyline is drawn steps back its last vertex, from the keys and the island alike, and leaves the history alone", async ({ page }) => {
  await openScan(page, { schema: POLYLINE_SCHEMA });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  await page.getByTestId("scan-edit-toggle").click();
  const top = page.getByTestId("scan-top-down-canvas");
  await expect.poll(() => drawCount(top)).toBeGreaterThan(0);

  // An earlier edit in the history, which an undo of a vertex must not reach.
  await page.getByTestId("object-select-0").click();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("object-count")).toHaveText("0 objects");

  await page.getByTestId("scan-tool-polyline").click();
  const box = await top.boundingBox();
  if (box === null) throw new Error("the top-down view has no box");
  const [cx, cy] = [box.width / 2, box.height / 2];
  for (const [x, y] of [[cx - 160, cy + 60], [cx - 100, cy + 80], [cx - 40, cy + 60]] as const) {
    await page.mouse.click(box.x + x, box.y + y);
  }
  await expect(page.getByTestId("scan-top-draft-vertex-2")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("scan-top-draft-vertex-2")).toHaveCount(0);
  await expect(page.getByTestId("scan-top-draft-vertex-1")).toBeVisible();
  await expect(page.getByTestId("object-count")).toHaveText("0 objects");

  await page.getByTestId("tool-undo").click();
  await expect(page.getByTestId("scan-top-draft-vertex-1")).toHaveCount(0);
  await expect(page.getByTestId("scan-top-draft-vertex-0")).toBeVisible();
  await expect(page.getByTestId("object-count")).toHaveText("0 objects");
  // A redo has no draft step to put back, and never reaches the history mid-draw.
  await expect(page.getByTestId("tool-redo")).toHaveAttribute("aria-disabled", "true");

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("scan-top-draft-vertex-0")).toHaveCount(0);
  await expect(page.getByTestId("object-count")).toHaveText("0 objects");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("object-count")).toHaveText("1 object");
});

test("in Edit, every edit to the scan is saved on its own, and a box being drawn holds the save", async ({ page }) => {
  const sent = await openScan(page, { schema: CUBOID_SCHEMA });
  const writes = (method: string): number =>
    sent.filter((request) => request.method() === method && request.url().includes(`/jobs/${JOB}/annotations`)).length;
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  await page.getByTestId("scan-edit-toggle").click();

  await page.getByTestId("scan-tool-cuboid").click();
  await drawCuboid(page, view);
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");
  await expect.poll(() => writes("POST")).toBe(1);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");

  // The second edit on the frame, with no mod+s.
  await page.getByTestId("object-delete-0").click();
  await expect(page.getByTestId("object-count")).toHaveText("1 object");
  await expect.poll(() => writes("DELETE")).toBe(1);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");

  // A third, then a footprint left at its width step: the save waits for the box.
  await page.getByTestId("object-delete-0").click();
  await expect(page.getByTestId("object-count")).toHaveText("0 objects");
  const box = await view.boundingBox();
  if (box === null) throw new Error("the view has no box");
  const [cx, cy] = [box.width / 2, box.height / 2];
  await dragIn(page, view, [cx - 220, cy + 150], [cx - 220, cy + 60]);
  await expect(page.getByTestId("scan-width-hint")).toBeVisible();
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-autosave", "held");
  expect(writes("DELETE")).toBe(1);

  await page.keyboard.press("Escape");
  await expect.poll(() => writes("DELETE")).toBe(2);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
});

const SCAN_CONTROLS = ["color-by-height", "color-by-intensity", "toggle-scan-labels", "reset-scan-view"] as const;
const ISLAND_CONTROLS = ["tool-undo", "tool-redo", "skip", "prev-asset", "open-gallery", "finish-job"] as const;

/** The ids among `ids` whose own centre is covered by something that is not part of them. */
async function covered(page: Page, ids: readonly string[]): Promise<string[]> {
  return page.evaluate((testIds) => {
    const out: string[] = [];
    for (const id of testIds) {
      const control = document.querySelector(`[data-testid="${id}"]`);
      if (control === null) {
        out.push(`${id} (absent)`);
        continue;
      }
      const rect = control.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      // A disabled control takes no pointer, so its tooltip wrapper is what a press meets.
      if (hit === null || !(control.contains(hit) || hit.contains(control))) {
        out.push(`${id} under ${hit?.closest("[data-testid]")?.getAttribute("data-testid") ?? hit?.tagName ?? "nothing"}`);
      }
    }
    return out;
  }, ids);
}

/** Which of the island and the scan's controls lie over the top-down view's canvas, where its handles are pressed. */
async function overTopDown(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const view = document.querySelector('[data-testid="scan-top-down-canvas"]')?.getBoundingClientRect();
    if (view === undefined) return ["no top-down view"];
    return ["frame-island", "point-cloud-controls"].filter((id) => {
      const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      return r !== undefined && r.x < view.right && view.x < r.right && r.y < view.bottom && view.y < r.bottom;
    });
  });
}

const WIDTHS = [768, 820, 880, 940, 1000, 1024, 1080, 1180, 1240, 1300, 1360] as const;

test("at every width from 768 to 1360 px, the island and the scan's controls cover neither each other nor the top-down view", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: WIDTHS[0], height: 900 });
  await openScan(page, { schema: CUBOID_SCHEMA });
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  await expect(page.getByTestId("point-cloud-controls")).toBeVisible();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => covered(page, [...SCAN_CONTROLS, ...ISLAND_CONTROLS]), { message: `View at ${width}` }).toEqual([]);
  }

  await page.getByTestId("scan-edit-toggle").click();
  await expect.poll(() => drawCount(page.getByTestId("scan-top-down-canvas"))).toBeGreaterThan(0);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => covered(page, [...SCAN_CONTROLS, ...ISLAND_CONTROLS]), { message: `Edit at ${width}` }).toEqual([]);
    await expect.poll(() => overTopDown(page), { message: `Edit at ${width}` }).toEqual([]);
  }
});

test("a scan's page carries no 2D tool chrome, and ? on the view opens the scan's own shortcuts", async ({ page }) => {
  await openScan(page);
  const view = page.getByTestId("point-cloud-canvas");
  await expect.poll(() => drawCount(view)).toBeGreaterThan(0);
  await expect(page.getByTestId("tool-options")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Tools" })).toHaveCount(0);
  await expect(page.getByTestId("annotation-page")).not.toContainText("picks a class");
  await expect(page.getByTestId("prev-asset")).toHaveAttribute("aria-label", "Previous scan");

  await page.getByTestId("point-cloud-gl").focus();
  await page.keyboard.press("?");
  const sheet = page.getByTestId("shortcut-sheet");
  await expect(sheet).toHaveAttribute("data-sheet", "scan");
  await expect(sheet.locator("[data-chord]")).toHaveCount(9);
  await expect(sheet).not.toContainText(/frame/i);
  await page.keyboard.press("?");
  await expect(sheet).toHaveCount(0);
});

test("a scan whose source request fails says so with a retry, and never that it declares no frame", async ({ page }) => {
  const source = { failing: true };
  await openScan(page, { schema: CUBOID_SCHEMA, source });
  const failure = page.getByTestId("scan-source-error");
  await expect(failure).toContainText("could not be read", { timeout: 20_000 });
  await expect(failure).toContainText("The workspace is busy");
  await expect(page.getByTestId("point-cloud-summary")).toContainText("frame unknown");
  await expect(page.getByTestId("point-cloud-summary")).not.toContainText("no declared frame");
  await expect(page.getByTestId("scan-edit-strip").locator("[data-reason]")).toHaveAttribute("data-reason", /could not be read/);

  source.failing = false;
  await failure.getByRole("button", { name: "Try again" }).click();
  await expect(failure).toHaveCount(0);
  await expect(page.getByTestId("point-cloud-summary")).toContainText("lidar_flu");
  await page.getByTestId("scan-edit-toggle").click();
  await expect(page.getByTestId("point-cloud-canvas")).toHaveAttribute("data-editing", "on");
});

/** Scan 1 holds the tracked car and a second car; scan 2 holds another car, then the tracked car one position on. */
const SCAN_OCCURRENCES: readonly Wire["FrameOccurrenceOut"][] = [
  { id: "scan-occ-1", source_id: SOURCE, position: 1, timestamp: 0.1, asset_id: "asset-1" },
  { id: "scan-occ-2", source_id: SOURCE, position: 2, timestamp: 0.2, asset_id: "asset-2" },
];

const OTHER_CAR: Wire["AnnotationOut"] = { ...CAR, id: "car-3d-b", geometry: { type: "cuboid_3d", center: [-8, 4, 0], size: [4, 2, 1.6], yaw: 0 } };
const CAR_LATER: Wire["AnnotationOut"] = { ...CAR, id: "car-3d-later", asset_id: "asset-2" };
const PARKED_LATER: Wire["AnnotationOut"] = { ...OTHER_CAR, id: "car-3d-parked", asset_id: "asset-2" };

function scanTracks(): TrackWorld {
  const at = (occurrence: Wire["FrameOccurrenceOut"], annotationId: string): Wire["TrackObservationOut"] => ({
    occurrence_id: occurrence.id,
    position: occurrence.position,
    timestamp: occurrence.timestamp,
    asset_id: occurrence.asset_id,
    annotation_id: annotationId,
  });
  return {
    sourceId: SOURCE,
    occurrences: SCAN_OCCURRENCES,
    tracks: [
      {
        id: "track-1",
        source_id: SOURCE,
        label_class: "vehicle",
        external_id: "scene-1-car",
        geometry_kind: "cuboid_3d",
        observations: [at(SCAN_OCCURRENCES[0]!, CAR.id), at(SCAN_OCCURRENCES[1]!, CAR_LATER.id)],
      },
    ],
  };
}

test("a scan of a sequence lists its tracks, steps to the next scan on its cuboid, and its cuboids join and leave a track", async ({ page }) => {
  await requireWebGl2(page);
  const sent = await serveScan(page, openedWorld(), { schema: CUBOID_SCHEMA, tracks: scanTracks(), seeded: [CAR, OTHER_CAR, PARKED_LATER, CAR_LATER] });

  await expect(page.getByTestId("track-region")).toBeVisible();
  await expect(page.getByTestId("track-row-track-1")).toContainText("vehicle scene-1-car");
  await expect(page.getByTestId("track-row-track-1")).toContainText("2 frames");
  await expect(page.getByTestId("object-track-0")).toBeVisible();
  await expect(page.getByTestId("object-track-1")).toHaveCount(0);

  await page.getByTestId("object-track-0").click();
  await expect(page.getByTestId("track-where")).toHaveText("On this frame at 1");
  await page.getByTestId("track-next").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  await expect(page.getByTestId("track-where")).toHaveText("On this frame at 2");
  await expect(page.getByTestId("object-row-1")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("object-row-0")).toHaveAttribute("data-selected", "false");

  await page.getByTestId("track-unobserve-2").click();
  await expect(page.getByTestId("track-done")).toContainText("the object stays");
  await expect(page.getByTestId("object-track-1")).toHaveCount(0);

  await page.getByTestId("track-previous").click();
  await expect(page.getByTestId("asset-position")).toContainText("1/2");
  await page.getByTestId("object-select-1").click();
  await expect(page.getByTestId("track-observe")).toHaveAttribute("data-reason", "The track already follows an object on this frame");
  await page.getByTestId("track-start").click();
  await expect(page.getByTestId("track-done")).toHaveText("Started a track at frame 1");
  await expect(page.getByTestId("object-track-1")).toBeVisible();

  const writes = sent
    .filter((one) => one.method() !== "GET" && one.url().includes("/tracks"))
    .map((one) => `${one.method()} ${new URL(one.url()).pathname.replace(/^\/api/, "")}`);
  expect(writes).toEqual([
    `DELETE /jobs/${JOB}/tracks/track-1/observations/scan-occ-2`,
    `POST /jobs/${JOB}/tracks`,
  ]);
  const start = sent.filter((one) => one.method() === "POST" && one.url().endsWith(`/jobs/${JOB}/tracks`)).at(-1)!;
  expect(JSON.parse(start.postData() ?? "{}")).toEqual({ occurrence_id: "scan-occ-1", annotation_id: OTHER_CAR.id });
});
