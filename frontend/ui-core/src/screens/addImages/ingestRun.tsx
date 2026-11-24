/**
 * A registered source's run: launch it at a batch, watch it finish, resume it
 * when it died. Images and scans share it; a clip does not (`clipImport.tsx`).
 *
 * ## Refusals split by when they can be known
 *
 * A refusal a request can make is made on the request, and that decides where
 * Add images shows it: an unknown batch is 404, a batch past `draft` is 409, a
 * blank name is 422, all of them before a job row exists — so those render on
 * the Frames & settings step, beside the target that caused them. Everything
 * after the launch is on the job: `error` is the one fatal cause, `failures` is
 * the per-item report.
 *
 * ## The per-item report says one thing about every row
 *
 * Every entry in `failures` is a file that produced no asset, which is what lets
 * the table state a count on that basis and group by *why*. `IngestFailureKind`
 * has two members since the server stopped decoding clips: a directory read is
 * all-or-nothing per file.
 *
 * ## `batch_id` is NOT there from the first poll
 *
 * `enqueue` stores the batch id it was *handed* — null for the common case of a
 * run creating its own batch — and the row learns the real id in the same
 * transaction that marks the job `completed`. So a run in flight has nothing to
 * open, a run that `failed` before it materialized a batch never gets one, and
 * nor does a completed run whose assets were all already batched. `batch_name`
 * is stored at enqueue when the launch named or targeted a batch — Add images
 * always does — and is null otherwise, so the outcome falls back to a phrase.
 */

import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useEffect, useState, type JSX } from "react";

import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@robomous/ui-core";
import { ProgressBar } from "../../patterns/ProgressBar";
import type { BadgeTone } from "../batchState";
import { useIngestJob, useResumeIngest, useStartIngest, type IngestFailure, type IngestJob, type Source } from "../queries";
import { NEW_BATCH, type Target } from "./IntoField";

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

/**
 * The same states, as tokens. **A finished run is `success`, because a finished
 * batch is**; `pending` and `running` keep the near-black, because work in
 * flight is the healthy state and `warning` means something waiting on a person.
 */
const RUN_STATE_VARIANT: Record<string, BadgeTone> = {
  pending: "default",
  running: "default",
  completed: "success",
  failed: "destructive",
};

/** `IngestFailureKind`: what is wrong with the file, said plainly. */
const FAILURE_KIND_LABEL: Record<string, string> = {
  unsupported: "Unsupported format",
  corrupt: "Corrupt file",
  unreadable: "Could not open",
  skipped: "Not a file",
};

export interface IngestRun {
  readonly jobId: string | null;
  readonly job: IngestJob | null;
  /** The run reached `completed` or `failed`. */
  readonly settled: boolean;
  readonly start: ReturnType<typeof useStartIngest>;
  readonly resume: ReturnType<typeof useResumeIngest>;
  readonly launch: (source: Source, target: Target) => void;
  /** Forget the run — it stays a row on the server; this is a form. */
  readonly reset: () => void;
}

export function useIngestRun(projectId: string): IngestRun {
  const [jobId, setJobId] = useState<string | null>(null);
  const start = useStartIngest(projectId);
  const resume = useResumeIngest();
  const job = useIngestJob(jobId);
  const state = job.data?.state;
  const queries = useQueryClient();

  /**
   * Refresh the project when the run **finishes**, not when it starts.
   *
   * `useStartIngest` invalidates on the launch, and at that moment there is
   * nothing to see: `ingest()` fills the batch and completes the job in its
   * *last* transaction, so the batch a run creates does not exist until the poll
   * says `completed`. The hook lives as long as the Add images dialog's host,
   * not as long as the dialog is open, so a run somebody closed the dialog on
   * still refreshes the batch table when it lands.
   */
  useEffect(() => {
    if (state !== "completed" && state !== "failed") return;
    void queries.invalidateQueries({ queryKey: ["projects", projectId] });
  }, [state, projectId, queries]);

  const startReset = start.reset;
  const resumeReset = resume.reset;

  return {
    jobId,
    job: job.data ?? null,
    settled: state === "completed" || state === "failed",
    start,
    resume,
    launch: (source, target) => {
      if (start.isPending) return;
      start.mutate(
        {
          sourceId: source.id,
          ...(target.choice === NEW_BATCH
            ? { batchName: target.name.trim() === "" ? source.name : target.name.trim() }
            : { batchId: target.choice }),
        },
        { onSuccess: (launched) => setJobId(launched.id) },
      );
    },
    reset: () => {
      setJobId(null);
      startReset();
      resumeReset();
    },
  };
}

export function RunStateBadge({ state }: { readonly state: string }): JSX.Element {
  return (
    <Badge variant={RUN_STATE_VARIANT[state] ?? "secondary"} data-testid="run-state">
      {RUN_STATE_LABEL[state] ?? state}
    </Badge>
  );
}

/** A directory states its total before the first file, so the bar has a denominator. */
export function ingestFraction(job: IngestJob): number {
  if (job.total === null || job.total === undefined) return job.state === "completed" ? 1 : 0;
  return job.processed / Math.max(job.total, 1);
}

/** Bound once, so `value` and the `aria-valuenow` the primitive draws never disagree. */
export function IngestProgress({ job }: { readonly job: IngestJob }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <p className="text-muted-foreground tabular-nums" data-testid="run-progress">
          {job.total === null || job.total === undefined ? `${job.processed} extracted` : `${job.processed} of ${job.total}`}
        </p>
        <RunStateBadge state={job.state} />
      </div>
      <ProgressBar aria-label="Ingest progress" value={Math.round(ingestFraction(job) * 100)} />
    </div>
  );
}

/**
 * A source's name, fit for a sentence.
 *
 * A **staged upload of images** is named by its content digest when nobody
 * named it — 64 hex characters nobody can read. Shortened for display, the full
 * string kept in `title`, and never a name the source does not have.
 */
export function sourceLabel(name: string): string {
  return /^[0-9a-f]{64}$/.test(name) ? `${name.slice(0, 8)}…` : name;
}

/**
 * The per-file report of what did *not* arrive, grouped by kind: an
 * `unsupported` file is operator noise, a `corrupt` one is data loss, and
 * reading fifty rows to notice the second is the mistake a table can prevent.
 */
export function Failures({ failures }: { readonly failures: readonly IngestFailure[] }): JSX.Element | null {
  const corrupt = failures.filter((failure) => failure.kind === "corrupt");
  const unsupported = failures.filter((failure) => failure.kind === "unsupported");
  const rest = failures.filter((failure) => failure.kind !== "corrupt" && failure.kind !== "unsupported");
  const refused = failures.length;
  if (refused === 0) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="failures">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <TriangleAlert className="size-4 text-destructive" aria-hidden="true" />
        <span className="tabular-nums">
          {refused} file{refused === 1 ? "" : "s"} could not be read
        </span>
        {corrupt.length > 0 && (
          <Badge variant="destructive" data-testid="corrupt-count">
            {corrupt.length} corrupt
          </Badge>
        )}
        {unsupported.length > 0 && (
          <Badge variant="secondary" data-testid="unsupported-count">
            {unsupported.length} unsupported
          </Badge>
        )}
      </p>
      <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead className="w-32">Kind</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...corrupt, ...unsupported, ...rest].map((failure, index) => (
              <TableRow key={`${failure.name}-${index}`} data-testid={`failure-${index}`}>
                <TableCell className="font-mono text-xs" title={failure.name}>
                  {basename(failure.name)}
                </TableCell>
                <TableCell>
                  <Badge variant={failure.kind === "corrupt" ? "destructive" : "secondary"}>
                    {FAILURE_KIND_LABEL[failure.kind] ?? failure.kind}
                  </Badge>
                </TableCell>
                <TableCell className="text-pretty text-muted-foreground">{failure.reason}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * The last segment of whatever the report called the file. For a **directory**
 * ingest `IngestFailure.name` is the full server path — a known kernel
 * inconsistency, deliberately left alone — so a path from somebody else's
 * machine stays in the `title` and out of the table.
 */
function basename(name: string): string {
  const segments = name.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] || name;
}
