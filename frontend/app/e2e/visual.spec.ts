/**
 * The visual baseline: a small set of reference surfaces, in both themes.
 *
 * ## Why these six and not the route list
 *
 * A snapshot is worth keeping when it would catch a change nothing else does — a
 * token resolving to the wrong colour, a font that failed to load, an icon that
 * stopped drawing, a radius or a gap that moved. Those are properties of the
 * design system rather than of a route, so the set is chosen for the *variety of
 * system* each surface puts on screen, and stops there:
 *
 * - **Projects** is the shell and a data surface at once — rail, page header,
 *   table density, a thumbnail, buttons and meta text.
 * - **Schema** is the form vocabulary: inputs, labels, the wrapped action row Phase 7
 *   fixed, and the class ledger with its drawn shape glyphs.
 * - **Models** is a full-width table of badges and technical text, which is where
 *   a column's width regresses without any assertion noticing.
 * - **An open menu** is the one surface whose palette is deliberately inverted, so
 *   it is the only place a `menuColor` regression shows.
 * - **The annotator** carries the densest chrome in the product: top bar, tool
 *   palette, stage, panel, zoom and the highest icon count anywhere.
 * - **A scan** is the one surface drawn in WebGL rather than CSS: its points take
 *   each theme's own ramp, its cuboid the class colour and its surround `stage`.
 *
 * Home, Batches, Dataset and Ingest are covered by behavioural specs and
 * add no design-system vocabulary these six do not already hold. A baseline that
 * mostly photographs empty space is a baseline that fails for reasons nobody can
 * read.
 *
 * ## Locators, mostly
 *
 * The screenshot is of the surface that owns the contract, not of the window,
 * except where the composition between shell and content *is* the subject. A page
 * screenshot of a long data surface amplifies every irrelevant difference, and
 * `fullPage` would photograph a scroll position as well as a layout.
 */

import { expect, test, type Locator } from "@playwright/test";

import { VISUAL, openVisual, readyForCapture, useDark } from "./_visual";

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 420, height: 900 };

test.describe("the shell and a data surface", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`Projects, desktop, ${theme}`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await openVisual(page, "/projects");
      await expect(page.getByTestId("projects-screen")).toBeVisible();
      if (theme === "dark") await useDark(page);
      await readyForCapture(page);

      // The window, because the rail beside the content is half of what this
      // reference is for.
      await expect(page).toHaveScreenshot(`projects-desktop-${theme}.png`);
    });
  }
});

test.describe("a form surface", () => {
  test("Schema, desktop, dark", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openVisual(page, `/projects/${VISUAL.project}/schema`);
    await expect(page.getByTestId("project-screen")).toBeVisible();
    await useDark(page);
    await readyForCapture(page);
    await expect(page.getByTestId("project-screen")).toHaveScreenshot("schema-desktop-dark.png");
  });

  test("Schema, narrow, light", async ({ page }) => {
    // The width where the action row wraps rather than widening the page — the
    // composition Phase 7 changed, and the one worth a picture.
    await page.setViewportSize(NARROW);
    await openVisual(page, `/projects/${VISUAL.project}/schema`);
    await expect(page.getByTestId("project-screen")).toBeVisible();
    await readyForCapture(page);
    await expect(page.getByTestId("project-screen")).toHaveScreenshot("schema-narrow-light.png");
  });
});

test.describe("a card surface", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`Models, desktop, ${theme}`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await openVisual(page, "/models");
      await expect(page.getByTestId("models-screen")).toBeVisible();
      if (theme === "dark") await useDark(page);
      await readyForCapture(page);
      await expect(page.getByTestId("models-screen")).toHaveScreenshot(
        `models-desktop-${theme}.png`,
      );
    });
  }
});

test.describe("an inverted floating surface", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`an open menu, ${theme}`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      // The batch's row menu on the Overview: the panel's top bar has no overflow any
      // more (every control there is an icon button), and the panel is modal, so the
      // menu is opened from the table with the panel closed.
      await openVisual(page, `/projects/${VISUAL.project}/overview`);
      await expect(page.getByTestId("overview-batches")).toBeVisible();
      if (theme === "dark") await useDark(page);
      await readyForCapture(page);

      await page.getByTestId("batch-menu-drive-01").click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      // The menu carries the `dark` subtree in both themes; that inversion is the
      // whole reason this surface earns a reference of its own.
      await expect(menu).toHaveScreenshot(`menu-open-${theme}.png`);
    });
  }
});

test.describe("the annotation workspace", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`the annotator, desktop, ${theme}`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await openVisual(page, `/jobs/${VISUAL.job}`);
      await expect(page.getByTestId("annotation-page")).toBeVisible();
      if (theme === "dark") await useDark(page);
      await readyForCapture(page);
      await expect(page).toHaveScreenshot(`annotator-desktop-${theme}.png`);
    });
  }
});

/** Drawn, and not drawing again: the canvas draws on demand, so a still count is a still picture. */
async function scanSettled(view: Locator): Promise<void> {
  await expect(view).toHaveAttribute("data-status", "ready");
  let last = "";
  await expect
    .poll(async () => {
      const draws = (await view.getAttribute("data-draws")) ?? "0";
      const settled = draws !== "0" && draws === last;
      last = draws;
      return settled;
    })
    .toBe(true);
}

test.describe("the scan view", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`a scan, desktop, ${theme}`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      // Through the system preference, so the canvas draws its first frame in the theme.
      await page.emulateMedia({ colorScheme: theme });
      await openVisual(page, `/jobs/${VISUAL.job}`, { scan: true });
      await expect(page.getByTestId("annotation-page")).toBeVisible();
      await readyForCapture(page);
      await scanSettled(page.getByTestId("point-cloud-canvas"));
      await expect(page).toHaveScreenshot(`scan-desktop-${theme}.png`);
    });
  }
});
