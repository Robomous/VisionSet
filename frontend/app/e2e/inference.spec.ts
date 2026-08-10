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
 * It is also where the *poll* is real: the bar below moves because a timer fired
 * and an answer changed, with nothing clicked after the screen opened.
 *
 * What is **not** here is the counting half — *and it stops asking once nothing is
 * moving*. That is a claim that nothing happens over an interval, and the only way
 * to make it in a browser is to wait on a clock, which `tests/scripts/e2e_discipline`
 * forbids for the reason it gives. It is asserted in `inference.test.tsx`, which
 * can count requests without a browser scheduler deciding the outcome.
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
const CHECK_JOB = "55555555-5555-4555-8555-555555555555";

const GIGABYTE = 1_000_000_000;

interface Download {
  readonly state: string;
  readonly bytes_done: number;
  readonly bytes_total: number | null;
  readonly error?: string | null;
}

interface Check {
  readonly state: string;
  readonly files_read: number;
  readonly files_total: number | null;
  readonly error?: string | null;
}

/** What the server answers for one local connection, in the state a test wants. */
function connection(
  setup: "not_set_up" | "ready",
  download: Download | null,
  check: Check | null = null,
): unknown {
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
    download: download === null ? null : { job_id: JOB, error: null, ...download },
    integrity_check: check === null ? null : { job_id: CHECK_JOB, error: null, ...check },
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
async function serveApi(page: Page, next: () => unknown): Promise<void> {
  await page.route("**/api/session", (route) => route.fulfill({ json: { issued: false } }));
  await page.route("**/api/inference/connections*", (route) =>
    route.fulfill({ status: 200, json: { items: [next()], total: 1 } }),
  );
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
  await expect(page.getByTestId("download-progress-bar")).toHaveAttribute("aria-valuenow", "25");

  // Throw the application away. Nothing survives this that a client is holding.
  await page.reload();
  await expect(page.getByTestId("inference-screen")).toBeVisible();

  await expect(page.getByTestId("download-progress-prose")).toHaveText("400.0 MB of 1.6 GB · 25%");
  await expect(page.getByTestId("download-progress-bar")).toHaveAttribute("aria-valuenow", "25");
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

test("the bar moves on the poll alone, and stops being a bar when it lands", async ({ page }) => {
  // Nothing is clicked after the screen opens. Every number below arrives because
  // a timer fired, a request went out, and the answer changed — which is the one
  // part of this feature that only a browser can be asked about.
  let done = 0.8 * GIGABYTE;
  let settled = false;
  await serveApi(page, () =>
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
  );
  await openInference(page);
  await expect(page.getByTestId("download-progress-prose")).toContainText("50%");

  done = 1.4 * GIGABYTE;
  await expect(page.getByTestId("download-progress-prose")).toContainText("88%");

  settled = true;
  await expect(page.getByTestId("connection-status")).toContainText("Ready");
  // The success treatment is the row's own status; the bar goes with the transfer.
  await expect(page.getByTestId("download-progress")).toHaveCount(0);
});

test("arriving after a transfer finished shows the row and no bar", async ({ page }) => {
  // The record stays on the connection once the job settles — it answers *what
  // happened last time* — and a settled record is not something to draw a bar for.
  await serveApi(page, () =>
    connection("ready", {
      state: "succeeded",
      bytes_done: 1.6 * GIGABYTE,
      bytes_total: 1.6 * GIGABYTE,
    }),
  );
  await openInference(page);

  await expect(page.getByTestId("connection-status")).toContainText("Ready");
  await expect(page.getByTestId("download-progress")).toHaveCount(0);
  await expect(page.getByTestId("download-error")).toHaveCount(0);
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


test("a check nobody on this page started survives a reload", async ({ page }) => {
  // The download's proof, one action over. The check kept its job id in a
  // component until now, so only the mount that pressed the menu item could see a
  // run reading gigabytes — and a check somebody started from a terminal was
  // invisible to every browser.
  await serveApi(page, () =>
    connection("ready", null, { state: "running", files_read: 4, files_total: 9 }),
  );
  await openInference(page);

  await expect(page.getByTestId("integrity-progress-prose")).toHaveText("4 of 9 files · 44%");
  await expect(page.getByTestId("integrity-progress-bar")).toHaveAttribute("aria-valuenow", "44");

  // Throw the application away. Nothing survives this that a client is holding.
  await page.reload();
  await expect(page.getByTestId("inference-screen")).toBeVisible();

  await expect(page.getByTestId("integrity-progress-prose")).toHaveText("4 of 9 files · 44%");
  await expect(page.getByTestId("integrity-progress-bar")).toHaveAttribute("aria-valuenow", "44");
  // A check in flight is not a setup state: the connection is still ready.
  await expect(page.getByTestId("connection-status")).toContainText("Ready");
});

test("a check's bar moves on the poll alone and goes when it passes", async ({ page }) => {
  let read = 2;
  let passed = false;
  await serveApi(page, () =>
    connection(
      "ready",
      null,
      passed
        ? { state: "succeeded", files_read: 9, files_total: 9 }
        : { state: "running", files_read: read, files_total: 9 },
    ),
  );
  await openInference(page);
  await expect(page.getByTestId("integrity-progress-prose")).toContainText("22%");

  read = 8;
  await expect(page.getByTestId("integrity-progress-prose")).toContainText("89%");

  passed = true;
  // A pass leaves the row where it was, so `Ready` is the whole success treatment.
  await expect(page.getByTestId("integrity-progress")).toHaveCount(0);
  await expect(page.getByTestId("connection-status")).toContainText("Ready");
});

test("a check that found damage while nobody watched still says what was done", async ({
  page,
}) => {
  await serveApi(page, () =>
    connection("not_set_up", null, {
      state: "failed",
      files_read: 9,
      files_total: 9,
      error: "1 file does not match (model.safetensors). The damaged copies have been removed",
    }),
  );
  await openInference(page);

  const shown = page.getByTestId("integrity-error");
  await expect(shown).toContainText("model.safetensors");
  await expect(shown).toContainText("removed");
  // The verdict is the row's, and the remedy is the action it now declares.
  await expect(page.getByTestId("connection-status")).toContainText("Not set up");
  await expect(page.getByTestId("download-weights")).toBeEnabled();
});

test("a transfer and a re-read are two records on one row", async ({ page }) => {
  await serveApi(page, () =>
    connection(
      "ready",
      { state: "succeeded", bytes_done: 1.6 * GIGABYTE, bytes_total: 1.6 * GIGABYTE },
      { state: "running", files_read: 3, files_total: 9 },
    ),
  );
  await openInference(page);

  // Files here, and no byte count borrowed from the settled transfer beside it.
  await expect(page.getByTestId("integrity-progress-prose")).toHaveText("3 of 9 files · 33%");
  await expect(page.getByTestId("download-progress")).toHaveCount(0);
});
