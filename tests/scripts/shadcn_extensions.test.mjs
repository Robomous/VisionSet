import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(REPO, rel), "utf8");

/** The variant keys of the first `variant: { … }` block in a cva source. */
export function variantKeys(source, block = "variant") {
  const start = source.indexOf(`${block}: {`);
  assert.notEqual(start, -1, `no "${block}" block`);
  let depth = 0, i = start + block.length + 3;
  const begin = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { if (depth === 0) break; depth--; }
  }
  const body = source.slice(begin, i);
  return [...body.matchAll(/(?:^|,)\s*"?([a-z][a-z0-9-]*)"?:\s/g)].map((m) => m[1]);
}

test("variantKeys reads quoted and bare keys and ignores class text", () => {
  assert.deepEqual(
    variantKeys(`x({ variants: { variant: { default: "a: b", "icon-xs": "c" }, size: { sm: "d" } } })`),
    ["default", "icon-xs"],
  );
  assert.deepEqual(variantKeys(`variants: { variant: { a: "" }, size: { sm: "x", lg: "y" } }`, "size"), ["sm", "lg"]);
});

const BUTTON = "frontend/ui-core/src/primitives/button.tsx";
test("Button carries shadcn's variants and sizes, and nothing else", () => {
  const src = read(BUTTON);
  assert.deepEqual(variantKeys(src, "variant"), ["default", "outline", "secondary", "ghost", "destructive", "link"]);
  assert.deepEqual(variantKeys(src, "size"), ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"]);
});

const BADGE = "frontend/ui-core/src/primitives/badge.tsx";
const OFFICIAL_BADGE = ["default", "secondary", "destructive", "outline", "ghost", "link"];
const VISIONSET_BADGE = ["success", "warning", "info", "quiet"];

test("Badge keeps shadcn's variants and adds exactly the four VisionSet status variants", () => {
  const keys = variantKeys(read(BADGE), "variant");
  for (const k of OFFICIAL_BADGE) assert.ok(keys.includes(k), `official Badge variant ${k} missing`);
  assert.deepEqual(keys.filter((k) => !OFFICIAL_BADGE.includes(k)).sort(), [...VISIONSET_BADGE].sort());
});

/** The class string of one variant line in a cva source. */
export function variantClasses(source, key) {
  const m = source.match(new RegExp(String.raw`^\s*"?${key}"?:\s*\n?\s*"([^"]*)"`, "m"));
  assert.ok(m, `no variant ${key}`);
  return m[1];
}

test("a status Badge paints a soft surface and readable ink, never a coloured stroke", () => {
  const src = read(BADGE);
  const stroke = /\bborder-(?:emerald|amber|sky|success|warning|destructive|primary)\b/;
  for (const k of [...VISIONSET_BADGE, "destructive"]) {
    assert.doesNotMatch(variantClasses(src, k), stroke, `${k} adds a coloured border`);
  }
  assert.match(variantClasses(src, "success"), /\bbg-emerald-500\/10\b/);
  assert.match(variantClasses(src, "success"), /\btext-emerald-700\b/);
  assert.match(variantClasses(src, "warning"), /\bbg-amber-500\/10\b/);
  assert.match(variantClasses(src, "warning"), /\btext-amber-700\b/);
  assert.match(variantClasses(src, "info"), /\bbg-sky-500\/10\b/);
  assert.match(variantClasses(src, "info"), /\btext-sky-700\b/);
  assert.match(variantClasses(src, "quiet"), /\bbg-muted\b/);
  assert.match(variantClasses(src, "quiet"), /\btext-muted-foreground\b/);
  // Official destructive stays on the semantic token, never red-*.
  assert.match(variantClasses(src, "destructive"), /\bbg-destructive\/10\b/);
  assert.doesNotMatch(src, /\b(?:bg|text)-red-\d/);
});
