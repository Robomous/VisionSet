/**
 * The sentences the batch controls say, kept apart from the controls so they
 * can be read and tested without rendering anything.
 */

import type { FinishBatchResult } from "./queries";

/**
 * What a press promoted, said in one sentence — in the UI's words, "added to
 * the dataset", for the kernel's `promote`.
 *
 * Exported and pure because it is the part with a decision in it, and the
 * decision is not obvious: **zero promoted is not a failure**, and the sentence
 * for it has to say why without sounding like one.
 *
 * `moved` is what the response carried; `settled` is how many of the batch's
 * assets are in the trunk now. A press that moved nothing over a batch that is
 * entirely in the trunk means "already there"; a press that moved nothing over a
 * batch with nothing in the trunk means every one was skipped.
 *
 * `noun` is the batch's own (`batchNoun`: images, scans or assets), so what was
 * added and what stayed out are counted in one word — the word the panel's
 * Images property uses.
 */
export function promotionSummary(
  moved: number,
  settled: number,
  total: number,
  noun: (count: number) => string,
): string {
  if (moved > 0) {
    const excluded = total - settled;
    const tail = excluded > 0 ? ` ${excluded} skipped ${noun(excluded)} stayed out.` : "";
    return `Added ${moved} ${noun(moved)} to the dataset.${tail}`;
  }
  if (settled > 0) {
    // The idempotent no-op, which is the case that looked most like a bug: a
    // second press, or a first press in a fresh session after an earlier one.
    return `Already in the dataset — nothing new to add.`;
  }
  return `Nothing here can be added: every ${noun(1)} was skipped, and a skipped ${noun(1)} never enters the dataset.`;
}

/**
 * What to call a correction of this batch, before anybody types anything.
 *
 * Pure and exported because it is the part with a decision in it: a name is
 * required, and a dialog that opened blank would make the common case — "yes,
 * correct this, that is all I meant" — cost a sentence of typing. Numbering by
 * how many corrections already exist keeps a chain readable in a listing, and
 * counting is the caller's job because only it has the listing.
 */
export function defaultCorrectionName(parent: string, existing: number): string {
  return existing === 0 ? `${parent} — correction` : `${parent} — correction ${existing + 1}`;
}

/** "Completed, closing 2 open jobs." — shared by both ways of completing. */
export function completedLine(result: FinishBatchResult): string {
  const jobs = result.jobsFinished;
  return jobs > 0 ? `Completed, closing ${jobs} open job${jobs === 1 ? "" : "s"}.` : "Completed.";
}
