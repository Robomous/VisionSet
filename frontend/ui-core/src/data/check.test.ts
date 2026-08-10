/**
 * The combinators, one case per branch the generator can emit.
 *
 * Every fixture here is hand-written and every expectation is stated by a person.
 * That is the whole design of this file: `./conformance.test.ts` compares the generated
 * checks against a second reader of the same spec, which is a strong test of *agreement*
 * and no test at all of whether either one is right. This file is where "right" is
 * asserted, by someone who read the contract.
 *
 * Each `it` fails if its branch is deleted from `check.ts`, which is the mutation
 * claim stated as a checklist rather than run as a tool.
 */

import { describe, expect, it } from "vitest";

import {
  arrayOf,
  checkBlob,
  checkNoContent,
  either,
  firstMismatch,
  isBoolean,
  isInteger,
  isNull,
  isNumber,
  isString,
  lit,
  mapOf,
  object,
  oneOf,
  tagged,
  tuple,
} from "./check";

const bbox = object({
  type: [true, lit("bbox")],
  x: [true, isNumber],
  y: [true, isNumber],
} as const);

const polygon = object({
  type: [true, lit("polygon")],
  points: [true, arrayOf(tuple([isNumber, isNumber] as const))],
} as const);

const geometry = tagged("type", { bbox, polygon });

describe("objects", () => {
  const person = object({ name: [true, isString], nickname: [false, isString] } as const);

  it("refuses a document missing a required key, and names it", () => {
    expect(firstMismatch(person, {})).toBe("/name should be present");
  });

  it("accepts a document that omits an optional key", () => {
    expect(firstMismatch(person, { name: "ada" })).toBeNull();
  });

  it("still checks an optional key that is present", () => {
    expect(firstMismatch(person, { name: "ada", nickname: 7 })).toBe("/nickname should be a string");
  });

  it("accepts an unknown key, because a server may add a field", () => {
    // Forward compatibility, and it is a rule rather than an oversight: a client
    // that refused an additive change would break on every backward-compatible
    // release. Pinned here so it cannot be tightened by accident.
    expect(firstMismatch(person, { name: "ada", invented_later: true })).toBeNull();
  });

  it("refuses an array and null, which `typeof` alone calls objects", () => {
    expect(firstMismatch(person, [])).toBe("the body should be an object");
    expect(firstMismatch(person, null)).toBe("the body should be an object");
  });
});

describe("scalars", () => {
  it("tells an integer from a number that merely is one", () => {
    expect(firstMismatch(isInteger, 3.5)).toBe("the body should be an integer");
    expect(firstMismatch(isInteger, 3)).toBeNull();
    expect(firstMismatch(isNumber, 3.5)).toBeNull();
  });

  it("refuses the numbers JSON cannot carry", () => {
    // A NaN in a body did not come from this contract, and it is exactly the value
    // that renders as "NaN" in a formatter instead of failing.
    expect(firstMismatch(isNumber, Number.NaN)).toBe("the body should be a number");
    expect(firstMismatch(isNumber, Number.POSITIVE_INFINITY)).toBe("the body should be a number");
  });

  it("keeps null and boolean apart from everything else", () => {
    expect(firstMismatch(isNull, null)).toBeNull();
    expect(firstMismatch(isNull, 0)).toBe("the body should be null");
    expect(firstMismatch(isBoolean, "true")).toBe("the body should be a boolean");
  });
});

describe("enums and literals", () => {
  it("refuses a member the contract does not declare", () => {
    const state = oneOf(["draft", "in_annotation"] as const);
    expect(firstMismatch(state, "archived")).toBe('the body should be "draft" or "in_annotation"');
    expect(firstMismatch(state, "draft")).toBeNull();
  });

  it("holds a discriminator tag to its exact value", () => {
    expect(firstMismatch(lit("bbox"), "polygon")).toBe('the body should be "bbox"');
  });
});

describe("arrays, tuples and maps", () => {
  it("names the index of the element that failed", () => {
    expect(firstMismatch(arrayOf(isString), ["a", "b", 3])).toBe("/2 should be a string");
  });

  it("holds a tuple to its arity, which an array check cannot", () => {
    // `PolygonBody.points` is the contract's one `prefixItems`, and a three-number
    // "point" is the shape a renderer would silently draw wrong.
    const point = tuple([isNumber, isNumber] as const);
    expect(firstMismatch(point, [1, 2, 3])).toBe("the body should be 2 items");
    expect(firstMismatch(point, [1])).toBe("the body should be 2 items");
    expect(firstMismatch(point, [1, 2])).toBeNull();
  });

  it("checks every value of a map and names the key", () => {
    // `AnnotationOut.attributes` is `additionalProperties` over a scalar union.
    const attributes = mapOf(either([isBoolean, isNumber, isString] as const));
    expect(firstMismatch(attributes, { a: 1, b: "x", c: true })).toBeNull();
    expect(firstMismatch(attributes, { a: {} })).toBe("/a should be one of the declared alternatives");
  });
});

describe("unions", () => {
  it("accepts either side of a nullable, and refuses a third thing", () => {
    // `anyOf: [X, {type: null}]` is how this contract spells a nullable field.
    const nullableText = either([isString, isNull] as const);
    expect(firstMismatch(nullableText, "x")).toBeNull();
    expect(firstMismatch(nullableText, null)).toBeNull();
    expect(firstMismatch(nullableText, 7)).toBe("the body should be one of the declared alternatives");
  });

  it("dispatches a discriminated union on its tag rather than probing every branch", () => {
    // The difference is the diagnosis. Probing would report "none of the variants
    // matched"; dispatching reports the bad polygon, which is the actionable answer.
    expect(firstMismatch(geometry, { type: "polygon", points: [[1, 2, 3]] })).toBe(
      "/points/0 should be 2 items",
    );
  });

  it("refuses a tag the union does not declare, and lists the ones it does", () => {
    expect(firstMismatch(geometry, { type: "mask" })).toBe('/type should be "bbox" or "polygon"');
  });

  it("refuses a variant's fields carried under another variant's tag", () => {
    expect(firstMismatch(geometry, { type: "bbox", points: [] })).toBe("/x should be present");
  });
});

describe("the two bodies that are not JSON", () => {
  it("accepts binary content and refuses a parsed document", () => {
    // Without this, an error page served as JSON and read with `parseAs: "blob"`
    // would be handed to the browser and saved to disk as `release.zip`.
    expect(firstMismatch(checkBlob, new Blob(["x"]))).toBeNull();
    expect(firstMismatch(checkBlob, { code: "NOT_FOUND" })).toBe(
      "the body should be binary content",
    );
  });

  it("accepts nothing at all only where the contract says a 204", () => {
    expect(firstMismatch(checkNoContent, undefined)).toBeNull();
    expect(firstMismatch(checkNoContent, {})).toBe("the body should be no body at all");
  });
});

describe("the path in a failure", () => {
  it("reads as a JSON pointer through nesting", () => {
    const page = object({
      items: [true, arrayOf(object({ counts: [true, arrayOf(isInteger)] } as const))],
    } as const);
    expect(firstMismatch(page, { items: [{ counts: [1, "2"] }] })).toBe(
      "/items/0/counts/1 should be an integer",
    );
  });

  it("reports the first mismatch and stops", () => {
    const two = object({ a: [true, isString], b: [true, isString] } as const);
    expect(firstMismatch(two, { a: 1, b: 2 })).toBe("/a should be a string");
  });
});
