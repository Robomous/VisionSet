/**
 * A seeded generator of random command runs — the harness behind #39's property
 * test, and nothing a consumer ever sees.
 *
 * The `_` prefix marks a harness, the convention `tests/server/_flow.py` set on
 * the Python side and `_fixture.ts` already follows here: `tsconfig.build.json`
 * excludes `src/**\/_*.ts`, so this is out of the shipped engine and out of the
 * headless boundary's type gate, which inherits that exclusion.
 *
 * The PRNG itself and the seed list live in `../_random`, promoted there by #41
 * once a second property test needed them. What stays here is what is about
 * *commands*: this module reaches for `commands`, `document` and `commandLog`,
 * and a geometry test importing it for sixteen lines of arithmetic would drag the
 * whole state layer into the stack trace of a failing clamp. The reasoning behind
 * a hand-written PRNG rather than `fast-check` moved with it.
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
    job_id: null,
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
