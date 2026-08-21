/**
 * How a batch's states read, and how its six per-asset states group into five.
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
 * ## Green arrived, and it arrived the way the old note said it would have to
 *
 * `tests/scripts/design_tokens.test.mjs` fails the build on a colour that is not a
 * token, so a status green has to be a published token before anything can use
 * one. `success` is that token, and `completed` takes it.
 *
 * ## The tone is a token, and the word is not optional
 *
 * Left to each surface, the six per-asset states get **three** private
 * vocabularies: a monochrome ramp off `primary` for the gallery card and the
 * timeline, and a semantic one in the annotator in which `skipped` is
 * **`destructive`**. That makes `accepted` green on one screen and near-black on
 * another, and paints a frame somebody deliberately passed over in the
 * colour this product uses for a failure.
 *
 * `PROGRESS_TONE` is the one answer, and `progressDotClass` /
 * `progressCellClass` are the one drawing of it. The rule underneath is two
 * channels that stay separable: **the tone says which family a state is in, the
 * shape says how far along it is**, so the strip still reads in greyscale and a
 * dot is still a dot to somebody who cannot tell the green from the amber. The
 * word rides beside every one of them, which is the part neither channel
 * replaces — `DESIGN.md` and WCAG agree that status is never colour alone.
 *
 * `warning` is the attention family and it means exactly one thing here,
 * `review_pending`: a frame waiting on a person. That is also the argument for
 * what did **not** move. `in_annotation` keeps the accent: a batch somebody is
 * annotating is the healthy majority state, and painting the majority state
 * amber makes a list of ordinary work read as a list of problems. `approved`
 * stays `outline` rather than acquiring a colour for symmetry's sake.
 *
 * `pre_labeled` takes `accent` for the same reason `in_annotation` does: a
 * model's guess sitting in an otherwise ordinary batch is the healthy case,
 * not a problem, so it earns the colour that already means "this is where the
 * normal work is" rather than `warning`, which is spoken for. Its shape is
 * `ring` rather than `filled` — the labels exist but nobody has committed to
 * them yet, the same open reading `review_pending`'s ring gives a submitted
 * frame.
 */

import type { AssetProgress } from "../annotator/jobQueries.js";

/**
 * The semantic tokens a status may wear, and the whole list of them.
 *
 * A status picks an intent; it never picks a colour. Every family in the product
 * — batch lifecycle, per-asset progress, an ingest run, a background job —
 * writes its map against this union, so a sixth colour is a type error rather
 * than a diff nobody notices. `outline` is on `BadgeTone` alone: it is a chip
 * treatment (a `card` fill on a hairline) rather than a colour, so nothing can
 * paint a dot or a timeline cell with it.
 */
export type StatusTone = "neutral" | "accent" | "success" | "warning" | "destructive";

export type BadgeTone = StatusTone | "outline";

/** `BatchState`, and how each reads. The order is the machine's own. */
export const BATCH_STATE_VARIANT: Record<string, BadgeTone> = {
  draft: "neutral",
  approved: "outline",
  in_annotation: "accent",
  completed: "success",
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

/**
 * Whether this batch has been cut into jobs yet — and therefore whether anything
 * on the screen that describes *work* has an answer.
 *
 * **This is a question about data, never about permission**, and the distinction
 * is the one this module got wrong. It used to gate the gallery's selection and
 * its bulk bar, which made `hasJobs` the answer to "may work happen here" — and
 * the answer was wrong for two of the three states it admitted, because
 * `approved` and `completed` have jobs and refuse every write. Legality comes
 * from `allowed_actions` now (`data/capabilities.ts`); this decides only whether
 * a progress bar has a number to show.
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

// --- the five segments -------------------------------------------------------

/**
 * The toolbar's grouping of the domain's six per-asset states.
 *
 * **Every state maps to exactly one segment**, which is the property that makes
 * the counts trustworthy: they sum to the batch's own total, so a segment showing
 * `0` means none rather than "not counted". `review_pending` and `accepted` are
 * two a four-way split silently drops if nobody writes the mapping down, and
 * dropping a state is worse than an extra segment would have been — an asset
 * that exists in no filter cannot be found at all.
 *
 * `pre_labeled` earns its own segment rather than joining one of the other
 * three, because it honestly is none of them: not `unannotated` — a model
 * already wrote something there — not `review` — nobody submitted it, a person
 * has not touched it at all — and not `done` — it is exactly the work this batch
 * still needs a person to do. Folding it into `unannotated` would show
 * "Unannotated" over frames that already carry boxes; folding it into `review`
 * would claim a person is waiting on a reviewer when no person has been near it.
 * Both readings are false in a way a filter should not be.
 *
 * The grouping is the *toolbar's*, not the domain's. A card and a timeline cell
 * still show the exact state, because "done" is the right thing to filter by and
 * the wrong thing to be told when you are looking at one frame.
 */
export type Segment = "all" | "unannotated" | "pre_labeled" | "review" | "done";

export const SEGMENTS: readonly Segment[] = [
  "all",
  "unannotated",
  "pre_labeled",
  "review",
  "done",
];

export const SEGMENT_LABEL: Record<Segment, string> = {
  all: "All",
  unannotated: "Unannotated",
  // "Model-labeled" rather than "Pre-labeled": the gallery's own Pre-label
  // button already owns that word, and a segment tab reading the same text
  // back would read as a second door to the same action rather than a filter.
  pre_labeled: "Model-labeled",
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
    case "pre_labeled":
      return "pre_labeled";
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

/** The states a segment asks the server for; `all` asks for nothing. */
export function segmentProgress(segment: Segment): readonly AssetProgress[] | undefined {
  switch (segment) {
    case "all":
      return undefined;
    case "unannotated":
      return ["unannotated"];
    case "pre_labeled":
      return ["pre_labeled"];
    case "review":
      return ["review_pending"];
    case "done":
      return ["annotated", "skipped", "accepted"];
  }
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
  readonly pre_labeled: number;
  readonly annotated: number;
  readonly skipped: number;
  readonly review_pending: number;
  readonly accepted: number;
}): Record<Segment, number> {
  return {
    all: counts.total,
    unannotated: counts.unannotated,
    pre_labeled: counts.pre_labeled,
    review: counts.review_pending,
    done: counts.annotated + counts.accepted + counts.skipped,
  };
}

// --- per-asset presentation --------------------------------------------------

/**
 * The exact six states, as a shape, a tone and a word.
 *
 * `filled` vs `hollow` vs `muted` vs `ring` is the shape half and
 * `PROGRESS_TONE` is the colour half; the word is the third, and none of them is
 * optional. The two that a four-segment toolbar folds together, `annotated` and
 * `accepted`, share a shape *and* a tone — they are both settled, labelled work
 * — and the **word** is what tells them apart. That is deliberate: this is the
 * only place in the product that can say an asset was reviewed rather than
 * merely labelled, and it says it in prose, which is the channel that survives
 * every kind of colour blindness and every monochrome screen.
 *
 * `pre_labeled` is `ring`, the same shape `review_pending` wears for the same
 * reason: labels exist but nobody has committed to them, so the dot stays open
 * rather than filling in.
 */
export type DotStyle = "filled" | "hollow" | "muted" | "ring";

export const PROGRESS_DOT: Record<string, DotStyle> = {
  unannotated: "hollow",
  pre_labeled: "ring",
  annotated: "filled",
  review_pending: "ring",
  accepted: "filled",
  skipped: "muted",
};

export const PROGRESS_LABEL: Record<string, string> = {
  unannotated: "unannotated",
  pre_labeled: "pre-labeled",
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
 * Which semantic family each state belongs to.
 *
 * `skipped` is **neutral and not `destructive`**, which is the one reading this
 * sweep reversed rather than unified: skipping is a settled decision about a
 * frame, the same kind of act as annotating it, and the error colour said the
 * opposite to everybody who chose it. `unannotated` is neutral because nothing
 * has happened yet — a fresh batch is not a batch in trouble.
 *
 * `pre_labeled` is `accent`, not `warning`: `warning` is spoken for by
 * `review_pending` alone, and a model's guess in an otherwise ordinary batch is
 * the healthy case rather than a problem — the same reasoning `in_annotation`
 * gets on the batch-state map above.
 */
export const PROGRESS_TONE: Record<string, StatusTone> = {
  unannotated: "neutral",
  pre_labeled: "accent",
  annotated: "success",
  review_pending: "warning",
  accepted: "success",
  skipped: "neutral",
};

export function progressTone(progress: AssetProgress | null | undefined): StatusTone {
  if (progress === null || progress === undefined) return "neutral";
  return PROGRESS_TONE[progress] ?? "neutral";
}

/**
 * A tone's border and its fill, as whole utility names.
 *
 * Whole names rather than a `border-${tone}` template, because Tailwind scans
 * source *text*: a class assembled at runtime is a class the build never saw and
 * therefore a rule that is never emitted. The failure is silent and looks like a
 * styling mistake, which is why these are written out.
 */
const TONE_BORDER: Record<StatusTone, string> = {
  neutral: "border-border",
  accent: "border-primary",
  success: "border-success",
  warning: "border-warning",
  destructive: "border-destructive",
};

const TONE_FILL: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground",
  accent: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

/**
 * The dot, as the classes that draw it — border and fill, no geometry.
 *
 * The caller owns the size and the radius, because a dot on the annotator's
 * 44px bar and a dot on a gallery card are the same *status* at two scales. What
 * they may not own is the colour: that is what three private vocabularies were.
 *
 * The shape decides outline-versus-solid and the tone decides which colour, so
 * neither channel needs a table of its own. `muted` and `hollow` are drawn in
 * surface colours rather than in `neutral`'s ink: they are the two states with
 * nothing to announce, and a grey dot as loud as a green one is a dot competing
 * for a glance it does not deserve.
 */
export function progressDotClass(progress: AssetProgress | null | undefined): string {
  const shape = progressDot(progress);
  if (shape === "muted") return "border-border bg-stage";
  if (shape === "hollow") return "border-border bg-transparent";
  const tone = progressTone(progress);
  return shape === "ring" ? `${TONE_BORDER[tone]} bg-transparent` : `${TONE_BORDER[tone]} ${TONE_FILL[tone]}`;
}

/**
 * A timeline cell's fill, from the same tones.
 *
 * The strip is a row of solid blocks a pixel apart, so the shape channel is not
 * available to it at all — a ring inside a 4px-tall cell is not a ring, it is a
 * smudge. `review_pending` is therefore a solid `warning` here where the card
 * draws it as a warning ring. The **token is the same**, and that is the claim:
 * a colour on the strip and a dot on a card can no longer come to mean different
 * things, which is what the monochrome ramp had already started to do.
 */
export function progressCellClass(progress: AssetProgress | null | undefined): string {
  const shape = progressDot(progress);
  if (shape === "muted") return "bg-stage";
  if (shape === "hollow") return "bg-muted";
  return TONE_FILL[progressTone(progress)];
}

/**
 * The card's word for a model-labeled frame: how many labels, and the weakest
 * score among them — named as prompt affinity, the scale pre-labeling runs on.
 */
export function affinityWord(count: number, minConfidence: number | null): string {
  const labels = `${count} pre-labeled`;
  return minConfidence === null
    ? labels
    : `${labels} · ≥${Math.round(minConfidence * 100)}% affinity`;
}

/**
 * How many frames are still blocking the batch from completing.
 *
 * `SETTLED_PROGRESS` is `{annotated, skipped, accepted}` — generous, because review
 * is optional and an asset may be done at `annotated` — so the three that block
 * are `unannotated` (the labeling has not happened), `pre_labeled` (a model's
 * guess sits there unjudged) and `review_pending` (the review has not
 * happened). Stated as a sum of the three named states rather than as
 * `total - settled`, so a seventh state fails the build here instead of
 * quietly counting as done.
 */
export function outstandingWork(counts: {
  readonly unannotated: number;
  readonly pre_labeled: number;
  readonly review_pending: number;
}): number {
  return counts.unannotated + counts.pre_labeled + counts.review_pending;
}

// --- the header's numbers ----------------------------------------------------

/**
 * How far the batch has got, as the header states it.
 *
 * "Annotated" here means *a person has made a decision about the frame* —
 * every state but `unannotated` and `pre_labeled` is one, including skipping
 * it. `pre_labeled` reads as undone for the same reason `outstandingWork`
 * counts it: a model's guess sitting untouched is not a person's work, and a
 * bar crediting it would be the exact contradiction a batch of only
 * pre-labeled frames once showed — "100% annotated" beside a full list of
 * frames still to do. A bar that counted only `annotated` would also go
 * backwards when a frame is accepted, which is the one thing a progress bar
 * must never do.
 */
export function annotatedShare(counts: {
  readonly total: number;
  readonly unannotated: number;
  readonly pre_labeled: number;
}): { readonly done: number; readonly total: number; readonly percent: number } {
  const done = Math.max(0, counts.total - counts.unannotated - counts.pre_labeled);
  return {
    done,
    total: counts.total,
    percent: counts.total === 0 ? 0 : Math.round((done / counts.total) * 100),
  };
}

/**
 * "3 days ago", from an ISO moment — or `null` when there is nothing to say.
 *
 * **Null in, null out.** `ingested_at` is nullable because an asset written
 * before the column existed is legitimately
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
 * Derived rather than stored: `BatchOut` has no timestamp at all (that gap is
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
