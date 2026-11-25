/**
 * A point-cloud scan dropped on the ingest screen reaches a batch, against the real
 * server: the job has to run to `completed`, which a stubbed wire cannot show.
 *
 * The scan is built here, in memory — fixture media is never committed.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { emptyWorkspace } from "./_workspace";

const CYCLE_DIR = process.env["VISIONSET_CYCLE_DIR"] ?? "";

/** Written by `scripts/cycle_server.sh`, which minted it once. */
function token(): string {
  return readFileSync(path.join(CYCLE_DIR, "token"), "utf8").trim();
}

const POINTS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const SCAN = Buffer.from(
  [
    "# .PCD v0.7 - Point Cloud Data file format",
    "VERSION 0.7",
    "FIELDS x y z",
    "SIZE 4 4 4",
    "TYPE F F F",
    "COUNT 1 1 1",
    `WIDTH ${POINTS.length}`,
    "HEIGHT 1",
    "VIEWPOINT 0 0 0 1 0 0 0",
    `POINTS ${POINTS.length}`,
    "DATA ascii",
    ...POINTS.map((point) => point.join(" ")),
    "",
  ].join("\n"),
);

test.beforeEach(async ({ request }) => {
  await emptyWorkspace(request, token());
});

test("a scan dropped on the ingest screen lands in a new batch", async ({ page, request }) => {
  const created = await request.post("/projects", {
    headers: { Authorization: `Bearer ${token()}` },
    data: { name: "browser-point-cloud-upload" },
  });
  expect(created.ok(), `POST /projects answered ${created.status()}`).toBe(true);
  const { id } = (await created.json()) as { id: string };
  // The old ingest address opens Add images over the project.
  await page.goto(`./projects/${id}/ingest`);
  await expect(page.getByRole("dialog", { name: "Add images" })).toBeVisible();

  await page
    .getByTestId("file-input")
    .setInputFiles({ name: "scan.pcd", mimeType: "application/octet-stream", buffer: SCAN });
  await expect(page.getByTestId("point-cloud-flow")).toBeVisible();
  await expect(page.getByTestId("chosen")).toHaveText("scan.pcd");

  // No frame is preselected, so registering is not offered until one is chosen.
  await expect(page.getByTestId("register-source")).toBeDisabled();
  await page.getByTestId("scan-frame").getByRole("radio", { name: /LiDAR FLU/ }).click();
  await page.getByTestId("register-source").click();
  await expect(page.getByTestId("source-card")).toBeVisible();

  await page.getByTestId("batch-name").fill("scan-batch");
  await page.getByTestId("start-ingest").click();

  await expect(page.getByTestId("run-state")).toHaveText("Done", { timeout: 60_000 });
  await expect(page.getByTestId("run-progress")).toContainText("1 of 1");
  await expect(page.getByTestId("failures")).toHaveCount(0);
  await expect(page.getByTestId("run-outcome")).toContainText("scan-batch");

  // A batch opens in the Overview's panel, which names it and counts its assets.
  await page.getByTestId("open-batch").click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/overview\?batch=[0-9a-f-]{36}$/);
  const panel = page.getByTestId("batch-sheet");
  await expect(panel.getByRole("heading", { level: 2, name: "scan-batch" })).toBeVisible();
  // The count property, read by its label — a scan batch counts Scans — since the panel lists the state first.
  // The count is the way to the batch's scans, named by what it shows.
  const scans = panel.getByTestId("batch-sheet-facts").locator("div", { has: page.locator("dt", { hasText: /^Scans$/ }) });
  await expect(scans.getByTestId("batch-sheet-assets")).toHaveAccessibleName("1 scan, open in Images");
});
