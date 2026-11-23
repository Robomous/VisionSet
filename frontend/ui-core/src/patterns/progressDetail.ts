/**
 * What a progress indicator can say beyond its number, when a person asks by
 * pointing at it: whose progress it is, and how the whole splits.
 *
 * The split is the wire's own: a batch's or a job's `ProgressCounts` is how
 * many assets sit in each annotation state, so the parts add up to the total
 * and nothing is estimated. The first four are done — a person decided them —
 * and the last two are not, which is how `annotatedShare` counts too.
 */

export type SegmentTone = "success" | "progress" | "info" | "muted" | "model" | "empty";

export interface ProgressSegment {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly tone: SegmentTone;
  /** Counted toward done. */
  readonly done: boolean;
}

export interface ProgressDetail {
  /** Whose progress: "Labeled", "Job 2", "Downloading sam2". */
  readonly title: string;
  /** A second line: the batch's name, who holds the job. */
  readonly caption?: string;
  /** How the total splits, in reading order; omitted where the wire has no split. */
  readonly segments?: readonly ProgressSegment[];
  /** One sentence more: what is left, or what it is waiting on. */
  readonly note?: string;
}

/** The fill each tone draws with, for a dot, a bar segment or an arc. */
export const SEGMENT_FILL: Readonly<Record<SegmentTone, string>> = {
  success: "bg-success",
  progress: "bg-progress",
  info: "bg-info",
  muted: "bg-muted-foreground/45",
  model: "bg-info/40",
  empty: "bg-progress/15",
};

export const SEGMENT_STROKE: Readonly<Record<SegmentTone, string>> = {
  success: "stroke-success",
  progress: "stroke-progress",
  info: "stroke-info",
  muted: "stroke-muted-foreground/45",
  model: "stroke-info/40",
  empty: "stroke-progress/15",
};

interface LabelCounts {
  readonly accepted: number;
  readonly annotated: number;
  readonly review_pending: number;
  readonly skipped: number;
  readonly pre_labeled: number;
  readonly unannotated: number;
}

/** A batch's or a job's assets by annotation state, done first; empty states left out. */
export function labelSegments(counts: LabelCounts): readonly ProgressSegment[] {
  const all: ProgressSegment[] = [
    { key: "accepted", label: "Accepted", count: counts.accepted, tone: "success", done: true },
    { key: "annotated", label: "Annotated", count: counts.annotated, tone: "progress", done: true },
    { key: "review", label: "Waiting review", count: counts.review_pending, tone: "info", done: true },
    { key: "skipped", label: "Skipped", count: counts.skipped, tone: "muted", done: true },
    { key: "pre_labeled", label: "Drafted by a model", count: counts.pre_labeled, tone: "model", done: false },
    { key: "left", label: "Not started", count: counts.unannotated, tone: "empty", done: false },
  ];
  return all.filter((one) => one.count > 0);
}

/**
 * The share as a whole percent, rounded as `formatPercent` rounds — so a card
 * and the readout it came from agree — but never 100 while anything is left.
 */
export function percentDone(value: number, total: number, complete: boolean): number {
  if (total <= 0) return 0;
  const exact = Math.round((value / total) * 100);
  return complete ? exact : Math.min(99, exact);
}

/** The part of the whole a segment holds, from 0 to 1. */
export function segmentShare(segment: ProgressSegment, total: number): number {
  return total <= 0 ? 0 : segment.count / total;
}
