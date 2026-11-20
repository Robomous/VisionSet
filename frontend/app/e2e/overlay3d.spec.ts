/**
 * The read-only 3D overlay (#1039), in a real browser: a `polyline_3d` projected
 * through its frame's calibration, drawn with a 2D polyline's visibility styling,
 * and never part of what a press, a selection or a save can reach. A frame with no
 * fitting calibration draws nothing and says why.
 */

import { expect, test, type Request } from "@playwright/test";

import { expectNothingToSave, saveNow } from "./_frame";
import type { Wire } from "./_wire";
import { openJob, progressStore } from "./_wireApiStub";

const PINHOLE: Wire["CalibrationOut"] = {
  intrinsics: { fx: 500, fy: 500, cx: 320, cy: 240, skew: 0, width: 640, height: 480 },
  extrinsics: {
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    translation: [0, 0, 0],
  },
  distortion: null,
};

function lane3d(id: string, assetId: string, points: number[][], visibility?: number[]): Wire["AnnotationOut"] {
  return {
    id,
    asset_id: assetId,
    label_class: "lane",
    schema_version: 3,
    geometry: {
      type: "polyline_3d",
      points: points as [number, number, number][],
      ...(visibility === undefined ? {} : { visibility: visibility as (0 | 1 | 2)[] }),
    },
    attributes: {},
    provenance: "import",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

const LANE = lane3d(
  "lane-3d",
  "asset-1",
  [
    [-1, 1.5, 5],
    [-1, 1.5, 10],
    [-1, 1.5, 20],
    [-1, 1.5, 40],
  ],
  [2, 2, 1, 2],
);

/** Its middle vertex is behind the camera, so it draws as two pieces. */
const THROUGH_THE_CAMERA = lane3d("through-camera", "asset-1", [
  [2, 1.5, 8],
  [2, 1.5, -1],
  [2, 1.5, 9],
]);

const BEHIND = lane3d("behind", "asset-1", [
  [0, 1.5, -3],
  [0, 1.5, -9],
]);

const UNCALIBRATED = lane3d("uncalibrated", "asset-2", [
  [0, 1.5, 5],
  [0, 1.5, 10],
]);

async function openSeeded(
  page: Parameters<typeof openJob>[0],
  calibrations: Readonly<Record<string, Wire["CalibrationOut"]>>,
): Promise<Request[]> {
  const sent: Request[] = [];
  await openJob(
    page,
    sent,
    progressStore({ "asset-1": "unannotated", "asset-2": "unannotated" }),
    undefined,
    undefined,
    [LANE, THROUGH_THE_CAMERA, BEHIND, UNCALIBRATED],
    false,
    calibrations,
  );
  return sent;
}

test("a calibrated frame draws its 3D labels projected, occluded runs dashed", async ({ page }) => {
  await openSeeded(page, { "asset-1": PINHOLE });

  const lane = page.locator('[data-overlay-id="lane-3d"] polyline');
  await expect(lane).toHaveCount(2);
  await expect(lane.nth(0)).toHaveAttribute("points", "220,390 270,315");
  await expect(lane.nth(0)).not.toHaveAttribute("data-occluded", "true");
  await expect(lane.nth(1)).toHaveAttribute("points", "270,315 295,277.5 307.5,258.75");
  await expect(lane.nth(1)).toHaveAttribute("data-occluded", "true");
  const dash = await lane.nth(1).evaluate((node) => getComputedStyle(node).strokeDasharray);
  expect(dash).not.toBe("none");

  await expect(page.locator('[data-overlay-id="through-camera"] polyline')).toHaveCount(2);
  await expect(page.locator('[data-overlay-id="behind"]')).toHaveCount(0);
  await expect(page.getByTestId("overlay-3d-withheld")).toHaveCount(0);

  // Not an object: not counted, nothing to save.
  await expect(page.getByTestId("object-total")).toHaveText("0 objects");
  await expectNothingToSave(page);
});

test("a save never sends the 3D labels it drew", async ({ page }) => {
  const sent = await openSeeded(page, { "asset-1": PINHOLE });
  await expect(page.locator('[data-overlay-id="lane-3d"]')).toBeVisible();
  await saveNow(page);
  await expectNothingToSave(page);
  const writes = sent.filter(
    (request) => request.url().includes("/annotations") && request.method() !== "GET",
  );
  expect(writes).toEqual([]);
});

test("a frame with no calibration draws nothing and says why", async ({ page }) => {
  await openSeeded(page, { "asset-1": PINHOLE });
  await page.getByTestId("next-asset").click();
  await expect(page).toHaveURL(/asset=asset-2/);

  const notice = page.getByTestId("overlay-3d-withheld");
  await expect(notice).toContainText("3D labels are not drawn on this image");
  await expect(notice).toContainText("Neither this image nor its source has a camera calibration");
  await expect(page.locator("[data-overlay-id]")).toHaveCount(0);
});

test("a calibration measured at another size draws nothing rather than being rescaled", async ({
  page,
}) => {
  await openSeeded(page, {
    "asset-1": {
      ...PINHOLE,
      intrinsics: { ...PINHOLE.intrinsics, fx: 1000, fy: 1000, cx: 640, cy: 360, width: 1280, height: 720 },
    },
  });

  await expect(page.getByTestId("overlay-3d-withheld")).toContainText(
    "measured at 1280×720 and this image is 640×480",
  );
  await expect(page.locator("[data-overlay-id]")).toHaveCount(0);
});
