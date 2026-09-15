import { expect, test, type Page } from "@playwright/test";

import { HELPERS, MANIFEST, rgb } from "./_support.ts";

interface Selection {
  extractionFps: number;
  ranges: { startSeconds: number; endSeconds: number }[];
  scalePercent: number;
}

interface Run {
  result: { materialized: number; expected: number; skipped: number[] };
  progress: { materialized: number; expected: number }[];
  chunks: number[];
  frames: {
    ordinal: number;
    requestedTimestamp: number;
    sourceTimestamp: number;
    width: number;
    height: number;
    format: string;
    size: number;
    type: string;
    png: { width: number; height: number; rgb: [number, number, number] };
  }[];
}

function selection(over: Partial<Selection> = {}): Selection {
  return { extractionFps: MANIFEST.fps, ranges: [], scalePercent: 100, ...over };
}

function materialize(page: Page, file: string, chosen: Selection): Promise<Run> {
  return page.evaluate(
    async ({ helpers, file, chosen }) => {
      const h = await import(helpers);
      const sink = h.collecting();
      const progress: { materialized: number; expected: number }[] = [];
      const result = await (
        await h.materializer()
      ).materialize(await h.fixture(file), chosen, sink, {
        onProgress: (step: { materialized: number; expected: number }) => progress.push(step),
      });
      const frames = [];
      for (const frame of sink.frames) {
        frames.push({
          ordinal: frame.ordinal,
          requestedTimestamp: frame.requestedTimestamp,
          sourceTimestamp: frame.sourceTimestamp,
          width: frame.width,
          height: frame.height,
          format: frame.format,
          size: frame.bytes.size,
          type: frame.bytes.type,
          png: await h.inspectPng(frame.bytes),
        });
      }
      return { result, progress, chunks: sink.chunks, frames };
    },
    { helpers: HELPERS, file, chosen },
  ) as Promise<Run>;
}

/** Lossy coding moves a solid colour a little; it does not move it to another corner. */
function expectColour(actual: [number, number, number], hex: string) {
  const wanted = rgb(hex);
  for (const channel of [0, 1, 2]) {
    expect(Math.abs(actual[channel] - wanted[channel])).toBeLessThanOrEqual(32);
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/browser/harness.html");
});

for (const codec of ["vp8", "vp9"]) {
  test(`${codec}: the whole clip at source rate is every frame, in order`, async ({ page }) => {
    const run = await materialize(page, `${codec}.webm`, selection());
    expect(run.result).toEqual({ materialized: 8, expected: 8, skipped: [] });
    expect(run.frames.map((frame) => frame.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    run.frames.forEach((frame, index) => {
      expectColour(frame.png.rgb, MANIFEST.colours[index]);
      expect(frame.format).toBe("png");
      expect(frame.type).toBe("image/png");
      expect(frame.png).toMatchObject({ width: 64, height: 64 });
      expect(frame).toMatchObject({ width: 64, height: 64 });
    });
  });
}

test("a lower extraction rate picks the grid's frames, not the first few", async ({ page }) => {
  const run = await materialize(page, "vp8.webm", selection({ extractionFps: 4 }));
  expect(run.result).toMatchObject({ materialized: 4, expected: 4, skipped: [] });
  expect(run.frames.map((frame) => frame.ordinal)).toEqual([0, 1, 2, 3]);
  expect(run.frames.map((frame) => frame.requestedTimestamp)).toEqual([0, 0.25, 0.5, 0.75]);
  // Source frames 0, 2, 4 and 6 — which is what their colours say.
  [0, 2, 4, 6].forEach((source, index) => {
    expectColour(run.frames[index].png.rgb, MANIFEST.colours[source]);
  });
});

test("a range selects a half-open span of the grid", async ({ page }) => {
  const run = await materialize(
    page,
    "vp8.webm",
    selection({ ranges: [{ startSeconds: 0.25, endSeconds: 0.5 }] }),
  );
  expect(run.result).toMatchObject({ materialized: 2, expected: 2, skipped: [] });
  // Ordinals are grid indices, so a range keeps the numbering of the whole clip.
  expect(run.frames.map((frame) => frame.ordinal)).toEqual([2, 3]);
  expectColour(run.frames[0].png.rgb, MANIFEST.colours[2]);
  expectColour(run.frames[1].png.rgb, MANIFEST.colours[3]);
});

test("requested and source timestamps are reported separately", async ({ page }) => {
  const run = await materialize(page, "vp8.webm", selection({ extractionFps: 3 }));
  expect(run.result).toMatchObject({ materialized: 3, expected: 3 });
  expect(run.frames.map((frame) => frame.requestedTimestamp)).toEqual([0, 1 / 3, 2 / 3]);
  // The sample actually drawn is the last one starting at or before the request, and
  // at 3 fps against an 8 fps clip that is a different number for two of the three.
  expect(run.frames.map((frame) => frame.sourceTimestamp)).toEqual([0, 0.25, 0.625]);
  [0, 2, 5].forEach((source, index) => {
    expectColour(run.frames[index].png.rgb, MANIFEST.colours[source]);
  });
});

test("scale is applied to the display dimensions, half-up", async ({ page }) => {
  const run = await materialize(page, "vp8.webm", selection({ scalePercent: 50 }));
  for (const frame of run.frames) {
    expect(frame).toMatchObject({ width: 32, height: 32 });
    expect(frame.png).toMatchObject({ width: 32, height: 32 });
  }
});

test("a rotated track materializes at its display dimensions", async ({ page }) => {
  // Coded 64x32, rotated 90 degrees, so what comes out is 32x64 — and 75% of that,
  // half-up, is 24x48.
  const run = await materialize(page, "rotated.mp4", selection({ scalePercent: 75 }));
  expect(run.frames).not.toHaveLength(0);
  for (const frame of run.frames) {
    expect(frame.png).toMatchObject({ width: 24, height: 48 });
  }
});

test("frames reach the sink in bounded chunks, and progress counts what it took", async ({
  page,
}) => {
  const run = await materialize(page, "vp8.webm", selection({ extractionFps: 100 }));
  expect(run.result).toMatchObject({ materialized: 100, expected: 100, skipped: [] });
  expect(run.chunks).toEqual([...Array(12).fill(8), 4]);
  // One step per chunk the sink accepted, never one per frame decoded: a count that
  // ran ahead of delivery would promise frames that a cancel then threw away.
  expect(run.progress).toHaveLength(13);
  expect(run.progress.map((step) => step.materialized)).toEqual([
    8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 100,
  ]);
  expect(run.progress.at(-1)).toEqual({ materialized: 100, expected: 100 });
  expect(run.progress.at(-1)?.materialized).toBe(run.result.materialized);
});

test("a sink that throws synchronously fails the import instead of hanging it", async ({
  page,
}) => {
  const outcome = await page.evaluate(async (helpers) => {
    const h = await import(helpers);
    // A published interface: a third-party sink guarding a closed batch with a plain
    // `throw` is enough, and it must reach the same place a rejection does.
    const sink = {
      append: () => {
        throw new Error("this sink is closed");
      },
    };
    const run = (
      await h.materializer()
    ).materialize(
      await h.fixture("vp8.webm"),
      { extractionFps: 8, ranges: [], scalePercent: 100 },
      sink,
    );
    return Promise.race([
      run.then(
        () => "resolved",
        (error: Error) => error.message,
      ),
      new Promise((settle) => setTimeout(() => settle("HUNG"), 5000)),
    ]);
  }, HELPERS);
  expect(outcome).toBe("this sink is closed");
  // And the worker it stranded is gone: a hung promise never reaches the `finally`
  // that terminates it.
  await expect.poll(() => page.workers().length).toBe(0);
});

test("a sink that rejects fails the import with the sink's own error", async ({ page }) => {
  const message = await page.evaluate(async (helpers) => {
    const h = await import(helpers);
    const sink = {
      append: () => Promise.reject(new Error("the batch is closed")),
    };
    try {
      await (
        await h.materializer()
      ).materialize(
        await h.fixture("vp8.webm"),
        { extractionFps: 8, ranges: [], scalePercent: 100 },
        sink,
      );
      return "resolved";
    } catch (error) {
      return (error as Error).message;
    }
  }, HELPERS);
  expect(message).toBe("the batch is closed");
});
