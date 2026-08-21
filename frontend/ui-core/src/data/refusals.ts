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
 * a user is not an error message, and removing that class of rendering one screen
 * at a time leaves the rule with nowhere to live.
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
 *
 * ## Six codes are withheld on purpose
 *
 * `LOCAL_INFERENCE_UNAVAILABLE`, `INFERENCE_CONNECTION_NOT_RUNNABLE`,
 * `INFERENCE_OUT_OF_MEMORY`, `UNSUPPORTED_PROMPT` and
 * `INFERENCE_CONNECTION_NOT_CHECKABLE` carry their remedy in the message
 * itself — an install command, the model family nothing here can run, the
 * device that ran out of memory, which of two states the connection is in and
 * the download that fixes one of them. A sentence written here would be shorter
 * and would say less, so these fall through by decision rather than by omission.
 *
 * `DUPLICATE_CLASSIFICATION_TAG` is withheld for a different reason: its
 * message mixes a leak (an asset id) with a fact (the class name), and a
 * static sentence cannot keep the fact. The real fix is kernel-side.
 *
 * ## Where the code may appear
 *
 * The prose is always the visible notice. The identifier survives only where a
 * bug report can reach it, and which place that is depends on the surface:
 *
 * - an inline notice (`EditorNotice`) puts it in the DOM `title` tooltip —
 *   quotable, never rendered;
 * - a full error state (`ErrorState`) puts it in a secondary mono meta line,
 *   de-duplicated against the sentence;
 * - a bare `Alert` does not carry it at all;
 * - a visible `Badge` beside the raw message is the fourth shape, not yet
 *   settled — two `InferenceScreen` sites still do it. Each renders a
 *   union: a real wire refusal from the mutation, or a settled background
 *   job's error string, and it is the job half no code-keyed map can serve.
 *
 * A code as an `Alert` heading is the shape this map exists to end.
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
  // Projects.
  PROJECT_NOT_FOUND: "That project is no longer on record.",
  PROJECT_NAME_TAKEN: "A project with that name already exists.",

  // The batch-state family. These three are the ones a capability declaration
  // now pre-empts, so reaching one means the batch moved under the press —
  // another tab, another person — rather than a control that should not have
  // been offered.
  BATCH_NOT_IN_ANNOTATION: "This batch is not open for annotation any more.",
  BATCH_NOT_EDITABLE: "This batch can no longer be edited — only a draft can be.",
  BATCH_NOT_COMPLETE: "Some of this batch's jobs are still unfinished.",
  BATCH_IMMUTABLE: "This batch is completed, and completed batches are kept.",
  BATCH_NOT_FOUND: "That batch is no longer on record.",
  EMPTY_BATCH: "This batch has no frames — add some before approving it.",
  INVALID_TRANSITION: "This has already moved on — reload to see where it is now.",
  // Not the same sentence as INVALID_TRANSITION, though they are neighbours.
  // That one means the move was never allowed from here; this one means it was
  // allowed a moment ago and somebody else got there first — so the remedy names
  // the other person rather than the rule.
  STALE_WRITE: "Someone else changed this while you were working on it — reload to see it.",

  // The annotation-work family — a job, and the frames inside one.
  ASSET_NOT_WRITABLE: "This frame's labeling is settled — its labels cannot be changed here.",
  JOB_NOT_COMPLETE: "Some frames still need annotating or skipping.",
  ASSET_NOT_IN_JOB: "This frame is not part of this job.",
  ASSET_NOT_IN_BATCH: "That frame is not in the batch this one corrects.",
  ASSET_NOT_FOUND: "Some of those frames are not in this project.",
  ANNOTATION_NOT_FOUND: "That annotation is no longer on record.",
  ANNOTATION_GEOMETRY_OUT_OF_BOUNDS: "That shape falls outside the frame it is drawn on.",
  JOB_NOT_FOUND: "That job is no longer on record.",
  JOB_FINISHED: "This job is finished — correct its labels in a new batch instead.",

  // The schema family. `SCHEMA_NOT_FOUND` is the one with a remedy the screen
  // supplies (a link to the schema tab), so the sentence sets that up.
  SCHEMA_NOT_FOUND: "This project has no labels yet — define them first.",
  DESTRUCTIVE_SCHEMA_CHANGE: "This change removes part of the contract already in use.",
  SCHEMA_CHANGE_WOULD_ORPHAN: "Annotations already exist under a class this change removes.",
  SCHEMA_DRAFT_NOT_FOUND: "There is no saved draft to publish.",
  SCHEMA_VERSION_CONFLICT: "Someone else published a version first — publish again to take the next one.",

  // Ingest.
  INGEST_JOB_NOT_FOUND: "That run is no longer on record.",
  SOURCE_NOT_FOUND: "That source is no longer on record.",

  // Background runs.
  BACKGROUND_JOB_NOT_FOUND: "That background job is no longer on record.",

  // Releases and export.
  DATASET_NOT_FOUND: "That dataset is no longer on record.",
  RELEASE_NOT_FOUND: "That release is no longer on record.",
  RELEASE_TAG_TAKEN: "A release with that tag already exists — tags are never reused.",
  NO_SPLIT_RECIPE: "This release was published without a split, so there are no folds to show.",
  LOSSY_EXPORT_NOT_CONSENTED: "This format cannot express every shape in the dataset.",
  EXPORT_FORMAT_NOT_FOUND: "No exporter for that format is installed on this server.",
  UNSERIALIZABLE_MANIFEST: "This release's manifest cannot be read back — the workspace may be damaged.",
  EMPTY_RELEASE: "This dataset has no frames yet — promote a completed batch first.",

  // Inference connections.
  INFERENCE_CONNECTION_NOT_FOUND: "That model connection is no longer on record.",
  INFERENCE_CONNECTION_NAME_TAKEN: "A model connection with that name already exists.",
  INFERENCE_CONNECTION_NOT_DOWNLOADABLE:
    "This connection's model runs elsewhere, so there are no weights to fetch.",
  INFERENCE_CONNECTION_NOT_SET_UP: "This connection is not ready — download its weights first.",

  // Infrastructure the user can act on.
  WORKSPACE_BUSY: "The workspace is busy — try again in a moment.",
  NOT_A_WORKSPACE: "This server is not pointed at a workspace.",
  MEDIA_TOOL_UNAVAILABLE: "This server is missing a tool it needs to read that media.",

  // The client's own two, from `data/errors.ts`. A person hitting either of
  // these is not looking at a domain refusal, and saying "the server refused
  // this" would be wrong about where the problem is.
  NETWORK_ERROR: "The server could not be reached — check the connection and try again.",
  MALFORMED_RESPONSE: "The server answered with something this app does not recognise.",
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
