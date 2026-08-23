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

import { availableParallelism } from "node:os";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * How many test files run at once, and why it is a quarter of the cores rather
 * than vitest's own default.
 *
 * Vitest's `forks` pool defaults to roughly one worker per logical core, and each
 * worker here builds a whole jsdom, a React root and a TanStack Query client. On a
 * 16-thread machine that measured 847% CPU — eight and a half cores of load that
 * this suite creates for itself, on eight physical ones. The tests that then miss
 * their deadline are not slow tests; they are the ones that happened to be holding
 * a core when the machine ran out (#555). Capped at four, the same suite ran clean
 * at a load average of 350, where the default failed at 140.
 *
 * Derived rather than fixed, for the reason `scripts/check.sh` gives for pytest's
 * `-n auto`: this is the command a contributor runs on whatever they have, and a
 * number chosen for a twenty-core desktop would throttle it on a four-core laptop.
 * The divisor is four rather than two because the count that held was half the
 * *physical* cores on a hyperthreaded box, and `availableParallelism` reports
 * logical ones. The floor of two keeps a two-core CI runner exactly where it
 * already was — GitHub's runners derive below the floor, so nothing about the
 * `frontend` job changes.
 *
 * It is close to free, which is worth stating because it sounds like it should not
 * be. Measured on an idle 16-thread machine, alternating: 41s and 42s at four
 * workers against 37s and 44s at vitest's default of fifteen. The suite's wall
 * time is bounded by its slowest *file*, not by how much CPU it can occupy —
 * `screens/models.test.tsx` alone is 23s of a 41s run, while all 51 files
 * together sum to 78s. Four workers therefore carry about 19s of work each, which
 * is under that critical path, and the workers past the fourth spend most of their
 * lives waiting for it. What the cap actually removes is the contention that made
 * the *other* fifty files miss a deadline.
 */
const MAX_WORKERS = Math.max(2, Math.floor(availableParallelism() / 4));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Explicit imports from "vitest" in every test file, matching the annotator's
    // suite. Globals would make a test file's dependencies invisible.
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    maxWorkers: MAX_WORKERS,
    /**
     * Not a loosening — the number this suite had already chosen three times.
     *
     * Vitest's 5000ms default is a bound for a pure function, and several tests
     * here are not that: they mount a screen under a real `ApiProvider`, wait on
     * TanStack Query and drive a dozen `userEvent` interactions. Three in
     * `models.test.tsx` are slower still by design — `CONNECTION_POLL_MS` is
     * 2000ms and they sleep 1.5 poll intervals to prove a poll *stopped*, which is
     * a negative that cannot be asserted any faster. Each of those three carried
     * its own `}, 15_000)` override; this is that decision made once, in the place
     * that applies to every test, so the next screen test to cross five seconds
     * does not have to rediscover it.
     *
     * It works only alongside the cap above. On its own a bigger timeout would
     * just move the load at which contention starts reading as failure, which is
     * the objection recorded on #555 and it is correct.
     */
    testTimeout: 15_000,
  },
});
