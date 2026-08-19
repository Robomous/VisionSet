/**
 * The chrome that makes the demo a showcase: the floating tool strip and
 * the zoom readout.
 *
 * Both are host UI, so nothing here is about the engine — every one of these
 * scenarios would still pass with a different renderer underneath. What they hold
 * is the two claims the chrome makes that are easy to get wrong and invisible when
 * they are: that a **tool button over a derived tool** does not quietly rewrite the
 * active class, and that the **zoom readout is the stage's own scale** rather than
 * a number the host is keeping in parallel.
 *
 * The second is the one worth the file. `onViewChange` is the annotator prop this
 * task added, and there is no jsdom in this repository — the adapter chose pure functions
 * over component tests precisely because `getBoundingClientRect` returns zeros
 * there — so a browser is the only place its mount-time call can be observed at
 * all. A readout stuck at `100%` is exactly what a missing mount call looks like.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  expectCounts,
  expectFitted,
  focusCanvas,
  frameOf,
  SHOWCASE,
  zoomWheel,
} from "./_frame";

test.beforeEach(async ({ page }) => {
  await page.goto(SHOWCASE);
});

/**
 * The strip's claims about `toolFor`, in one walk: the schema decides the
 * buttons, a hotkey moves the strip because it reports the derived tool, and a
 * press on the already-lit tool leaves the active class alone.
 */
test("the strip lists the schema's tools, follows the hotkeys, and never rewrites the class", async ({
  page,
}) => {
  await frameOf(page);

  await expect(page.getByTestId("tool-select")).toBeVisible();
  await expect(page.getByTestId("tool-bbox")).toBeVisible();
  await expect(page.getByTestId("tool-polygon")).toBeVisible();
  // `centerline` is a polyline and has a tool.
  await expect(page.getByTestId("tool-polyline")).toBeVisible();
  // `daytime` is a tag and `pose` is keypoints: `drawableGeometry` answers `null`
  // for both, so neither gets a canvas tool. The demo's schema declares them so
  // that this omission is a visible fact rather than an untested claim.
  await expect(page.getByTestId("tool-classification_tag")).toHaveCount(0);
  await expect(page.getByTestId("tool-keypoints")).toHaveCount(0);

  await expect(page.getByTestId("tool-select")).toHaveAttribute("data-active", "true");

  // A hotkey moves the strip, because the strip reports the derived tool.
  await focusCanvas(page);
  for (const [digit, active] of [
    ["1", "tool-bbox"],
    ["2", "tool-polygon"],
    // A *second* bbox class. The class moved; the tool did not, so the strip does
    // not either — which is the whole reason it reads `toolFor` rather than the
    // class name.
    ["4", "tool-bbox"],
    // `centerline` is a polyline and has a tool. Digit 6 is `pose`,
    // which is keypoints — declared, drawable by nothing, so the strip stays on
    // select and offers no button for it at all.
    ["5", "tool-polyline"],
    ["6", "tool-select"],
    ["v", "tool-select"],
  ] as const) {
    await page.keyboard.press(digit);
    for (const tool of ["tool-select", "tool-bbox", "tool-polygon", "tool-polyline"] as const) {
      await expect(page.getByTestId(tool)).toHaveAttribute(
        "data-active",
        tool === active ? "true" : "false",
      );
    }
  }

  // The consequence of putting a tool button over a store that has no tool: with
  // a second bbox class held, the box button is already lit, and re-pointing the
  // class at the *first* bbox class would silently change what the next shape is
  // labelled. The tool did not move, so nothing moves.
  await page.keyboard.press("4");
  await expect(page.getByTestId("class-pedestrian")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("tool-bbox")).toHaveAttribute("data-active", "true");

  await page.getByTestId("tool-bbox").click();

  await expect(page.getByTestId("class-pedestrian")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("class-vehicle")).toHaveAttribute("data-active", "false");
});

/** The strip draws, and it draws with the class the tool button stands for. */
test("the strip activates a tool by click and the canvas draws with it", async ({ page }) => {
  const frame = await frameOf(page);

  await page.getByTestId("tool-bbox").click();
  await expect(page.getByTestId("class-vehicle")).toHaveAttribute("data-active", "true");

  await page.mouse.move(frame.at(400, 240).x, frame.at(400, 240).y);
  await page.mouse.down();
  await page.mouse.move(frame.at(650, 420).x, frame.at(650, 420).y, { steps: 8 });
  await page.mouse.up();
  await expectCounts(page, 1, 1);
});

/**
 * The readout is the stage's scale, measured against the same bounding box
 * `_frame.ts` derives every coordinate from.
 *
 * The mount value is the load-bearing half. `AnnotatorCanvas` fits the asset in a
 * `useLayoutEffect` against a pane rect no host can measure, so a host that was
 * never told would have to display `1` — and 100% is the one number the fit is
 * guaranteed not to be.
 */
test("the zoom readout reports the fit, follows the wheel and comes back on mod+0", async ({
  page,
}) => {
  const frame = await frameOf(page);
  expectFitted(frame);
  await expectReadout(page, frame.zoom);

  await zoomWheel(page, frame.at(640, 360), -240);

  const zoomed = await frameOf(page);
  expect(zoomed.zoom).toBeGreaterThan(frame.zoom);
  await expectReadout(page, zoomed.zoom);

  await focusCanvas(page);
  await page.keyboard.press("ControlOrMeta+0");
  await expectReadout(page, frame.zoom);
});

/**
 * The readout must never eat a press. Its corner of the image is annotatable like
 * any other, and this suite's coordinates are in *asset* pixels — they cannot see
 * where a badge landed, so a swallowed press would surface as an unrelated
 * scenario missing a target.
 */
test("the zoom readout is not a pointer target", async ({ page }) => {
  await frameOf(page);
  const badge = page.getByTestId("zoom-readout");
  await expect(badge).toHaveCSS("pointer-events", "none");

  const box = await badge.boundingBox();
  if (box === null) throw new Error("zoom-readout has no bounding box");

  // The behavioural half, and the reason the CSS assertion above is not the whole
  // test: `handlePointerDown`'s first act is to focus the root. Nothing is focused
  // on load, so a press that reaches the stage is observable without drawing
  // anything — which matters here, because the badge sits in the pane's corner and
  // may be off the asset entirely.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("annotator-root")).toBeFocused();
});

/** The help button is the pointer road to the sheet `?` opens. */
test("the strip's help button opens and closes the shortcut sheet", async ({ page }) => {
  await frameOf(page);

  await expect(page.getByTestId("shortcuts")).toHaveCount(0);
  await page.getByTestId("tool-help").click();
  await expect(page.getByTestId("shortcuts")).toBeVisible();

  await page.getByTestId("shortcuts-close").click();
  await expect(page.getByTestId("shortcuts")).toHaveCount(0);

  // `?` still reaches it — the button is a second road, not a replacement.
  await focusCanvas(page);
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcuts")).toBeVisible();
});

/**
 * A percent is one rounding away from the measured scale.
 *
 * The slack is one point, not zero: the readout rounds the adapter's own float and
 * the measurement rounds a bounding box read back through the DOM, so the two can
 * land either side of a `.5` without anything being wrong.
 */
async function expectReadout(page: Page, zoom: number): Promise<void> {
  const expected = Math.round(zoom * 100);
  await expect
    .poll(async () => {
      const text = (await page.getByTestId("zoom-readout").textContent()) ?? "";
      return Math.abs(Number.parseInt(text, 10) - expected);
    })
    .toBeLessThanOrEqual(1);
}
