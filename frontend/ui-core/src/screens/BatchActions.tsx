/**
 * What a batch may be asked to do, in its panel on the Overview — the one place
 * a batch moves forward, now that it has no page of its own.
 *
 * Every control is the shared one, with its own gating, refusals and outcome
 * line: *Approve* opens the partition dialog, *Start annotating*, *Complete*,
 * *Complete and promote*, *Promote* and *Create correction batch* are the
 * components of their own (`BatchLifecycle.tsx`, `ComposedTransitions.tsx`,
 * `PromoteButton.tsx`, `CorrectionBatch.tsx`), and the overflow holds *Delete batch*. Each is
 * offered from what the batch's `allowed_actions` declares, never from its
 * state, and each says what it did — a label flip is not feedback.
 *
 * One control is filled: the batch's forward step. *Annotate* is filled while
 * there is work left; once nothing is outstanding, *Complete and promote* is.
 */

import { Check, Pencil, WandSparkles } from "lucide-react";
import { useState, type JSX } from "react";

import { Button } from "@robomous/ui-core";
import { BATCH_ACTION, declares } from "../data/capabilities";
import type { BatchRowView } from "../patterns/project/BatchTable";
import { ApproveDialog, CompleteBatchButton, StartAnnotatingButton } from "./BatchLifecycle";
import { outstandingWork } from "./batchState";
import { CompleteAndPromoteButton } from "./ComposedTransitions";
import { CorrectionButton } from "./CorrectionBatch";
import { BatchOverflowMenu } from "./DeleteBatch";
import { PromoteButton } from "./PromoteButton";
import type { Batch } from "./queries";

const ICON = "size-3.5";
const STROKE = 1.75;
/** Each control's outcome line sits under its own button, so the footer's controls align on their tops. */
const STACK = "flex flex-col items-end gap-1";

export interface BatchActionsProps {
  readonly batch: Batch;
  readonly projectId: string;
  readonly phase: BatchRowView["phase"];
  /** How many corrections of this batch exist, for the correction dialog's suggested name. */
  readonly existingCorrections: number;
  /** The batch's one open job, straight into the editor; absent when there is not exactly one. */
  readonly onAnnotate?: () => void;
  readonly onPrelabel?: () => void;
  /** A correction just cut: the panel moves to it. */
  readonly onOpenBatch?: (batchId: string) => void;
  /** Where a promotion lands. */
  readonly onOpenDataset?: () => void;
  /** The approve dialog's remedy when the project has no schema to pin. */
  readonly onOpenSchema?: () => void;
  /** The batch is gone, so the panel closes. */
  readonly onDeleted?: () => void;
}

export function BatchActions({ batch, projectId, phase, existingCorrections, onAnnotate, onPrelabel, onOpenBatch, onOpenDataset, onOpenSchema, onDeleted }: BatchActionsProps): JSX.Element {
  const toDataset = onOpenDataset === undefined ? {} : { onOpenDataset };
  return (
    <>
      <Housekeeping batch={batch} projectId={projectId} {...(onPrelabel === undefined ? {} : { onPrelabel })} {...(onDeleted === undefined ? {} : { onDeleted })} />
      <CorrectionButton batch={batch} projectId={projectId} existingCorrections={existingCorrections} size="lg" {...(onOpenBatch === undefined ? {} : { onOpenBatch })} />
      <Forward batch={batch} phase={phase} {...(onAnnotate === undefined ? {} : { onAnnotate })} {...(onOpenSchema === undefined ? {} : { onOpenSchema })} />
      <Finish batch={batch} projectId={projectId} phase={phase} {...toDataset} />
    </>
  );
}

/** What is not a step forward: the overflow (Delete) and Auto-label, at the footer's start. */
function Housekeeping({
  batch,
  projectId,
  onPrelabel,
  onDeleted,
}: Pick<BatchActionsProps, "batch" | "projectId" | "onPrelabel" | "onDeleted">): JSX.Element {
  return (
    <div className="mr-auto flex items-center gap-1">
      <BatchOverflowMenu batch={batch} projectId={projectId} align="start" {...(onDeleted === undefined ? {} : { onDeleted })} />
      {onPrelabel !== undefined && declares(batch, BATCH_ACTION.preLabel) && (
        <Button variant="ghost" size="lg" onClick={onPrelabel} data-testid="sheet-prelabel">
          <WandSparkles data-icon="inline-start" className={ICON} strokeWidth={STROKE} aria-hidden="true" />
          Auto-label
        </Button>
      )}
    </div>
  );
}

/** Getting the work going: approve, start, and into the one job. */
function Forward({ batch, phase, onAnnotate, onOpenSchema }: Pick<BatchActionsProps, "batch" | "phase" | "onAnnotate" | "onOpenSchema">): JSX.Element {
  const [approving, setApproving] = useState(false);
  const finishing = isFinishing(batch);
  return (
    <>
      {/* Opens the dialog rather than sending anything: approval carries a
          partition, pins the schema and cuts the jobs, and has no route back. */}
      {declares(batch, BATCH_ACTION.approve) && (
        <Button size="lg" onClick={() => setApproving(true)} data-autofocus="" data-testid="approve-batch">
          <Check data-icon="inline-start" className={ICON} strokeWidth={STROKE} aria-hidden="true" />
          Approve
        </Button>
      )}
      {declares(batch, BATCH_ACTION.start) && <StartAnnotatingButton batch={batch} size="lg" className={STACK} />}
      {onAnnotate !== undefined && phase === "annotating" && (
        <Button variant={finishing ? "outline" : "default"} size="lg" onClick={onAnnotate} data-testid="sheet-annotate" data-autofocus={finishing ? undefined : ""}>
          <Pencil data-icon="inline-start" className={ICON} strokeWidth={STROKE} aria-hidden="true" />
          Annotate
        </Button>
      )}
      <ApproveDialog batch={approving ? batch : null} onClose={() => setApproving(false)} {...(onOpenSchema === undefined ? {} : { onOpenSchema })} />
    </>
  );
}

/** Closing the work: complete, and put it in the dataset. */
function Finish({ batch, projectId, phase, onOpenDataset }: Pick<BatchActionsProps, "batch" | "projectId" | "phase" | "onOpenDataset">): JSX.Element {
  const toDataset = onOpenDataset === undefined ? {} : { onOpenDataset };
  // `promote` stays declared once everything is in the trunk — an idempotent
  // union — so it is the forward step only while there is something to add.
  const promoting = declares(batch, BATCH_ACTION.promote) && phase !== "in_dataset";
  return (
    <>
      {declares(batch, BATCH_ACTION.complete) && <CompleteBatchButton batch={batch} size="lg" className={STACK} />}
      <CompleteAndPromoteButton batch={batch} projectId={projectId} variant={isFinishing(batch) ? "default" : "outline"} size="lg" className={STACK} {...toDataset} />
      <PromoteButton batch={batch} projectId={projectId} variant={promoting ? "default" : "outline"} size="lg" className={STACK} {...toDataset} />
    </>
  );
}

/** Nothing is outstanding and the batch may be completed: finishing it is the forward step. */
function isFinishing(batch: Batch): boolean {
  return declares(batch, BATCH_ACTION.complete) && outstandingWork(batch.progress) === 0;
}
