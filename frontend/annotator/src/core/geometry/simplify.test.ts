/**
 * The TypeScript half of the simplifier's parity gate.
 *
 * `tests/fixtures/simplification.json` is written by the kernel and kept current
 * by `tests/inference/test_simplification_fixture.py`. This proves the port
 * reproduces it — exactly, point for point, at every tolerance — which is what
 * lets the editor re-simplify locally while the kernel stays authoritative on
 * what is written.
 *
 * **Exact equality, deliberately.** A tolerance on the comparison would let a
 * genuine divergence through: the two implementations either run the same
 * arithmetic in the same order or they will disagree about a vertex somewhere,
 * and "somewhere" is what a golden fixture exists to find.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Point } from "../types";
import {
  DEFAULT_TOLERANCE,
  MAXIMUM_TOLERANCE,
  MINIMUM_TOLERANCE,
  polygonAt,
  simplified,
  steppedTolerance,
} from "./simplify";

interface Case {
  readonly name: string;
  readonly contour: readonly (readonly number[])[];
  readonly polygon: Readonly<Record<string, readonly (readonly number[])[] | null>>;
}

interface Fixture {
  readonly minimum_tolerance: number;
  readonly default_tolerance: number;
  readonly maximum_tolerance: number;
  readonly tolerances: readonly number[];
  readonly cases: readonly Case[];
}

const FIXTURE_URL = new URL("../../../../../tests/fixtures/simplification.json", import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Fixture;

const points = (rows: readonly (readonly number[])[]): Point[] =>
  rows.map((row) => [row[0]!, row[1]!] as Point);

/** The fixture keys a polygon by Python's spelling of the float: `1.0`, not `1`. */
const keyed = (tolerance: number): string =>
  Number.isInteger(tolerance) ? `${tolerance}.0` : String(tolerance);

describe("the constants travel rather than being restated", () => {
  it("floors, defaults and caps the tolerance where the kernel does", () => {
    expect(MINIMUM_TOLERANCE).toBe(fixture.minimum_tolerance);
    expect(DEFAULT_TOLERANCE).toBe(fixture.default_tolerance);
    expect(MAXIMUM_TOLERANCE).toBe(fixture.maximum_tolerance);
  });
});

describe.each(fixture.cases)("$name", (found) => {
  it.each([...fixture.tolerances])("keeps exactly the same vertices at %s px", (tolerance) => {
    const expected = found.polygon[keyed(tolerance)];
    expect(expected).toBeDefined();
    const actual = polygonAt(points(found.contour), tolerance);
    if (expected === null) {
      expect(actual).toBeNull();
      return;
    }
    expect(actual).toEqual(points(expected!));
  });
});

describe("the gate would notice a port that ignored its input", () => {
  it("has a case whose vertex count moves with the tolerance", () => {
    const moving = fixture.cases.filter((found) => {
      const counts = Object.values(found.polygon)
        .filter((value): value is readonly (readonly number[])[] => Boolean(value))
        .map((value) => value.length);
      return new Set(counts).size >= 4;
    });
    expect(moving.length).toBeGreaterThan(0);
  });

  it("has a case that cannot be a polygon at all", () => {
    const refused = fixture.cases.filter((found) =>
      Object.values(found.polygon).every((value) => value === null),
    );
    expect(refused.length).toBeGreaterThan(0);
  });
});

describe("simplification on its own", () => {
  it("keeps the corners and drops the straight runs", () => {
    const line: Point[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 1],
    ];
    expect(simplified(line, 0.5)).toEqual([
      [0, 0],
      [3, 0],
      [3, 1],
    ]);
  });

  it("hands back anything shorter than a segment unchanged", () => {
    const pair: Point[] = [
      [0, 0],
      [1, 1],
    ];
    expect(simplified(pair, 0.5)).toEqual(pair);
    expect(simplified(pair, 0.5)).not.toBe(pair);
  });
});

describe("stepping the tolerance", () => {
  it("doubles for coarser and halves for finer", () => {
    expect(steppedTolerance(1, -1)).toBe(2);
    expect(steppedTolerance(1, 1)).toBe(0.5);
  });

  it("stops at each end rather than wrapping", () => {
    expect(steppedTolerance(MAXIMUM_TOLERANCE, -1)).toBe(MAXIMUM_TOLERANCE);
    expect(steppedTolerance(MINIMUM_TOLERANCE, 1)).toBe(MINIMUM_TOLERANCE);
  });

  it("walks the fixture's ladder from the floor to the ceiling", () => {
    const walked: number[] = [MINIMUM_TOLERANCE];
    while (walked[walked.length - 1]! < MAXIMUM_TOLERANCE) {
      walked.push(steppedTolerance(walked[walked.length - 1]!, -1));
    }
    expect(walked).toEqual([...fixture.tolerances]);
  });

  it("lands on the ceiling from a value that is not on the ladder", () => {
    expect(steppedTolerance(12, -1)).toBe(MAXIMUM_TOLERANCE);
    expect(steppedTolerance(0.3, 1)).toBe(MINIMUM_TOLERANCE);
  });

  it("snaps a value between stops to the nearest one before stepping", () => {
    expect(steppedTolerance(1.19, -1)).toBe(2);
    expect(steppedTolerance(1.19, 1)).toBe(0.5);
  });
});
