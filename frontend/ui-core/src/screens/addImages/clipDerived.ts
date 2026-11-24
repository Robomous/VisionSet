/** What a clip import knows without asking anyone: derived from the inspection and the settings. */

import type { VideoInspection } from "@visionset/media";

import { ApiError } from "../../data/errors";
import { refusalProse } from "../../data/refusals";
import { expectedFrames, mergedRanges, type ClipRange } from "../clipRanges";
import type { VideoImportStart } from "../queries";
import { NEW_BATCH, type Target } from "./intoTarget";

/**
 * What went wrong, when the thing that went wrong may not be the server.
 *
 * A `FrameSink` that was refused throws an `ApiError`, and that goes through
 * the product's one code→prose vocabulary. A **decoder** that died throws
 * whatever the host's materializer throws, and `refusalProse` reads an
 * unrecognised throw as `NETWORK_ERROR` — which would tell somebody whose codec
 * blew up to check their connection. So a non-`ApiError` keeps its own sentence.
 */
export function decodeProse(cause: unknown): string {
  if (cause instanceof ApiError) return refusalProse(cause);
  return `The decoder stopped: ${cause instanceof Error ? cause.message : String(cause)}`;
}

/** The kernel's own default. One frame per second. */
export const DEFAULT_EXTRACTION_FPS = 1;

export interface ClipDerived {
  /** The typed rate as a number; NaN while it is not one. */
  readonly rate: number;
  readonly usableRate: boolean;
  readonly decodable: boolean;
  /** Seconds, sanitized: zero where the container carried none. */
  readonly duration: number;
  /** The selection in canonical form: sorted, overlaps joined. */
  readonly merged: readonly ClipRange[];
  readonly expected: number;
  readonly importable: boolean;
}

export function deriveClip(inspection: VideoInspection | null, fps: string, ranges: readonly ClipRange[]): ClipDerived {
  const rate = Number(fps);
  // Every comparison with NaN is false, so `<= 0` alone would wave a NaN through
  // and open a session at `extraction_fps=NaN`.
  const usableRate = Number.isFinite(rate) && rate > 0;
  const decodable = inspection !== null && inspection.decodable;
  // A container a decoder parses but cannot time answers `NaN`; zero is the
  // honest reading — no duration is known, so no frame count is either.
  const duration = inspection !== null && Number.isFinite(inspection.durationSeconds) ? inspection.durationSeconds : 0;
  const merged = decodable ? mergedRanges(ranges, duration) : [];
  const expected = decodable && usableRate ? expectedFrames(merged, duration, rate) : 0;
  // `expected > 0` and never `expected !== 0`: the NaN a bad duration produces
  // would pass a `!== 0` gate and post `duration_seconds: null` for a raw 422.
  const importable = decodable && usableRate && expected > 0;
  return { rate, usableRate, decodable, duration, merged, expected, importable };
}

/** The batch a clip's frames land in: the chosen one, a named new one, or the server's own default. */
function batchOf(target: Target): { readonly batch_id: string } | { readonly batch_name: string } | Record<string, never> {
  if (target.choice !== NEW_BATCH) return { batch_id: target.choice };
  return target.name.trim() === "" ? {} : { batch_name: target.name.trim() };
}

/** The request that opens the session the frames are staged against. */
export function startRequest(
  file: File,
  inspection: VideoInspection,
  derived: ClipDerived,
  settings: { readonly scalePercent: number; readonly decoderName: string; readonly target: Target },
): VideoImportStart {
  return {
    display_name: file.name,
    metadata: {
      width: inspection.displayWidth,
      height: inspection.displayHeight,
      // The rate the clip was *shot* at, straight through — `null` for a
      // variable-rate clip. Never `rate`: that is the rate it is being cut at.
      fps: inspection.sourceFps,
      duration_seconds: inspection.durationSeconds,
      codec: inspection.codec,
    },
    extraction_fps: derived.rate,
    // Canonical, not raw: an overlapping pair would decode the overlap twice
    // and disagree with the count the server computed from the same selection.
    ranges: [...derived.merged],
    scale_percent: settings.scalePercent,
    // What drew these frames, from the materializer itself.
    materializer: settings.decoderName,
    ...batchOf(settings.target),
  };
}
