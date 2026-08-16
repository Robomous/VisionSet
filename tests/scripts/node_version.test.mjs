// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// The Node version this repository builds and tests under is declared in exactly one
// place, `.nvmrc`, and this holds every other spelling of it to that file.
//
// Before `.nvmrc` existed the version was ten copies of the literal `24` — eight
// `actions/setup-node` steps across two workflows and two Dockerfile base images —
// and nothing at all that `scripts/check.sh` or a developer's shell could read. So
// the gate's answer depended on whichever `node` happened to be on PATH, and the way
// that failure arrives is the bad kind: Node 26 ships a built-in
// `globalThis.localStorage` that is inert without `--localstorage-file` and takes
// precedence over the one the test environment supplies, so eight `ui-core` tests
// across two files fail on storage they never touched. Nothing in that output says
// "wrong interpreter".
//
// The workflows read `.nvmrc` directly through `node-version-file`, so they cannot
// drift and are checked here only for the absence of a literal creeping back. The
// Dockerfiles genuinely cannot: a `FROM` is resolved before any build context is
// available, so the major is written out and this is what keeps it honest.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

const PINNED = read(".nvmrc").trim();

const workflows = () =>
  readdirSync(join(ROOT, ".github", "workflows")).filter((name) => name.endsWith(".yml"));

test(".nvmrc names a bare major, which is what every reader of it expects", () => {
  // A major rather than a full version, because that is what CI installs and what a
  // patch release must not invalidate. `check.sh` takes the major of both sides, so a
  // full version here would still work there — but `node:24.13.0-bookworm-slim` is not
  // a tag Docker publishes, and the comparison below would start failing for a reason
  // that has nothing to do with drift.
  assert.match(PINNED, /^\d+$/, `.nvmrc must hold a bare major, not ${JSON.stringify(PINNED)}`);
});

test("every workflow installs Node by reading .nvmrc rather than by naming a version", () => {
  for (const name of workflows()) {
    const text = read(".github", "workflows", name);
    if (!text.includes("setup-node")) continue;
    assert.ok(
      !/^\s*node-version:/m.test(text),
      `.github/workflows/${name} names a Node version literally — use ` +
        "`node-version-file: .nvmrc` so there is one place to change it",
    );
    assert.match(
      text,
      /^\s*node-version-file:\s*\.nvmrc\s*$/m,
      `.github/workflows/${name} uses setup-node without pointing it at .nvmrc`,
    );
  }
});

test("every Dockerfile that starts from a Node image starts from the pinned major", () => {
  // The one place the version is legitimately duplicated, and therefore the one that
  // can drift silently: a stale base image builds and runs, and only produces the
  // localStorage-shaped confusion above once somebody looks at a test result.
  const dockerfiles = readdirSync(join(ROOT, "docker")).filter((name) =>
    name.endsWith(".Dockerfile"),
  );
  const seen = [];
  for (const name of dockerfiles) {
    for (const [, major] of read("docker", name).matchAll(/^FROM\s+node:(\d+)[.\-]/gm)) {
      seen.push(name);
      assert.equal(
        major,
        PINNED,
        `docker/${name} builds on Node ${major} while .nvmrc pins ${PINNED}`,
      );
    }
  }
  // An absence assertion on its own would pass just as well against a regex that
  // stopped matching anything, which is the failure this whole file exists to catch a
  // version of.
  assert.ok(seen.length > 0, "no Dockerfile FROM node:<major> was found — has the pattern moved?");
});
