/**
 * #59: the whole cycle in a browser, against a **real server and a real kernel**.
 *
 * Every other suite in this repository stubs the API — `annotate.spec.ts` holds
 * the routes still so a failure names the page, and the annotator's 76 scenarios
 * have no server at all. This one has no mocks anywhere: `visionset ui` serves the
 * compiled bundle out of `_static/` and the API off the same origin, exactly as the
 * wheel does, and Playwright drives the product from a pasted token to a downloaded
 * export.
 *
 * ## Why a second config rather than a second project
 *
 * The default suite runs against `vite` on 5273 with the dev proxy in front of a
 * server that does not exist. This one runs against the **built** bundle at
 * `/app/`, which is a different base URL, a different build and a different server.
 * A `projects[]` entry cannot carry a different `webServer`.
 *
 * It is also why the base URL ends in `/app/`: the API owns the root, so the bundle
 * is mounted under a prefix (#33), and the SPA deep-link fallback (#58) is what
 * makes a reload on `/app/projects/x` work at all. Driving the real mount is the
 * only way either of those is actually exercised.
 *
 * ## Retries and traces, which the issue asks for by name
 *
 * One retry in CI and a trace on it. A cycle this long has more places to be slow
 * than to be wrong, and a trace is what tells those apart after the fact.
 */

import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Where the workspace, the token and the fixture images live. */
const CYCLE_DIR =
  process.env["VISIONSET_CYCLE_DIR"] ?? mkdtempSync(path.join(tmpdir(), "visionset-cycle-"));

const PORT = process.env["VISIONSET_CYCLE_PORT"] ?? "8123";

/**
 * Put the directory back into the environment, for the **workers**.
 *
 * `webServer.env` reaches the server and nothing else, and the spec needs the same
 * path — the token was minted into it, and so were the fixture images. This file is
 * evaluated in the main process before any worker is forked, and a worker inherits
 * the environment it was forked with, so one assignment here is what the two halves
 * share.
 *
 * It failed exactly once, in CI, because locally the variable was always set on the
 * command line and the default branch never ran.
 */
process.env["VISIONSET_CYCLE_DIR"] = CYCLE_DIR;

export default defineConfig({
  testDir: "./cycle",
  fullyParallel: false,
  // One browser, one workspace, one SQLite file with one writer. The cycle is a
  // sequence — a project before a schema before a batch — so parallelism here
  // would not be faster, only wrong.
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/app/`,
    viewport: { width: 1440, height: 900 },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    // The whole stack, in the order the wheel builds it: engine, design system,
    // bundle, and the bundle copied into the package data `visionset ui` serves.
    command: [
      "pnpm --filter @visionset/annotator build",
      "pnpm --filter @visionset/ui-core build",
      "pnpm --filter @visionset/app build",
      "pnpm bundle:static",
      // `uv run`, which is what puts the virtualenv's `bin/` on PATH — so
      // `visionset` is the *installation under test* rather than whatever happens
      // to be on the developer's PATH, and `python3` inside the script is the one
      // with Pillow. The `e2e (cli)` job uses the same idiom for the same reason.
      "uv run bash scripts/cycle_server.sh",
    ].join(" && "),
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    url: `http://127.0.0.1:${PORT}/health`,
    // Never: this suite's whole subject is the *built* artifact, so reusing a
    // server somebody left running would test last week's bundle.
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { VISIONSET_CYCLE_DIR: CYCLE_DIR, VISIONSET_CYCLE_PORT: PORT },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

/** Exported so the spec finds the token and the images the server script wrote. */
export { CYCLE_DIR };
