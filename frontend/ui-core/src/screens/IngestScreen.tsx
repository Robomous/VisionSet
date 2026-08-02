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
 * deliberately, since idempotency is on `(kind, path, extraction_fps)`.
 *
 * ## So the rate is asked in a modal, at the moment of registration (#234)
 *
 * It used to be an inline field under the dropzone, inside a step titled "Choose
 * files" — which is not what it is about, and which put an irreversible decision in
 * a control a user could scroll past without reading. `Register source` is the last
 * moment the value can still be changed, so that is where it is asked.
 *
 * Two rules the dialog holds, and both are load-bearing. **Cancel registers
 * nothing**: no request, no source, and the chosen file stays chosen, so backing
 * out costs the selection nothing. And the draft rate lives *in the dialog*, not on
 * the screen, which is what makes that true of an edit as well as of the whole
 * gesture — a rate typed and then cancelled leaves no trace to be uploaded by the
 * next press.
 *
 * A refusal renders **inside** the dialog and leaves it open, because a rate the
 * server would not take has to be correctable where it was typed. Images never see
 * any of this: they have no rate, so `Register source` uploads them directly.
 *
 * ## Refusals split by when they can be known
 *
 * #28's rule, and it decides what this screen shows where. Anything the *request*
 * can refuse is refused synchronously — an unknown batch is 404, a batch past
 * `draft` is 409, a blank name is 422, all of them before a job row exists — so
 * those render on the launch form. Everything after the launch is on the job:
 * `error` is the one fatal cause, `failures` is the per-item report.
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
 * #181: the card reached `completed` and the screen went inert — no way to the
 * batch the run had just filled, and no way to ingest a second source short of
 * reloading the page, because `Start ingest` is gated on `jobId !== null` and
 * nothing ever cleared it. Ingest is the *entry point* of the product, so a
 * terminal state naming no next step leaves a first-time user guessing where
 * their assets went. So a run that has settled offers exactly two things: open
 * the batch, and start over with a clean form.
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

import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileVideo, FolderOpen, Images, RefreshCw, Upload } from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type JSX,
} from "react";

import { asApiError } from "../data/errors";
import { BackLink } from "../patterns/BackLink";
import { parentLabel } from "../patterns/parentLabel";
import { Alert, Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/Card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { Progress } from "../primitives/Feedback";
import { FieldError, FieldHint, Input, Label } from "../primitives/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
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
  /** Up to the project this is ingesting into (#199). */
  readonly onBack?: () => void;
}

export function IngestScreen({ projectId, onOpenBatch, onBack }: IngestScreenProps): JSX.Element {
  const project = useProject(projectId);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [fps, setFps] = useState(String(DEFAULT_EXTRACTION_FPS));
  const [batchChoice, setBatchChoice] = useState(NEW_BATCH);
  const [batchName, setBatchName] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  // Whether the extraction-rate dialog is open. Only ever true for a clip.
  const [asking, setAsking] = useState(false);
  // Bumped by `again()` and used as the dropzone's `key`. See there.
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
   * Found by #59's browser cycle, which is the only test that walks from one screen
   * to another after a background job.
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

  // Only a draft batch may take an ingest. Anything else is refused at the launch
  // with 409 `BATCH_NOT_EDITABLE`, so offering one would be offering a refusal.
  const draftBatches = (batches.data?.items ?? []).filter((batch) => batch.state === "draft");

  /**
   * The primary action of step 1 — which for a clip does not register anything.
   *
   * A video needs a rate, and the rate is asked rather than assumed, so this opens
   * the dialog and the *dialog* registers. Images have no rate to ask about, so
   * they go straight up.
   */
  function upload(): void {
    if (isVideo) {
      setAsking(true);
      return;
    }
    register.mutate({ files }, { onSuccess: (registered) => setSource(registered) });
  }

  /**
   * Accepting the dialog: register the clip at the rate that was confirmed.
   *
   * The rate is written back to the screen before the request, so `again()` has one
   * place to clear and a second attempt after a refusal opens on the rate that was
   * refused rather than on the default. The dialog closes on success only — a
   * refusal leaves it open, holding its own draft, so it can be corrected there.
   */
  function registerVideo(rate: number): void {
    setFps(String(rate));
    register.mutate(
      { files, extractionFps: rate },
      {
        onSuccess: (registered) => {
          setSource(registered);
          setAsking(false);
        },
      },
    );
  }

  /**
   * Back to a clean form — the whole of "ingest a second source without a reload".
   *
   * Every piece of the flow is cleared, including both mutations: a stale
   * `register.isError` left behind would sit above an empty dropzone as a
   * refusal of files nobody has chosen yet. The run itself is untouched — it is
   * a row on the server and this is a form, so starting over here neither
   * cancels nor forgets what was ingested.
   *
   * The dropzone is *remounted* rather than reset, because an `<input
   * type="file">` keeps the selection it already holds: clearing our own `files`
   * state leaves the element still holding the last pick, and a picker asked for
   * that same file again may report no change at all. A fresh element has
   * nothing to compare against.
   */
  function again(): void {
    setFiles([]);
    setFps(String(DEFAULT_EXTRACTION_FPS));
    setBatchChoice(NEW_BATCH);
    setBatchName("");
    setSource(null);
    setJobId(null);
    setAsking(false);
    setAttempt((previous) => previous + 1);
    register.reset();
    start.reset();
  }

  function launch(): void {
    if (source === null) return;
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

  return (
    <div className="flex flex-col gap-6" data-testid="ingest-screen">
      {onBack !== undefined && <BackLink onClick={onBack} label={parentLabel(project.data?.name)} />}

      <header className="border-b border-border pb-4">
        <h1 className="text-page font-semibold tracking-tight">Ingest</h1>
        <p className="text-meta text-muted-foreground">
          A source is registered once; ingesting it again creates nothing new.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="size-4 text-muted-foreground" aria-hidden="true" />
            1 · Choose files
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Dropzone key={attempt} files={files} onFiles={setFiles} />

          {/* While the dialog is open it owns the refusal — one `register-error`
              on the page at a time, shown where the value that caused it was
              typed. */}
          {!asking && register.isError && (
            <FieldError data-testid="register-error">
              {asApiError(register.error).code}: {asApiError(register.error).message}
            </FieldError>
          )}

          <div>
            <Button
              variant="primary"
              data-testid="register-source"
              // No `fps` term: the rate is not on this card any more, and a button
              // disabled by a value nobody can see is a control with no explanation.
              // The dialog's own action holds that gate.
              disabled={files.length === 0 || register.isPending}
              onClick={upload}
            >
              {register.isPending ? "Uploading…" : "Register source"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {source !== null && (
        <Card data-testid="source-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {source.kind === "video" ? (
                <FileVideo className="size-4 text-muted-foreground" aria-hidden="true" />
              ) : (
                <Images className="size-4 text-muted-foreground" aria-hidden="true" />
              )}
              2 · {source.name}
              <Badge>{source.kind}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {source.video !== null && source.video !== undefined && (
              <dl className="grid grid-cols-2 gap-2 text-body md:grid-cols-3" data-testid="probe">
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
                    Math.floor(source.video.duration_seconds * source.video.extraction_fps),
                  )}
                />
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
                <FieldHint>Only a draft batch can take new assets.</FieldHint>
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
                  <FieldHint>Defaults to the source name.</FieldHint>
                </div>
              )}
            </div>

            {start.isError && (
              <FieldError data-testid="start-error">
                {asApiError(start.error).code}: {asApiError(start.error).message}
              </FieldError>
            )}

            <div>
              <Button
                variant="primary"
                data-testid="start-ingest"
                disabled={start.isPending || jobId !== null}
                onClick={launch}
              >
                {start.isPending ? "Starting…" : "Start ingest"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {jobId !== null && (
        <RunCard
          job={job.data ?? null}
          {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
          onAgain={again}
        />
      )}

      {/* Mounted only while it is open. Radix portals its content, but the children
          of `DialogContent` are an *argument* and are evaluated on every render of
          this screen regardless — and mounting on demand is also what seeds the
          dialog's draft rate with a plain `useState` instead of an effect. */}
      {asking && files.length === 1 && (
        <ExtractionRateDialog
          fileName={files[0].name}
          initial={fps}
          pending={register.isPending}
          error={register.isError ? register.error : null}
          onAccept={registerVideo}
          onCancel={() => {
            setAsking(false);
            register.reset();
          }}
        />
      )}
    </div>
  );
}

/**
 * The extraction rate, asked before a clip is registered (#234).
 *
 * The rate cannot be changed later — source idempotency is on
 * `(kind, path, extraction_fps)`, so re-registering the same clip at another rate
 * produces a *second* source rather than correcting the first. `DESIGN.md` asks a
 * dialog standing in front of something irreversible to say what it costs, so the
 * description states that rather than leaving it to a hint under a field.
 *
 * The draft lives here, not on the screen. That is the whole of "Cancel takes no
 * action": a rate typed and then abandoned goes with the dialog, so the next press
 * of `Register source` opens on the last *accepted* value and never on a discarded
 * one. Escape, the overlay and `DialogContent`'s own close button all arrive as
 * `onOpenChange(false)`, so there is one cancel path and not four.
 *
 * The accept gate is `Number.isFinite(rate) && rate > 0` rather than the `!(rate
 * <= 0)` the button it replaces used, because **every comparison with `NaN` is
 * false** — so `<= 0` would let a `NaN` through and upload `extraction_fps=NaN`.
 * `Number("")` is `0`, but an `<input type="number">` also reports a rejected
 * keystroke as an empty string, so both are reachable by typing rather than only by
 * pasting.
 */
function ExtractionRateDialog({
  fileName,
  initial,
  pending,
  error,
  onAccept,
  onCancel,
}: {
  readonly fileName: string;
  readonly initial: string;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onAccept: (rate: number) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(initial);
  const rate = Number(draft);
  const usable = Number.isFinite(rate) && rate > 0;

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!usable || pending) return;
    onAccept(rate);
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent data-testid="extraction-rate-dialog">
        <DialogTitle>Extraction rate</DialogTitle>
        <DialogDescription>
          <strong className="font-medium">{fileName}</strong> is decomposed into frames at this
          rate. It is chosen before the clip is probed, because the rate is part of what the
          source <em>is</em> — registering the same clip at another rate creates a second
          source rather than changing this one.
        </DialogDescription>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex max-w-xs flex-col gap-1.5">
            <Label htmlFor="extraction-fps">Frames per second</Label>
            <Input
              id="extraction-fps"
              data-testid="extraction-fps"
              type="number"
              min="0.1"
              step="0.1"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoFocus
            />
            <FieldHint>The kernel's default is one frame per second.</FieldHint>
          </div>

          {error !== null && (
            <FieldError data-testid="register-error">
              {asApiError(error).code}: {asApiError(error).message}
            </FieldError>
          )}

          <DialogFooter>
            <Button
              variant="secondary"
              data-testid="extraction-rate-cancel"
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              data-testid="extraction-rate-accept"
              disabled={!usable || pending}
            >
              {pending ? "Uploading…" : "Register"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function RunCard({
  job,
  onOpenBatch,
  onAgain,
}: {
  readonly job: IngestJob | null;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onAgain: () => void;
}): JSX.Element {
  const resume = useResumeIngest();

  return (
    <Card data-testid="run-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          3 · Run
          {job !== null && (
            <Badge
              variant={job.state === "failed" ? "destructive" : job.state === "completed" ? "outline" : "accent"}
              data-testid="run-state"
            >
              {job.state}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {job === null ? (
          <p className="text-body text-muted-foreground">Starting…</p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <p className="text-meta text-muted-foreground" data-testid="run-progress">
                {job.total === null || job.total === undefined
                  ? // A clip has no denominator until it is over: `VideoMetadata`
                    // carries no frame count, by design.
                    `${job.processed} extracted`
                  : `${job.processed} of ${job.total}`}
              </p>
              <Progress
                aria-label="Ingest progress"
                value={
                  job.total === null || job.total === undefined
                    ? job.state === "completed"
                      ? 100
                      : 0
                    : Math.round((job.processed / Math.max(job.total, 1)) * 100)
                }
              />
            </div>

            {job.error !== null && job.error !== undefined && (
              <Alert variant="destructive" title="The run stopped" data-testid="run-error">
                {job.error}
              </Alert>
            )}

            {job.failures.length > 0 && <Failures failures={job.failures} />}

            {job.state === "failed" && (
              <div>
                <Button
                  variant="secondary"
                  data-testid="resume-ingest"
                  disabled={resume.isPending}
                  onClick={() => resume.mutate(job.id)}
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  {resume.isPending ? "Resuming…" : "Resume"}
                </Button>
                <FieldHint>
                  A resume is a redo, not a skip — nothing records which files already
                  succeeded, and content addressing makes re-reading them free.
                </FieldHint>
              </div>
            )}

            {(job.state === "completed" || job.state === "failed") && (
              <Outcome
                job={job}
                {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
                onAgain={onAgain}
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
}: {
  readonly job: IngestJob;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onAgain: () => void;
}): JSX.Element {
  const batchId = job.batch_id ?? null;
  // Resolved at enqueue, so it survives a run that never reached the batch.
  const batchName = job.batch_name ?? "the batch";
  const partial = job.state === "failed" || job.failures.length > 0;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4" data-testid="run-outcome">
      <p className="text-body">
        {batchId === null ? (
          // `enqueue` only stores an id it was handed, and one is handed only
          // when the launch targeted an existing draft. A run that died before
          // it materialized its own batch therefore has nothing to open — and
          // saying so is more use than a button that cannot work.
          <>This run never reached a batch, so there is nothing to open yet.</>
        ) : partial ? (
          <>
            What this run managed to read is in{" "}
            <strong className="font-medium">{batchName}</strong>.
          </>
        ) : (
          <>
            Everything this run read is in <strong className="font-medium">{batchName}</strong>.
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {batchId !== null && onOpenBatch !== undefined && (
          <Button variant="primary" data-testid="open-batch" onClick={() => onOpenBatch(batchId)}>
            <FolderOpen className="size-4" aria-hidden="true" />
            Open batch
          </Button>
        )}
        <Button variant="secondary" data-testid="ingest-another" onClick={onAgain}>
          <Upload className="size-4" aria-hidden="true" />
          Ingest another source
        </Button>
      </div>
    </div>
  );
}

/**
 * The per-file report.
 *
 * Grouped by `kind`, which is the whole reason `IngestFailureKind` exists: an
 * `unsupported` file is operator noise — a `.txt` in a directory of photographs —
 * and a `corrupt` one is data loss. Reading fifty rows to notice that one of them
 * is the second kind is exactly the mistake a table can prevent.
 */
function Failures({ failures }: { readonly failures: readonly IngestFailure[] }): JSX.Element {
  const corrupt = failures.filter((failure) => failure.kind === "corrupt");
  const unsupported = failures.filter((failure) => failure.kind === "unsupported");

  return (
    <div className="flex flex-col gap-2" data-testid="failures">
      <p className="flex items-center gap-2 text-body">
        <AlertTriangle className="size-4 text-destructive" aria-hidden="true" />
        {failures.length} file{failures.length === 1 ? "" : "s"} could not be read
        {corrupt.length > 0 && (
          <Badge variant="destructive" data-testid="corrupt-count">
            {corrupt.length} corrupt
          </Badge>
        )}
        {unsupported.length > 0 && (
          <Badge data-testid="unsupported-count">{unsupported.length} unsupported</Badge>
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
              <TableCell className="font-mono text-meta" title={failure.name}>
                {basename(failure.name)}
              </TableCell>
              <TableCell>
                <Badge variant={failure.kind === "corrupt" ? "destructive" : "neutral"}>
                  {failure.kind}
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
 */
function Dropzone({
  files,
  onFiles,
}: {
  readonly files: readonly File[];
  readonly onFiles: (files: readonly File[]) => void;
}): JSX.Element {
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
      <p className="text-body">Drop images or a video here</p>
      <p className="text-meta text-muted-foreground">
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
      {files.length > 0 && (
        <p className="text-meta text-muted-foreground" data-testid="chosen">
          {files.length === 1 ? files[0].name : `${files.length} files`}
        </p>
      )}
    </div>
  );
}
