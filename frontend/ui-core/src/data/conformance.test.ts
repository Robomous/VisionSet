/**
 * The generated checks, against a second reader of the same contract.
 *
 * ## Why this is not circular
 *
 * `check.test.ts` asserts what the combinators mean, by hand. This file asserts that
 * the *generator* wired them up the way the spec says — and the danger there is
 * obvious: a test that built its fixtures with the generator's own reading of
 * `openapi.json` would agree with itself no matter how wrong both were.
 *
 * So the oracle below is a second, deliberately naive validator, written by hand in
 * this file and walking the raw JSON Schema directly. The only thing it shares with
 * the generated checks is `openapi.json`, which is the contract and is exactly what
 * they are both supposed to be reading. Where the two disagree, one of them has a bug.
 *
 * It also covers the two failure modes `tsc` provably cannot catch — a dropped
 * nullable, and a check stricter than the type — because both are *over*-validation,
 * and an over-strict check is assignable to the type it over-validates.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Check } from "./check";
import * as generated from "../generated/checks";

interface Spec {
  readonly components: { readonly schemas: Record<string, JsonSchema> };
}

interface JsonSchema {
  readonly $ref?: string;
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly prefixItems?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly enum?: readonly string[];
  readonly const?: string;
  readonly additionalProperties?: JsonSchema | boolean;
  readonly default?: unknown;
}

// From the package root, which is where vitest runs. `import.meta.url` is not a
// `file:` URL here — vite rewrites it — so it cannot be used to find the repo.
const spec = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../openapi.json"), "utf8"),
) as Spec;

const schemas = spec.components.schemas;

const deref = (schema: JsonSchema): JsonSchema =>
  schema.$ref === undefined ? schema : schemas[schema.$ref.replace("#/components/schemas/", "")];

/**
 * The oracle. Naive on purpose — no paths, no messages, no early exit worth naming,
 * just "does this document satisfy this schema".
 */
function conforms(schema: JsonSchema, value: unknown): boolean {
  const node = deref(schema);

  if (node.const !== undefined) return value === node.const;
  if (node.enum !== undefined) return typeof value === "string" && node.enum.includes(value);

  const branches = node.oneOf ?? node.anyOf;
  if (branches !== undefined) return branches.some((branch) => conforms(branch, value));

  switch (node.type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    case "array": {
      if (!Array.isArray(value)) return false;
      if (node.prefixItems !== undefined) {
        return (
          value.length === node.prefixItems.length &&
          node.prefixItems.every((item, index) => conforms(item, value[index]))
        );
      }
      return node.items === undefined || value.every((item) => conforms(node.items!, item));
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const held = value as Record<string, unknown>;
      if (node.properties === undefined) {
        const extra = node.additionalProperties;
        if (extra === undefined || typeof extra === "boolean") return true;
        return Object.values(held).every((entry) => conforms(extra, entry));
      }
      return Object.entries(node.properties).every(([key, property]) => {
        // A property with a `default` is always sent, so it is required in a response
        // even when `required` omits it. The generator reads it that way because
        // `openapi-typescript` types it that way; the oracle has to agree or it is
        // testing a different contract.
        const always = (node.required ?? []).includes(key) || property.default !== undefined;
        if (held[key] === undefined) return !always;
        return conforms(property, held[key]);
      });
    }
    default:
      return true;
  }
}

/** A minimal document that satisfies a schema, built from the schema. */
function example(schema: JsonSchema, depth = 0): unknown {
  const node = deref(schema);
  // Only a safety net: `reachableSchemas` proves the $ref graph acyclic, so nothing
  // here can recurse forever. Eight was too shallow — `SchemaVersionPage` nests six
  // schemas deep before it reaches `AttributeBody.options`.
  if (depth > 20) return null;
  if (node.const !== undefined) return node.const;
  if (node.enum !== undefined) return node.enum[0];
  const branches = node.oneOf ?? node.anyOf;
  if (branches !== undefined) return example(branches[0], depth + 1);
  switch (node.type) {
    case "string":
      return "x";
    case "boolean":
      return true;
    case "integer":
      return 1;
    case "number":
      return 1.5;
    case "null":
      return null;
    case "array":
      return node.prefixItems === undefined
        ? node.items === undefined
          ? []
          : [example(node.items, depth + 1)]
        : node.prefixItems.map((item) => example(item, depth + 1));
    case "object": {
      if (node.properties === undefined) {
        const extra = node.additionalProperties;
        // A populated entry, not `{}`. An empty map has no positions inside it, so a
        // corpus built from one never mutates the values — and two generator bugs
        // survived exactly that hole: `mapOf` degraded to "any object", and a
        // stray `isNull` added to the attribute-value union that lives in here.
        if (extra === undefined || typeof extra === "boolean") return {};
        return { sample: example(extra, depth + 1) };
      }
      const built: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(node.properties)) {
        built[key] = example(property, depth + 1);
      }
      return built;
    }
    default:
      return null;
  }
}

/** Every position inside a document, as a path of keys and indices. */
function positions(value: unknown, at: readonly (string | number)[] = []): (string | number)[][] {
  const here: (string | number)[][] = at.length === 0 ? [] : [[...at]];
  if (Array.isArray(value)) {
    return here.concat(...value.map((item, index) => positions(item, [...at, index])));
  }
  if (typeof value === "object" && value !== null) {
    return here.concat(
      ...Object.entries(value as Record<string, unknown>).map(([key, held]) =>
        positions(held, [...at, key]),
      ),
    );
  }
  return here;
}

function replaceAt(value: unknown, at: readonly (string | number)[], next: unknown): unknown {
  if (at.length === 0) return next;
  const [head, ...rest] = at;
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[head as number] = replaceAt(copy[head as number], rest, next);
    return copy;
  }
  const copy = { ...(value as Record<string, unknown>) };
  copy[head as string] = replaceAt(copy[head as string], rest, next);
  return copy;
}

function removeAt(value: unknown, at: readonly (string | number)[]): unknown {
  if (at.length === 1) {
    if (Array.isArray(value)) return value.filter((_, index) => index !== at[0]);
    const copy = { ...(value as Record<string, unknown>) };
    delete copy[at[0] as string];
    return copy;
  }
  const [head, ...rest] = at;
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[head as number] = removeAt(copy[head as number], rest);
    return copy;
  }
  const copy = { ...(value as Record<string, unknown>) };
  copy[head as string] = removeAt(copy[head as string], rest);
  return copy;
}

/**
 * Every mutation worth trying on one document.
 *
 * Deliberately **deep**: an earlier version mutated only the top-level keys, and a
 * generator bug that replaced `PolygonBody.points`' tuple with a loose `number[]`
 * survived it — the corpus never reached inside `points` to try a one-element
 * "point". Walking every position is what makes the nested constructs — tuples,
 * discriminated unions, attribute maps — actually exercised.
 */
function mutants(valid: unknown): unknown[] {
  const out: unknown[] = [];
  for (const at of positions(valid)) {
    // A sentinel no schema in this contract accepts, and one of each JSON kind, so a
    // check that is too loose *or* too strict at this position shows up as a
    // disagreement with the oracle.
    for (const substitute of [Symbol.iterator.toString(), null, 1, true, [], {}]) {
      out.push(replaceAt(valid, at, substitute));
    }
    out.push(removeAt(valid, at));
  }
  return out;
}

const checks = generated as unknown as Record<string, Check<unknown> | undefined>;

/** Every schema the generator emitted a check for, paired with that check. */
const covered = Object.keys(schemas)
  .map((name) => ({ name, check: checks[`check${name}`] }))
  .filter((entry): entry is { name: string; check: Check<unknown> } => entry.check !== undefined);

const agree = (check: Check<unknown>, value: unknown): boolean => check(value, [], () => {});

describe("the generated checks and a second reading of the spec", () => {
  it("covers every schema a 2xx JSON response can carry", () => {
    // 51 of the 66 component schemas are reachable from a response; the rest are
    // request bodies. If this drops, the generator stopped emitting something.
    expect(covered.length).toBeGreaterThanOrEqual(50);
  });

  it("agree that a conforming document conforms", () => {
    const disagreed: string[] = [];
    for (const { name, check } of covered) {
      const valid = example(schemas[name]);
      if (!conforms(schemas[name], valid)) disagreed.push(`${name}: the oracle rejects its own example`);
      if (!agree(check, valid)) disagreed.push(`${name}: the generated check rejects a valid document`);
    }
    expect(disagreed).toEqual([]);
  });

  it("agree on every mutation of every schema", () => {
    // This is the half that catches a dropped nullable or an over-strict field —
    // the two generator bugs the compiler cannot see, because a check that is
    // stricter than its type is still assignable to it.
    const disagreed: string[] = [];
    let compared = 0;
    for (const { name, check } of covered) {
      for (const mutant of mutants(example(schemas[name]))) {
        compared += 1;
        const oracle = conforms(schemas[name], mutant);
        if (agree(check, mutant) !== oracle) {
          disagreed.push(
            `${name}: generated says ${!oracle}, spec says ${oracle} for ${JSON.stringify(mutant).slice(0, 120)}`,
          );
        }
      }
    }
    expect(disagreed).toEqual([]);
    expect(compared).toBeGreaterThan(2000);
  });

  it("accept an unknown key everywhere, because a server may add a field", () => {
    for (const { name, check } of covered) {
      const valid = example(schemas[name]);
      if (typeof valid !== "object" || valid === null || Array.isArray(valid)) continue;
      const widened = { ...(valid as Record<string, unknown>), invented_later: "…" };
      expect(agree(check, widened), `${name} refused an added field`).toBe(true);
    }
  });
});
