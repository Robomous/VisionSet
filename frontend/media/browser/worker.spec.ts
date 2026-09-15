import { expect, test } from "@playwright/test";

import { HELPERS, WORKER_PATH } from "./_support.ts";

const WHOLE_CLIP = { extractionFps: 8, ranges: [], scalePercent: 100 };

test.beforeEach(async ({ page }) => {
  await page.goto("/browser/harness.html");
});

test("decoding runs in a module worker loaded from a real sibling file", async ({ page }) => {
  const [worker] = await Promise.all([
    page.waitForEvent("worker"),
    page.evaluate(
      async ([helpers, chosen]) => {
        const h = await import(helpers as string);
        return (
          await h.materializer()
        ).materialize(await h.fixture("vp8.webm"), chosen, h.collecting());
      },
      [HELPERS, WHOLE_CLIP] as const,
    ),
  ]);
  expect(worker.url()).toBe(new URL(WORKER_PATH, page.url()).href);
  // Never a blob: or data: URL — a host's content-security policy must not be what
  // breaks the import.
  expect(worker.url().startsWith("http://")).toBe(true);
  // The adapter terminates the worker it spawned; nothing is left running.
  await expect.poll(() => page.workers().length).toBe(0);
});

test("a sink that never resolves stalls the decoder instead of filling the heap", async ({
  page,
}) => {
  const observed = await page.evaluate(
    async ([helpers, chunkSize]) => {
      const h = await import(helpers as string);
      const chunks: number[] = [];
      const produced: number[] = [];
      const controller = new AbortController();
      const sink = {
        append: (frames: unknown[]) => {
          chunks.push(frames.length);
          return new Promise<void>(() => {});
        },
      };
      const run = (
        await h.materializer()
      ).materialize(
        await h.fixture("vp8.webm"),
        { extractionFps: 200, ranges: [], scalePercent: 100 },
        sink,
        {
          signal: controller.signal,
          onProgress: (step: { materialized: number }) => produced.push(step.materialized),
        },
      );
      // Long enough that an unbounded decoder would have finished all 200 frames.
      await new Promise((settle) => setTimeout(settle, 1500));
      const stalled = { chunks: [...chunks], produced: produced.at(-1) ?? 0, chunkSize };
      controller.abort();
      return { ...stalled, result: await run };
    },
    [HELPERS, 8] as const,
  );

  // One chunk delivered and never acknowledged, so no second chunk ever leaves the
  // worker — the bound that makes memory constant rather than proportional to the clip.
  expect(observed.chunks).toEqual([8]);
  // Nothing is reported as materialized while the only chunk sent is still in the
  // sink's hands: the count is what was taken, not what was decoded.
  expect(observed.produced).toBe(0);
  expect(observed.result).toEqual({ materialized: 0, expected: 200, skipped: [] });
});

test("cancelling mid-import releases the decoder and delivers nothing further", async ({
  page,
}) => {
  const observed = await page.evaluate(async (helpers) => {
    const h = await import(helpers);
    const controller = new AbortController();
    let received = 0;
    let afterAbort = 0;
    let aborted = false;
    const sink = {
      append: (frames: unknown[]) => {
        received += frames.length;
        if (aborted) afterAbort += frames.length;
        if (!aborted && received >= 8) {
          aborted = true;
          controller.abort();
        }
        return Promise.resolve();
      },
    };
    // Resolving at all is the assertion: the worker posts `done` only after the
    // `finally` that ends the canvas iterator and disposes the Input, so a hung
    // teardown would time this test out rather than pass it.
    const result = await (
      await h.materializer()
    ).materialize(
      await h.fixture("vp8.webm"),
      { extractionFps: 200, ranges: [], scalePercent: 100 },
      sink,
      { signal: controller.signal },
    );
    return { result, received, afterAbort };
  }, HELPERS);

  expect(observed.result.expected).toBe(200);
  expect(observed.result.materialized).toBeLessThan(200);
  // Exactly what the sink took — the decoder runs a chunk ahead of delivery, and a
  // count that included that lead would name frames the cancel discarded.
  expect(observed.result.materialized).toBe(observed.received);
  expect(observed.afterAbort).toBe(0);
  await expect.poll(() => page.workers().length).toBe(0);
});

test("a cancel that aborts an upload in flight is still a cancel, not a failure", async ({
  page,
}) => {
  // The common shape against a real server: the sink hands the signal to `fetch`, so
  // the caller's own abort comes back as an `AbortError` from `append` — on the same
  // microtask queue, always ahead of the worker's `done`. Reporting that to the person
  // who pressed Cancel as a failed import would be a lie about what they did.
  const observed = await page.evaluate(async (helpers) => {
    const h = await import(helpers);
    const controller = new AbortController();
    let received = 0;
    const sink = {
      append: (frames: unknown[], signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          received += frames.length;
          signal.addEventListener("abort", () => {
            reject(new DOMException("signal is aborted without reason", "AbortError"));
          });
          controller.abort();
          setTimeout(resolve, 10_000);
        }),
    };
    const run = (
      await h.materializer()
    ).materialize(
      await h.fixture("vp8.webm"),
      { extractionFps: 200, ranges: [], scalePercent: 100 },
      sink,
      { signal: controller.signal },
    );
    const settled = await run.then(
      (result: unknown) => ({ result }),
      (error: Error) => ({ rejected: error.message }),
    );
    return { ...settled, received };
  }, HELPERS);

  expect(observed).toEqual({ received: 8, result: { materialized: 0, expected: 200, skipped: [] } });
  await expect.poll(() => page.workers().length).toBe(0);
});

test("an already-aborted signal produces nothing at all", async ({ page }) => {
  const observed = await page.evaluate(
    async ([helpers, chosen]) => {
      const h = await import(helpers as string);
      const sink = h.collecting();
      const result = await (
        await h.materializer()
      ).materialize(await h.fixture("vp8.webm"), chosen, sink, {
        signal: AbortSignal.abort(),
      });
      return { result, frames: sink.frames.length };
    },
    [HELPERS, WHOLE_CLIP] as const,
  );
  expect(observed.frames).toBe(0);
  expect(observed.result.materialized).toBe(0);
});
