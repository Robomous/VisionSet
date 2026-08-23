/**
 * How the Models page names an ability and filters by one, without a screen in
 * the way.
 *
 * The claims here are the ones that would be tedious to make through a rendered
 * grid and are total over the vocabulary instead: that every described
 * capability gets a chip whether or not anything serves it, that a connection
 * answers the chip of each ability it declares and a bare one answers only All,
 * and that neither an unrecognised value nor a connection that declares nothing
 * falls out of the page.
 *
 * **The totality of the copy is the compiler's job, not this file's.**
 * `CAPABILITY_COPY` is a `Record` over the vocabulary's *known* members — the wire
 * type admits a value a newer server added, the known-member union does not — so
 * adding a member to the kernel's vocabulary fails `tsc` until its entry exists.
 * What the first test below adds is the *order*, which no type can state — and it
 * fails on a new member too, which is the point: somebody has to look at where
 * the chip goes.
 */

import { expect, it } from "vitest";

import {
  capabilityBadge,
  capabilityBadgeVariant,
  capabilityChips,
  inviteFor,
  underCapability,
} from "./modelCapabilities";
import type { Connection } from "../data/inferenceQueries";

function connection(
  name: string,
  capabilities: readonly string[],
  overrides: Partial<Connection> = {},
): Connection {
  return {
    id: `id-${name}`,
    name,
    connection_type: "local",
    model_id: "some/model",
    model_revision: "abc123",
    device: "cpu",
    precision: "fp32",
    endpoint_url: null,
    provider_id: "sam",
    credential_env: null,
    origin: "huggingface",
    setup_state: "ready",
    allowed_actions: [],
    capabilities,
    produces: [],
    download: null,
    integrity_check: null,
    created_at: "2026-08-10T00:00:00Z",
    updated_at: "2026-08-10T00:00:00Z",
    ...overrides,
  } as unknown as Connection;
}

it("gives every described ability a chip, in one fixed order, with nothing to show", () => {
  expect(capabilityChips([]).map((chip) => chip.key)).toEqual(["point_suggest", "text_detect"]);
});

it("labels a described chip in a person's words and marks it known", () => {
  const [suggest, detect] = capabilityChips([]);
  expect(suggest).toEqual({ key: "point_suggest", label: "Point prompts", known: true });
  expect(detect).toEqual({ key: "text_detect", label: "Text prompts", known: true });
});

it("adds a chip for a value this build has no name for, from the value itself", () => {
  // The zero-orphaned-capabilities invariant, at the layer that decides what the
  // filter offers: a chip built from the value, marked as one this build cannot
  // describe, rather than a connection no chip reaches.
  const chips = capabilityChips([connection("newer", ["depth_estimate"])]);
  expect(chips.find((chip) => chip.key === "depth_estimate")).toEqual({
    key: "depth_estimate",
    label: "depth_estimate",
    known: false,
  });
});

it("orders unnamed abilities the way the workspace lists them, after the named ones", () => {
  const chips = capabilityChips([
    connection("second", ["zzz_later"]),
    connection("first", ["aaa_earlier", "zzz_later"]),
  ]);
  // First seen, not alphabetised, and once each: the order is a fact about the
  // workspace.
  expect(chips.map((chip) => chip.key)).toEqual([
    "point_suggest",
    "text_detect",
    "zzz_later",
    "aaa_earlier",
  ]);
});

it("raises no chip for a connection that has not said what it answers", () => {
  // The commonest state there is: capability is read off weights, so a connection
  // whose download has not run declares nothing. There is nothing to name a chip
  // after, and All is where such a card lives.
  expect(capabilityChips([connection("fresh", [])]).map((chip) => chip.key)).toEqual([
    "point_suggest",
    "text_detect",
  ]);
});

it("shows every connection under All, including one that declares nothing", () => {
  const rows = [connection("fresh", []), connection("sam", ["point_suggest"])];
  expect(underCapability(rows, null)).toBe(rows);
});

it("shows a connection under each ability it declares, and a bare one under none", () => {
  const both = connection("both", ["point_suggest", "text_detect"]);
  const fresh = connection("fresh", []);
  const rows = [both, fresh];
  // The same connection, not a copy of it: acting on it from either chip is
  // acting on one card.
  expect(underCapability(rows, "point_suggest")[0]).toBe(both);
  expect(underCapability(rows, "text_detect")).toEqual([both]);
  expect(underCapability(rows, "depth_estimate")).toEqual([]);
});

it("says what a model does on its badge, in product prose, and passes an unknown value through", () => {
  expect(capabilityBadge("point_suggest")).toBe("Suggests from clicks");
  expect(capabilityBadge("text_detect")).toBe("Finds what you name");
  // Display, never drop: what a newer server declares is what the reader needs.
  expect(capabilityBadge("depth_estimate")).toBe("depth_estimate");
});

it("colours each described ability's badge with its own series, and an unknown one with none", () => {
  const point = capabilityBadgeVariant("point_suggest");
  const text = capabilityBadgeVariant("text_detect");
  // Series, never status: the kind of prompt a model answers is a category, and
  // the two kinds must be told apart before the words are read.
  expect(point).toMatch(/^series-\d$/);
  expect(text).toMatch(/^series-\d$/);
  expect(point).not.toBe(text);
  expect(capabilityBadgeVariant("depth_estimate")).toBe("neutral");
});

it("invites a connection for a described ability, and has nothing to invite for one it cannot name", () => {
  const detect = inviteFor("text_detect");
  expect(detect?.cta).toBe("Add a text-prompt connection");
  expect(detect?.body).toContain("before anybody opens it");
  expect(inviteFor("point_suggest")?.cta).toBe("Add a point-prompt connection");
  expect(inviteFor("depth_estimate")).toBeUndefined();
});

it("does not treat an inherited object key as a described capability", () => {
  // `toString` is on every object's prototype. A lookup that read through the
  // chain would badge a connection declaring it with a function's source.
  expect(capabilityBadge("toString")).toBe("toString");
  expect(inviteFor("constructor")).toBeUndefined();
});
