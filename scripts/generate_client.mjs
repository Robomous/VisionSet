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

/** Repo-relative path of the generated response checks. */
export const CHECKS_PATH = "frontend/ui-core/src/generated/checks.ts";

/** The do-not-edit header for the checks. Deterministic, like `BANNER`. */
export const CHECKS_BANNER = `/**
 * DO NOT EDIT — generated from the repo-root ${SPEC_PATH}.
 *
 * Regenerate with \`pnpm generate:client\` and commit the result. CI fails on drift.
 *
 * One check per schema a 2xx JSON response can carry, plus one alias per operation named
 * after its \`operationId\`. \`unwrap\` takes the alias, so a response that is well-formed JSON
 * and the wrong document is reported as MALFORMED_RESPONSE instead of reaching a renderer.
 *
 * Two things are deliberately **not** checked, and both are argued in \`../data/check.ts\`:
 * \`format\` (a \`uuid\` is validated as a string and nothing more), and unknown keys (a server
 * that grows a field must not break an older client).
 */
`;

/**
 * HTTP verbs a path item can carry. Anything else in a path item (`parameters`,
 * `summary`) is not an operation and is skipped.
 */
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/**
 * Keywords this generator understands but deliberately does not enforce.
 *
 * `format`, `pattern` and the numeric/length bounds are the contract describing values
 * more tightly than a renderer needs. Enforcing them would reject honest data — the test
 * fixtures across this repo use ids like `"asset-1"` — while catching nothing in the bug
 * class this exists for, which is a whole document of the wrong type.
 */
const IGNORED_KEYWORDS = new Set([
  "title",
  "description",
  // `default` is *not* ignored where it appears on a property — see `compile`, which reads it
  // as "always present in a response". It is listed here because it is never a shape by itself.
  "default",
  "format",
  "example",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "contentMediaType",
  "contentEncoding",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "multipleOf",
  "uniqueItems",
]);

/** Keywords that decide the shape, and therefore the emitted expression. */
const STRUCTURAL_KEYWORDS = new Set([
  "$ref",
  "type",
  "properties",
  "required",
  "items",
  "anyOf",
  "oneOf",
  "enum",
  "const",
  "additionalProperties",
  "prefixItems",
  "minItems",
  "maxItems",
  "discriminator",
]);

const SCALARS = {
  string: "isString",
  number: "isNumber",
  integer: "isInteger",
  boolean: "isBoolean",
  null: "isNull",
};

/** `AssetProgressOut` → `checkAssetProgressOut`. */
function schemaCheckName(name) {
  return `check${name}`;
}

/** `get_project_stats` → `checkGetProjectStats`. */
export function operationCheckName(operationId) {
  const pascal = operationId
    .split("_")
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `check${pascal}`;
}

function refName(ref) {
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) throw new Error(`unsupported $ref: ${ref}`);
  return ref.slice(prefix.length);
}

/**
 * The 2xx answer of every operation, as the check it needs.
 *
 * Four kinds, and each is a decision recorded in `docs/api.md`: a `$ref` becomes that
 * schema's check; a 204 becomes `checkNoContent`; an empty schema (`{}`, OpenAPI's "bytes,
 * and nothing more to say") becomes `checkBlob`, because every such operation here is read
 * with `parseAs: "blob"`; an inline schema is compiled in place.
 */
export function responsesOf(spec) {
  const answers = [];
  for (const [routePath, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      const { operationId } = operation;
      if (operationId === undefined) throw new Error(`${method} ${routePath} has no operationId`);
      const success = Object.keys(operation.responses ?? {})
        .filter((code) => code.startsWith("2"))
        .sort();
      if (success.length === 0) throw new Error(`${operationId} declares no 2xx response`);
      if (success.length > 1) {
        throw new Error(`${operationId} declares more than one 2xx response: ${success.join(", ")}`);
      }
      const status = success[0];
      const response = operation.responses[status];
      const content = response.content;
      if (content === undefined) {
        answers.push({ operationId, path: routePath, method, status, kind: "none" });
        continue;
      }
      const json = content["application/json"];
      const schema = json === undefined ? undefined : (json.schema ?? {});
      if (json === undefined || Object.keys(schema).length === 0) {
        answers.push({ operationId, path: routePath, method, status, kind: "bytes" });
        continue;
      }
      answers.push({ operationId, path: routePath, method, status, kind: "json", schema });
    }
  }
  answers.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return answers;
}

/**
 * Every schema a 2xx JSON response can carry, transitively.
 *
 * Returned dependency-first, so the emitted module is a straight list of `const`s with no
 * forward reference. The graph is asserted acyclic rather than assumed: a cycle emitted as
 * `const` would be a temporal-dead-zone crash at import, and the day somebody adds a
 * recursive model is the day that would happen silently.
 */
export function reachableSchemas(spec) {
  const all = spec.components?.schemas ?? {};
  const roots = new Set();
  for (const answer of responsesOf(spec)) {
    if (answer.kind !== "json") continue;
    for (const name of refsIn(answer.schema)) roots.add(name);
  }

  const ordered = [];
  const state = new Map(); // name -> "visiting" | "done"
  const visit = (name, trail) => {
    const seen = state.get(name);
    if (seen === "done") return;
    if (seen === "visiting") {
      throw new Error(`recursive $ref: ${[...trail, name].join(" -> ")}`);
    }
    if (all[name] === undefined) throw new Error(`unknown $ref: ${name}`);
    state.set(name, "visiting");
    for (const child of [...refsIn(all[name])].sort()) visit(child, [...trail, name]);
    state.set(name, "done");
    ordered.push(name);
  };
  for (const name of [...roots].sort()) visit(name, []);
  return ordered;
}

/** Every schema named by a `$ref` anywhere inside one schema object. */
function refsIn(schema) {
  const found = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.add(refName(value));
      else walk(value);
    }
  };
  walk(schema);
  return found;
}

/**
 * One schema, as the expression that checks it.
 *
 * Throws on any keyword it does not recognise. That refusal is the most load-bearing line
 * in this file: a generator that quietly emitted a permissive check for an `allOf` it did
 * not understand would pass every gate in the repository while validating nothing.
 */
export function compile(schema, pointer = "#") {
  const unknown = Object.keys(schema).filter(
    (key) => !STRUCTURAL_KEYWORDS.has(key) && !IGNORED_KEYWORDS.has(key),
  );
  if (unknown.length > 0) {
    throw new Error(`unsupported keyword(s) ${unknown.sort().join(", ")} at ${pointer}`);
  }

  if (schema.$ref !== undefined) return schemaCheckName(refName(schema.$ref));

  if (schema.const !== undefined) {
    if (typeof schema.const !== "string") {
      throw new Error(`unsupported non-string const at ${pointer}`);
    }
    return `lit(${JSON.stringify(schema.const)})`;
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.every((member) => typeof member === "string")) {
      throw new Error(`unsupported non-string enum at ${pointer}`);
    }
    return `oneOf([${schema.enum.map((member) => JSON.stringify(member)).join(", ")}] as const)`;
  }

  if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
    const branches = schema.oneOf ?? schema.anyOf;
    const discriminator = schema.discriminator;
    if (discriminator !== undefined) {
      const mapping = discriminator.mapping ?? {};
      const variants = Object.keys(mapping)
        .sort()
        .map((tag) => `${JSON.stringify(tag)}: ${schemaCheckName(refName(mapping[tag]))}`);
      return `tagged(${JSON.stringify(discriminator.propertyName)}, { ${variants.join(", ")} })`;
    }
    const compiled = branches.map((branch, index) => compile(branch, `${pointer}/${index}`));
    return `either([${compiled.join(", ")}] as const)`;
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    const compiled = type.map((member) => compile({ ...schema, type: member }, pointer));
    return `either([${compiled.join(", ")}] as const)`;
  }

  if (type === "array") {
    if (schema.prefixItems !== undefined) {
      const parts = schema.prefixItems.map((item, index) =>
        compile(item, `${pointer}/prefixItems/${index}`),
      );
      return `tuple([${parts.join(", ")}] as const)`;
    }
    if (schema.items === undefined) throw new Error(`array with no items at ${pointer}`);
    return `arrayOf(${compile(schema.items, `${pointer}/items`)})`;
  }

  if (type === "object") {
    const properties = schema.properties;
    if (properties === undefined) {
      const extra = schema.additionalProperties;
      if (extra !== undefined && typeof extra === "object") {
        return `mapOf(${compile(extra, `${pointer}/additionalProperties`)})`;
      }
      return `object({})`;
    }
    const required = new Set(schema.required ?? []);
    const fields = Object.keys(properties)
      .sort()
      .map((key) => {
        const compiled = compile(properties[key], `${pointer}/properties/${key}`);
        // A property carrying a `default` is always *present* in a response even though it
        // is absent from `required` — `required` constrains what an input must supply, and
        // pydantic serializes a defaulted field every time. `openapi-typescript` reads it
        // the same way and emits the property as non-optional, so a check that called it
        // optional would not be assignable to the generated type. The two agreeing is the
        // whole point of annotating these; this line is where they agree.
        const always = required.has(key) || properties[key].default !== undefined;
        return `${JSON.stringify(key)}: [${always}, ${compiled}]`;
      });
    return `object({ ${fields.join(", ")} } as const)`;
  }

  if (typeof type === "string" && SCALARS[type] !== undefined) return SCALARS[type];

  throw new Error(`unsupported schema at ${pointer}: ${JSON.stringify(schema).slice(0, 120)}`);
}

/**
 * Render the response checks from the committed spec.
 *
 * Pure, exactly like `renderClient`: the same spec always produces the same text, which is
 * what lets the CI drift gate diff the whole `generated/` directory and mean something.
 */
export function renderChecks(root = repoRoot()) {
  const spec = JSON.parse(readFileSync(path.join(root, SPEC_PATH), "utf8"));
  const schemas = reachableSchemas(spec);
  const answers = responsesOf(spec);

  const lines = [];
  for (const name of schemas) {
    const expression = compile(spec.components.schemas[name], `#/components/schemas/${name}`);
    lines.push(
      `export const ${schemaCheckName(name)}: Check<Schemas[${JSON.stringify(name)}]> =`,
      `  /*#__PURE__*/ ${expression};`,
      "",
    );
  }

  lines.push(
    "// One alias per operation. `unwrap` takes these, never a schema check directly, so that",
    "// `tests/scripts/checks_wiring.test.mjs` can pair every call with its own operationId.",
    "",
  );
  for (const answer of answers) {
    const alias = operationCheckName(answer.operationId);
    if (answer.kind === "none") {
      lines.push(`export const ${alias} = checkNoContent;`);
      continue;
    }
    if (answer.kind === "bytes") {
      lines.push(`export const ${alias} = checkBlob;`);
      continue;
    }
    if (answer.schema.$ref !== undefined) {
      lines.push(`export const ${alias} = ${schemaCheckName(refName(answer.schema.$ref))};`);
      continue;
    }
    const inline = compile(answer.schema, `#/paths${answer.path}/${answer.method}`);
    const responseType = `operations[${JSON.stringify(answer.operationId)}]["responses"][${answer.status}]["content"]["application/json"]`;
    lines.push(
      `export const ${alias}: Check<${responseType}> =`,
      `  /*#__PURE__*/ ${inline};`,
    );
  }
  lines.push("");

  const body = lines.join("\n");
  const helpers = [
    "arrayOf",
    "checkBlob",
    "checkNoContent",
    "either",
    "isBoolean",
    "isInteger",
    "isNull",
    "isNumber",
    "isString",
    "lit",
    "mapOf",
    "object",
    "oneOf",
    "tagged",
    "tuple",
  ].filter((helper) => new RegExp(`\\b${helper}\\b`).test(body));

  return `${CHECKS_BANNER}
import {
${helpers.map((helper) => `  ${helper},`).join("\n")}
} from "../data/check";
import type { Check } from "../data/check";
import type { components, operations } from "./api";

type Schemas = components["schemas"];

${body}`;
}

async function main(check) {
  const root = repoRoot();
  const artifacts = [
    { label: "API client", relative: OUTPUT_PATH, rendered: await renderClient(root) },
    { label: "response checks", relative: CHECKS_PATH, rendered: renderChecks(root) },
  ];

  if (check) {
    for (const artifact of artifacts) {
      let committed = null;
      try {
        committed = readFileSync(path.join(root, artifact.relative), "utf8");
      } catch {
        committed = null;
      }
      if (committed !== artifact.rendered) {
        console.error(
          `The generated ${artifact.label} is stale — run 'pnpm generate:client' and commit the result.`,
        );
        process.exit(1);
      }
      console.log(`${artifact.relative} matches ${SPEC_PATH}.`);
    }
    return;
  }

  for (const artifact of artifacts) {
    writeFileSync(path.join(root, artifact.relative), artifact.rendered);
    console.log(
      `wrote ${artifact.relative} (${Buffer.byteLength(artifact.rendered, "utf8")} bytes)`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.includes("--check"));
}
