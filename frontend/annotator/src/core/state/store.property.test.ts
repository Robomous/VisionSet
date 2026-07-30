/**
 * Acceptance criterion 1 of #39: random command sequences, then a full undo
 * returns the initial document.
 *
 * Each seed drives forty steps of arbitrary edits — adds, replacements, deletes,
 * nested groups, staged drags and the occasional undo or redo mid-run — and then
 * unwinds the whole thing. The seed is in the test name, so a failure is replayed
 * by running that one case.
 *
 * ## The assertion is against a document the log never touched
 *
 * Comparing the unwound document with the object the run started from would be
 * vacuous under a snapshot history: undo restores that very reference, so the
 * check would pass by construction and prove nothing. So the expectation is built
 * **separately**, from the same ids, and never handed to the store.
 *
 * And it compares an ordered array. A history that restored the right annotations
 * in the wrong order would satisfy a set comparison, and that is exactly the
 * failure mode of the `apply`/`invert` design that was rejected: undoing a delete
 * through `addAnnotation` appends, so the annotation comes back on top instead of
 * where it was. Draw order is the assertion that decides between the two designs.
 */

import { describe, expect, it } from "vitest";

import { mulberry32, SEEDS } from "../_random";
import { documentOf } from "./_sample";
import { randomCommand, type RandomWorld } from "./_random";
import { annotationsInDrawOrder } from "./document";
import { AnnotatorStore } from "./store";

const START = ["a", "b", "c"] as const;
const STEPS = 40;

describe("a random run and a full unwind", () => {
  for (const seed of SEEDS) {
    it(`returns the document it started from (seed ${seed})`, () => {
      const random = mulberry32(seed);
      let minted = 0;
      const world: RandomWorld = {
        random,
        mint: () => `s${seed}-${(minted += 1)}`,
        labelClass: "sign",
      };

      const store = new AnnotatorStore(documentOf(...START));
      const initial = store.document;
      let drags = 0;
      let groupsAndEdits = 0;

      for (let step = 0; step < STEPS; step += 1) {
        const roll = random();
        if (roll < 0.1 && store.canUndo) {
          store.undo();
        } else if (roll < 0.15 && store.canRedo) {
          store.redo();
        } else if (roll < 0.35) {
          // A drag: staged three times — which also asserts in passing that
          // repeated projections do not stack — then committed as one entry.
          const command = randomCommand(world, store.document);
          for (let move = 0; move < 3; move += 1) {
            store.stage((document) => command.apply(document));
          }
          store.commit(command.label);
          drags += 1;
        } else {
          store.execute(randomCommand(world, store.document));
          groupsAndEdits += 1;
        }
      }

      expect(drags).toBeGreaterThan(0);
      expect(groupsAndEdits).toBeGreaterThan(0);

      // The head of the history, which is not where the run necessarily stopped:
      // a run whose last step was an undo is sitting *inside* the log, and
      // "redo everything" means the end of it, not wherever it happened to be.
      while (store.redo()) {
        /* to the head */
      }
      const head = store.document;

      while (store.undo()) {
        /* all the way back */
      }

      // Built here, from the ids alone. Nothing in this value came out of the
      // store, so agreeing with it is a claim about the history rather than
      // about a pointer the history handed back.
      expect(annotationsInDrawOrder(store.document)).toEqual(
        annotationsInDrawOrder(documentOf(...START)),
      );
      expect(store.canUndo).toBe(false);
      expect(store.document).toBe(initial);

      while (store.redo()) {
        /* all the way forward */
      }
      expect(store.canRedo).toBe(false);
      expect(store.document).toBe(head);
    });
  }

  it("leaves nothing staged behind, whatever the run did", () => {
    const random = mulberry32(99);
    let minted = 0;
    const world: RandomWorld = {
      random,
      mint: () => `x-${(minted += 1)}`,
      labelClass: "sign",
    };
    const store = new AnnotatorStore(documentOf(...START));

    for (let step = 0; step < STEPS; step += 1) {
      store.execute(randomCommand(world, store.document));
    }
    while (store.undo()) {
      /* unwind */
    }

    expect(store.preview).toBeNull();
    expect(store.rendered).toBe(store.document);
  });
});
