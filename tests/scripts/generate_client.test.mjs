// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  BANNER,
  CHECKS_BANNER,
  CHECKS_PATH,
  OUTPUT_PATH,
  SPEC_PATH,
  compile,
  operationCheckName,
  reachableSchemas,
  renderChecks,
  renderClient,
  repoRoot,
  responsesOf,
} from "../../scripts/generate_client.mjs";

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

// --- the response checks (#225) ----------------------------------------------

const committedChecks = () => readFileSync(path.join(repoRoot(), CHECKS_PATH), "utf8");

test("the committed response checks match the committed spec", () => {
  assert.equal(
    committedChecks(),
    renderChecks(),
    `${CHECKS_PATH} is stale — run 'pnpm generate:client' and commit the result.`,
  );
});

test("check generation is a pure function of the spec too", () => {
  assert.equal(renderChecks(), renderChecks());
  assert.ok(committedChecks().startsWith(CHECKS_BANNER));
  assert.doesNotMatch(CHECKS_BANNER, /\d+\.\d+\.\d+/);
});

test("every operation that answers a body has a check named after it", () => {
  const spec = JSON.parse(readFileSync(path.join(repoRoot(), SPEC_PATH), "utf8"));
  const source = committedChecks();
  const answers = responsesOf(spec);
  // The spec has more than fifty operations; a scan that found a handful has broken.
  assert.ok(answers.length > 50, `only ${answers.length} operations found`);
  for (const answer of answers) {
    const name = operationCheckName(answer.operationId);
    assert.match(
      source,
      new RegExp(`export const ${name}\\b`),
      `${answer.operationId} has no ${name}`,
    );
  }
});

test("the generator refuses a construct it does not understand", () => {
  // The most load-bearing line in the generator. A permissive fallback for an
  // unrecognised keyword would emit a check that validates nothing and still passes
  // every gate in this repository — so the refusal is asserted rather than assumed.
  // Proved on synthetic fragments, so this file demonstrates the rule without
  // containing a violation of it.
  assert.throws(() => compile({ allOf: [{ type: "string" }] }), /unsupported keyword\(s\) allOf/);
  assert.throws(() => compile({ type: "object", patternProperties: {} }), /patternProperties/);
  assert.throws(() => compile({ not: { type: "string" } }), /unsupported keyword\(s\) not/);
});

test("a recursive model is refused rather than emitted as a dead const", () => {
  // Nothing in the contract is recursive today. If something becomes so, emitting it
  // in dependency order would produce a temporal-dead-zone crash at import — a blank
  // page with no error anybody could act on — so the generator stops instead.
  const looped = {
    paths: {
      "/x": { get: { operationId: "get_x", responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } } } } },
    },
    components: {
      schemas: {
        Node: { type: "object", properties: { next: { $ref: "#/components/schemas/Node" } } },
      },
    },
  };
  assert.throws(() => reachableSchemas(looped), /recursive \$ref: Node -> Node/);
});

test("the checks are generated from this spec, not from an empty one", () => {
  const source = committedChecks();
  // One of each construct the contract actually uses, so a generator that quietly
  // stopped emitting a whole category fails here.
  assert.match(source, /checkProjectStatsOut/);
  assert.match(source, /tagged\("type", \{ "bbox":/); // the geometry discriminator
  assert.match(source, /tuple\(\[isNumber, isNumber\] as const\)/); // PolygonBody.points
  assert.match(source, /mapOf\(/); // AnnotationOut.attributes
  assert.match(source, /export const checkDeleteProject = checkNoContent;/); // a 204
  assert.match(source, /export const checkExportRelease = checkBlob;/); // bytes
});
