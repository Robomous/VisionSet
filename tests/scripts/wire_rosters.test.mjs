// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// The two transcriptions of the wire's action tables must agree with the kernel,
// and with each other.
//
// `allowed_actions` is answered by `kernel/domain/capabilities.py`, and two test
// doubles stand in for that answer:
//
//   frontend/ui-core/src/testing/wire.fixtures.ts
//   frontend/app/e2e/_wire.ts
//
// Both are typed against the generated vocabularies, and that holds *membership*
// only — `tsc` refuses a value outside the union, which is what catches a
// withdrawn `BatchAction.DELETE`, and nothing else: the *rows* are hand-written,
// so a member the kernel gains and nobody transcribes is invisible to the compiler.
// When the e2e stub was still `string[]` a withdrawn member surfaced only as every
// gallery spec timing out, because `checks.ts` rejects the payload inside a hook,
// and 2590 pytest, both vitest suites, mypy, ruff, lint-imports,
// `generate:client:check` and `typecheck:e2e` were green the whole time.
//
// ## What this proves
//
// Each double says what the kernel says, state by state, in both directions — and
// the two doubles say the same thing as each other. The kernel's answer reaches
// here as `tests/fixtures/wire_capabilities.json`, written by
// `scripts/export_wire_fixtures.py` from `batch_actions` &c. and held fresh by
// `tests/server/test_wire_fixtures.py`, because the `frontend` CI job installs no
// Python — the same bytes-across-the-boundary arrangement as `openapi.json` and the
// annotator's `wire_annotations.json`. The double-to-double comparison stays
// because its failure names the two files that disagree, which is the message a
// unilateral edit deserves; it used to be the only comparison, and it could not
// see a member both doubles lacked — which is exactly what happened when
// `pre_label` joined `BatchAction` and neither roster was told.
//
// Ordering, stated precisely because it is easy to overclaim: this runs in the
// `frontend` CI job, which today completes before `annotator e2e (chromium)`. That is
// job scheduling, not a structural dependency — nothing makes the browser suite wait
// on this gate.
//
// ## Mechanism
//
// The rosters are read by parsing both files as text. Importing them is not on the
// table: `_wire.ts` is TypeScript that `node --test` cannot load, and reaching
// `wire.fixtures.ts` through `@visionset/ui-core` would mean exporting it — an API
// widening nobody asked for. Parsing is therefore the least-brittle mechanism
// *available*, and it is made tolerant of reformatting rather than of rewriting:
// comments are stripped with a scanner that respects string literals, the object
// literal is found by brace balancing rather than by line, and keys may be bare or
// quoted with the array on one line or many. Renaming a constant or changing the
// declaration form will fail this gate — correctly, and with a message that says so,
// because a roster this file can no longer see is a roster nothing checks.
//
// Like its neighbours here the rule is a pure function proved on synthetic strings,
// so this file demonstrates a divergence without containing one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// `design_tokens.test.mjs`'s spelling rather than `checks_wiring.test.mjs`'s
// `repoRoot` import: that one reaches through `scripts/generate_client.mjs`, which
// pulls in `openapi-typescript`. This gate has nothing to do with the generator and
// should not need it installed to run.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The three files, by the names the failure messages use. */
const FIXTURE = "frontend/ui-core/src/testing/wire.fixtures.ts";
const STUB = "frontend/app/e2e/_wire.ts";
const KERNEL = "tests/fixtures/wire_capabilities.json";

/**
 * `text` with comments removed and everything else — including line breaks — kept.
 *
 * String literals are tracked so a `//` inside one survives, and newlines inside a
 * block comment are preserved so any line number taken afterwards still refers to
 * the real file. Written out rather than regexed because the regex form of this is
 * the classic one that eats a URL in a string.
 */
export function withoutComments(text) {
  let out = "";
  let state = "code";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (state === "code") {
      if (c === "/" && d === "/") {
        state = "line";
        i += 2;
      } else if (c === "/" && d === "*") {
        state = "block";
        i += 2;
      } else {
        if (c === '"' || c === "'" || c === "`") state = c;
        out += c;
        i += 1;
      }
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") {
        state = "code";
        i += 2;
      } else {
        if (c === "\n") out += c;
        i += 1;
      }
      continue;
    }
    // inside a string literal opened by `state`
    if (c === "\\") {
      out += c + (d ?? "");
      i += 2;
      continue;
    }
    if (c === state) state = "code";
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Every `const NAME: Record<…> = { … }` in `text`, as `name -> {key: [members]}`.
 *
 * Only SCREAMING_CASE constants qualify, which is what the roster tables are and
 * what the helper functions beside them are not.
 */
export function rostersIn(text) {
  const source = withoutComments(text);
  const declaration = /const\s+([A-Z][A-Z0-9_]*)\s*:\s*Record<[\s\S]*?=\s*\{/g;
  const rosters = new Map();
  let match;
  while ((match = declaration.exec(source)) !== null) {
    const body = balanced(source, declaration.lastIndex - 1);
    if (body === null) continue;
    const rows = new Map();
    const entry = /(?:"([^"]+)"|([A-Za-z_]\w*))\s*:\s*\[([^\]]*)\]/g;
    let row;
    while ((row = entry.exec(body)) !== null) {
      rows.set(row[1] ?? row[2], [...row[3].matchAll(/"([^"]*)"/g)].map((one) => one[1]));
    }
    rosters.set(match[1], rows);
  }
  return rosters;
}

/** The kernel's exported answer, in the shape `rostersIn` produces, so one comparison serves both. */
export function rostersOf(payload) {
  return new Map(
    Object.entries(payload).map(([name, rows]) => [name, new Map(Object.entries(rows))]),
  );
}

/** The contents of the object literal whose `{` sits at `open`, or null if unbalanced. */
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** `a`'s members that `b` lacks, sorted. */
const missing = (a, b) => [...a].filter((one) => !b.includes(one)).sort();

/**
 * Every way `left` and `right` disagree, as sentences naming both files.
 *
 * Both directions at every level — roster names, the keys within a roster, and the
 * members of a key — because "the stub dropped one" and "the fixture gained one"
 * are different mistakes and a one-directional check sees only whichever it was
 * written for.
 */
export function divergences(left, right, leftName, leftPath, rightName, rightPath) {
  const report = [];
  const say = (member, where, hasPath, lacksName, lacksPath) =>
    report.push(`${where}: ${member} is in ${hasPath} but not in ${lacksPath} (${lacksName})`);

  for (const name of missing([...left.keys()], [...right.keys()]))
    say(name, "roster", leftPath, rightName, rightPath);
  for (const name of missing([...right.keys()], [...left.keys()]))
    say(name, "roster", rightPath, leftName, leftPath);

  for (const [name, leftRows] of left) {
    const rightRows = right.get(name);
    if (rightRows === undefined) continue;
    for (const key of missing([...leftRows.keys()], [...rightRows.keys()]))
      say(`${name}.${key}`, "key", leftPath, rightName, rightPath);
    for (const key of missing([...rightRows.keys()], [...leftRows.keys()]))
      say(`${name}.${key}`, "key", rightPath, leftName, leftPath);

    for (const [key, leftMembers] of leftRows) {
      const rightMembers = rightRows.get(key);
      if (rightMembers === undefined) continue;
      for (const member of missing(leftMembers, rightMembers))
        say(`"${member}" in ${name}.${key}`, "action", leftPath, rightName, rightPath);
      for (const member of missing(rightMembers, leftMembers))
        say(`"${member}" in ${name}.${key}`, "action", rightPath, leftName, leftPath);
    }
  }
  return report;
}

const read = (relative) => readFileSync(path.join(REPO, relative), "utf8");

test("comments are stripped without eating a string that looks like one", () => {
  const sample = `
    // dropped
    const KEEP = "http://example.com/not-a-comment"; /* also dropped */
  `;
  const stripped = withoutComments(sample);
  assert.ok(!stripped.includes("dropped"));
  assert.ok(stripped.includes("http://example.com/not-a-comment"));
});

test("the parse reads a roster whichever way it is formatted", () => {
  // Bare and quoted keys, one line and many, a trailing comma, an empty row, and a
  // comment carrying a word that must not be read as a member.
  const sample = `
    const BATCH_ACTIONS: Record<BatchState, readonly string[]> = {
      draft: ["approve", "edit_membership"],
      "approved": [
        "start",
        "repin",
      ],
      completed: [], // "delete" was withdrawn
    };
    export function batchActions(state) { return BATCH_ACTIONS[state]; }
  `;
  const rosters = rostersIn(sample);
  assert.deepEqual([...rosters.keys()], ["BATCH_ACTIONS"]);
  assert.deepEqual(
    [...rosters.get("BATCH_ACTIONS")].map(([key, members]) => [key, members]),
    [
      ["draft", ["approve", "edit_membership"]],
      ["approved", ["start", "repin"]],
      ["completed", []],
    ],
  );
});

test("the kernel's JSON reads as the same shape the parser produces", () => {
  const parsed = rostersIn(`const A: Record<S, readonly string[]> = { draft: ["approve"], done: [] };`);
  const exported = rostersOf({ A: { draft: ["approve"], done: [] } });
  assert.deepEqual(divergences(parsed, exported, "parsed", "p", "exported", "e"), []);
  assert.equal(
    divergences(parsed, rostersOf({ A: { draft: [] , done: [] } }), "parsed", "p", "exported", "e").length,
    1,
  );
});

test("a divergence is reported in whichever file has the extra, naming both", () => {
  const withDelete = rostersIn(`const A: Record<S, readonly string[]> = { draft: ["approve", "delete"] };`);
  const without = rostersIn(`const A: Record<S, readonly string[]> = { draft: ["approve"] };`);

  const found = divergences(without, withDelete, "fixture", FIXTURE, "stub", STUB);
  assert.equal(found.length, 1);
  assert.match(found[0], /"delete" in A\.draft/);
  assert.match(found[0], new RegExp(`is in ${STUB} but not in ${FIXTURE}`));

  // The other direction is a different mistake and must not be silent.
  assert.equal(divergences(withDelete, without, "fixture", FIXTURE, "stub", STUB).length, 1);
  // And agreement is silence.
  assert.deepEqual(divergences(without, without, "fixture", FIXTURE, "stub", STUB), []);
});

test("a roster present in only one file is reported", () => {
  const one = rostersIn(`const A: Record<S, readonly string[]> = { k: ["x"] };`);
  const two = rostersIn(
    `const A: Record<S, readonly string[]> = { k: ["x"] };
     const B: Record<S, readonly string[]> = { k: ["y"] };`,
  );
  const found = divergences(one, two, "fixture", FIXTURE, "stub", STUB);
  assert.equal(found.length, 1);
  assert.match(found[0], /^roster: B is in/);
});

const kernel = () => rostersOf(JSON.parse(read(KERNEL)));

test("all three files are read, and none as empty", () => {
  // Guards the vacuous pass: a rename or a reformat this parser cannot follow would
  // otherwise make the comparisons below trivially true.
  for (const [name, relative, rosters] of [
    ["fixture", FIXTURE, rostersIn(read(FIXTURE))],
    ["stub", STUB, rostersIn(read(STUB))],
    ["kernel", KERNEL, kernel()],
  ]) {
    assert.ok(
      rosters.size > 0,
      `${relative} (${name}): no roster found. If a roster was renamed, its declaration ` +
        `reshaped, or the export emptied, this gate can no longer see it — teach ` +
        `\`rostersIn\` the new form, or regenerate the anchor, rather than deleting the assertion.`,
    );
    for (const [roster, rows] of rosters)
      assert.ok(rows.size > 0, `${relative}: ${roster} parsed as empty`);
  }
});

for (const [name, relative] of [
  ["the ui-core fixture", FIXTURE],
  ["the e2e stub", STUB],
]) {
  test(`${name} declares what the kernel declares`, () => {
    const found = divergences(kernel(), rostersIn(read(relative)), "the kernel", KERNEL, name, relative);
    assert.deepEqual(
      found,
      [],
      `${relative} has drifted from the kernel's own answer:\n\n` +
        found.map((one) => `  - ${one}`).join("\n") +
        `\n\n${KERNEL} is \`allowed_actions\` as kernel/domain/capabilities.py answers it ` +
        `(held fresh by tests/server/test_wire_fixtures.py). A member in the kernel and not ` +
        `in the double means a stub is lying about what the server would send; a member in ` +
        `the double and not in the kernel means the stub promises a control the server ` +
        `refuses. Fix the double — or, if the kernel changed, regenerate the anchor with ` +
        `\`uv run python scripts/export_wire_fixtures.py\` and then fix the double.\n`,
    );
  });
}

test("the e2e stub and the ui-core fixture declare the same actions", () => {
  const found = divergences(
    rostersIn(read(FIXTURE)),
    rostersIn(read(STUB)),
    "the ui-core fixture",
    FIXTURE,
    "the e2e stub",
    STUB,
  );
  assert.deepEqual(
    found,
    [],
    `The two transcriptions of the wire's action tables have drifted:\n\n` +
      found.map((one) => `  - ${one}`).join("\n") +
      `\n\nThey are test doubles for the same answer — \`allowed_actions\`, from ` +
      `kernel/domain/capabilities.py — so an action in one and not the other means a ` +
      `stub is lying about what the server would send. Fix whichever is stale — the ` +
      `kernel is the authority, not either file, and the tests above say which one it is.\n`,
  );
});
