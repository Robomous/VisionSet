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

test("the tag strip toggles a whole-asset tag, and the demo's own checkbox agrees", async ({
  page,
}) => {
  await frameOf(page);

  // A tag is a command, not an active class — `classAction`'s split, and the
  // strip is the only surface that offers one: it is not a shape, so no
  // tool and no canvas gesture reaches it.
  await page.getByTestId("tag-chip-daytime").click();
  await expect(page.getByTestId("tag-chip-daytime")).toHaveAttribute("data-active", "true");
  // One document, two views of it: the demo's own checkbox reads the same store.
  await expect(page.getByTestId("tag-daytime")).toBeChecked();
  // …and it is an annotation like any other, so it shows up in the list.
  await expect(page.getByTestId("object-count")).toHaveText("1 object");

  await page.getByTestId("tag-chip-daytime").click();
  await expect(page.getByTestId("tag-chip-daytime")).toHaveAttribute("data-active", "false");
  await expect(page.getByTestId("tag-daytime")).not.toBeChecked();
});

test("reassigning a class refuses the wrong geometry and says why, in one history entry", async ({
  page,
}) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 520, y: 340 });

  await page.getByTestId("object-reclass-0").click();

  // `lane` is a polygon and `centerline` a polyline: both are writes the API
  // refuses for a bbox. They are listed anyway, disabled and carrying the reason —
  // a short list with no explanation reads as a schema missing its classes.
  await expect(page.getByTestId("reclass-0-lane")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("reclass-0-lane")).toContainText("needs a polygon");
  await expect(page.getByTestId("reclass-0-centerline")).toHaveAttribute("aria-disabled", "true");

  await page.getByTestId("reclass-0-pedestrian").click();
  await expect(page.getByTestId("object-row-0")).toContainText("1. pedestrian");
  await expect(page.getByTestId("undo")).toContainText("edit pedestrian");
});

test("the object filter narrows the list without renumbering it", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 460, y: 320 });
  await drawBbox(page, frame, { x: 600, y: 200 }, { x: 760, y: 320 });

  await page.getByTestId("object-reclass-1").click();
  await page.getByTestId("reclass-1-pedestrian").click();
  await expect(page.getByTestId("object-row-1")).toContainText("2. pedestrian");

  await page.getByTestId("object-filter").fill("pedestrian");
  await expect(page.getByTestId("object-row-0")).toHaveCount(0);
  // Still "2.": the number is the object's identity on the canvas, so filtering
  // must not renumber it out from under the picture.
  await expect(page.getByTestId("object-row-1")).toContainText("2. pedestrian");
  // The count stays the whole document's.
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");
});
