import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { relativize } from "../../scripts/shadcn_relativize.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRIMITIVES = path.join(REPO, "frontend/ui-core/src/primitives");
const SNAPSHOTS = path.join(REPO, "frontend/ui-core/shadcn");

const lines = (text) => text.split(/\r?\n/).map((l) => l.trimEnd());

// Every snapshot line must appear in the primitive, in order. Added lines are
// the only permitted difference — that is the whole of the "do not modify
// shadcn's code" rule, in a form a machine can check.
export function additiveOnly(snapshot, actual) {
  const want = lines(snapshot).filter((l) => l !== "");
  const have = lines(actual);
  let cursor = 0;
  for (const line of want) {
    const at = have.indexOf(line, cursor);
    if (at === -1) return { ok: false, missing: line };
    cursor = at + 1;
  }
  return { ok: true };
}

test("additiveOnly accepts an added line and refuses a changed one", () => {
  assert.equal(additiveOnly("a\nb\n", "a\nx\nb\n").ok, true);
  assert.equal(additiveOnly("a\nb\n", "a\nB\n").ok, false);
  assert.equal(additiveOnly("a\nb\n", "b\na\n").ok, false);
});

const primitives = readdirSync(PRIMITIVES).filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"));

for (const file of primitives) {
  test(`${file} is shadcn's canonical file plus added lines only`, () => {
    const snapshot = path.join(SNAPSHOTS, file);
    assert.ok(existsSync(snapshot), `${file} has no snapshot in frontend/ui-core/shadcn/ — install it with pnpm --filter @visionset/ui-core shadcn:add`);
    const result = additiveOnly(relativize(readFileSync(snapshot, "utf8")), readFileSync(path.join(PRIMITIVES, file), "utf8"));
    assert.ok(result.ok, `${file} diverges from its snapshot at: ${result.missing}`);
  });
}
