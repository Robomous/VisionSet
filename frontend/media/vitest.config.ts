import { defineConfig } from "vitest/config";

// No jsdom: this package's core is plain TypeScript with no DOM dependency, the
// same argument @visionset/annotator's core makes for its own vitest run.
export default defineConfig({
  test: {
    // `src` only: `browser/` is the Playwright suite, and vitest collecting a
    // `*.spec.ts` full of `test.beforeEach` fails in a way that names neither runner.
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
