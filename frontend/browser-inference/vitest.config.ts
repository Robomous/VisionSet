import { defineConfig } from "vitest/config";

// No jsdom: this package's core is plain TypeScript with no DOM dependency, and a
// DOM environment would hide the thing these tests are for — that the correlation
// table, the capability logic and the error contract all hold outside a browser.
export default defineConfig({
  test: {
    // `src` only: `browser/` is the Playwright suite, and vitest collecting a
    // `*.spec.ts` full of `test.beforeEach` fails in a way that names neither runner.
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
