/**
 * Whether the Overview offers to auto-label, and how loudly — read off the
 * batch listing, as plain functions so the reading is tested without a DOM.
 *
 * ## Offered where the wire declares it
 *
 * The batches counted are the ones whose own `allowed_actions` carry
 * `pre_label` (`ui-capabilities`): nothing here decides that a batch may be
 * auto-labeled, it only adds up what the ones that may are still waiting for.
 *
 * ## The count
 *
 * An image is waiting when nobody — person or model — has labeled it: the
 * batch's `progress.unannotated`. A batch a model is drafting now is left out,
 * because its waiting images are already being done, so starting a run is what
 * makes the line go.
 *
 * ## Put away, against a number
 *
 * "Not now" is remembered per project with the count it was said to. The line
 * comes back only when more images are waiting than that — new images arrived —
 * and until then the offer is a quiet icon in the band.
 */

import { BATCH_ACTION, declares } from "../data/capabilities";
import { readPref, writePref } from "../data/prefs";
import { isDrafting } from "./overviewRows";
import type { Batch } from "./queries";

export interface AutoLabelOffer {
  /** The batches that declare `pre_label`, which the dialog lists. */
  readonly eligible: readonly Batch[];
  /** Images nobody has labeled, in those batches, that no run is drafting now. */
  readonly waiting: number;
  /** The line over the table: work is waiting and it has not been put away. */
  readonly line: boolean;
  /** The quiet icon in the band: offered, with no line saying so. */
  readonly tool: boolean;
}

export function autoLabelOffer(batches: readonly Batch[], dismissedAt: number | null): AutoLabelOffer {
  const eligible = batches.filter((batch) => declares(batch, BATCH_ACTION.preLabel));
  const waiting = eligible.reduce((sum, batch) => sum + (isDrafting(batch) ? 0 : batch.progress.unannotated), 0);
  const line = waiting > 0 && (dismissedAt === null || waiting > dismissedAt);
  return { eligible, waiting, line, tool: eligible.length > 0 && !line };
}

const dismissalKey = (projectId: string): string => `autolabel.dismissed.${projectId}`;

/** The count "Not now" was said to in this project, or `null` if it never was. */
export function readDismissal(projectId: string): number | null {
  const stored = readPref(dismissalKey(projectId));
  if (stored === null) return null;
  const count = Number(stored);
  // Read back, never trusted: anything that is not a count is no answer at all.
  return Number.isInteger(count) && count >= 0 ? count : null;
}

export function writeDismissal(projectId: string, count: number): void {
  writePref(dismissalKey(projectId), String(count));
}
