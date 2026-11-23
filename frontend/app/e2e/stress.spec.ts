/**
 * Content the product has to survive, in shapes a real workspace can hold.
 *
 * Phase 7 measured the responsive floor against whatever data happened to exist,
 * which is how a long project description reached production and stretched a table
 * row to five hundred pixels. These are the cases that pass could not seed: the
 * write path refuses some of them and the rest need a workspace nobody has.
 * `_visual.ts` supplies them as typed wire instead.
 *
 * The assertions are about layout rather than appearance. A screenshot would show
 * that something went wrong but not say what, and it cannot answer the question
 * these scenarios exist to ask — whether the *page* scrolls sideways, and whether
 * the controls are still reachable. The visual baseline is next door and covers
 * what a picture is actually better at.
 */

import { expect, test } from "@playwright/test";

import {
  LONG_CLASS_NAME,
  LONG_CONNECTION_NAME,
  LONG_MODEL_REFERENCE,
  LONG_PROJECT_NAME,
  LONG_REFUSAL,
  VISUAL,
  expectNoPageOverflow,
  openVisual,
} from "./_visual";

const FLOOR = [320, 375, 480] as const;

test("a very long project name and description do not widen the page", async ({ page }) => {
  await openVisual(page, "/projects", { longProjectText: true });
  await expect(page.getByTestId("projects-screen")).toBeVisible();
  await expect(page.getByText(LONG_PROJECT_NAME)).toBeVisible();

  for (const width of FLOOR) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoPageOverflow(page, `Projects at ${width}px`);
  }

  // The row stays a row. Unclamped, the description wrapped a fragment per line
  // and took it past four hundred pixels, which is the defect this guards.
  await page.setViewportSize({ width: 1280, height: 900 });
  const height = await page
    .getByTestId("projects-screen")
    .locator("tbody tr")
    .first()
    .evaluate((row) => row.getBoundingClientRect().height);
  expect(height, "a long description must not stretch its row").toBeLessThan(160);
});

test("a very long class name does not widen the schema", async ({ page }) => {
  await openVisual(page, `/projects/${VISUAL.project}/schema`, { longClassName: true });
  await expect(page.getByTestId("project-screen")).toBeVisible();

  // The row, not the text. Matching on the name reaches two nodes - the rendered
  // one and a zero-sized span beside it - and asking the first of those to be
  // visible asserts something about a measurement node rather than about the
  // screen.
  const row = page.getByTestId("class-card-0");
  await expect(row).toBeVisible();
  await expect(row).toContainText(LONG_CLASS_NAME.slice(0, 24));

  for (const width of FLOOR) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoPageOverflow(page, `Schema at ${width}px with a long class name`);
    // The name may wrap or truncate, but the row that holds it may not grow past
    // the ledger it sits in.
    const escapes = await row.evaluate((el) => {
      const ledger = el.closest('[data-testid="class-list"]');
      if (ledger === null) return Number.POSITIVE_INFINITY;
      return Math.round(el.getBoundingClientRect().right - ledger.getBoundingClientRect().right);
    });
    expect(escapes, `the class row escapes its ledger at ${width}px`).toBeLessThanOrEqual(1);
  }

  // And the sheet the row opens: the same name, in the field, in a form that
  // never grows past the window.
  await page.setViewportSize({ width: 320, height: 800 });
  await row.click();
  const detail = page.getByTestId("class-sheet");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("class-name-0")).toBeVisible();
  await expect(page.getByTestId("class-name-0")).toHaveValue(LONG_CLASS_NAME);
  const detailBox = await detail.boundingBox();
  expect(detailBox?.width ?? Infinity, "the class sheet is wider than the window").toBeLessThanOrEqual(320);
  await expectNoPageOverflow(page, "Schema at 320px with a class sheet open");
});

test("a very long model reference does not widen the models grid", async ({ page }) => {
  await openVisual(page, "/models", { longModelReference: true });
  await expect(page.getByTestId("models-screen")).toBeVisible();
  await expect(page.getByText(LONG_CONNECTION_NAME, { exact: false }).first()).toBeVisible();

  for (const width of FLOOR) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoPageOverflow(page, `Models at ${width}px with a long model reference`);
  }

  // The reference is technical text: it may truncate, but it may not push the
  // cell wider than the column it sits in.
  await page.setViewportSize({ width: 1280, height: 900 });
  const reference = page.getByTestId("model-reference").filter({ hasText: LONG_MODEL_REFERENCE }).first();
  await expect(reference).toBeVisible();
  const escapes = await reference.evaluate((el) => {
    const cell = el.closest("td");
    if (cell === null) return Number.POSITIVE_INFINITY;
    return Math.round(el.getBoundingClientRect().right - cell.getBoundingClientRect().right);
  });
  expect(escapes, "the model reference must stay inside its column").toBeLessThanOrEqual(1);
});

test("a large annotation count keeps the panel usable", async ({ page }) => {
  // Enough for three-digit numbering and a scrolling panel, and no more: a
  // thousand rows would prove the same point and cost the suite a minute.
  await openVisual(page, `/jobs/${VISUAL.job}`, { annotationCount: 120 });
  await expect(page.getByTestId("annotation-page")).toBeVisible();

  const rows = page.locator("[data-testid^='object-row-']");
  await expect(rows.first()).toBeVisible();

  // The count is rendered, and the row numbering reaches three digits without the
  // counter or the row growing into its neighbours.
  await expect(page.getByTestId("object-count")).toContainText("120");
  await expectNoPageOverflow(page, "the annotator with 120 annotations");

  // The panel owns its own scrolling rather than handing it to the document.
  const ownsScroll = await page.evaluate(() => {
    const row = document.querySelector("[data-testid^='object-row-']");
    for (let el = row?.parentElement ?? null; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) return true;
    }
    return false;
  });
  expect(ownsScroll, "the annotations region should scroll within itself").toBe(true);
});

test("a long refusal wraps instead of widening the page", async ({ page }) => {
  await openVisual(page, "/projects", { refusal: LONG_REFUSAL });
  // The read fails three times before the screen gives up, so the assertion waits
  // for the refusal rather than for a moment in the retry.
  await expect(page.getByText(LONG_REFUSAL, { exact: false })).toBeVisible({ timeout: 15_000 });

  for (const width of FLOOR) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoPageOverflow(page, `a refusal at ${width}px`);
  }

  // Whatever the refusal says, the way out of it stays on screen.
  await page.setViewportSize({ width: 320, height: 800 });
  const retry = page.getByRole("button").first();
  await expect(retry).toBeVisible();
});
