/**
 * Tracks in the annotation workspace, in a real browser: the Tracks region, an
 * observed object's badge, stepping along a track across a frame the job does
 * not carry, the two writes, and copy and paste staying independent of tracks.
 *
 * The job carries asset-1 and asset-2 of one sequence source. Position 2 decoded
 * to an asset another job carries, and position 4 repeats asset-1's bytes, so
 * asset-1 is one asset at two occurrences.
 */

import { expect, test, type Page, type Request } from "@playwright/test";

import type { Wire } from "./_wire";
import { focusCanvas, saveNow } from "./_frame";
import { openJob, type TrackWorld } from "./_wireApiStub";

const SOURCE = "source-1";

const OCCURRENCES: readonly Wire["FrameOccurrenceOut"][] = [
  { id: "occ-1", source_id: SOURCE, position: 1, timestamp: 0.1, asset_id: "asset-1" },
  { id: "occ-2", source_id: SOURCE, position: 2, timestamp: 0.2, asset_id: "asset-9" },
  { id: "occ-3", source_id: SOURCE, position: 3, timestamp: 0.3, asset_id: "asset-2" },
  { id: "occ-4", source_id: SOURCE, position: 4, timestamp: 0.4, asset_id: "asset-1" },
];

function stored(id: string, assetId: string, x: number): Wire["AnnotationOut"] {
  return {
    id,
    asset_id: assetId,
    label_class: "vehicle",
    schema_version: 3,
    geometry: { type: "bbox", x, y: 40, width: 60, height: 40 },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

const SEEDED = [stored("seeded-a", "asset-1", 40), stored("seeded-c", "asset-1", 300), stored("seeded-b", "asset-2", 40)];

function observed(occurrence: string, annotationId: string): Wire["TrackObservationOut"] {
  const at = OCCURRENCES.find((one) => one.id === occurrence)!;
  return { occurrence_id: at.id, position: at.position, timestamp: at.timestamp, asset_id: at.asset_id, annotation_id: annotationId };
}

function world(): TrackWorld {
  return {
    sourceId: SOURCE,
    occurrences: OCCURRENCES,
    tracks: [
      {
        id: "track-1",
        source_id: SOURCE,
        label_class: "vehicle",
        external_id: "7",
        observations: [observed("occ-1", "seeded-a"), observed("occ-2", "elsewhere"), observed("occ-3", "seeded-b")],
      },
    ],
  };
}

async function open(page: Page, tracks: TrackWorld = world()): Promise<Request[]> {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, undefined, undefined, SEEDED, undefined, undefined, tracks);
  await expect(page.getByTestId("track-region")).toBeVisible();
  return sent;
}

function trackWrites(sent: readonly Request[]): string[] {
  return sent
    .filter((one) => one.method() !== "GET" && /\/(tracks|annotations)/.test(one.url()))
    .map((one) => `${one.method()} ${new URL(one.url()).pathname.replace(/^\/api/, "")}`);
}

test("reads a track, badges its object, and steps over the frame outside the job", async ({ page }) => {
  await open(page);

  await expect(page.getByTestId("track-row-track-1")).toContainText("vehicle 7");
  await expect(page.getByTestId("track-row-track-1")).toContainText("3 frames");
  await expect(page.getByTestId("object-track-0")).toBeVisible();
  await expect(page.getByTestId("object-track-1")).toHaveCount(0);

  await page.getByTestId("object-track-0").click();
  await expect(page.getByTestId("track-where")).toHaveText("On this frame at 1");
  await expect(page.getByTestId("track-status")).toHaveText("1 of 2 settled in this batch · 1 outside it");

  await page.getByTestId("track-next").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  await expect(page.getByTestId("track-passed")).toHaveText("Passed over 1 frame outside this job.");
  await expect(page.getByTestId("track-where")).toHaveText("On this frame at 3");

  await page.getByTestId("track-previous").click();
  await expect(page.getByTestId("asset-position")).toContainText("1/2");
  await expect(page.getByTestId("track-where")).toHaveText("On this frame at 1");
});

test("adds the selected object at the repeated frame's other position, then takes it off", async ({ page }) => {
  const sent = await open(page);

  await page.getByTestId("object-select-1").click();
  await page.getByTestId("track-row-track-1").click();
  await page.getByTestId("track-observe").click();
  await expect(page.getByTestId("track-done")).toHaveText("Added at frame 4");
  await expect(page.getByTestId("object-track-1")).toBeVisible();
  await expect(page.getByTestId("track-row-track-1")).toContainText("4 frames");

  await page.getByTestId("track-unobserve-4").click();
  await expect(page.getByTestId("track-done")).toContainText("the object stays");
  await expect(page.getByTestId("object-track-1")).toHaveCount(0);
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");

  expect(trackWrites(sent)).toEqual([
    "POST /jobs/33333333-3333-4333-8333-333333333333/tracks/track-1/observations",
    "DELETE /jobs/33333333-3333-4333-8333-333333333333/tracks/track-1/observations/occ-4",
  ]);
});

test("a newly drawn object is saved first, then starts a track", async ({ page }) => {
  const sent = await open(page);
  await page.getByTestId("save-and-next").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");

  const canvas = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await focusCanvas(page);
  await page.keyboard.press("1");
  await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * 0.7, canvas.y + canvas.height * 0.7, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("object-count")).toHaveText("2 objects");

  await page.getByTestId("object-select-1").click();
  await page.getByTestId("track-start").click();
  await expect(page.getByTestId("track-done")).toHaveText("Started a track at frame 3");
  await expect(page.getByTestId("track-row-track-2")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("object-track-1")).toBeVisible();

  const writes = trackWrites(sent);
  expect(writes.slice(-2)).toEqual([
    "POST /jobs/33333333-3333-4333-8333-333333333333/annotations",
    "POST /jobs/33333333-3333-4333-8333-333333333333/tracks",
  ]);
  const start = sent.filter((one) => one.url().endsWith("/jobs/33333333-3333-4333-8333-333333333333/tracks")).at(-1)!;
  expect(JSON.parse(start.postData() ?? "{}")).toEqual({ occurrence_id: "occ-3", annotation_id: expect.stringMatching(/^server-/) });
});

test("a pasted copy of an observed object is on no track", async ({ page }) => {
  const sent = await open(page);

  await page.getByTestId("object-select-0").click();
  await focusCanvas(page);
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.getByTestId("object-count")).toHaveText("3 objects");

  await expect(page.getByTestId("object-track-0")).toBeVisible();
  await expect(page.locator("[data-testid^='object-track-']")).toHaveCount(1);

  await saveNow(page);
  await expect(page.getByTestId("save-state")).toContainText("Saved");
  await expect(page.locator("[data-testid^='object-track-']")).toHaveCount(1);
  expect(trackWrites(sent).filter((one) => one.includes("/tracks"))).toEqual([]);
  await expect(page.getByTestId("track-row-track-1")).toContainText("3 frames");
});

test("the kernel's refusal of an observe is said in words", async ({ page }) => {
  await open(page, { ...world(), refuseObserve: { code: "ASSET_NOT_JUDGED", message: "the kernel's own wording" } });

  await page.getByTestId("object-select-1").click();
  await page.getByTestId("track-row-track-1").click();
  await page.getByTestId("track-observe").click();
  await expect(page.getByTestId("track-refusal")).toContainText("have not been judged yet");
  await expect(page.getByTestId("object-track-1")).toHaveCount(0);
});
