/**
 * Add images' state, apart from how it is drawn: what was chosen, what it is,
 * how far the source and the run have got, and the approval at the end.
 *
 * ## The kind is derived from the files, never from a mode switch
 *
 * A mode switch is a second place the same fact lives, and the two can
 * disagree. So one dropzone takes all three: scans are routed first, by
 * extension (a drop mixing scans with other files is refused); otherwise a
 * single file the browser reports as video is a clip; otherwise the drop is
 * images, including a directory that happens to contain a clip.
 *
 * `File.type` is a guess the browser makes from the extension, not from the
 * bytes — a container it has no mapping for arrives as `""` and is routed here
 * as images, which the server then refuses by format. That is the honest
 * description of this line, and it stays a guess on purpose: the decoder that
 * could settle it is the clip's, and there is no way back out of that flow for
 * a file that turned out to be an image.
 *
 * ## No media runtime, no clip
 *
 * `useMediaRuntime()` answers `null` where the host offers no browser video
 * import, and a video file is then images like any other file — the dialog
 * never mentions video at all. There is no server-side decoder to offer
 * instead: it was deleted, not moved.
 *
 * ## The step is derived, never stored
 *
 * Which step the flow has *reached* is read off the data — a run (or an
 * import) is step 3, a registered source (or a read clip somebody chose to cut)
 * is step 2, otherwise step 1 — so it cannot disagree with what happened. The
 * step *shown* is the reached one unless somebody walked back to an earlier
 * one; a run in flight is a row on the server that cannot be un-launched, so
 * once it exists there is no walking back.
 *
 * ## It outlives the dialog
 *
 * The host keeps this mounted while the dialog is closed, so closing hides the
 * flow rather than discarding it: a run keeps polling (and refreshes the batch
 * table when it lands), a clip keeps decoding, and Add images reopens on it.
 * Once the flow has settled — a batch made, an import cancelled — closing
 * starts the next one over.
 */

import { useState } from "react";

import type { components } from "../../generated/api";
import { useMediaRuntime } from "../../media/VisionSetMediaProvider";
import { useApproveForm, type ApproveForm } from "../approveForm";
import { useBatch, useRegisterPointCloudSource, useRegisterSource, type Batch, type Source } from "../queries";
import { useClipImport, type ClipImport } from "./useClipImport";
import { approvedLine, filledBatch, isInFlight, kindOf, reachedStep, shownStep, sourceNamed, suggestionFor, uploadable, type AddKind, type Landed, type StepIndex } from "./flowRules";
import { useLanded } from "./useLanded";
import { useIngestRun, type IngestRun } from "./ingestRun";
import { NEW_TARGET, type Target } from "./intoTarget";

export type { AddKind, Landed, StepIndex };
type ScanFrame = components["schemas"]["ScanFrame"];

export interface AddImagesFlow {
  readonly projectId: string;
  readonly files: readonly File[];
  /** Bumped by every reset, and the file inputs' key: a picker asked for the same file again may report no change. */
  readonly attempt: number;
  readonly choose: (files: readonly File[]) => void;
  readonly clear: () => void;
  readonly kind: AddKind;
  readonly canDecode: boolean;
  readonly sourceName: string;
  readonly setSourceName: (name: string) => void;
  /** What the source is called unless somebody types otherwise: the first file's stem. */
  readonly suggestedName: string;
  readonly frame: ScanFrame | null;
  readonly setFrame: (frame: ScanFrame) => void;
  readonly register: ReturnType<typeof useRegisterSource> | ReturnType<typeof useRegisterPointCloudSource>;
  readonly source: Source | null;
  readonly upload: () => void;
  readonly canUpload: boolean;
  readonly clip: ClipImport;
  /** Somebody chose to cut the read clip — the clip's step 1 → 2. */
  readonly cutting: boolean;
  readonly cut: () => void;
  readonly target: Target;
  readonly setTarget: (target: Target) => void;
  readonly run: IngestRun;
  readonly launch: () => void;
  /** Back to step 2 with the same source, for a run into another batch. */
  readonly rerun: () => void;
  /** The batch the settled flow filled, when there is one. */
  readonly batchId: string | null;
  readonly batchName: string | null;
  readonly batch: Batch | null;
  readonly approving: boolean;
  readonly setApproving: (approving: boolean) => void;
  readonly approval: ApproveForm;
  /** The approval's own line once it settled: what was pinned, how it was cut, whether it is open. */
  readonly approved: string | null;
  readonly approve: () => void;
  readonly landed: readonly Landed[];
  /** Nothing is in flight and the flow reached its end — a batch, or a run or import that will not go further. */
  readonly settled: boolean;
  readonly busy: boolean;
  readonly reached: StepIndex;
  readonly shown: StepIndex;
  readonly direction: 1 | -1;
  readonly go: (step: StepIndex | null) => void;
  /** Start over: every choice resets, the batches made this session are kept. */
  readonly another: () => void;
  /** Start over and forget the session too — the dialog closing on a settled flow. */
  readonly restart: () => void;
}

export function useAddImagesFlow(projectId: string): AddImagesFlow {
  const media = useMediaRuntime();
  const canDecode = media !== null;
  const [files, setFiles] = useState<readonly File[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [sourceName, setSourceName] = useState("");
  const [frame, setFrameRaw] = useState<ScanFrame | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [cutting, setCutting] = useState(false);
  const [target, setTarget] = useState<Target>(NEW_TARGET);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState<string | null>(null);
  const [at, setAt] = useState<StepIndex | null>(null);
  const [direction, setDirection] = useState<1 | -1>(1);

  const registerImages = useRegisterSource(projectId);
  const registerScans = useRegisterPointCloudSource(projectId);
  const run = useIngestRun(projectId);
  const kind = kindOf(files, canDecode);
  const clip = useClipImport(projectId, media, kind === "video" ? files[0] : null);
  const register = kind === "scans" ? registerScans : registerImages;

  const suggestedName = suggestionFor(files);

  const { batchId, batchName } = filledBatch(kind, clip, run);
  const batch = useBatch(batchId ?? "", batchId !== null);
  const approval = useApproveForm(approving ? (batch.data ?? null) : null);
  const resetApproval = approval.reset;
  const { landed, forget } = useLanded(batchId, batchName);

  const reached = reachedStep(kind, clip, cutting, run, source);
  const shown = shownStep(at, reached);

  const inFlight = isInFlight(kind, clip, run);
  const busy = inFlight || register.isPending || run.start.isPending || approval.busy;
  const settled = reached === 2 && !inFlight;

  function go(step: StepIndex | null): void {
    const next = step ?? reached;
    setDirection(next < shown ? -1 : 1);
    setAt(step);
  }

  function resetChoices(): void {
    setFiles([]);
    setAttempt((was) => was + 1);
    setSourceName("");
    setFrameRaw(null);
    setSource(null);
    setCutting(false);
    setTarget(NEW_TARGET);
    setApproving(false);
    setApproved(null);
    setAt(null);
    setDirection(1);
    registerImages.reset();
    registerScans.reset();
    run.reset();
    clip.reset();
  }

  const canUpload = uploadable(kind, frame) && !register.isPending && source === null;

  return {
    projectId,
    files,
    attempt,
    choose: (next) => {
      // A new selection is a new question: nothing decided for the old one carries over.
      setFiles(next);
      setSourceName("");
      setFrameRaw(null);
      setCutting(false);
      registerImages.reset();
      registerScans.reset();
    },
    clear: resetChoices,
    kind,
    canDecode,
    sourceName,
    setSourceName,
    suggestedName,
    frame,
    setFrame: setFrameRaw,
    register,
    source,
    canUpload,
    upload: () => {
      if (!canUpload) return;
      // Blank falls back to the suggestion the placeholder shows. Without a
      // stated name the server names the source by its staged directory, whose
      // basename is a content digest — and the new batch inherits it.
      const named = sourceNamed(sourceName, suggestedName);
      setDirection(1);
      setAt(null);
      if (kind === "scans" && frame !== null) {
        registerScans.mutate({ files, frame, ...named }, { onSuccess: setSource });
      } else {
        registerImages.mutate({ files, ...named }, { onSuccess: setSource });
      }
    },
    clip,
    cutting,
    cut: () => {
      if (!clip.decodable) return;
      setDirection(1);
      setAt(null);
      setCutting(true);
    },
    target,
    setTarget,
    run,
    launch: () => {
      setDirection(1);
      setAt(null);
      if (kind === "video") clip.run(target);
      else if (source !== null) run.launch(source, target);
    },
    rerun: () => {
      // Re-ingesting a registered source is free — registration is idempotent
      // and content addressing deduplicates — so the same files into another
      // batch is a real second run. Only the run and the target reset.
      run.reset();
      setTarget(NEW_TARGET);
      setApproving(false);
      setApproved(null);
      setDirection(-1);
      setAt(null);
    },
    batchId,
    batchName,
    batch: batch.data ?? null,
    approving,
    setApproving: (next) => {
      setDirection(next ? 1 : -1);
      // The form stays mounted between openings, so each one starts it afresh from here.
      if (next && !approving) resetApproval();
      setApproving(next);
    },
    approval,
    approved,
    approve: () => {
      const jobs = approval.parts.length;
      const opened = approval.start;
      approval.submit((done) => {
        setApproved(approvedLine(done.schema_version, jobs, opened));
      });
    },
    landed,
    settled,
    busy,
    reached,
    shown,
    direction,
    go,
    another: resetChoices,
    restart: () => {
      resetChoices();
      forget();
    },
  };
}
