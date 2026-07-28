// Generate the typed API client from the repo-root openapi.json (the committed public contract).
//
// Usage:
//   node scripts/generate_client.mjs            write frontend/ui-core/src/generated/api.ts
//   node scripts/generate_client.mjs --check    exit 1 if the committed file is stale (CI drift gate)
//
// The output is committed, exactly like openapi.json: a contract change becomes a reviewable type
// diff in the pull request. That only works if generation is a pure function of the spec, so the
// banner below carries no version and no timestamp — anything that varies would fail the gate for
// a reason nobody chose.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import openapiTS, { astToString } from "openapi-typescript";

/** Repo-relative path of the generated client. */
export const OUTPUT_PATH = "frontend/ui-core/src/generated/api.ts";

/** Repo-relative path of the spec it is generated from. */
export const SPEC_PATH = "openapi.json";

/** The do-not-edit header. Deterministic on purpose: no version, no timestamp. */
export const BANNER = `/**
 * DO NOT EDIT — generated from the repo-root ${SPEC_PATH}.
 *
 * Regenerate with \`pnpm generate:client\` and commit the result. CI fails on drift.
 *
 * Binary responses (asset content, thumbnails, the release manifest, the export archive) type as
 * \`unknown\`: the spec declares them with an empty schema, and calling them \`string\` would be a
 * lie in a browser where the value is a Blob. Read those through \`response.blob()\`.
 */
`;

/** @returns {string} the repo-root absolute path */
export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Render the client from the committed spec.
 *
 * Pure: the same spec always produces the same text, which is what makes the drift gate meaningful.
 *
 * @param {string} root the repo root
 * @returns {Promise<string>} the full contents of the generated module
 */
export async function renderClient(root = repoRoot()) {
  const spec = JSON.parse(readFileSync(path.join(root, SPEC_PATH), "utf8"));
  // emptyObjectsUnknown: the three binary operations declare `"schema": {}`, which would otherwise
  // become `Record<string, never>` — a shape no response ever has.
  const ast = await openapiTS(spec, { emptyObjectsUnknown: true });
  return BANNER + astToString(ast);
}

async function main(check) {
  const root = repoRoot();
  const rendered = await renderClient(root);
  const outPath = path.join(root, OUTPUT_PATH);

  if (check) {
    let committed = null;
    try {
      committed = readFileSync(outPath, "utf8");
    } catch {
      committed = null;
    }
    if (committed !== rendered) {
      console.error(
        `The generated API client is stale — run 'pnpm generate:client' and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`${OUTPUT_PATH} matches ${SPEC_PATH}.`);
    return;
  }

  writeFileSync(outPath, rendered);
  console.log(`wrote ${OUTPUT_PATH} (${Buffer.byteLength(rendered, "utf8")} bytes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.includes("--check"));
}
