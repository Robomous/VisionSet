/**
 * A seeded generator of random command runs — the harness behind #39's property
 * test, and nothing a consumer ever sees.
 *
 * The `_` prefix marks a harness, the convention `tests/server/_flow.py` set on
 * the Python side and `_fixture.ts` already follows here: `tsconfig.build.json`
 * excludes `src/**\/_*.ts`, so this is out of the shipped engine and out of the
 * headless boundary's type gate, which inherits that exclusion.
 *
 * ## Why a hand-written PRNG rather than a property-testing library
 *
 * `fast-check` would bring shrinking, which is the real thing a library buys.
 * It would also be the annotator's first test dependency, and the package ships
 * zero. Sixteen lines of `mulberry32` swept over a fixed list of seeds gets the
 * coverage; what it does not get is a *minimal* counterexample, so a failure
 * arrives at full length with its seed in the test name and is replayed by
 * running that one test. The trade is recorded here rather than left implicit.
 *
 * `Math.random` is not usable for this even ignoring the seed: a test that fails
 * on one run in fifty and passes on re-run is worse than no test, which is the
 * same standard `tests/kernel/test_concurrency.py` holds itself to.
 */

import {
  addAnnotationCommand,
  composeCommands,
  removeAnnotationsCommand,
  replaceAnnotationCommand,
} from "./commands";
import { annotationsInDrawOrder } from "./document";
import type { AnnotationDocument } from "./document";
import type { Command } from "./commandLog";
import type { Annotation } from "../types";

/**
 * The mulberry32 PRNG: one 32-bit state word, uniform in `[0, 1)`.
 *
 * Small, well-distributed enough for choosing among four branches, and — the
 * point — identical on every machine and every run for a given seed.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a run needs to invent an annotation the document will accept. */
export interface RandomWorld {
  readonly random: () => number;
  /** A fresh id. A counter in the tests, so a failure is readable. */
  readonly mint: () => string;
  /** A class the schema declares, for the annotations the run adds. */
  readonly labelClass: string;
}

function pick<T>(world: RandomWorld, values: readonly T[]): T {
  return values[Math.floor(world.random() * values.length)];
}

function integer(world: RandomWorld, bound: number): number {
  return Math.floor(world.random() * bound);
}

/** An annotation with a fresh id and an arbitrary box, on this document's asset. */
export function randomAnnotation(
  world: RandomWorld,
  document: AnnotationDocument,
): Annotation {
  return {
    id: world.mint(),
    asset_id: document.asset.id,
    label_class: world.labelClass,
    schema_version: document.schema.version,
    geometry: {
      type: "bbox",
      x: integer(world, document.asset.width),
      y: integer(world, document.asset.height),
      width: 1 + integer(world, 32),
      height: 1 + integer(world, 32),
    },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
  };
}

/**
 * One command the given document will accept.
 *
 * It never generates a command that the document would refuse — a run that
 * blew up on a duplicate id would be testing the generator, not the log. The
 * document's refusals have their own tests in `document.test.ts`.
 *
 * A group's members are generated against the *intermediate* documents, because
 * `composeCommands` threads the document through them and a member built against
 * the wrong state is the one way a group can throw.
 */
export function randomCommand(
  world: RandomWorld,
  document: AnnotationDocument,
  depth = 0,
): Command {
  const present = annotationsInDrawOrder(document);
  // Groups stop nesting at depth 2 — not for correctness, but so a failing run
  // is something a person can read.
  const branches = depth < 2 ? 4 : 3;
  const branch = present.length === 0 ? 0 : integer(world, branches);

  if (branch === 0) {
    return addAnnotationCommand(randomAnnotation(world, document));
  }
  if (branch === 1) {
    const target = pick(world, present);
    return replaceAnnotationCommand({
      ...randomAnnotation(world, document),
      id: target.id,
    });
  }
  if (branch === 2) {
    // Possibly empty, which is the no-op the log declines to record.
    const doomed = present
      .filter(() => world.random() < 0.5)
      .map((annotation) => annotation.id);
    return removeAnnotationsCommand(doomed);
  }

  // A group of two, each generated against what the previous one leaves behind.
  const first = randomCommand(world, document, depth + 1);
  const second = randomCommand(world, first.apply(document), depth + 1);
  return composeCommands("group of 2", [first, second]);
}
