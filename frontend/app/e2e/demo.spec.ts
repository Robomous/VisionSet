/**
 * The demo page itself: the one scenario of v1's `annotation-redesign.spec.ts` that
 * survives the port, plus the view controls no v1 spec covered.
 *
 * ## Why only one of six survives
 *
 * v1's `annotation-redesign.spec.ts` (129 LOC) is six tests, and five of them are
 * about v1's *routing and chrome*: a project tab listing upload batches, an
 * `Annotate` link to a fullscreen route, an `AppSidebar`, an image-picker dialog and
 * a back button. This page has none of that — it is `<AnnotatorDemo/>` on one route,
 * with no backend and no auth. Those five describe a product surface M5 builds, not
 * a behaviour that moved, so they are recorded as out of scope rather than dropped
 * quietly. The application has a router and a rail; the showcase is a leaf
 * outside the token gate, so the five belong to the cycle suite instead.
 *
 * The sixth — *"no console errors on annotation route"* — ports directly, and is
 * worth more here than it was there. `StrictMode` double-invokes effects, and
 * `eslint-plugin-react-hooks` is a lint gate that cannot see a hook-order violation
 * at runtime. It is also strengthened: v1 tolerated every console error that was not
 * React-shaped, because its page really did 404 for things. This page fetches
 * nothing, so it can be held to *no uncaught exception at all*.
 */

import { expect, test } from "@playwright/test";

import {
  canvasOrigin,
  drawBbox,
  expectCounts,
  focusCanvas,
  frameOf,
  SHOWCASE,
  zoomWheel,
} from "./_frame";

test.beforeEach(async ({ page }) => {
  await page.goto(SHOWCASE);
});

test("a full editing session raises no console error and no uncaught exception", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const crashes: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => crashes.push(error.message));

  await page.reload();
  const frame = await frameOf(page);

  // Not an idle page: walk every tool the engine has, plus undo and redo.
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 520, y: 340 });
  await focusCanvas(page);
  await page.keyboard.press("2");
  for (const [x, y] of [
    [700, 300],
    [640, 440],
    [780, 440],
  ] as const) {
    await page.mouse.click(frame.at(x, y).x, frame.at(x, y).y);
  }
  await page.keyboard.press("Enter");
  await page.getByTestId("tag-daytime").click();
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expectCounts(page, 3, 1);

  expect(crashes).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

/**
 * The palette is host chrome, and clicking it reaches the machine by a different
 * road than a hotkey: `AnnotatorCanvas` bridges a class change through a
 * `tool-changed` **effect**, one tick later, where `runAction` dispatches
 * synchronously. Every other spec here uses digits for that reason, so this is the
 * one that holds the click path.
 */
test("the palette activates a tool by click, not only by hotkey", async ({ page }) => {
  const frame = await frameOf(page);

  await page.getByTestId("class-vehicle").click();
  await page.mouse.move(frame.at(400, 240).x, frame.at(400, 240).y);
  await page.mouse.down();
  await page.mouse.move(frame.at(650, 420).x, frame.at(650, 420).y, { steps: 8 });
  await page.mouse.up();
  await expectCounts(page, 1, 1);

  // …and back to select, which must not draw. The selection is deliberately still
  // 1 afterwards: there is no marquee here, so a press on empty canvas that
  // *travels* leaves the selection untouched — only a press that stays put clears
  // it, which is the row `machine.ts` calls "idle; selection untouched".
  await page.getByTestId("class-select").click();
  await page.mouse.move(frame.at(200, 550).x, frame.at(200, 550).y);
  await page.mouse.down();
  await page.mouse.move(frame.at(320, 640).x, frame.at(320, 640).y, { steps: 8 });
  await page.mouse.up();
  await expectCounts(page, 1, 1);

  // The press that does clear it.
  await page.mouse.click(frame.at(200, 550).x, frame.at(200, 550).y);
  await expectCounts(page, 1, 0);
});

/**
 * The wheel is the one handler that is not a JSX prop: React attaches `wheel`
 * **passively** at its root container, so `onWheel` plus `preventDefault()` silently
 * does nothing and the page scrolls instead of the image zooming. The adapter
 * registers an imperative non-passive listener instead, and this is what proves the
 * registration is still there — a regression to `onWheel` would leave the zoom flat.
 */
test("the wheel zooms the stage, and mod+0 puts it back", async ({ page }) => {
  const frame = await frameOf(page);
  const fitted = frame.zoom;

  await zoomWheel(page, frame.at(640, 360), -240);

  const zoomed = await frameOf(page);
  expect(zoomed.zoom).toBeGreaterThan(fitted);

  await focusCanvas(page);
  await page.keyboard.press("ControlOrMeta+0");

  const refitted = await frameOf(page);
  expect(refitted.zoom).toBeCloseTo(fitted, 3);
});

/**
 * `mod+0` is **intercepted** rather than forwarded — the zoom is the adapter's, and
 * the one `InputHost` row that is not a pass-through. A pan proves the reset is a
 * whole viewport rather than a scale alone.
 */
test("mod+0 recentres a panned view, not just its scale", async ({ page }) => {
  const frame = await frameOf(page);
  const origin = await canvasOrigin(page);

  const from = frame.at(640, 360);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(from.x - 150, from.y - 100, { steps: 8 });
  await page.mouse.up({ button: "right" });

  await expect.poll(async () => Math.round((await canvasOrigin(page)).x)).toBe(
    Math.round(origin.x - 150),
  );

  await focusCanvas(page);
  await page.keyboard.press("ControlOrMeta+0");

  await expect.poll(async () => Math.round((await canvasOrigin(page)).x)).toBe(
    Math.round(origin.x),
  );
  expect(Math.round((await canvasOrigin(page)).y)).toBe(Math.round(origin.y));
});

/**
 * A bare **mouse** wheel zooms, where a bare trackpad scroll pans.
 *
 * The two devices want opposite things from the same event, and #576 gave the
 * whole of it to the trackpad — which is what a laptop needed and what took the
 * mouse's zoom away. `isMouseWheel` splits them, and what a browser driven by
 * Chromium's own input can prove is only this half: **CDP's synthetic wheel
 * reports `wheelDeltaY` as ±120 whatever `deltaY` says** — measured, 7 and 12
 * and 40 all arrive as -120 — so a trackpad's *vertical* scroll has no spelling
 * here at all. The scenario below is the sideways one, which does, and the rest
 * of the predicate is unit-tested in `viewport.test.ts`.
 *
 * Both assertions matter and neither alone would do: a pan also moves the
 * `<svg>`'s origin, so "it moved" is satisfied either way. The zoom having
 * *changed* is the half that says this was a zoom.
 */
test("a bare mouse wheel zooms the stage", async ({ page }) => {
  const frame = await frameOf(page);
  const origin = await canvasOrigin(page);

  const at = frame.at(640, 360);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -120);

  await expect.poll(async () => (await frameOf(page)).zoom).toBeGreaterThan(frame.zoom);
  expect(Math.round((await canvasOrigin(page)).y)).not.toBe(Math.round(origin.y));
});

/**
 * `deltaX` too: a trackpad scrolls sideways, a wheel does not, and this is the
 * one gesture that is a pan on both sides of the device test — sideways travel
 * is what `isMouseWheel` reads as two fingers however notch-shaped the rest of
 * the event looks. A pan that ignored the axis would also be half a pan.
 */
test("a bare sideways scroll pans and leaves the zoom alone", async ({ page }) => {
  const frame = await frameOf(page);
  const origin = await canvasOrigin(page);

  const at = frame.at(640, 360);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(-90, 0);

  await expect.poll(async () => Math.round((await canvasOrigin(page)).x)).toBe(
    Math.round(origin.x + 90),
  );
  expect(Math.round((await canvasOrigin(page)).y)).toBe(Math.round(origin.y));
  expect((await frameOf(page)).zoom).toBeCloseTo(frame.zoom, 3);
});

/**
 * `Space` held is the hand, and it is the spelling that needs no host at all.
 *
 * It cannot be a registry row — a keystroke is a press and this is a hold — so it
 * is an adapter substitution, and the release is as much a part of it as the
 * press. The second drag is what proves the release: without it a scenario
 * asserting only that the pan happened would pass with the mode stuck on
 * forever, which is the failure a held key actually has.
 */
test("holding space turns a primary drag into a pan, and letting go gives it back", async ({
  page,
}) => {
  const frame = await frameOf(page);
  await focusCanvas(page);
  const origin = await canvasOrigin(page);

  const from = frame.at(640, 360);
  await page.keyboard.down(" ");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 120, from.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up(" ");

  await expect.poll(async () => Math.round((await canvasOrigin(page)).x)).toBe(
    Math.round(origin.x - 120),
  );
  // Nothing was drawn: the press never reached the machine.
  await expectCounts(page, 0, 0);

  // And with the key up, the same drag draws again — the mode was transient.
  await drawBbox(page, frame, { x: 100, y: 100 }, { x: 300, y: 260 });
  await expectCounts(page, 1, 1);
});
