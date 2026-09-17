/**
 * The displayed asset is the browser pixel source — proved in a real browser.
 *
 * `docs/content/architecture/frontend/ui-core.md` states the rule and the unit
 * tests beside `AssetImage` and `decodedAssetImage.ts` hold most of it, but jsdom's
 * canvas does not decode a real image: nothing in that suite can show that a real
 * `<img>`, drawn through a real 2D context, yields the exact bytes the descriptor
 * frame promises. `/demo?scene=asset-pixels` (`src/demo/AssetPixelsFixture.tsx`) is a
 * test-only host that composes the real `AssetImage` and `AnnotatorCanvas` against
 * a tiny RGBA image encoded to a PNG at runtime, and this is the one scenario that
 * reads it.
 */

import { expect, test } from "@playwright/test";

test("reuses the visible decoded image for exact descriptor-frame RGB", async ({ page }) => {
  await page.goto("/demo?scene=asset-pixels");
  await expect(page.getByTestId("annotator-image")).toBeVisible();
  await expect(page.getByTestId("pixel-source-same-image")).toHaveText("true");
  await expect(page.getByTestId("pixel-rgb")).toHaveText("1,2,3,5,6,7,9,10,11");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __assetContentRequests?: number }).__assetContentRequests,
      ),
    )
    .toBe(1);
});
