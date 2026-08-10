/**
 * The combinators the generated response checks are built from.
 *
 * This is the hand-written half of `./generated/checks.ts`, exactly as `../client.ts`
 * is the hand-written half of `../generated/api.ts`: the generator decides *what* the
 * contract says, and this module decides what checking it means.
 *
 * ## Why a check exists at all
 *
 * `openapi-fetch` gives every response a static type off the contract, and nothing
 * whatsoever at runtime. `unwrap` used to return `result.data` unexamined, so a
 * well-formed JSON document of the *wrong* type reached a screen intact and one
 * `undefined` in a formatter took the page down with it. That happened three times
 * three times over one milestone, and the fixes were three separate hand-written
 * guards at three render sites. This is the one mechanism that replaces them.
 *
 * ## Why combinators rather than one generated predicate per schema
 *
 * Because the compiler can check them. A generated
 * `export const checkAssetOut: Check<components["schemas"]["AssetOut"]> = object({…})`
 * is verified by `tsc` against the generated *type*, so a generator that emits
 * `isString` for a numeric field, flips a `required` flag, drops a property, or
 * widens a `const` fails the build. Four of the six ways the generator can be wrong
 * are caught before any test runs. The two it cannot catch — a dropped nullable and
 * an over-strict extra field — are both *over*-validation, and they are what
 * `tests/scripts/checks_conformance.test.mjs` exists for.
 *
 * ## Three rules, each of which is a decision
 *
 * **Unknown keys are allowed.** `additionalProperties: false` in the spec constrains
 * what pydantic *accepts*, not what the server may one day *send*. A client that
 * refused a response because it grew a field would turn every additive, backward-
 * compatible API change into a broken page. Forward compatibility wins, and a test
 * pins it so it cannot be tightened by accident.
 *
 * **`format` is not validated.** `uuid` and `date-time` are checked as `string` and
 * nothing more. A renderer is protected by the *type*; rejecting a legal ISO-8601
 * variant would be a new bug, and the fixtures across this repo use ids like
 * `"asset-1"` that are honest test data and not UUIDs.
 *
 * **First failure wins.** The walk stops at the first mismatch and reports its path,
 * because the useful half of the message is *where*, not *how many*.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
 * `Check<any>` is the only way to write a heterogeneous list of checks whose element
 * types differ (`either([isString, isNull])`). `Check<unknown>` would not do: a
 * `Check<string>` is not assignable to it, because a type predicate is invariant in
 * its asserted type. The `any` never escapes — every combinator recovers the real
 * type through `Out<C>`, which is what makes the generated annotations checkable.
 */

/** Where in the document the walk currently is, as JSON-Pointer segments. */
export type Path = readonly string[];

/** Told the path of the first mismatch and what was expected there. */
export type Report = (at: Path, want: string) => void;

/**
 * A runtime witness that a value really is `T`.
 *
 * The extra parameters are what make the failure legible: a bare
 * `(v: unknown) => v is T` can say only "no", and "no" about a forty-field document
 * is not an answer anybody can act on.
 */
export type Check<T> = (value: unknown, at: Path, report: Report) => value is T;

type AnyCheck = Check<any>;

/** Recover the type a check asserts. */
type Out<C> = C extends Check<infer T> ? T : never;

/** One declared property: whether the contract requires it, and what it holds. */
export type Field = readonly [required: boolean, check: AnyCheck];

export type Fields = Readonly<Record<string, Field>>;

type RequiredKeys<F extends Fields> = {
  [K in keyof F]: F[K][0] extends true ? K : never;
}[keyof F];

/**
 * The object type a `Fields` map describes.
 *
 * Required and optional keys are split deliberately: it is what lets `tsc` catch a
 * generator that marks a required field optional, which is the single most likely
 * generator bug and the one that produced the original white-screens.
 */
type Shape<F extends Fields> = {
  [K in RequiredKeys<F>]: Out<F[K][1]>;
} & {
  [K in Exclude<keyof F, RequiredKeys<F>>]?: Out<F[K][1]>;
};

const quiet: Report = () => {};

export const isString: Check<string> = (value, at, report): value is string => {
  if (typeof value === "string") return true;
  report(at, "a string");
  return false;
};

export const isNumber: Check<number> = (value, at, report): value is number => {
  // `Number.isFinite` rather than `typeof`: JSON cannot carry NaN or Infinity, so a
  // value that is one came from somewhere that is not this contract.
  if (typeof value === "number" && Number.isFinite(value)) return true;
  report(at, "a number");
  return false;
};

export const isInteger: Check<number> = (value, at, report): value is number => {
  if (typeof value === "number" && Number.isInteger(value)) return true;
  report(at, "an integer");
  return false;
};

export const isBoolean: Check<boolean> = (value, at, report): value is boolean => {
  if (typeof value === "boolean") return true;
  report(at, "a boolean");
  return false;
};

export const isNull: Check<null> = (value, at, report): value is null => {
  if (value === null) return true;
  report(at, "null");
  return false;
};

/**
 * Any JSON at all — the check for a field the contract deliberately does not shape.
 *
 * `{}` in OpenAPI means "no constraints", and pydantic's `JsonValue` emits exactly
 * that. `openapi-typescript` renders it as `unknown`, so this is the check that
 * agrees with the generated type: it accepts whatever came back and hands the
 * caller something it must narrow before using.
 *
 * **It is a pass-through, and that is honest rather than lazy.** Every other check
 * here exists because the contract promised a shape and the server could break it.
 * A `BackgroundJob.result` promises nothing — its shape belongs to whichever
 * handler produced it, and the one caller that reads a key out of it (the export
 * flow, looking for `archive`) narrows that key itself. Asserting a shape here
 * would be inventing a contract in the client.
 */
export const isJsonValue: Check<unknown> = (value): value is unknown => {
  // `value` is named rather than discarded because a type predicate has to be
  // *about* a parameter; the two the other checks use are what they report a
  // mismatch with, and there is no mismatch to report.
  void value;
  return true;
};

/**
 * A body read with `parseAs: "blob"`.
 *
 * A real check rather than a pass-through, and it earns it: without one, an error
 * page served as JSON and read as a blob would be handed to the browser and saved to
 * disk as `release.zip`.
 */
export const checkBlob: Check<Blob> = (value, at, report): value is Blob => {
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  report(at, "binary content");
  return false;
};

/**
 * A 204, or any other answer the contract says carries no body.
 *
 * `openapi-fetch` reports those as `data: undefined`, so this is the one check that
 * expects to be handed nothing.
 */
export const checkNoContent: Check<undefined> = (value, at, report): value is undefined => {
  if (value === undefined) return true;
  report(at, "no body at all");
  return false;
};

/** A single declared string, the shape a discriminator tag takes. */
export function lit<V extends string>(expected: V): Check<V> {
  return (value, at, report): value is V => {
    if (value === expected) return true;
    report(at, `"${expected}"`);
    return false;
  };
}

/** A closed set of strings — the contract's enums. */
export function oneOf<V extends string>(allowed: readonly V[]): Check<V> {
  const permitted = new Set<string>(allowed);
  return (value, at, report): value is V => {
    if (typeof value === "string" && permitted.has(value)) return true;
    report(at, allowed.map((option) => `"${option}"`).join(" or "));
    return false;
  };
}

/**
 * An object with declared properties.
 *
 * Unknown keys pass (see the module docstring). A key present with the value
 * `undefined` counts as absent, because that is what a hand-written test fixture
 * spelling an optional field tends to produce, and JSON itself never can.
 */
export function object<F extends Fields>(fields: F): Check<Shape<F>> {
  const declared = Object.entries(fields);
  return (value, at, report): value is Shape<F> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      report(at, "an object");
      return false;
    }
    const record = value as Record<string, unknown>;
    for (const [key, [required, check]] of declared) {
      const held = record[key];
      if (held === undefined) {
        if (!required) continue;
        report([...at, key], "present");
        return false;
      }
      if (!check(held, [...at, key], report)) return false;
    }
    return true;
  };
}

/** A homogeneous array. */
export function arrayOf<T>(item: Check<T>): Check<T[]> {
  return (value, at, report): value is T[] => {
    if (!Array.isArray(value)) {
      report(at, "an array");
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!item(value[index], [...at, String(index)], report)) return false;
    }
    return true;
  };
}

/** An object used as a map — the contract's `additionalProperties` schemas. */
export function mapOf<T>(entry: Check<T>): Check<Record<string, T>> {
  return (value, at, report): value is Record<string, T> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      report(at, "an object");
      return false;
    }
    for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
      if (!entry(held, [...at, key], report)) return false;
    }
    return true;
  };
}

/**
 * Any one of several shapes.
 *
 * This is how the contract spells a nullable field (`anyOf: [X, {type: null}]`) and
 * how it spells the attribute-value union. Branches are probed silently, because a
 * branch that failed is not news — only the fact that none matched is.
 */
export function either<C extends readonly AnyCheck[]>(options: C): Check<Out<C[number]>> {
  return (value, at, report): value is Out<C[number]> => {
    for (const option of options) {
      if (option(value, at, quiet)) return true;
    }
    report(at, "one of the declared alternatives");
    return false;
  };
}

/**
 * A discriminated union — one `oneOf` with a `discriminator` in this contract, the
 * annotation geometry.
 *
 * Dispatching on the tag rather than probing every branch is what makes the failure
 * useful: a polygon whose `points` are malformed is reported as a bad polygon, not
 * as "none of bbox, polygon or classification_tag matched".
 */
export function tagged<M extends Readonly<Record<string, AnyCheck>>>(
  tag: string,
  variants: M,
): Check<Out<M[keyof M]>> {
  return (value, at, report): value is Out<M[keyof M]> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      report(at, "an object");
      return false;
    }
    const found = (value as Record<string, unknown>)[tag];
    if (typeof found !== "string" || !Object.hasOwn(variants, found)) {
      report(
        [...at, tag],
        Object.keys(variants)
          .map((name) => `"${name}"`)
          .join(" or "),
      );
      return false;
    }
    return variants[found](value, at, report);
  };
}

/** A fixed-length, positionally typed array — the contract's `prefixItems`. */
export function tuple<C extends readonly AnyCheck[]>(
  items: C,
): Check<{ -readonly [I in keyof C]: Out<C[I]> }> {
  return (value, at, report): value is { -readonly [I in keyof C]: Out<C[I]> } => {
    if (!Array.isArray(value)) {
      report(at, "an array");
      return false;
    }
    if (value.length !== items.length) {
      report(at, `${items.length} items`);
      return false;
    }
    for (let index = 0; index < items.length; index += 1) {
      if (!items[index](value[index], [...at, String(index)], report)) return false;
    }
    return true;
  };
}

/**
 * Run a check and say where it first disagreed.
 *
 * `null` means the value conformed. Anything else is a sentence naming the path and
 * what belonged there, ready to be put in an error a person reads.
 */
export function firstMismatch<T>(check: Check<T>, value: unknown): string | null {
  let found: string | null = null;
  const record: Report = (at, want) => {
    found ??= `${at.length === 0 ? "the body" : `/${at.join("/")}`} should be ${want}`;
  };
  return check(value, [], record) ? null : (found ?? "the body should be the declared shape");
}
