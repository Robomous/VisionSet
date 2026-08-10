/**
 * The component-test harness — this package's, and not the annotator's.
 *
 * `@visionset/annotator` deliberately has **no jsdom**: its core is pure
 * TypeScript, and the annotator's own argument is that a component test of the
 * canvas would verify
 * nothing, because jsdom's `getBoundingClientRect` returns zeros and the transform
 * is the risky part. Neither reason applies here. These are ordinary DOM
 * components whose behaviour *is* markup and roles, and the schema editor
 * asks in so many words for "component tests for the editor's edit/validate/save
 * flow" — so the harness is stood up once, here, rather than by whichever screen
 * needs it first.
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Explicit imports from "vitest" in every test file, matching the annotator's
    // suite. Globals would make a test file's dependencies invisible.
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
  },
});
