/**
 * The two hooks a host needs, and the binding trap in the second one.
 *
 * Separate from `AnnotatorCanvas.tsx` because a host uses them *outside* the
 * canvas: the demo's undo button, its class palette and its tag panel all read
 * the same store the canvas draws, and a component that had to be rendered to
 * expose its state would not be embeddable in the sense #47 means.
 */

import { useMemo, useState, useSyncExternalStore } from "react";

import { documentFromWire } from "../../core/state/document";
import type { WireDocument } from "../../core/state/document";
import { AnnotatorStore } from "../../core/state/store";
import type { StoreSnapshot } from "../../core/state/store";
import type { Selection } from "../../core/state/selection";

/**
 * One store per asset, built from exactly what the API returned.
 *
 * `useState`'s lazy initializer rather than `useMemo`: React may drop a memo at
 * any time and rebuild it, which for a store would silently discard the session's
 * whole undo history. That is the documented difference between the two, and this
 * is the case where it bites.
 *
 * The wire payload is read **once**. A later one does not rebuild the store,
 * because the store is the source of truth after mount and rebuilding it would
 * throw away the history — swap the asset by remounting with a new `key`, which
 * is the same discipline the document's own asset check enforces.
 */
export function useAnnotatorStore(
  wire: WireDocument,
  selection?: Selection,
): AnnotatorStore {
  const [store] = useState(() => new AnnotatorStore(documentFromWire(wire), selection));
  return store;
}

/**
 * Everything the store holds, re-read whenever it changes.
 *
 * `store.subscribe` and `store.getSnapshot` are **bound**, and that is not
 * tidiness: passing `store.subscribe` bare loses `this`, so the first subscribe
 * throws on `this.listeners`. The one `useMemo` is what keeps
 * `useSyncExternalStore` from resubscribing on every render, which is the other
 * half of the contract `store.ts` was designed against.
 */
export function useAnnotatorSnapshot(store: AnnotatorStore): StoreSnapshot {
  const bound = useMemo(
    () => ({
      subscribe: (listener: () => void) => store.subscribe(listener),
      getSnapshot: () => store.getSnapshot(),
    }),
    [store],
  );
  return useSyncExternalStore(bound.subscribe, bound.getSnapshot, bound.getSnapshot);
}
