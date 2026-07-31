/**
 * The bbox tool, which v1's Playwright suite never covered at all.
 *
 * v1 shipped four specs: two are polyline and lane-export work over a geometry this
 * build refuses on the wire, one is routing, and the fourth is the polygon tool. So
 * the tool that draws most of the boxes in most datasets had no browser coverage,
 * and these scenarios are the port's own addition rather than a translation.
 *
 * The scenario that earns the file is the last one: **the transform, pinned**. Every
 * other assertion here is structural — a count, a class, a label — and would stay
 * green if the screen-to-asset conversion were wrong by a constant factor. Drawing a
 * box between two known asset coordinates at a fit zoom of about 0.8 and reading the
 * numbers back off the wire is the one check that the coordinates leaving this page
 * are in the asset's own frame. `sampleAsset.ts` draws a labelled ruler grid for
 * exactly this reason; this is that check, automated.
 */

import { expect, test } from "@playwright/test";

import {
  COORDINATE_SLACK,
  drag,
  drawBbox,
  expectCounts,
  focusCanvas,
  frameOf,
  wire,
  SHOWCASE,
} from "./_frame";

test.beforeEach(async ({ page }) => {
  await page.goto(SHOWCASE);
});

test("a drag with a bbox class draws one box, already selected", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 400, y: 240 }, { x: 800, y: 480 });

  await expectCounts(page, 1, 1);
  await expect(page.getByTestId("annotation-layer").locator("[data-handle]")).toHaveCount(8);
  await expect(page.getByTestId("undo")).toHaveText(/Undo add vehicle/);
});

/**
 * The scenario this file exists for.
 *
 * Geometry is in the asset's native pixels and is never normalized — the invariant
 * `core/types.ts` states and the one an agent gets wrong by measuring on a preview.
 * A box drawn between (400,240) and (800,480) must read back as exactly that, at a
 * zoom that is neither 1 nor a round number.
 */
test("the drawn box reads back in the asset's own pixels", async ({ page }) => {
  const frame = await frameOf(page);
  // Not 1: if the fit ever became native scale this check would stop proving the
  // conversion and nobody would notice.
  expect(frame.zoom).toBeLessThan(1);

  await drawBbox(page, frame, { x: 400, y: 240 }, { x: 800, y: 480 });

  const payload = await wire(page);
  expect(payload).toHaveLength(1);
  const box = payload[0]?.geometry as {
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
  };
  expect(box.type).toBe("bbox");
  expect(Math.abs(box.x - 400)).toBeLessThanOrEqual(COORDINATE_SLACK);
  expect(Math.abs(box.y - 240)).toBeLessThanOrEqual(COORDINATE_SLACK);
  expect(Math.abs(box.width - 400)).toBeLessThanOrEqual(COORDINATE_SLACK);
  expect(Math.abs(box.height - 240)).toBeLessThanOrEqual(COORDINATE_SLACK);
  expect(payload[0]?.label_class).toBe("vehicle");
});

test("a body drag moves the box by the distance dragged", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 400, y: 240 }, { x: 700, y: 440 });
  await page.keyboard.press("v");

  await drag(page, frame.at(550, 340), frame.at(650, 400));
  await expect(page.getByTestId("undo")).toHaveText(/Undo move vehicle/);

  const box = (await wire(page))[0]?.geometry as { x: number; y: number; width: number };
  expect(Math.abs(box.x - 500)).toBeLessThanOrEqual(COORDINATE_SLACK);
  expect(Math.abs(box.y - 300)).toBeLessThanOrEqual(COORDINATE_SLACK);
  // A move is not a resize: the size is the invariant that makes the claim specific.
  expect(Math.abs(box.width - 300)).toBeLessThanOrEqual(COORDINATE_SLACK);
});

/**
 * The `se` grip drives both edges, so one drag proves the handle was picked *and*
 * which one. Dragging a corner grip and getting a move instead would keep the size
 * and change the origin, which the width assertion below rules out.
 */
test("a corner grip resizes rather than moves", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 400, y: 240 }, { x: 700, y: 440 });
  await page.keyboard.press("v");

  await drag(page, frame.at(700, 440), frame.at(820, 540));
  await expect(page.getByTestId("undo")).toHaveText(/Undo resize vehicle/);

  const box = (await wire(page))[0]?.geometry as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  expect(Math.abs(box.x - 400)).toBeLessThanOrEqual(COORDINATE_SLACK);
  expect(Math.abs(box.y - 240)).toBeLessThanOrEqual(COORDINATE_SLACK);
  expect(Math.abs(box.width - 420)).toBeLessThanOrEqual(COORDINATE_SLACK);
  expect(Math.abs(box.height - 300)).toBeLessThanOrEqual(COORDINATE_SLACK);
});

/**
 * `MIN_DRAW_SIZE_PX` is three **screen** pixels — a fact about hands, not about the
 * document. So the gesture below is sized in *page* pixels, straight off `from`,
 * rather than converted from asset units: page pixels are the frame the constant is
 * declared in, and going through `frame.at` twice would silently rescale it.
 *
 * v1 compared its threshold against a coordinate it had already divided by the zoom,
 * so a box needed about one screen pixel of drag at 30% and six at 200%. This is the
 * gate that inversion used to sit on.
 */
test("a drag smaller than the draw minimum creates nothing", async ({ page }) => {
  const frame = await frameOf(page);
  await focusCanvas(page);
  await page.keyboard.press("1");

  const from = frame.at(500, 300);
  await drag(page, from, { x: from.x + 2, y: from.y + 2 });

  await expectCounts(page, 0, 0);
  await expect(page.getByTestId("undo")).toBeDisabled();
});

/**
 * Escape mid-drag **reverts**, where v1 could only stop.
 *
 * #39's store stages a drag outside the log, so the committed document is the same
 * object for the whole gesture and a cancel drops the preview rather than pushing a
 * compensating edit. Nothing reaches the history at all — which is what `canUndo`
 * still reading `add vehicle` proves.
 */
test("Escape during a drag reverts it and leaves no history entry", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 400, y: 240 }, { x: 700, y: 440 });
  await page.keyboard.press("v");

  const before = (await wire(page))[0];

  await page.mouse.move(frame.at(550, 340).x, frame.at(550, 340).y);
  await page.mouse.down();
  await page.mouse.move(frame.at(700, 500).x, frame.at(700, 500).y, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();

  await expect(page.getByTestId("undo")).toHaveText(/Undo add vehicle/);
  expect((await wire(page))[0]).toEqual(before);
});

/**
 * Two bbox classes exist in the schema for this: `vehicle` (1) and `pedestrian` (4).
 * Swapping one for the other must **not** abandon a half-drawn box, because the
 * derived tool did not move — the half of `tool-changed` a host usually gets wrong.
 */
test("switching between two bbox classes does not abandon a half-drawn box", async ({ page }) => {
  const frame = await frameOf(page);
  await focusCanvas(page);
  await page.keyboard.press("1");

  await page.mouse.move(frame.at(400, 240).x, frame.at(400, 240).y);
  await page.mouse.down();
  await page.mouse.move(frame.at(600, 380).x, frame.at(600, 380).y, { steps: 6 });
  await page.keyboard.press("4");
  await page.mouse.move(frame.at(700, 440).x, frame.at(700, 440).y, { steps: 6 });
  await page.mouse.up();

  await expectCounts(page, 1, 1);
  // The class is the one the gesture *started* with: a drawing session carries its
  // own `labelClass`, so the swap changes what the next box would be, not this one.
  expect((await wire(page))[0]?.label_class).toBe("vehicle");
});
