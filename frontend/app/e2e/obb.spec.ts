/**
 * The rotated-box tool on the annotation page: a drag draws a box at angle 0, the
 * grip above it turns it, and what the page saves is the wire's `obb` in canonical
 * form.
 */

import { expect, test, type Page, type Request } from "@playwright/test";

import { COORDINATE_SLACK, drag, focusCanvas, frameOf, saveNow, type Frame } from "./_frame";
import { openedWorld, openJob } from "./_wireApiStub";

/** Digit 4 on the served schema: `vehicle`, `lane`, `pedestrian`, then `crate`. */
const CRATE_HOTKEY = "4";

const ASSET = { width: 640, height: 480 } as const;

/** Where the rotation grip sits beyond the box's `n` side, in screen pixels. */
const ROTATE_OFFSET_PX = 24;

/** The box every scenario draws: centred on (320, 220), 240 by 120. */
const CENTRE = { x: 320, y: 220 } as const;

interface Obb {
  readonly type: string;
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
}

async function openWithCrate(page: Page, sent: Request[]): Promise<Frame> {
  await openJob(page, sent, undefined, openedWorld(), { obb: true });
  return frameOf(page, ASSET);
}

async function drawCrate(page: Page, frame: Frame): Promise<void> {
  await focusCanvas(page);
  await page.keyboard.press(CRATE_HOTKEY);
  await drag(page, frame.at(200, 160), frame.at(440, 280));
  await expect(page.getByTestId("annotation-layer").locator("[data-annotation-id]")).toHaveCount(1);
}

/** Press the rotation grip of the box just drawn and drag it to `to`, in select mode. */
async function turnTo(page: Page, frame: Frame, to: { readonly x: number; readonly y: number }): Promise<void> {
  await page.keyboard.press("v");
  const top = frame.at(CENTRE.x, 160);
  await drag(page, { x: top.x, y: top.y - ROTATE_OFFSET_PX }, frame.at(to.x, to.y));
}

async function saved(page: Page, sent: Request[]): Promise<Obb> {
  await saveNow(page);
  await expect.poll(() => sent.some((r) => r.method() === "POST" && r.url().endsWith("/annotations"))).toBe(true);
  const post = sent.filter((r) => r.method() === "POST" && r.url().endsWith("/annotations")).at(-1);
  const body = JSON.parse(post?.postData() ?? "[]") as { geometry: Obb }[];
  expect(body).toHaveLength(1);
  return body[0].geometry;
}

test("the strip offers the tool a rotated-box class earns", async ({ page }) => {
  await openWithCrate(page, []);
  await focusCanvas(page);
  await page.keyboard.press(CRATE_HOTKEY);
  await expect(page.getByTestId("tool-obb")).toHaveAttribute("data-active", "true");
});

test("a drag draws a rotated box at angle 0, with eight grips and a rotation grip", async ({ page }) => {
  const sent: Request[] = [];
  const frame = await openWithCrate(page, sent);
  await drawCrate(page, frame);

  await expect(page.getByTestId("annotation-layer").locator("[data-handle]")).toHaveCount(9);
  await expect(page.getByTestId("annotation-layer").locator('[data-handle="rotate"]')).toHaveCount(1);

  const geometry = await saved(page, sent);
  expect(Object.keys(geometry).sort()).toEqual(["angle", "cx", "cy", "height", "type", "width"]);
  expect(geometry.type).toBe("obb");
  expect(geometry.angle).toBe(0);
  expect(Math.abs(geometry.cx - CENTRE.x)).toBeLessThan(COORDINATE_SLACK);
  expect(Math.abs(geometry.cy - CENTRE.y)).toBeLessThan(COORDINATE_SLACK);
  expect(Math.abs(geometry.width - 240)).toBeLessThan(2 * COORDINATE_SLACK);
  expect(Math.abs(geometry.height - 120)).toBeLessThan(2 * COORDINATE_SLACK);
});

test("the rotation grip turns the box about its centre, and the save carries the angle", async ({ page }) => {
  const sent: Request[] = [];
  const frame = await openWithCrate(page, sent);
  await drawCrate(page, frame);

  // An eighth of a turn clockwise: from straight up to up and to the right.
  await turnTo(page, frame, { x: CENTRE.x + 100 * Math.SQRT1_2, y: CENTRE.y - 100 * Math.SQRT1_2 });

  const geometry = await saved(page, sent);
  expect(geometry.angle).toBeGreaterThan(Math.PI / 4 - 0.05);
  expect(geometry.angle).toBeLessThan(Math.PI / 4 + 0.05);
  expect(Math.abs(geometry.cx - CENTRE.x)).toBeLessThan(COORDINATE_SLACK);
  expect(Math.abs(geometry.cy - CENTRE.y)).toBeLessThan(COORDINATE_SLACK);
  expect(geometry.width).toBeGreaterThan(geometry.height);
});

test("a turn past a quarter is saved canonically, width first and the angle in [-π/2, π/2)", async ({ page }) => {
  const sent: Request[] = [];
  const frame = await openWithCrate(page, sent);
  await drawCrate(page, frame);

  // Three eighths of a turn clockwise, so the stored angle wraps to the far side.
  await turnTo(page, frame, { x: CENTRE.x + 100 * Math.SQRT1_2, y: CENTRE.y + 100 * Math.SQRT1_2 });

  const geometry = await saved(page, sent);
  expect(geometry.width).toBeGreaterThanOrEqual(geometry.height);
  expect(geometry.angle).toBeGreaterThan(-Math.PI / 4 - 0.05);
  expect(geometry.angle).toBeLessThan(-Math.PI / 4 + 0.05);
});

test("undo puts a turned box back at angle 0", async ({ page }) => {
  const sent: Request[] = [];
  const frame = await openWithCrate(page, sent);
  await drawCrate(page, frame);
  await turnTo(page, frame, { x: CENTRE.x + 100, y: CENTRE.y });
  // A quarter turn, which the canonical form stores at -π/2.
  const drawnAngle = page.getByTestId("annotation-layer").locator("[data-obb-angle]");
  await expect.poll(async () => Number(await drawnAngle.getAttribute("data-obb-angle"))).toBeCloseTo(-Math.PI / 2, 1);

  await focusCanvas(page);
  await page.keyboard.press("ControlOrMeta+z");

  expect((await saved(page, sent)).angle).toBe(0);
});

test("a body drag moves the box and keeps its size and angle", async ({ page }) => {
  const sent: Request[] = [];
  const frame = await openWithCrate(page, sent);
  await drawCrate(page, frame);
  await page.keyboard.press("v");

  await drag(page, frame.at(CENTRE.x, CENTRE.y), frame.at(CENTRE.x + 60, CENTRE.y + 40));

  const geometry = await saved(page, sent);
  expect(Math.abs(geometry.cx - (CENTRE.x + 60))).toBeLessThan(2 * COORDINATE_SLACK);
  expect(Math.abs(geometry.cy - (CENTRE.y + 40))).toBeLessThan(2 * COORDINATE_SLACK);
  expect(geometry.angle).toBe(0);
  expect(Math.abs(geometry.width - 240)).toBeLessThan(2 * COORDINATE_SLACK);
});
