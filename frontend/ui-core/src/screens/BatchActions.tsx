/**
 * What a batch may be asked to do, in its panel on the Overview — the one place
 * a batch moves forward, now that it has no page of its own.
 *
 * **Every control is an icon button named by its tooltip** (`patterns/IconAction`),
 * and a withheld one keeps its tooltip with the reason. At the footer's start,
 * what ends or branches the batch: *Delete batch* (in the destructive colour, and
 * withheld with its reason once the batch is completed) and *Create correction
 * batch*. At its end, the forward step: *Approve*, *Start annotating*,
 * *Annotate* (filled while work is left), *Complete* (filled once nothing is
 * outstanding — a press opens its confirmation, whose switch decides whether the
 * images go into the dataset too) and *Add to dataset*. A batch already wholly in
 * the dataset has no forward step, and says so in a line instead of a button.
 * *Auto-label* is not here: it is the panel's top bar's.
 *
 * **What a control says is a line above the controls** — an outcome, a
 * refusal, a count. Each control renders its own lines marked `data-line`, and
 * the footer (`BatchSheet`) lays every one of them out on its first rows, so an
 * icon button's words never squeeze under a 32px square.
 *
 * Each is offered from what the batch's `allowed_actions` declares, never from
 * its state, and each says what it did — a label flip is not feedback. The UI
 * says "add to dataset" for the kernel's `promote`.
 */

import { ArrowRight, PenLine, Stamp } from "lucide-react";
import { useState, type JSX } from "react";

import { Button } from "@robomous/ui-core";
import { BATCH_ACTION, declares } from "../data/capabilities";
import { batchNoun } from "../lib/assetNoun";
import { IconAction } from "../patterns/IconAction";
import type { BatchRowView } from "../patterns/project/BatchTable";
import { ApproveDialog, StartAnnotatingButton } from "./BatchLifecycle";
import { outstandingWork } from "./batchState";
import { CompleteBatchButton } from "./ComposedTransitions";
import { CorrectionButton } from "./CorrectionBatch";
import { DeleteBatchButton } from "./DeleteBatch";
import { PromoteButton } from "./PromoteButton";
import type { Batch } from "./queries";

export interface BatchActionsProps {
  readonly batch: Batch;
  readonly projectId: string;
  readonly phase: BatchRowView["phase"];
  /** How many corrections of this batch exist, for the correction dialog's suggested name. */
  readonly existingCorrections: number;
  /** The batch's one open job, straight into the editor; absent when there is not exactly one. */
  readonly onAnnotate?: () => void;
  /** A correction just cut: the panel moves to it. */
  readonly onOpenBatch?: (batchId: string) => void;
  /** Where a promotion lands. */
  readonly onOpenDataset?: () => void;
  /** The approve dialog's remedy when the project has no schema to pin. */
  readonly onOpenSchema?: () => void;
  /** The batch is gone, so the panel closes. */
  readonly onDeleted?: () => void;
}

export function BatchActions({ batch, projectId, phase, existingCorrections, onAnnotate, onOpenBatch, onOpenDataset, onOpenSchema, onDeleted }: BatchActionsProps): JSX.Element {
  return (
    <>
      <DeleteBatchButton batch={batch} projectId={projectId} {...(onDeleted === undefined ? {} : { onDeleted })} />
      <CorrectionButton batch={batch} projectId={projectId} existingCorrections={existingCorrections} iconOnly {...(onOpenBatch === undefined ? {} : { onOpenBatch })} />
      {/* What ends or branches the batch at the start; the forward step at the end. */}
      <span aria-hidden="true" className="flex-1" />
      <Forward batch={batch} phase={phase} {...(onAnnotate === undefined ? {} : { onAnnotate })} {...(onOpenSchema === undefined ? {} : { onOpenSchema })} />
      <Finish batch={batch} projectId={projectId} phase={phase} {...(onOpenDataset === undefined ? {} : { onOpenDataset })} />
    </>
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
        <IconAction icon={Stamp} label="Approve" hint="Freezes its images and cuts it into jobs" variant="default" data-testid="approve-batch" data-autofocus="" onClick={() => setApproving(true)} />
      )}
      {declares(batch, BATCH_ACTION.start) && <StartAnnotatingButton batch={batch} />}
      {onAnnotate !== undefined && phase === "annotating" && (
        <IconAction
          icon={PenLine}
          label="Annotate"
          variant={finishing ? "outline" : "default"}
          data-testid="sheet-annotate"
          {...(finishing ? {} : { "data-autofocus": "" })}
          onClick={onAnnotate}
        />
      )}
      <ApproveDialog batch={approving ? batch : null} onClose={() => setApproving(false)} {...(onOpenSchema === undefined ? {} : { onOpenSchema })} />
    </>
  );
}

/**
 * Closing the work: complete, and add it to the dataset.
 *
 * *Add to dataset* is the forward step only while something is left to add:
 * `promote` stays declared once everything is in the trunk — an idempotent
 * union — and a press there could only report that nothing moved, so a batch
 * wholly in the dataset gets a line saying so instead. A curator removing one
 * of its images puts the batch back in `completed`, and the control with it.
 *
 * Each control keeps the place it was pressed from: once *Add to dataset* lands,
 * the batch reads `in_dataset` and the control would otherwise unmount with its
 * own report; once *Complete* lands both steps, a second *Add to dataset* beside
 * its report would be a step already taken. If its second step is refused, *Add
 * to dataset* stays — it is the retry.
 */
function Finish({ batch, projectId, phase, onOpenDataset }: Pick<BatchActionsProps, "batch" | "projectId" | "phase" | "onOpenDataset">): JSX.Element {
  const toDataset = onOpenDataset === undefined ? {} : { onOpenDataset };
  const [promotedHere, setPromotedHere] = useState(false);
  const [finishedHere, setFinishedHere] = useState(false);
  const promotable = declares(batch, BATCH_ACTION.promote);
  const inDataset = phase === "in_dataset";
  return (
    <>
      <CompleteBatchButton batch={batch} projectId={projectId} variant={isFinishing(batch) ? "default" : "outline"} onPromoted={() => setFinishedHere(true)} {...toDataset} />
      {promotable && !finishedHere && (!inDataset || promotedHere) && (
        <div className="contents" onClickCapture={() => setPromotedHere(true)}>
          <PromoteButton batch={batch} projectId={projectId} variant="default" iconOnly {...toDataset} />
        </div>
      )}
      {promotable && !finishedHere && inDataset && !promotedHere && (
        <span data-line="" className="flex items-center justify-end gap-3 text-xs text-muted-foreground" data-testid={`in-dataset-${batch.name}`}>
          All {batch.asset_count} {batchNoun(batch.modalities, batch.asset_count)} in the dataset
          {onOpenDataset !== undefined && (
            <Button variant="link" className="h-auto p-0 text-xs" data-testid={`in-dataset-open-${batch.name}`} onClick={onOpenDataset}>
              Open the dataset
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Button>
          )}
        </span>
      )}
    </>
  );
}

/** Nothing is outstanding and the batch may be completed: finishing it is the forward step. */
function isFinishing(batch: Batch): boolean {
  return declares(batch, BATCH_ACTION.complete) && outstandingWork(batch.progress) === 0;
}
