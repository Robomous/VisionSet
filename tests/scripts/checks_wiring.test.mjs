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
// Like the other scanners here, the rule is a pure function proved on a synthetic string,
// so this file demonstrates a violation without containing one. It reads `git ls-files`
// (the index) so a merely staged file is gated before any commit lands.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { operationCheckName, repoRoot, responsesOf } from "../../scripts/generate_client.mjs";

/** The files that are allowed to call `unwrap`, and therefore have to be paired. */
const CALLERS = [
  "frontend/ui-core/src/screens/queries.ts",
  "frontend/ui-core/src/annotator/jobQueries.ts",
  "frontend/ui-core/src/data/TokenGate.tsx",
];

/**
 * Every `client.<METHOD>("<path>"` in one file, with the check identifier that follows it.
 *
 * Deliberately returns an entry for a call with **no** check rather than skipping it, so a
 * parse that misses cannot pass vacuously — the count is asserted below.
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

const tracked = () =>
  execFileSync("git", ["ls-files", ...CALLERS], { cwd: repoRoot(), encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");

const spec = () => JSON.parse(readFileSync(path.join(repoRoot(), "openapi.json"), "utf8"));

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

test("every API call names the check for its own operation", () => {
  const expected = new Map(
    responsesOf(spec()).map((answer) => [
      `${answer.method.toUpperCase()} ${answer.path}`,
      operationCheckName(answer.operationId),
    ]),
  );

  const wrong = [];
  let counted = 0;
  for (const file of tracked()) {
    const text = readFileSync(path.join(repoRoot(), file), "utf8");
    for (const pair of pairingsIn(text)) {
      counted += 1;
      const key = `${pair.method} ${pair.route}`;
      const wanted = expected.get(key);
      if (wanted === undefined) wrong.push(`${file}: ${key} is not an operation in the spec`);
      else if (pair.check !== wanted) {
        wrong.push(`${file}: ${key} should pass ${wanted}, not ${pair.check}`);
      }
    }
  }

  assert.deepEqual(wrong, [], wrong.join("\n"));
  // A parse that silently found nothing would agree with an empty `wrong` list. The
  // repository has forty-odd of these; anything near zero means the scanner broke.
  assert.ok(counted > 30, `only ${counted} API calls found — the scan is not reading the files`);
});

test("no unwrap is left without a check", () => {
  // The compiler already refuses this, so the gate is belt and braces — but the two
  // catch different mistakes, and this one keeps working if the signature ever widens.
  for (const file of tracked()) {
    const text = readFileSync(path.join(repoRoot(), file), "utf8");
    for (const pair of pairingsIn(text)) {
      assert.notEqual(pair.check, null, `${file}: ${pair.method} ${pair.route} unwraps unchecked`);
    }
  }
});
