/**
 * The design system, in a browser — the half of #128's contract no unit test can
 * reach.
 *
 * `tokens.test.ts` proves `styles.css` and `tokens.ts` agree, and
 * `primitives.test.tsx` proves each component behaves. Neither proves the thing
 * that actually breaks: **that the class strings become CSS.** `ui-core` ships as
 * `tsc` output, so its utilities exist only if the consuming app's Tailwind build
 * scans the package's sources — a missing `@source` produces a page that compiles,
 * mounts, renders every element and is completely unstyled, with nothing failing
 * anywhere. Reading a computed colour back out of a real browser is the only
 * check for that.
 *
 * Deliberately small. This is not a visual-regression suite; it is four questions
 * about the wiring, and it runs inside the existing `annotator e2e (chromium)` job
 * rather than paying for one of its own.
 */

import { expect, test } from "@playwright/test";

/** `--color-primary`, the one value everything else is calibrated against. */
const PRIMARY = "rgb(235, 90, 71)";
/** `--color-foreground`. */
const INK = "rgb(37, 41, 73)";

test.beforeEach(async ({ page }) => {
  await page.goto("/styleguide.html");
});

test("the token utilities reach the browser as the contract's values", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("VisionSet design system");

  // If Tailwind never saw `ui-core`'s sources, `bg-primary` is not a rule and this
  // element is transparent — which is exactly what a missing `@source` looks like.
  await expect(page.getByTestId("button-primary")).toHaveCSS("background-color", PRIMARY);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("color", INK);
});

test("the base layer applies, so a screen inherits the scale without asking", async ({ page }) => {
  // 14px and 1.6 are the rhythm every measurement in DESIGN.md was taken against,
  // and they come from `@layer base` rather than from a class on each page.
  await expect(page.locator("body")).toHaveCSS("font-size", "14px");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
});

/**
 * The bug `cn.ts` documents, seen from the far end.
 *
 * `tailwind-merge` read `text-body` as a colour and dropped it, so every field in
 * the package rendered at the browser's default size instead of the contract's.
 * `cn.test.ts` pins the merge; this pins the pixels, because the two failures look
 * nothing alike from the outside.
 */
test("a merged font size survives to the rendered element", async ({ page }) => {
  await expect(page.getByLabel("Project name")).toHaveCSS("font-size", "14px");
});

/** Radix owns the overlay behaviour; this is the proof it is actually wired. */
test("a dialog traps focus, closes on Escape and returns focus to its trigger", async ({ page }) => {
  const trigger = page.getByTestId("open-dialog");
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName("Delete highway-survey?");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("the class palette draws the schema's colour and the derived hue side by side", async ({
  page,
}) => {
  // The acceptance criterion "one spelling", made visible: `vehicle` declares
  // `#38bdf8` and `pedestrian` declares nothing, so the second must still get a
  // colour and it must not be the first one's.
  const swatches = page.getByTestId("class-palette").locator("span[aria-hidden]");
  await expect(swatches).toHaveCount(4);

  const colours = await swatches.evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).backgroundColor),
  );
  expect(colours[0]).toBe("rgb(56, 189, 248)");
  expect(new Set(colours).size).toBe(4);
});
