/**
 * The built runtime, in a real Chromium.
 *
 * ## Why a browser suite and not vitest
 *
 * The vitest suite under `src/` drives the whole correlation table — ids, out-of-order
 * replies, cancellation, disposal — against a controllable channel, and it can say
 * nothing at all about the artifact. A module worker, `new URL("./worker.js",
 * import.meta.url)` resolving against a built file, and ONNX Runtime fetching and
 * instantiating a `.wasm` are all things jsdom does not have. The one question this
 * suite exists for is whether `dist/` actually runs, and only a browser can answer it.
 *
 * ## Why a server at all
 *
 * A module worker cannot be started from `about:blank`, and
 * `WebAssembly.instantiateStreaming` needs a real response with a real content-type.
 * So the harness is served over `http://127.0.0.1` by the small static server in
 * `browser/serve.mjs`, which serves this package's own directory — the page therefore
 * loads `dist/browser/index.js` and `dist/browser/ort/` exactly as a consumer would.
 * That is also why the build is the first link of `webServer.command`: the subject is
 * the artifact this run just produced.
 *
 * ## The port
 *
 * Derived from this worktree's path, for the reason `frontend/app/e2e-ports.ts` argues
 * at length: several checkouts run their gates on one machine at once, and a fixed port
 * makes a browser suite single-occupancy. The scheme is that file's — a 2048-wide band,
 * `LEGACY` in a main checkout, an environment override — with this suite's own band,
 * 24576, continuing after `media`'s 22528 so the two can run at the same time. It is
 * *not* imported from there: this package depends on no other workspace package, and a
 * test config is not the place to start.
 */

import { defineConfig, devices, type ReporterDescription } from "@playwright/test";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = realpathSync(path.resolve(HERE, "..", ".."));
const SLOTS = 2048;
const BAND = 24576;
const LEGACY = 5474;

/** `.git` is a directory in the main checkout and a file in a linked worktree. */
function linked(): boolean {
  try {
    return !statSync(path.join(ROOT, ".git")).isDirectory();
  } catch {
    return false;
  }
}

function resolvePort(): number {
  const stated = process.env["VISIONSET_INFERENCE_PORT"];
  if (stated !== undefined && stated.trim() !== "") {
    const port = Number(stated);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`VISIONSET_INFERENCE_PORT=${stated} is not a port number (want 1-65535).`);
    }
    return port;
  }
  if (!linked()) return LEGACY;
  return BAND + (createHash("sha256").update(ROOT).digest().readUInt32BE(0) % SLOTS);
}

const PORT = resolvePort();

/**
 * The machine-readable half of the require-not-skip gate.
 *
 * `VISIONSET_REQUIRE_BROWSER_MODELS=1` already makes `efficientSam.spec.ts` throw when the
 * exported graphs are absent. That catches the common accident and not the dangerous one: a
 * spec file that is renamed, moved out of `testDir`, filtered out by a stray `--grep`, or
 * quietly given a `test.skip()` never loads at all, so it cannot throw, and Playwright exits
 * 0 having run nothing. A green check would then mean "the command succeeded", not "the real
 * model ran" — which is the whole thing the browser-models job exists to assert.
 *
 * So under the flag the run also emits a JSON report, and
 * `scripts/browser_models/assert_tests_ran.mjs` reads it back and insists the real-model specs
 * are actually present, actually passed, and actually were not skipped.
 */
const REAL_MODEL_REQUIRED = process.env["VISIONSET_REQUIRE_BROWSER_MODELS"] === "1";
export const RESULTS_JSON = "playwright-report/results.json";

const REPORTERS: ReporterDescription[] = process.env["CI"]
  ? [["github"], ["html", { open: "never" }]]
  : [["list"]];
if (REAL_MODEL_REQUIRED) REPORTERS.push(["json", { outputFile: RESULTS_JSON }]);

if (process.env["TEST_WORKER_INDEX"] === undefined) {
  console.error(`[visionset] browser inference port: ${PORT}  (${ROOT})`);
}

export default defineConfig({
  testDir: "./browser",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: process.env["CI"] ? 2 : undefined,
  // Generous next to media's 30s: the first run in a page instantiates a 28 MB
  // WebAssembly module, and on a cold cache that is most of the budget.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: REPORTERS,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
    video: "off",
  },
  webServer: {
    command: `pnpm run build && node browser/serve.mjs ${PORT}`,
    cwd: HERE,
    url: `http://127.0.0.1:${PORT}/browser/harness.html`,
    // Never: the subject is the artifact this run just built, so a server somebody
    // left open would be serving an older `dist/`.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
