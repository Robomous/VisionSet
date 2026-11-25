/**
 * What a batch may be asked to do, in its panel on the Overview — the one place
 * a batch moves forward, now that it has no page of its own.
 *
 * They sit at the end of the panel's top bar (`BatchSheet`), and every one is
 * quiet — a ghost button. **Most are icon buttons named by their tooltips**
 * (`patterns/IconAction`), and a withheld one keeps its tooltip with the reason;
 * *Annotate* and *Correct* say their names, the first because it is where most
 * visits to a labeling batch are going, the second because no icon reads as
 * "fix a finished batch's labels". First, what ends or branches the batch:
 * *Delete batch* (quiet like the rest, in the destructive colour under the
 * pointer or the focus; not drawn on a completed batch, which can never be
 * deleted) and *Correct* on a completed one. Then — parted by the spacer the
 * bar draws as a hairline — the forward step: *Approve*, *Start annotating*,
 * *Annotate*, *Complete* (a press opens its confirmation, whose switch decides
 * whether the images go into the dataset too) and *Add to dataset*. The one the
 * panel opens on is marked `data-autofocus`: *Annotate* while work is left,
 * *Complete* once nothing is outstanding. A batch already wholly in the dataset
 * has no forward step, and says so in a line instead of a button. *Auto-label*
 * is not here: the bar puts it before these.
 *
 * **What a control says is a line of its own** — an outcome, a refusal, a
 * count. Each control renders its own lines as `SheetLine`s; in the panel an
 * outcome or a refusal is a toast and a lasting state says nothing (the
 * properties say it), so an icon button's words never squeeze under a 32px
 * square and the top bar stays one row.
 *
 * Each is offered from what the batch's `allowed_actions` declares, never from
 * its state, and each says what it did — a label flip is not feedback. The UI
 * says "add to dataset" for the kernel's `promote`.
 */

import { PenLine, Stamp } from "lucide-react";
import { useState, type JSX } from "react";

import { Button } from "@robomous/ui-core";
import { BATCH_ACTION, declares } from "../data/capabilities";
import { IconAction } from "../patterns/IconAction";
import type { BatchRowView } from "../patterns/project/BatchTable";
import { ApproveDialog, StartAnnotatingButton } from "./BatchLifecycle";
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
      <CorrectionButton batch={batch} projectId={projectId} existingCorrections={existingCorrections} inBar {...(onOpenBatch === undefined ? {} : { onOpenBatch })} />
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
        <IconAction icon={Stamp} label="Approve" hint="Freezes its images and cuts it into jobs" data-testid="approve-batch" data-autofocus="" onClick={() => setApproving(true)} />
      )}
      {declares(batch, BATCH_ACTION.start) && <StartAnnotatingButton batch={batch} />}
      {onAnnotate !== undefined && phase === "annotating" && (
        // The one control that says its name: it is where most visits to a labeling batch are going.
        <Button
          variant="ghost"
          size="lg"
          className="text-[13px] transition-[background-color,scale] duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none"
          data-testid="sheet-annotate"
          {...(finishing ? {} : { "data-autofocus": "" })}
          onClick={onAnnotate}
        >
          <PenLine data-icon="inline-start" aria-hidden="true" strokeWidth={1.75} />
          Annotate
        </Button>
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
 * wholly in the dataset is offered nothing here: its State says *In dataset*
 * and offers *Open the dataset ↗*. A curator removing one of its images puts
 * the batch back in `completed`, and the control with it.
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
      <CompleteBatchButton batch={batch} projectId={projectId} forward={isFinishing(batch)} onPromoted={() => setFinishedHere(true)} {...toDataset} />
      {promotable && !finishedHere && (!inDataset || promotedHere) && (
        <div className="contents" onClickCapture={() => setPromotedHere(true)}>
          <PromoteButton batch={batch} projectId={projectId} forward iconOnly {...toDataset} />
        </div>
      )}
    </>
  );
}

/** The batch declares `complete`, which the kernel does only once nothing is outstanding: finishing it is the forward step. */
function isFinishing(batch: Batch): boolean {
  return declares(batch, BATCH_ACTION.complete);
}
