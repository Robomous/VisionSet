/**
 * Engine behaviour with no path through the React adapter — found by this port, and
 * pinned here rather than left as a silent hole.
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
 * That is the adapter honouring `state.ts`'s written contract — while panning it
 * forwards nothing — and it is also correct for the overwhelmingly common case.
 * The cost is that two rows of the interaction table are unreachable in a browser:
 *
 * 1. `IDLE_ROW`'s secondary press on a vertex, which deletes it. v1's spelling.
 *    Reachable here through the toggle modifier instead, which `polygon.spec.ts`
 *    covers, so the *capability* is not lost — only v1's gesture for it.
 * 2. `DRAWING_POLYGON_ROW`'s secondary press, which takes back the last placed
 *    point and was v1's only undo of any kind while drawing. There is **no other
 *    spelling**, so this capability is genuinely unreachable from the demo today.
 *
 * Both are covered by the annotator's own vitest suite, which drives the machine
 * directly and therefore cannot notice that nothing calls it this way. That gap
 * between "the engine does it" and "a user can reach it" is exactly what an
 * end-to-end suite is for.
 *
 * These scenarios assert **what happens today**, deliberately. If a later change
 * routes a secondary press to the machine, they go red and say what to update —
 * which is the behaviour a pinned gap should have. Filed as **#129**, which sets out
 * the two defensible answers; see also `docs/annotations.md`.
 */

import { expect, test } from "@playwright/test";

import { canvasOrigin, drawTriangle, expectCounts, focusCanvas, frameOf, vertices } from "./_frame";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
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
test("a secondary press while drawing pans, and takes back no point", async ({ page }) => {
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

  // Both points survived: one more closes the polygon. Coordinates are re-read,
  // because the view moved under them.
  const moved = await frameOf(page);
  await page.mouse.click(moved.at(570, 470).x, moved.at(570, 470).y);
  await page.keyboard.press("Enter");

  await expectCounts(page, 1, 1);
  await expect(vertices(page)).toHaveCount(3);
});
