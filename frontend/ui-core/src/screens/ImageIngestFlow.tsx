/**
 * Images: pick files, register a source, launch a run, watch it finish.
 *
 * This is the path the server reads. It was the whole of `IngestScreen` until a
 * clip stopped being something the server can decode, and it is unchanged by that
 * split — the reasoning below is the reasoning it already had.
 *
 * ## One step is active at a time
 *
 * The flow is a vertical stepper: three steps always visible, exactly one
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
 * ## Refusals split by when they can be known
 *
 * A refusal a request can make is made on the request, and that decides what this
 * flow shows where: an unknown batch is 404, a batch past
 * `draft` is 409, a blank name is 422, all of them before a job row exists — so
 * those render on the launch form. Everything after the launch is on the job:
 * `error` is the one fatal cause, `failures` is the per-item report.
 *
 * ## The per-item report says one thing about every row
 *
 * Every entry in `failures` is a file that produced no asset, which is what lets
 * the table state a count on that basis and group by *why*. `IngestFailureKind`
 * lost its `partial` member when the server stopped decoding clips: a directory
 * read is all-or-nothing per file, and the half-read source that needed prose of
 * its own was always a video extraction.
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
 * `processed` is not the size of the batch: content addressing collapses
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

import { ArrowLeft, Image, RefreshCw, RotateCw, TriangleAlert, Upload } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useState,
  type FormEvent,
  type JSX,
} from "react";

import { refusalProse } from "../data/refusals";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, Progress, Input, Label, FieldDescription, FieldError, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@robomous/ui-core";
import { formatBytes, formatCount } from "../lib/format";
import type { BadgeTone } from "./batchState";
import { OutcomeNextStep } from "./ComposedTransitions";
import { ClearSelection, Dropzone, Step } from "./ingestSteps";
import {
  useBatches,
  useIngestJob,
  useRegisterSource,
  useResumeIngest,
  useStartIngest,
  type IngestFailure,
  type IngestJob,
  type Source,
} from "./queries";

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
 * person. Nobody is waiting on a person here.
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

/** `IngestFailureKind`: what is wrong with the file, said plainly. */
const FAILURE_KIND_LABEL: Record<string, string> = {
  unsupported: "Unsupported format",
  corrupt: "Corrupt file",
};

function failureKindLabel(kind: string): string {
  return FAILURE_KIND_LABEL[kind] ?? kind;
}

/** The value the batch picker uses for "make a new one". Never a batch id. */
const NEW_BATCH = "__new__";

export interface ImageIngestFlowProps {
  readonly projectId: string;
  readonly files: readonly File[];
  readonly onFiles: (files: readonly File[]) => void;
  /** Empty the selection and remount the dropzone. The screen owns both. */
  readonly onClearFiles: () => void;
  readonly dropzonePrompt: string;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onOpenSchema?: () => void;
}

export function ImageIngestFlow({
  projectId,
  files,
  onFiles,
  onClearFiles,
  dropzonePrompt,
  onOpenBatch,
  onOpenSchema,
}: ImageIngestFlowProps): JSX.Element {
  // What to call the source. Empty means "use the suggestion".
  const [sourceName, setSourceName] = useState("");
  const [batchChoice, setBatchChoice] = useState(NEW_BATCH);
  const [batchName, setBatchName] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const register = useRegisterSource(projectId);
  const start = useStartIngest(projectId);
  const batches = useBatches(projectId);
  const job = useIngestJob(jobId);
  const settled = job.data?.state;
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
   * see this, which is what the browser cycle suite is for — and it did: this
   * effect was lost when the ingest screen split into an image flow and a video
   * flow, and the cycle walk found the stale empty list again.
   */
  useEffect(() => {
    if (settled !== "completed" && settled !== "failed") return;
    void queries.invalidateQueries({ queryKey: ["projects", projectId] });
  }, [settled, projectId, queries]);

  // Only a draft batch may take an ingest. Anything else is refused at the launch
  // with 409 `BATCH_NOT_EDITABLE`, so offering one would be offering a refusal.
  const draftBatches = (batches.data?.items ?? []).filter((batch) => batch.state === "draft");

  // What the source is called unless the user types otherwise.
  // Without a stated name the server calls the source by its staged directory,
  // whose basename is a content digest — 64 hex characters that then become the
  // default batch name too. The first file's stem is deterministic, editable
  // right there, and honest: it names what was actually picked.
  const suggestedName = files.length > 0 ? stem(files[0].name) : "";

  const canRegister = files.length > 0 && !register.isPending;

  // Which step is live — derived, never stored, so it cannot disagree with the
  // data: a run (in flight or settled) is step 3, a registered source is step 2,
  // otherwise the user is still choosing files.
  const activeStep = jobId !== null ? 3 : source !== null ? 2 : 1;

  function upload(event: FormEvent): void {
    event.preventDefault();
    if (!canRegister) return;
    // Blank falls back to the suggestion the placeholder shows — the batch-name pattern.
    const stated = (sourceName.trim() === "" ? suggestedName : sourceName.trim()).trim();
    register.mutate(
      { files, ...(stated === "" ? {} : { name: stated }) },
      { onSuccess: (registered) => setSource(registered) },
    );
  }

  /**
   * Empty the selection without touching anything downstream — there is nothing
   * downstream yet, since this control only exists while step 1 is active.
   */
  function clearFiles(): void {
    setSourceName("");
    onClearFiles();
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
    setSourceName("");
    setBatchChoice(NEW_BATCH);
    setBatchName("");
    setSource(null);
    setJobId(null);
    onClearFiles();
    register.reset();
    start.reset();
  }

  /**
   * Back from a settled run to step 2, keeping the source.
   *
   * Re-ingesting a registered source is free — registration is idempotent and
   * content addressing deduplicates — so "the same files into a different
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
              <Dropzone onFiles={onFiles} prompt={dropzonePrompt} />

              {files.length > 0 && (
                <SelectionPanel
                  files={files}
                  sourceName={sourceName}
                  onSourceName={setSourceName}
                  suggestedName={suggestedName}
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
                  // files the dropzone above says what to do.
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
                  <Image className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span className="text-sm font-medium" title={source.name}>
                    {sourceLabel(source.name)}
                  </span>
                  <Badge variant="secondary">{source.kind}</Badge>
                </div>

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
        hint="Watch the files land in a batch."
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
          projectId={projectId}
          {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
          {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
          onAgain={again}
          onRerun={rerun}
        />
      </Step>
    </ol>
  );
}

/**
 * The selection, read back before anything uploads.
 */
function SelectionPanel({
  files,
  sourceName,
  onSourceName,
  suggestedName,
  onClear,
}: {
  readonly files: readonly File[];
  readonly sourceName: string;
  readonly onSourceName: (value: string) => void;
  readonly suggestedName: string;
  readonly onClear: () => void;
}): JSX.Element {
  const kind = files.length === 1 ? "image" : "images";
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <div className="flex flex-col rounded-lg border border-border" data-testid="selection">
      <div className="flex items-center gap-3 p-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <Image className="size-4 text-muted-foreground" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" data-testid="chosen">
            {files.length === 1 ? files[0].name : `${files.length} files`}
          </p>
          <p className="text-xs text-muted-foreground">
            {kind} · {formatBytes(totalBytes)}
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
        <ClearSelection onClear={onClear} />
      </div>

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
    </div>
  );
}

/**
 * A source's name, fit for a sentence.
 *
 * A **staged upload of images** is named by its content digest, because the
 * server stages parts under `uploads/<digest>/` and `SourceOut.name` is that
 * directory's basename — 64 hex characters nobody can read, in the step summary,
 * the default batch name and the outcome sentence. Rendered defensively on the
 * `IngestFailure.name` precedent: shorten for display, keep the full string in
 * `title`, and never invent a name the source does not have.
 */
export function sourceLabel(name: string): string {
  return /^[0-9a-f]{64}$/.test(name) ? `${name.slice(0, 8)}…` : name;
}

/** The filename without its last extension: `photo-0.png` → `photo-0`. */
function stem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

/** A directory states its total before the first file, so the bar has a denominator. */
function ingestPercent(job: IngestJob): number {
  if (job.total === null || job.total === undefined) {
    return job.state === "completed" ? 100 : 0;
  }
  return Math.round((job.processed / Math.max(job.total, 1)) * 100);
}

/** Bound once, so `value` and the `aria-valuenow` canonical `Progress` drops never disagree. */
function IngestProgress({ job }: { readonly job: IngestJob }): JSX.Element {
  const percent = ingestPercent(job);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground" data-testid="run-progress">
        {job.total === null || job.total === undefined
          ? `${job.processed} extracted`
          : `${job.processed} of ${job.total}`}
      </p>
      <Progress aria-label="Ingest progress" value={percent} />
    </div>
  );
}

function RunCard({
  job,
  projectId,
  onOpenBatch,
  onOpenSchema,
  onAgain,
  onRerun,
}: {
  readonly job: IngestJob | null;
  readonly projectId: string;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onOpenSchema?: () => void;
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
            <IngestProgress job={job} />

            {job.error !== null && job.error !== undefined && (
              <Alert variant="destructive" data-testid="run-error">
                <AlertTitle>The run stopped</AlertTitle>
                <AlertDescription>{job.error}</AlertDescription>
              </Alert>
            )}

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
                projectId={projectId}
                {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
                {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
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
  projectId,
  onOpenBatch,
  onOpenSchema,
  onAgain,
  onRerun,
}: {
  readonly job: IngestJob;
  readonly projectId: string;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onOpenSchema?: () => void;
  readonly onAgain: () => void;
  readonly onRerun: () => void;
}): JSX.Element {
  const batchId = job.batch_id ?? null;
  // Resolved at enqueue, so it survives a run that never reached the batch.
  const batchName = job.batch_name ?? "the batch";
  // Anything the run did not read whole — a fatal stop, a refused file, or a
  // file that ran out partway. All three make "everything this run read" a
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
      {batchId !== null && (
        <OutcomeNextStep
          projectId={projectId}
          batchId={batchId}
          {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
          {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {/* Back to step 2, source kept: the same files into a different batch
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
 * The per-file report of what did *not* arrive.
 *
 * Grouped by `kind`, which is the whole reason `IngestFailureKind` exists: an
 * `unsupported` file is operator noise — a `.txt` in a directory of photographs —
 * and a `corrupt` one is data loss. Reading fifty rows to notice that one of them
 * is the second kind is exactly the mistake a table can prevent.
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
 * than the basename — it is whatever the run's own loop was holding. That
 * inconsistency is known, deliberately left alone in the kernel, and it travels
 * on the wire. Rendering it raw would put an absolute path from somebody else's
 * machine into a table; the full string stays in the `title` so nothing is hidden.
 */
function basename(name: string): string {
  const segments = name.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] || name;
}
