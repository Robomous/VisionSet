/**
 * The TypeScript half of the simplifier's parity gate.
 *
 * `tests/fixtures/simplification.json` is written by the kernel and kept current
 * by `tests/inference/test_simplification_fixture.py`. This proves the port
 * reproduces it — exactly, point for point, at every step — which is what lets
 * the editor re-simplify locally while the kernel stays authoritative on what is
 * written.
 *
 * **Exact equality, deliberately.** A tolerance on the comparison would let a
 * genuine divergence through: the two implementations either run the same
 * arithmetic in the same order or they will disagree about a vertex somewhere,
 * and "somewhere" is what a golden fixture exists to find. Both languages hold
 * IEEE-754 doubles and `Math.sqrt` is Python's `** 0.5`, so equality is
 * achievable rather than optimistic.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Point } from "../types";
import { DETAIL_STEPS, EPSILON, MINIMUM_TOLERANCE, polygonAt, simplified, steppedDetail, toleranceFor } from "./simplify";
import type { Detail } from "./simplify";

interface Case {
  readonly name: string;
  readonly contour: readonly (readonly number[])[];
  readonly tolerance: Readonly<Record<string, number>>;
  readonly polygon: Readonly<Record<string, readonly (readonly number[])[] | null>>;
}

interface Fixture {
  readonly minimum_tolerance: number;
  readonly epsilon: Readonly<Record<string, number>>;
  readonly cases: readonly Case[];
}

const FIXTURE_URL = new URL("../../../../../tests/fixtures/simplification.json", import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Fixture;

const points = (rows: readonly (readonly number[])[]): Point[] =>
  rows.map((row) => [row[0]!, row[1]!] as Point);

describe("the constants travel rather than being restated", () => {
  it("floors the tolerance where the kernel does", () => {
    expect(MINIMUM_TOLERANCE).toBe(fixture.minimum_tolerance);
  });

  it("means the same thing by each step", () => {
    expect({ ...EPSILON }).toEqual(fixture.epsilon);
  });

  it("names the steps the kernel names", () => {
    expect([...DETAIL_STEPS].sort()).toEqual(Object.keys(fixture.epsilon).sort());
  });
});

describe.each(fixture.cases)("$name", (found) => {
  it.each([...DETAIL_STEPS])("resolves the same tolerance at %s", (step) => {
    expect(toleranceFor(points(found.contour), step)).toBe(found.tolerance[step]);
  });

  it.each([...DETAIL_STEPS])("keeps exactly the same vertices at %s", (step) => {
    const expected = found.polygon[step];
    const actual = polygonAt(points(found.contour), step);
    if (expected === null || expected === undefined) {
      expect(actual).toBeNull();
      return;
    }
    expect(actual).toEqual(points(expected));
  });
});

describe("the gate would notice a port that ignored its input", () => {
  it("has a case whose vertex count differs at every step", () => {
    // Without one, a `polygonAt` that returned the contour unchanged — or that
    // used a fixed tolerance — would satisfy every straight-edged case, which
    // answers four corners at all three settings and is right to.
    const moving = fixture.cases.filter((found) => {
      const counts = [...DETAIL_STEPS]
        .map((step) => found.polygon[step])
        .filter((value): value is readonly (readonly number[])[] => Boolean(value))
        .map((value) => value.length);
      return new Set(counts).size === DETAIL_STEPS.length;
    });
    expect(moving.length).toBeGreaterThan(0);
  });

  it("has a case that cannot be a polygon at all", () => {
    const refused = fixture.cases.filter((found) =>
      [...DETAIL_STEPS].every((step) => found.polygon[step] === null),
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

describe("stepping through the vocabulary", () => {
  it("moves one step at a time", () => {
    expect(steppedDetail("balanced", 1)).toBe("fine");
    expect(steppedDetail("balanced", -1)).toBe("coarse");
  });

  it("stops at each end rather than wrapping", () => {
    // Held down, a wrapping control takes somebody from the coarsest straight to
    // the finest without their having asked for anything in between.
    expect(steppedDetail("coarse", -1)).toBe("coarse");
    expect(steppedDetail("fine", 1)).toBe("fine");
  });

  it("visits every step on the way across", () => {
    const walked: Detail[] = ["coarse"];
    while (walked[walked.length - 1] !== "fine") {
      walked.push(steppedDetail(walked[walked.length - 1]!, 1));
    }
    expect(walked).toEqual([...DETAIL_STEPS]);
  });
});
