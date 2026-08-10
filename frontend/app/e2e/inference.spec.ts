/**
 * The Inference section in a real browser: a weight download somebody watches.
 *
 * ## Why this is not `inference.test.tsx`
 *
 * The claim is **recovery**, and recovery is a claim about a page that did not
 * start the thing it is showing. jsdom can assert that a component renders a prop;
 * only a browser can throw the whole application away — the React tree, the query
 * cache, every closure that might have been holding a job id — and prove that what
 * comes back still knows a transfer is running. `page.reload()` is the assertion,
 * and there is no jsdom equivalent of it.
 *
 * It is also where the *poll* is real. The interval is wall-clock and conditional
 * on the wire, so "keeps asking while a download is live, stops when it settles"
 * is a statement about time passing in a browser.
 *
 * ## The wire is stubbed and the screen is not
 *
 * `page.route` answers `/api/inference/connections` from a mutable fixture, so the
 * bodies are what the server would send — `_wire.ts`'s rule, and the generated
 * runtime checks enforce it: a row missing a required field is rejected before the
 * screen renders, which is exactly what that gate is for.
 */

import { expect, test, type Page } from "@playwright/test";

const CONNECTION = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";

const GIGABYTE = 1_000_000_000;

interface Download {
  readonly state: string;
  readonly bytes_done: number;
  readonly bytes_total: number | null;
  readonly error?: string | null;
}

/** What the server answers for one local connection, in the state a test wants. */
function connection(setup: "not_set_up" | "ready", download: Download | null): unknown {
  return {
    id: CONNECTION,
    name: "sam2-local",
    connection_type: "local",
    model_id: "facebook/sam2.1-hiera-base-plus",
    model_revision: "b73207",
    device: "cuda",
    precision: "fp16",
    endpoint_url: null,
    setup_state: setup,
    allowed_actions: ["download_weights", "update", "delete"],
    capabilities: setup === "ready" ? ["point_suggest"] : [],
    download:
      download === null
        ? null
        : { job_id: JOB, error: null, ...download },
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
  };
}

/**
 * A workspace whose one connection is whatever `next` last returned.
 *
 * Mutable rather than frozen, and derived rather than replayed, for the reason
 * `refactor-protocol` states about doubles: a stub that answers from a script
 * makes a test assert against its own fixture, and a stub whose answer depends on
 * registration order makes it assert against the order too. `next` is asked on
 * every request, so what a test changes is the *workspace*, and the screen reads
 * it the way it reads a server.
 */
async function serveApi(
  page: Page,
  next: () => unknown,
  counted?: { reads: number },
): Promise<void> {
  await page.route("**/api/session", (route) => route.fulfill({ json: { issued: false } }));
  await page.route("**/api/inference/connections*", (route) => {
    if (counted !== undefined) counted.reads += 1;
    return route.fulfill({ status: 200, json: { items: [next()], total: 1 } });
  });
  await page.route("**/api/projects**", (route) =>
    route.fulfill({ status: 200, json: { items: [], total: 0 } }),
  );
}

async function openInference(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await page.getByTestId("rail-inference").click();
  await expect(page.getByTestId("inference-screen")).toBeVisible();
}

test("a page that never started the download still shows it", async ({ page }) => {
  // The shipped bug, in the one shape that could not be tested without a browser:
  // the job id lived in a component, so only the mount that pressed the button
  // could see the transfer. Everything else — a reload, a second tab, a colleague
  // — got `Not set up` beside a download that was still running.
  await serveApi(page, () =>
    connection("not_set_up", { state: "running", bytes_done: 0.4 * GIGABYTE, bytes_total: 1.6 * GIGABYTE }),
  );
  await openInference(page);

  await expect(page.getByTestId("download-progress-prose")).toHaveText("400.0 MB of 1.6 GB · 25%");
  await expect(page.getByTestId("download-bar")).toHaveAttribute("aria-valuenow", "25");

  // Throw the application away. Nothing survives this that a client is holding.
  await page.reload();
  await expect(page.getByTestId("inference-screen")).toBeVisible();

  await expect(page.getByTestId("download-progress-prose")).toHaveText("400.0 MB of 1.6 GB · 25%");
  await expect(page.getByTestId("download-bar")).toHaveAttribute("aria-valuenow", "25");
});

test("a transfer left running is where it got to when you come back", async ({ page }) => {
  // Navigating away is the ordinary way somebody loses sight of a download, and
  // the poll that was watching it goes with the screen. What comes back is read
  // from the wire, so it shows the *current* number rather than the last one this
  // browser happened to see.
  let done = 0.4 * GIGABYTE;
  await serveApi(page, () =>
    connection("not_set_up", { state: "running", bytes_done: done, bytes_total: 1.6 * GIGABYTE }),
  );
  await openInference(page);
  await expect(page.getByTestId("download-progress-prose")).toContainText("25%");

  await page.getByTestId("rail-projects").click();
  await expect(page.getByTestId("inference-screen")).toHaveCount(0);
  // The worker keeps going, because nothing about it was ever this browser's.
  done = 1.2 * GIGABYTE;

  await page.getByTestId("rail-inference").click();
  await expect(page.getByTestId("download-progress-prose")).toHaveText("1.2 GB of 1.6 GB · 75%");
});

test("the bar follows the transfer, and the poll stops when it settles", async ({ page }) => {
  const counted = { reads: 0 };
  let done = 0.8 * GIGABYTE;
  let settled = false;
  await serveApi(
    page,
    () =>
      settled
        ? connection("ready", {
            state: "succeeded",
            bytes_done: 1.6 * GIGABYTE,
            bytes_total: 1.6 * GIGABYTE,
          })
        : connection("not_set_up", {
            state: "running",
            bytes_done: done,
            bytes_total: 1.6 * GIGABYTE,
          }),
    counted,
  );
  await openInference(page);
  await expect(page.getByTestId("download-progress-prose")).toContainText("50%");

  // The bar moves on the poll alone — nothing here clicks anything.
  done = 1.4 * GIGABYTE;
  await expect(page.getByTestId("download-progress-prose")).toContainText("88%");

  settled = true;
  await expect(page.getByTestId("connection-status")).toContainText("Ready");
  // The success treatment is the row's own status; the bar goes with the transfer.
  await expect(page.getByTestId("download-progress")).toHaveCount(0);

  // And the timer stops rather than re-reading a list nothing is moving.
  const after = counted.reads;
  await page.waitForTimeout(5_000);
  expect(counted.reads).toBe(after);
});

test("a connection that is not downloading is not polled at all", async ({ page }) => {
  const counted = { reads: 0 };
  await serveApi(page, () => connection("ready", null), counted);
  await openInference(page);
  await expect(page.getByTestId("connection-status")).toContainText("Ready");

  const first = counted.reads;
  await page.waitForTimeout(5_000);
  expect(counted.reads).toBe(first);
});

test("a transfer that failed while nobody was watching still says why", async ({ page }) => {
  await serveApi(page, () =>
    connection("not_set_up", {
      state: "failed",
      bytes_done: 0.3 * GIGABYTE,
      bytes_total: 1.6 * GIGABYTE,
      error: "could not fetch facebook/sam2.1-hiera-base-plus at b73207: the connection was lost",
    }),
  );
  await openInference(page);

  const shown = page.getByTestId("download-error");
  await expect(shown).toContainText("the connection was lost");
  await expect(shown).toContainText("still Not set up");
  // The remedy is the action the connection declares, not a second control.
  await expect(page.getByTestId("download-weights")).toBeEnabled();
});
