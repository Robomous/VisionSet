/**
 * A clip: read it here, cut it here, decode it here, and send frames.
 *
 * ## Nothing about this file crosses the wire
 *
 * The server holds no decoder. A clip is therefore never uploaded, never probed
 * remotely and never "ingested whole" by a decoder on the server — the host's
 * materializer reads the container in this browser, and what travels is PNG
 * frames. **There is no backend fallback, so this screen never offers one**: a
 * refusal here is the end of the road for that file in this browser, and saying
 * otherwise would promise a path that does not exist.
 *
 * ## Two steps, not three
 *
 * The image flow has three because registering a source is a server round trip
 * that has to happen before a batch can be chosen. Nothing here is: inspection is
 * local, and the rate, the ranges, the scale and the batch name all ride on the
 * one request that opens the session. So configuration belongs to the step that
 * chose the file, and the second step is the import itself.
 *
 * ## The report names what was found, not what was refused
 *
 * A file extension decides nothing here — `.mkv` says nothing about what is inside
 * it, and two files with the same suffix can differ on the only question that
 * matters. (Getting *to* this screen is still a guess from the extension, by way of
 * `File.type`; `IngestScreen` says so where the guess is made.) So the panel states the container and codec the decoder actually read
 * and whether *this* browser can decode them, which is also what makes the
 * refusal specific enough to act on: "this browser cannot decode AV1" has a
 * remedy, "unsupported video" does not.
 *
 * ## The session is what makes a cancel safe
 *
 * Frames are staged against a session and become assets in one transaction at
 * commit, so a materialization that stops partway leaves an *uncommitted import*
 * rather than a batch silently short of a stretch of its clip. That is what
 * `Cancel` has to honour on both sides: abort the materializer so decoding stops,
 * and `DELETE` the session so the staged frames go with it. Aborting only the
 * first would leave bytes on the server nobody will ever claim. Leaving the
 * screen is the same act and takes the same path, because a run nobody can see
 * is a run nobody can cancel.
 *
 * The window closes at the commit, and that is why `Cancel` goes disabled there:
 * one transaction turns every staged frame into an asset, aborting its request
 * would not roll it back, and a control that accepted the click would answer it
 * with the batch.
 *
 * ## Where the frames actually go is not this package's business
 *
 * `VisionSetMediaRuntime.createFrameSink` answers that, and the materializer
 * calls `append` itself — the returned promise is its back-pressure ack, so a
 * slow sink stalls decoding rather than filling the heap. This flow never sees a
 * frame, which is exactly what lets a managed host send them to object storage
 * without forking anything here.
 */

import { Film, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import type {
  VideoImportProgress,
  VideoInspection,
  VideoRefusal,
} from "@visionset/media";

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  FieldDescription,
  Input,
  Label,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@robomous/ui-core";

import { BATCH_ACTION, declares } from "../data/capabilities";
import { ApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import { formatBytes, formatCount } from "../lib/format";
import type { VisionSetMediaRuntime } from "../media/port";
import { ClipRangeTimeline } from "./ClipRangeTimeline";
import { ClearSelection, Dropzone, Fact, Step } from "./ingestSteps";
import { OutcomeNextStep } from "./ComposedTransitions";
import { ScaleField } from "./ingestScale";
import {
  expectedFrames,
  mergedRanges,
  selectionSummary,
  toTimeRanges,
  type ClipRange,
} from "./clipRanges";
import {
  useAbortVideoImport,
  useBatches,
  useCommitVideoImport,
  useStartVideoImport,
  type Batch,
} from "./queries";

/**
 * What went wrong, when the thing that went wrong may not be the server.
 *
 * Two failure sources meet on this screen. A `FrameSink` that was refused throws
 * an `ApiError`, and that goes through the product's one code→prose vocabulary
 * like every other refusal. A **decoder** that died throws whatever the host's
 * materializer throws, and `refusalProse` reads an unrecognised throw as
 * `NETWORK_ERROR` — which would tell somebody whose codec blew up to go and check
 * their connection. So a non-`ApiError` keeps its own sentence, under a heading
 * that says where it came from.
 */
function decodeProse(cause: unknown): string {
  if (cause instanceof ApiError) return refusalProse(cause);
  return `The decoder stopped: ${cause instanceof Error ? cause.message : String(cause)}`;
}

/** The kernel's own default. One frame per second. */
const DEFAULT_EXTRACTION_FPS = 1;

/** The value the batch picker uses for "make a new one". Never a batch id. */
const NEW_BATCH = "__new__";

export interface VideoImportFlowProps {
  readonly projectId: string;
  /** The host's decoder and frame transport. The screen renders nothing without one. */
  readonly runtime: VisionSetMediaRuntime;
  readonly file: File;
  readonly onFiles: (files: readonly File[]) => void;
  readonly onClearFiles: () => void;
  readonly dropzonePrompt: string;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onOpenSchema?: () => void;
}

export function VideoImportFlow({
  projectId,
  runtime,
  file,
  onFiles,
  onClearFiles,
  dropzonePrompt,
  onOpenBatch,
  onOpenSchema,
}: VideoImportFlowProps): JSX.Element {
  const { materializer } = runtime;
  /**
   * The decoder this screen keeps — identified by its name, not by its address.
   *
   * `VisionSetMediaRuntime` is the host's value, and `media/port.ts` asks the
   * host to hold one adapter per name rather than promising it will hand over
   * the same object twice. A host that builds its runtime inline in JSX honours
   * that and still hands a fresh materializer on every render it does, so an
   * effect keyed on the object would re-inspect for each one: a worker spawned
   * and torn down, and the ranges and the scale the person just chose thrown
   * away, for a decoder that did not change. `name` is the decoder and its exact
   * version, which is the only thing that can change what `inspect` answers.
   */
  const [decoder, setDecoder] = useState(materializer);
  if (decoder.name !== materializer.name) setDecoder(materializer);
  const [inspection, setInspection] = useState<VideoInspection | null>(null);
  // The inspection itself throwing — not a refusal the decoder described, but
  // the decoder failing to answer at all.
  const [unreadable, setUnreadable] = useState<unknown>(null);
  const [fps, setFps] = useState(String(DEFAULT_EXTRACTION_FPS));
  const [ranges, setRanges] = useState<readonly ClipRange[]>([]);
  const [scalePercent, setScalePercent] = useState(100);
  const [batchChoice, setBatchChoice] = useState(NEW_BATCH);
  const [batchName, setBatchName] = useState("");
  const [clipUrl, setClipUrl] = useState<string | null>(null);

  const [progress, setProgress] = useState<VideoImportProgress | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  // The materialization's own failure, as opposed to a mutation's: a decoder
  // that died, or a sink whose upload was refused.
  const [failure, setFailure] = useState<unknown>(null);
  const [cancelled, setCancelled] = useState(false);
  const running = useRef<AbortController | null>(null);
  const [inFlight, setInFlight] = useState(false);

  const start = useStartVideoImport(projectId);
  const commit = useCommitVideoImport(projectId);
  const abort = useAbortVideoImport();
  const batches = useBatches(projectId);

  // Which batches may take frames, read off the wire's own declaration. Only a
  // draft one can — an approved batch has been cut into jobs already — but
  // `state === "draft"` is the client re-deriving that rule, and the mirror
  // `FrameGrid` was rewritten to remove. The session refuses a closed batch at
  // `start`, before any decoding, so what is worth getting right here is the
  // offer, and `edit_membership` is the kernel's own answer to it.
  const editableBatches = (batches.data?.items ?? []).filter((batch) =>
    declares(batch, BATCH_ACTION.editMembership),
  );

  // Ask the host's decoder what this file is. The stale flag is the whole
  // cancellation story: an answer that arrives after the selection changed must
  // not describe the previous file.
  useEffect(() => {
    let stale = false;
    const controller = new AbortController();
    setInspection(null);
    setUnreadable(null);
    setRanges([]);
    setScalePercent(100);
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

  // Leaving the screen is a cancel. Without this, `run` goes on awaiting a
  // materialization nobody can see any more: the sink keeps POSTing frames and
  // the commit then makes a batch that no progress bar, no cancel and no outcome
  // ever described. Aborting the controller is the whole fix, because an aborted
  // signal is already the path `run` answers by deleting the session — so the
  // staged frames go with it rather than being left open on the server. A commit
  // already in flight is past that door and still lands: it is one transaction,
  // and aborting its request would not roll it back.
  useEffect(() => () => running.current?.abort(), []);

  // The preview player's source. Null where the platform has no object URLs
  // (jsdom), so the timeline renders no player.
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
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
  // A container a decoder parses but cannot time answers `NaN` here, and every
  // comparison with NaN is false — so an unsanitized duration reaches the
  // readouts as `NaN:NaN` and every guard below as "not zero". Zero is the
  // honest reading: no duration is known, so no frame count is either.
  const duration =
    inspection !== null && Number.isFinite(inspection.durationSeconds)
      ? inspection.durationSeconds
      : 0;
  const merged = decodable ? mergedRanges(ranges, duration) : [];
  const expected = decodable && usableRate ? expectedFrames(merged, duration, rate) : 0;
  // `expected > 0` and never `expected !== 0`: the same NaN that a bad duration
  // produces would pass a `!== 0` gate and open a session posting
  // `duration_seconds: null` — JSON has no NaN — for a raw 422.
  const importable = decodable && usableRate && expected > 0;

  const step = batch !== null || inFlight || progress !== null ? 2 : 1;

  async function run(): Promise<void> {
    if (inspection === null || !importable || inFlight) return;
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
          // variable-rate clip, which has none. Never `rate`: that is the rate
          // it is being cut at, and putting it here would record a fact about
          // the file that the file does not have.
          fps: inspection.sourceFps,
          duration_seconds: inspection.durationSeconds,
          codec: inspection.codec,
        },
        extraction_fps: rate,
        // Canonical, not raw. The materializer walks these bounds directly, so an
        // overlapping pair would decode the overlap twice and disagree with the
        // count the server computed from the same selection.
        ranges: [...merged],
        scale_percent: scalePercent,
        // What drew these frames, from the materializer itself rather than from
        // a string typed here: a host that swaps its decoder must not leave this
        // screen naming the old one.
        materializer: decoder.name,
        ...(batchChoice !== NEW_BATCH
          ? { batch_id: batchChoice }
          : batchName.trim() === ""
            ? {}
            : { batch_name: batchName.trim() }),
      });
      session = opened.id;
      await decoder.materialize(
        file,
        {
          extractionFps: rate,
          ranges: toTimeRanges(merged),
          scalePercent,
        },
        runtime.createFrameSink({ projectId, importId: opened.id }),
        { signal: controller.signal, onProgress: setProgress },
      );
      // A cancelled materialization *resolves* with what got through — the caller
      // owns the signal, so a partial result is an answer. Committing it would
      // hand somebody a batch they asked to throw away.
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

  function cancel(): void {
    running.current?.abort();
  }

  /** Back to a clean first step with a new file. The import itself is untouched. */
  function again(): void {
    setFps(String(DEFAULT_EXTRACTION_FPS));
    setScalePercent(100);
    setBatchChoice(NEW_BATCH);
    setBatchName("");
    setProgress(null);
    setBatch(null);
    setFailure(null);
    setCancelled(false);
    onClearFiles();
    start.reset();
    commit.reset();
    abort.reset();
  }

  const summary =
    inspection === null
      ? file.name
      : `${file.name} · ${inspection.container || "unknown container"} · ${formatCount(expected)} frames`;

  return (
    <ol className="flex flex-col">
      <Step
        index={1}
        title="Choose a clip"
        testId="step-1"
        state={step === 1 ? "active" : "complete"}
        summary={summary}
      >
        <Card className="mt-2">
          <CardContent className="flex flex-col gap-4 pt-4">
            <Dropzone onFiles={onFiles} prompt={dropzonePrompt} />

            <div className="flex flex-col rounded-lg border border-border" data-testid="selection">
              <div className="flex items-center gap-3 p-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Film className="size-4 text-muted-foreground" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" data-testid="chosen">
                    {file.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    video · {formatBytes(file.size)}
                    {inspection !== null &&
                      inspection.durationSeconds > 0 &&
                      ` · ${inspection.durationSeconds.toFixed(1)} s`}
                  </p>
                </div>
                <ClearSelection onClear={again} />
              </div>

              <div className="border-t border-border p-3">
                {inspection === null && unreadable === null && (
                  <p className="text-sm text-muted-foreground" data-testid="clip-inspecting">
                    Reading the clip…
                  </p>
                )}
                {unreadable !== null && (
                  <Alert variant="destructive" data-testid="clip-unreadable">
                    <AlertTitle>This clip could not be read</AlertTitle>
                    <AlertDescription>{decodeProse(unreadable)}</AlertDescription>
                  </Alert>
                )}
                {inspection !== null && (
                  <div className="flex flex-col gap-4">
                    <ClipReport inspection={inspection} />
                    {inspection.refusal !== undefined ? (
                      <Refusal refusal={inspection.refusal} inspection={inspection} />
                    ) : (
                      <ClipRangeTimeline
                        src={clipUrl}
                        durationSeconds={inspection.durationSeconds}
                        ranges={ranges}
                        onRangesChange={setRanges}
                        aside={
                          <div className="flex flex-col gap-3">
                            <RateField fps={fps} onFps={setFps} />
                            <ScaleField
                              percent={scalePercent}
                              onPercent={setScalePercent}
                              native={{
                                width: inspection.displayWidth,
                                height: inspection.displayHeight,
                              }}
                            />
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor="video-target-batch">Target batch</Label>
                              <Select value={batchChoice} onValueChange={setBatchChoice}>
                                <SelectTrigger id="video-target-batch" data-testid="target-batch">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NEW_BATCH}>New batch</SelectItem>
                                  {editableBatches.map((batch) => (
                                    <SelectItem key={batch.id} value={batch.id}>
                                      {batch.name} ({batch.asset_count})
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <FieldDescription>Only a draft batch can take new frames.</FieldDescription>
                            </div>
                            {batchChoice === NEW_BATCH && (
                              <div className="flex flex-col gap-1.5">
                                <Label htmlFor="video-batch-name">New batch name</Label>
                                <Input
                                  id="video-batch-name"
                                  data-testid="batch-name"
                                  value={batchName}
                                  placeholder={file.name}
                                  onChange={(event) => setBatchName(event.target.value)}
                                />
                                <FieldDescription>Defaults to the clip&apos;s name.</FieldDescription>
                              </div>
                            )}
                            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                              {usableRate && (
                                <>
                                  <dt className="text-muted-foreground">Frames</dt>
                                  <dd
                                    className="font-medium tabular-nums"
                                    data-testid="frames-estimate"
                                  >
                                    {formatCount(expected)}
                                  </dd>
                                </>
                              )}
                              <dt className="text-muted-foreground">Selection</dt>
                              <dd className="tabular-nums" data-testid="selection-readout">
                                {selectionSummary(ranges, duration)}
                              </dd>
                            </dl>
                            <FieldDescription>
                              Decoded in this browser. The clip itself is never uploaded — only
                              the frames it is cut into.
                            </FieldDescription>
                          </div>
                        }
                      />
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                variant="default"
                data-testid="start-video-import"
                // Explained by adjacency (`DESIGN.md` principle 9): a refusal or
                // a bad rate is stated in the panel directly above.
                disabled={!importable || inFlight}
                onClick={() => void run()}
              >
                {inFlight ? "Importing…" : "Import frames"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </Step>

      <Step
        index={2}
        title="Import"
        testId="step-2"
        last
        state={step === 2 ? "active" : "upcoming"}
        done={batch !== null}
        hint="Frames are decoded here and sent as they are made."
      >
        <Card className="mt-2" data-testid="import-card">
          <CardContent className="flex flex-col gap-4 pt-4">
            {progress !== null && (
              <div className="flex flex-col gap-1">
                <p className="text-xs text-muted-foreground" data-testid="import-progress">
                  {progress.materialized} of {progress.expected} frames
                </p>
                <Progress
                  aria-label="Video import progress"
                  value={
                    progress.expected === 0
                      ? 0
                      : Math.round((progress.materialized / progress.expected) * 100)
                  }
                />
              </div>
            )}

            {inFlight && (
              <div>
                <Button
                  variant="outline"
                  data-testid="cancel-video-import"
                  // There is nothing left to cancel once the commit is in flight: the
                  // transaction that turns the staged frames into assets has been asked
                  // for, aborting its request would not roll it back, and a control that
                  // took the click anyway would answer it with the batch the person just
                  // asked to throw away. Disabled with the reason beside it — the
                  // `ui-capabilities` reading for an action that is meaningful on this
                  // screen but not available at this moment.
                  disabled={commit.isPending}
                  onClick={cancel}
                >
                  <X aria-hidden="true" />
                  Cancel
                </Button>
                <FieldDescription>
                  {commit.isPending
                    ? "Too late to cancel: these frames are being turned into assets now, in one transaction that cannot be taken back."
                    : "Stops decoding and throws the staged frames away. No assets and no batch have been created yet, so there is nothing to undo afterwards."}
                </FieldDescription>
              </div>
            )}

            {cancelled && (
              <Alert data-testid="import-cancelled">
                <AlertTitle>That import was cancelled</AlertTitle>
                <AlertDescription>
                  The staged frames were discarded. No assets and no batch were added to the project.
                </AlertDescription>
              </Alert>
            )}

            {failure !== null && (
              <Alert variant="destructive" data-testid="import-error">
                <AlertTitle>The import stopped</AlertTitle>
                <AlertDescription>{decodeProse(failure)}</AlertDescription>
              </Alert>
            )}

            {commit.isError && (
              <Alert variant="destructive" data-testid="commit-error">
                <AlertTitle>Those frames were not committed</AlertTitle>
                <AlertDescription>{refusalProse(commit.error)}</AlertDescription>
              </Alert>
            )}

            {abort.isError && (
              <Alert variant="destructive" data-testid="abort-error">
                <AlertTitle>The staged frames could not be discarded</AlertTitle>
                <AlertDescription>{refusalProse(abort.error)}</AlertDescription>
              </Alert>
            )}

            {batch !== null && (
              <div
                className="flex flex-col gap-3 border-t border-border pt-4"
                data-testid="import-outcome"
              >
                <p className="text-sm">
                  Every frame this clip was cut into is in{" "}
                  <strong className="font-medium">{batch.name}</strong>. Identical frames
                  collapse into one asset, so the batch can hold fewer than {formatCount(expected)}.
                </p>
                <OutcomeNextStep
                  projectId={projectId}
                  batchId={batch.id}
                  {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
                  {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
                />
              </div>
            )}

            {(batch !== null || cancelled || failure !== null) && (
              <div>
                <Button variant="outline" data-testid="import-another" onClick={again}>
                  <Upload aria-hidden="true" />
                  Import another clip
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </Step>
    </ol>
  );
}

/**
 * What the decoder found, before anything is decided.
 *
 * The extension is not consulted anywhere on this screen, and this is why: these
 * are the facts the container actually carries, and "can this browser decode it"
 * is a property of the pair rather than of the suffix.
 */
function ClipReport({ inspection }: { readonly inspection: VideoInspection }): JSX.Element {
  return (
    <dl
      className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-muted p-4 text-sm md:grid-cols-3"
      data-testid="clip-report"
    >
      <Fact label="Container" value={inspection.container === "" ? "unreadable" : inspection.container} />
      <Fact label="Codec" value={inspection.codec === "" ? "unreadable" : inspection.codec} />
      <div>
        <dt className="text-xs text-muted-foreground">This browser</dt>
        <dd>
          <Badge
            variant={inspection.decodable ? "success" : "destructive"}
            data-testid="clip-decodable"
          >
            {inspection.decodable ? "can decode it" : "cannot decode it"}
          </Badge>
        </dd>
      </div>
      {inspection.displayWidth > 0 && (
        <Fact
          label="Size"
          value={`${inspection.displayWidth}×${inspection.displayHeight}${
            inspection.rotation === 0 ? "" : ` · rotated ${inspection.rotation}°`
          }`}
        />
      )}
      {inspection.durationSeconds > 0 && (
        <Fact label="Duration" value={`${inspection.durationSeconds.toFixed(1)} s`} />
      )}
      <Fact
        label="Source rate"
        value={inspection.sourceFps === null ? "variable" : `${inspection.sourceFps.toFixed(2)} fps`}
      />
    </dl>
  );
}

/**
 * One member of `VideoRefusal`, in the words a person can act on.
 *
 * Exhaustive by construction — a new member of the union fails to compile here
 * rather than falling through to a shrug — and every branch names a remedy that
 * exists. **None of them is "the server will do it instead":** there is no
 * server-side decoder, so offering one would send somebody to look for a path
 * that was deliberately deleted.
 */
function refusalNotice(
  refusal: VideoRefusal,
  inspection: VideoInspection,
): { readonly title: string; readonly body: string } {
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

function Refusal({
  refusal,
  inspection,
}: {
  readonly refusal: VideoRefusal;
  readonly inspection: VideoInspection;
}): JSX.Element {
  const notice = refusalNotice(refusal, inspection);
  return (
    <Alert variant="destructive" data-testid="clip-refusal" data-refusal={refusal}>
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>{notice.body}</AlertDescription>
    </Alert>
  );
}

/**
 * The rate the grid is walked at — chosen here, and part of what the import *is*.
 *
 * Unlike the old upload flow, the clip's own facts are on screen while it is
 * chosen: the report above already says what the source rate was, so this is no
 * longer a number picked blind.
 */
function RateField({
  fps,
  onFps,
}: {
  readonly fps: string;
  readonly onFps: (value: string) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="extraction-fps">Extraction rate</Label>
      <div className="flex items-center gap-2">
        <Input
          id="extraction-fps"
          data-testid="extraction-fps"
          type="number"
          min="0.1"
          step="0.1"
          className="w-24 tabular-nums"
          value={fps}
          onChange={(event) => onFps(event.target.value)}
        />
        <span className="text-sm text-muted-foreground">fps</span>
      </div>
    </div>
  );
}
