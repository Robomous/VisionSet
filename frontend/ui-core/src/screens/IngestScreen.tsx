/**
 * Ingest: pick files, register a source, launch a run, watch it finish.
 *
 * ## The order is forced by where `extraction_fps` lives, and it is not obvious
 *
 * The issue asks for "fps parameter for video with **original-fps display from the
 * probe**". Those two cannot happen in that order. `extraction_fps` belongs to the
 * **source**, not to the run — "same source, same assets" only means something if
 * the parameters are part of what the source *is* — and the probe result only
 * exists once the clip has been registered. So the rate is chosen *before*
 * anything has been probed, and the clip's own fps is shown *after*.
 *
 * That is not a UI defect to design around; it is the domain, and pretending
 * otherwise would mean probing the file twice (once to advise, once to register)
 * and reporting a number that might not be the one stored. So this screen states
 * it: pick a rate, register, and then read what the clip actually is. If the rate
 * was wrong, registering again at a different one produces a **second source** —
 * deliberately, since idempotency is on `(kind, path, extraction_fps, ranges)`.
 *
 * ## One step is active at a time
 *
 * The screen is a vertical stepper: three steps always visible, exactly one
 * active. Which one is **derived** from the data — a run in flight is step 3, a
 * registered source is step 2, otherwise step 1 — never stored, so it cannot
 * disagree with the flow. A completed step collapses to a one-line summary of
 * what was decided and keeps **no live controls**, which also closes a real
 * hole: the old layout left step 1's dropzone active under an open step 2, so a
 * user could swap the files while the source card still described the old
 * ones, and nothing handled that. An upcoming step shows its number and one
 * line of what it will ask — the road ahead is what makes three cards read as
 * one workflow instead of appearing from nowhere.
 *
 * The extraction rate is inline rather than in a modal: with one active step
 * there is no competing surface for the field to be lost in, and the real
 * objection to an inline field was choosing blind, which the browser-side
 * estimate below answers better than a dialog does. The
 * `Number.isFinite(rate) && rate > 0` gate sits on `Register source` —
 * every comparison with `NaN` is false, so a `<= 0` spelling would upload
 * `extraction_fps=NaN` — and with the field adjacent and visible, the disabled
 * button has its explanation next to it (`DESIGN.md` principle 9).
 *
 * ## The browser reads the clip, so the rate is not chosen blind
 *
 * The fps must be chosen before the server's probe exists — but a browser can
 * read a clip's *duration* locally (`clipProbe.ts`) without uploading a byte,
 * and duration is what turns a rate into "≈ N frames". The estimate is
 * advisory; the probe in step 2 stays the authoritative record. Where the
 * browser cannot read the clip (an unsupported codec — or jsdom, which has no
 * media pipeline at all), the panel shows no estimate and no timeline, says the
 * clip will be ingested whole, and registration proceeds exactly as before.
 *
 * ## Refusals split by when they can be known
 *
 * A refusal a request can make is made on the request, and that decides what this
 * screen shows where: an unknown batch is 404, a batch past
 * `draft` is 409, a blank name is 422, all of them before a job row exists — so
 * those render on the launch form. Everything after the launch is on the job:
 * `error` is the one fatal cause, `failures` is the per-item report.
 *
 * ## The per-item report has two halves, and only one of them is a failure
 *
 * A damaged clip is read as far as its bytes go and the frames that came
 * out become assets, so its entry says *some of this is in your batch* — the
 * opposite of every other row in that table. It renders as prose above the
 * table, with the count it recovered and the remedy; the table below counts only
 * the files that produced nothing.
 *
 * **And this card is the only place either fact is ever stated.** A partial
 * extraction is reported once, at ingest, to the
 * person doing the ingest. The assets carry nothing, no later screen mentions
 * it, and a run that read everything says nothing at all — surfacing it again
 * would only be noise.
 *
 * ## `total` is null for a clip, and a progress bar has to survive that
 *
 * `VideoMetadata` carries no frame count by design, so an extraction has no
 * denominator until it is over. A directory states its total before the first
 * file. A bar that assumed a denominator would be a lie with a percentage on it,
 * so a clip gets a count and an indeterminate state instead.
 *
 * ## A settled run is a fork in the road, and it has to name both branches
 *
 * Without this the card reaches `completed` and the screen goes inert — no way to
 * the batch the run has just filled, and no way to ingest a second source short of
 * reloading the page, because `Start ingest` is gated on `jobId !== null` and
 * nothing clears it. Ingest is the *entry point* of the product, so a
 * terminal state naming no next step leaves a first-time user guessing where
 * their assets went. So a run that has settled offers the batch, a second run
 * with the same source into another batch, and a clean start with a new one.
 *
 * ## Every step names its way back, and a run in flight has none
 *
 * Step 2's footer carries "Change files" — a full restart, named for the step
 * it returns to; the registered source stays on the server, since registration
 * is idempotent and there is nothing to undo. A settled run's outcome carries
 * "Ingest into another batch" (back to step 2, source kept) beside "Ingest
 * another source" (back to step 1, everything reset). A run *in flight* is a
 * row on the server that cannot be un-launched, so it deliberately offers no
 * back control at all — a back that cancels nothing would be a lie with an
 * arrow on it.
 *
 * ## The outcome deliberately quotes no number, and the counters are why
 *
 * `processed` is not the size of the batch, on either path. A directory ingest
 * counts refused items into it (`len(candidates) + len(failures)`) and a video
 * ingest does not (`len(candidates)` alone), so `processed - failures.length` is
 * right for one and wrong for the other. And content addressing collapses
 * identical items into one asset, so even a clean directory run can put fewer
 * assets in the batch than it read files. The number that is honest is the one
 * the batch itself reports, and it is one click away: this card says *where*,
 * and lets the batch say *how many*.
 *
 * ## `batch_id` is NOT there from the first poll, which is what the button degrades on
 *
 * `enqueue` stores the batch id it was *handed* — null for the common case of a
 * run creating its own batch — and the row learns the real id in the same
 * transaction that marks the job `completed`. So a run in flight has nothing to
 * open, and a run that `failed` before it materialized a batch never gets one.
 * `batch_name` is resolved at enqueue either way, which is what lets a partial
 * run still say which batch holds what it managed to read.
 */

import { ArrowLeft, Check, Film, FolderOpen, Image, RefreshCw, RotateCw, TriangleAlert, Upload, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type JSX,
  type ReactNode,
} from "react";

import { refusalProse } from "../data/refusals";
import { cn } from "../lib/cn";
import { formatBytes, formatCount } from "../lib/format";
import { progressAria } from "../lib/progress";
import { BackLink } from "../patterns/BackLink";
import { parentLabel } from "../patterns/parentLabel";
import { Alert, AlertDescription, AlertTitle } from "../primitives/alert";
import { Badge } from "../primitives/badge";
import type { BadgeTone } from "./batchState";
import { Button } from "../primitives/button";
import { Card, CardContent } from "../primitives/card";
import { Progress } from "../primitives/progress";
import { Input } from "../primitives/input";
import { Label } from "../primitives/label";
import { FieldDescription, FieldError } from "../primitives/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/table";
import { SchemaForeshadow } from "./SchemaForeshadow";
import { ClipRangeTimeline } from "./ClipRangeTimeline";
import { probeClip, type ClipProbe } from "./clipProbe";
import {
  clock,
  expectedFrames,
  mergedRanges,
  selectionSummary,
  type ClipRange,
} from "./clipRanges";
import {
  useBatches,
  useIngestJob,
  useProject,
  useRegisterSource,
  useResumeIngest,
  useStartIngest,
  type IngestFailure,
  type IngestJob,
  type Source,
} from "./queries";

/** The kernel's own default. One frame per second. */
const DEFAULT_EXTRACTION_FPS = 1;

/**
 * `IngestState`, in the words a person uses for it — `batchState.ts`'s
 * convention, unknown members falling through to themselves so a newer
 * server's state reads as that state rather than as a shrug.
 */
const RUN_STATE_LABEL: Record<string, string> = {
  pending: "Waiting",
  running: "Processing",
  completed: "Done",
  failed: "Failed",
};

function runStateLabel(state: string): string {
  return RUN_STATE_LABEL[state] ?? state;
}

/**
 * The same states, as tokens.
 *
 * **A finished run is `success`, because a finished batch is.** Reading `outline`
 * here would give "finished" two colours in one product depending on
 * which noun you had finished. `outline` is the treatment for a decision nobody
 * has acted on yet (`approved`), which is the opposite of done.
 *
 * `pending` and `running` keep the near-black: work in flight is the healthy
 * state, and `warning` means one thing product-wide — something waiting on a
 * person. Nobody is waiting on a person here; they are waiting on ffmpeg.
 *
 * Beside the labels rather than in `batchState.ts` because this vocabulary has
 * exactly one rendering site and never had a second spelling. What is shared is
 * the *type*: a colour outside `BadgeTone` fails to compile.
 */
const RUN_STATE_VARIANT: Record<string, BadgeTone> = {
  pending: "default",
  running: "default",
  completed: "success",
  failed: "destructive",
};

function runStateVariant(state: string): BadgeTone {
  return RUN_STATE_VARIANT[state] ?? "secondary";
}

/**
 * `IngestFailureKind`, likewise: what is wrong with the file, said plainly.
 *
 * `partial` is deliberately absent, and its absence is not an oversight. The
 * other two kinds fit a table cell because they say the same thing about every
 * row — this file did not become an asset — and a partial says the opposite:
 * part of it did. It gets prose above the table instead. See `Partials`.
 */
const FAILURE_KIND_LABEL: Record<string, string> = {
  unsupported: "Unsupported format",
  corrupt: "Corrupt file",
};

function failureKindLabel(kind: string): string {
  return FAILURE_KIND_LABEL[kind] ?? kind;
}

/** The value the batch picker uses for "make a new one". Never a batch id. */
const NEW_BATCH = "__new__";

export interface IngestScreenProps {
  readonly projectId: string;
  /**
   * Open the batch a finished run filled.
   *
   * A callback rather than a route, because `ui-core` may not import a router —
   * turning it into `/projects/{projectId}/batches/{batchId}` is the shell's
   * job, the way `GalleryScreen`'s `onOpenAsset` and `ProjectScreen`'s
   * `onOpenBatch` already work. Optional, so a host that has nowhere to send
   * anybody renders the outcome without the button rather than a dead link.
   */
  readonly onOpenBatch?: (batchId: string) => void;
  /** Up to the project this is ingesting into — the immediate parent, and the one way out. */
  readonly onBack?: () => void;
  /** The schema tab, for the labels foreshadowing banner. */
  readonly onOpenSchema?: () => void;
}

export function IngestScreen({
  projectId,
  onOpenBatch,
  onBack,
  onOpenSchema,
}: IngestScreenProps): JSX.Element {
  const project = useProject(projectId);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [fps, setFps] = useState(String(DEFAULT_EXTRACTION_FPS));
  // What to call an image source. Empty means "use the suggestion".
  const [sourceName, setSourceName] = useState("");
  const [batchChoice, setBatchChoice] = useState(NEW_BATCH);
  const [batchName, setBatchName] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  // The browser's own read of a chosen clip. Null while unread or unreadable.
  const [clip, setClip] = useState<ClipProbe | null>(null);
  // The clip-range selection being edited in step 1. Raw and possibly
  // overlapping: the kernel canonicalizes on registration, and step 2 echoes
  // the merged form back.
  const [ranges, setRanges] = useState<readonly ClipRange[]>([]);
  // The chosen clip as an object URL for the preview player. Null where the
  // platform has no object URLs (jsdom), so the timeline renders no player.
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  // True once the browser said it cannot decode the clip — probeClip settled
  // null, as opposed to never settling at all.
  const [unreadable, setUnreadable] = useState(false);
  // Bumped by `again()`/`clearFiles()` and used as the dropzone's `key`. See there.
  const [attempt, setAttempt] = useState(0);

  const register = useRegisterSource(projectId);
  const start = useStartIngest(projectId);
  const batches = useBatches(projectId);
  const job = useIngestJob(jobId);
  const queries = useQueryClient();

  /**
   * Refresh the project when the run **finishes**, not when it starts.
   *
   * `useStartIngest` invalidates on the launch, and at that moment there is nothing
   * to see: `ingest()` fills the batch and completes the job in its *last*
   * transaction, so the batch a run creates does not exist until the poll says
   * `completed`. Without this, a user who ingests and then walks to the batch list
   * is shown "No batches yet" about a batch that is right there.
   *
   * Only a test that walks from one screen to another after a background job can
   * see this, which is what the browser cycle suite is for.
   */
  const settled = job.data?.state;
  useEffect(() => {
    if (settled !== "completed" && settled !== "failed") return;
    void queries.invalidateQueries({ queryKey: ["projects", projectId] });
  }, [settled, projectId, queries]);

  // A clip is one file; images are many. Decided from the selection rather than
  // from a mode switch, because a mode switch is a second place the same fact
  // lives and the two can disagree.
  const isVideo = useMemo(() => files.length === 1 && files[0].type.startsWith("video/"), [files]);

  // Ask the browser what the clip is, so the rate row can estimate frames. The
  // stale flag is the whole cancellation story: `probeClip`'s promise may settle
  // after the selection changed — or never, where there is no media pipeline —
  // and a late answer must not describe the previous file.
  useEffect(() => {
    setClip(null);
    setRanges([]);
    setUnreadable(false);
    if (!(files.length === 1 && files[0].type.startsWith("video/"))) return;
    const url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(files[0]) : null;
    setClipUrl(url);
    let stale = false;
    void probeClip(files[0]).then((probe) => {
      if (stale) return;
      if (probe === null) setUnreadable(true);
      else setClip(probe);
    });
    return () => {
      stale = true;
      setClipUrl(null);
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [files]);

  // Only a draft batch may take an ingest. Anything else is refused at the launch
  // with 409 `BATCH_NOT_EDITABLE`, so offering one would be offering a refusal.
  const draftBatches = (batches.data?.items ?? []).filter((batch) => batch.state === "draft");

  // What an image source is called unless the user types otherwise.
  // Without a stated name the server calls the source by its staged directory,
  // whose basename is a content digest — 64 hex characters that then become the
  // default batch name too. The first file's stem is deterministic, editable
  // right there, and honest: it names what was actually picked.
  const suggestedName = files.length > 0 && !isVideo ? stem(files[0].name) : "";

  // Every comparison with NaN is false, so `<= 0` alone would wave a NaN through
  // and upload `extraction_fps=NaN`.
  const rate = Number(fps);
  const usableRate = Number.isFinite(rate) && rate > 0;
  const canRegister = files.length > 0 && !register.isPending && (!isVideo || usableRate);

  // Which step is live — derived, never stored, so it cannot disagree with the
  // data: a run (in flight or settled) is step 3, a registered source is step 2,
  // otherwise the user is still choosing files.
  const activeStep = jobId !== null ? 3 : source !== null ? 2 : 1;

  function upload(event: FormEvent): void {
    event.preventDefault();
    if (!canRegister) return;
    // A video's name is its filename, so only images state one. Blank falls
    // back to the suggestion the placeholder shows — the batch-name pattern.
    const stated = (sourceName.trim() === "" ? suggestedName : sourceName.trim()).trim();
    register.mutate(
      {
        files,
        ...(isVideo ? { extractionFps: rate, ranges } : {}),
        ...(isVideo || stated === "" ? {} : { name: stated }),
      },
      { onSuccess: (registered) => setSource(registered) },
    );
  }

  /**
   * Empty the selection without touching anything downstream — there is nothing
   * downstream yet, since this control only exists while step 1 is active.
   *
   * The dropzone is *remounted*, not reset: an `<input type="file">` keeps the
   * selection it already holds, and a picker asked for the same file again may
   * report no change at all. A fresh element has nothing to compare against.
   */
  function clearFiles(): void {
    setFiles([]);
    setFps(String(DEFAULT_EXTRACTION_FPS));
    setSourceName("");
    setAttempt((previous) => previous + 1);
    register.reset();
  }

  /**
   * Back to a clean form — the whole of "ingest a second source without a reload".
   *
   * Every piece of the flow is cleared, including both mutations: a stale
   * `register.isError` left behind would sit above an empty dropzone as a
   * refusal of files nobody has chosen yet. The run itself is untouched — it is
   * a row on the server and this is a form, so starting over here neither
   * cancels nor forgets what was ingested.
   */
  function again(): void {
    setFiles([]);
    setFps(String(DEFAULT_EXTRACTION_FPS));
    setSourceName("");
    setBatchChoice(NEW_BATCH);
    setBatchName("");
    setSource(null);
    setJobId(null);
    setAttempt((previous) => previous + 1);
    register.reset();
    start.reset();
  }

  /**
   * Back from a settled run to step 2, keeping the source.
   *
   * Re-ingesting a registered source is free — registration is idempotent and
   * content addressing deduplicates — so "the same frames into a different
   * batch" is a real second run, not a re-upload. Only the run and the batch
   * choice reset; the source, being the thing reused, stays.
   */
  function rerun(): void {
    setJobId(null);
    setBatchChoice(NEW_BATCH);
    setBatchName("");
    start.reset();
  }

  function launch(event: FormEvent): void {
    event.preventDefault();
    if (source === null || start.isPending) return;
    start.mutate(
      {
        sourceId: source.id,
        ...(batchChoice === NEW_BATCH
          ? { batchName: batchName.trim() === "" ? source.name : batchName.trim() }
          : { batchId: batchChoice }),
      },
      { onSuccess: (launched) => setJobId(launched.id) },
    );
  }

  const chosenLabel = files.length === 1 ? files[0].name : `${files.length} files`;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  // What step 2 decided, for its collapsed summary. Derived from the same state
  // the launch read, so it cannot name a batch the run was not aimed at.
  const batchLabel =
    batchChoice === NEW_BATCH
      ? batchName.trim() === ""
        ? (source?.name ?? "")
        : batchName.trim()
      : (draftBatches.find((batch) => batch.id === batchChoice)?.name ?? "the batch");

  return (
    <div className="flex flex-col gap-6" data-testid="ingest-screen">
      {/* The one way out: up to the project, named — its noun while the name is
          still in flight. Rendered only when the host gave it somewhere to go. */}
      {onBack !== undefined && (
        <BackLink label={parentLabel(project.data?.name)} onNavigate={onBack} />
      )}

      <header className="border-b border-border pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Ingest</h1>
        <p className="text-xs text-muted-foreground">
          A source is registered once; ingesting it again creates nothing new.
        </p>
      </header>

      {/* Ingesting without labels is fine — annotating without them is not, and
          the refusal would otherwise arrive only at batch approval. */}
      <SchemaForeshadow
        projectId={projectId}
        {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
      />

      <ol className="flex flex-col">
        <Step
          index={1}
          title="Choose files"
          testId="step-1"
          state={activeStep === 1 ? "active" : "complete"}
          summary={`${chosenLabel} · ${formatBytes(totalBytes)}`}
        >
          <Card className="mt-2">
            <CardContent className="pt-4">
              <form className="flex flex-col gap-4" onSubmit={upload}>
                <Dropzone key={attempt} onFiles={setFiles} />

                {files.length > 0 && (
                  <SelectionPanel
                    files={files}
                    isVideo={isVideo}
                    clip={clip}
                    fps={fps}
                    onFps={setFps}
                    sourceName={sourceName}
                    onSourceName={setSourceName}
                    suggestedName={suggestedName}
                    ranges={ranges}
                    onRanges={setRanges}
                    clipUrl={clipUrl}
                    unreadable={unreadable}
                    estimate={
                      clip !== null && usableRate
                        ? // Still approximate: the input is the browser's duration,
                          // which can differ from ffprobe's by a container's rounding.
                          expectedFrames(
                            mergedRanges(ranges, clip.durationSeconds),
                            clip.durationSeconds,
                            rate,
                          )
                        : null
                    }
                    onClear={clearFiles}
                  />
                )}

                {register.isError && (
                  <FieldError data-testid="register-error">
                    {refusalProse(register.error)}
                  </FieldError>
                )}

                <div className="flex justify-end">
                  <Button
                    type="submit"
                    variant="default"
                    data-testid="register-source"
                    // Explained by adjacency (`DESIGN.md` principle 9): with no
                    // files the dropzone above says what to do, and with a bad
                    // rate the field it came from is right there.
                    disabled={!canRegister}
                  >
                    {register.isPending ? "Uploading…" : "Register source"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </Step>

        <Step
          index={2}
          title="Configure the run"
          testId="step-2"
          state={activeStep === 2 ? "active" : activeStep === 3 ? "complete" : "upcoming"}
          hint="Pick the target batch once the source is registered."
          summary={
            source !== null ? `${sourceLabel(source.name)} → ${sourceLabel(batchLabel)}` : undefined
          }
        >
          {source !== null && (
            <Card className="mt-2" data-testid="source-card">
              <CardContent className="pt-4">
                <form className="flex flex-col gap-4" onSubmit={launch}>
                  <div className="flex items-center gap-2">
                    {source.kind === "video" ? (
                      <Film className="size-4 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <Image className="size-4 text-muted-foreground" aria-hidden="true" />
                    )}
                    <span className="text-sm font-medium" title={source.name}>
                      {sourceLabel(source.name)}
                    </span>
                    <Badge variant="secondary">{source.kind}</Badge>
                  </div>

                  {source.video !== null && source.video !== undefined && (
                    <dl
                      className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-muted p-4 text-sm md:grid-cols-3"
                      data-testid="probe"
                    >
                      <Fact label="Native fps" value={source.video.fps.toFixed(2)} />
                      <Fact label="Extraction fps" value={String(source.video.extraction_fps)} />
                      <Fact
                        label="Duration"
                        value={`${source.video.duration_seconds.toFixed(1)} s`}
                      />
                      <Fact label="Size" value={`${source.video.width}×${source.video.height}`} />
                      <Fact label="Codec" value={source.video.codec} />
                      <Fact
                        label="Frames expected"
                        value={String(
                          expectedFrames(
                            source.video.ranges,
                            source.video.duration_seconds,
                            source.video.extraction_fps,
                          ),
                        )}
                      />
                      {source.video.ranges.length > 0 && (
                        <Fact
                          label="Ranges"
                          value={source.video.ranges
                            .map((one) => `${clock(one.start_seconds)}–${clock(one.end_seconds)}`)
                            .join(", ")}
                        />
                      )}
                    </dl>
                  )}

                  <div className="grid max-w-2xl gap-4 md:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="target-batch">Target batch</Label>
                      <Select value={batchChoice} onValueChange={setBatchChoice}>
                        <SelectTrigger id="target-batch" data-testid="target-batch">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NEW_BATCH}>New batch</SelectItem>
                          {draftBatches.map((batch) => (
                            <SelectItem key={batch.id} value={batch.id}>
                              {batch.name} ({batch.asset_count})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldDescription>Only a draft batch can take new assets.</FieldDescription>
                    </div>
                    {batchChoice === NEW_BATCH && (
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="batch-name">New batch name</Label>
                        <Input
                          id="batch-name"
                          data-testid="batch-name"
                          value={batchName}
                          placeholder={source.name}
                          onChange={(event) => setBatchName(event.target.value)}
                        />
                        <FieldDescription>Defaults to the source name.</FieldDescription>
                      </div>
                    )}
                  </div>

                  {start.isError && (
                    <FieldError data-testid="start-error">
                      {refusalProse(start.error)}
                    </FieldError>
                  )}

                  <div className="flex items-center justify-between">
                    {/* The back names the step it returns to. It is a full
                        restart — the registered source stays on the server
                        (registration is idempotent, nothing to undo), but every
                        setting on this screen resets with the files. */}
                    <Button type="button" variant="ghost" data-testid="back-to-files" onClick={again}>
                      <ArrowLeft aria-hidden="true" />
                      Change files
                    </Button>
                    <Button
                      type="submit"
                      variant="default"
                      data-testid="start-ingest"
                      disabled={start.isPending}
                    >
                      {start.isPending ? "Starting…" : "Start ingest"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}
        </Step>

        <Step
          index={3}
          title="Run"
          testId="step-3"
          last
          state={activeStep === 3 ? "active" : "upcoming"}
          // The marker turns into a check while the content stays live: a
          // completed run is done *and* still worth reading.
          done={settled === "completed"}
          hint="Watch the frames land in a batch."
          aside={
            activeStep === 3 && job.data !== undefined ? (
              <Badge variant={runStateVariant(job.data.state)} data-testid="run-state">
                {runStateLabel(job.data.state)}
              </Badge>
            ) : undefined
          }
        >
          <RunCard
            job={job.data ?? null}
            {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
            onAgain={again}
            onRerun={rerun}
          />
        </Step>
      </ol>
    </div>
  );
}

/**
 * One row of the workflow: marker, rail, and whichever of three bodies its
 * state earns — the active card, a completed summary, or an upcoming hint.
 *
 * `state` is passed in rather than computed here because the screen derives it
 * from the data in one expression; a step judging its own state would be a
 * second copy of that expression per step. `data-state` is published for the
 * tests, which assert the *choreography* — one active step at a time, completed
 * steps keep no live controls — rather than any class string.
 */
function Step({
  index,
  title,
  state,
  done = false,
  hint,
  summary,
  aside,
  last = false,
  testId,
  children,
}: {
  readonly index: number;
  readonly title: string;
  readonly state: "upcoming" | "active" | "complete";
  /** Show the check while staying active — for the step whose end is the flow's end. */
  readonly done?: boolean;
  readonly hint?: string;
  readonly summary?: string;
  readonly aside?: ReactNode;
  readonly last?: boolean;
  readonly testId: string;
  readonly children?: ReactNode;
}): JSX.Element {
  const checked = state === "complete" || done;
  return (
    <li
      className="flex gap-4"
      data-testid={testId}
      data-state={state}
      aria-current={state === "active" ? "step" : undefined}
    >
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            checked
              ? "border border-border bg-muted text-foreground"
              : state === "active"
                ? "bg-primary text-primary-foreground"
                : "border border-border bg-card text-muted-foreground",
          )}
          aria-hidden="true"
        >
          {checked ? <Check className="size-3.5" /> : index}
        </span>
        {!last && <div className="mt-1 w-px flex-1 bg-border" aria-hidden="true" />}
      </div>

      <div className={cn("flex min-w-0 flex-1 flex-col gap-1", last ? "pb-0" : "pb-8")}>
        <div className="flex min-h-7 flex-wrap items-center gap-2">
          <h2
            className={cn(
              state === "active" ? "text-base font-semibold" : "text-sm font-medium",
              state === "upcoming" && "text-muted-foreground",
            )}
          >
            {title}
          </h2>
          {aside}
        </div>
        {state === "upcoming" && hint !== undefined && (
          <p className="text-xs text-muted-foreground">{hint}</p>
        )}
        {state === "complete" && summary !== undefined && (
          <p className="truncate text-sm text-muted-foreground" data-testid={`${testId}-summary`}>
            {summary}
          </p>
        )}
        {state === "active" && children}
      </div>
    </li>
  );
}

/**
 * The selection, read back before anything uploads.
 *
 * This panel is where the extraction rate lives for a clip — a structured,
 * full-width row instead of the lone corner field it used to be. The estimate
 * beside it is the browser's own duration read times the typed rate, `floor`ed
 * to match the server's "Frames expected" exactly; it renders only when both
 * halves exist, so an unreadable clip degrades to the field alone.
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


function SelectionPanel({
  files,
  isVideo,
  clip,
  fps,
  onFps,
  sourceName,
  onSourceName,
  suggestedName,
  ranges,
  onRanges,
  clipUrl,
  unreadable,
  estimate,
  onClear,
}: {
  readonly files: readonly File[];
  readonly isVideo: boolean;
  readonly clip: ClipProbe | null;
  readonly fps: string;
  readonly onFps: (value: string) => void;
  readonly sourceName: string;
  readonly onSourceName: (value: string) => void;
  readonly suggestedName: string;
  readonly ranges: readonly ClipRange[];
  readonly onRanges: (ranges: readonly ClipRange[]) => void;
  readonly clipUrl: string | null;
  readonly unreadable: boolean;
  readonly estimate: number | null;
  readonly onClear: () => void;
}): JSX.Element {
  const kind = isVideo ? "video" : files.length === 1 ? "image" : "images";
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <div className="flex flex-col rounded-lg border border-border" data-testid="selection">
      <div className="flex items-center gap-3 p-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
          {isVideo ? (
            <Film className="size-4 text-muted-foreground" aria-hidden="true" />
          ) : (
            <Image className="size-4 text-muted-foreground" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" data-testid="chosen">
            {files.length === 1 ? files[0].name : `${files.length} files`}
          </p>
          <p className="text-xs text-muted-foreground">
            {kind} · {formatBytes(totalBytes)}
            {clip !== null && ` · ${clip.durationSeconds.toFixed(1)} s`}
          </p>
          {/* A bunch reads back its *contents*, not only its count — the first
              few names are what let somebody catch "that is the wrong folder"
              before a single byte uploads. Three, because the point is
              recognition, not inventory; the batch says the rest. */}
          {files.length > 1 && (
            <p className="truncate text-xs text-muted-foreground" data-testid="selection-names">
              {files
                .slice(0, 3)
                .map((file) => file.name)
                .join(" · ")}
              {files.length > 3 && ` · +${formatCount(files.length - 3)} more`}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="clear-files"
          aria-label="Clear selection"
          onClick={onClear}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      {!isVideo && (
        <div className="border-t border-border p-3">
          <div className="flex max-w-sm flex-col gap-1.5">
            <Label htmlFor="source-name">Source name</Label>
            <Input
              id="source-name"
              data-testid="source-name"
              value={sourceName}
              placeholder={suggestedName}
              onChange={(event) => onSourceName(event.target.value)}
            />
            <FieldDescription>
              Names the source — and the new batch inherits it. Without one the server calls
              both by the upload&apos;s content digest.
            </FieldDescription>
          </div>
        </div>
      )}

      {isVideo && (
        <div className="border-t border-border p-3">
          {clip !== null ? (
            <ClipRangeTimeline
              src={clipUrl}
              durationSeconds={clip.durationSeconds}
              ranges={ranges}
              onRangesChange={onRanges}
              aside={
                <div className="flex flex-col gap-3">
                  <RateField fps={fps} onFps={onFps} />
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {estimate !== null && (
                      <>
                        <dt className="text-muted-foreground">Frames</dt>
                        <dd
                          className="font-medium tabular-nums"
                          data-testid="frames-estimate"
                          title="The browser's own reading of the clip; the probe after registration is the authoritative one."
                        >
                          ≈ {formatCount(estimate)}
                        </dd>
                      </>
                    )}
                    <dt className="text-muted-foreground">Selection</dt>
                    <dd className="tabular-nums" data-testid="selection-readout">
                      {selectionSummary(ranges, clip.durationSeconds)}
                    </dd>
                  </dl>
                  <FieldDescription>
                    Part of what the source <em>is</em> — the same clip registered at another
                    rate or other ranges becomes a second source.
                  </FieldDescription>
                </div>
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
              {unreadable && (
                <p className="text-xs text-muted-foreground" data-testid="clip-undecodable">
                  The browser cannot decode this clip; it will be ingested whole.
                </p>
              )}
              <RateField fps={fps} onFps={onFps} />
              <FieldDescription>
                Part of what the source <em>is</em> — the same clip registered at another rate
                or other ranges becomes a second source.
              </FieldDescription>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A source's name, fit for a sentence.
 *
 * A video source is named by its file — `clip.mp4`, fine as it is. A **staged
 * upload of images** is named by its content digest, because the server stages
 * parts under `uploads/<digest>/` and `SourceOut.name` is that directory's
 * basename — 64 hex characters nobody can read, in the step summary, the
 * default batch name and the outcome sentence. Rendered defensively on the
 * `IngestFailure.name` precedent: shorten for display, keep the full string in
 * `title`, and never invent a name the source does not have.
 */
function sourceLabel(name: string): string {
  return /^[0-9a-f]{64}$/.test(name) ? `${name.slice(0, 8)}…` : name;
}

/** The filename without its last extension: `photo-0.png` → `photo-0`. */
function stem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function Fact({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/** A clip has no denominator until it is over: `VideoMetadata` carries no frame count, by design. */
function ingestPercent(job: IngestJob): number {
  if (job.total === null || job.total === undefined) {
    return job.state === "completed" ? 100 : 0;
  }
  return Math.round((job.processed / Math.max(job.total, 1)) * 100);
}

function RunCard({
  job,
  onOpenBatch,
  onAgain,
  onRerun,
}: {
  readonly job: IngestJob | null;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onAgain: () => void;
  readonly onRerun: () => void;
}): JSX.Element {
  const resume = useResumeIngest();

  return (
    <Card className="mt-2" data-testid="run-card">
      <CardContent className="flex flex-col gap-4 pt-4">
        {job === null ? (
          <p className="text-sm text-muted-foreground">Starting…</p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground" data-testid="run-progress">
                {job.total === null || job.total === undefined
                  ? `${job.processed} extracted`
                  : `${job.processed} of ${job.total}`}
              </p>
              <Progress
                aria-label="Ingest progress"
                value={ingestPercent(job)}
                {...progressAria(ingestPercent(job))}
              />
            </div>

            {job.error !== null && job.error !== undefined && (
              <Alert variant="destructive" data-testid="run-error">
                <AlertTitle>The run stopped</AlertTitle>
                <AlertDescription>{job.error}</AlertDescription>
              </Alert>
            )}

            {/* Two reports, split by whether anything arrived. A partial is not a
                file the run could not read, so it does not go in the table that
                says so — and a run with only partials renders no table at all. */}
            <Partials failures={job.failures} />
            <Failures failures={job.failures} />

            {job.state === "failed" && (
              <div>
                <Button
                  variant="outline"
                  data-testid="resume-ingest"
                  disabled={resume.isPending}
                  onClick={() => resume.mutate(job.id)}
                >
                  <RefreshCw aria-hidden="true" />
                  {resume.isPending ? "Resuming…" : "Resume"}
                </Button>
                <FieldDescription>
                  A resume is a redo, not a skip — nothing records which files already
                  succeeded, and content addressing makes re-reading them free.
                </FieldDescription>
                {/*
                  The refusal of the *resume*, which is a different fact from the
                  run's own error above it (audit F9). `resume.isError` was read
                  nowhere, and the `run-error` alert a few lines up shows the job
                  row's stored cause — so a rejected resume left the old failure
                  on screen unchanged and the button re-enabled, which reads as a
                  press the page ignored. Titled separately for exactly that
                  reason: same screen, two different things that went wrong.
                */}
                {resume.isError && (
                  <Alert variant="destructive" data-testid="resume-error">
                    <AlertTitle>That resume was refused</AlertTitle>
                    <AlertDescription>{refusalProse(resume.error)}</AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            {(job.state === "completed" || job.state === "failed") && (
              <Outcome
                job={job}
                {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
                onAgain={onAgain}
                onRerun={onRerun}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Where the assets went, and what to do about it.
 *
 * Rendered for `completed` **and** for `failed`, because a partial run has a
 * batch too: whatever it managed to read before it stopped is in there, and the
 * failure report above is precisely the case where a user needs to be told that
 * some of it did land. That is also the argument against redirecting on
 * completion — the report and the next step have to be readable at the same
 * time, and a redirect throws the report away for the runs that most need it.
 *
 * The action is *offered*, never taken.
 */
function Outcome({
  job,
  onOpenBatch,
  onAgain,
  onRerun,
}: {
  readonly job: IngestJob;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onAgain: () => void;
  readonly onRerun: () => void;
}): JSX.Element {
  const batchId = job.batch_id ?? null;
  // Resolved at enqueue, so it survives a run that never reached the batch.
  const batchName = job.batch_name ?? "the batch";
  // Anything the run did not read whole — a fatal stop, a refused file, or a
  // clip that ran out partway. All three make "everything this run read" a
  // sentence the outcome must not say.
  const incomplete = job.state === "failed" || job.failures.length > 0;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4" data-testid="run-outcome">
      <p className="text-sm">
        {batchId === null ? (
          // `enqueue` only stores an id it was handed, and one is handed only
          // when the launch targeted an existing draft. A run that died before
          // it materialized a batch therefore has nothing to open — and
          // saying so is more use than a button that cannot work.
          <>This run never reached a batch, so there is nothing to open yet.</>
        ) : incomplete ? (
          <>
            What this run managed to read is in{" "}
            <strong className="font-medium" title={batchName}>
              {sourceLabel(batchName)}
            </strong>
            .
          </>
        ) : (
          <>
            Everything this run read is in{" "}
            <strong className="font-medium" title={batchName}>
              {sourceLabel(batchName)}
            </strong>
            .
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {batchId !== null && onOpenBatch !== undefined && (
          <Button variant="default" data-testid="open-batch" onClick={() => onOpenBatch(batchId)}>
            <FolderOpen aria-hidden="true" />
            Open batch
          </Button>
        )}
        {/* Back to step 2, source kept: the same frames into a different batch
            is a real second run — registration is idempotent and content
            addressing makes re-reading free. */}
        <Button variant="outline" data-testid="rerun-source" onClick={onRerun}>
          <RotateCw aria-hidden="true" />
          Ingest into another batch
        </Button>
        <Button variant="outline" data-testid="ingest-another" onClick={onAgain}>
          <Upload aria-hidden="true" />
          Ingest another source
        </Button>
      </div>
    </div>
  );
}

/**
 * What arrived out of a source that was only read in part.
 *
 * Prose rather than a table row, because a partial is the one entry in the
 * report that asks for a decision. The other kinds say "this file is not in your
 * batch" and the remedy is obvious; this one says "some of this file *is* in
 * your batch", and what to do about the rest — obtain a good copy, ingest it
 * again, content addressing makes the overlap free — is not something a reader
 * derives from a count. `DESIGN.md`'s copy rule, one sentence each: what
 * happened, then what to do.
 *
 * **This is the whole of where the fact lives.** A partial extraction is reported
 * once, here, to the person doing the ingest —
 * the assets themselves carry nothing, and no later view mentions it.
 *
 * The estimate is hedged (`about`) and dropped entirely when the server sent
 * none: a damaged container's own metadata is suspect, and a denominator stated
 * flatly would be the one number on screen that nobody measured.
 *
 * Renders nothing at all when nothing was partial, which is the ok-state.
 *
 * The treatment is the one this card already uses for a report — the neutral
 * `Alert` box, with `Failures`' own `TriangleAlert` in the heading. No new
 * `Alert` variant was added for it: the icon and the sentence carry the status,
 * which is what keeps it from being conveyed by colour alone.
 */
function Partials({
  failures,
}: {
  readonly failures: readonly IngestFailure[];
}): JSX.Element | null {
  const partials = failures.filter((failure) => failure.kind === "partial");
  if (partials.length === 0) return null;

  return (
    <Alert data-testid="partials">
      <AlertTitle>
        <span className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-warning" aria-hidden="true" />
          Some of what you ingested was damaged
        </span>
      </AlertTitle>
      <AlertDescription>
      <ul className="flex flex-col gap-2">
        {partials.map((failure, index) => (
          <li key={`${failure.name}-${index}`} data-testid={`partial-${index}`}>
            <span className="font-mono text-xs" title={failure.name}>
              {basename(failure.name)}
            </span>{" "}
            — damaged source: {formatCount(failure.frames_produced ?? 0)} frame
            {failure.frames_produced === 1 ? "" : "s"} recovered
            {failure.frames_expected_estimate !== null &&
              failure.frames_expected_estimate !== undefined &&
              ` (the container claimed about ${formatCount(failure.frames_expected_estimate)})`}
            . The frames are in the batch; re-ingest a good copy to replace them.
          </li>
        ))}
      </ul>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The per-file report of what did *not* arrive.
 *
 * Grouped by `kind`, which is the whole reason `IngestFailureKind` exists: an
 * `unsupported` file is operator noise — a `.txt` in a directory of photographs —
 * and a `corrupt` one is data loss. Reading fifty rows to notice that one of them
 * is the second kind is exactly the mistake a table can prevent.
 *
 * `partial` is filtered out rather than given a third badge: every row here is
 * a file that produced nothing, and the heading counts them on that basis. A
 * partial that slipped into this table would be counted as a file that could
 * not be read while its frames sat in the batch.
 */
function Failures({
  failures,
}: {
  readonly failures: readonly IngestFailure[];
}): JSX.Element | null {
  const corrupt = failures.filter((failure) => failure.kind === "corrupt");
  const unsupported = failures.filter((failure) => failure.kind === "unsupported");
  const refused = corrupt.length + unsupported.length;
  if (refused === 0) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="failures">
      <p className="flex items-center gap-2 text-sm">
        <TriangleAlert className="size-4 text-destructive" aria-hidden="true" />
        {/* The refused count, not `failures.length`: a partial belongs to the
            report above, and counting it here would say a file could not be read
            while its frames are in the batch. */}
        {refused} file{refused === 1 ? "" : "s"} could not be read
        {corrupt.length > 0 && (
          <Badge variant="destructive" data-testid="corrupt-count">
            {corrupt.length} corrupt
          </Badge>
        )}
        {unsupported.length > 0 && (
          <Badge variant="secondary" data-testid="unsupported-count">{unsupported.length} unsupported</Badge>
        )}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>File</TableHead>
            <TableHead className="w-32">Kind</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...corrupt, ...unsupported].map((failure, index) => (
            <TableRow key={`${failure.name}-${index}`} data-testid={`failure-${index}`}>
              <TableCell className="font-mono text-xs" title={failure.name}>
                {basename(failure.name)}
              </TableCell>
              <TableCell>
                <Badge variant={failure.kind === "corrupt" ? "destructive" : "secondary"}>
                  {failureKindLabel(failure.kind)}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{failure.reason}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The last segment of whatever the report called the file.
 *
 * Defensive on purpose, and the reason is recorded in the repository: for a
 * **directory** ingest, `IngestFailure.name` is the **full server path** rather
 * than the basename — it is whatever the run's own loop was holding — while for a
 * clip it is the name that was uploaded. That inconsistency is known, deliberately
 * left alone in the kernel, and it travels on the wire. Rendering it raw would put
 * an absolute path from somebody else's machine into a table; the full string stays
 * in the `title` so nothing is hidden.
 */
function basename(name: string): string {
  const segments = name.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] || name;
}

/**
 * Drag-and-drop plus a picker.
 *
 * Hand-rolled rather than `react-dropzone`, which `DESIGN.md`'s table pins for
 * this concern. The library earns its keep on the parts this does not need —
 * MIME filtering, size limits, per-file rejection reasons — and every one of those
 * is a rule the **server** already owns and refuses better: a `.txt` among the
 * photographs comes back as an `unsupported` row in the report above, with the
 * kernel's own reason. Duplicating that in the browser would be a second spelling
 * of the accepted-format list, and the two would drift. What is left is a `drop`
 * handler and a hidden `<input>`.
 *
 * What was chosen renders in `SelectionPanel`, not here — the zone stays a
 * standing invitation, and dropping again replaces the selection.
 */
function Dropzone({ onFiles }: { readonly onFiles: (files: readonly File[]) => void }): JSX.Element {
  const [over, setOver] = useState(false);

  function take(list: FileList | null): void {
    onFiles(list === null ? [] : Array.from(list));
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files);
  }

  return (
    <div
      data-testid="dropzone"
      data-over={over ? "true" : "false"}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center ${
        over ? "border-primary bg-primary/5" : "border-border bg-muted"
      }`}
    >
      <Upload className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm">Drop images or a video here</p>
      <p className="text-xs text-muted-foreground">
        Nothing is filtered in the browser — the server reads every file and reports what it
        could not.
      </p>
      <Label htmlFor="ingest-files" className="cursor-pointer text-primary underline">
        or choose files
      </Label>
      <input
        id="ingest-files"
        data-testid="file-input"
        type="file"
        multiple
        className="sr-only"
        onChange={(event: ChangeEvent<HTMLInputElement>) => take(event.target.files)}
      />
    </div>
  );
}
