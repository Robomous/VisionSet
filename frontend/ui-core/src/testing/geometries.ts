/**
 * What `GET /geometries` answers, for stubbed responses.
 *
 * Read off the kernel-written wire fixture rather than transcribed:
 * `tests/fixtures/wire_annotations.json`'s `implemented_geometry_types` is held
 * to `IMPLEMENTED_GEOMETRIES` by `tests/server/test_wire_fixtures.py`, so a
 * geometry implemented server-side reaches these stubs with no edit here.
 *
 * From the package root, which is where vitest runs: `import.meta.url` is an
 * `http://localhost/` URL under jsdom.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { components } from "../generated/api.js";
import type { GeometryType, OfferedGeometries } from "../screens/queries";

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../tests/fixtures/wire_annotations.json"), "utf8"),
) as { readonly implemented_geometry_types: readonly GeometryType[] };

/** The server's implemented set, in the server's order. */
export const IMPLEMENTED_GEOMETRIES: readonly GeometryType[] = fixture.implemented_geometry_types;

/** A `GET /geometries` body offering `geometries`. */
export function geometryPage(
  geometries: readonly GeometryType[] = IMPLEMENTED_GEOMETRIES,
): components["schemas"]["GeometryPage"] {
  return { items: geometries.map((name) => ({ name })), total: geometries.length };
}

/** A picker's `offered` prop once the set has been read. */
export function offeredGeometries(
  geometries: readonly GeometryType[] = IMPLEMENTED_GEOMETRIES,
): OfferedGeometries {
  return { state: "ready", geometries };
}
