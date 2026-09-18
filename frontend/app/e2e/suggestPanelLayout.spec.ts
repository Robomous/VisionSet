/**
 * The suggest notice has three deliberate layouts: expanded, reduced while a
 * proposal needs a decision, and minimal while it has no live controls. These
 * browser assertions keep each visible control inside its own notice through a
 * reduce/restore cycle.
 */

import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

import { openJob } from "./_wireApiStub";

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

async function expectContainedBy(notice: Locator, control: Locator): Promise<void> {
  const [noticeBox, controlBox] = await Promise.all([notice.boundingBox(), control.boundingBox()]);
  expect(noticeBox).not.toBeNull();
  expect(controlBox).not.toBeNull();
  if (noticeBox === null || controlBox === null) return;

  expect(controlBox.x).toBeGreaterThanOrEqual(noticeBox.x);
  expect(controlBox.y).toBeGreaterThanOrEqual(noticeBox.y);
  expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(noticeBox.x + noticeBox.width);
  expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(noticeBox.y + noticeBox.height);
}

test("a minimal suggest notice contains its reopen control after reducing and restoring", async ({ page }) => {
  await arm(page);
  const notice = page.getByTestId("suggest-panel");
  const toggle = page.getByTestId("suggest-panel-collapse");
  const expanded = await notice.boundingBox();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expectContainedBy(notice, toggle);
  const minimal = await notice.boundingBox();
  expect(expanded).not.toBeNull();
  expect(minimal).not.toBeNull();
  if (expanded !== null && minimal !== null) expect(minimal.width).toBeLessThan(expanded.width);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("suggest-idle")).toBeVisible();
  await expectContainedBy(notice, toggle);
});

test("a reduced proposal keeps its decisions contained through restore", async ({ page }) => {
  await showProposal(page);
  const notice = page.getByTestId("suggest-panel");
  const toggle = page.getByTestId("suggest-panel-collapse");
  const expanded = await notice.boundingBox();

  await toggle.click();
  const accept = page.getByTestId("suggest-accept");
  const discard = page.getByTestId("suggest-discard");
  await expect(accept).toBeVisible();
  await expect(discard).toBeVisible();
  await expect(page.getByText("Click again to refine it — alt-click to take a part away.")).toBeVisible();
  await expectContainedBy(notice, toggle);
  await expectContainedBy(notice, accept);
  await expectContainedBy(notice, discard);
  const reduced = await notice.boundingBox();
  expect(expanded).not.toBeNull();
  expect(reduced).not.toBeNull();
  if (expanded !== null && reduced !== null) expect(reduced.height).toBeLessThan(expanded.height);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(accept).toBeVisible();
  await expect(discard).toBeVisible();
  await expectContainedBy(notice, toggle);
});

test("accept remains operable from the reduced proposal", async ({ page }) => {
  await showProposal(page);
  await page.getByTestId("suggest-panel-collapse").click();
  await page.getByTestId("suggest-accept").click();

  await expect(page.getByTestId("suggestion-shape")).toHaveCount(0);
  await expect(page.getByTestId("suggest-panel-collapse")).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("suggest-panel-collapse").click();
  await expect(page.getByTestId("suggest-idle")).toBeVisible();
});
