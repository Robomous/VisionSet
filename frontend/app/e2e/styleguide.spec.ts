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

/** `--color-primary`, the near-black everything else is calibrated against. */
const PRIMARY = "rgb(30, 33, 48)";
/** `--color-brand` — Robomous coral, and it belongs to two elements (#323). */
const BRAND = "rgb(232, 93, 68)";
/** `--color-foreground`. */
const INK = "rgb(27, 29, 40)";
/** `--color-muted` — the hover and focus fill. */
const MUTED = "rgb(243, 244, 246)";
/** `--color-background` — the page, which is no longer the same white as a card. */
const PAGE = "rgb(250, 250, 251)";
/** `--color-ring` — the action colour at 35%, not the action colour. */
const RING = "rgba(30, 33, 48, 0.35)";
/** What a computed colour reads as when nothing painted: no fill, no border. */
const NOTHING = "rgba(0, 0, 0, 0)";

test.beforeEach(async ({ page }) => {
  await page.goto("/styleguide");
});

test("the token utilities reach the browser as the contract's values", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("VisionSet design system");

  // If Tailwind never saw `ui-core`'s sources, `bg-primary` is not a rule and this
  // element is transparent — which is exactly what a missing `@source` looks like.
  await expect(page.getByTestId("button-primary")).toHaveCSS("background-color", PRIMARY);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("color", INK);
});

/**
 * #323's actual claim, and the only place a browser can check it.
 *
 * The palette's whole argument is that the brand is *not* what a button is made
 * of. `tokens.test.ts` can assert the two hexes differ; only a rendered page can
 * assert that the button and the progress bar ended up wearing the right one of
 * them. A revert that pointed `--color-primary` back at the coral would satisfy
 * every unit test in the repository and fail here.
 */
test("the brand is on the progress bar and nowhere near the primary button", async ({ page }) => {
  const filled = page.getByTestId("button-primary");
  await expect(filled).toHaveCSS("background-color", PRIMARY);
  await expect(filled).not.toHaveCSS("background-color", BRAND);

  // Radix's indicator is the fill inside the track; the track itself is `muted`.
  const bar = page.getByRole("progressbar").first();
  await expect(bar).toHaveCSS("background-color", MUTED);
  await expect(bar.locator("> *").first()).toHaveCSS("background-color", BRAND);
});

test("the base layer applies, so a screen inherits the scale without asking", async ({ page }) => {
  // 14px and 1.6 are the rhythm every measurement in DESIGN.md was taken against,
  // and they come from `@layer base` rather than from a class on each page.
  await expect(page.locator("body")).toHaveCSS("font-size", "14px");
  await expect(page.locator("body")).toHaveCSS("background-color", PAGE);
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

/**
 * #182's actual claim, which is a claim about pixels.
 *
 * `primitives.test.tsx` asserts the *meaning* — `aria-selected`, `data-state`, one
 * panel in the tree — and deliberately matches no class string, so it would stay
 * green through a restyle that made all three tabs look identical. The difference
 * between an active tab and an inactive one is a computed colour, and jsdom
 * computes nothing from a stylesheet. This is where that is checked.
 */
test("the active tab wears the accent rule and an inactive one wears no chrome", async ({
  page,
}) => {
  const bar = page.getByTestId("tabs-underline");
  const open = bar.getByRole("tab", { name: "Batches" });
  const shut = bar.getByRole("tab", { name: "About" });

  await expect(open).toHaveCSS("border-bottom-color", PRIMARY);
  // The report's complaint, inverted into an assertion: no fill, no border, no
  // shadow. An inactive tab must not read as a button somebody has not pressed.
  await expect(shut).toHaveCSS("border-bottom-color", NOTHING);
  await expect(shut).toHaveCSS("background-color", NOTHING);
  await expect(shut).toHaveCSS("box-shadow", "none");

  await shut.click();
  await expect(shut).toHaveCSS("border-bottom-color", PRIMARY);
  await expect(open).toHaveCSS("border-bottom-color", NOTHING);
});

test("the segmented variant still ships, for the 288px panel it exists for", async ({ page }) => {
  const panel = page.getByTestId("tabs-segmented");
  // Raised onto `card` inside a `muted` list — the shape a two-way switch wants,
  // and the one the page's section bar no longer uses.
  await expect(panel.getByRole("tab", { name: "Objects" })).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(panel.getByRole("tab", { name: "Labels" })).toHaveCSS("background-color", NOTHING);
});

test("focus is visible on a tab that has no fill to draw it against", async ({ page }) => {
  // Arrive by keyboard, because `:focus-visible` is the point — and from the last
  // focusable before the bar, so this is one press rather than a hunt.
  await page.getByLabel("Description").focus();
  await page.keyboard.press("Tab");

  const focused = page.getByTestId("tabs-underline").getByRole("tab", { name: "Batches" });
  await expect(focused).toBeFocused();
  // The ring comes from `styles.css`'s base layer and is drawn *outside* the box,
  // so it never depended on the chip the underline variant dropped. The variant
  // adds the fill the ring encloses, which is what "still clearly visible" means
  // once the tab is otherwise bare.
  await expect(focused).toHaveCSS("outline-color", RING);
  await expect(focused).toHaveCSS("outline-width", "2px");
  await expect(focused).toHaveCSS("background-color", MUTED);
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

/**
 * #188: one rule owns the space between a tab bar and its content.
 *
 * `TabsContent`'s `mt-3` is that rule, and a consumer adds no gap of its own — so
 * both specimens sit at the same distance whatever variant they wear. Measured
 * here as well as on the two real screens, because the styleguide is where a
 * variant is looked at in isolation and a regression would be seen first.
 */
test("both tab variants sit one rhythm step above their content", async ({ page }) => {
  await page.goto("/styleguide");

  for (const specimen of ["tabs-underline", "tabs-segmented"]) {
    const scope = page.getByTestId(specimen);
    const list = await scope.locator('[role="tablist"]').boundingBox();
    const panel = await scope.locator('[role="tabpanel"][data-state="active"]').boundingBox();
    expect(list, specimen).not.toBeNull();
    expect(panel, specimen).not.toBeNull();
    expect(panel!.y - (list!.y + list!.height), specimen).toBeCloseTo(12, 0);
  }
});
