/**
 * The keyboard, which v1 had almost none of and this engine treats as a first-class
 * surface.
 *
 * v1 bound one key in a spec (`l` for the polyline tool) and could not even assert
 * it took effect, because its toolbar carried no `aria-pressed`. Here the binding
 * table is **data** — `DEFAULT_BINDINGS` plus `classHotkeys(schema)` — and the demo
 * renders it, so the shortcut sheet cannot go out of date with the shortcuts.
 *
 * What this file is really for is the half a unit test cannot reach. `bindings.test.ts`
 * proves a chord resolves to an action and `runAction.test.ts` proves the action runs;
 * neither can prove a browser delivers the keystroke to an element that still holds
 * focus, which is precisely the failure #47 shipped and then fixed.
 */

import { expect, test } from "@playwright/test";

import { drawBbox, expectCounts, focusCanvas, frameOf, wire } from "./_frame";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

/**
 * Digits bind to classes **by name**, in the schema's authored order, capped at
 * nine. The demo's five are chosen so the walk covers every branch the engine has,
 * which is what makes this one scenario worth more than five.
 */
test("the digits activate the schema's classes in authored order", async ({ page }) => {
  await frameOf(page);
  await focusCanvas(page);

  for (const [digit, className] of [
    ["1", "vehicle"],
    ["2", "lane"],
    ["4", "pedestrian"],
    ["5", "centerline"],
  ] as const) {
    await page.keyboard.press(digit);
    // The demo outlines the active class; the outline is the only thing that says
    // which one the canvas would draw with.
    await expect(page.getByTestId(`class-${className}`)).toHaveCSS(
      "outline-color",
      "rgb(143, 211, 244)",
    );
  }

  await page.keyboard.press("v");
  await expect(page.getByTestId("class-select")).toHaveCSS("outline-color", "rgb(143, 211, 244)");
});

/**
 * `centerline` is declared `polyline` — a nameable `GeometryType` with no `Geometry`
 * variant, which is #73's answer and the reason two of v1's four specs are out of
 * scope here. `toolFor` answers `select` for it, so activating it draws nothing.
 *
 * This is the closest honest port of `polyline-tool.spec.ts`'s premise: not the
 * behaviour it asserted, but the state that replaced it.
 */
test("a class whose geometry has no implementation draws nothing", async ({ page }) => {
  const frame = await frameOf(page);
  await focusCanvas(page);
  await page.keyboard.press("5");

  await page.mouse.move(frame.at(400, 240).x, frame.at(400, 240).y);
  await page.mouse.down();
  await page.mouse.move(frame.at(700, 440).x, frame.at(700, 440).y, { steps: 8 });
  await page.mouse.up();

  await expectCounts(page, 0, 0);
  await expect(page.getByTestId("undo")).toBeDisabled();
});

test("the undo and redo chords walk the history, and the buttons agree with them", async ({
  page,
}) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 500, y: 340 });
  await drawBbox(page, frame, { x: 700, y: 200 }, { x: 900, y: 340 });
  await expectCounts(page, 2, 1);

  await expect(page.getByTestId("undo")).toBeEnabled();
  await expect(page.getByTestId("redo")).toBeDisabled();

  await page.keyboard.press("ControlOrMeta+z");
  await expectCounts(page, 1, 0);
  await page.keyboard.press("ControlOrMeta+z");
  await expectCounts(page, 0, 0);
  await expect(page.getByTestId("undo")).toBeDisabled();

  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expectCounts(page, 1, 0);
  await expect(page.getByTestId("redo")).toBeEnabled();
});

/**
 * The buttons are the host's, the history is the engine's, and this is what proves
 * they are the same history rather than two that happen to agree.
 *
 * The click is on chrome **outside** the annotator, which also exercises the demo's
 * `keepFocus` guard: a button that stole focus would be a keyboard that stops
 * working after the first palette click.
 */
test("the history buttons drive the same log the chords do", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 500, y: 340 });

  await page.getByTestId("undo").click();
  await expectCounts(page, 0, 0);

  // `1 selected`, not `0`: selection is a set of ids held beside the document and
  // **filtered on read, never pruned on write**, so it survives the round trip with
  // no coordination — the annotation resolves again and is still selected. That is
  // the invariant, seen from a browser.
  await page.getByTestId("redo").click();
  await expectCounts(page, 1, 1);

  // Focus never left the canvas, so a chord still lands with no click in between.
  await page.keyboard.press("ControlOrMeta+z");
  await expectCounts(page, 0, 0);
});

test("select-all picks every annotation, and Delete removes them as one entry", async ({
  page,
}) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 500, y: 340 });
  await drawBbox(page, frame, { x: 700, y: 200 }, { x: 900, y: 340 });

  await page.keyboard.press("ControlOrMeta+a");
  await expectCounts(page, 2, 2);

  await page.keyboard.press("Delete");
  await expectCounts(page, 0, 0);
  await expect(page.getByTestId("undo")).toHaveText(/Undo delete 2 annotations/);

  // One entry, not two: a single undo brings both back.
  await page.keyboard.press("ControlOrMeta+z");
  await expectCounts(page, 2, 2);
});

/**
 * `?` is a **host** action. Core names no help sheet and enumerates no capability;
 * it forwards the name and the demo decides. The chord is claimed all the same, so
 * the browser never gets it.
 */
test("the help sheet is a host action, and its table is the binding table", async ({ page }) => {
  await frameOf(page);
  await focusCanvas(page);

  await expect(page.getByTestId("shortcuts")).toBeHidden();
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcuts")).toBeVisible();
  // Rendered from `DEFAULT_BINDINGS`, so the sheet cannot drift from the registry.
  await expect(page.getByTestId("shortcuts")).toContainText("mod+shift+z");
  await expect(page.getByTestId("shortcuts")).toContainText("delete-selection");

  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcuts")).toBeHidden();
});

/**
 * Typing in the notes field must not reach the canvas.
 *
 * Worth being precise about what this proves, because it is easy to read as more.
 * `notes` sits **outside** `annotator-root`, so its keystrokes never reach the
 * canvas handler at all, and moving focus there fires the root's `onBlur`, which
 * cancels a gesture in flight. The `isTextEntry` guard covers the *other* shape —
 * a text field nested inside a host's canvas chrome — which this demo does not
 * have; `keyboard.test.ts` in the annotator covers that one directly.
 */
test("typing in the notes field types, and draws nothing", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 500, y: 340 });
  await expectCounts(page, 1, 1);

  const notes = page.getByTestId("notes");
  await notes.click();
  // `pressSequentially`, not `fill`: the point is that real per-character key events
  // are dispatched. `fill` sets the value in one go and would fire none of them, so
  // the scenario would pass with the guard removed.
  await notes.pressSequentially("vvv1111 delete");

  await expect(notes).toHaveValue("vvv1111 delete");
  await expectCounts(page, 1, 1);
  expect(await wire(page)).toHaveLength(1);
});
