/**
 * What the form makes of a served catalog, which no screen test can see.
 *
 * A form test can prove the select is built from these functions. It cannot
 * prove what happens to an entry whose capability this build has never heard of,
 * to a catalog holding nothing, or to a preferred default that is not installed
 * — and those are the cases a served list has and a hardcoded one did not.
 *
 * What used to be asserted here and is **not** gone: that every entry pins a
 * commit rather than a branch, and that every entry says what it is for. Those
 * are properties of a driver's declaration now, and
 * `tests/inference/test_provider_conformance.py` holds every installed driver to
 * them — including drivers this repository did not write, which is the half no
 * test in this file could ever have covered.
 */

import { expect, it } from "vitest";

import type { CuratedEntry } from "../data/inferenceQueries";
import {
  DEVICES,
  PREFERRED_MODEL_ID,
  accessFor,
  defaultEntry,
  entriesOf,
  entryFor,
  groupsOf,
  precisionOn,
  precisionsFor,
} from "./inferenceCatalog";

const COMMIT = "0".repeat(40);

function entry(overrides: Partial<CuratedEntry> = {}): CuratedEntry {
  return {
    model_id: "acme/seg-small",
    model_revision: COMMIT,
    family: "acme_seg",
    capability: "point_suggest",
    hint: "small — light on a CPU",
    access_note: null,
    access_url: null,
    ...overrides,
  };
}

it("flattens the drivers into one list of offers, in the order they were served", () => {
  const flat = entriesOf([
    { provider_id: "acme", families: {}, curated: [entry({ model_id: "a" }), entry({ model_id: "b" })] },
    { provider_id: "zeta", families: {}, curated: [entry({ model_id: "c" })] },
  ]);

  expect(flat.map((one) => one.model_id)).toEqual(["a", "b", "c"]);
});

it("groups the offers under the heading this build has for each ability", () => {
  const groups = groupsOf([
    entry({ model_id: "a", capability: "point_suggest" }),
    entry({ model_id: "b", capability: "text_detect" }),
  ]);

  expect(groups.map((one) => one.key)).toEqual(["point_suggest", "text_detect"]);
  expect(groups[0]!.label).toBe("Interactive segmentation (point prompts)");
});

it("renders no heading over an ability nothing offers a model for", () => {
  // A section of the dashboard that holds nothing is an invitation. A group in a
  // select that holds nothing is a heading over an empty space, which is chrome
  // rather than information.
  const groups = groupsOf([entry({ capability: "point_suggest" })]);

  expect(groups.map((one) => one.key)).toEqual(["point_suggest"]);
});

it("shows an ability this build has never heard of under its own name", () => {
  // The capability vocabulary is open, so a newer server or an installed driver
  // may name one this build was not compiled against. Dropping it would hide a
  // model the installation can actually run.
  const groups = groupsOf([
    entry({ model_id: "a", capability: "point_suggest" }),
    entry({ model_id: "b", capability: "depth_estimate" }),
  ]);

  expect(groups.map((one) => one.key)).toEqual(["point_suggest", "depth_estimate"]);
  expect(groups[1]!.label).toBe("depth_estimate");
});

it("opens on the preferred model when the installation offers it", () => {
  const chosen = defaultEntry([
    entry({ model_id: "acme/other" }),
    entry({ model_id: PREFERRED_MODEL_ID }),
  ]);

  expect(chosen?.model_id).toBe(PREFERRED_MODEL_ID);
});

it("falls back to the first point-prompt offer when the preferred one is absent", () => {
  // The whole reason the default is a product decision here rather than a flag on
  // the contract: an installation this repository never saw still opens on
  // something a person can use, and no plugin decides what that is.
  const chosen = defaultEntry([
    entry({ model_id: "acme/detect", capability: "text_detect" }),
    entry({ model_id: "acme/seg-tiny", capability: "point_suggest" }),
    entry({ model_id: "acme/seg-large", capability: "point_suggest" }),
  ]);

  expect(chosen?.model_id).toBe("acme/seg-tiny");
});

it("opens on nothing when no offer answers a point prompt", () => {
  expect(defaultEntry([])).toBeUndefined();
  expect(defaultEntry([entry({ capability: "text_detect" })])).toBeUndefined();
});

it("treats the pair as the identity of an offer", () => {
  const one = entry({ model_id: "acme/seg-small" });

  expect(entryFor([one], "acme/seg-small", COMMIT)).toBe(one);
  // The same model at another revision is a custom connection wearing a familiar
  // name, and calling it the offered entry would misreport its weights.
  expect(entryFor([one], "acme/seg-small", "deadbeef")).toBeUndefined();
});

it("answers the access requirement by model id alone", () => {
  // An access gate belongs to the repository: pinning another commit of the same
  // model exempts nobody from its terms, so a line that disappeared when the
  // revision was edited would hide a requirement that still applies.
  const gated = entry({
    model_id: "acme/gated",
    access_note: "Acme grants access by request.",
    access_url: "https://example.invalid/acme/gated",
  });

  expect(accessFor([gated], "acme/gated")).toEqual({
    note: "Acme grants access by request.",
    href: "https://example.invalid/acme/gated",
  });
  expect(accessFor([gated], "acme/ungated")).toBeUndefined();
});

it("says nothing about access when only half of it was declared", () => {
  // Either half alone is a requirement a form cannot finish stating before it
  // offers the download, so it states none of it and the refusal answers.
  const half = entry({ model_id: "acme/half", access_note: "Ask first." });

  expect(accessFor([half], "acme/half")).toBeUndefined();
});

it("offers the devices the kernel names, in the order the form offers them", () => {
  expect([...DEVICES]).toEqual(["cpu", "cuda", "mps"]);
});

it("offers half precision only where an adapter honours it", () => {
  expect(precisionsFor("cuda")).toEqual(["fp16", "fp32"]);
  expect(precisionsFor("cuda:1")).toEqual(["fp16", "fp32"]);
  expect(precisionsFor("cpu")).toEqual(["fp32"]);
  expect(precisionsFor("mps")).toEqual(["fp32"]);
});

it("keeps a precision that survives a device change and moves one that does not", () => {
  expect(precisionOn("cuda", "fp16")).toBe("fp16");
  expect(precisionOn("cpu", "fp16")).toBe("fp32");
  expect(precisionOn("cpu", "fp32")).toBe("fp32");
});
