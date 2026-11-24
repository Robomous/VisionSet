/**
 * A clip: read it here, cut it here, decode it here, and send frames.
 *
 * ## Nothing about this file crosses the wire
 *
 * The server holds no decoder. A clip is therefore never uploaded, never probed
 * remotely and never "ingested whole" by a decoder on the server — the host's
 * materializer reads the container in this browser, and what travels is JPEG
 * frames. **There is no backend fallback, so nothing here offers one**: a
 * refusal is the end of the road for that file in this browser, and saying
 * otherwise would promise a path that does not exist.
 *
 * ## The report names what was found, not what was refused
 *
 * A file extension decides nothing here — `.mkv` says nothing about what is
 * inside it. (Getting *to* this flow is still a guess from the extension, by way
 * of `File.type`; `kindOf` says so where the guess is made.) So the card states
 * the container and codec the decoder actually read and whether *this* browser
 * can decode them, which is what makes a refusal specific enough to act on.
 *
 * ## The session is what makes a cancel safe
 *
 * Frames are staged against a session and become assets in one transaction at
 * commit, so a materialization that stops partway leaves an *uncommitted
 * import* rather than a batch silently short of a stretch of its clip. That is
 * what `Cancel` honours on both sides: abort the materializer so decoding
 * stops, and `DELETE` the session so the staged frames go with it. The hook
 * lives as long as the dialog's host — closing the dialog hides an import, it
 * does not stop it — and leaving the project unmounts the host, which is a
 * cancel by the same path: a run nobody can reach is a run nobody can cancel.
 *
 * The window closes at the commit, and that is why `Cancel` goes disabled
 * there: one transaction turns every staged frame into an asset, and aborting
 * its request would not roll it back.
 *
 * ## Where the frames actually go is not this package's business
 *
 * `VisionSetMediaRuntime.createFrameSink` answers that, and the materializer
 * calls `append` itself — the returned promise is its back-pressure ack, so a
 * slow sink stalls decoding rather than filling the heap.
 *
 * The pieces live beside it: what is derived (`clipDerived.ts`), what is read
 * from the file (`useClipSource.ts`), and the run itself (`useClipRun.ts`).
 */

import { useState } from "react";
import type { VideoInspection } from "@visionset/media";

import type { VisionSetMediaRuntime } from "../../media/port";
import type { ClipRange } from "../clipRanges";
import { DEFAULT_EXTRACTION_FPS, deriveClip } from "./clipDerived";
import { useClipRun, type ClipRun } from "./useClipRun";
import { useClipInspection, useClipUrl, useStableDecoder } from "./useClipSource";

export interface ClipImport extends ClipRun {
  readonly inspection: VideoInspection | null;
  /** The inspection itself throwing — not a refusal the decoder described, but the decoder failing to answer. */
  readonly unreadable: unknown;
  readonly fps: string;
  readonly setFps: (fps: string) => void;
  readonly ranges: readonly ClipRange[];
  readonly setRanges: (ranges: readonly ClipRange[]) => void;
  readonly scalePercent: number;
  readonly setScalePercent: (percent: number) => void;
  /** The preview player's source; null where the platform has no object URLs. */
  readonly clipUrl: string | null;
  readonly usableRate: boolean;
  readonly decodable: boolean;
  /** Seconds, sanitized: zero where the container carried none. */
  readonly duration: number;
  readonly expected: number;
  readonly importable: boolean;
}

export function useClipImport(
  projectId: string,
  runtime: VisionSetMediaRuntime | null,
  file: File | null,
): ClipImport {
  const decoder = useStableDecoder(runtime?.materializer ?? null);
  const { inspection, unreadable } = useClipInspection(file, decoder);
  const clipUrl = useClipUrl(file);
  const [fps, setFps] = useState(String(DEFAULT_EXTRACTION_FPS));
  const [ranges, setRanges] = useState<readonly ClipRange[]>([]);
  const [scalePercent, setScalePercent] = useState(100);

  // A new clip, or a new decoder reading it, starts from a clean selection —
  // adjusted during render against the pair last seen, not in an effect, so the
  // stale ranges never reach a render (react.dev: adjusting state when a prop
  // changes). The branch converges: it records the pair it reset for.
  const [seen, setSeen] = useState({ file, decoder });
  if (seen.file !== file || seen.decoder !== decoder) {
    setSeen({ file, decoder });
    setRanges([]);
    setScalePercent(100);
  }

  const derived = deriveClip(inspection, fps, ranges);
  const run = useClipRun({ projectId, runtime, decoder, file, inspection, derived, scalePercent });
  const { usableRate, decodable, duration, expected, importable } = derived;
  const runReset = run.reset;

  return {
    ...run,
    inspection,
    unreadable,
    fps,
    setFps,
    ranges,
    setRanges,
    scalePercent,
    setScalePercent,
    clipUrl,
    usableRate,
    decodable,
    duration,
    expected,
    importable,
    reset: () => {
      setFps(String(DEFAULT_EXTRACTION_FPS));
      setScalePercent(100);
      setRanges([]);
      runReset();
    },
  };
}
