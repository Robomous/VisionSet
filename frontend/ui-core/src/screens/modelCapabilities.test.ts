/**
 * What the page says about an ability, as pure functions: this build's prose for
 * a described capability, the raw value for one it cannot name, and the lookup
 * never reading through the object prototype. Which abilities the filter offers
 * is `modelFilters.test.ts`'s subject.
 */

import { expect, it } from "vitest";

import { CAPABILITY_OPTION_LABELS, capabilityProse } from "./modelCapabilities";

it("says what a model does on its label, in product prose, and passes an unknown value through", () => {
  expect(capabilityProse("point_suggest")).toBe("Suggests from clicks");
  expect(capabilityProse("text_detect")).toBe("Finds what you name");
  // Display, never drop: what a newer server declares is what the reader needs.
  expect(capabilityProse("depth_estimate")).toBe("depth_estimate");
});

it("names each described ability for a filter, in one fixed order", () => {
  expect(Object.entries(CAPABILITY_OPTION_LABELS)).toEqual([
    ["point_suggest", "Point prompts"],
    ["text_detect", "Text prompts"],
  ]);
});

it("does not treat an inherited object key as a described capability", () => {
  // `toString` is on every object's prototype. A lookup that read through the
  // chain would label a connection declaring it with a function's source.
  expect(capabilityProse("toString")).toBe("toString");
});
