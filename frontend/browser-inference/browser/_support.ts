import type { Page } from "@playwright/test";

/**
 * Open the harness and start counting workers before any page script runs.
 *
 * The count is the persistence proof's second half. The first half is that a graph
 * loaded once stays loaded — if the runtime had quietly started a second worker, its
 * session map would be empty and the next `run` would fail — and this catches the case
 * the first half cannot see: a second worker that loaded the graph again.
 */
export async function openHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Real = Worker;
    const counted = class extends Real {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        (globalThis as unknown as { __workersStarted: number }).__workersStarted += 1;
      }
    };
    (globalThis as unknown as { __workersStarted: number }).__workersStarted = 0;
    (globalThis as unknown as { Worker: unknown }).Worker = counted;
  });
  await page.goto("/browser/harness.html");
}

export function workersStarted(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as { __workersStarted: number }).__workersStarted);
}

/**
 * The model, as a plain number array.
 *
 * Playwright serialises `page.evaluate` arguments as JSON, so a `Uint8Array` would
 * arrive as an object with numeric keys. Converting explicitly on both sides keeps the
 * failure — if there is one — in the graph rather than in the transport.
 */
export function modelArgument(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}
