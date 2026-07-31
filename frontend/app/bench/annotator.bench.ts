/**
 * #49's benchmark: frame times during pan, zoom and drag over 200 boxes and 20
 * polygons of 32 vertices on a 4K asset.
 *
 * ## Measured, and only loosely gated
 *
 * The acceptance criterion is 60fps "on a dev machine (document the machine)",
 * which is a statement about a measurement and not about a threshold that can
 * live in CI. #48 settled the precedent when it recorded its own runtime rather
 * than asserting it: a wall-clock assertion on a shared runner fails for reasons
 * nobody chose. So every row below is printed, written to `bench-results.json`
 * and copied into `docs/annotations.md`, and the only assertion is a floor —
 * `p95` under **33 ms**, half the frame rate — which no working build can fail
 * and no catastrophic regression can pass.
 *
 * The hardware-independent half of the same question is asserted properly, in
 * `e2e/perf.spec.ts`, which runs on every pull request. The two see different
 * things and neither replaces the other: that file counts DOM writes, so it
 * cannot see a re-render that produces identical output, and this one can.
 *
 * ## Against a production build, deliberately
 *
 * `playwright.bench.config.ts` serves `vite preview`, not `vite dev`. Under the
 * dev server React runs its development build and `StrictMode` double-invokes
 * every render — numbers from there describe a build nobody ships. A production
 * build also makes `StrictMode` a no-op, so one decision fixes both.
 *
 * ## The rows, and why each is there
 *
 * The four gestures are #49's own list. The two extra rows are controls, and
 * they are what make the four interpretable:
 *
 * - **the demo scene** isolates the cost of the *document* from the cost of the
 *   page, by running the identical drag against one annotation instead of 220;
 * - **the wire pane** prices the host chrome `BenchmarkHost` leaves out, so that
 *   omission is a measurement rather than an assertion.
 */

import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  BENCH_ANNOTATIONS,
  BENCH_ASSET,
  BENCH_PAGE,
  BENCH_WIRE_PAGE,
  DEMO_PAGE,
  benchBoxCentre,
} from "../e2e/_bench";
import { ASSET, drawBbox, expectCounts, frameOf } from "../e2e/_frame";
import { pacedMove, pacedWheel } from "./_gestures";
import {
  FRAME_BUDGET_MS,
  STALL_MS,
  settle,
  startSampling,
  stopSampling,
  throttleCpu,
} from "./_sampler";
import type { FrameStats } from "./_sampler";

/** Frames per measured gesture. Sixty is one second of a real drag. */
const FRAMES = 60;

/** `e2e/perf.spec.ts`'s target box, for the same reason: it sits under no polygon. */
const TARGET_BOX = 23;

/**
 * The loose floor — 30fps.
 *
 * Not 60: this is the assertion that survives an unknown machine, and the 60fps
 * claim is the recorded number beside it.
 */
const P95_CEILING_MS = 2 * FRAME_BUDGET_MS;

/**
 * The ladder the headroom rows walk: this machine, then a quarter, a tenth and a
 * twentieth of it.
 *
 * A single rate would not find anything. Everything holds at 4x and the drag
 * still holds at 10x, so one row at either would be indistinguishable from the
 * unthrottled one; the interesting number is *where each gesture stops holding*,
 * and that is a curve rather than a point.
 */
const HEADROOM_RATES = [4, 10, 20] as const;

interface Row extends FrameStats {
  readonly scenario: string;
  readonly annotations: number;
  readonly asset: string;
  readonly cpu: string;
}

const rows: Row[] = [];
let machine = "unknown";

function record(
  scenario: string,
  annotations: number,
  asset: string,
  stats: FrameStats,
  throttle = 1,
): void {
  rows.push({ scenario, annotations, asset, cpu: throttle === 1 ? "full" : `${throttle}x slower`, ...stats });
  // The gesture ran for as long as it was asked to. A short run is not a fast
  // one — it is a run whose frames never happened, and its percentiles would be
  // about a handful of samples.
  expect(stats.frames).toBeGreaterThanOrEqual(FRAMES - 5);
  // The throttled rows exist to find the ceiling, so they are recorded and not
  // gated: asserting a frame rate on a deliberately crippled machine is the
  // mistake the loose floor was introduced to avoid, twice over.
  if (throttle === 1) expect(stats.p95).toBeLessThan(P95_CEILING_MS);
}

test.beforeAll(async ({ browser }) => {
  const cpu = os.cpus()[0]?.model ?? "unknown cpu";
  const memory = Math.round(os.totalmem() / 1024 ** 3);
  machine =
    `${os.type()} ${os.release()} ${process.arch} · ${cpu} · ${os.cpus().length} threads · ` +
    `${memory} GB · node ${process.versions.node} · chromium ${browser.version()}` +
    (process.env.CI === undefined ? "" : " · CI runner");
});

test.afterAll(() => {
  const report = { machine, frameBudgetMs: FRAME_BUDGET_MS, rows };
  const output = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "bench-results.json",
  );
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

  const cell = (value: number): string => value.toFixed(1).padStart(7);
  const cpu = (value: string): string => value.padStart(9);
  const lines = [
    "",
    machine,
    `frame budget ${FRAME_BUDGET_MS.toFixed(2)} ms (60fps); a stall is an interval over ${STALL_MS.toFixed(1)} ms`,
    "",
    "scenario                                  n       cpu   frames   p50 ms   p95 ms   p99 ms   max ms   stalls",
    "-".repeat(108),
    ...rows.map((row) =>
      [
        row.scenario.padEnd(38),
        String(row.annotations).padStart(4),
        cpu(row.cpu),
        String(row.frames).padStart(8),
        cell(row.p50),
        cell(row.p95),
        cell(row.p99),
        cell(row.max),
        String(row.stalls).padStart(8),
      ].join(" "),
    ),
    "",
    `written to ${output}`,
    "",
  ];
  // The report is the deliverable, so it goes to stdout where a CI log keeps it.
  console.log(lines.join("\n"));
});

test("pan · 220 annotations · 4K", async ({ page }) => {
  await page.goto(BENCH_PAGE);
  const frame = await frameOf(page, BENCH_ASSET);
  await settle(page);

  const from = frame.at(1900, 1100);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button: "right" });
  await startSampling(page);
  await pacedMove(page, from, frame.at(2500, 1500), FRAMES);
  const stats = await stopSampling(page);
  await page.mouse.up({ button: "right" });

  record("pan", BENCH_ANNOTATIONS, "4K", stats);
});

test("zoom · 220 annotations · 4K", async ({ page }) => {
  await page.goto(BENCH_PAGE);
  const frame = await frameOf(page, BENCH_ASSET);
  await settle(page);

  await startSampling(page);
  await pacedWheel(page, frame.at(1920, 1080), FRAMES);
  const stats = await stopSampling(page);

  record("zoom (wheel)", BENCH_ANNOTATIONS, "4K", stats);
});

test("drag one box · 220 annotations · 4K", async ({ page }) => {
  await page.goto(BENCH_PAGE);
  const frame = await frameOf(page, BENCH_ASSET);
  await settle(page);

  const centre = benchBoxCentre(TARGET_BOX);
  const from = frame.at(centre.x, centre.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await startSampling(page);
  await pacedMove(page, from, frame.at(centre.x + 900, centre.y + 500), FRAMES);
  const stats = await stopSampling(page);
  await page.mouse.up();
  await expectCounts(page, BENCH_ANNOTATIONS, 1);

  record("drag one box", BENCH_ANNOTATIONS, "4K", stats);
});

test("draw a box · 220 annotations · 4K", async ({ page }) => {
  await page.goto(BENCH_PAGE);
  const frame = await frameOf(page, BENCH_ASSET);
  await settle(page);

  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  const from = frame.at(400, 1500);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await startSampling(page);
  await pacedMove(page, from, frame.at(1400, 2000), FRAMES);
  const stats = await stopSampling(page);
  await page.mouse.up();
  await expectCounts(page, BENCH_ANNOTATIONS + 1, 1);

  record("draw a box", BENCH_ANNOTATIONS, "4K", stats);
});

/**
 * The control: the same drag against one annotation on the demo's 1280x720
 * asset. Whatever both rows share is the page; the difference is the document.
 */
test("drag one box · 1 annotation · 1280x720 (control)", async ({ page }) => {
  await page.goto(DEMO_PAGE);
  const frame = await frameOf(page);
  await drawBbox(page, frame, { x: 300, y: 200 }, { x: 520, y: 360 });
  await expectCounts(page, 1, 1);
  await settle(page);

  const from = frame.at(410, 280);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await startSampling(page);
  await pacedMove(page, from, frame.at(700, 500), FRAMES);
  const stats = await stopSampling(page);
  await page.mouse.up();

  record("drag one box (control)", 1, `${ASSET.width}x${ASSET.height}`, stats);
});

/**
 * The price of the host chrome `BenchmarkHost` leaves out: the demo's wire pane,
 * which runs `JSON.stringify` over every annotation on every snapshot change —
 * and a drag invalidates the snapshot on every pointer-move.
 */
test("drag one box · 220 annotations · 4K · with the demo's wire pane", async ({ page }) => {
  await page.goto(BENCH_WIRE_PAGE);
  const frame = await frameOf(page, BENCH_ASSET);
  await expect(page.getByTestId("wire")).toBeVisible();
  await settle(page);

  const centre = benchBoxCentre(TARGET_BOX);
  const from = frame.at(centre.x, centre.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await startSampling(page);
  await pacedMove(page, from, frame.at(centre.x + 900, centre.y + 500), FRAMES);
  const stats = await stopSampling(page);
  await page.mouse.up();

  record("drag one box + wire pane", BENCH_ANNOTATIONS, "4K", stats);
});

/**
 * The headroom ladder: the two most expensive gestures, on machines pretending
 * to be four, ten and twenty times slower than this one.
 *
 * Not a stress test for its own sake. Every unthrottled row above reports 16.7 ms
 * whether the work uses a tenth of the frame budget or all of it, so the
 * benchmark on its own could not tell a healthy build from one about to miss —
 * and a regression halving the margin would leave every number identical. These
 * rows say how far away the cliff is for each gesture, which is the thing a
 * future change should be compared against.
 *
 * They are generated rather than written out, so adding a rate is one number.
 */
for (const rate of HEADROOM_RATES) {
  test(`drag one box · 220 annotations · 4K · ${rate}x CPU throttle`, async ({ page }) => {
    await page.goto(BENCH_PAGE);
    const frame = await frameOf(page, BENCH_ASSET);
    await settle(page);
    await throttleCpu(page, rate);

    const centre = benchBoxCentre(TARGET_BOX);
    const from = frame.at(centre.x, centre.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await startSampling(page);
    await pacedMove(page, from, frame.at(centre.x + 900, centre.y + 500), FRAMES);
    const stats = await stopSampling(page);
    await page.mouse.up();
    await throttleCpu(page, 1);

    record("drag one box (headroom)", BENCH_ANNOTATIONS, "4K", stats, rate);
  });

  test(`zoom · 220 annotations · 4K · ${rate}x CPU throttle`, async ({ page }) => {
    await page.goto(BENCH_PAGE);
    const frame = await frameOf(page, BENCH_ASSET);
    await settle(page);
    await throttleCpu(page, rate);

    await startSampling(page);
    await pacedWheel(page, frame.at(1920, 1080), FRAMES);
    const stats = await stopSampling(page);
    await throttleCpu(page, 1);

    record("zoom (wheel) (headroom)", BENCH_ANNOTATIONS, "4K", stats, rate);
  });
}
