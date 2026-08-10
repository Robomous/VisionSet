/**
 * The end-to-end suite has no fixed waits, and this is what keeps it that way.
 *
 * v1's four specs are built on `waitForTimeout(80 | 100 | 200 | 300 | 500 | 2000)` —
 * load-bearing sync points, because nothing on its page exposed a settled state. The
 * port needs none: the demo publishes `counts` and `wire`, React 19 flushes discrete
 * events synchronously, and every assertion is either web-first or an `expect.poll`.
 *
 * That property decays on the first flaky afternoon unless something holds it. So it
 * is held, on the bargain `annotator_boundary.test.mjs` already runs on: the rule is
 * a pure function, which is what lets this file prove "it fails on a violation"
 * while containing none. It reads `git ls-files`, i.e. the **index**, so a merely
 * staged spec is checked before any commit lands and `node_modules/` and
 * `test-results/` stay out for free rather than by a list somebody maintains.
 *
 * When a sleep looks necessary, the demo has stopped exposing the state the
 * scenario needs. The fix is a `data-testid`, not a timeout.
 *
 * `frontend/app/bench/` is under the same rule. That directory times
 * things, so it is the one place where "wait a moment for it to settle" reads as
 * reasonable — and the one place a fixed wait does the most damage, since it
 * lands inside the window being measured. The benchmark waits on
 * `requestAnimationFrame` instead, which is a frame having happened rather than a
 * duration having elapsed, so the rule costs it nothing at all.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Both browser-driven suites. `bench/` is under the rule rather than being
// exempted from it: a benchmark is the file most tempted to sleep — "give it a
// moment to settle" is the obvious way to write one — and it is also the file a
// sleep corrupts most, because a fixed wait lands inside the window being timed.
// `bench/_sampler.ts` waits on `requestAnimationFrame` instead, which is a frame
// having happened, so the rule costs it nothing.
const SUITES = ["frontend/app/e2e", "frontend/app/bench"];

// Assembled at runtime from two fragments so this file does not match itself — the
// same trick, for the same reason, as the synthetic-event scan next door.
const WAIT = ["waitFor", "Timeout"].join("");
// `.*` and not `[^)]*` for the hand-rolled sleep: the idiomatic spelling is
// `new Promise((r) => setTimeout(r, 50))`, whose first `)` closes the arrow
// function's own parameter list, so a negated-paren class never reaches the call it
// is looking for. Caught by this file's own first test, which is what it is for.
const SLEEPS = new RegExp(String.raw`\.${WAIT}\s*\(|networkidle|new\s+Promise\b.*setTimeout`);
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;
const SOURCE = /\.(?:ts|tsx|mjs)$/;

/** Every `file:line` in `text` that waits on a clock instead of on a state. */
function sleepsIn(file, text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => !COMMENT.test(line) && SLEEPS.test(line))
    .map(({ line, at }) => `${file}:${at}: ${line.trim()}`);
}

test("the scan finds v1's sync points, and nothing that merely mentions them", () => {
  assert.deepEqual(sleepsIn("v1.spec.ts", `  await page.${WAIT}(200);`), [
    `v1.spec.ts:1: await page.${WAIT}(200);`,
  ]);
  assert.deepEqual(
    sleepsIn("v1.spec.ts", `  await page.waitForLoadState('networkidle');`),
    ["v1.spec.ts:1: await page.waitForLoadState('networkidle');"],
  );
  assert.deepEqual(
    sleepsIn("h.ts", "  await new Promise((r) => setTimeout(r, 50));"),
    ["h.ts:1: await new Promise((r) => setTimeout(r, 50));"],
  );
  // A docstring explaining the rule must pass, or the gate would forbid the files
  // that make it true — `polygon.spec.ts` quotes v1's own numbers.
  assert.deepEqual(sleepsIn("d.ts", ` * v1 used \`${WAIT}(80)\` between clicks.`), []);
  // And the waits that are *not* clocks stay legal.
  assert.deepEqual(sleepsIn("s.ts", "  await page.waitForURL(/x/);"), []);
  assert.deepEqual(sleepsIn("s.ts", "  await expect.poll(read).toBe(1);"), []);
});

test("no end-to-end scenario waits on a clock", () => {
  const offenders = [];
  for (const suite of SUITES) {
    const listed = spawnSync("git", ["ls-files", "-z", suite], { cwd: REPO, encoding: "utf8" });
    assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
    const tracked = listed.stdout.split("\0").filter((name) => SOURCE.test(name));
    // Asserted per suite, not over the union: a renamed or emptied directory would
    // otherwise be covered by its neighbour and the scan would quietly prove less
    // than it says.
    assert.ok(tracked.length > 0, `the scan found no sources under ${suite}, so it proves nothing`);
    offenders.push(
      ...tracked.flatMap((file) => sleepsIn(file, readFileSync(path.join(REPO, file), "utf8"))),
    );
  }
  assert.deepEqual(
    offenders,
    [],
    "wait on a state, not on a clock — if there is no state to wait on, the demo " +
      `needs a data-testid:\n${offenders.join("\n")}`,
  );
});
