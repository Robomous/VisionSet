/**
 * One vocabulary for every refusal the kernel can hand a person.
 *
 * ## Why one map and not one per screen
 *
 * A refusal reached the user in three different shapes depending on which screen
 * they were on: the full `{code}: {message}` in six places, a bare
 * `BATCH_NOT_IN_ANNOTATION` badge in three, and a humanized sentence in two —
 * each map written where it was needed and none of them aware of the others.
 * The bare-code sites are the ones worth naming: a kernel identifier in front of
 * a user is not an error message, and #292 removed that class of rendering from
 * one screen without anywhere to put the rule.
 *
 * This is that place. A code has one sentence, product-wide, and a screen that
 * wants a remedy adds it *beside* the sentence rather than instead of it.
 *
 * ## The fall-through is deliberate
 *
 * A code with no entry keeps the server's own `message`, which is written for a
 * person and is usually good. Falling through to "Something went wrong" would
 * discard the one description the kernel actually wrote. The code is appended
 * only when there is no message at all — at that point the identifier is the
 * only fact there is, and it is what a bug report should quote.
 *
 * Entries are for codes whose server message is *correct but unhelpful in
 * context*: the kernel says what rule was broken, and the product says what the
 * person can do about it.
 */

import { asApiError } from "./errors.js";

/**
 * The codes worth restating, and what they say instead.
 *
 * Keyed on the kernel's `code`, which is a stable public contract by
 * construction — `server/errors.py` holds them as literals precisely so a Python
 * rename cannot silently break a client.
 */
export const REFUSAL_PROSE: Record<string, string> = {
  // The batch-state family. These three are the ones a capability declaration
  // now pre-empts, so reaching one means the batch moved under the press —
  // another tab, another person — rather than a control that should not have
  // been offered.
  BATCH_NOT_IN_ANNOTATION: "This batch is not open for annotation any more.",
  BATCH_NOT_EDITABLE: "This batch can no longer be edited — only a draft can be.",
  BATCH_NOT_COMPLETE: "Some of this batch's jobs are still unfinished.",
  BATCH_IMMUTABLE: "This batch is completed, and completed batches are kept.",
  INVALID_TRANSITION: "This has already moved on — reload to see where it is now.",

  // The per-asset family.
  ASSET_NOT_WRITABLE: "This frame's labeling is settled — its labels cannot be changed here.",
  JOB_NOT_COMPLETE: "Some frames still need annotating or skipping.",
  ASSET_NOT_IN_JOB: "This frame is not part of this job.",

  // The schema family. `SCHEMA_NOT_FOUND` is the one with a remedy the screen
  // supplies (a link to the schema tab), so the sentence sets that up.
  SCHEMA_NOT_FOUND: "This project has no label schema yet — one is needed before approving.",
  DESTRUCTIVE_SCHEMA_CHANGE: "This change removes part of the contract already in use.",
  SCHEMA_CHANGE_WOULD_ORPHAN: "Annotations already exist under a class this change removes.",

  // Infrastructure the user can act on.
  WORKSPACE_BUSY: "The workspace is busy — try again in a moment.",
  NOT_A_WORKSPACE: "This server is not pointed at a workspace.",
};

/**
 * What to show a person for one failed request.
 *
 * Takes the raw `unknown` a mutation's `error` carries rather than an `ApiError`,
 * because every call site has the former and converting at each of them is how a
 * site ends up rendering `[object Object]`.
 */
export function refusalProse(cause: unknown): string {
  const error = asApiError(cause);
  const known = REFUSAL_PROSE[error.code];
  if (known !== undefined) return known;
  if (error.message.length > 0) return error.message;
  return `The server refused this (${error.code}).`;
}

/** One refusal, kept with the thing it happened to. */
export interface Refusal {
  readonly code: string;
  readonly message: string;
}

/**
 * N refusals, said once each, with how many times each happened.
 *
 * A bulk move over forty frames that hits one rule hits it forty times, and
 * forty identical sentences is not more information than one. Grouping by code
 * is what turns "0 moved, 40 refused" into a sentence somebody can act on.
 *
 * Insertion-ordered: the first refusal's code leads, which for a bulk move over
 * a homogeneous selection is the only one there is.
 */
export function groupRefusals(
  refusals: readonly Refusal[],
): readonly { readonly code: string; readonly prose: string; readonly count: number }[] {
  const byCode = new Map<string, { prose: string; count: number }>();
  for (const refusal of refusals) {
    const seen = byCode.get(refusal.code);
    if (seen !== undefined) {
      seen.count += 1;
      continue;
    }
    byCode.set(refusal.code, {
      prose: REFUSAL_PROSE[refusal.code] ?? (refusal.message.length > 0 ? refusal.message : refusal.code),
      count: 1,
    });
  }
  return [...byCode].map(([code, { prose, count }]) => ({ code, prose, count }));
}
