/**
 * Deleting a batch: one overflow menu and one dialog, mounted at two sites.
 *
 * ## Why it is a component and not two
 *
 * The Batches row and the gallery header both offer this, and a second spelling
 * of "which states may be deleted", of the blast radius, or of the confirmation
 * would be the hand-mirror one layer up from the one `capabilities.ts` exists to
 * remove. The annotator's reassignment picker has the same shape: the
 * shared piece holds everything the control *decides*, and each mount supplies
 * only its anchor and what to do afterwards.
 *
 * ## An overflow menu, never a button
 *
 * Deleting a batch is not a step of the workflow — every other control in both
 * places moves the batch along, and this one ends it. It is also the only action
 * either surface offers that cannot be undone. So it lives behind `⋯`, where the
 * things you go looking for live, rather than beside the thing you press next.
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

import { MoreHorizontal, Trash2 } from "lucide-react";
import { useState, type JSX } from "react";

import { BATCH_ACTION, declares, withheldBecause } from "../data/capabilities";
import { refusalProse } from "../data/refusals";
import { Button } from "../primitives/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { FieldError } from "../primitives/Input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../primitives/Menu";
import { useDeleteBatch, type Batch } from "./queries";

export interface BatchOverflowMenuProps {
  readonly batch: Batch;
  /** Whose listing to refetch. The batch is what stops existing, so it cannot say. */
  readonly projectId: string;
  /**
   * Where to go once the batch is gone.
   *
   * The gallery passes its way back to the Batches tab, because the screen's
   * subject no longer exists. The Batches row passes nothing: the row leaves the
   * table and the rest of the table is still the answer.
   */
  readonly onDeleted?: () => void;
  readonly align?: "start" | "center" | "end";
}

export function BatchOverflowMenu({
  batch,
  projectId,
  onDeleted,
  align = "end",
}: BatchOverflowMenuProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const deletable = declares(batch, BATCH_ACTION.delete);
  // Only reached when the action is withheld, which for `delete` is `completed`
  // alone — every other state is in `DELETABLE_STATES`. The sentence is the
  // shared one, so this control and every disabled control on these screens
  // explain a completed batch the same way.
  const reason = deletable ? null : withheldBecause(batch.state);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`More actions for ${batch.name}`}
            data-testid={`batch-overflow-${batch.name}`}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-64">
          {/*
            Disabled-with-reason rather than hidden: there *is* an operation
            behind this and a state that would enable it, which is the whole
            distinction between this and removing the control. The reason
            renders inline under the label — the shape the annotator's class
            picker uses for a class a shape cannot become — because a tooltip on
            a menu item that cannot be hovered into is a reason nobody reads.
          */}
          <DropdownMenuItem
            destructive={deletable}
            disabled={!deletable}
            data-testid={`delete-batch-${batch.name}`}
            onSelect={() => setConfirming(true)}
          >
            <Trash2 className="size-4 shrink-0" aria-hidden="true" />
            <span className="flex flex-col items-start gap-0.5">
              <span>Delete batch</span>
              {reason !== null && (
                <span className="text-meta text-muted-foreground" data-testid={`delete-withheld-${batch.name}`}>
                  {reason}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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

  return (
    <Dialog open={batch !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="delete-batch-dialog">
        <DialogTitle>Delete {batch?.name}?</DialogTitle>
        <DialogDescription>
          This removes the batch, its jobs, and how far each frame had got
          {moved > 0 ? ` — progress on ${moved} of them` : ""}.{" "}
          <strong>The annotations stay.</strong> Labels belong to assets, not to batches, so the{" "}
          {batch?.asset_count ?? 0} frames remain in the project with their work on them
          {batch !== null && batch.promoted_asset_count > 0
            ? `, and the ${batch.promoted_asset_count} already promoted stay in the dataset`
            : ""}
          .
        </DialogDescription>
        {remove.isError && (
          <FieldError data-testid="delete-batch-error">{refusalProse(remove.error)}</FieldError>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
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
