/**
 * The behavioural contract: v1's Playwright specs, re-pointed at the annotator demo.
 *
 * ## Why the suite lives here and not at the repository root
 *
 * v1 kept its specs in a root `e2e/`, beside `frontend/` and `backend/`, because it
 * had a backend to drive. This suite drives one page and no server, so it lives
 * beside the page — and that placement buys a gate. `tests/scripts/annotator_boundary.test.mjs`
 * scans `git ls-files frontend` for `new (Keyboard|Pointer|Mouse|Touch)Event(` and
 * `dispatchEvent(`; a spec under `frontend/` is therefore held to the same rule the
 * engine is, which is exactly the discipline an end-to-end suite should be under.
 * It must drive real input through `page.mouse` and `page.keyboard` rather than
 * reaching into the page to synthesize an event — a suite that fakes its own input
 * proves nothing about the adapter that would have received the real one.
 *
 * ## Why the script is `e2e` and never `test`
 *
 * Root `pnpm test` is `pnpm -r test && pnpm test:scripts`. Naming this package's
 * script `test` would put a browser download inside the existing `frontend` CI job
 * on every pull request. It gets its own job instead — the precedent is #37's
 * `e2e (http|cli|mcp)` matrix, a job that pays for its own setup.
 *
 * ## The server builds the engine first, deliberately
 *
 * `frontend/app` resolves `@visionset/annotator` through its **`dist/`**, so an
 * unbuilt engine change is invisible in the browser rather than a compile error —
 * the workflow gotcha #47 recorded after losing a real detour to it. Encoding the
 * build in `webServer.command` is what stops a green run against last week's engine.
 * The cost is that `reuseExistingServer` skips it locally: if the demo behaves like
 * an older build, kill the dev server you already had open.
 *
 * ## A port of its own, and one per worktree
 *
 * `reuseExistingServer` asks only whether *something* answers on the URL, and
 * anything returning 200 will do. The first run of this suite proved the point by
 * driving v1's stack: an OrbStack container already held 5173, so twelve scenarios
 * failed hunting for a canvas on somebody else's application. A dedicated port
 * makes the reuse a reuse of *our* server and `--strictPort` turns a clash into a
 * refusal rather than a silent hop to the next number. `polygon.spec.ts`'s first
 * scenario still checks the demo's own heading, because a port is a convention and
 * an assertion is a guarantee.
 *
 * One dedicated port was not enough once several worktrees started running their
 * gates at once, so since #346 the number is derived from this worktree's own path —
 * 5273 in the main checkout and in CI, its own elsewhere. `e2e-ports.ts` argues it
 * and `--guard` refuses the run, saying where the number came from, if somebody is
 * already on it.
 */

import { defineConfig, devices } from "@playwright/test";

import { PORT, announce } from "./e2e-ports.ts";

announce();

/**
 * Large enough that the 1280x720 asset fits at a zoom around 0.80 rather than the
 * 0.68 a 1280x720 window gives — 18% more screen separation between targets, free.
 *
 * No spec assumes the number. `e2e/_frame.ts` reads the scale off the `<svg>`'s own
 * bounding box, because the demo ships no CSS reset: `body` keeps its default 8px
 * margin, the page is `100vh` plus that, and the resulting always-present scrollbar
 * moves the fit by about 1.5% — which is more than a tolerance is wide.
 */
const VIEWPORT = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "./e2e",
  // v1 could not parallelise: its specs shared one server and deleted every
  // annotation in `beforeEach`. This demo's state is per page and starts empty, so
  // no spec needs a reset hook and every test gets its own document.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A flake is reported as flaky rather than hidden, and the retry carries a trace.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT.e2e}`,
    viewport: VIEWPORT,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command:
      // First, so a taken port is a sentence rather than a minute of building
      // followed by vite's own four words about it.
      "node e2e-ports.ts --guard e2e && " +
      "pnpm --filter @visionset/annotator build && " +
      "pnpm --filter @visionset/ui-core build && " +
      `vite --port ${PORT.e2e} --strictPort`,
    url: `http://localhost:${PORT.e2e}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  // Chromium only, as v1 was. The subject of every scenario here is pointer and
  // keyboard semantics, and the React adapter implements those one way; tripling
  // the browser download would buy rendering coverage nothing in this suite asserts.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: VIEWPORT } }],
});
