/**
 * Video import sampling policy, versioned so a future change to it stays legible.
 * The policy itself is written down in `docs/content/architecture/frontend/media.md`;
 * bump this whenever the grid, clamp or scale arithmetic below changes shape.
 */
export const SAMPLING_POLICY_VERSION = 1;

/** Clip-relative seconds, half-open `[startSeconds, endSeconds)`. */
export interface TimeRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/**
 * The one spelling of a range selection, ported from the kernel's
 * `canonical_ranges` (`src/visionset/kernel/domain/source.py`) so identity can
 * compare it on both sides of the wire.
 *
 * Clamps each end to `durationSeconds`, drops what that clamp emptied, sorts by
 * start, and merges overlapping *and adjacent* ranges — "0-3 plus 3-5" and "0-5"
 * are the same selection. A selection covering the whole clip canonicalizes to
 * `[]`, so "whole clip" has exactly one identity spelling: the one a caller who
 * selected nothing already has. Start is deliberately left unclamped, matching
 * the kernel exactly — `TimeRange` construction is where a negative start is
 * rejected, not this function.
 */
export function canonicalRanges(
  ranges: readonly TimeRange[],
  durationSeconds: number,
): TimeRange[] {
  const clamped = ranges
    .filter((range) => range.startSeconds < durationSeconds)
    .map((range) => ({
      startSeconds: range.startSeconds,
      endSeconds: Math.min(range.endSeconds, durationSeconds),
    }))
    .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);

  const merged: TimeRange[] = [];
  for (const range of clamped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.startSeconds <= last.endSeconds) {
      merged[merged.length - 1] = {
        startSeconds: last.startSeconds,
        endSeconds: Math.max(last.endSeconds, range.endSeconds),
      };
    } else {
      merged.push(range);
    }
  }
  if (merged.length === 1 && merged[0].startSeconds === 0 && merged[0].endSeconds === durationSeconds) {
    return [];
  }
  return merged;
}

/**
 * Each range as `[a, b)` in grid indices: `ceil(start*fps), ceil(end*fps)`.
 * Ported from `grid_bounds`. The same numbers drive extraction and the expected
 * count, which is what keeps the estimate and the emitted frames from disagreeing.
 */
export function gridBounds(ranges: readonly TimeRange[], fps: number): [number, number][] {
  return ranges.map((range) => [Math.ceil(range.startSeconds * fps), Math.ceil(range.endSeconds * fps)]);
}

/**
 * How many grid points the selection holds — exactly what extraction emits.
 * Ported from `expected_frames`. An empty selection is the whole clip,
 * `ceil(durationSeconds*fps)`; the grid includes `t = 0`, which is what a
 * `floor` estimate would miss by one on every fractional product.
 */
export function expectedFrames(
  ranges: readonly TimeRange[],
  durationSeconds: number,
  fps: number,
): number {
  const bounds = gridBounds(ranges, fps);
  if (bounds.length === 0) {
    return Math.ceil(durationSeconds * fps);
  }
  return bounds.reduce((sum, [start, end]) => sum + (end - start), 0);
}

/**
 * The clip-relative grid timestamps (`i / fps`) for every selected index `i`,
 * ascending. A generator so the per-range bounds arithmetic is written once rather
 * than repeated by every caller — not for laziness: the materializer collects it
 * into an array, because it needs the length up front and the timestamp at a given
 * position. No Python counterpart; this is what the materializer walks.
 */
export function* gridTimestamps(
  ranges: readonly TimeRange[],
  durationSeconds: number,
  fps: number,
): Iterable<number> {
  const bounds = ranges.length === 0 ? [[0, Math.ceil(durationSeconds * fps)] as [number, number]] : gridBounds(ranges, fps);
  for (const [start, end] of bounds) {
    for (let index = start; index < end; index++) {
      yield index / fps;
    }
  }
}

/**
 * One axis after a percent downscale — integer half-up, floored at one. Ported
 * from `scaled_dimension`. Integer arithmetic on purpose: Python's `round` is
 * half-even (`round(2.5) === 2`) and would silently under-scale a tie; the one
 * spelling both sides share instead is `floor((native*percent + 50) / 100)`.
 */
export function scaledDimension(native: number, percent: number): number {
  return Math.max(1, Math.floor((native * percent + 50) / 100));
}

/**
 * The `Blob` surface this package needs, declared structurally.
 *
 * Neither ambient spelling fits this boundary: core compiles without a browser lib
 * (see tsconfig.json), and `node:buffer`'s `Blob` is *not* assignable to the DOM one —
 * their `stream()` readers disagree about `ArrayBufferView` — so a browser adapter
 * could not implement `VideoMaterializer` against it. A real DOM `Blob` satisfies this.
 */
export interface BlobLike {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number, contentType?: string): BlobLike;
  text(): Promise<string>;
}

/** The `File` surface the materializer takes: a `BlobLike` that knows its name. */
export interface FileLike extends BlobLike {
  readonly name: string;
  readonly lastModified: number;
}

/** Why a materializer could not produce frames for a file, an exhaustive union. */
export type VideoRefusal =
  | "no-video-track"
  | "unparsable-container"
  | "undecodable-codec"
  | "unsupported-browser";

/**
 * Structural subset of the DOM `AbortSignal` — declared locally rather than
 * pulled from `lib.dom`, which core never includes. A real `AbortSignal`
 * satisfies this shape, so adapters pass their own straight through.
 */
export interface AbortSignal {
  readonly aborted: boolean;
}

export interface VideoInspection {
  readonly fileName: string;
  readonly container: string;
  readonly codec: string;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly durationSeconds: number;
  readonly sourceFps: number | null;
  readonly decodable: boolean;
  readonly refusal?: VideoRefusal;
}

export interface VideoSelection {
  readonly extractionFps: number;
  readonly ranges: readonly TimeRange[];
  readonly scalePercent: number;
}

export interface MaterializedFrame {
  readonly ordinal: number;
  readonly requestedTimestamp: number;
  readonly sourceTimestamp: number | null;
  readonly width: number;
  readonly height: number;
  readonly format: "png";
  readonly bytes: BlobLike;
}

/** Where materialized frames go. `append` is also the backpressure point: a
 * materializer must not decode past what its caller has room to accept. */
export interface FrameSink {
  append(frames: readonly MaterializedFrame[], signal?: AbortSignal): Promise<void>;
}

export interface VideoImportProgress {
  readonly materialized: number;
  readonly expected: number;
}

export interface VideoImportResult {
  readonly materialized: number;
  readonly expected: number;
  /** Grid ordinals with no sample — requested past the last frame, not faked. */
  readonly skipped: number[];
}

export interface VideoMaterializer {
  /**
   * What to record as the provenance of the frames this produces — a decoder
   * and its exact version, `"mediabunny/1.56.1"` and the like.
   *
   * Frame bytes are not reproducible across decoders, so a source states what
   * drew its frames rather than promising anybody can redraw them. It is on the
   * port because the only thing that knows the answer is the implementation: a
   * caller that typed the string itself would be describing a materializer it
   * does not own, and would go on saying so after the host swapped one in.
   */
  readonly name: string;
  inspect(file: FileLike, signal?: AbortSignal): Promise<VideoInspection>;
  materialize(
    file: FileLike,
    selection: VideoSelection,
    sink: FrameSink,
    opts?: { signal?: AbortSignal; onProgress?(progress: VideoImportProgress): void },
  ): Promise<VideoImportResult>;
}

/**
 * The bounded chunk a materializer pushes per `FrameSink.append` call, and the
 * unit backpressure is measured in: decoding waits for the sink to ack one
 * chunk before producing the next, so a slow upload stalls the decoder rather
 * than filling the heap.
 */
export const FRAME_CHUNK_SIZE = 8;
