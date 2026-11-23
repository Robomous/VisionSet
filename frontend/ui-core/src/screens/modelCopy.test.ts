/**
 * How a connection's facts read, as pure functions: each closed vocabulary is
 * total, the open one passes an unknown value through raw, and no lookup reads
 * through the object prototype.
 */

import { expect, it } from "vitest";

import {
  KIND_LABELS,
  OPTION_LABELS,
  STATE_LABELS,
  capabilityProse,
  kindLabel,
  originLabel,
  originMark,
} from "./modelCopy";

it("names every origin, and marks each with its own fill", () => {
  expect(originLabel("huggingface")).toBe("Hugging Face");
  expect(originLabel("custom")).toBe("Customized");
  expect(originLabel("robomous")).toBe("Robomous");
  expect(new Set((["huggingface", "custom", "robomous"] as const).map(originMark)).size).toBe(3);
  // A fill for the small square beside the name — not the left border it used
  // to be, now that a connection is a row and has no edge of its own.
  expect(originMark("huggingface")).toMatch(/\bbg-origin-hub\b/);
  expect(originMark("custom")).toMatch(/\bbg-origin-custom\b/);
  expect(originMark("robomous")).toMatch(/\bbg-origin-robomous\b/);
  for (const origin of ["huggingface", "custom", "robomous"] as const) {
    expect(originMark(origin)).not.toMatch(/border-l-/);
  }
});

it("says what a model does in product prose, and passes an unknown value through", () => {
  expect(capabilityProse("point_suggest")).toBe("Suggests from clicks");
  expect(capabilityProse("text_detect")).toBe("Finds what you name");
  // Display, never drop: what a newer server declares is what the reader needs.
  expect(capabilityProse("depth_estimate")).toBe("depth_estimate");
});

it("does not treat an inherited object key as a described capability", () => {
  // `toString` is on every object's prototype. A lookup that read through the
  // chain would label a connection declaring it with a function's source.
  expect(capabilityProse("toString")).toBe("toString");
});

it("names where a model runs and whether it is ready in the same words everywhere", () => {
  expect(kindLabel("local")).toBe("Local");
  expect(kindLabel("http")).toBe("HTTP");
  expect(kindLabel("hosted")).toBe("hosted");
  expect(OPTION_LABELS.kind).toBe(KIND_LABELS);
  expect(OPTION_LABELS.state).toBe(STATE_LABELS);
  expect(Object.entries(OPTION_LABELS.capability)).toEqual([
    ["point_suggest", "Point prompts"],
    ["text_detect", "Text prompts"],
  ]);
});
