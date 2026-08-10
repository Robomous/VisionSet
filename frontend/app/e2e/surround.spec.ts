/**
 * The margin around the picture.
 *
 * Every other scenario in this suite aims *inside* the asset, because that is
 * where annotations are. This one is about everywhere else — and without a
 * full-viewport input surface there
 * was nothing there at all: `AnnotatorCanvas` laid the `<svg>` out at
 * `asset.width × asset.height` inside the scaled stage, so the `<svg>` **was** the
 * image rectangle, and it is deliberately the only input surface. The
 * hit-testable region was therefore exactly the asset, and the pane around it was
 * dead. A box against the edge of the image had grips sitting on or just outside
 * the boundary that could not be grabbed, and a press on the surround did not
 * clear the selection the way a press on empty canvas does.
 *
 * That was a layout fact, never a geometry one — `screenToImage` is arithmetic
 * with no clamp and `resolveTarget` has always worked at negative coordinates.
 * The fix moves the sole input surface from the `<svg>` to the **pane**, which
 * spans the whole viewport and, being a `<div>` that no commit ever detaches, is
 * a strictly safer host for the focus rule than the `<svg>` was.
 *
 * ## Every coordinate here is deliberately outside the asset
 *
 * `frameOf().at()` is linear and unclamped, so `at(-30, y)` is a real page
 * position 30 asset-pixels to the left of the image. `surroundOf` proves such a
 * position is inside the pane before any scenario relies on it — a fit that left
 * no margin would otherwise turn every assertion below into a silent pass.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  ASSET,
  COORDINATE_SLACK,
  SHOWCASE,
  drawBbox,
  expectCounts,
  frameOf,
  type Frame,
  type Point,
} from "./_frame";

/**
 * A point in the margin, and the proof that the margin exists.
 *
 * Read from the live layout rather than assumed: the fit depends on the window,
 * and a scenario that aimed at a made-up "outside" would pass on a wide viewport
 * and miss the pane on a narrow one. Returned as page coordinates, since that is
 * what `page.mouse` takes.
 */
async function surroundOf(page: Page): Promise<{ readonly left: Point; readonly above: Point }> {
  const pane = await page.getByTestId("annotator-pane").boundingBox();
  const canvas = await page.getByTestId("annotator-canvas").boundingBox();
  if (pane === null || canvas === null) throw new Error("no pane or canvas box");

  // The margin has to be real on both axes for the scenarios below to mean
  // anything. `FIT_PADDING_PX` is 16, so this is the fit doing its job — and if a
  // layout change ever removes the margin, this fails here rather than as five
  // mysterious misses.
  expect(canvas.x - pane.x).toBeGreaterThan(8);
  expect(canvas.y - pane.y).toBeGreaterThan(8);

  return {
    left: { x: Math.round(canvas.x - 6), y: Math.round(canvas.y + canvas.height / 2) },
    above: { x: Math.round(canvas.x + canvas.width / 2), y: Math.round(canvas.y - 6) },
  };
}

/**
 * A box hard against the left edge, so its two left grips sit on the boundary.
 *
 * Ends in **select mode**. `drawBbox` leaves the bbox tool active — unlike
 * `drawTriangle`, which presses `v` on the way out — and every scenario here is
 * about pressing empty space, where the two tools mean opposite things: in select
 * mode a press on nothing is `pressing-empty`, in bbox mode it starts drawing.
 * Without this the surround assertions would be measuring a refused zero-size box.
 */
async function boxAgainstTheLeftEdge(page: Page, frame: Frame): Promise<void> {
  await drawBbox(page, frame, { x: 0, y: 200 }, { x: 300, y: 500 });
  await expectCounts(page, 1, 1);
  await page.keyboard.press("v");
}

test.beforeEach(async ({ page }) => {
  await page.goto(SHOWCASE);
});

test("a press on the surround reaches the machine and clears the selection", async ({ page }) => {
  const frame = await frameOf(page);
  await boxAgainstTheLeftEdge(page, frame);

  const { above } = await surroundOf(page);
  // A press that stays put clears the selection — the same rule that holds inside
  // the image and it is not changed here, only made reachable in the margin.
  await page.mouse.click(above.x, above.y);
  await expectCounts(page, 1, 0);
});

test("a press on the surround that travels leaves the selection alone", async ({ page }) => {
  const frame = await frameOf(page);
  await boxAgainstTheLeftEdge(page, frame);

  const { above } = await surroundOf(page);
  await page.mouse.move(above.x, above.y);
  await page.mouse.down();
  await page.mouse.move(above.x + 120, above.y, { steps: 8 });
  await page.mouse.up();

  // There is no rubber-band marquee, and a travelling press leaves the
  // selection untouched. This one passed before the fix too — for the wrong
  // reason, because the press reached nothing at all — so it is here as the
  // other half of the rule its sibling above asserts: now that the margin *is*
  // live, a press there must still distinguish a click from a drag.
  await expectCounts(page, 1, 1);
});

test("a grip that sits on the image edge is grabbable from outside it", async ({ page }) => {
  const frame = await frameOf(page);
  await boxAgainstTheLeftEdge(page, frame);

  // The top-left grip is at asset (0, 200) — on the boundary. Grab it from six
  // asset-pixels *outside* the image, which is inside `VERTEX_PX` of the grip and
  // was previously dead surround.
  const from = frame.at(-6, 200);
  const to = frame.at(-6, 120);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();

  const [box] = await page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="wire"]')?.textContent ?? "[]"),
  );
  // The resize landed: the top edge moved up. `inFrame` still clamps the geometry
  // into the asset, which is the rule this issue deliberately does not touch — it
  // is about *reaching* a shape, not about permitting out-of-bounds annotations.
  expect(box.geometry.y).toBeLessThan(180);
  expect(box.geometry.y).toBeGreaterThanOrEqual(0);
});

test("a shape selects by the part of it that overhangs the image", async ({ page }) => {
  const frame = await frameOf(page);
  await boxAgainstTheLeftEdge(page, frame);

  // Deselect through the surround, then re-select by pressing the very edge of
  // the shape from the margin side.
  const { above } = await surroundOf(page);
  await page.mouse.click(above.x, above.y);
  await expectCounts(page, 1, 0);

  const edge = frame.at(-2, 350);
  await page.mouse.click(edge.x, edge.y);
  await expectCounts(page, 1, 1);
});

test("a drag that leaves the image keeps tracking", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 200, y: 200 }, { x: 400, y: 400 });
  await expectCounts(page, 1, 1);
  await page.keyboard.press("v");

  // Grab the body and drag it well past the left edge.
  //
  // This is a **control**: it passed before the fix, because `setPointerCapture`
  // redirects every subsequent move to the capturing element regardless of where
  // the pointer is. The issue lists it as a requirement, so it is asserted rather
  // than assumed — moving the input surface must not cost the capture that made
  // it work.
  const from = frame.at(300, 300);
  const to = frame.at(-120, 300);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();

  const [box] = await page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="wire"]')?.textContent ?? "[]"),
  );
  // Clamped to the frame by `inFrame`, which is exactly what "kept tracking to
  // the end" looks like for a move that ran off the left edge.
  expect(box.geometry.x).toBe(0);
  // The width is unchanged by a move. Compared with the suite's own slack, because
  // `drawBbox` rounds to integer page coordinates and 200 asset pixels at a fitted
  // zoom is not a whole number of them.
  expect(Math.abs(box.geometry.width - 200)).toBeLessThanOrEqual(COORDINATE_SLACK);
});

/**
 * The adapter's invariant, restated as a test rather than as a comment.
 *
 * The focus bug was caused by an SVG shape being a press's hit target and then
 * being detached by that same press, leaving the browser's focus fixup resolving
 * a node that was gone. The invariant is *one input surface, and shapes are never
 * it*, and moving that surface to the pane must not weaken it.
 *
 * **What guards it now is the transform wrapper's `pointer-events: none`, and
 * that was measured rather than assumed.** The property is inherited, so the
 * topmost inert element decides for everything below: removing the wrapper's
 * declaration fails this scenario, while removing the `<svg>`'s — or
 * `AnnotationLayer`'s, which reproduces the focus bug
 * when the `<svg>` was still live — changes nothing at all. The computed-style
 * assertions below therefore describe the *result* for the whole subtree, and the
 * `elementFromPoint` check is the one that actually bites.
 */
test("nothing between the pane and the pixels can be a hit target", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 200, y: 200 }, { x: 400, y: 400 });
  await page.keyboard.press("v");

  // The whole subtree between the pane and the pixels resolves to inert, however
  // many of the declarations along the way are doing the work.
  const canvasEvents = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector('[data-testid="annotator-canvas"]')!).pointerEvents,
  );
  expect(canvasEvents).toBe("none");

  const inert = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="annotator-canvas"] > g')].map(
      (layer) => getComputedStyle(layer).pointerEvents,
    ),
  );
  expect(inert.length).toBeGreaterThan(0);
  expect(inert.every((value) => value === "none")).toBe(true);

  // …and the element a press actually lands on is the pane — over the picture,
  // where a shape is drawn, which is exactly where the focus bug lives.
  const at = frame.at(300, 300);
  const target = await page.evaluate(
    ([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.dataset["testid"] ?? null,
    [at.x, at.y] as const,
  );
  expect(target).toBe("annotator-pane");

  // Focus survives the press that removes the shape under it — the exact gesture
  // the focus rule protects, driven here through the pane.
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId("annotator-root")).toBeFocused();
  await page.keyboard.press("Delete");
  await expectCounts(page, 0, 0);
  await expect(page.getByTestId("annotator-root")).toBeFocused();
});

/** The asset frame is unchanged: the `<svg>` still measures the picture. */
test("the canvas still reports the asset rect, so every other scenario's frame holds", async ({
  page,
}) => {
  const frame = await frameOf(page);
  const box = await page.getByTestId("annotator-canvas").boundingBox();
  expect(box?.width).toBeCloseTo(ASSET.width * frame.zoom, 0);
  expect(box?.height).toBeCloseTo(ASSET.height * frame.zoom, 0);

  // …and a shape still lands where it was aimed. This is the control the rest of
  // the file leans on: every scenario above converts asset pixels to page
  // coordinates through `frame.at`, so a transform that had shifted would make
  // them pass or fail for a reason that has nothing to do with the surround.
  await drawBbox(page, frame, { x: 300, y: 300 }, { x: 500, y: 500 });
  const [drawn] = await page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="wire"]')?.textContent ?? "[]"),
  );
  expect(drawn.geometry.x).toBeCloseTo(300, -1);
  expect(drawn.geometry.y).toBeCloseTo(300, -1);
  expect(drawn.geometry.width).toBeCloseTo(200, -1);
  expect(drawn.geometry.height).toBeCloseTo(200, -1);
});
