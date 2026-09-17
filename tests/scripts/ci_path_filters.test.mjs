// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// `.github/path-filters.yml` decides which CI jobs a change wakes up, and getting
// it wrong is quiet in both directions: too broad and a `CHANGELOG.md` edit pays
// for a torch download (#867), too narrow and a suite stops running with nothing
// red to read. Neither shows up in a diff — the file looks reasonable either way —
// so the routing is pinned here against named example paths instead.
//
// `scripts/check_ci_path_coverage.mjs` answers the other half: that no tracked
// path falls outside every group. This answers *which* group, for the handful of
// paths whose answer someone would actually notice being wrong.
//
// No YAML parser here either, for the reason `cooldown.test.mjs` gives: the file
// is kept to a subset narrow enough to match by hand, and the checker refuses any
// line outside it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILTERS = path.join(ROOT, ".github", "path-filters.yml");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "ci.yml");

/** The same subset the coverage checker reads, parsed the same way. */
function groups() {
  const parsed = new Map();
  let current = null;
  for (const line of readFileSync(FILTERS, "utf8").split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const header = /^([A-Za-z][A-Za-z0-9_-]*):$/.exec(line);
    if (header) {
      current = header[1];
      parsed.set(current, []);
      continue;
    }
    const entry = /^ {2}- "([^"]+)"$/.exec(line);
    assert.ok(entry, `unparseable line in path-filters.yml: ${line}`);
    parsed.get(current).push(entry[1]);
  }
  return parsed;
}

const fires = (patterns, file) =>
  patterns.some((p) => (p.endsWith("/**") ? file.startsWith(p.slice(0, -2)) : file === p));

/** Which groups a one-file change would set to `true`. */
function groupsFor(file) {
  const hit = [];
  for (const [name, patterns] of groups()) if (fires(patterns, file)) hit.push(name);
  return hit.sort();
}

test("a changelog-only change wakes nothing — the case that motivated this file", () => {
  // #867: this ran the whole suite, twice, because the groups were written as
  // "everything except" and nobody had thought of CHANGELOG.md.
  assert.deepEqual(groupsFor("CHANGELOG.md"), ["inert"]);
});

test("the other root-level prose files are inert too", () => {
  for (const file of ["CONTRIBUTING.md", "DESIGN.md", "AGENTS.md", ".editorconfig"]) {
    assert.deepEqual(groupsFor(file), ["inert"], `${file} should wake no job`);
  }
});

test("kernel source wakes Python and the dev image, and neither browser suite", () => {
  // The dev image installs from `src/`, which is how a Python-only change once
  // broke it with no `docker/` file touched — see the `docker` job's comment.
  assert.deepEqual(groupsFor("src/visionset/kernel/domain/batch.py"), ["docker", "python"]);
});

test("frontend source wakes only the frontend jobs", () => {
  assert.deepEqual(groupsFor("frontend/app/src/main.tsx"), ["frontend"]);
});

test("what the real-model e2e suite exercises wakes the job that runs it for real", () => {
  // `browserSuggestion.spec.ts` self-skips without the ONNX artifacts and the
  // `VISIONSET_REQUIRE_BROWSER_MODELS` flag, both of which only the `browser-models`
  // job supplies. So every file that suite drives has to wake that job by name: a
  // change reaching only `frontend` is a change whose one real-browser proof ran
  // nothing and still reported green.
  for (const file of [
    "frontend/app/src/data/browserInference/BrowserInferenceRuntime.ts",
    "frontend/app/vite.config.ts",
    "frontend/app/playwright.config.ts",
    "frontend/ui-core/src/inference/browserPort.ts",
    "frontend/ui-core/src/annotator/SuggestPanel.tsx",
    "frontend/ui-core/src/annotator/AnnotationPage.tsx",
  ]) {
    assert.deepEqual(groupsFor(file), ["browser-models", "frontend"], file);
  }
});

test("documentation wakes only the docs site", () => {
  assert.deepEqual(groupsFor("docs/content/install.md"), ["docs"]);
});

test("these script tests wake the job that actually runs them", () => {
  // `pnpm test:scripts` is the tail of `pnpm test`, which is the *frontend* job's
  // last step — pytest never collects a `.test.mjs`. Routing these to `python`
  // alone would mean editing one of them runs every suite except this one.
  assert.ok(
    groupsFor("tests/scripts/ci_path_filters.test.mjs").includes("frontend"),
    "tests/scripts/** must wake the frontend job, which is where pnpm test:scripts runs",
  );
});

test("the API contract wakes both sides of it", () => {
  // Python regenerates it and fails on drift; the frontend regenerates its client
  // from it and fails on drift. A change here has to face both.
  assert.deepEqual(groupsFor("openapi.json"), ["frontend", "python"]);
});

test("this workflow and this file wake everything they gate", () => {
  // A change to the gating itself is the one change that must re-validate every
  // job — otherwise a filter edit is only ever tested by the jobs it did not skip.
  for (const file of [".github/workflows/ci.yml", ".github/path-filters.yml"]) {
    assert.deepEqual(groupsFor(file), ["browser-models", "docker", "docs", "frontend", "python"], file);
  }
});

test("every group ci.yml reads is one this file defines", () => {
  // A hyphenated group name (`browser-models`) cannot use dot access at all —
  // `needs.changes.outputs.browser-models` is not valid expression syntax — so
  // every read of one is bracketed instead: `needs.changes.outputs['browser-models']`.
  const defined = new Set(groups().keys());
  const read = new Set(
    [
      ...readFileSync(WORKFLOW, "utf8").matchAll(
        /needs\.changes\.outputs(?:\.([a-z]+)|\['([a-z-]+)'\])/g,
      ),
    ].map((m) => m[1] ?? m[2]),
  );
  assert.ok(read.size > 0, "ci.yml reads no group at all — the gating is disconnected");
  for (const name of read) {
    assert.ok(defined.has(name), `ci.yml reads needs.changes.outputs for '${name}', which is not a group`);
  }
});

test("every group this file defines is published by the changes job", () => {
  // A group nobody publishes is a group nobody can read: `needs.changes.outputs.x`
  // resolves to an empty string, every `== 'true'` is false, and the jobs meant to
  // run for it silently stop. `inert` is the deliberate exception. Same dot-vs-bracket
  // split as the read side: a hyphenated name is only ever valid bracketed.
  const workflow = readFileSync(WORKFLOW, "utf8");
  for (const name of groups().keys()) {
    if (name === "inert") continue;
    const accessor = name.includes("-") ? `\\['${name}'\\]` : `\\.${name}`;
    assert.match(
      workflow,
      new RegExp(`^\\s{6}${name}: \\$\\{\\{ steps\\.filter\\.outputs${accessor} \\}\\}$`, "m"),
      `the changes job does not publish an output for the '${name}' group`,
    );
  }
});

test("no job is gated at the job level, which would leave a required check unreported", () => {
  // The hazard CONTRIBUTING.md's release-gate section names: a required job that
  // does not report on some pull requests wedges every future merge on a check
  // that never arrives. Gating lives on steps; `if: always()` keeps the job itself
  // unconditional.
  const workflow = readFileSync(WORKFLOW, "utf8");
  const jobLevelIf = [...workflow.matchAll(/^ {4}if: (.+)$/gm)].map((m) => m[1]);
  for (const condition of jobLevelIf) {
    assert.ok(
      condition === "always()" || condition.startsWith("github.event_name =="),
      `job-level 'if: ${condition}' can leave a required check unreported — gate the ` +
        "steps and keep the job on always()",
    );
  }
});

test("every gated step opens the gate when the changes job did not succeed", () => {
  // Fail open: a broken filter must run the work, not skip it. Every step
  // condition that reads a group has to carry the escape hatch beside it.
  const workflow = readFileSync(WORKFLOW, "utf8");
  const stepIfs = [...workflow.matchAll(/^ {8}if: (.+)$/gm)].map((m) => m[1]);
  const gated = stepIfs.filter((c) => c.includes("needs.changes.outputs"));
  assert.ok(gated.length > 0, "no step reads a group — the gating is disconnected");
  for (const condition of gated) {
    assert.ok(
      condition.includes("needs.changes.result != 'success'"),
      `step condition skips work when the filter itself broke: ${condition}`,
    );
  }
});

test("the coverage checker passes on the tree as committed", () => {
  execFileSync("node", ["scripts/check_ci_path_coverage.mjs"], { cwd: ROOT, stdio: "pipe" });
});
