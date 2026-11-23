/**
 * The suggest tool's bar, in a real browser: it is the tool's own row over the
 * canvas (`tool-options`), not a card over the picture. What jsdom cannot say is
 * geometry and focus — that the row stays one row at the editor's minimum
 * viewport without widening the page, that its words drop while its controls
 * stay reachable, and that a press on it leaves the keyboard with the canvas.
 */

import { expect, test, type Page, type Request } from "@playwright/test";

import { openJob } from "./_wireApiStub";

/** The annotator's floor (`viewportFloor.ts`), where the stage column is narrowest. */
const MINIMUM = { width: 768, height: 720 };

async function arm(page: Page): Promise<void> {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, undefined, undefined, undefined, true);
  await page.getByTestId("tool-suggest").click();
  await expect(page.getByTestId("suggest-idle")).toBeVisible();
}

async function showProposal(page: Page): Promise<void> {
  await arm(page);
  const canvas = await page.getByTestId("annotator-canvas").boundingBox();
  if (canvas === null) throw new Error("The annotation canvas is not visible");
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await expect(page.getByTestId("suggestion-shape")).toBeVisible();
}

/** The bar's height and its column, so a wrap or a page-widening shows as a number. */
async function barFits(page: Page): Promise<void> {
  const bar = page.getByTestId("tool-options");
  const box = (await bar.boundingBox())!;
  // One row: `h-12`, never two lines of controls.
  expect(Math.round(box.height)).toBe(48);
  // Inside its own column, between the rail and the side panel.
  const rail = (await page.getByTestId("tool-palette").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(rail.x + rail.width - 1);
  const panel = (await page.getByRole("complementary", { name: "Frame" }).boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(panel.x + 1);
  // The page itself never scrolls sideways for the bar.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Whatever does not fit scrolls inside the bar, with no scrollbar drawn.
  await expect(bar).toHaveCSS("overflow-x", "auto");
  await expect(bar).toHaveCSS("scrollbar-width", "none");
}

test("the suggest options live in the tool's bar, and nothing floats over the picture", async ({ page }) => {
  await showProposal(page);

  const bar = page.getByTestId("tool-options");
  await expect(bar.getByTestId("suggest-bar")).toBeVisible();
  await expect(bar.getByTestId("suggest-shown")).toBeVisible();
  await expect(bar.getByTestId("suggest-accept")).toBeVisible();
  await expect(bar.getByTestId("suggest-discard")).toBeVisible();
  await expect(page.getByTestId("editor-notices").locator("[data-testid^='suggest-']")).toHaveCount(0);
  await expect(page.getByTestId("suggest-panel")).toHaveCount(0);
});

test("idle, the bar is one row at the minimum viewport and never widens the page", async ({ page }) => {
  await page.setViewportSize(MINIMUM);
  await arm(page);
  await barFits(page);
});

test("with a proposal up, the bar is still one row at the minimum viewport", async ({ page }) => {
  await page.setViewportSize(MINIMUM);
  await showProposal(page);
  await barFits(page);
});

test("words drop at a narrow bar and the keys go with them, while every control keeps its name", async ({
  page,
}) => {
  await showProposal(page);
  // A wide bar carries the keys beside the decisions…
  const acceptKey = page.getByTestId("suggest-accept").locator("[data-slot=kbd]");
  await expect(acceptKey).toBeVisible();

  // …and a narrow one drops them, keeping the decisions themselves.
  await page.setViewportSize(MINIMUM);
  await expect(acceptKey).toBeHidden();
  await expect(page.getByTestId("suggest-accept")).toHaveAccessibleName(/Accept/);
  // The tool's word leaves the eye and stays for a screen reader.
  await expect(page.getByTestId("active-tool")).toContainText("Suggest");
  await expect(page.getByTestId("active-tool").getByText("Suggest")).toHaveClass(/@max-\[48rem\]:sr-only/);
});

test("accept works from the bar at the minimum viewport", async ({ page }) => {
  await page.setViewportSize(MINIMUM);
  await showProposal(page);

  // Playwright scrolls the bar to the control if it sits past the visible edge,
  // which is exactly what a person does with the row.
  await page.getByTestId("suggest-accept").click();

  await expect(page.getByTestId("suggestion-shape")).toHaveCount(0);
  await expect(page.getByTestId("object-count")).toHaveText("1 object");
  // Armed still, ready for the next object.
  await expect(page.getByTestId("suggest-idle")).toBeVisible();
});

test("a press on the bar leaves the keyboard with the canvas", async ({ page }) => {
  await showProposal(page);
  await page.getByTestId("annotator-root").focus();

  // Discard with the mouse, then a fresh proposal accepted with the key: if the
  // button had taken focus, `↵` would land on it instead of the canvas.
  await page.getByTestId("suggest-discard").click();
  await expect(page.getByTestId("annotator-root")).toBeFocused();
  const canvas = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await expect(page.getByTestId("suggestion-shape")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("object-count")).toHaveText("1 object");
});
