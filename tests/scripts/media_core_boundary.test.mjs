// tests/scripts/media_core_boundary.test.mjs
// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// `@visionset/media`'s core is the host-neutral half of the package: sampling policy and
// grid arithmetic, with the browser decoder confined to `src/mediabunny/`. ESLint's
// `no-restricted-globals` guards the same boundary; this text scan is the second gate,
// the way `ui_core_boundary.test.mjs` backs ui-core. Type-level mentions of `Blob` and
// `File` (`BlobLike`, `FileLike`) are legitimate and pass: only value uses are caught.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { trackedFiles } from "./tracked.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

function coreSource() {
  return trackedFiles(["frontend/media/src"])
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => !/\.test\.[jt]sx?$/.test(file))
    .filter((file) => !file.startsWith("frontend/media/src/mediabunny/"))
    .map((file) => ({ path: file, text: readFileSync(path.join(REPO, file), "utf8") }));
}

const HOST_VALUES = [
  [/\bfetch\s*\(/, "calls fetch — the host owns transport"],
  [/\bnew\s+(?:Blob|File|Response|Request)\b/, "constructs a host Blob/File/Response/Request"],
  [/\bURL\s*\.\s*(?:createObjectURL|revokeObjectURL|canParse)\b|\bnew\s+URL\b/, "uses the URL global"],
  [/\bself\s*\./, "reaches the worker/window global through self"],
  [/\bcaches\s*\./, "reaches the Cache Storage global"],
  [/\b(?:globalThis|window)\s*\.\s*(?:fetch|Blob|File|URL|caches)\b/, "reaches a host global through globalThis"],
];

function violations(files, rules) {
  const found = [];
  for (const { path: file, text } of files) {
    for (const [pattern, reason] of rules) {
      if (pattern.test(text)) found.push(`${file}: ${reason}`);
    }
  }
  return found;
}

test("the media core scans a non-empty source set", () => {
  assert.ok(coreSource().some((file) => file.path === "frontend/media/src/index.ts"));
});

test("the media core reaches for no host transport or object global", () => {
  assert.deepEqual(violations(coreSource(), HOST_VALUES), []);
});

test("the gate fires on a violation", () => {
  const planted = [
    'await fetch("/clip.mp4");\n',
    "const b = new Blob([]);\n",
    'const f = new File([], "a.mp4");\n',
    "const u = URL.createObjectURL(b);\n",
    'const u = new URL("x", base);\n',
    "self.postMessage(1);\n",
    'await caches.open("v");\n',
    "const f = globalThis.fetch;\n",
  ].map((text, i) => ({ path: `frontend/media/src/Bad${i}.ts`, text }));
  for (const file of planted) {
    assert.equal(violations([file], HOST_VALUES).length, 1, file.text);
  }
});

test("the gate does NOT fire on the legitimate neighbouring form", () => {
  const legitimate = [
    { path: "frontend/media/src/ok.ts", text: "export interface BlobLike { size: number }\n" },
    { path: "frontend/media/src/ok2.ts", text: "export interface FileLike extends BlobLike { name: string }\n" },
    { path: "frontend/media/src/ok3.ts", text: "// the Blob surface, declared structurally\nconst prefetch = 1;\n" },
  ];
  assert.deepEqual(violations(legitimate, HOST_VALUES), []);
});
