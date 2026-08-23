/**
 * The Models page's filters, as pure functions: a dimension offers only the
 * values on the page, is withheld until there is a choice to make, an unknown
 * value is offered raw, a stale choice reads as All, and the dimensions combine.
 * How each value reads is `modelCopy.test.ts`'s subject.
 */

import { expect, it } from "vitest";

import {
  DIMENSIONS,
  NO_FILTERS,
  activeFilters,
  anyFilter,
  applyFilters,
  filterOptions,
  offeredDimensions,
  optionsOf,
} from "./modelFilters";
import type { Connection } from "../data/inferenceQueries";

function connection(name: string, overrides: Partial<Connection> = {}): Connection {
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
    capabilities: ["point_suggest"],
    produces: ["bbox"],
    download: null,
    integrity_check: null,
    created_at: "2026-08-10T00:00:00Z",
    updated_at: "2026-08-10T00:00:00Z",
    ...overrides,
  } as unknown as Connection;
}

const hub = connection("hub");
const own = connection("own", {
  connection_type: "http",
  origin: "custom",
  device: null,
  precision: null,
  endpoint_url: "https://models.example/predict",
  capabilities: ["text_detect"],
});
const pending = connection("pending", { setup_state: "not_set_up" });

it("offers only the values on the page, named ones first in this build's order", () => {
  // Three origins this build names, one on the page: one option, not three.
  expect(optionsOf([hub], "origin").map((o) => o.key)).toEqual(["huggingface"]);
  // In this build's order, not the listing's.
  expect(optionsOf([own, hub], "origin").map((o) => o.label)).toEqual([
    "Hugging Face",
    "Customized",
  ]);
  expect(optionsOf([own, hub], "capability").map((o) => o.label)).toEqual([
    "Point prompts",
    "Text prompts",
  ]);
  expect(optionsOf([hub, own], "kind").map((o) => o.label)).toEqual(["Local", "HTTP"]);
  expect(optionsOf([pending, hub], "state").map((o) => o.label)).toEqual([
    "Ready",
    "Not set up",
  ]);
});

it("offers a value this build cannot name raw, after the named ones, in listing order", () => {
  // Ability is the open vocabulary on this page: a newer server's member
  // arrives through the generated check and must reach a filter.
  const rows = [
    connection("z", { capabilities: ["z_sense"] }),
    connection("a", { capabilities: ["a_sense"] }),
    own,
  ];
  expect(optionsOf(rows, "capability").map((o) => [o.key, o.known])).toEqual([
    ["text_detect", true],
    ["z_sense", false],
    ["a_sense", false],
  ]);
});

it("withholds a dimension until there is a choice to make", () => {
  // One of everything: nothing to choose, so nothing is offered.
  expect(offeredDimensions(filterOptions([hub]))).toEqual([]);
  // Two origins and two abilities and two kinds, one state: those three.
  expect(offeredDimensions(filterOptions([hub, own]))).toEqual(["origin", "capability", "kind"]);
  // Every dimension, in the page's order.
  expect(offeredDimensions(filterOptions([hub, own, pending]))).toEqual([...DIMENSIONS]);
  // Nothing on the page: nothing offered.
  expect(offeredDimensions(filterOptions([]))).toEqual([]);
});

it("reads a stale choice as All: a value gone from the page, or a dimension no longer offered", () => {
  const options = filterOptions([hub, own]);
  expect(activeFilters(options, { ...NO_FILTERS, origin: "custom" }).origin).toBe("custom");
  // The value left the workspace.
  expect(activeFilters(options, { ...NO_FILTERS, origin: "robomous" }).origin).toBeNull();
  // The dimension fell back to one value and left the page.
  expect(activeFilters(options, { ...NO_FILTERS, state: "ready" }).state).toBeNull();
});

it("shows everything under All, and narrows by each dimension alone", () => {
  const rows = [hub, own, pending];
  expect(anyFilter(NO_FILTERS)).toBe(false);
  expect(applyFilters(rows, NO_FILTERS)).toEqual(rows);
  expect(applyFilters(rows, { ...NO_FILTERS, origin: "custom" })).toEqual([own]);
  expect(applyFilters(rows, { ...NO_FILTERS, capability: "text_detect" })).toEqual([own]);
  expect(applyFilters(rows, { ...NO_FILTERS, kind: "http" })).toEqual([own]);
  expect(applyFilters(rows, { ...NO_FILTERS, state: "not_set_up" })).toEqual([pending]);
});

it("combines the dimensions: a card must answer every chosen value", () => {
  const rows = [
    connection("hub-ready"),
    connection("hub-pending", { setup_state: "not_set_up" }),
    connection("own-pending", { origin: "custom", setup_state: "not_set_up" }),
  ];
  const chosen = { ...NO_FILTERS, origin: "huggingface", state: "not_set_up" };
  expect(anyFilter(chosen)).toBe(true);
  expect(applyFilters(rows, chosen).map((row) => row.name)).toEqual(["hub-pending"]);
});

it("shows a connection declaring no ability under All and under no ability", () => {
  const bare = connection("bare", { capabilities: [] });
  expect(applyFilters([bare, hub], NO_FILTERS)).toEqual([bare, hub]);
  expect(applyFilters([bare, hub], { ...NO_FILTERS, capability: "point_suggest" })).toEqual([hub]);
  // And a bare connection raises no option: there is nothing to name.
  expect(optionsOf([bare], "capability")).toEqual([]);
});
