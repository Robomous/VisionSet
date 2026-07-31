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
 */

import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileVideo, Images, RefreshCw, Upload } from "lucide-react";
import { useEffect, useMemo, useState, type ChangeEvent, type DragEvent, type JSX } from "react";

import { asApiError } from "../data/errors";
import { Alert, Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/Card";
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
}

export function IngestScreen({ projectId }: IngestScreenProps): JSX.Element {
  const [files, setFiles] = useState<readonly File[]>([]);
  const [fps, setFps] = useState(String(DEFAULT_EXTRACTION_FPS));
  const [batchChoice, setBatchChoice] = useState(NEW_BATCH);
  const [batchName, setBatchName] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

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

  function upload(): void {
    register.mutate(
      { files, ...(isVideo ? { extractionFps: Number(fps) } : {}) },
      { onSuccess: (registered) => setSource(registered) },
    );
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
          <Dropzone files={files} onFiles={setFiles} />

          {isVideo && (
            <div className="flex max-w-sm flex-col gap-1.5">
              <Label htmlFor="extraction-fps">Extraction rate (fps)</Label>
              <Input
                id="extraction-fps"
                data-testid="extraction-fps"
                type="number"
                min="0.1"
                step="0.1"
                value={fps}
                onChange={(event) => setFps(event.target.value)}
              />
              <FieldHint>
                Chosen before the clip is probed — the rate is part of what the source{" "}
                <em>is</em>, so it has to be decided at registration. Registering the same clip
                at another rate creates a second source.
              </FieldHint>
            </div>
          )}

          {register.isError && (
            <FieldError data-testid="register-error">
              {asApiError(register.error).code}: {asApiError(register.error).message}
            </FieldError>
          )}

          <div>
            <Button
              variant="primary"
              data-testid="register-source"
              disabled={files.length === 0 || register.isPending || Number(fps) <= 0}
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

      {jobId !== null && <RunCard job={job.data ?? null} />}
    </div>
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

function RunCard({ job }: { readonly job: IngestJob | null }): JSX.Element {
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
          </>
        )}
      </CardContent>
    </Card>
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
