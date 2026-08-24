/**
 * Clip ranges, mirrored from the kernel: the canonical form and the one count.
 *
 * The kernel's `canonical_ranges` and `expected_frames` (kernel/domain/source.py)
 * decide identity and what extraction emits; these are their TypeScript
 * spellings, for the advisory numbers the screen shows before the server has
 * answered. Ranges are half-open [start, end) on the t = 0 grid and the count is
 * `ceil` per bound — the grid includes t = 0, which the old `floor` estimate
 * missed by one on every fractional product. Change either side of the mirror
 * only together with the other.
 */

import type { components } from "../generated/api";

export type ClipRange = components["schemas"]["ClipRange"];

/** Clamp to the clip, sort, merge overlaps and touches; a full cover is `[]`. */
export function mergedRanges(
  ranges: readonly ClipRange[],
  durationSeconds: number,
): readonly ClipRange[] {
  const clamped = ranges
    .filter((one) => one.start_seconds < durationSeconds && one.end_seconds > one.start_seconds)
    .map((one) => ({
      start_seconds: Math.max(0, one.start_seconds),
      end_seconds: Math.min(one.end_seconds, durationSeconds),
    }))
    .sort((a, b) => a.start_seconds - b.start_seconds || a.end_seconds - b.end_seconds);
  const merged: { start_seconds: number; end_seconds: number }[] = [];
  for (const one of clamped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && one.start_seconds <= last.end_seconds) {
      last.end_seconds = Math.max(last.end_seconds, one.end_seconds);
    } else {
      merged.push({ ...one });
    }
  }
  if (
    merged.length === 1 &&
    merged[0].start_seconds === 0 &&
    merged[0].end_seconds === durationSeconds
  ) {
    return [];
  }
  return merged;
}

/** Grid points inside the selection — exactly what extraction will emit. */
export function expectedFrames(
  ranges: readonly ClipRange[],
  durationSeconds: number,
  fps: number,
): number {
  if (ranges.length === 0) return Math.ceil(durationSeconds * fps);
  let count = 0;
  for (const one of ranges) {
    count += Math.ceil(one.end_seconds * fps) - Math.ceil(one.start_seconds * fps);
  }
  return count;
}

/** Seconds an already-merged selection covers; the whole clip when empty. */
export function selectedSeconds(ranges: readonly ClipRange[], durationSeconds: number): number {
  if (ranges.length === 0) return durationSeconds;
  return ranges.reduce((sum, one) => sum + (one.end_seconds - one.start_seconds), 0);
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
