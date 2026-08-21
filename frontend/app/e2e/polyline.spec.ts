/**
 * v1's `polyline-tool.spec.ts`, ported — the last of its four specs to become
 * portable.
 *
 * `docs/content/annotations.md`'s reconciliation table has carried this file as *"out of
 * scope for a different and narrower reason: it drives a drawing tool, and 0.1.0
 * has none"*. The tool exists now, so the reason is spent and the port
 * is this file.
 *
 * ## What ports, and what does not
 *
 * v1 had **seven** scenarios over 257 lines, and most of that length was setup: it
 * created a `LANE_DETECTION` project through the API, uploaded an image, and
 * navigated to an editor, per test. The harness here has a fixture, so what is left
 * is the behaviour.
 *
 * | v1 scenario | here |
 * | --- | --- |
 * | the strip shows a Polyline tool | *the strip offers the tool a lane class earns* |
 * | pressing `L` activates it | *a class hotkey arms it* — the key is the class's digit, because tools are derived from classes and not dispatched (`tool.ts`) |
 * | drawing produces an SVG `<polyline>` | *drawing a lane places its points in the order they were clicked* |
 * | a floating bar shows the point count | **not ported** — there is no floating bar, and the point count lives on the Annotations panel |
 * | right-click undoes the last pending point | *backspace takes back the last point* — every non-primary press is a pan and never reaches the machine, so the keyboard is the browser's only spelling |
 * | dragging the body moves it | *a lane moves as one, and undo puts it back* |
 * | Delete removes the selected polyline | *delete removes the selected lane* |
 *
 * Two things v1 could not assert at all and this does: that a session is **one**
 * undo step however many points it has, and that the stored point order is the
 * order they were clicked. The second is the one that matters — TuSimple's
 * ascending-Y rule is enforced at export precisely so drawing never guesses which
 * way a lane runs, and a tool that sorted would reverse half of them invisibly.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  COORDINATE_SLACK,
  SHOWCASE,
  expectCounts,
  focusCanvas,
  frameOf,
  vertices,
  wire,
  type Frame,
  type Point,
} from "./_frame";

test.beforeEach(async ({ page }) => {
  await page.goto(SHOWCASE);
});

/** Digit 5 in the demo schema is `centerline`, the one polyline class. */
const LANE_HOTKEY = "5";

/** Three points running **upward** — descending Y, so a sort would reverse them. */
const LANE: readonly Point[] = [
  { x: 400, y: 500 },
  { x: 600, y: 380 },
  { x: 800, y: 260 },
];

async function drawLane(page: Page, frame: Frame, points: readonly Point[] = LANE): Promise<void> {
  await focusCanvas(page);
  await page.keyboard.press(LANE_HOTKEY);
  for (const point of points) {
    const at = frame.at(point.x, point.y);
    await page.mouse.click(at.x, at.y);
  }
  await page.keyboard.press("Enter");
}

test("the strip offers the tool a lane class earns", async ({ page }) => {
  await frameOf(page);

  const tool = page.getByTestId("tool-polyline");
  await expect(tool).toBeVisible();
  // Live, not disabled-with-reason: it spent one release as the strip's worked
  // example of not-yet-drawable, and it has a tool now.
  await expect(tool).not.toHaveAttribute("aria-disabled", /.*/);
  await expect(tool).toHaveAttribute("title", "Polyline (5)");
});

test("a class hotkey arms it, and the strip reports the derived tool", async ({ page }) => {
  await frameOf(page);
  await focusCanvas(page);

  await page.keyboard.press(LANE_HOTKEY);

  // v1 pressed `L` for a stored `activeTool`. Here the tool *is* the active class,
  // so the key is the class's digit and the strip is reporting rather than holding.
  await expect(page.getByTestId("tool-polyline")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("tool-select")).toHaveAttribute("data-active", "false");
});

test("drawing a lane places its points in the order they were clicked", async ({ page }) => {
  const frame = await frameOf(page);
  await drawLane(page, frame);

  await expectCounts(page, 1, 1);
  const drawn = (await wire(page)).at(-1) as { geometry: { type: string; points: number[][] } };
  expect(drawn.geometry.type).toBe("polyline");
  // Y descends, exactly as clicked. A sort into TuSimple's ascending-Y order —
  // which is enforced at *export*, in `visionset.formats.lanes`, and must not be
  // enforced here — would reverse this and the reversed lane would look fine.
  // `COORDINATE_SLACK`, because a click lands on a device pixel and the fitted
  // zoom is not an integer ratio — the claim is the *order*, not the arithmetic.
  const ys = drawn.geometry.points.map(([, y]) => y);
  for (const [at, wanted] of [500, 380, 260].entries()) {
    expect(ys[at]).toBeGreaterThan(wanted - COORDINATE_SLACK);
    expect(ys[at]).toBeLessThan(wanted + COORDINATE_SLACK);
  }
});

test("a whole session is one undo step, however many points it has", async ({ page }) => {
  const frame = await frameOf(page);
  await drawLane(page, frame, [
    { x: 300, y: 500 },
    { x: 420, y: 440 },
    { x: 540, y: 380 },
    { x: 660, y: 320 },
    { x: 780, y: 260 },
  ]);
  await expectCounts(page, 1, 1);

  await page.keyboard.press("ControlOrMeta+z");

  await expectCounts(page, 0, 0);
  await expect(page.getByTestId("undo")).toBeDisabled();
});

test("backspace takes back the last point, which is the only spelling a browser has", async ({
  page,
}) => {
  // v1 used a right-click, and the React adapter answers **every** non-primary
  // press with a pan and returns before the machine is told, so the gesture has no
  // path through a browser — the keyboard is it. The engine still carries both, and
  // `polylineTool.test.ts` drives the secondary press directly.
  const frame = await frameOf(page);
  await focusCanvas(page);
  await page.keyboard.press(LANE_HOTKEY);
  for (const point of LANE) {
    const at = frame.at(point.x, point.y);
    await page.mouse.click(at.x, at.y);
  }

  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");

  const drawn = (await wire(page)).at(-1) as { geometry: { points: number[][] } };
  expect(drawn.geometry.points).toHaveLength(2);
});

test("escape abandons the session and writes nothing", async ({ page }) => {
  const frame = await frameOf(page);
  await focusCanvas(page);
  await page.keyboard.press(LANE_HOTKEY);
  for (const point of LANE) {
    const at = frame.at(point.x, point.y);
    await page.mouse.click(at.x, at.y);
  }

  await page.keyboard.press("Escape");

  await expectCounts(page, 0, 0);
  await expect(page.getByTestId("undo")).toBeDisabled();
});

test("a lane moves as one, and undo puts it back", async ({ page }) => {
  const frame = await frameOf(page);
  await drawLane(page, frame);
  await page.keyboard.press("v");

  const before = (await wire(page)).at(-1) as { geometry: { points: number[][] } };
  // Press on the middle of the first segment — an open path is reached by its
  // outline, because it has no inside for a press to land in.
  const from = frame.at(500, 440);
  const to = frame.at(500 + 60, 440 + 40);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();

  const moved = (await wire(page)).at(-1) as { geometry: { points: number[][] } };
  expect(moved.geometry.points[0][0]).toBeGreaterThan(before.geometry.points[0][0]);
  // Rigid: every point took the same offset, so the shape is unchanged.
  const spans = (shape: { geometry: { points: number[][] } }) =>
    shape.geometry.points[2][0] - shape.geometry.points[0][0];
  expect(Math.round(spans(moved))).toBe(Math.round(spans(before)));

  await page.keyboard.press("ControlOrMeta+z");
  const back = (await wire(page)).at(-1) as { geometry: { points: number[][] } };
  expect(Math.round(back.geometry.points[0][0])).toBe(
    Math.round(before.geometry.points[0][0]),
  );
});

test("a selected lane draws its vertices, and one of them drags", async ({ page }) => {
  const frame = await frameOf(page);
  await drawLane(page, frame);
  await page.keyboard.press("v");

  // Three vertices, because the lane is selected — the same affordance a polygon
  // gets, over a geometry `resolveTarget` would not look at without a tool.
  await expect(vertices(page)).toHaveCount(3);

  const grip = frame.at(LANE[0].x, LANE[0].y);
  const to = frame.at(LANE[0].x - 80, LANE[0].y - 40);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();

  const edited = (await wire(page)).at(-1) as { geometry: { points: number[][] } };
  expect(Math.round(edited.geometry.points[0][0])).toBeCloseTo(320, -1);
  // And only that one moved.
  expect(Math.round(edited.geometry.points[2][1])).toBe(260);
});

test("delete removes the selected lane", async ({ page }) => {
  const frame = await frameOf(page);
  await drawLane(page, frame);
  await page.keyboard.press("v");
  await expectCounts(page, 1, 1);

  await focusCanvas(page);
  await page.keyboard.press("Delete");

  await expectCounts(page, 0, 0);
});
