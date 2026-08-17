/**
 * `scripts/check.sh` says on **stdout** what it covered, and this is what keeps it
 * saying so.
 *
 * The script aborts correctly on a missing prerequisite — that was made
 * `require_node_modules` exit 2 rather than limp on. What it did not do is leave
 * any trace of that on the stream a caller captures: the message goes to stderr,
 * `All checks passed.` is structurally unreachable, and stdout carries some green
 * pytest output and then silence. Which is exactly what a *complete* run looks like
 * to an agent, a CI step, or a `$(…)`. The exit code is right, and nobody reads an
 * exit code out of a transcript. It is the same false-calm failure the script's own
 * header warns about for `| tail`, arriving from the other direction.
 *
 * So there is now one last line on stdout, from a `trap … EXIT` so no path out can
 * skip it:
 *
 *     check.sh: PASSED  ran=python,frontend,generated,browser  skipped=docs
 *
 * Two halves are held here, and they fail differently. The **behavioural** half
 * runs the real script against a copied tree with no `node_modules` — the issue's
 * own reproduction — and asserts the line arrives on stdout alone. The **static**
 * half holds the group roster to the dispatch `case`, because the way this rots is
 * not a deleted line but a group that quietly stops being dispatched: coverage
 * shrinks, every remaining stage passes, and the verdict line says PASSED about a
 * smaller run than the reader thinks.
 *
 * The subprocess runs with a PATH that has neither `uv` nor `pnpm` on it. That is
 * deliberate rather than incidental: it makes every step fail the same way on every
 * machine, so the FAILED case is a fixed outcome instead of a question about what
 * happens to be installed on the runner.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "check.sh");
const SOURCE = readFileSync(SCRIPT, "utf8");

/** Every group the script knows. The roster the assertions below are measured in. */
const GROUPS = ["python", "frontend", "generated", "browser", "docs"];

/**
 * The script, run against a directory that is only the script and its own pin.
 *
 * `root` is derived from `BASH_SOURCE`, so a copy two directories deep in a temp
 * dir *is* a workspace with nothing in it — no `node_modules`, no `pyproject.toml`,
 * nothing to check. Which is the state worth measuring, and the one a fresh worktree
 * is in before `pnpm install`.
 *
 * `.nvmrc` comes along because the script now reads it: the Node major is verified
 * before any group that needs Node runs, so without the file every such run stops at
 * that check instead of reaching the behaviour these tests are about. It is part of
 * the script's own contract rather than part of the tree being checked, which is why
 * it is copied while `pyproject.toml` and `node_modules` deliberately are not.
 */
function runCopied(...args) {
  const root = mkdtempSync(path.join(os.tmpdir(), "visionset-check-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(SCRIPT, path.join(root, "scripts", "check.sh"));
    copyFileSync(path.join(REPO, ".nvmrc"), path.join(root, ".nvmrc"));
    return spawnSync("bash", [path.join(root, "scripts", "check.sh"), ...args], {
      encoding: "utf8",
      // Neither `uv` nor `pnpm` is reachable here, so every step fails identically
      // whatever the machine has installed. `node` is, and has to be: the script
      // verifies the Node major before any group that needs one, so an unreachable
      // `node` would stop every run below at that check rather than at the
      // behaviour it is measuring. The one running these tests is the obvious
      // candidate and is the version CI pinned, so this narrows nothing.
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The verdict line, or `null` — read off **stdout**, which is the whole point. */
function verdictLine(result) {
  return result.stdout.split("\n").find((line) => line.startsWith("check.sh: ")) ?? null;
}

test("a run that stops before its groups says so on stdout, not only in the exit code", () => {
  // The issue's own reproduction: `generated` reaches `require_node_modules`
  // before it reaches anything else, and there is no `node_modules` here.
  const result = runCopied("generated");

  assert.equal(result.status, 2);
  assert.match(result.stderr, /node_modules is missing/);
  assert.equal(
    verdictLine(result),
    "check.sh: INCOMPLETE  ran=none  skipped=python,frontend,generated,browser,docs",
  );
});

test("INCOMPLETE and FAILED are different news, and the line tells them apart", () => {
  // Nothing was found *wrong* with the tree above — the checks did not happen.
  // Here they do happen and report problems, which is a different thing to be
  // told, and `ran=` still says how much of the gate the answer covers.
  const result = runCopied("python");

  assert.equal(result.status, 1);
  assert.equal(
    verdictLine(result),
    "check.sh: FAILED  ran=python  skipped=frontend,generated,browser,docs",
  );
});

test("a usage error is a verdict too, rather than a bare exit code", () => {
  const result = runCopied("nope");

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown group 'nope'/);
  assert.equal(
    verdictLine(result),
    "check.sh: INCOMPLETE  ran=none  skipped=python,frontend,generated,browser,docs",
  );
});

test("nothing having run keeps the browser banner quiet, so the real answer is on top", () => {
  // Twelve lines about the browser suites in front of `unknown group 'nope'`
  // buries the answer under the wrong warning. The banner is for a run that
  // happened and was partial; the verdict line covers the rest.
  assert.doesNotMatch(runCopied("nope").stderr, /THE BROWSER SUITES DID NOT RUN/);
  assert.match(runCopied("python").stderr, /THE BROWSER SUITES DID NOT RUN/);
});

test("the banner follows what ran, not what was asked for", () => {
  // `python` alone was never going to reach the browser, and neither does a run
  // that asked for everything and died in `frontend`. Keyed on the request, the
  // second one stays silent — which is the case it matters most in.
  const result = runCopied("python", "browser");

  assert.equal(verdictLine(result), "check.sh: FAILED  ran=python  skipped=frontend,generated,browser,docs");
  assert.match(result.stderr, /THE BROWSER SUITES DID NOT RUN/);
});

test("every group the script knows is dispatched, and every arm belongs to a group", () => {
  // The way this rots is not a deleted line: it is a group that quietly stops
  // being dispatched. Coverage shrinks, every remaining stage passes, and the
  // verdict says PASSED about a smaller run than the reader believes — the exact
  // shortened-run-that-looks-complete failure, one level up from stdout.
  const roster = SOURCE.match(/declare -a ALL_GROUPS=\(([^)]*)\)/);
  assert.ok(roster, "ALL_GROUPS is the roster the verdict line measures coverage against");
  assert.deepEqual(roster[1].trim().split(/\s+/), GROUPS);

  const dispatch = SOURCE.match(/for group in "\$\{groups\[@\]\}"; do\n\s*case "\$group" in\n([\s\S]*?)\n\s*\*\)/);
  assert.ok(dispatch, "the group loop dispatches through a case");
  const arms = [...dispatch[1].matchAll(/^\s*(\w+)\)/gm)].map((match) => match[1]);
  assert.deepEqual(arms, GROUPS);
});

test("the default run is every group, and --fast is that minus the browser", () => {
  // Two literals rather than one, because they are two decisions: what a bare
  // invocation covers, and what the documented shortcut gives up. A silent edit to
  // either is a shortened run nobody asked for.
  assert.match(SOURCE, /groups=\(python frontend generated\)/);
  assert.match(SOURCE, /\[\[ \$fast -eq 1 \]\] \|\| groups\+=\(browser\)/);
});

/**
 * The same copied tree, but with a `node` on PATH that reports whatever version it
 * is told to. A shim rather than a real installation: what the script reads is
 * `node --version`, so that is the whole of what has to be true, and asserting the
 * refusal must not depend on which Node majors happen to be on the machine.
 */
function runWithNodeVersion(version, ...args) {
  const root = mkdtempSync(path.join(os.tmpdir(), "visionset-check-node-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "bin"));
    copyFileSync(SCRIPT, path.join(root, "scripts", "check.sh"));
    copyFileSync(path.join(REPO, ".nvmrc"), path.join(root, ".nvmrc"));
    const shim = path.join(root, "bin", "node");
    writeFileSync(shim, `#!/bin/sh\necho '${version}'\n`);
    chmodSync(shim, 0o755);
    return spawnSync("bash", [path.join(root, "scripts", "check.sh"), ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(root, "bin")}:/usr/bin:/bin` },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a wrong Node major stops the run before any group, naming both versions", () => {
  // The failure this prevents does not look like a version problem: under Node 26
  // eight `ui-core` tests fail on a built-in `globalThis.localStorage` that is inert
  // without `--localstorage-file`, several minutes into the gate, reading as a
  // broken change. So the refusal happens first and says which two versions are in
  // play — a message naming only one of them leaves the reader to go and find the
  // other.
  const result = runWithNodeVersion("v26.7.0", "generated");

  assert.equal(result.status, 2);
  assert.match(result.stderr, /node is v26\.7\.0 but this repository is pinned to Node 24 by \.nvmrc/);
  // Before `require_node_modules`, which is three groups deep and would otherwise
  // be the first thing this run hit.
  assert.doesNotMatch(result.stderr, /node_modules is missing/);
  assert.equal(
    verdictLine(result),
    "check.sh: INCOMPLETE  ran=none  skipped=python,frontend,generated,browser,docs",
  );
});

test("the pinned major is let through, so the check is a gate and not a wall", () => {
  // The negative control, and it is the half that would go missing: a refusal that
  // fires for every version is indistinguishable from one that works, because both
  // produce a red gate on the machine that has the wrong Node.
  const result = runWithNodeVersion("v24.13.0", "generated");

  assert.doesNotMatch(result.stderr, /pinned to Node/);
  assert.match(result.stderr, /node_modules is missing/);
});

test("the group that needs no Node is not held to the pin", () => {
  // `python` reaches neither pnpm nor vitest, so refusing it would be refusing work
  // that would have succeeded — and a gate that over-refuses gets worked around.
  const result = runWithNodeVersion("v26.7.0", "python");

  assert.doesNotMatch(result.stderr, /pinned to Node/);
  assert.equal(
    verdictLine(result),
    "check.sh: FAILED  ran=python  skipped=frontend,generated,browser,docs",
  );
});

test("the verdict is printed from a trap, so no exit path can skip it", () => {
  // `require_node_modules` exits from three groups deep. A line at the bottom of
  // the script is not reached from there — which is how stdout came to be empty on
  // exactly the run that most needed to say something.
  assert.match(SOURCE, /^trap summary EXIT$/m);
  assert.match(SOURCE, /printf 'check\.sh: %s {2}ran=%s {2}skipped=%s\\n'/);
});
