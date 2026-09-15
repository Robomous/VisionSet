/**
 * The mediabunny adapter, in a real Chromium.
 *
 * ## Why a browser suite and not jsdom
 *
 * Everything this adapter does is a browser primitive jsdom does not have: a module
 * worker, `VideoDecoder`, `OffscreenCanvas`, `convertToBlob`. A mocked decoder would
 * assert that the mock was called, which is worth nothing here — the questions are
 * "which frame came back" and "was the decoder released", and only a decoder can
 * answer them.
 *
 * ## Why a server at all
 *
 * WebCodecs is gated on a secure context. Measured on this repository's Chromium: on
 * `about:blank` `VideoEncoder`, `VideoDecoder` and the rest are all `undefined`. So the
 * harness is served over `http://127.0.0.1`, which Chromium treats as trustworthy, by
 * a twenty-line static server in `browser/serve.mjs`. It serves this package's own
 * directory, so the page loads the built `dist/` exactly as a consumer would — which is
 * also why the build is the first link of `webServer.command`, the same reason
 * `frontend/app/playwright.config.ts` builds the engine before starting vite.
 *
 * ## The port
 *
 * Derived from this worktree's path, for the reason `frontend/app/e2e-ports.ts` argues
 * at length: several checkouts run their gates on one machine at once, and a fixed
 * port makes a browser suite single-occupancy. The scheme is that file's — a 2048-wide
 * band, `LEGACY` in a main checkout, `VISIONSET_MEDIA_PORT` to override — with this
 * suite's own band, 22528, continuing after `bench`. It is *not* imported from there:
 * `@visionset/media` depends on no other workspace package, and a test config is not
 * the place to start.
 */

import { defineConfig, devices } from "@playwright/test";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = realpathSync(path.resolve(HERE, "..", ".."));
const SLOTS = 2048;
const BAND = 22528;
const LEGACY = 5473;

/** `.git` is a directory in the main checkout and a file in a linked worktree. */
function linked(): boolean {
  try {
    return !statSync(path.join(ROOT, ".git")).isDirectory();
  } catch {
    return false;
  }
}

function resolvePort(): number {
  const stated = process.env["VISIONSET_MEDIA_PORT"];
  if (stated !== undefined && stated.trim() !== "") {
    const port = Number(stated);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`VISIONSET_MEDIA_PORT=${stated} is not a port number (want 1-65535).`);
    }
    return port;
  }
  if (!linked()) return LEGACY;
  return BAND + (createHash("sha256").update(ROOT).digest().readUInt32BE(0) % SLOTS);
}

const PORT = resolvePort();

if (process.env["TEST_WORKER_INDEX"] === undefined) {
  console.error(`[visionset] media browser port: ${PORT}  (${ROOT})`);
}

export default defineConfig({
  testDir: "./browser",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: process.env["CI"] ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],
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
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
