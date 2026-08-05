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

import {
  SHOWCASE,
  drawBbox,
  expectCounts,
  focusCanvas,
  frameOf,
  vertices,
  wire,
} from "./_frame";

test.beforeEach(async ({ page }) => {
  await page.goto(SHOWCASE);
});

/**
 * Digits bind to classes **by name**, in the schema's authored order, capped at
 * nine. The demo's five are chosen so the walk covers every branch the engine has,
 * which is what makes this one scenario worth more than five.
 */
test("the digits activate the schema's classes in authored order", async ({ page }) => {
  await frameOf(page);
  await focusCanvas(page);

  // Every row the palette draws, so "this one is active" can be checked against
  // "and no other one is" — which is the claim, and which an assertion on the
  // active row alone cannot make.
  const rows = ["select", "vehicle", "lane", "daytime", "pedestrian", "centerline"] as const;

  for (const [digit, className] of [
    ["1", "vehicle"],
    ["2", "lane"],
    ["4", "pedestrian"],
    ["5", "centerline"],
    ["v", "select"],
  ] as const) {
    await page.keyboard.press(digit);
    // `data-active`, not the row's colour. #50 moved the palette onto `DESIGN.md`'s
    // tokens, where a selected row is `border-primary` plus the accent at 10% — so
    // an assertion on a literal `rgb(...)` was pinning the design system rather than
    // the behaviour, and would have to be re-pinned by every restyle.
    for (const row of rows) {
      await expect(page.getByTestId(`class-${row}`)).toHaveAttribute(
        "data-active",
        row === className ? "true" : "false",
      );
    }
  }
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

  // #123 claimed `mod+c`/`mod+v`, which makes this the chord a user is most
  // likely to press inside a field — and the browser has to keep it, or copying
  // a note out of the panel would silently duplicate a box instead.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
  await expectCounts(page, 1, 1);
  expect(await wire(page)).toHaveLength(1);
});

/**
 * Copy and paste (#123), which the engine deferred and left to the browser until
 * the founder settled what a clipboard is.
 *
 * The offset is the part only a browser can check: `PASTE_OFFSET_PX` is **20
 * screen pixels**, converted to asset pixels by dividing by the live zoom — so
 * the number the document ends up carrying depends on a fit this page computed
 * from its own pane, which is exactly what a unit test cannot supply.
 */
test("copy and paste duplicates the selection, offset and selected", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 500, y: 340 });
  await expectCounts(page, 1, 1);

  await page.keyboard.press("ControlOrMeta+c");
  // A copy is a read: nothing is added and nothing is selected differently.
  await expectCounts(page, 1, 1);

  await page.keyboard.press("ControlOrMeta+v");
  // The copy exists, and **it** is what is selected — so the next drag moves the
  // duplicate rather than the original.
  await expectCounts(page, 2, 1);

  const drawn = await wire(page);
  expect(drawn).toHaveLength(2);
  const source = drawn[0].geometry as { x: number; y: number };
  const copy = drawn[1].geometry as { x: number; y: number };
  // 20 screen pixels, in asset pixels at this page's own fit zoom.
  const expected = 20 / frame.zoom;
  expect(copy.x - source.x).toBeCloseTo(expected, 5);
  expect(copy.y - source.y).toBeCloseTo(expected, 5);

  // One history entry for the whole paste.
  await page.keyboard.press("ControlOrMeta+z");
  await expectCounts(page, 1, 0);
});

test("a second paste steps further out rather than stacking on the first", async ({ page }) => {
  // Two presses of `mod+v` landing on one spot would put two annotations under
  // one visible shape — a dataset with a duplicate in it and nothing on screen
  // saying so. The rule reads the document rather than counting presses, which is
  // what makes the undo below restore the slot it took.
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 500, y: 340 });
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
  await page.keyboard.press("ControlOrMeta+v");
  await expectCounts(page, 3, 1);

  const drawn = await wire(page);
  const xs = drawn.map((one) => (one.geometry as { x: number }).x);
  const step = 20 / frame.zoom;
  expect(xs[1] - xs[0]).toBeCloseTo(step, 5);
  expect(xs[2] - xs[0]).toBeCloseTo(step * 2, 5);
});

test("paste with nothing copied does nothing at all", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 500, y: 340 });
  await expectCounts(page, 1, 1);

  await page.keyboard.press("ControlOrMeta+v");
  await expectCounts(page, 1, 1);
  // Nothing to undo but the box itself, so the paste recorded no entry.
  await expect(page.getByTestId("undo")).toHaveText(/Undo add vehicle/);
});

/**
 * #129 split the two delete chords, and this is the behaviour change a user sees.
 *
 * They used to mean one thing, so one of them was free — and `Backspace` takes back
 * *the last thing you did*, which is what it means in every text field and every
 * drawing tool. It bought a capability that had no spelling at all: v1 took a
 * polygon point back with a right-click, and the React adapter answers every
 * non-primary press with a pan.
 *
 * What it costs is a synonym, and the pair below is the proof that it is only that.
 */
test("Delete removes the selection and Backspace no longer does", async ({ page }) => {
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 520, y: 340 });
  await expectCounts(page, 1, 1);

  // Silent: outside `drawing-polygon` the take-back intent is a square no row
  // fills, which `machine.ts`'s partial rows make automatic.
  await page.keyboard.press("Backspace");
  await expectCounts(page, 1, 1);

  await page.keyboard.press("Delete");
  await expectCounts(page, 0, 0);
});

/** And while drawing, it is the take-back — which is the whole point of the swap. */
test("Backspace takes back the last polygon point, and the ring survives", async ({ page }) => {
  const frame = await frameOf(page);
  await focusCanvas(page);
  await page.keyboard.press("2");

  for (const [x, y] of [
    [500, 300],
    [420, 440],
    [640, 300],
  ] as const) {
    await page.mouse.click(frame.at(x, y).x, frame.at(x, y).y);
  }
  // Take the third back, then place a different one and close. Three vertices
  // rather than four is what says the take-back happened.
  await page.keyboard.press("Backspace");
  await page.mouse.click(frame.at(580, 440).x, frame.at(580, 440).y);
  await page.keyboard.press("Enter");

  await expectCounts(page, 1, 1);
  await expect(vertices(page)).toHaveCount(3);
});

/** Taking the only point back ends the session rather than leaving an empty one. */
test("Backspace on a one-point ring returns to idle, and the next press starts fresh", async ({
  page,
}) => {
  const frame = await frameOf(page);
  await focusCanvas(page);
  await page.keyboard.press("2");

  await page.mouse.click(frame.at(500, 300).x, frame.at(500, 300).y);
  await page.keyboard.press("Backspace");

  // A fresh session: three clicks and Enter, not two — if the first point had
  // survived, this would close a quadrilateral.
  for (const [x, y] of [
    [420, 440],
    [640, 300],
    [640, 440],
  ] as const) {
    await page.mouse.click(frame.at(x, y).x, frame.at(x, y).y);
  }
  await page.keyboard.press("Enter");

  await expectCounts(page, 1, 1);
  await expect(vertices(page)).toHaveCount(3);
});
