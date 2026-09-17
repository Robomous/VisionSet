// tests/scripts/cdn_vendor_boundary.test.mjs
// Run with: pnpm test:scripts
//
// The CDN this repository's OSS build points at by default is frontend/app's own choice
// (see frontend/app/src/data/browserInference/manifest.ts), never a fact @visionset/
// annotator or @visionset/browser-inference are allowed to know — those two packages ship
// to npm and must work against any self-hosted mirror. Mirrors ui_core_boundary.test.mjs's
// CDN_VENDOR_LITERALS rule, scoped to the two packages that rule does not cover.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

function shippedSourceUnder(dir) {
  return execFileSync("git", ["ls-files", dir], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => !/\.test\.[jt]sx?$/.test(file))
    .map((file) => ({ path: file, text: readFileSync(path.join(REPO, file), "utf8") }));
}

const CDN_VENDOR_LITERALS = [
  [/\bmodels\.robomous\.ai\b/, "names models.robomous.ai — only frontend/app may know this hostname"],
  [/\bcloudflare\b/i, "names cloudflare"],
  [/\bcloudfront\b/i, "names cloudfront"],
  [/\bamazonaws\.com\b/, "names amazonaws.com"],
  [/\br2\.cloudflarestorage\.com\b/, "names r2.cloudflarestorage.com"],
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

test("@visionset/annotator names no CDN/vendor identity", () => {
  assert.deepEqual(violations(shippedSourceUnder("frontend/annotator/src"), CDN_VENDOR_LITERALS), []);
});

test("@visionset/browser-inference names no CDN/vendor identity", () => {
  assert.deepEqual(violations(shippedSourceUnder("frontend/browser-inference/src"), CDN_VENDOR_LITERALS), []);
});

test("the gate fires on a violation", () => {
  // One planted line per rule, each written so it trips exactly one pattern —
  // verified so a neutered pattern changes the count, not just its sign, and a
  // mutation to one pattern cannot hide behind another's hit.
  const planted = [
    { path: "frontend/annotator/src/Bad.ts", text: 'const url = "https://models.robomous.ai/x";\n' },
    { path: "frontend/annotator/src/BadCloudflare.ts", text: "// hosted on Cloudflare R2\n" },
    { path: "frontend/browser-inference/src/BadCloudfront.ts", text: 'const url = "https://d123.cloudfront.net/x";\n' },
    { path: "frontend/browser-inference/src/BadAmazon.ts", text: 'const url = "https://bucket.s3.amazonaws.com/x";\n' },
    { path: "frontend/annotator/src/BadR2.ts", text: 'const url = "https://abc.r2.cloudflarestorage.com/x";\n' },
  ];
  assert.equal(violations(planted, CDN_VENDOR_LITERALS).length, planted.length);
});

test("the gate does NOT fire on the legitimate neighbouring form", () => {
  const legitimate = [
    { path: "frontend/annotator/src/Fine.ts", text: "// this runtime may run in the cloud someday\n" },
    { path: "frontend/browser-inference/src/Fine.ts", text: 'const label = "amazon-style layout";\n' },
  ];
  assert.deepEqual(violations(legitimate, CDN_VENDOR_LITERALS), []);
});
