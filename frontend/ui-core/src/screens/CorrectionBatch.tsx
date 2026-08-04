/**
 * Correcting a batch that is finished — audit gap G6, and the end of the
 * forward-only story.
 *
 * ## What this replaces
 *
 * Nothing, which is the point. A `completed` batch is immutable as a workflow
 * unit: the kernel gives it no exit and none is coming. The product's answer to
 * "this frame is wrong" had been a dead end dressed three different ways — an
 * annotator that opened fully editable and refused every save (#306 made it a
 * viewer), a bulk bar whose buttons were live and whose every request 409'd
 * (#305 disabled them with a reason), and a sentence naming a correction batch
 * that nothing could create.
 *
 * Each of those now says the same thing and, from here, *points at the same
 * control*. That is the difference between a refusal and a next step, and it is
 * the whole reason those two tasks left the sentence in place rather than
 * inventing a friendlier lie.
 *
 * ## Scope is a choice, and the default is the whole batch
 *
 * "Correct this batch" is the ordinary ask, so `all` is the default and sends no
 * `asset_ids` at all — the server's own default is the parent's whole
 * membership, and re-listing forty-eight ids to say so would be this screen
 * telling the API something it already knows.
 *
 * `selection` exists because the other ordinary ask is *the three frames
 * somebody found wrong*, and the gallery already has a selection to hand. It is
 * offered only when there is one: a scope choice with an empty option is a
 * choice between doing something and doing nothing.
 *
 * There is deliberately no "filtered set" option. The gallery's segments are a
 * *view*, and a correction cut from whatever happens to be filtered at the
 * moment of pressing is a batch nobody can describe afterwards — where a
 * selection is a thing somebody chose.
 */

import { GitBranch } from "lucide-react";
import { useState, type JSX } from "react";

import { BATCH_ACTION, declares } from "../data/capabilities";
import { refusalProse } from "../data/refusals";
import { Button } from "../primitives/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { FieldError, FieldHint, Input, Label } from "../primitives/Input";
import { useCreateCorrection, type Batch } from "./queries";

/** What a correction covers. `all` sends nothing and lets the server default. */
export type CorrectionScope = "all" | "selection";

/**
 * What to call a correction of this batch, before anybody types anything.
 *
 * Pure and exported because it is the part with a decision in it: a name is
 * required, and a dialog that opened blank would make the common case — "yes,
 * correct this, that is all I meant" — cost a sentence of typing. Numbering by
 * how many corrections already exist keeps a chain readable in a listing, and
 * counting is the caller's job because only it has the listing.
 */
export function defaultCorrectionName(parent: string, existing: number): string {
  return existing === 0 ? `${parent} — correction` : `${parent} — correction ${existing + 1}`;
}

export interface CorrectionButtonProps {
  readonly batch: Batch;
  readonly projectId: string;
  /**
   * How many corrections of this batch already exist, for the suggested name.
   *
   * Passed in rather than counted here: the caller is already holding the
   * project's batch listing, and a second request to name a dialog would be a
   * request nobody asked for.
   */
  readonly existingCorrections?: number;
  /** The frames currently selected, when the caller has a selection to offer. */
  readonly selection?: readonly string[];
  /** Where to go once the correction exists. Absent leaves the caller where it is. */
  readonly onOpenBatch?: (batchId: string) => void;
  readonly className?: string;
  /**
   * Drive the dialog from outside, for a caller with a second way in.
   *
   * The gallery has two — the header button and the bulk bar's "Create one" —
   * and two independent dialogs would be two states that can both be true. When
   * this is supplied the component is controlled and its own button reports
   * through `onOpenChange` rather than to itself.
   */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function CorrectionButton({
  batch,
  projectId,
  existingCorrections = 0,
  selection,
  onOpenBatch,
  className,
  open,
  onOpenChange,
}: CorrectionButtonProps): JSX.Element | null {
  const [own, setOwn] = useState(false);
  const showing = open ?? own;
  const setShowing = onOpenChange ?? setOwn;

  // Capability-gated like every other action in this product: `create_correction`
  // is declared exactly while the batch is `completed`, and correcting an open
  // batch is not a correction — it is the work, in the batch already there.
  if (!declares(batch, BATCH_ACTION.createCorrection)) return null;

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className={className}
        data-testid={`correct-${batch.name}`}
        onClick={() => setShowing(true)}
      >
        <GitBranch className="size-4" aria-hidden="true" />
        Create correction batch
      </Button>
      <CorrectionDialog
        batch={batch}
        projectId={projectId}
        existingCorrections={existingCorrections}
        open={showing}
        onClose={() => setShowing(false)}
        {...(selection === undefined ? {} : { selection })}
        {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
      />
    </>
  );
}

function CorrectionDialog({
  batch,
  projectId,
  existingCorrections,
  selection,
  open,
  onClose,
  onOpenBatch,
}: {
  readonly batch: Batch;
  readonly projectId: string;
  readonly existingCorrections: number;
  readonly selection?: readonly string[];
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenBatch?: (batchId: string) => void;
}): JSX.Element {
  const create = useCreateCorrection(projectId);
  const suggested = defaultCorrectionName(batch.name, existingCorrections);
  const [name, setName] = useState(suggested);
  const [touched, setTouched] = useState(false);
  const [scope, setScope] = useState<CorrectionScope>("all");

  const chosen = selection ?? [];
  const canScopeToSelection = chosen.length > 0;
  const effective: CorrectionScope = canScopeToSelection ? scope : "all";
  const value = touched ? name : suggested;

  const submit = (): void => {
    create.mutate(
      {
        batchId: batch.id,
        name: value,
        // Omitted for `all`, so the server's own default answers — see the
        // module docstring.
        ...(effective === "selection" ? { assetIds: chosen } : {}),
      },
      {
        onSuccess: (child) => {
          onClose();
          onOpenBatch?.(child.id);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="correction-dialog">
        <div className="flex flex-col gap-1.5">
          <DialogTitle>Create a correction batch</DialogTitle>
          <DialogDescription>
            {batch.name} is completed, and a completed batch is kept as it is. A correction is a
            new batch over the same frames that records where it came from.
          </DialogDescription>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="correction-name">Name</Label>
            <Input
              id="correction-name"
              data-testid="correction-name"
              value={value}
              onChange={(event) => {
                setTouched(true);
                setName(event.target.value);
              }}
            />
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-meta font-medium">Which frames</legend>
            <label className="flex items-center gap-2 text-meta">
              <input
                type="radio"
                name="correction-scope"
                data-testid="correction-scope-all"
                checked={effective === "all"}
                onChange={() => setScope("all")}
              />
              Every frame in {batch.name} ({batch.asset_count})
            </label>
            {/*
              Offered only when there is a selection. A scope choice whose second
              option covers nothing is a choice between doing something and doing
              nothing, which is not a choice.
            */}
            {canScopeToSelection && (
              <label className="flex items-center gap-2 text-meta">
                <input
                  type="radio"
                  name="correction-scope"
                  data-testid="correction-scope-selection"
                  checked={effective === "selection"}
                  onChange={() => setScope("selection")}
                />
                The {chosen.length} frame{chosen.length === 1 ? "" : "s"} selected
              </label>
            )}
            <FieldHint>
              The correction starts as a draft, so its frames can still change. Approving it pins
              the project’s current label schema — not the one {batch.name} was judged against.
            </FieldHint>
          </fieldset>

          {create.isError && (
            <FieldError data-testid="correction-error">{refusalProse(create.error)}</FieldError>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="correction-submit"
            disabled={create.isPending || value.trim() === ""}
            onClick={submit}
          >
            {create.isPending ? "Creating…" : "Create correction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Correction of X" — lineage, rendered where somebody is looking at the child.
 *
 * A batch's parent is one hop, not a root pointer: each records the one it was
 * cut from, and a reader walks the chain for the origin. So this says *of what*
 * and nothing about how deep the chain goes, which is the honest reading of the
 * one field there is.
 *
 * `null` when there is no parent, which is most batches and is not a state worth
 * drawing: "not a correction of anything" is the ordinary case, and a badge
 * saying so on every batch would be noise on the many to inform the few.
 */
export function CorrectionOf({
  parentName,
  onOpenParent,
}: {
  readonly parentName: string | undefined;
  readonly onOpenParent?: () => void;
}): JSX.Element | null {
  if (parentName === undefined) return null;
  return (
    <span className="flex items-center gap-1 text-meta text-muted-foreground" data-testid="correction-of">
      <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
      Correction of{" "}
      {onOpenParent === undefined ? (
        parentName
      ) : (
        <Button
          variant="link"
          className="h-auto p-0 text-meta"
          data-testid="open-parent-batch"
          onClick={onOpenParent}
        >
          {parentName}
        </Button>
      )}
    </span>
  );
}
