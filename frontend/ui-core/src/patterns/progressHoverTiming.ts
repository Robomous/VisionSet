/**
 * When a progress card may skip its wait and its entrance.
 *
 * The first card waits for intent — a pointer crossing a table on its way
 * somewhere else must not set cards flashing. Once one has been open, the
 * next opens at once and without motion: the person has shown they are
 * reading along the column, and making them wait again for each is the
 * slowness hover must never have.
 */

/** The wait before the first card: intent, not a pointer passing through (400–700ms reads as intent). */
export const PROGRESS_CARD_DELAY = 450;
/** How long after a card closes the next one still counts as the same reading. */
export const PROGRESS_CARD_CHAIN = 400;

let lastClosed = Number.NEGATIVE_INFINITY;

export function inProgressChain(): boolean {
  return performance.now() - lastClosed < PROGRESS_CARD_CHAIN;
}

export function markProgressCardClosed(): void {
  lastClosed = performance.now();
}
