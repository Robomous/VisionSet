/**
 * The interpreter: seven effect kinds turned into `AnnotatorStore` calls.
 *
 * The **only** file in `interaction/` that imports `state/store.ts`, which is
 * the point of having it. The machine stays a pure function over data, and every
 * piece of knowledge about how a store is driven — the argument `stage` wants,
 * what `commit` does with a label, that a log verb drops the preview — lives in
 * one reviewable place instead of being re-derived by every tool and adapter.
 *
 * ## `stage` resolves against the committed document, every time
 *
 * `AnnotatorStore.stage` hands its projection the committed document on every
 * call, which is what makes a drag idempotent per pointer-move. So the
 * projection here looks the annotation up *inside* itself rather than closing
 * over one: the geometry travels in the effect, everything else comes from
 * whatever is committed at the moment the projection runs.
 *
 * It answers the document unchanged when the id has gone. That is not
 * defensive-programming reflex — `replaceAnnotation` throws `DocumentError` on
 * an unknown id, and this projection runs inside a pointer handler, so an undo
 * landing between a machine turn and its effects would surface as an exception
 * thrown at the adapter. `machine.ts`'s staleness guards catch that case one
 * turn later; this closes the window in between.
 *
 * ## Ordering, and why the failures are collected
 *
 * Effects apply in the order the turn listed them. `AnnotatorStore.changed`
 * runs every subscriber and then throws one `AggregateError` carrying whatever
 * they threw — so a naive loop would abort on the first bad subscriber, leave
 * the remaining effects unapplied, and leave the machine (whose state the caller
 * has already adopted) permanently disagreeing with the store. This mirrors the
 * store's own posture instead: apply everything, then raise once. That is the
 * kernel `InProcessEventBus`'s log-and-continue adapted to a layer with no
 * logger, one level further out.
 */

import { annotationById, replaceAnnotation } from "../state/document";
import { addAnnotationCommand, removeAnnotationsCommand, replaceAnnotationCommand } from "../state/commands";
import type { AnnotatorStore } from "../state/store";
import type { Effect } from "./effects";

function apply(store: AnnotatorStore, effect: Effect): void {
  switch (effect.kind) {
    case "select":
      store.select(effect.selection);
      return;
    case "stage":
      store.stage((document) => {
        const current = annotationById(document, effect.id);
        if (current === undefined) return document;
        return replaceAnnotation(document, { ...current, geometry: effect.geometry });
      });
      return;
    case "commit":
      store.commit(effect.label);
      return;
    case "discard":
      store.discard();
      return;
    case "add":
      store.execute(addAnnotationCommand(effect.annotation));
      return;
    case "replace":
      store.execute(replaceAnnotationCommand(effect.annotation));
      return;
    case "remove":
      store.execute(removeAnnotationsCommand(effect.ids));
      return;
    default:
      return unreachable(effect);
  }
}

/**
 * The compiler's own exhaustiveness proof: an effect kind added without a case
 * above makes this call fail to type-check.
 *
 * `noFallthroughCasesInSwitch` catches a missing `break`; it says nothing about
 * a missing case. This does.
 */
function unreachable(value: never): never {
  throw new TypeError(`unhandled effect: ${JSON.stringify(value)}`);
}

/**
 * Run a turn's effects against a store, in order.
 *
 * Every effect is applied even if an earlier one's subscribers threw; the
 * failures come back as one `AggregateError` once they all have.
 */
export function runEffects(store: AnnotatorStore, effects: readonly Effect[]): void {
  const failures: unknown[] = [];
  for (const effect of effects) {
    try {
      apply(store, effect);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} of ${effects.length} effect(s) failed`);
  }
}
