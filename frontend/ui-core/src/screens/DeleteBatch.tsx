/**
 * Deleting a batch: one icon button and one dialog.
 *
 * ## Why it is a component and not two
 *
 * The batch panel's top bar offers this (it once had a second mount, on the
 * Batches row), and a second spelling of "which states may be deleted", of the
 * blast radius, or of the confirmation would be the hand-mirror one layer up from the one `capabilities.ts` exists to
 * remove. The annotator's reassignment picker has the same shape: the
 * shared piece holds everything the control *decides*, and each mount supplies
 * only its anchor and what to do afterwards.
 *
 * ## An icon button first among the batch's actions
 *
 * Deleting a batch is not a step of the workflow — every other control in the
 * panel moves the batch along, and this one ends it. It is also the only action
 * the panel offers that cannot be undone. So it sits first among the batch's
 * actions, parted by a hairline from the forward step at their end. It is quiet
 * at rest like every control beside it, turns the destructive colour under the
 * pointer or the focus, and opens a confirmation rather than acting on a press.
 *
 * ## What the dialog is allowed to say
 *
 * **The verified blast radius, and no number it cannot source.** Both numbers
 * come off `BatchOut`, which is already loaded at both mounts: `asset_count` and
 * `progress`. The count of *jobs* is deliberately absent — it lives on
 * `/batches/{id}/jobs`, which the Batches row never fetches, and a dialog that
 * said "3 jobs" on one screen and nothing on the other would be two dialogs.
 *
 * The archived design for this control listed "annotations not yet promoted"
 * among what dies. **That is not what happens**, and the sentence here says the
 * opposite because the schema does: `annotation.asset_id` is the row's only
 * parent (`_tables.py`), so a batch's cascade cannot reach a label. Deleting the
 * unit of work never deletes the work — `BatchService.delete`'s own docstring
 * says so, and `test_batch_service.py` holds it.
 */

import { Trash2 } from "lucide-react";
import { useState, type JSX } from "react";

import { BATCH_ACTION, declares, withheldBecause } from "../data/capabilities";
import { refusalProse } from "../data/refusals";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FieldError } from "@robomous/ui-core";
import { IconAction } from "../patterns/IconAction";
import { batchNoun } from "../lib/assetNoun";
import { useDeleteBatch, type Batch } from "./queries";

export interface DeleteBatchButtonProps {
  readonly batch: Batch;
  /** Whose listing to refetch. The batch is what stops existing, so it cannot say. */
  readonly projectId: string;
  /**
   * Where to go once the batch is gone. The batch panel closes itself here,
   * because its subject no longer exists.
   */
  readonly onDeleted?: () => void;
}

/**
 * An icon button, and its confirmation. Withheld with its reason while the
 * batch may yet be deleted — the declaration says no for now, and the tooltip's
 * second line (reachable by focus as well as pointer) says why. A completed
 * batch can never be deleted again (the kernel's `DELETABLE_STATES`; `completed`
 * has no exit), so there it is not drawn at all: `ui-capabilities` hides what is
 * never meaningful on the screen, and the onward route — a correction — stands
 * beside it in the bar.
 */
export function DeleteBatchButton({ batch, projectId, onDeleted }: DeleteBatchButtonProps): JSX.Element | null {
  const [confirming, setConfirming] = useState(false);
  const deletable = declares(batch, BATCH_ACTION.delete);
  // Only reached when the action is withheld, which for `delete` is `completed`
  // alone — every other state is in `DELETABLE_STATES`. The sentence is the
  // shared one, so every withheld control explains a completed batch the same way.
  // The declaration decides, never the state word: a batch that does not declare
  // `delete` is withheld whatever its state, with the shared sentence when there
  // is one for that state and a plain one when there is not.
  const reason = deletable ? null : (withheldBecause(batch.state) ?? "This batch can’t be deleted right now.");
  if (!deletable && batch.state === "completed") return null;

  return (
    <>
      <IconAction
        icon={Trash2}
        label="Delete batch"
        reason={reason}
        // Quiet at rest like the rest of the bar; the destructive colour arrives as the pointer or the focus does.
        className="text-muted-foreground transition-[color,background-color,scale] duration-150 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-destructive/10 [@media(hover:hover)_and_(pointer:fine)]:hover:text-destructive focus-visible:text-destructive aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
        data-testid={`delete-batch-${batch.name}`}
        onClick={() => setConfirming(true)}
      />
      <DeleteBatchDialog
        batch={confirming ? batch : null}
        projectId={projectId}
        onClose={() => setConfirming(false)}
        {...(onDeleted === undefined ? {} : { onDeleted })}
      />
    </>
  );
}

/**
 * The confirmation, and the sentence that makes it answerable.
 *
 * `progress.total - progress.unannotated` is the one derived number, and it is
 * derived rather than fetched: it is how many frames have moved off the state
 * they were cut in, which is exactly the per-frame progress the delete destroys.
 * A draft reports `total: 0` — it has no jobs — so the clause disappears rather
 * than reading "0 frames", which is a sentence about nothing.
 */
function DeleteBatchDialog({
  batch,
  projectId,
  onClose,
  onDeleted,
}: {
  readonly batch: Batch | null;
  readonly projectId: string;
  readonly onClose: () => void;
  readonly onDeleted?: () => void;
}): JSX.Element {
  const remove = useDeleteBatch(projectId);
  const moved = batch === null ? 0 : batch.progress.total - batch.progress.unannotated;
  const modalities = batch?.modalities ?? [];
  const remaining = batch?.asset_count ?? 0;

  return (
    <Dialog open={batch !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="delete-batch-dialog">
        <DialogTitle>Delete {batch?.name}?</DialogTitle>
        <DialogDescription>
          This removes the batch, its jobs, and how far each {batchNoun(modalities, 1)} had got
          {moved > 0 ? ` — progress on ${moved} of them` : ""}.{" "}
          <strong>The annotations stay.</strong> Labels belong to assets, not to batches, so the{" "}
          {remaining} {batchNoun(modalities, remaining)}{" "}
          {remaining === 1 ? "remains in the project with its work on it" : "remain in the project with their work on them"}
          {batch !== null && batch.promoted_asset_count > 0
            ? `, and the ${batch.promoted_asset_count} already promoted ${batch.promoted_asset_count === 1 ? "stays" : "stay"} in the dataset`
            : ""}
          .
        </DialogDescription>
        {remove.isError && (
          <FieldError data-testid="delete-batch-error">{refusalProse(remove.error)}</FieldError>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="delete-batch-submit"
            disabled={remove.isPending}
            onClick={() =>
              batch !== null &&
              remove.mutate(batch.id, {
                onSuccess: () => {
                  onClose();
                  onDeleted?.();
                },
              })
            }
          >
            {remove.isPending ? "Deleting…" : "Delete batch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
