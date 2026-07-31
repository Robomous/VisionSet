/**
 * The benchmark's own Playwright project — #49, run by hand.
 *
 * A second config rather than a second project inside `playwright.config.ts`,
 * because almost everything the behavioural suite decided is wrong here: that
 * one runs `fullyParallel` against a dev server and retries a flake, and a
 * benchmark wants one worker, no retries, and a production build. Sharing a file
 * would mean every one of those settings growing a condition.
 *
 * ## A production build, and that is the whole reason for the separate server
 *
 * `vite dev` serves React's **development** build, where every hook is
 * instrumented and `StrictMode` double-invokes every render. Frame times from
 * there are two to five times pessimistic and describe a build nobody ships. So
 * this config builds the app and serves `vite preview`, which also makes
 * `StrictMode` a no-op — one decision closing both holes.
 *
 * The annotator is built first for the reason #47 recorded after losing a real
 * detour to it: `frontend/app` resolves `@visionset/annotator` through its
 * **`dist/`**, so an unbuilt engine change is invisible in the browser rather
 * than a compile error. A benchmark that quietly measured last week's engine
 * would be worse than no benchmark.
 *
 * ## No `reuseExistingServer`, ever
 *
 * The end-to-end suite reuses a server that is already answering, which is a
 * convenience there and a correctness bug here: the build **is** part of what is
 * being measured. `reuseExistingServer` also asks only whether *something*
 * answers 200 — the trap that had #48's first run driving v1's OrbStack stack on
 * vite's 5173 — so this takes port 5373 of its own, with `--strictPort` to turn a
 * clash into a refusal rather than a silent hop.
 *
 * ## Why `baseURL` carries a path, and why `--base` is passed by hand
 *
 * `vite.config.ts` sets `base: command === "build" ? "/ui/" : "/"`, because the
 * Python wheel serves the bundle under that prefix and the API owns the root
 * (#33). The trap, measured rather than reasoned about: **`vite preview` reports
 * `command` as `"serve"`**, so the config hands it `base: "/"` while the build it
 * is about to serve has `/ui/assets/…` baked into its `index.html`. The result is
 * not an error — the preview server's SPA fallback answers **200 with
 * `index.html`** for the missing script, so the page loads, the script silently
 * never runs, and every scenario fails hunting for a canvas on a blank page.
 *
 * `--base /ui/` on the preview command is the fix, and it belongs here rather
 * than in `vite.config.ts`: the application's config is right for the two things
 * it is asked about, and a benchmark is not a reason to complicate a shipped
 * build. Every page URL in `e2e/_bench.ts` is relative with no leading slash for
 * the same reason — see the note on `BENCH_PAGE`.
 */

import { defineConfig, devices } from "@playwright/test";

/** The end-to-end suite's viewport, so a coordinate means the same thing in both. */
const VIEWPORT = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "./bench",
  // `*.bench.ts`, so the default `*.spec.ts` glob keeps these out of the
  // behavioural suite and the two are never run by accident together.
  testMatch: "**/*.bench.ts",
  // A benchmark shares the machine with nothing, and a retried measurement is
  // two measurements of different conditions.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5373/ui/",
    viewport: VIEWPORT,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command:
      "pnpm --filter @visionset/annotator build && vite build && vite preview --base /ui/ --port 5373 --strictPort",
    url: "http://localhost:5373/ui/",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: VIEWPORT } }],
});
