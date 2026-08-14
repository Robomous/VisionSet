/**
 * The curated list's own rules, which no screen test can see.
 *
 * A form test can prove the list is rendered from this module. It cannot prove
 * that an entry added later carries a commit rather than a branch, or that the
 * default is one of the entries at all — and those are exactly the mistakes an
 * addition makes, because the type accepts a plausible-looking string for both.
 */

import { expect, it } from "vitest";

import {
  CURATED_BY_ID,
  CURATED_MODELS,
  CUSTOM_MODEL,
  DEFAULT_MODEL,
  DEVICES,
  curatedEntry,
  precisionOn,
  precisionsFor,
} from "./inferenceCatalog";

const EVERY_MODEL = CURATED_MODELS.flatMap((group) => group.models);

it("pins every curated entry to a commit, never to a moving pointer", () => {
  // The form's own helper text says a moving pointer is not a provenance. A
  // curated list that pinned `main` would be saying it while doing the opposite,
  // and the size beside the entry would describe whatever the branch last was.
  for (const model of EVERY_MODEL) {
    expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
  }
});

it("says what each entry costs and what it is for", () => {
  for (const model of EVERY_MODEL) {
    expect(model.totalBytes).toBeGreaterThan(0);
    expect(model.hint.trim()).not.toBe("");
  }
});

it("names every entry once, so a lookup cannot be ambiguous", () => {
  expect(CURATED_BY_ID.size).toBe(EVERY_MODEL.length);
});

it("defaults to an entry the list actually holds", () => {
  // `DEFAULT_MODEL` is resolved by id, so a rename that missed it would leave
  // the form opening on `undefined` — a blank select and no revision.
  expect(DEFAULT_MODEL).toBeDefined();
  expect(EVERY_MODEL).toContain(DEFAULT_MODEL);
});

it("keeps the custom sentinel out of the model ids it could collide with", () => {
  expect(CURATED_BY_ID.has(CUSTOM_MODEL)).toBe(false);
});

it("treats the pair as the identity of a curated entry", () => {
  expect(curatedEntry(DEFAULT_MODEL.modelId, DEFAULT_MODEL.revision)).toBe(DEFAULT_MODEL);
  // The same model at another revision is a custom connection wearing a
  // familiar name, and calling it the curated entry would misreport its weights.
  expect(curatedEntry(DEFAULT_MODEL.modelId, "deadbeef")).toBeUndefined();
  expect(curatedEntry("someone/else", DEFAULT_MODEL.revision)).toBeUndefined();
});

it("offers half precision on CUDA and on every address of it", () => {
  expect(precisionsFor("cpu")).toEqual(["fp32"]);
  expect(precisionsFor("cuda")).toEqual(["fp16", "fp32"]);
  // A second GPU is still a GPU. This is the kernel's `precisions_for`, and the
  // two answer the same way or the form offers what the kernel refuses.
  expect(precisionsFor("cuda:1")).toEqual(["fp16", "fp32"]);
  // Metal has no float64 and an inconsistent bfloat16, so full precision is the
  // only format that behaves the same on every Mac — and the kernel refuses the
  // pairing at creation, which a form still offering it would walk straight into.
  expect(precisionsFor("mps")).toEqual(["fp32"]);
});

it("keeps a precision that survives a device change and replaces one that does not", () => {
  expect(precisionOn("cuda", "fp32")).toBe("fp32");
  expect(precisionOn("cpu", "fp32")).toBe("fp32");
  expect(precisionOn("cpu", "fp16")).toBe("fp32");
  // Moving a half-precision CUDA connection onto Metal cannot keep the setting.
  expect(precisionOn("mps", "fp16")).toBe("fp32");
});

it("offers the devices every machine can be asked about", () => {
  // `cuda:N` is deliberately absent: how many GPUs this machine has is not
  // something a static list can know, so it is typed by the kernel's pattern and
  // shown by the form only when a row already carries one. `mps` needs no such
  // escape, because a Mac has exactly one.
  expect([...DEVICES]).toEqual(["cpu", "cuda", "mps"]);
});
