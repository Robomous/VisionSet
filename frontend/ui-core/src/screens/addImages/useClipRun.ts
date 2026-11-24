/** A clip import's run: stage frames against a session, then commit or take them back. */

import { useEffect, useRef, useState } from "react";
import type { VideoImportProgress, VideoInspection, VideoMaterializer } from "@visionset/media";

import type { VisionSetMediaRuntime } from "../../media/port";
import { toTimeRanges } from "../clipRanges";
import { useAbortVideoImport, useCommitVideoImport, useStartVideoImport, type Batch } from "../queries";
import { startRequest, type ClipDerived } from "./clipDerived";
import type { Target } from "./intoTarget";

export interface ClipRunInputs {
  readonly projectId: string;
  readonly runtime: VisionSetMediaRuntime | null;
  readonly decoder: VideoMaterializer | null;
  readonly file: File | null;
  readonly inspection: VideoInspection | null;
  readonly derived: ClipDerived;
  readonly scalePercent: number;
}

export interface ClipRun {
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
  /** No run, no outcome. The import itself is untouched. */
  readonly reset: () => void;
}

export function useClipRun(inputs: ClipRunInputs): ClipRun {
  const { projectId, runtime, decoder, file, inspection, derived, scalePercent } = inputs;
  const [progress, setProgress] = useState<VideoImportProgress | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [cancelled, setCancelled] = useState(false);
  const running = useRef<AbortController | null>(null);
  const [inFlight, setInFlight] = useState(false);

  const start = useStartVideoImport(projectId);
  const commit = useCommitVideoImport(projectId);
  const abort = useAbortVideoImport();

  // Unmounting the host is a cancel. Aborting the controller is the whole fix,
  // because an aborted signal is already the path `run` answers by deleting the
  // session. A commit already in flight is past that door and still lands.
  useEffect(() => () => running.current?.abort(), []);

  async function materialize(target: Target): Promise<void> {
    if (file === null || decoder === null || runtime === null || inspection === null || !derived.importable || inFlight) return;
    const controller = new AbortController();
    running.current = controller;
    setFailure(null);
    setCancelled(false);
    setInFlight(true);
    setProgress({ materialized: 0, expected: derived.expected });
    let session: string | null = null;
    // Which half is in flight. A refused commit renders from `commit.isError`,
    // so the catch below must not restate it as a second alert.
    let committing = false;
    try {
      const opened = await start.mutateAsync(startRequest(file, inspection, derived, { scalePercent, decoderName: decoder.name, target }));
      session = opened.id;
      await decoder.materialize(
        file,
        { extractionFps: derived.rate, ranges: toTimeRanges(derived.merged), scalePercent },
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
