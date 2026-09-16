// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// `scripts/browser_models/assert_tests_ran.mjs` is the guard that makes the browser-models
// job's green check mean "the real EfficientSAM-Ti graphs ran in Chromium" rather than "the
// command exited 0". A guard that cannot fail is worth nothing, so each way a run can fail to
// prove itself is exercised here against a report shaped like Playwright's.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MINIMUM_REAL_MODEL_SPECS,
  REAL_MODEL_SPEC,
  reasonsNotProven,
} from "../../scripts/browser_models/assert_tests_ran.mjs";

/** Playwright nests `suites` inside a per-file suite; the shape matters more than the titles. */
function report({ count = MINIMUM_REAL_MODEL_SPECS, status = "expected", ok = true, file } = {}) {
  const specs = Array.from({ length: count }, (_, index) => ({
    title: `real model test ${index}`,
    ok,
    tests: [{ status }],
  }));
  return {
    errors: [],
    suites: [
      {
        title: file ?? REAL_MODEL_SPEC,
        file: file ?? REAL_MODEL_SPEC,
        specs: [],
        suites: [{ title: "EfficientSAM-Ti in a real browser", specs }],
      },
    ],
  };
}

test("a full passing run is proof", () => {
  assert.deepEqual(reasonsNotProven(report()), []);
});

test("more tests than the floor is still proof", () => {
  assert.deepEqual(reasonsNotProven(report({ count: MINIMUM_REAL_MODEL_SPECS + 3 })), []);
});

test("a run with no real-model tests at all is refused", () => {
  const reasons = reasonsNotProven({ errors: [], suites: [] });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /found 0/);
});

test("a spec file that is not the real-model one does not count", () => {
  // The failure this exists for: `runtime.spec.ts` runs its tiny hand-built ONNX graph and
  // passes, which says nothing about EfficientSAM-Ti.
  const reasons = reasonsNotProven(report({ file: "runtime.spec.ts" }));
  assert.match(reasons.join("\n"), /found 0/);
});

test("losing a test drops below the floor", () => {
  const reasons = reasonsNotProven(report({ count: MINIMUM_REAL_MODEL_SPECS - 1 }));
  assert.match(reasons.join("\n"), new RegExp(`at least ${MINIMUM_REAL_MODEL_SPECS}`));
});

test("a skipped real-model test is refused, and named as skipped", () => {
  const reasons = reasonsNotProven(report({ status: "skipped", ok: true }));
  assert.equal(reasons.length, MINIMUM_REAL_MODEL_SPECS);
  assert.match(reasons[0], /was skipped/);
});

test("a failing real-model test is refused", () => {
  const reasons = reasonsNotProven(report({ status: "unexpected", ok: false }));
  assert.match(reasons.join("\n"), /did not pass/);
});

test("a top-level run error is refused even when the tests look fine", () => {
  // A worker that crashes after its tests report can leave passing specs beside a run error.
  const proven = report();
  proven.errors = [{ message: "worker process exited unexpectedly" }];
  const reasons = reasonsNotProven(proven);
  assert.match(reasons.join("\n"), /worker process exited unexpectedly/);
});

test("the floor names a real number of tests", () => {
  assert.ok(MINIMUM_REAL_MODEL_SPECS > 0);
  assert.equal(REAL_MODEL_SPEC, "efficientSam.spec.ts");
});
