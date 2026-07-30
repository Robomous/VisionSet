/**
 * Acceptance criterion 2 of #41: a transform never escapes the asset bounds.
 *
 * Each seed drives two hundred rounds — a frame, a shape that fits inside it, a
 * target point that is outside it about half the time, and one of the six
 * transforms — and every round asserts the same seven invariants. The seed is in
 * the test name, so a failure is replayed by running that one case.
 *
 * The generators are here rather than in a `_`-harness because only this file
 * needs them and because a reader chasing a failure wants to see what was drawn
 * without opening a second file. The PRNG and the seed list are shared, from
 * `../_random`.
 *
 * ## Why the target point is drawn from outside the frame
 *
 * A sweep over in-bounds inputs would pass against an implementation with no
 * clamping at all. Drawing from `[-w, 2w] × [-h, 2h]` is the whole point: roughly
 * half of these rounds are a pointer dragged off the edge of the image, which is
 * the only situation in which the criterion can fail. It is what catches v1's
 * `left = right - 3` escape (I1) and an accumulating transform (I4).
 *
 * ## Why the generated shape always fits the frame
 *
 * An annotation larger than its own asset is loadable — nothing in `parseGeometry`
 * refuses it — but it is not a state a transform can repair, and `moveBbox`
 * deliberately pins it rather than deforming it. Sweeping it would make I1 assert
 * something false about correct behaviour. The pinning is covered by its own
 * deterministic tests in `bbox.test.ts` and `polygon.test.ts`.
 *
 * ## The one transform that is not a fixpoint
 *
 * `resizeBbox` is idempotent unless the drag flipped past its anchor, because a
 * flip re-anchors the box and the same grip then means the other side. That is
 * v1's behaviour, kept, and it costs nothing in practice — #39's store re-projects
 * from the committed document, so a tool always passes the box the gesture began
 * on. I4 therefore excludes flips, and `bbox.test.ts` pins the flip case by hand.
 */

import { describe, expect, it } from "vitest";

import { SEEDS, mulberry32 } from "../_random";
import type { BboxGeometry, PolygonGeometry, Point } from "../types";
import {
  BBOX_HANDLES,
  MIN_BBOX_SIZE,
  moveBbox,
  resizeBbox,
  type BboxHandle,
} from "./bbox";
import {
  MIN_POLYGON_POINTS,
  insertPolygonVertex,
  movePolygonVertex,
  polygonBbox,
  removePolygonVertex,
  translatePolygon,
} from "./polygon";
import type { Bounds } from "./primitives";

const ROUNDS = 200;

/**
 * How far the *minimum size* may fall short, in asset pixels.
 *
 * Bounds get no slack at all: `expectBoxInFrame` compares against a literal `0` and
 * a literal `bounds.width`, because "never escapes the asset" is the criterion and a
 * negative coordinate is a negative coordinate however small. The minimum size does
 * get slack, because placing an interval inside a frame moves its length by an ulp
 * and a nanometre-scale shortfall on a three-pixel floor is not a defect. That
 * asymmetry is deliberate, and it is what `slideIntoBounds` is shaped around.
 */
const FLOAT_SLACK = 1e-9;

/**
 * Frames where the two rules collide — an asset narrower than `MIN_BBOX_SIZE`, so
 * a resize cannot honour both the minimum and the bounds. One in five rounds draws
 * from here, because a uniform generator would essentially never produce one.
 */
const PATHOLOGICAL: readonly Bounds[] = [
  { width: 1, height: 1 },
  { width: 2, height: 2 },
  { width: 2, height: 400 },
  { width: 400, height: 2 },
  { width: 3, height: 3 },
];

type Random = () => number;

function between(random: Random, low: number, high: number): number {
  return low + random() * (high - low);
}

function randomBounds(random: Random): Bounds {
  if (random() < 0.2) {
    return PATHOLOGICAL[Math.floor(random() * PATHOLOGICAL.length)];
  }
  return { width: between(random, 1, 1024), height: between(random, 1, 1024) };
}

/** A box that fits inside the frame — see the docstring on why it must. */
function randomBbox(random: Random, bounds: Bounds): BboxGeometry {
  const width = random() * bounds.width;
  const height = random() * bounds.height;
  return {
    type: "bbox",
    x: between(random, 0, bounds.width - width),
    y: between(random, 0, bounds.height - height),
    width,
    height,
  };
}

/** A polygon of three to eight vertices, all inside the frame. */
function randomPolygon(random: Random, bounds: Bounds): PolygonGeometry {
  const count = MIN_POLYGON_POINTS + Math.floor(random() * 6);
  const points: Point[] = [];
  for (let at = 0; at < count; at += 1) {
    points.push([random() * bounds.width, random() * bounds.height]);
  }
  return { type: "polygon", points };
}

/** A destination that lands outside the frame about half the time. */
function randomTarget(random: Random, bounds: Bounds): Point {
  return [
    between(random, -bounds.width, 2 * bounds.width),
    between(random, -bounds.height, 2 * bounds.height),
  ];
}

function randomHandle(random: Random): BboxHandle {
  return BBOX_HANDLES[Math.floor(random() * BBOX_HANDLES.length)];
}

/** I1 for a box. */
function expectBoxInFrame(box: BboxGeometry, bounds: Bounds, where: string): void {
  expect(box.width, where).toBeGreaterThanOrEqual(0);
  expect(box.height, where).toBeGreaterThanOrEqual(0);
  expect(box.x, where).toBeGreaterThanOrEqual(0);
  expect(box.y, where).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, where).toBeLessThanOrEqual(bounds.width);
  expect(box.y + box.height, where).toBeLessThanOrEqual(bounds.height);
}

/** I1 for a polygon. */
function expectPolygonInFrame(
  shape: PolygonGeometry,
  bounds: Bounds,
  where: string,
): void {
  for (const [x, y] of shape.points) {
    expect(x, where).toBeGreaterThanOrEqual(0);
    expect(x, where).toBeLessThanOrEqual(bounds.width);
    expect(y, where).toBeGreaterThanOrEqual(0);
    expect(y, where).toBeLessThanOrEqual(bounds.height);
  }
}

/** Every vertex's offset from the first — what a rigid move must preserve (I3). */
function shapeOf(value: PolygonGeometry): readonly Point[] {
  const [ox, oy] = value.points[0];
  return value.points.map(([x, y]): Point => [x - ox, y - oy]);
}

/** Two boxes equal to within floating-point noise. See `expectPointsClose`. */
function expectBoxClose(
  actual: BboxGeometry,
  expected: BboxGeometry,
  where: string,
): void {
  expect(actual.x, `${where} x`).toBeCloseTo(expected.x, 9);
  expect(actual.y, `${where} y`).toBeCloseTo(expected.y, 9);
  expect(actual.width, `${where} width`).toBeCloseTo(expected.width, 9);
  expect(actual.height, `${where} height`).toBeCloseTo(expected.height, 9);
}

/**
 * Two point lists equal to within floating-point noise.
 *
 * `toEqual` is too strong for a translation: `(x + dx) - (x0 + dx)` differs from
 * `x - x0` by an ulp, so a rigid move preserves the offsets to about 1e-14 and not
 * bit-exactly. Nine decimal places is still a far stronger claim than the geometry
 * needs — a sub-nanometre drift on a pixel grid — while asserting something that is
 * actually true of doubles.
 */
function expectPointsClose(
  actual: readonly Point[],
  expected: readonly Point[],
  where: string,
): void {
  expect(actual.length, where).toBe(expected.length);
  for (let at = 0; at < expected.length; at += 1) {
    expect(actual[at][0], `${where} point ${at} x`).toBeCloseTo(expected[at][0], 9);
    expect(actual[at][1], `${where} point ${at} y`).toBeCloseTo(expected[at][1], 9);
  }
}

/** Did this resize drag the grip past the edge it anchors on? */
function flips(start: BboxGeometry, handle: BboxHandle, point: Point): boolean {
  const left = Math.min(start.x, start.x + start.width);
  const right = Math.max(start.x, start.x + start.width);
  const top = Math.min(start.y, start.y + start.height);
  const bottom = Math.max(start.y, start.y + start.height);
  const horizontal =
    (handle.includes("w") && point[0] > right) ||
    (handle.includes("e") && point[0] < left);
  const vertical =
    (handle.startsWith("n") && point[1] > bottom) ||
    (handle.startsWith("s") && point[1] < top);
  return horizontal || vertical;
}

describe("a transform never escapes the asset", () => {
  for (const seed of SEEDS) {
    it(`keeps every coordinate inside the frame (seed ${seed})`, () => {
      const random = mulberry32(seed);
      let boxes = 0;
      let polygons = 0;
      let outside = 0;
      let pathological = 0;

      for (let round = 0; round < ROUNDS; round += 1) {
        const bounds = randomBounds(random);
        if (PATHOLOGICAL.includes(bounds)) pathological += 1;
        const target = randomTarget(random, bounds);
        if (
          target[0] < 0 ||
          target[1] < 0 ||
          target[0] > bounds.width ||
          target[1] > bounds.height
        ) {
          outside += 1;
        }
        const where = `seed ${seed} round ${round}`;

        if (random() < 0.4) {
          boxes += 1;
          const start = randomBbox(random, bounds);
          const before = JSON.stringify(start);

          if (random() < 0.5) {
            const moved = moveBbox(start, target, bounds);
            expectBoxInFrame(moved, bounds, `moveBbox ${where}`);
            // I3 — a move never resizes.
            expect(moved.width, where).toBe(Math.abs(start.width));
            expect(moved.height, where).toBe(Math.abs(start.height));
            // I4 and I7.
            expect(moveBbox(moved, target, bounds), where).toEqual(moved);
            expect(moveBbox(start, target, bounds), where).toEqual(moved);
          } else {
            const handle = randomHandle(random);
            const sized = resizeBbox(start, handle, target, bounds);
            expectBoxInFrame(sized, bounds, `resizeBbox ${handle} ${where}`);
            // I2 — the minimum, unless the frame is smaller than it.
            expect(sized.width, `${handle} ${where}`).toBeGreaterThanOrEqual(
              Math.min(MIN_BBOX_SIZE, bounds.width) - FLOAT_SLACK,
            );
            expect(sized.height, `${handle} ${where}`).toBeGreaterThanOrEqual(
              Math.min(MIN_BBOX_SIZE, bounds.height) - FLOAT_SLACK,
            );
            // I7 — the same call twice is the same answer, bit for bit.
            expect(resizeBbox(start, handle, target, bounds), where).toEqual(sized);
            // I4 — re-projecting is a fixpoint, except across a flip, which
            // re-anchors the box and so renames the grip. Close rather than equal:
            // placing an interval inside a frame moves its length by an ulp, and the
            // second pass re-derives the min-size push from that.
            if (!flips(start, handle, target)) {
              expectBoxClose(
                resizeBbox(sized, handle, target, bounds),
                sized,
                `fixpoint ${handle} ${where}`,
              );
            }
          }
          // I6 — nothing was mutated in place.
          expect(JSON.stringify(start), where).toBe(before);
          continue;
        }

        polygons += 1;
        const start = randomPolygon(random, bounds);
        const before = JSON.stringify(start);
        const roll = random();

        if (roll < 0.3) {
          const moved = translatePolygon(start, target, bounds);
          expectPolygonInFrame(moved, bounds, `translatePolygon ${where}`);
          // I3 — rigid: every pairwise offset survives. I5 — same arity.
          expectPointsClose(shapeOf(moved), shapeOf(start), `rigid ${where}`);
          expect(moved.points.length, where).toBe(start.points.length);
          // I4 — re-projecting the same drag lands in the same place — and I7.
          expectPointsClose(
            translatePolygon(moved, target, bounds).points,
            moved.points,
            `fixpoint ${where}`,
          );
          expect(translatePolygon(start, target, bounds), where).toEqual(moved);
        } else if (roll < 0.6) {
          const index = Math.floor(random() * start.points.length);
          const moved = movePolygonVertex(start, index, target, bounds);
          expectPolygonInFrame(moved, bounds, `movePolygonVertex ${where}`);
          expect(moved.points.length, where).toBe(start.points.length);
          // Only the one vertex moved.
          for (let at = 0; at < start.points.length; at += 1) {
            if (at !== index) expect(moved.points[at], where).toEqual(start.points[at]);
          }
          expect(movePolygonVertex(moved, index, target, bounds), where).toEqual(moved);
        } else if (roll < 0.85) {
          const index = Math.floor(random() * start.points.length);
          const grown = insertPolygonVertex(start, index, target);
          // No bounds parameter, and it needs none: the new vertex is a convex
          // combination of two that were already inside.
          expectPolygonInFrame(grown, bounds, `insertPolygonVertex ${where}`);
          // I5 — exactly one added, the originals still in order.
          expect(grown.points.length, where).toBe(start.points.length + 1);
          expect(
            grown.points.filter((_, at) => at !== index + 1),
            where,
          ).toEqual(start.points);
          expect(insertPolygonVertex(start, index, target), where).toEqual(grown);
        } else {
          const index = Math.floor(random() * start.points.length);
          const shrunk = removePolygonVertex(start, index);
          if (start.points.length <= MIN_POLYGON_POINTS) {
            expect(shrunk, where).toBeNull();
          } else {
            expect(shrunk, where).not.toBeNull();
            const answer = shrunk as PolygonGeometry;
            expectPolygonInFrame(answer, bounds, `removePolygonVertex ${where}`);
            // I5 — exactly one gone, the rest untouched and in order.
            expect(answer.points.length, where).toBe(start.points.length - 1);
            expect(answer.points, where).toEqual(
              start.points.filter((_, at) => at !== index),
            );
          }
          expect(removePolygonVertex(start, index), where).toEqual(shrunk);
        }

        expect(JSON.stringify(start), where).toBe(before);
      }

      // The sweep is only worth its runtime if it actually covered the shapes and
      // the frames it claims to. A generator that quietly stopped producing
      // polygons would otherwise leave every polygon invariant unasserted.
      expect(boxes).toBeGreaterThan(20);
      expect(polygons).toBeGreaterThan(20);
      expect(outside).toBeGreaterThan(ROUNDS / 4);
      expect(pathological).toBeGreaterThan(5);
    });
  }

  it("leaves an annotation larger than its own asset pinned rather than deformed", () => {
    // Loadable — parseGeometry refuses neither — and deliberately outside the
    // sweep, because there is no in-frame answer a transform could give without
    // destroying the shape.
    const frame: Bounds = { width: 100, height: 100 };
    const wide: BboxGeometry = { type: "bbox", x: 0, y: 0, width: 400, height: 400 };
    expect(moveBbox(wide, [50, 50], frame)).toEqual(wide);

    const shape: PolygonGeometry = {
      type: "polygon",
      points: [
        [0, 0],
        [400, 0],
        [400, 400],
      ],
    };
    const moved = translatePolygon(shape, [50, 50], frame);
    expect(moved).toEqual(shape);
    expect(polygonBbox(moved)).toEqual(polygonBbox(shape));
  });
});
