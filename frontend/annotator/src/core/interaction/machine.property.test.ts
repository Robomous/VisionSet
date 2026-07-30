/**
 * A random walk through the machine, and the five things that must hold after
 * every single event of it.
 *
 * The scripted gestures next door assert what a *correct* sequence produces.
 * This one asserts what is true of *any* sequence, including the ones nobody
 * would write down: a pointer-up with no press, a commit in the middle of a
 * drag, a tool change between two moves, an escape while idle. Those are the
 * sequences a browser actually delivers when a gesture is interrupted.
 *
 * The generator lives here rather than in `_scene.ts` because only this file
 * needs it and because a reader chasing a failure wants to see what was
 * dispatched without opening a second file — the rule
 * `transforms.property.test.ts` states. The PRNG and the seed list are shared,
 * from `../_random`, so that two property tests failing on "seed 1337" are
 * talking about the same run of the same generator.
 *
 * ## The invariants, and which wrong implementation each one catches
 *
 * 1. **A cancel reverts.** After `cancel` the committed document is `toBe` — by
 *    reference — the one the run last saw while idle, the preview is gone, and
 *    `canUndo` has not moved. This is the claim v1 could not make: it wrote
 *    every pointer-move through to its annotations array, so its Escape had
 *    nothing to restore.
 * 2. **Idle stages nothing.** A path to idle that forgot to discard would leave
 *    a preview painting a drag nobody is performing.
 * 3. **The document moves only when the turn asked for it.** Every effect list
 *    with no log verb in it must leave the committed document and `canUndo`
 *    exactly where they were — which is the machine-side statement of "a drag
 *    writes nothing until release".
 * 4. **A pointer-move is a fixpoint.** Walking a path and jumping to its end
 *    land in the same place. An accumulator passes a single-move test and fails
 *    this one.
 * 5. **Nothing throws.** Whatever order the events arrive in.
 */

import { describe, expect, it } from "vitest";

import { mulberry32, SEEDS } from "../_random";
import type { AnnotationDocument } from "../state/document";
import type { Point } from "../types";
import {
  BOX_BODY,
  BOX_NW,
  EMPTY_POINT,
  POLY_BODY,
  POLY_VERTEX,
  World,
  down,
  held,
  move,
  up,
} from "./_scene";
import type { Effect } from "./effects";
import type { InteractionEvent, Modifiers, PointerButton } from "./events";
import { NO_MODIFIERS } from "./events";

/** Events per run. Long enough to walk into and out of every state repeatedly. */
const STEPS = 200;

/** The classes a run switches between: two drawing tools and select mode. */
const CLASSES: readonly (string | null)[] = [null, "sign", "lane"];

/** Points worth pressing: every interesting feature, plus somewhere random. */
const LANDMARKS: readonly Point[] = [BOX_BODY, BOX_NW, POLY_BODY, POLY_VERTEX, EMPTY_POINT];

const BUTTONS: readonly PointerButton[] = ["primary", "primary", "primary", "secondary", "auxiliary"];

function pick<T>(random: () => number, from: readonly T[]): T {
  return from[Math.min(from.length - 1, Math.floor(random() * from.length))];
}

function somewhere(random: () => number): Point {
  if (random() < 0.6) return pick(random, LANDMARKS);
  // Deliberately allowed outside the asset: clamping is the engine's job and a
  // pointer that leaves the image is the ordinary case, not an edge case.
  return [Math.round(random() * 760 - 60), Math.round(random() * 560 - 40)];
}

function modifiers(random: () => number): Modifiers {
  const roll = random();
  if (roll < 0.7) return NO_MODIFIERS;
  if (roll < 0.85) return held("shift");
  return held("ctrl");
}

function anEvent(random: () => number): InteractionEvent {
  const roll = random();
  if (roll < 0.22) return down(somewhere(random), pick(random, BUTTONS), modifiers(random));
  if (roll < 0.58) return move(somewhere(random));
  if (roll < 0.78) return up(somewhere(random), pick(random, BUTTONS), modifiers(random));
  if (roll < 0.84) return { type: "cancel" };
  if (roll < 0.89) return { type: "pointer-cancel" };
  if (roll < 0.94) return { type: "commit" };
  if (roll < 0.97) return { type: "tool-changed" };
  return { type: "double-click", point: somewhere(random), modifiers: NO_MODIFIERS };
}

/** Does this turn's effect list ask for anything the history would record? */
function logs(effects: readonly Effect[]): boolean {
  return effects.some(
    (effect) =>
      effect.kind === "commit" ||
      effect.kind === "add" ||
      effect.kind === "replace" ||
      effect.kind === "remove",
  );
}

describe("what is true after every single event", () => {
  for (const seed of SEEDS) {
    it(`holds through a random run (seed ${seed})`, () => {
      const random = mulberry32(seed);
      const world = new World();
      let quiet: AnnotationDocument = world.store.document;
      const seen = new Map<string, number>();
      let cancels = 0;

      for (let step = 0; step < STEPS; step += 1) {
        const where = `seed ${seed} step ${step}`;

        if (random() < 0.18) {
          const next = pick(random, CLASSES);
          if (next !== world.activeClass) {
            world.activeClass = next;
            world.dispatch({ type: "tool-changed" });
          }
        }

        if (world.state.type === "idle") quiet = world.store.document;
        const committed = world.store.document;
        const couldUndo = world.store.canUndo;

        const event = anEvent(random);
        seen.set(world.state.type, (seen.get(world.state.type) ?? 0) + 1);

        // 5. Nothing throws, whatever order the events arrive in.
        const answer = world.dispatch(event);

        // 3. The document moves only when the turn asked for it.
        if (!logs(answer.effects)) {
          expect(world.store.document, where).toBe(committed);
          expect(world.store.canUndo, where).toBe(couldUndo);
        }

        // 1. A cancel reverts — to the object, not to something equal to it.
        if (event.type === "cancel") {
          cancels += 1;
          expect(world.state.type, where).toBe("idle");
          expect(world.store.document, where).toBe(quiet);
          expect(world.store.preview, where).toBeNull();
        }

        // 2. Idle stages nothing.
        if (world.state.type === "idle") {
          expect(world.store.preview, where).toBeNull();
          expect(world.store.rendered, where).toBe(world.store.document);
        }
      }

      // The sweep is only worth its runtime if it covered the states it claims
      // to. A generator that quietly stopped reaching the drags would leave
      // every invariant about them unasserted.
      const where = `seed ${seed}`;
      expect(seen.get("idle") ?? 0, where).toBeGreaterThan(10);
      expect(seen.get("drawing-bbox") ?? 0, where).toBeGreaterThan(0);
      expect(seen.get("drawing-polygon") ?? 0, where).toBeGreaterThan(0);
      expect(seen.get("moving") ?? 0, where).toBeGreaterThan(0);
      expect(seen.get("pressing-empty") ?? 0, where).toBeGreaterThan(0);
      expect(cancels, where).toBeGreaterThan(0);
    });
  }
});

describe("a pointer-move is a fixpoint", () => {
  for (const seed of SEEDS) {
    it(`lands in the same place whether the path was walked or jumped (seed ${seed})`, () => {
      const random = mulberry32(seed);

      for (let round = 0; round < 20; round += 1) {
        const where = `seed ${seed} round ${round}`;
        const walked = new World();
        const jumped = new World();
        // Drawn once, outside the loop. Drawing it per world would hand the two
        // different gestures and compare a move against a resize — which is how
        // this test failed the first time it ran.
        const press = random() < 0.5 ? down(BOX_BODY) : down(BOX_NW);
        for (const world of [walked, jumped]) {
          world.send(down(BOX_BODY), up(BOX_BODY));
          world.dispatch(press);
        }

        const path: Point[] = [];
        for (let step = 0; step < 8; step += 1) path.push(somewhere(random));
        const destination = path[path.length - 1];

        for (const at of path) walked.dispatch(move(at));
        jumped.dispatch(move(destination));

        expect(walked.state.type, where).toBe(jumped.state.type);
        expect(
          walked.store.rendered.annotations.get("box")?.geometry,
          where,
        ).toEqual(jumped.store.rendered.annotations.get("box")?.geometry);
      }
    });
  }
});
