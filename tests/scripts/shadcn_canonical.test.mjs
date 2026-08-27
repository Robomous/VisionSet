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
  const want = lines(snapshot);
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
  assert.equal(additiveOnly("a\n\nb\n", "a\nb\n").ok, false);
  assert.equal(additiveOnly("a\r\nb  \r\n", "a\nb\n").ok, true);
});

// A primitive may replace a framework-specific hook (shadcn's Next.js
// integrations) with a thin adapter that reads VisionSet's one theme source
// instead — never a shortcut for divergence in general. `FRAMEWORK_ADAPTERS`
// is the explicit allow-list; the marker comment `SHADCN FRAMEWORK ADAPTER`
// is how a primitive claims the exemption, and it must be on the list to
// claim it. `ADAPTER_REMOVED_LINES` are exactly the snapshot lines the
// adapter is permitted to drop — every other snapshot line must still appear,
// in order, same as any other primitive.
const FRAMEWORK_ADAPTERS = ["sonner.tsx"];
const ADAPTER_REMOVED_LINES = ['import { useTheme } from "next-themes"', '  const { theme = "system" } = useTheme()'];

export function withoutLines(text, removed) {
  const removedTrimmed = new Set(removed.map((l) => l.trimEnd()));
  return lines(text)
    .filter((line) => !removedTrimmed.has(line))
    .join("\n");
}

// Decides which comparison a primitive gets. Returns { ok: false, reason }
// when the marker is present on a file that isn't allow-listed; otherwise
// { ok: true, isAdapter } says whether the adapter-adjusted snapshot applies.
export function checkAdapter(file, actualText) {
  if (!actualText.includes("SHADCN FRAMEWORK ADAPTER")) return { ok: true, isAdapter: false };
  if (!FRAMEWORK_ADAPTERS.includes(file)) {
    return { ok: false, reason: `${file} carries the SHADCN FRAMEWORK ADAPTER marker but is not in FRAMEWORK_ADAPTERS` };
  }
  return { ok: true, isAdapter: true };
}

test("checkAdapter refuses an unlisted file carrying the marker", () => {
  const result = checkAdapter("unlisted.tsx", "// SHADCN FRAMEWORK ADAPTER\nconst x = 1\n");
  assert.equal(result.ok, false);
});

test("checkAdapter accepts a listed file carrying the marker", () => {
  const result = checkAdapter("sonner.tsx", "// SHADCN FRAMEWORK ADAPTER\nconst x = 1\n");
  assert.deepEqual(result, { ok: true, isAdapter: true });
});

test("checkAdapter ignores a file with no marker even if unlisted", () => {
  const result = checkAdapter("unlisted.tsx", "const x = 1\n");
  assert.deepEqual(result, { ok: true, isAdapter: false });
});

test("a listed adapter passes when only the two next-themes lines are removed", () => {
  const snapshot = 'import { useTheme } from "next-themes"\nconst x = 1\n  const { theme = "system" } = useTheme()\nconst y = 2\n';
  const actual = "// SHADCN FRAMEWORK ADAPTER\nconst x = 1\nconst y = 2\n";
  const result = additiveOnly(withoutLines(relativize(snapshot), ADAPTER_REMOVED_LINES), actual);
  assert.equal(result.ok, true);
});

test("a listed adapter that also drops a different snapshot line still fails", () => {
  const snapshot = 'import { useTheme } from "next-themes"\nconst x = 1\n  const { theme = "system" } = useTheme()\nconst y = 2\n';
  const actual = "// SHADCN FRAMEWORK ADAPTER\nconst y = 2\n"; // "const x = 1" went missing too
  const result = additiveOnly(withoutLines(relativize(snapshot), ADAPTER_REMOVED_LINES), actual);
  assert.equal(result.ok, false);
});

const primitives = readdirSync(PRIMITIVES).filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"));

for (const file of primitives) {
  test(`${file} is shadcn's canonical file plus added lines only`, () => {
    const snapshot = path.join(SNAPSHOTS, file);
    assert.ok(existsSync(snapshot), `${file} has no snapshot in frontend/ui-core/shadcn/ — install it with pnpm --filter @visionset/ui-core shadcn:add`);
    const snapshotText = relativize(readFileSync(snapshot, "utf8"));
    const actualText = readFileSync(path.join(PRIMITIVES, file), "utf8");
    const adapter = checkAdapter(file, actualText);
    assert.ok(adapter.ok, adapter.reason);
    const result = adapter.isAdapter
      ? additiveOnly(withoutLines(snapshotText, ADAPTER_REMOVED_LINES), actualText)
      : additiveOnly(snapshotText, actualText);
    assert.ok(result.ok, `${file} diverges from its snapshot at: ${result.missing}`);
  });
}
