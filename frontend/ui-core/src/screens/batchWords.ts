/**
 * The sentences the batch controls say, kept apart from the controls so they
 * can be read and tested without rendering anything.
 */

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
 * batch with nothing in the trunk means every frame was skipped.
 */
export function promotionSummary(
  moved: number,
  settled: number,
  total: number,
): string {
  if (moved > 0) {
    const excluded = total - settled;
    const tail =
      excluded > 0
        ? ` ${excluded} skipped frame${excluded === 1 ? "" : "s"} stayed out.`
        : "";
    return `Added ${moved} asset${moved === 1 ? "" : "s"} to the dataset.${tail}`;
  }
  if (settled > 0) {
    // The idempotent no-op, which is the case that looked most like a bug: a
    // second press, or a first press in a fresh session after an earlier one.
    return `Already in the dataset — nothing new to add.`;
  }
  return "Nothing here can be added: every frame was skipped, and a skipped frame never enters the dataset.";
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
