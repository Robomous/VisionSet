/**
 * The side panel in a browser, and the one claim only a browser can settle:
 * **a hidden object neither renders nor hit-tests.**
 *
 * The panel's markup and its commands are covered by `ui-core`'s component tests,
 * which drive a real `AnnotatorStore` and need no page. What they cannot reach is
 * the half that lives in the canvas — `resolveTarget` reads the document the
 * machine is given, so hiding is only real if a press *over* a hidden shape
 * behaves as if the shape were not there. In jsdom every element is 0×0 and there
 * is no press to place.
 */

import { expect, test } from "@playwright/test";

import { SHOWCASE, drawBbox, expectCounts, focusCanvas, frameOf } from "./_frame";

/**
 * A bbox's grips — **eight**, four corners and four edges, which is
 * `BBOX_HANDLES`. `vertices()` in `_frame.ts` is the polygon's `[data-vertex]`.
 */
function grips(page: import("@playwright/test").Page) {
  return page.getByTestId("annotation-layer").locator("[data-handle]");
}

/**
 * Back to select mode.
 *
 * `drawBbox` leaves the `vehicle` class active, and while a *drawing* tool is
 * active the canvas draws — `tool.ts`'s flat rule, and v1's own guard minus the
 * escape hatch. A scenario about pressing a shape has to say so first.
 */
async function selectMode(page: import("@playwright/test").Page): Promise<void> {
  await focusCanvas(page);
  await page.keyboard.press("v");
}

test.beforeEach(async ({ page }) => {
  await page.goto(SHOWCASE);
});

test("the panel lists what is drawn, and the selection round-trips", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 520, y: 340 });

  await expect(page.getByTestId("object-count")).toHaveText("1 object");
  await expect(page.getByTestId("object-row-0")).toContainText("1. vehicle");
  // Drawn shapes arrive selected, so the row is already highlighted.
  await expect(page.getByTestId("object-row-0")).toHaveAttribute("data-selected", "true");

  // Canvas → row: a press on empty canvas clears the selection, and the row follows.
  await selectMode(page);
  await page.mouse.click(frame.at(900, 620).x, frame.at(900, 620).y);
  await expect(page.getByTestId("object-row-0")).toHaveAttribute("data-selected", "false");

  // Row → canvas: selecting from the panel puts the grips back on the shape.
  await page.getByTestId("object-select-0").click();
  await expect(page.getByTestId("object-row-0")).toHaveAttribute("data-selected", "true");
  await expect(grips(page)).toHaveCount(8);
});

/**
 * The acceptance criterion, and both halves of it.
 *
 * The press is aimed at the middle of the box. While it is visible that press
 * selects it; while it is hidden the same press must land on empty canvas — which
 * is only true because `AnnotatorCanvas` filters the document the machine hit
 * tests against, not merely the layer it draws.
 */
test("a hidden object neither renders nor hit-tests", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 520, y: 340 });
  const middle = frame.at(410, 270);

  // Visible: pressing the body selects it.
  await selectMode(page);
  await page.mouse.click(frame.at(900, 620).x, frame.at(900, 620).y);
  await expectCounts(page, 1, 0);
  await page.mouse.click(middle.x, middle.y);
  await expectCounts(page, 1, 1);

  await page.getByTestId("object-visibility-0").click();
  await expect(page.getByTestId("object-row-0")).toHaveAttribute("data-hidden", "true");

  // Not drawn: the committed layer has no shape left.
  await expect(page.getByTestId("annotation-layer").locator("g")).toHaveCount(0);

  // Not hit-tested: the same press now clears the selection instead of making one.
  await page.mouse.click(middle.x, middle.y);
  await expectCounts(page, 1, 0);

  // Still an object — hiding is a view decision, and the document did not move.
  await expect(page.getByTestId("object-count")).toHaveText("1 object");

  // And showing it again restores both halves.
  await page.getByTestId("object-visibility-0").click();
  await page.mouse.click(middle.x, middle.y);
  await expectCounts(page, 1, 1);
});

test("a panel delete is the keyboard's delete, and undo brings it back", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 520, y: 340 });

  await page.getByTestId("object-delete-0").click();
  await expectCounts(page, 0, 0);
  await expect(page.getByTestId("undo")).toContainText("delete 1 annotation");

  await focusCanvas(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expectCounts(page, 1, 1);
});

test("the Labels tab activates a class and toggles a tag, exactly as the digits do", async ({
  page,
}) => {
  await frameOf(page);
  await page.getByTestId("tab-labels").click();

  await page.getByTestId("label-lane").click();
  await expect(page.getByTestId("label-lane")).toHaveAttribute("data-active", "true");
  // One active class, two views of it: the demo's own palette agrees.
  await expect(page.getByTestId("class-lane")).toHaveAttribute("data-active", "true");

  // A tag is a command, not an active class — `classAction`'s split.
  await page.getByTestId("label-daytime").click();
  await expect(page.getByTestId("label-daytime")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("tag-daytime")).toBeChecked();
  await expect(page.getByTestId("label-lane")).toHaveAttribute("data-active", "true");
});

test("reassigning a class offers only the geometry's own, and lands as one history entry", async ({
  page,
}) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 520, y: 340 });

  await expect(page.getByTestId("editing-card")).toBeVisible();
  await expect(page.getByTestId("editing-geometry")).toHaveText("bbox");

  await page.getByTestId("reclass-select").click();
  await expect(page.getByRole("option", { name: "pedestrian" })).toBeVisible();
  // `lane` is a polygon and `centerline` a polyline: both are writes the API
  // refuses for a bbox, so neither is offered.
  await expect(page.getByRole("option", { name: "lane" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "centerline" })).toHaveCount(0);

  await page.getByRole("option", { name: "pedestrian" }).click();
  await page.getByTestId("reclass-apply").click();
  await expect(page.getByTestId("object-row-0")).toContainText("1. pedestrian");
  await expect(page.getByTestId("undo")).toContainText("edit pedestrian");
});
