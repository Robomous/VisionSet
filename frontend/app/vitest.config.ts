/**
 * The app's own unit harness, for the one thing `ui-core` cannot test: the route
 * table. `ui-core` imports no router, so whether a URL lands on the right screen
 * — and where an old address redirects — is a claim only this package can make
 * without a browser. The browser suites (`e2e/`, `cycle/`) stay the place for
 * anything a real viewport decides.
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    // Both extensions. The app owns transport, token persistence, rail state and
    // its own layout-token assertions, and none of those is a component — so a
    // `.tsx`-only pattern silently skips them and reports green for a run that
    // discovered nothing.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
