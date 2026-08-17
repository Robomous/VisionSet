// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// Every `unwrap` is paired with the check for the operation it actually calls.
//
// This gate exists because the compiler cannot provide it, and that is worth stating
// precisely rather than assuming. `unwrap<T>(result: FetchResult<T>, check: Check<T>)`
// makes a *missing* check a compile error — but not a *wrong* one: a type predicate is
// assignable whenever its asserted type is, so
//
//     unwrap(projectResult, checkDatasetOut)
//
// compiles cleanly and silently re-narrows the result to `ProjectOut`. Measured against
// this repo's own TypeScript before the mechanism was designed. So the required
// parameter buys "a check was passed" and this file buys "the right one".
//
// The set of files it buys it for is derived, never listed: a hardcoded caller list is
// an allowlist that goes stale silently the moment a new query module is added, and the
// gate then reports green over a surface it does not read. So the corpus is every
// tracked frontend source file, and a caller is any of them whose text calls `unwrap` —
// only the definition site and test files are excluded, each by its role.
//
// Like the other scanners here, the rules are pure functions proved on a synthetic
// corpus, so this file demonstrates a violation without containing one. It reads
// `git ls-files` (the index) so a merely staged file is gated before any commit lands.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { operationCheckName, repoRoot, responsesOf } from "../../scripts/generate_client.mjs";

/** The definition site: its prose quotes `unwrap(` verbatim, and it never calls it. */
const DEFINITION = "frontend/ui-core/src/data/errors.ts";

/**
 * The files among a corpus that call `unwrap`, and therefore have to be paired.
 *
 * The definition site is excluded by its path, and test files by their name — they
 * exercise the plumbing itself, against synthetic results the spec knows nothing about.
 */
export function unwrapCallers(files) {
  return files
    .filter(({ path: p }) => p !== DEFINITION && !/\.test\.[jt]sx?$/.test(p))
    .filter(({ text }) => /\bunwrap\(/.test(text))
    .map(({ path: p }) => p);
}

/**
 * Every `client.<METHOD>("<path>"` in one file, with the check identifier that follows it.
 *
 * Deliberately returns an entry for a call with **no** check rather than skipping it, so a
 * parse that misses cannot pass vacuously — every caller is asserted to yield at least one
 * pairing below.
 */
export function pairingsIn(text) {
  const found = [];
  const call = /\b\w+\.(GET|PUT|POST|DELETE|PATCH)\(\s*"([^"]+)"/g;
  let match;
  while ((match = call.exec(text)) !== null) {
    const after = text.slice(match.index);
    const check = after.match(/\bcheck[A-Z]\w*/);
    found.push({
      method: match[1],
      route: match[2],
      check: check === null ? null : check[0],
    });
  }
  return found;
}

/** Every complaint the pairing rule has about a corpus, judged against the spec's map. */
export function wrongChecks(files, expected) {
  const wrong = [];
  for (const { path: p, text } of files) {
    for (const pair of pairingsIn(text)) {
      const key = `${pair.method} ${pair.route}`;
      const wanted = expected.get(key);
      if (wanted === undefined) wrong.push(`${p}: ${key} is not an operation in the spec`);
      else if (pair.check !== wanted) {
        wrong.push(`${p}: ${key} should pass ${wanted}, not ${pair.check}`);
      }
    }
  }
  return wrong;
}

const corpus = () =>
  execFileSync("git", ["ls-files", "frontend"], { cwd: repoRoot(), encoding: "utf8" })
    .split("\n")
    .filter((line) => /\.[jt]sx?$/.test(line))
    .map((file) => ({ path: file, text: readFileSync(path.join(repoRoot(), file), "utf8") }));

const callers = () => {
  const files = corpus();
  const calling = new Set(unwrapCallers(files));
  return files.filter(({ path: p }) => calling.has(p));
};

const spec = () => JSON.parse(readFileSync(path.join(repoRoot(), "openapi.json"), "utf8"));

const expectedChecks = () =>
  new Map(
    responsesOf(spec()).map((answer) => [
      `${answer.method.toUpperCase()} ${answer.path}`,
      operationCheckName(answer.operationId),
    ]),
  );

test("the scan pairs a call with the check that follows it, and reports one that has none", () => {
  const sample = `
    unwrap(await client.GET("/projects", {}), checkListProjects),
    unwrap(await client.POST("/projects", { body }))
  `;
  assert.deepEqual(pairingsIn(sample), [
    { method: "GET", route: "/projects", check: "checkListProjects" },
    { method: "POST", route: "/projects", check: null },
  ]);
});

test("a caller no list names is discovered, and its wrong check reported", () => {
  // The gap this guards against: a new query module calling `unwrap` with a check the
  // compiler accepts and the spec refutes. Discovery must find the file with nobody
  // registering it anywhere, and the pairing rule must then name the mistake.
  const planted = [
    { path: DEFINITION, text: `export function unwrap<T>( // quotes unwrap( in prose` },
    { path: "frontend/ui-core/src/data/newQueries.test.ts", text: `unwrap(fake, checkFake)` },
    {
      path: "frontend/ui-core/src/data/newQueries.ts",
      text: `unwrap(await client.GET("/projects", {}), checkGetDataset)`,
    },
  ];
  assert.deepEqual(unwrapCallers(planted), ["frontend/ui-core/src/data/newQueries.ts"]);
  assert.deepEqual(
    wrongChecks(
      planted.filter(({ path: p }) => unwrapCallers(planted).includes(p)),
      new Map([["GET /projects", "checkListProjects"]]),
    ),
    [
      "frontend/ui-core/src/data/newQueries.ts: GET /projects should pass checkListProjects, not checkGetDataset",
    ],
  );
});

test("every API call names the check for its own operation", () => {
  const scanned = callers();
  const wrong = wrongChecks(scanned, expectedChecks());
  assert.deepEqual(wrong, [], wrong.join("\n"));

  // Two ways a broken scan would agree with an empty `wrong` list, each refused by an
  // assertion anchored to discovery rather than to a magic count: discovery finding no
  // callers at all, and a caller whose calls the pairing parse cannot read.
  assert.ok(scanned.length > 0, "no tracked file calls unwrap — discovery is broken");
  for (const { path: p, text } of scanned) {
    assert.ok(pairingsIn(text).length > 0, `${p} calls unwrap but the scan reads no API call in it`);
  }
});

test("no unwrap is left without a check", () => {
  // The compiler already refuses this, so the gate is belt and braces — but the two
  // catch different mistakes, and this one keeps working if the signature ever widens.
  for (const { path: p, text } of callers()) {
    for (const pair of pairingsIn(text)) {
      assert.notEqual(pair.check, null, `${p}: ${pair.method} ${pair.route} unwraps unchecked`);
    }
  }
});
