/**
 * The TypeScript half of the mask-to-geometry parity gate.
 *
 * `tests/fixtures/mask_geometry.json` is written by `visionset.inference.masks`
 * and kept current by `tests/inference/test_mask_geometry_fixture.py`. This
 * proves the port reproduces it — every stage, exactly — which is what lets a
 * host run a model in the browser and get the shapes the server would have
 * given.
 *
 * **Exact equality, deliberately.** A tolerance on the comparison would let a
 * genuine divergence through: the two implementations either run the same
 * arithmetic in the same order or they will disagree about a vertex somewhere,
 * and "somewhere" is what a golden fixture exists to find.
 *
 * The stages are asserted separately from the shapes so a failure says *which*
 * step diverged rather than only that the answers differ.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_TOLERANCE, MINIMUM_TOLERANCE } from "../geometry/simplify";
import type { Point } from "../types";
import { CLOSING_REACH, MAXIMUM_CLOSING_RADIUS, closingRadius, filled } from "./closing";
import { MINIMUM_FRAGMENT_SHARE, components } from "./components";
import { contour, outline } from "./outline";
import { maskOf, runs, type Run } from "./runs";
import { shapesFromMask } from "./shapes";
import type { BinaryMask } from "./binaryMask";
import type { GeometryType } from "../types";

interface Grid {
  readonly width: number;
  readonly height: number;
  readonly runs: readonly (readonly number[])[];
}

interface Cropped extends Grid {
  readonly x: number;
  readonly y: number;
}

interface Shaped {
  readonly geometry: Record<string, unknown>;
  readonly contour: readonly (readonly number[])[];
}

interface Case {
  readonly name: string;
  readonly mask: Grid;
  readonly at: readonly (readonly number[])[];
  readonly components: readonly Cropped[];
  readonly closing_radius: number | null;
  readonly filled: Grid | null;
  readonly outline: readonly (readonly number[])[] | null;
  readonly contour: readonly (readonly number[])[] | null;
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

const plain = (runsOf: readonly Run[]): number[][] => runsOf.map((run) => [run[0], run[1], run[2]]);

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

  it("reconstructs the same pixels the fixture describes", () => {
    expect(plain(runs(mask))).toEqual(found.mask.runs);
  });

  it("survives the noise filter with the same pieces, in the same order", () => {
    const pieces = components(mask, at);
    expect(
      pieces.map((piece) => ({
        x: piece.x,
        y: piece.y,
        width: piece.mask.width,
        height: piece.mask.height,
        runs: plain(runs(piece.mask)),
      })),
    ).toEqual(
      found.components.map((piece) => ({
        x: piece.x,
        y: piece.y,
        width: piece.width,
        height: piece.height,
        runs: piece.runs.map((run) => [...run]),
      })),
    );
  });

  it("reaches the same distance into the head piece", () => {
    const pieces = components(mask, at);
    expect(pieces.length === 0 ? null : closingRadius(pieces[0]!.mask)).toBe(found.closing_radius);
  });

  it("closes the head piece into the same pixels", () => {
    const pieces = components(mask, at);
    if (found.filled === null) {
      expect(pieces).toHaveLength(0);
      return;
    }
    const whole = filled(pieces[0]!.mask);
    expect(whole.width).toBe(found.filled.width);
    expect(whole.height).toBe(found.filled.height);
    expect(plain(runs(whole))).toEqual(found.filled.runs.map((run) => [...run]));
  });

  it("traces the same boundary, corner for corner", () => {
    const pieces = components(mask, at);
    if (found.outline === null) {
      expect(pieces).toHaveLength(0);
      return;
    }
    expect(outline(filled(pieces[0]!.mask))).toEqual(points(found.outline));
  });

  it("reduces to the same canonical contour, point for point", () => {
    const pieces = components(mask, at);
    if (found.contour === null) {
      expect(pieces).toHaveLength(0);
      return;
    }
    expect(contour(filled(pieces[0]!.mask))).toEqual(points(found.contour));
  });

  describe.each(Object.keys(found.shapes))("allowed=%s", (key) => {
    const allowed = key.split(",") as GeometryType[];
    it.each([...fixture.tolerances])("proposes the same shapes at %s px", (tolerance) => {
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

describe("the gate would notice a port that ignored its input", () => {
  it("has a case with more than one surviving component", () => {
    expect(fixture.cases.some((found) => found.components.length > 1)).toBe(true);
  });

  it("has a case whose click is at a half pixel", () => {
    expect(
      fixture.cases.some((found) =>
        found.at.some((point) => point.some((value) => !Number.isInteger(value))),
      ),
    ).toBe(true);
  });

  it("has a case the closing changes and a case it leaves alone", () => {
    const withReach = fixture.cases.filter((found) => (found.closing_radius ?? 0) > 0);
    expect(withReach.length).toBeGreaterThan(1);
  });
});
