/**
 * The hooks a host needs, and the binding trap in the second one.
 *
 * Separate from `AnnotatorCanvas.tsx` because a host uses them *outside* the
 * canvas: the demo's undo button, its class palette and its tag panel all read
 * the same store the canvas draws, and a component that had to be rendered to
 * expose its state would not be embeddable. `usePendingIndicator` is here for the
 * same reason from the other direction — the host owns the request, so the host
 * owns the clock over it, and the canvas is handed the answer as a prop.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { documentFromWire } from "../../core/state/document";
import type { WireDocument } from "../../core/state/document";
import { AnnotatorStore } from "../../core/state/store";
import type { StoreSnapshot } from "../../core/state/store";
import type { Selection } from "../../core/state/selection";
import { pendingIndicator } from "./pending";

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

/** What the indicator has decided, plus the take-back. */
export interface PendingIndicatorState {
  /** A request is out, or the floor is still holding one up — draw the halo. */
  readonly shown: boolean;
  /** Long enough to be worth a sentence about the first click being the slow one. */
  readonly escalated: boolean;
  /** Escape: down now, ignoring the visibility floor. */
  readonly cancel: () => void;
}

/**
 * One clock over one in-flight request, read by every surface that reports it.
 *
 * `active` is the session's own `asking`, and the whole design rests on that
 * being a single boolean: a refine click never lowers it, so the machine sees one
 * continuous period and the halo neither restarts nor blinks. It is called
 * **once**, by the host holding the session — two calls would be two clocks, free
 * to drift, and the panel and the canvas would disagree about a threshold they are
 * both supposed to be obeying.
 *
 * **`shown` is `active` OR the machine's own state, and the disjunction is what
 * makes "immediately" true.** The machine is driven from an effect, so an
 * announcement it makes cannot reach this render — reading `shown` off the
 * announcement alone would leave one frame where a request has gone out and
 * nothing on screen says so, which is the delay this change removed, reintroduced
 * by React's scheduling instead of by a timer. `active` covers the request; the
 * machine's own flag covers the tail, where the floor is still holding the halo up
 * over a request that has already been answered.
 */
export function usePendingIndicator(active: boolean): PendingIndicatorState {
  const [phase, setPhase] = useState({ shown: false, escalated: false });

  // `useState`'s lazy initializer rather than `useMemo`, for the reason above it:
  // React may drop a memo and rebuild it, and a rebuilt machine would abandon the
  // timers the old one was holding with nothing left able to clear them.
  const [indicator] = useState(() =>
    pendingIndicator((announced) => {
      setPhase((live) =>
        announced === "show"
          ? { shown: true, escalated: live.escalated }
          : announced === "escalate"
            ? { shown: live.shown, escalated: true }
            : { shown: false, escalated: false },
      );
    }),
  );

  useEffect(() => {
    if (active) indicator.start();
    else indicator.resolve();
  }, [active, indicator]);

  // Leaving the frame mid-request must not leave a timer alive over a component
  // that is gone.
  useEffect(() => () => indicator.cancel(), [indicator]);

  const cancel = useCallback(() => indicator.cancel(), [indicator]);
  return { shown: active || phase.shown, escalated: phase.escalated, cancel };
}

/** The query, named once so the hook and its documentation cannot disagree. */
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Whether the host has one, and whether it says to stop moving things. */
function askedForStillness(): boolean {
  // `typeof` rather than a truthiness check, and it is load-bearing: this package
  // is unit-tested under **node**, and `ui-core` renders it under jsdom, and
  // neither implements `matchMedia`. A bare read would throw in both.
  return typeof matchMedia === "function" && matchMedia(REDUCED_MOTION).matches;
}

/**
 * The one accessibility preference this renderer reads.
 *
 * The engine cannot: `matchMedia` is a browser global, and `eslint.config.js`
 * bans every one of those under `src/core/**`. That is the boundary working —
 * whether an indicator pulses is a fact about a screen, not about an annotation.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(askedForStillness);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(REDUCED_MOTION);
    const read = (): void => setReduced(query.matches);
    // Read once on attach as well: the preference can have moved between the
    // lazy initializer and here, and a listener alone would never hear about it.
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);

  return reduced;
}
