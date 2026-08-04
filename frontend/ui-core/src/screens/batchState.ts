/**
 * How a batch's states read, and how its five per-asset states group into four.
 *
 * Pure, and separate from any component, for the reason `imbalance.ts` and
 * `columnsFor` are: these are the claims worth checking without a browser, and
 * jsdom has nothing to say about them either way.
 *
 * ## One mapping, two screens
 *
 * `BatchesScreen` renders the lifecycle as a table row and `GalleryScreen` renders
 * it as a header badge. Both need "what colour is `in_annotation`" and "what does
 * a person call it", and a second spelling of either is free to drift — the
 * promoted-not-copied rule. The variant map moved here out of `BatchesScreen`
 * unchanged, so no shipped pixel moved with it.
 *
 * ## Why there is no amber, no green and no blue
 *
 * The design brief asked for them. `DESIGN.md` principle 3 gives this product
 * **one** accent and no status palette, and `tests/scripts/design_tokens.test.mjs`
 * fails the build on a colour that is not a token — so inventing three would mean
 * either three new tokens (a design-system change nobody asked for) or three
 * hardcoded hexes (gated, correctly). What carries the meaning instead is the
 * word, which is also the accessibility rule: state is never colour alone. The
 * variants below are the four the design system publishes, and `draft` takes the
 * accent because it is the one state with something to do.
 */

import type { AssetProgress } from "../annotator/jobQueries.js";

/** `BatchState`, and how each reads. The order is the machine's own. */
export const BATCH_STATE_VARIANT: Record<string, "neutral" | "accent" | "outline"> = {
  draft: "neutral",
  approved: "outline",
  in_annotation: "accent",
  completed: "outline",
};

/**
 * The kernel's vocabulary in the words a person uses for it.
 *
 * An unknown state falls through to itself rather than to "unknown": a newer
 * server naming a state this build has never heard of should read as that state,
 * not as a shrug. Same call `DatasetChange.operation` makes on the wire.
 */
export const BATCH_STATE_LABEL: Record<string, string> = {
  draft: "pending approval",
  approved: "approved",
  in_annotation: "in progress",
  completed: "completed",
};

export function batchStateLabel(state: string): string {
  return BATCH_STATE_LABEL[state] ?? state;
}

/** Only a `draft` can be approved, and approving is the one irreversible move. */
export function isApprovable(state: string | undefined): boolean {
  return state === "draft";
}

/**
 * Whether this batch has been cut into jobs yet — and therefore whether anything
 * on the screen that describes *work* has an answer.
 *
 * **A draft's `ProgressCounts` is zeros across the board, and that is documented
 * rather than accidental**: `GET /batches/{id}` says so in as many words, because
 * the counts come from `JobService.batch_progress` and a draft has no jobs. Its
 * `asset_count` is meanwhile whatever the ingest gathered.
 *
 * So a screen that renders progress-derived chrome for a draft is reading a
 * documented "no answer" as if it were data — which is exactly what "All (0) /
 * Unannotated (0)" over forty-eight visible frames was. The counts were not
 * wrong; asking the question was.
 *
 * Everything downstream of this predicate is hidden before approval rather than
 * shown as zero: the progress bar, the segmented filter, the timeline strip, and
 * selection with it. A draft is a *preview of what was ingested*, and its one
 * action is Approve.
 */
export function hasJobs(state: string | undefined): boolean {
  return state !== undefined && state !== "draft";
}

// --- the four segments -------------------------------------------------------

/**
 * The toolbar's grouping of the domain's five per-asset states.
 *
 * **Every state maps to exactly one segment**, which is the property that makes
 * the counts trustworthy: they sum to the batch's own total, so a segment showing
 * `0` means none rather than "not counted". `review_pending` and `accepted` are
 * the two a four-way split silently drops if nobody writes the mapping down, and
 * dropping them is worse than a fifth segment would have been — an asset that
 * exists in no filter cannot be found at all.
 *
 * The grouping is the *toolbar's*, not the domain's. A card and a timeline cell
 * still show the exact state, because "done" is the right thing to filter by and
 * the wrong thing to be told when you are looking at one frame.
 */
export type Segment = "all" | "unannotated" | "review" | "done";

export const SEGMENTS: readonly Segment[] = ["all", "unannotated", "review", "done"];

export const SEGMENT_LABEL: Record<Segment, string> = {
  all: "All",
  unannotated: "Unannotated",
  review: "In review",
  done: "Done",
};

/**
 * Which segment an asset belongs to.
 *
 * A **null** progress is `unannotated`, and that is a real case rather than
 * defensive coding: `job_id` and `progress` are both null exactly while the batch
 * is a draft, because a draft has no jobs. Nothing has been annotated in a draft,
 * so the honest segment is the one that says so.
 *
 * `skipped` lands in `done` — it is a settled decision about the asset, and the
 * question the segment answers is "is there work left here". The card still says
 * `skipped`, which is where that distinction belongs.
 */
export function segmentOf(progress: AssetProgress | null | undefined): Exclude<Segment, "all"> {
  switch (progress) {
    case "review_pending":
      return "review";
    case "annotated":
    case "accepted":
    case "skipped":
      return "done";
    default:
      return "unannotated";
  }
}

export function inSegment(
  progress: AssetProgress | null | undefined,
  segment: Segment,
): boolean {
  return segment === "all" || segmentOf(progress) === segment;
}

/**
 * How many assets each segment holds, from the batch's own counts.
 *
 * Read off `ProgressCounts` rather than off the loaded pages, because the pages
 * are a *window*: a batch of fifty thousand shows a hundred, and a filter whose
 * counts described the hundred would be a filter that lies about the batch. The
 * fixed-field model is what makes this a sum of named states instead of a loop
 * over whatever came back — a sixth state fails the build here rather than
 * quietly falling out of every total.
 */
export function segmentCounts(counts: {
  readonly total: number;
  readonly unannotated: number;
  readonly annotated: number;
  readonly skipped: number;
  readonly review_pending: number;
  readonly accepted: number;
}): Record<Segment, number> {
  return {
    all: counts.total,
    unannotated: counts.unannotated,
    review: counts.review_pending,
    done: counts.annotated + counts.accepted + counts.skipped,
  };
}

// --- per-asset presentation --------------------------------------------------

/**
 * The exact five states, as a dot and a word.
 *
 * `filled` vs `hollow` vs `muted` is the shape half; the word is the other half,
 * and neither is optional — `DESIGN.md` and WCAG agree that colour alone is not a
 * status. The two that a four-segment toolbar folds together, `annotated` and
 * `accepted`, are deliberately drawn differently here: this is the only place in
 * the product that can tell somebody an asset has been *reviewed*.
 */
export type DotStyle = "filled" | "hollow" | "muted" | "ring";

export const PROGRESS_DOT: Record<string, DotStyle> = {
  unannotated: "hollow",
  annotated: "filled",
  review_pending: "ring",
  accepted: "filled",
  skipped: "muted",
};

export const PROGRESS_LABEL: Record<string, string> = {
  unannotated: "unannotated",
  annotated: "annotated",
  review_pending: "in review",
  accepted: "accepted",
  skipped: "skipped",
};

export function progressLabel(progress: AssetProgress | null | undefined): string {
  if (progress === null || progress === undefined) return "unannotated";
  return PROGRESS_LABEL[progress] ?? progress;
}

export function progressDot(progress: AssetProgress | null | undefined): DotStyle {
  if (progress === null || progress === undefined) return "hollow";
  return PROGRESS_DOT[progress] ?? "hollow";
}

/**
 * Whether an asset is far enough along that asking for its annotations is worth a
 * request.
 *
 * The count on a card is fetched per asset, because `BatchAssetOut` does not carry
 * one — so the cheapest correct thing is to not ask about the assets that
 * certainly have none. An `unannotated` asset has no annotations by definition;
 * a `skipped` one was passed over. The rest may.
 */
export function mayHaveAnnotations(progress: AssetProgress | null | undefined): boolean {
  return progress === "annotated" || progress === "review_pending" || progress === "accepted";
}

// --- which bulk moves a frame can actually make (#301) ------------------------

/**
 * Whether this frame can be skipped from here.
 *
 * A mirror of two rows of the kernel's `ASSET_PROGRESS_TRANSITIONS`, and it is a
 * mirror on purpose rather than by omission — the annotator already does the same
 * thing for its `Accept` button, on the same principle: *the kernel decides, and
 * the screen does not offer a move it can see is impossible.*
 *
 * The row that matters is the one that is **not** a refusal. Re-stating a state an
 * asset is already in is a documented **no-op** in `JobService.mark`, answered
 * `200` with nothing changed — so a bulk bar that sent it reported "moved" over
 * work it had not done, and the screen read as broken multi-selection when the
 * selection was working perfectly. That is #301's second half, and filtering here
 * is what makes the count on the button honest.
 *
 * `review_pending` is left out because its only exits are `annotated` and
 * `accepted`; `accepted` because it has none at all.
 */
export function canSkip(progress: AssetProgress | null | undefined): boolean {
  return progress === "unannotated" || progress === "annotated";
}

/**
 * Whether this frame's skip can be taken back — `skipped → unannotated`.
 *
 * The kernel calls that edge "the decision was reversed while the job is open",
 * and until #301 there was no way to make it anywhere in the browser: a mis-aimed
 * shift-click over forty frames was unrecoverable without opening each one.
 *
 * **`skipped` only, though `annotated → unannotated` is equally legal.** That edge
 * means *the last annotation on it was deleted* — it is what `AnnotationService`
 * records when the boxes go — so asserting it over a frame that still has boxes
 * would put progress and annotations out of step, with the kernel agreeing to it
 * because each half is individually valid. Restore undoes a decision, not work.
 */
export function canRestore(progress: AssetProgress | null | undefined): boolean {
  return progress === "skipped";
}

/**
 * How many frames are still blocking the batch from completing.
 *
 * `SETTLED_PROGRESS` is `{annotated, skipped, accepted}` — generous, because review
 * is optional and an asset may be done at `annotated` — so the two that block are
 * `unannotated` (the labeling has not happened) and `review_pending` (the review
 * has not). Stated as a sum of the two named states rather than as
 * `total - settled`, so a sixth state fails the build here instead of quietly
 * counting as done.
 */
export function outstandingWork(counts: {
  readonly unannotated: number;
  readonly review_pending: number;
}): number {
  return counts.unannotated + counts.review_pending;
}

// --- the header's numbers ----------------------------------------------------

/**
 * How far the batch has got, as the header states it.
 *
 * "Annotated" here means *past `unannotated`* — every other state is somebody
 * having made a decision about the frame, including skipping it. A bar that
 * counted only `annotated` would go backwards when a frame is accepted, which is
 * the one thing a progress bar must never do.
 */
export function annotatedShare(counts: {
  readonly total: number;
  readonly unannotated: number;
}): { readonly done: number; readonly total: number; readonly percent: number } {
  const done = Math.max(0, counts.total - counts.unannotated);
  return {
    done,
    total: counts.total,
    percent: counts.total === 0 ? 0 : Math.round((done / counts.total) * 100),
  };
}

/**
 * "3 days ago", from an ISO moment — or `null` when there is nothing to say.
 *
 * **Null in, null out, and that is the whole point of #283.** `ingested_at` is
 * nullable because an asset written before #216 existed is legitimately
 * unstamped, and null means *unknown* rather than "never". Rendering unknown as
 * "just now" or as the epoch would be inventing a fact; the header omits the line
 * instead.
 *
 * `now` is a parameter rather than a call to `Date.now()` so this is testable
 * without freezing a clock.
 */
export function relativeAge(iso: string | null | undefined, now: number): string | null {
  if (iso === null || iso === undefined) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * The earliest arrival among the assets loaded so far, as the batch's own age.
 *
 * Derived rather than stored: `BatchOut` has no timestamp at all (#283 records
 * why, and settling it is a migration nobody has taken). A whole ingest run
 * shares one timestamp, so for the batch this exists for — one born from one run
 * — the earliest *is* the batch's moment. It is computed from the loaded window
 * and stated as approximate for that reason.
 */
export function earliestArrival(
  assets: readonly { readonly ingested_at?: string | null }[],
): string | null {
  let earliest: string | null = null;
  for (const asset of assets) {
    const at = asset.ingested_at;
    if (at === null || at === undefined) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}
