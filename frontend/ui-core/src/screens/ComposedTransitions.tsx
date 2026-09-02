/**
 * Two lifecycle steps behind one control: *Approve and start*, and *Complete
 * and promote*.
 *
 * Nothing here is a new transition. Each control sends the same two requests a
 * person could send one at a time, in order, and stops where the kernel stops
 * it: a refusal on the second step leaves the batch in the state the first step
 * reached, and the control says so — the first step's outcome as a line, the
 * second step's refusal beneath it, never in its place. There is no rollback to
 * simulate, because `start` needs only `approved` and `promote` needs only
 * `completed`; the intermediate state is reachable by an infrastructure failure
 * alone, and the line is what makes it legible.
 *
 * Each control is offered on the **first** step's declaration. The two steps
 * are never declared together — `approve` on a draft, `start` on an approved
 * batch — so the second step's legality is a consequence of the first
 * succeeding, not something the wire can say in advance. A control keeps its
 * own record of having been pressed: once the first step lands the batch's
 * declaration moves on and the control would otherwise unmount with it, taking
 * the line and the refusal along.
 */

import { ArrowRight, ArrowUpToLine, FolderOpen, Play } from "lucide-react";
import { useState, type JSX } from "react";

import { asApiError } from "../data/errors";
import { BATCH_ACTION, declares } from "../data/capabilities";
import { refusalProse } from "../data/refusals";
import { Button, FieldError } from "@robomous/ui-core";
import { outstandingWork } from "./batchState";
import { promotionSummary } from "./PromoteButton";
import {
  useActiveSchema,
  useApproveBatch,
  useBatch,
  useBatchTransition,
  useFinishBatch,
  usePromoteBatch,
  type Batch,
  type FinishBatchResult,
} from "./queries";

/** What `SchemaService.require_active` raises for a project that has none. */
const SCHEMA_NOT_FOUND = "SCHEMA_NOT_FOUND";

// --- approve and start --------------------------------------------------------

export interface ApproveAndStartButtonProps {
  readonly batch: Batch;
  readonly projectId: string;
  /** The ingest outcome card's own filled control; a table row's is outline. */
  readonly variant?: "default" | "outline";
  readonly size?: "sm" | "default";
  readonly className?: string;
}

/**
 * `draft → approved → in_annotation`, cut into one job — the common batch.
 *
 * Offered only while the project has an active schema: approval pins one, and
 * `allowed_actions` cannot say whether there is one to pin, because that is a
 * fact about the project rather than a state of the batch. Without a schema the
 * hosts keep their existing controls, whose refusal names the remedy.
 */
export function ApproveAndStartButton({
  batch,
  projectId,
  variant = "outline",
  size = "sm",
  className,
}: ApproveAndStartButtonProps): JSX.Element | null {
  const schema = useActiveSchema(projectId);
  const approve = useApproveBatch(batch.id);
  const start = useBatchTransition(batch.id, "start");
  const [approved, setApproved] = useState<Batch | null>(null);

  const offered = declares(batch, BATCH_ACTION.approve) && schema.isSuccess;
  if (!offered && approved === null) return null;

  const pending = approve.isPending || start.isPending;
  const label = approve.isPending
    ? "Approving…"
    : start.isPending
      ? "Starting…"
      : "Approve and start";

  return (
    <div className={className ?? "flex flex-col items-end gap-1"}>
      {offered && (
        <Button
          variant={variant}
          size={size}
          data-testid={`approve-start-${batch.name}`}
          disabled={pending}
          onClick={() =>
            approve.mutate(
              { kind: "single" },
              {
                onSuccess: (result) => {
                  setApproved(result);
                  start.mutate();
                },
              },
            )
          }
        >
          <Play aria-hidden="true" />
          {label}
        </Button>
      )}
      {approved !== null && (
        <span className="text-xs text-muted-foreground" data-testid={`approved-${batch.name}`}>
          Approved against v{approved.schema_version}
          {start.isSuccess ? ", and open for annotation." : "."}
        </span>
      )}
      {approve.isError && (
        <FieldError data-testid={`approve-start-error-${batch.name}`}>
          {refusalProse(approve.error)}
        </FieldError>
      )}
      {start.isError && (
        <FieldError data-testid={`approve-start-error-${batch.name}`}>
          {refusalProse(start.error)}
        </FieldError>
      )}
    </div>
  );
}

// --- complete and promote -----------------------------------------------------

export interface CompleteAndPromoteButtonProps {
  readonly batch: Batch;
  readonly projectId: string;
  /** The dataset screen, so a promotion can be followed to where it landed. */
  readonly onOpenDataset?: () => void;
  readonly className?: string;
}

/**
 * `in_annotation → completed`, then the union into the trunk. Withheld while
 * work is outstanding, exactly as *Complete* is beside it — the count is that
 * control's to say, once.
 */
export function CompleteAndPromoteButton({
  batch,
  projectId,
  onOpenDataset,
  className,
}: CompleteAndPromoteButtonProps): JSX.Element | null {
  const finish = useFinishBatch(batch.id);
  const promote = usePromoteBatch(projectId);
  const [completed, setCompleted] = useState<FinishBatchResult | null>(null);

  const offered = declares(batch, BATCH_ACTION.complete);
  if (!offered && completed === null) return null;

  const outstanding = outstandingWork(batch.progress);
  const pending = finish.isPending || promote.isPending;
  const label = finish.isPending
    ? "Completing…"
    : promote.isPending
      ? "Promoting…"
      : "Complete and promote";
  const summary = promote.isSuccess
    ? promotionSummary(promote.data.total, batch.promoted_asset_count, batch.asset_count)
    : null;

  return (
    <div className={className ?? "flex flex-col items-end gap-1"}>
      {offered && (
        <Button
          variant="outline"
          size="sm"
          data-testid={`complete-promote-${batch.name}`}
          disabled={outstanding > 0 || pending}
          onClick={() =>
            finish.mutate(undefined, {
              onSuccess: (result) => {
                setCompleted(result);
                promote.mutate(batch.id);
              },
            })
          }
        >
          <ArrowUpToLine aria-hidden="true" />
          {label}
        </Button>
      )}
      {completed !== null && (
        <span className="text-xs text-muted-foreground" data-testid={`completed-${batch.name}`}>
          Completed
          {completed.jobsFinished > 0
            ? `, finishing ${completed.jobsFinished} job${completed.jobsFinished === 1 ? "" : "s"}.`
            : "."}
          {summary === null ? "" : ` ${summary}`}
        </span>
      )}
      {promote.isSuccess && onOpenDataset !== undefined && (
        <Button
          variant="link"
          data-testid={`complete-promote-open-dataset-${batch.name}`}
          onClick={onOpenDataset}
        >
          Open the dataset
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Button>
      )}
      {finish.isError && (
        <FieldError data-testid={`complete-promote-error-${batch.name}`}>
          {refusalProse(finish.error)}
        </FieldError>
      )}
      {promote.isError && (
        <FieldError data-testid={`complete-promote-error-${batch.name}`}>
          {refusalProse(promote.error)}
        </FieldError>
      )}
    </div>
  );
}

// --- the ingest outcome card's next step ------------------------------------

export interface OutcomeNextStepProps {
  readonly projectId: string;
  readonly batchId: string;
  readonly onOpenBatch?: (batchId: string) => void;
  /** The project's schema section, for the remedy when there is no schema to pin. */
  readonly onOpenSchema?: () => void;
}

/**
 * What a settled ingest offers over the batch it filled.
 *
 * The card is the only thing the stepper shows once a run settles, so it is a
 * view of its own and may carry one filled control. With an active schema that
 * is *Approve and start*, and *Open batch* steps down to secondary; without one
 * the card keeps *Open batch* filled and says, in words, what approving needs
 * and where to get it. Only a 404 for the schema is "none": any other failure
 * of that read says nothing about the project, and the card offers what it
 * always did.
 */
export function OutcomeNextStep({
  projectId,
  batchId,
  onOpenBatch,
  onOpenSchema,
}: OutcomeNextStepProps): JSX.Element {
  const batch = useBatch(batchId);
  const schema = useActiveSchema(projectId);
  const noSchema = schema.isError && asApiError(schema.error).code === SCHEMA_NOT_FOUND;
  const composable =
    schema.isSuccess && batch.data !== undefined && declares(batch.data, BATCH_ACTION.approve);
  const [pressed, setPressed] = useState(false);
  const composed = composable || pressed;

  return (
    <>
      {noSchema && (
        <p
          className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
          data-testid="approve-needs-schema"
        >
          Approving needs a schema.{" "}
          {onOpenSchema === undefined ? (
            "Define one"
          ) : (
            <button
              type="button"
              className="text-foreground underline underline-offset-2"
              data-testid="approve-needs-schema-go"
              onClick={onOpenSchema}
            >
              Define one
            </button>
          )}{" "}
          and the batch can start from its row.
        </p>
      )}
      {composed && batch.data !== undefined && (
        <div onClickCapture={() => setPressed(true)}>
          <ApproveAndStartButton
            batch={batch.data}
            projectId={projectId}
            variant="default"
            size="default"
            className="flex flex-col items-start gap-1"
          />
        </div>
      )}
      {onOpenBatch !== undefined && (
        <Button
          variant={composed ? "outline" : "default"}
          data-testid="open-batch"
          onClick={() => onOpenBatch(batchId)}
        >
          <FolderOpen aria-hidden="true" />
          Open batch
        </Button>
      )}
    </>
  );
}
