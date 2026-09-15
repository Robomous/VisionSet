/**
 * Clip ranges, over `@visionset/media`'s shared arithmetic — itself mirrored from
 * the kernel (`kernel/domain/source.py`). This module is the wire-shaped
 * (`ClipRange`, snake_case seconds) adapter over that one TypeScript spelling; the
 * arithmetic lives in `@visionset/media` and is not re-derived here.
 */

import { canonicalRanges, expectedFrames as sharedExpectedFrames, type TimeRange } from "@visionset/media";

import type { components } from "../generated/api";

export type ClipRange = components["schemas"]["ClipRange"];

function toTimeRange(range: ClipRange): TimeRange {
  return { startSeconds: range.start_seconds, endSeconds: range.end_seconds };
}

function toClipRange(range: TimeRange): ClipRange {
  return { start_seconds: range.startSeconds, end_seconds: range.endSeconds };
}

/**
 * Clamp to the clip, sort, merge overlaps and touches; a full cover is `[]`.
 *
 * `@visionset/media`'s `TimeRange` carries the kernel's own invariant (start ≥ 0,
 * end > start) enforced at construction — `canonicalRanges` assumes it holds and
 * does not re-check it. `ClipRangeTimeline` hands over ranges mid-drag, before a
 * dragged handle has settled into a valid `ClipRange`, so this adapter clamps a
 * negative start and drops what a snap left empty *before* calling the shared
 * function — the one piece of behaviour that is this caller's, not the kernel's.
 */
export function mergedRanges(
  ranges: readonly ClipRange[],
  durationSeconds: number,
): readonly ClipRange[] {
  const settled = ranges
    .map((one) => ({ start_seconds: Math.max(0, one.start_seconds), end_seconds: one.end_seconds }))
    .filter((one) => one.end_seconds > one.start_seconds);
  return canonicalRanges(settled.map(toTimeRange), durationSeconds).map(toClipRange);
}

/** Grid points inside the selection — exactly what extraction will emit. */
export function expectedFrames(
  ranges: readonly ClipRange[],
  durationSeconds: number,
  fps: number,
): number {
  return sharedExpectedFrames(ranges.map(toTimeRange), durationSeconds, fps);
}

/** Seconds an already-merged selection covers; the whole clip when empty. */
export function selectedSeconds(ranges: readonly ClipRange[], durationSeconds: number): number {
  if (ranges.length === 0) return durationSeconds;
  return ranges.reduce((sum, one) => sum + (one.end_seconds - one.start_seconds), 0);
}

/** The one sentence for a selection: "Whole clip", or its merged spans and length. */
export function selectionSummary(ranges: readonly ClipRange[], durationSeconds: number): string {
  const merged = mergedRanges(ranges, durationSeconds);
  if (merged.length === 0) return "Whole clip";
  const spans = merged
    .map((one) => `${clock(one.start_seconds)}–${clock(one.end_seconds)}`)
    .join(", ");
  return `${spans} · ${clock(selectedSeconds(merged, durationSeconds))}`;
}

/** `m:ss`, tenths kept only when they exist: 75 → "1:15", 7.5 → "0:07.5". */
export function clock(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = tenths - minutes * 600;
  const whole = Math.floor(rest / 10);
  const fraction = rest % 10;
  const padded = String(whole).padStart(2, "0");
  return fraction === 0 ? `${minutes}:${padded}` : `${minutes}:${padded}.${fraction}`;
}

/** The same selection in `@visionset/media`'s own vocabulary, for a materializer. */
export function toTimeRanges(ranges: readonly ClipRange[]): TimeRange[] {
  return ranges.map(toTimeRange);
}
