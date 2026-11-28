/** The TypeScript pipeline must reproduce Python's geometry and contour exactly. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_TOLERANCE, MINIMUM_TOLERANCE } from "../geometry/simplify";
import type { Point } from "../types";
import { CLOSING_REACH, MAXIMUM_CLOSING_RADIUS } from "./closing";
import { MINIMUM_FRAGMENT_SHARE } from "./components";
import { maskOf, type Run } from "./runs";
import { shapesFromMask } from "./shapes";
import type { BinaryMask } from "./binaryMask";
import type { GeometryType } from "../types";

interface Grid {
  readonly width: number;
  readonly height: number;
  readonly runs: readonly (readonly number[])[];
}

interface Shaped {
  readonly geometry: Record<string, unknown>;
  readonly contour: readonly (readonly number[])[];
}

interface Case {
  readonly name: string;
  readonly mask: Grid;
  readonly at: readonly (readonly number[])[];
  readonly shapes: Readonly<Record<string, Readonly<Record<string, readonly Shaped[]>>>>;
}

interface Fixture {
  readonly minimum_fragment_share: number;
  readonly closing_reach: number;
  readonly maximum_closing_radius: number;
  readonly minimum_tolerance: number;
  readonly default_tolerance: number;
  readonly tolerances: readonly number[];
  readonly cases: readonly Case[];
}

const FIXTURE_URL = new URL("../../../../../tests/fixtures/mask_geometry.json", import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Fixture;

/** The fixture keys a tolerance by Python's spelling of the float: `1.0`, not `1`. */
const keyed = (tolerance: number): string =>
  Number.isInteger(tolerance) ? `${tolerance}.0` : String(tolerance);

const rebuilt = (grid: Grid): BinaryMask =>
  maskOf(grid.width, grid.height, grid.runs.map((run) => [run[0]!, run[1]!, run[2]!] as Run));

const points = (rows: readonly (readonly number[])[]): Point[] =>
  rows.map((row) => [row[0]!, row[1]!] as Point);

describe("the constants travel rather than being restated", () => {
  it("holds the noise floor, the reach, the cap and the tolerances where the kernel does", () => {
    expect(MINIMUM_FRAGMENT_SHARE).toBe(fixture.minimum_fragment_share);
    expect(CLOSING_REACH).toBe(fixture.closing_reach);
    expect(MAXIMUM_CLOSING_RADIUS).toBe(fixture.maximum_closing_radius);
    expect(MINIMUM_TOLERANCE).toBe(fixture.minimum_tolerance);
    expect(DEFAULT_TOLERANCE).toBe(fixture.default_tolerance);
  });
});

describe.each(fixture.cases)("$name", (found) => {
  const mask = rebuilt(found.mask);
  const at = points(found.at);

  // shapes.test.ts checks caller order and box invariance across tolerances.
  const policies = Object.keys(found.shapes).filter((key) => key !== "polygon,bbox");
  describe.each(policies)("allowed=%s", (key) => {
    const allowed = key.split(",") as GeometryType[];
    const tolerances = allowed.includes("polygon") ? fixture.tolerances : [fixture.default_tolerance];
    it.each([...tolerances])("proposes the same shapes at %s px", (tolerance) => {
      const expected = found.shapes[key]![keyed(tolerance)];
      expect(expected).toBeDefined();
      const actual = shapesFromMask(mask, { allowed, tolerance, at });
      expect(actual).toEqual(
        expected!.map((shape) => ({
          geometry:
            shape.geometry["type"] === "polygon"
              ? { type: "polygon", points: points(shape.geometry["points"] as number[][]) }
              : shape.geometry,
          contour: points(shape.contour),
        })),
      );
    });
  });
});
