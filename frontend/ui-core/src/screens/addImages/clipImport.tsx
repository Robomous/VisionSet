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
 */

import { useEffect, useId, useRef, useState, type JSX } from "react";
import type { VideoImportProgress, VideoInspection, VideoRefusal } from "@visionset/media";

import { Alert, AlertDescription, AlertTitle, Badge, Input, Label } from "@robomous/ui-core";
import { ApiError } from "../../data/errors";
import { refusalProse } from "../../data/refusals";
import type { VisionSetMediaRuntime } from "../../media/port";
import { expectedFrames, mergedRanges, toTimeRanges, type ClipRange } from "../clipRanges";
import { useAbortVideoImport, useCommitVideoImport, useStartVideoImport, type Batch } from "../queries";
import { NEW_BATCH, type Target } from "./IntoField";

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
const DEFAULT_EXTRACTION_FPS = 1;

export interface ClipImport {
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
  readonly progress: VideoImportProgress | null;
  readonly batch: Batch | null;
  /** The materialization's own failure: a decoder that died, or a sink whose upload was refused. */
  readonly failure: unknown;
  readonly cancelled: boolean;
  readonly inFlight: boolean;
  /** Anything has happened past the settings: a run, its outcome, its cancel, its failure. */
  readonly started: boolean;
  readonly commit: ReturnType<typeof useCommitVideoImport>;
  readonly abort: ReturnType<typeof useAbortVideoImport>;
  readonly start: ReturnType<typeof useStartVideoImport>;
  readonly run: (target: Target) => void;
  readonly cancel: () => void;
  /** Back to the settings' defaults, and no run. The import itself is untouched. */
  readonly reset: () => void;
}

export function useClipImport(
  projectId: string,
  runtime: VisionSetMediaRuntime | null,
  file: File | null,
): ClipImport {
  /**
   * The decoder this flow keeps — identified by its name, not by its address.
   *
   * A host that builds its runtime inline hands a fresh materializer on every
   * render, and an effect keyed on the object would re-inspect for each one: a
   * worker spawned and torn down, and the ranges and the scale the person just
   * chose thrown away. `name` is the decoder and its exact version, which is the
   * only thing that can change what `inspect` answers.
   */
  const materializer = runtime?.materializer ?? null;
  const [decoder, setDecoder] = useState(materializer);
  if (decoder?.name !== materializer?.name) setDecoder(materializer);
  const [inspection, setInspection] = useState<VideoInspection | null>(null);
  const [unreadable, setUnreadable] = useState<unknown>(null);
  const [fps, setFps] = useState(String(DEFAULT_EXTRACTION_FPS));
  const [ranges, setRanges] = useState<readonly ClipRange[]>([]);
  const [scalePercent, setScalePercent] = useState(100);
  const [clipUrl, setClipUrl] = useState<string | null>(null);

  const [progress, setProgress] = useState<VideoImportProgress | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [cancelled, setCancelled] = useState(false);
  const running = useRef<AbortController | null>(null);
  const [inFlight, setInFlight] = useState(false);

  const start = useStartVideoImport(projectId);
  const commit = useCommitVideoImport(projectId);
  const abort = useAbortVideoImport();

  // Ask the host's decoder what this file is. The stale flag is the whole
  // cancellation story: an answer that arrives after the selection changed must
  // not describe the previous file.
  useEffect(() => {
    setInspection(null);
    setUnreadable(null);
    setRanges([]);
    setScalePercent(100);
    if (file === null || decoder === null) return;
    let stale = false;
    const controller = new AbortController();
    void decoder.inspect(file, controller.signal).then(
      (found) => {
        if (!stale) setInspection(found);
      },
      (error: unknown) => {
        if (!stale) setUnreadable(error);
      },
    );
    return () => {
      stale = true;
      controller.abort();
    };
  }, [file, decoder]);

  // Unmounting the host is a cancel. Aborting the controller is the whole fix,
  // because an aborted signal is already the path `run` answers by deleting the
  // session. A commit already in flight is past that door and still lands.
  useEffect(() => () => running.current?.abort(), []);

  // The preview player's source. Null where the platform has no object URLs
  // (jsdom), so the timeline renders no player.
  useEffect(() => {
    if (file === null || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(file);
    setClipUrl(url);
    return () => {
      setClipUrl(null);
      URL.revokeObjectURL(url);
    };
  }, [file]);

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

  async function materialize(target: Target): Promise<void> {
    if (file === null || decoder === null || runtime === null || inspection === null || !importable || inFlight) return;
    const controller = new AbortController();
    running.current = controller;
    setFailure(null);
    setCancelled(false);
    setInFlight(true);
    setProgress({ materialized: 0, expected });
    let session: string | null = null;
    // Which half is in flight. A refused commit renders from `commit.isError`,
    // so the catch below must not restate it as a second alert.
    let committing = false;
    try {
      const opened = await start.mutateAsync({
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
        extraction_fps: rate,
        // Canonical, not raw: an overlapping pair would decode the overlap twice
        // and disagree with the count the server computed from the same selection.
        ranges: [...merged],
        scale_percent: scalePercent,
        // What drew these frames, from the materializer itself.
        materializer: decoder.name,
        ...(target.choice !== NEW_BATCH
          ? { batch_id: target.choice }
          : target.name.trim() === ""
            ? {}
            : { batch_name: target.name.trim() }),
      });
      session = opened.id;
      await decoder.materialize(
        file,
        { extractionFps: rate, ranges: toTimeRanges(merged), scalePercent },
        runtime.createFrameSink({ projectId, importId: opened.id }),
        { signal: controller.signal, onProgress: setProgress },
      );
      // A cancelled materialization *resolves* with what got through.
      // Committing it would hand somebody a batch they asked to throw away.
      if (controller.signal.aborted) {
        setCancelled(true);
        abort.mutate(opened.id);
        return;
      }
      committing = true;
      setBatch(await commit.mutateAsync(opened.id));
    } catch (error) {
      if (!committing) setFailure(error);
      // Nothing staged is in the project, so the remedy for any failure is to
      // take the session with it rather than leave bytes nobody will claim.
      if (session !== null) abort.mutate(session);
    } finally {
      setInFlight(false);
      running.current = null;
    }
  }

  const startReset = start.reset;
  const commitReset = commit.reset;
  const abortReset = abort.reset;

  return {
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
    progress,
    batch,
    failure,
    cancelled,
    inFlight,
    started: inFlight || progress !== null || batch !== null || cancelled || failure !== null || commit.isError,
    commit,
    abort,
    start,
    run: (target) => void materialize(target),
    cancel: () => running.current?.abort(),
    reset: () => {
      setFps(String(DEFAULT_EXTRACTION_FPS));
      setScalePercent(100);
      setRanges([]);
      setProgress(null);
      setBatch(null);
      setFailure(null);
      setCancelled(false);
      startReset();
      commitReset();
      abortReset();
    },
  };
}

/**
 * What the decoder found, before anything is decided — the facts the container
 * carries. "Can this browser decode it" is a property of the pair, never of
 * the suffix.
 */
export function ClipFacts({ inspection }: { readonly inspection: VideoInspection }): JSX.Element {
  const facts = [
    inspection.container === "" ? "container unreadable" : inspection.container,
    inspection.codec === "" ? "codec unreadable" : inspection.codec,
    inspection.sourceFps === null ? "variable rate" : `${inspection.sourceFps.toFixed(2)} fps`,
    ...(inspection.rotation === 0 ? [] : [`rotated ${inspection.rotation}°`]),
  ];
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="clip-report">
      <span className="text-muted-foreground tabular-nums">{facts.join(" · ")}</span>
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground">This browser</span>
        <Badge variant={inspection.decodable ? "success" : "destructive"} data-testid="clip-decodable">
          {inspection.decodable ? "can decode it" : "cannot decode it"}
        </Badge>
      </span>
    </span>
  );
}

/**
 * One member of `VideoRefusal`, in the words a person can act on.
 *
 * Exhaustive by construction, and every branch names a remedy that exists.
 * **None of them is "the server will do it instead".**
 */
function refusalNotice(refusal: VideoRefusal, inspection: VideoInspection): { readonly title: string; readonly body: string } {
  switch (refusal) {
    case "no-video-track":
      return {
        title: "This file has no video track",
        body: "The container read fine, but nothing inside it is video — an audio-only recording, or a file that only looks like a clip. Choose one with a picture in it.",
      };
    case "unparsable-container":
      return {
        title: "This file's container could not be parsed",
        body: "There is no track to decode, because nothing here could read the file's structure at all: it is damaged, or it is not the format its name claims. Try a different copy.",
      };
    case "undecodable-codec":
      return {
        title: `This browser cannot decode ${inspection.codec === "" ? "this codec" : inspection.codec}`,
        body: "The clip itself read fine — container, size and duration are above — but this browser's decoder does not handle that codec. Another browser may; re-encoding the clip to H.264 will.",
      };
    case "unsupported-browser":
      return {
        title: "This browser has no video decoder to offer",
        body: "Importing a clip needs WebCodecs, an OffscreenCanvas and a module worker, and at least one of the three is missing here — a browser too old for them, or a page served outside a secure context. Open VisionSet over https or on localhost in a current browser.",
      };
    default: {
      const exhaustive: never = refusal;
      return exhaustive;
    }
  }
}

export function ClipRefusal({ refusal, inspection }: { readonly refusal: VideoRefusal; readonly inspection: VideoInspection }): JSX.Element {
  const notice = refusalNotice(refusal, inspection);
  return (
    <Alert variant="destructive" data-testid="clip-refusal" data-refusal={refusal}>
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription className="text-pretty">{notice.body}</AlertDescription>
    </Alert>
  );
}

/**
 * The rate the grid is walked at — typed, because it is any positive number and
 * the clip's own rate is on the card above it. The value stays a string so a
 * half-typed one ("0.") is not snapped back under the cursor; the flow reads it
 * as a number and withholds the import until it is a positive one.
 */
export function RateField({ fps, onFps, usable }: { readonly fps: string; readonly onFps: (value: string) => void; readonly usable: boolean }): JSX.Element {
  const id = useId();
  const hint = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Frames per second</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          data-testid="extraction-fps"
          type="number"
          inputMode="decimal"
          min="0.1"
          step="0.1"
          className="w-24 tabular-nums"
          aria-invalid={!usable || undefined}
          aria-describedby={hint}
          value={fps}
          onChange={(event) => onFps(event.target.value)}
        />
        <span className="text-xs text-muted-foreground">fps</span>
      </div>
      <p id={hint} className="text-xs text-pretty text-muted-foreground">
        {usable ? "How many frames each second of the selection is cut into." : "A positive number — 0.5 is one frame every two seconds."}
      </p>
    </div>
  );
}
