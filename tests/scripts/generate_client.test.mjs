// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { BANNER, OUTPUT_PATH, renderClient, repoRoot } from "../../scripts/generate_client.mjs";

const committed = () => readFileSync(path.join(repoRoot(), OUTPUT_PATH), "utf8");

test("the committed client matches the committed spec", async () => {
  // The drift gate, run where the mistake is actually made. CI has its own step for this; the
  // duplication is deliberate, the same bargain tests/server/test_openapi_contract.py struck for
  // openapi.json — a gate that only fires on a pushed branch is a gate you learn about late.
  assert.equal(
    committed(),
    await renderClient(),
    `${OUTPUT_PATH} is stale — run 'pnpm generate:client' and commit the result.`,
  );
});

test("generation is a pure function of the spec, so the drift gate means something", async () => {
  assert.equal(await renderClient(), await renderClient());
});

test("the banner carries the regeneration command and nothing that varies", () => {
  assert.match(BANNER, /pnpm generate:client/);
  // A version or a timestamp would fail the gate on a dependency bump nobody chose.
  assert.doesNotMatch(BANNER, /\d+\.\d+\.\d+/);
  assert.ok(committed().startsWith(BANNER));
});

test("the client is generated from this spec, not from an empty one", () => {
  const source = committed();
  // One operation, one wire model, one enum, one tuple: an empty or half-rendered module fails.
  for (const expected of [
    '"/projects/{project_id}/assets/{asset_id}/content"',
    "get_asset_content",
    "ProjectOut",
    "ErrorBody",
    'GeometryType: "bbox"',
  ]) {
    assert.ok(source.includes(expected), `expected the generated client to mention ${expected}`);
  }
});

test("binary responses type as unknown rather than as a shape no response has", () => {
  // `"schema": {}` under a binary media type is OpenAPI for "bytes". Without
  // emptyObjectsUnknown it renders as Record<string, never>; calling it `string` would be a lie
  // in a browser, where the value is a Blob.
  const source = committed();
  for (const line of [
    '"application/octet-stream": unknown;',
    '"image/png": unknown;',
    '"application/zip": unknown;',
  ]) {
    assert.ok(source.includes(line), `expected the generated client to contain: ${line}`);
  }
});
