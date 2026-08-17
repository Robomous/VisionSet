/**
 * How the dashboard's sections are decided, without a screen in the way.
 *
 * The claims here are the ones that would be tedious to make through a rendered
 * list and are total over the grouping instead: that every described capability
 * gets a section whether or not anything serves it, that a connection is under
 * each ability it declares, and that neither an unrecognised value nor a
 * connection that declares nothing falls out of the list.
 *
 * **The totality of the copy is the compiler's job, not this file's.**
 * `CAPABILITY_COPY` is a `Record` over the vocabulary's *known* members — the wire
 * type admits a value a newer server added, the known-member union does not — so
 * adding a member to the kernel's vocabulary fails `tsc` until its entry exists. What the first test
 * below adds is the *order*, which no type can state — and it fails on a new
 * member too, which is the point: somebody has to look at where the section goes.
 */

import { expect, it } from "vitest";

import { sectionsOf, UNDECLARED } from "./inferenceSections";
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
    setup_state: "ready",
    allowed_actions: [],
    capabilities,
    download: null,
    integrity_check: null,
    created_at: "2026-08-10T00:00:00Z",
    updated_at: "2026-08-10T00:00:00Z",
    ...overrides,
  } as unknown as Connection;
}

it("gives every described ability a section, in one fixed order, with nothing to show", () => {
  expect(sectionsOf([]).map((section) => section.key)).toEqual(["point_suggest", "text_detect"]);
});

it("keeps an empty section distinguishable from a served one", () => {
  const [suggest, detect] = sectionsOf([connection("sam", ["point_suggest"])]);
  expect(suggest!.connections.map((row) => row.name)).toEqual(["sam"]);
  expect(detect!.connections).toEqual([]);
});

it("puts a connection under every ability it declares", () => {
  const sections = sectionsOf([connection("both", ["point_suggest", "text_detect"])]);
  // The same connection, not a copy of it: acting on either is acting on one row.
  const [suggest, detect] = sections;
  expect(suggest!.connections[0]).toBe(detect!.connections[0]);
});

it("renders a value this build has no name for rather than dropping the row", () => {
  // The zero-orphaned-capabilities invariant, at the layer that decides where a
  // row goes: a section built from the value itself, marked as one this build
  // cannot describe, holding the connection that declared it.
  const sections = sectionsOf([connection("newer", ["depth_estimate"])]);
  const generic = sections.find((section) => section.key === "depth_estimate");
  expect(generic).not.toBeUndefined();
  expect(generic!.known).toBe(false);
  expect(generic!.title).toBe("depth_estimate");
  expect(generic!.connections.map((row) => row.name)).toEqual(["newer"]);
});

it("keeps a connection that has not said what it answers", () => {
  // The commonest state there is: capability is read off weights, so a connection
  // whose download has not run declares nothing. A row in no section would be a
  // connection nobody could download, edit or delete.
  const sections = sectionsOf([connection("fresh", [])]);
  const waiting = sections.find((section) => section.key === UNDECLARED);
  expect(waiting!.connections.map((row) => row.name)).toEqual(["fresh"]);
});

it("raises neither derived section until something is in it", () => {
  expect(sectionsOf([connection("sam", ["point_suggest"])]).map((one) => one.key)).toEqual([
    "point_suggest",
    "text_detect",
  ]);
});

it("orders unnamed abilities the way the workspace lists them", () => {
  const sections = sectionsOf([
    connection("second", ["zzz_later"]),
    connection("first", ["aaa_earlier"]),
  ]);
  // First seen, not alphabetised: the order is a fact about the workspace.
  expect(sections.map((one) => one.key)).toEqual([
    "point_suggest",
    "text_detect",
    "zzz_later",
    "aaa_earlier",
  ]);
});

it("puts the connections that declare nothing after the abilities that do", () => {
  const sections = sectionsOf([connection("fresh", []), connection("sam", ["point_suggest"])]);
  expect(sections[sections.length - 1]!.key).toBe(UNDECLARED);
});


/*
 * What the undeclared section *says*, which is a different question from which rows
 * land in it. Three things put a connection here and they do not share a remedy: the
 * weights have not been downloaded, the weights are here and nothing came of them, or
 * it is an endpoint whose model this workspace never loads. One sentence covering all
 * three told two thirds of the workspace something untrue about itself.
 */

function undeclared(rows: readonly Connection[]): string {
  return sectionsOf(rows).find((section) => section.key === UNDECLARED)!.purpose;
}

it("says the weights are missing only where they are", () => {
  const purpose = undeclared([connection("fresh", [], { setup_state: "not_set_up" })]);
  expect(purpose).toContain("downloaded");
  expect(purpose).not.toContain("endpoint");
  expect(purpose).not.toContain("driver");
});

it("does not blame the download for a connection whose weights are here", () => {
  // The bug this exists for. `ready` is set as the *last* step of a successful
  // download, so these weights are on disk; saying the ability "cannot be declared
  // until they are here" is a sentence about somebody else's connection.
  const purpose = undeclared([connection("here", [], { setup_state: "ready" })]);
  expect(purpose).toContain("driver");
  expect(purpose).not.toContain("downloaded");
});

it("answers for an endpoint on its own terms", () => {
  const purpose = undeclared([
    connection("hosted", [], { connection_type: "http", setup_state: "ready" }),
  ]);
  expect(purpose).toContain("endpoint");
  expect(purpose).not.toContain("downloaded");
  expect(purpose).not.toContain("driver");
});

it("names every reason a mixed section actually holds, and only those", () => {
  const purpose = undeclared([
    connection("fresh", [], { setup_state: "not_set_up" }),
    connection("here", [], { setup_state: "ready" }),
    connection("hosted", [], { connection_type: "http", setup_state: "ready" }),
  ]);
  expect(purpose).toContain("downloaded");
  expect(purpose).toContain("driver");
  expect(purpose).toContain("endpoint");
});
