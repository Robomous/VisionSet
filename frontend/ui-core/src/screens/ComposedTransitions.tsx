/**
 * Two lifecycle steps behind one control: *Complete* with its *Add to the
 * dataset* switch on (`complete`, then `promote`). Its sibling on the way in —
 * *Approve* with *Start annotating now* on (`approve`, then `start`) — is the
 * approve form's switch in `BatchLifecycle.tsx`, and follows the same rules.
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

import { ArrowRight, CircleCheckBig } from "lucide-react";
import { useState, type JSX } from "react";

import { BATCH_ACTION, declares } from "../data/capabilities";
import { refusalProse } from "../data/refusals";
import { Button, FieldError, Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger, Switch, Tooltip, TooltipContent, TooltipTrigger } from "@robomous/ui-core";
import { IconAction, IconButton } from "../patterns/IconAction";
import { quietUnlessVisible } from "../patterns/iconFocus";
import { batchNoun } from "../lib/assetNoun";
import { outstandingWork } from "./batchState";
import { completedLine, promotionSummary } from "./batchWords";
import {
  useFinishBatch,
  usePromoteBatch,
  type Batch,
  type FinishBatchResult,
} from "./queries";

// --- complete, and maybe add -------------------------------------------------

export interface CompleteBatchButtonProps {
  readonly batch: Batch;
  readonly projectId: string;
  /** The dataset screen, so a promotion can be followed to where it landed. */
  readonly onOpenDataset?: () => void;
  /** Both steps landed, so a host showing a separate *Add to dataset* can stand it down. */
  readonly onPromoted?: () => void;
  /** Filled while it is the batch's forward step. */
  readonly variant?: "default" | "outline";
}

/**
 * `in_annotation → completed`, and — if the person keeps the switch on — the
 * union into the trunk: one icon button, and a small confirmation that holds the
 * choice (the "Confirm" direction of the Complete prototype).
 *
 * **The choice is made where the consequence is said.** Completing cannot be
 * undone, so a press opens a popover that says so; its one switch, *Add N images
 * to the dataset*, is on by default and keeps the person's last answer for the
 * next batch. The button inside always says *Complete*: the switch is the
 * choice, and a label that changed with it would also change width under the
 * pointer.
 *
 * **The declaration alone decides.** The kernel declares `complete` only once
 * every asset has settled, so a batch being labeled that does not declare it is
 * shown withheld, its tooltip counting what is left — the count is the reason's
 * wording, never the gate. A refusal that still arrives is a race, said in words
 * under the footer's controls (`data-line`).
 *
 * The UI says "add to dataset" where the kernel, API and CLI say `promote`.
 */
export function CompleteBatchButton({ batch, projectId, onOpenDataset, onPromoted, variant = "default" }: CompleteBatchButtonProps): JSX.Element | null {
  const finish = useFinishBatch(batch.id);
  const promote = usePromoteBatch(projectId);
  const [completed, setCompleted] = useState<FinishBatchResult | null>(null);
  const [open, setOpen] = useState(false);
  const [add, setAdd] = useState(lastAddChoice);

  const offered = declares(batch, BATCH_ACTION.complete);
  const withheld = !offered && batch.state === "in_annotation";
  if (!offered && !withheld && completed === null) return null;

  const outstanding = outstandingWork(batch.progress);
  const reason = outstanding > 0 ? `${outstanding} ${batchNoun(batch.modalities, outstanding)} still to annotate or skip` : "This batch can’t be completed right now.";
  const busy = finish.isPending || promote.isPending;
  const summary = promote.isSuccess ? promotionSummary(promote.data.total, batch.promoted_asset_count, batch.asset_count) : null;

  function submit(): void {
    setOpen(false);
    lastAddChoice = add;
    finish.mutate(undefined, {
      onSuccess: (result) => {
        setCompleted(result);
        if (add) promote.mutate(batch.id, { onSuccess: () => onPromoted?.() });
      },
    });
  }

  return (
    <div className="contents">
      {withheld && completed === null && <IconAction icon={CircleCheckBig} label="Complete batch" reason={reason} variant="outline" data-testid={`complete-${batch.name}`} />}
      {offered &&
        (busy ? (
          <IconAction icon={CircleCheckBig} label="Complete batch" busy variant="outline" data-testid={`complete-${batch.name}`} />
        ) : (
          <Popover open={open} onOpenChange={setOpen}>
            <Tooltip>
              <TooltipTrigger asChild onFocus={quietUnlessVisible}>
                <PopoverTrigger asChild>
                  <IconButton icon={CircleCheckBig} label="Complete batch" variant={variant} data-testid={`complete-${batch.name}`} data-autofocus={variant === "default" ? "" : undefined} />
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">Complete batch</TooltipContent>
            </Tooltip>
            <PopoverContent side="top" align="end" className="w-80 p-3" data-testid="complete-confirm">
              <PopoverHeader>
                <PopoverTitle>Complete this batch?</PopoverTitle>
                <PopoverDescription>
                  Any job still open closes with it. A completed batch can’t be reopened.
                </PopoverDescription>
              </PopoverHeader>
              {/* The whole row is the switch's label: the row is the hit area and its words are the name. */}
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2.5">
                {/* Not a count: skipped ones stay out, and only the kernel knows which are left. */}
                <span className="font-medium">Add the labeled {batchNoun(batch.modalities, 2, "image")} to the dataset</span>
                <Switch checked={add} onCheckedChange={setAdd} data-testid="complete-add" />
              </label>
              <div className="flex justify-end gap-1.5">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button className={PRESS} onClick={submit} data-testid="complete-submit">
                  <CircleCheckBig data-icon="inline-start" aria-hidden="true" />
                  Complete
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        ))}
      {completed !== null && (
        <span data-line="" className="text-xs text-muted-foreground" data-testid={`completed-${batch.name}`}>
          {completedLine(completed)}
          {summary === null ? (promote.isIdle ? " Nothing is in the dataset yet." : "") : ` ${summary}`}
        </span>
      )}
      {promote.isSuccess && onOpenDataset !== undefined && (
        <span data-line="" className="flex justify-end">
          <Button variant="link" className="h-auto p-0" data-testid={`complete-promote-open-dataset-${batch.name}`} onClick={onOpenDataset}>
            Open the dataset
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Button>
        </span>
      )}
      {finish.isError && (
        <FieldError data-line="" data-testid={`complete-error-${batch.name}`}>
          {refusalProse(finish.error)}
        </FieldError>
      )}
      {promote.isError && (
        <FieldError data-line="" data-testid={`complete-promote-error-${batch.name}`}>
          {refusalProse(promote.error)}
        </FieldError>
      )}
    </div>
  );
}

/** The switch's last answer, for the next batch completed in this session. */
let lastAddChoice = true;

const PRESS = "transition-[background-color,scale] duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none";
