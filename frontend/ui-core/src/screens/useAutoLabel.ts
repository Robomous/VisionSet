/**
 * The Overview's auto-label offer, held where both of its places can read it:
 * the line over the Batches table and the icon in the table's band are one
 * offer, and putting the line away is the line *becoming* the icon.
 *
 * What is offered is `autoLabelOffer`'s reading of the listing; this hook adds
 * the person's "Not now", the dialog's open state, and the motion between the
 * two places — a FLIP from the line's button to the band's (`lib/motion.ts`).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

import { fadeIn, flipFirst, flipPlay, type Flight, type FlipFirst } from "../lib/motion";
import { autoLabelOffer, readDismissal, writeDismissal, type AutoLabelOffer } from "./autoLabelOffer";
import type { Batch } from "./queries";

/** The part of the offer's buttons that travels between them: the wand. */
const MORPH_ANCHOR = "[data-morph-anchor]";
/** The line's words on its button, which do not travel. */
const MORPH_LABEL = "[data-morph-label]";

export interface AutoLabel extends AutoLabelOffer {
  readonly dialogOpen: boolean;
  readonly openDialog: () => void;
  readonly closeDialog: () => void;
  /** "Not now". `fromKeyboard`: focus follows the offer into the band. */
  readonly dismiss: (fromKeyboard: boolean) => void;
  /** The line's "Auto-label them" — where the morph starts. */
  readonly startRef: RefObject<HTMLButtonElement | null>;
  /** The band's icon — where it lands. */
  readonly toolRef: RefObject<HTMLButtonElement | null>;
}

const NO_BATCHES: readonly Batch[] = [];

export function useAutoLabel(projectId: string, batches: readonly Batch[] | undefined): AutoLabel {
  // Read once per project; a "Not now" said here replaces it without a re-read.
  const [dismissal, setDismissal] = useState(() => ({ projectId, at: readDismissal(projectId) }));
  const dismissedAt = dismissal.projectId === projectId ? dismissal.at : readDismissal(projectId);
  const offer = useMemo(() => autoLabelOffer(batches ?? NO_BATCHES, dismissedAt), [batches, dismissedAt]);
  const [dialogOpen, setDialogOpen] = useState(false);

  const startRef = useRef<HTMLButtonElement>(null);
  const toolRef = useRef<HTMLButtonElement>(null);
  /** The one piece of motion in flight, so a newer one — or leaving — stops it where it is. */
  const flight = useRef<Flight | null>(null);
  /** "Not now", measured before it commits and flown once it has. */
  const putAway = useRef<{ readonly first: FlipFirst | null; readonly fromKeyboard: boolean } | null>(null);

  const fly = useCallback((trip: Flight): Flight => {
    flight.current?.cancel();
    flight.current = trip;
    void trip.finished.then(() => {
      if (flight.current === trip) flight.current = null;
    });
    return trip;
  }, []);

  const { waiting } = offer;
  const dismiss = useCallback(
    (fromKeyboard: boolean) => {
      // First: where the line's button is, before the change that takes it away.
      const source = startRef.current;
      putAway.current = { first: source === null ? null : flipFirst(source, MORPH_ANCHOR), fromKeyboard };
      writeDismissal(projectId, waiting);
      setDismissal({ projectId, at: waiting });
    },
    [projectId, waiting],
  );

  // After the commit that closes the line and puts the icon in the band, and
  // before it is painted: "Not now" flies the line's wand onto the icon; the
  // line leaving any other way — a run started, so nothing is waiting — hands
  // over without travelling, the icon fading in as the line closes. The line
  // coming back stops whatever was flying.
  const shown = useRef(offer.line);
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = offer.line;
    if (before === offer.line) return;
    const morph = putAway.current;
    putAway.current = null;
    const target = toolRef.current;
    if (offer.line || target === null) {
      flight.current?.cancel();
      flight.current = null;
      return;
    }
    if (morph?.first == null) {
      fly(fadeIn(target));
      return;
    }
    const trip = fly(flipPlay(morph.first, target, { anchor: MORPH_ANCHOR, label: MORPH_LABEL }));
    // Focus follows the offer to where it went, once it is there, so the
    // icon's tooltip opens over the icon rather than on its way.
    if (morph.fromKeyboard) {
      void trip.finished.then((landed) => {
        if (landed && target.isConnected) target.focus();
      });
    }
  }, [offer.line, fly]);

  // Nothing keeps flying, or stays on the page, once the Overview is gone.
  useEffect(() => {
    const pilot = flight;
    return () => pilot.current?.cancel();
  }, []);

  const openDialog = useCallback(() => setDialogOpen(true), []);
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  return { ...offer, dialogOpen, openDialog, closeDialog, dismiss, startRef, toolRef };
}
