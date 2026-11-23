/**
 * A long list is paged from a footer that stays under the table.
 *
 * Projects is the whole page, so it pages 25 to a page from a bar pinned above
 * the status bar; the document is what scrolls, and a page change brings the
 * table's top back. The arithmetic, the one-page behaviour and the Overview's
 * inline pager are the unit suites' (`ui-core/src/patterns/`); this is the part
 * only a real layout can say — where the footer is, and that it never widens the
 * page.
 */

import { expect, test, type Page } from "@playwright/test";

import { serveVisualApi, expectNoPageOverflow } from "./_visual";
import { projectDigest, type Wire } from "./_wire";

const FIXED = "2024-03-14T09:00:00Z";

function sixty(): Wire["ProjectPage"] {
  const items = Array.from({ length: 60 }, (_, index) => {
    const n = String(index + 1).padStart(2, "0");
    return {
      id: `bbbbbbbb-2222-4222-8222-${String(index).padStart(12, "0")}`,
      name: `project-${n}`,
      description: null,
      thumbnail_asset_id: null,
      thumbnail_hash: null,
      created_at: FIXED,
      digest: projectDigest({ asset_count: index + 1 }),
    } satisfies Wire["ProjectListItemOut"];
  });
  return { items, total: items.length };
}

async function openProjects(page: Page): Promise<void> {
  await serveVisualApi(page);
  // Registered after the fixture, so the newest route answers the list.
  await page.route("**/api/projects", (route) => route.fulfill({ json: sixty() }));
  await page.goto("/projects");
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("projects-table")).toBeVisible();
}

test("Projects pages 25 to a page from a footer pinned above the status bar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await openProjects(page);

  const rows = page.getByTestId("projects-table").locator("tbody tr");
  await expect(rows).toHaveCount(25);
  await expect(page.getByTestId("table-pager-range")).toHaveText("1–25 of 60 projects");
  await expect(page.getByTestId("table-pager-page")).toHaveText("Page 1 of 3");

  // Twenty-five rows are taller than the window, and the footer is on screen all
  // the same: it sticks to the bottom of the viewport, above the status bar.
  const footer = page.getByTestId("table-footer");
  await expect(footer).toBeInViewport({ ratio: 1 });
  const bar = await page.getByTestId("status-bar").boundingBox();
  const foot = await footer.boundingBox();
  expect(foot!.y + foot!.height).toBeLessThanOrEqual(bar!.y + 1);

  // A page change brings the table's top back, without a smooth scroll.
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
  await page.getByTestId("table-pager-next").click();
  await expect(page.getByTestId("table-pager-range")).toHaveText("26–50 of 60 projects");
  await expect(page.getByTestId("projects-table").getByRole("columnheader", { name: "Project" })).toBeInViewport();

  await page.getByTestId("table-pager-last").click();
  await expect(rows).toHaveCount(10);
  await expect(page.getByTestId("table-pager-next")).toHaveAttribute("aria-disabled", "true");

  // From the keyboard, the step that spends itself keeps focus rather than
  // dropping the person back to the top of the document.
  await page.getByTestId("table-pager-prev").click();
  await page.getByTestId("table-pager-next").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("table-pager-next")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("table-pager-next")).toBeFocused();
});

test("the footer does not widen the page at the responsive floor", async ({ page }) => {
  await openProjects(page);
  for (const width of [320, 375, 480]) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoPageOverflow(page, `the Projects footer at ${width}px`);
    await expect(page.getByTestId("table-pager-next")).toBeVisible();
  }
});
