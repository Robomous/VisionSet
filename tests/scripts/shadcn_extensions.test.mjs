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
