/**
 * Step 3, Batch: the run or the import, then the batch it filled and the two
 * ways on — approve it here, or add another source first.
 *
 * ## The outcome is offered, never taken
 *
 * No redirect on completion, because the same step carries the per-file report
 * and a run with `corrupt` rows is exactly the one whose report must be read. A
 * `failed` run gets the outcome too: a partial run has a batch, and "some of it
 * did land" is the thing nobody would otherwise be told.
 *
 * ## Approving is the step's own content, not a dialog over it
 *
 * One modal deep (`DESIGN.md`): *Approve batch* swaps the step's body for the
 * approval — the same form `ApproveDialog` draws, `ApproveFields` — and its
 * buttons take the footer. A refusal stays in place, beside what it refused.
 *
 * ## The outcome quotes the batch's number, not the run's
 *
 * `processed` is not the size of the batch: content addressing collapses
 * identical items into one asset, so a run can put fewer assets in the batch
 * than it read. The count said here is the one the batch itself reports.
 */

import { Check, FolderOpen, RefreshCw, Stamp } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle, Button, FieldError, FieldDescription } from "@robomous/ui-core";
import { refusalProse } from "../../data/refusals";
import { assetNoun } from "../../lib/assetNoun";
import { formatCount } from "../../lib/format";
import { ProgressBar } from "../../patterns/ProgressBar";
import { ApproveFields, approveCost } from "../BatchLifecycle";
import { decodeProse } from "./clipImport";
import { Failures, IngestProgress, sourceLabel } from "./ingestRun";
import { PRESS } from "./motion";
import type { AddImagesFlow } from "./useAddImagesFlow";

export interface BatchStepProps {
  readonly flow: AddImagesFlow;
  /** The project has no schema: approving would be refused, so the step says so instead of offering it. */
  readonly noSchema: boolean;
  /** Approving is offered: an active schema, and a batch declaring `approve`. */
  readonly approvable: boolean;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onOpenSchema?: () => void;
}

export function BatchStep(props: BatchStepProps): JSX.Element {
  const { flow } = props;
  return (
    <div className="flex flex-col gap-4">
      {/* Approving swaps the step's content: the run is behind it, and what is in front is the batch. */}
      {!(flow.approving || flow.approved !== null) && (flow.kind === "video" ? <ImportProgress flow={flow} /> : <RunProgress flow={flow} />)}
      {flow.settled && <Outcome {...props} />}
      {flow.settled && flow.landed.length > 1 && (
        <p className="text-xs text-pretty text-muted-foreground" data-testid="landed">
          Added this time: {flow.landed.map((one) => `“${one.name}”`).join(", ")}.
        </p>
      )}
    </div>
  );
}

function RunProgress({ flow }: { readonly flow: AddImagesFlow }): JSX.Element {
  const { job, resume } = flow.run;
  return (
    <div className="flex flex-col gap-4" data-testid="run-card" aria-live="polite">
      {job === null ? (
        <p className="text-sm text-muted-foreground">Starting…</p>
      ) : (
        <>
          <IngestProgress job={job} />
          {!flow.settled && (
            <p className="text-xs text-pretty text-muted-foreground">
              You can close this — the run keeps going on the server, and its batch appears on the Overview when it lands.
            </p>
          )}
          {job.error !== null && job.error !== undefined && (
            <Alert variant="destructive" data-testid="run-error">
              <AlertTitle>The run stopped</AlertTitle>
              <AlertDescription>{job.error}</AlertDescription>
            </Alert>
          )}
          <Failures failures={job.failures} />
          {job.state === "failed" && (
            <div className="flex flex-col items-start gap-1.5">
              <Button variant="outline" className={PRESS} data-testid="resume-ingest" disabled={resume.isPending} onClick={() => resume.mutate(job.id)}>
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {resume.isPending ? "Resuming…" : "Resume"}
              </Button>
              <FieldDescription>
                A resume is a redo, not a skip — nothing records which files already succeeded, and content addressing makes re-reading them free.
              </FieldDescription>
              {/* The refusal of the *resume*, a different fact from the run's own
                  error above it — titled apart so a rejected resume never reads
                  as a press the page ignored. */}
              {resume.isError && (
                <Alert variant="destructive" data-testid="resume-error">
                  <AlertTitle>That resume was refused</AlertTitle>
                  <AlertDescription>{refusalProse(resume.error)}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ImportProgress({ flow }: { readonly flow: AddImagesFlow }): JSX.Element {
  const { clip } = flow;
  const { progress } = clip;
  return (
    <div className="flex flex-col gap-4" data-testid="import-card" aria-live="polite">
      {progress !== null && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground tabular-nums" data-testid="import-progress">
            {formatCount(progress.materialized)} of {formatCount(progress.expected)} frames
          </p>
          <ProgressBar
            aria-label="Video import progress"
            value={progress.expected === 0 ? 0 : Math.round((progress.materialized / progress.expected) * 100)}
          />
        </div>
      )}
      {clip.inFlight && (
        // Why Cancel is (or is no longer) offered, beside the footer's button:
        // the window closes at the commit, one transaction that cannot be taken back.
        <p className="text-xs text-pretty text-muted-foreground" data-testid="cancel-reason">
          {clip.commit.isPending
            ? "Too late to cancel: these frames are being turned into assets now, in one transaction that cannot be taken back."
            : "Cancel stops decoding and throws the staged frames away. No assets and no batch have been created yet, so there is nothing to undo afterwards. Closing this only hides it."}
        </p>
      )}
      {clip.cancelled && (
        <Alert data-testid="import-cancelled">
          <AlertTitle>That import was cancelled</AlertTitle>
          <AlertDescription>The staged frames were discarded. No assets and no batch were added to the project.</AlertDescription>
        </Alert>
      )}
      {clip.failure !== null && (
        <Alert variant="destructive" data-testid="import-error">
          <AlertTitle>The import stopped</AlertTitle>
          <AlertDescription>{decodeProse(clip.failure)}</AlertDescription>
        </Alert>
      )}
      {clip.commit.isError && (
        <Alert variant="destructive" data-testid="commit-error">
          <AlertTitle>Those frames were not committed</AlertTitle>
          <AlertDescription>{refusalProse(clip.commit.error)}</AlertDescription>
        </Alert>
      )}
      {clip.abort.isError && (
        <Alert variant="destructive" data-testid="abort-error">
          <AlertTitle>The staged frames could not be discarded</AlertTitle>
          <AlertDescription>{refusalProse(clip.abort.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** The batch a settled flow filled, and what can be done with it here. */
function Outcome({ flow, noSchema, approvable, onOpenBatch, onOpenSchema }: BatchStepProps): JSX.Element | null {
  if (flow.kind === "video") {
    // A cancelled or failed import made nothing; its alert above already says so.
    if (flow.clip.batch === null) return null;
  } else if (flow.batchId === null) {
    const job = flow.run.job;
    if (job === null) return null;
    return (
      <p className="text-sm text-pretty" data-testid="run-outcome">
        {job.state === "completed"
          ? "Everything this run read was already in a batch, so no new batch was made."
          : "This run never reached a batch, so there is nothing to open yet."}
      </p>
    );
  }

  const batchId = flow.batchId;
  const name = flow.batchName ?? "this run's batch";
  if (batchId === null) return null;

  if (flow.approved !== null || (flow.approving && flow.approval.approvedAt !== null && flow.approval.begin.isError)) {
    return (
      <div className="flex flex-col gap-3">
        <Landed tone="approved" testId="approved-outcome" title={<>“{sourceLabel(name)}” is approved</>} fullName={name}>
          {flow.approved ?? `Approved${flow.approval.approvedAt === null ? "" : ` against v${flow.approval.approvedAt}`}, but not started.`}
        </Landed>
        {flow.approval.begin.isError && (
          <div className="flex flex-col gap-1" data-testid="approve-start-error">
            <span className="text-xs text-muted-foreground">It couldn’t be started:</span>
            <FieldError>{refusalProse(flow.approval.begin.error)}</FieldError>
          </div>
        )}
      </div>
    );
  }

  if (flow.approving && flow.batch !== null) {
    return (
      <div className="flex flex-col gap-3" data-testid="approve-step">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-balance">Approve “{sourceLabel(flow.batch.name)}”?</p>
          <p className="text-xs text-pretty text-muted-foreground">{approveCost(flow.approval)}</p>
        </div>
        <ApproveFields form={flow.approval} {...(onOpenSchema === undefined ? {} : { onOpenSchema })} />
      </div>
    );
  }

  const count = flow.batch?.asset_count;
  const incomplete = flow.kind !== "video" && (flow.run.job?.state === "failed" || (flow.run.job?.failures.length ?? 0) > 0);
  const draft = flow.batch === null || flow.batch.state === "draft";
  return (
    <div className="flex flex-col gap-3">
      <Landed
        tone="ready"
        testId={flow.kind === "video" ? "import-outcome" : "run-outcome"}
        title={
          <>
            “{sourceLabel(name)}” is ready{draft ? ", as a draft" : ""}
          </>
        }
        fullName={name}
        aside={
          approvable && onOpenBatch !== undefined ? (
            <Button variant="ghost" size="sm" className={PRESS} data-testid="open-batch" onClick={() => onOpenBatch(batchId)}>
              <FolderOpen data-icon="inline-start" aria-hidden="true" />
              Open
            </Button>
          ) : undefined
        }
      >
        {flow.kind === "video"
          ? `Every frame this clip was cut into is in it. Identical frames collapse into one asset, so it can hold fewer than ${formatCount(flow.clip.expected)}.`
          : incomplete
            ? "What this run managed to read is in it."
            : "Everything this run read is in it."}
        {count !== undefined && (
          <span className="tabular-nums">
            {" "}
            It holds {formatCount(count)} {assetNoun(flow.kind === "scans" ? "point_cloud" : "image", count, flow.kind === "video" ? "frame" : "image")}.
          </span>
        )}
        {approvable && " Approve it to cut it into jobs, or add another source first."}
      </Landed>
      {noSchema && (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-pretty text-muted-foreground" data-testid="approve-needs-schema">
          Approving needs a schema.{" "}
          {onOpenSchema === undefined ? (
            "Define one"
          ) : (
            <button type="button" className="text-foreground underline underline-offset-2" data-testid="approve-needs-schema-go" onClick={onOpenSchema}>
              Define one
            </button>
          )}{" "}
          and the batch can be approved from its panel.
        </p>
      )}
    </div>
  );
}

function Landed({
  tone,
  title,
  fullName,
  aside,
  testId,
  children,
}: {
  readonly tone: "ready" | "approved";
  readonly title: ReactNode;
  /** The full name, for the title attribute — the heading may shorten a digest. */
  readonly fullName: string;
  readonly aside?: ReactNode;
  readonly testId: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/30 p-4" data-testid={testId}>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-success-surface text-success">
        {tone === "ready" ? <Check className="size-4" strokeWidth={2.5} aria-hidden="true" /> : <Stamp className="size-4" aria-hidden="true" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium text-balance" title={fullName}>
          {title}
        </p>
        <p className="text-xs text-pretty text-muted-foreground">{children}</p>
      </div>
      {aside}
    </div>
  );
}
