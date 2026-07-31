/**
 * The secondary press, and what #129 decided about it.
 *
 * This file was written by #48 as a pinned *gap*: two rows of the interaction table
 * that no browser could reach. #129 settled it — **the pan stays** — so the file is
 * now a pinned *decision*, and one of its two scenarios has grown the answer.
 *
 * `AnnotatorCanvas.handlePointerDown` answers **every** non-primary press with a pan
 * and returns before the machine is told anything:
 *
 * ```
 * if (button !== "primary") {
 *   if (interactionNow.current.type !== "idle") dispatch({ type: "pointer-cancel" });
 *   panNow.current = { x: event.clientX, y: event.clientY };
 *   event.currentTarget.setPointerCapture(event.pointerId);
 *   return;
 * }
 * ```
 *
 * ## Why the pan stays
 *
 * The alternative was to forward a secondary press to the machine and begin the pan
 * only when the machine did not consume it. Two things killed it:
 *
 * - **A conditional pan is unpredictable.** Right-drag would pan on empty canvas
 *   and not over a vertex, so whether the gesture works depends on where the
 *   vertices happen to be — which the user cannot see before pressing.
 * - **On macOS, ctrl-click *is* a secondary press.** The toggle modifier is
 *   `ctrl` or `meta`, so routing the secondary press would make one ctrl-click
 *   raise **both** spellings of the vertex delete. That is v1's own bug, and #44
 *   closed it deliberately: `machine.test.ts` still asserts the double gesture
 *   cannot throw.
 *
 * So the two rows stay unreachable *by that gesture*, and the question becomes what
 * each capability costs:
 *
 * 1. `IDLE_ROW`'s secondary press on a vertex costs **nothing**: the toggle
 *    modifier reaches the same call, and `polygon.spec.ts` covers it. Only v1's
 *    gesture is gone.
 * 2. `DRAWING_POLYGON_ROW`'s take-back had **no other spelling at all**, and
 *    `mod+z` cannot serve because a pending polygon is not in the command log. So
 *    #129 gave it one: **`Backspace`**, a `take-back-point` intent the machine
 *    answers only while drawing. The scenario below asserts both halves — the press
 *    still pans, and the keyboard does the work.
 *
 * The rest is still pinned behaviour: a change that routes a secondary press to the
 * machine turns these red and says what to update.
 */

import { expect, test } from "@playwright/test";

import { canvasOrigin, drawTriangle, expectCounts, focusCanvas, frameOf, vertices, SHOWCASE } from "./_frame";

test.beforeEach(async ({ page }) => {
  await page.goto(SHOWCASE);
});

/**
 * v1: a right-click on a vertex removes it. Here it pans, and the vertex stays.
 *
 * The polygon is a quadrilateral on purpose: on a triangle the removal would be
 * refused anyway (`MIN_POLYGON_POINTS`), so the scenario could not tell "the adapter
 * never asked" from "the engine said no". With four vertices the engine *would* say
 * yes, which is what makes the pan the whole explanation.
 */
test("a secondary press on a vertex pans instead of removing it", async ({ page }) => {
  const frame = await frameOf(page);
  await drawTriangle(page, frame, 500, 400, 80);
  await page.mouse.dblclick(frame.at(500, 480).x, frame.at(500, 480).y);
  await expect(vertices(page)).toHaveCount(4);

  const origin = await canvasOrigin(page);
  const at = frame.at(500, 480);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(at.x - 80, at.y - 60, { steps: 8 });
  await page.mouse.up({ button: "right" });

  // The positive barrier: the press became a pan.
  await expect
    .poll(async () => Math.round((await canvasOrigin(page)).x))
    .toBe(Math.round(origin.x - 80));
  // …and therefore the vertex is still there.
  await expect(vertices(page)).toHaveCount(4);
  await expectCounts(page, 1, 1);
});

/**
 * v1: a right-click while drawing takes back the last point. Here it pans, and the
 * pending polygon keeps every point it had — the third click still closes it.
 *
 * Note what the adapter *does* do first: a gesture in flight is cancelled with
 * `pointer-cancel` before the pan begins. A `drawing-polygon` session survives that
 * deliberately (`machine.ts` omits the row), which is why the polygon below still
 * completes rather than vanishing.
 */
test("a secondary press while drawing pans, and Backspace is what takes a point back", async ({
  page,
}) => {
  const frame = await frameOf(page);
  await focusCanvas(page);
  await page.keyboard.press("2");

  await page.mouse.click(frame.at(500, 330).x, frame.at(500, 330).y);
  await page.mouse.click(frame.at(430, 470).x, frame.at(430, 470).y);

  const origin = await canvasOrigin(page);
  const at = frame.at(430, 470);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(at.x - 60, at.y - 40, { steps: 8 });
  await page.mouse.up({ button: "right" });

  await expect
    .poll(async () => Math.round((await canvasOrigin(page)).x))
    .toBe(Math.round(origin.x - 60));

  // Both points survived the pan, which is the pinned half.
  //
  // Now #129's answer: `Backspace` takes the second one back, so the ring is one
  // point again — and the shape below is drawn from a *different* second point,
  // which is what proves the take-back happened rather than being ignored.
  await focusCanvas(page);
  await page.keyboard.press("Backspace");

  const moved = await frameOf(page);
  await page.mouse.click(moved.at(560, 330).x, moved.at(560, 330).y);
  await page.mouse.click(moved.at(570, 470).x, moved.at(570, 470).y);
  await page.keyboard.press("Enter");

  await expectCounts(page, 1, 1);
  await expect(vertices(page)).toHaveCount(3);
});
