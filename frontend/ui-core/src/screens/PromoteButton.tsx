/**
 * Promotion, and saying what it did — audit findings F5, F17 and F18.
 *
 * ## The bug was that a working call looked broken
 *
 * Promoting a completed batch succeeds. It always did. What a person could
 * observe afterwards was the word "Promoted" on the button they had just pressed
 * and **nothing else** — and nothing else was structurally possible: promotion is
 * not a transition, so the batch stays `completed`, and no read model recorded
 * that anything had entered the trunk. The response carrying *the assets this
 * press actually promoted* was discarded unread.
 *
 * So three outcomes were indistinguishable:
 *
 * 1. promoted 3 of 48 — the founder's real batch, 3 annotated and 45 skipped;
 * 2. promoted nothing, because it was already done (promotion is a **union**, so
 *    a second press legitimately moves zero);
 * 3. the press did nothing at all.
 *
 * A user seeing no change concludes (3), which is the only one that was never
 * true. This says which it was.
 *
 * ## Two numbers, because neither one alone is the answer
 *
 * The response says what **this press** did and cannot be recovered afterwards.
 * `promoted_asset_count` says what is in the trunk **now** and is the only half
 * that survives a reload. A screen with only the first forgets; a screen with
 * only the second cannot tell a fresh promotion from an old one.
 *
 * ## Why the skipped frames get a sentence
 *
 * `PROMOTABLE_PROGRESS` is `{annotated, accepted}` — `skipped` is deliberately
 * excluded, because skipping is a decision that the asset does not belong in the
 * dataset. For the batch this was reported on that is 45 of 48 frames, and "3
 * promoted" over a batch of 48 reads as a failure unless somebody says where the
 * other 45 went.
 *
 * ## Shared, not copied
 *
 * The batch panel's top bar renders this, as a completed batch's forward step,
 * and the UI calls it **Add to dataset** — the kernel's `promote`, named for
 * what a person sees it do. It shares its sentences with *Complete and add to
 * dataset* (`ComposedTransitions.tsx`). Two spellings of "did my work reach the dataset"
 * would eventually disagree in front of a user, and the panel is where somebody
 * is actually standing when they finish a batch — F18 is that the screen they
 * were on had no promote control at all.
 */

import { ArrowUpRight, ArrowUpToLine, DatabasePlus } from "lucide-react";
import type { JSX } from "react";

import { BATCH_ACTION, declares } from "../data/capabilities";
import { batchNoun } from "../lib/assetNoun";
import { refusalProse } from "../data/refusals";
import { Button } from "@robomous/ui-core";
import { SheetLine } from "../patterns/project/SheetLine";
import { IconAction } from "../patterns/IconAction";
import { promotionSummary } from "./batchWords";
import { usePromoteBatch, type Batch } from "./queries";

export interface PromoteButtonProps {
  readonly batch: Batch;
  readonly projectId: string;
  /** The dataset screen, so a promotion can be followed to where it landed. */
  readonly onOpenDataset?: () => void;
  readonly className?: string;
  /** The size of the labelled button, where it is not an icon button. */
  readonly size?: "sm" | "lg";
  readonly variant?: "default" | "outline";
  /** As an icon button, the batch's forward step: the panel opens with the focus on it. */
  readonly forward?: boolean;
  /**
   * An icon button named by its tooltip, as the batch panel draws every control;
   * its lines (`SheetLine`) are toasts there.
   */
  readonly iconOnly?: boolean;
}


export function PromoteButton({
  batch,
  projectId,
  onOpenDataset,
  className,
  size = "sm",
  variant = "outline",
  forward = false,
  iconOnly = false,
}: PromoteButtonProps): JSX.Element | null {
  const promote = usePromoteBatch(projectId);

  if (!declares(batch, BATCH_ACTION.promote)) return null;

  const summary = promote.isSuccess
    ? promotionSummary(promote.data.total, batch.promoted_asset_count, batch.asset_count, (count) => batchNoun(batch.modalities, count, "image"))
    : null;

  return (
    <div className={iconOnly ? "contents" : (className ?? "flex flex-col items-end gap-1")}>
      {iconOnly ? (
        <IconAction
          icon={DatabasePlus}
          label="Add to dataset"
          busy={promote.isPending}
          data-testid={`promote-${batch.name}`}
          {...(forward ? { "data-autofocus": "" } : {})}
          onClick={() => promote.mutate(batch.id)}
        />
      ) : (
        <Button
          variant={variant}
          size={size}
          data-testid={`promote-${batch.name}`}
          disabled={promote.isPending}
          onClick={() => promote.mutate(batch.id)}
        >
          <ArrowUpToLine className="size-4" aria-hidden="true" />
          {/*
            The label no longer carries the outcome. It said "Promoted" after a
            press and that was the entire feedback — a label flip is not a report,
            and it also made a second press look forbidden when it is merely a
            no-op. The sentence below is the report; the button stays a button.
          */}
          {promote.isPending ? "Adding…" : "Add to dataset"}
        </Button>
      )}

      {/*
        What the press moved, and the way onward on the same line. Promotion's
        whole evidence lives on the dataset screen, and until the link a person
        was told something had happened and left to find it.
      */}
      {summary !== null && (
        <SheetLine
          tone="success"
          data-testid={`promoted-${batch.name}`}
          about={batch}
          {...(promote.isSuccess && onOpenDataset !== undefined
            ? {
                action: (
                  <Button variant="link" className="h-auto p-0 text-xs" data-testid={`promoted-open-dataset-${batch.name}`} onClick={onOpenDataset}>
                    Open the dataset
                    <ArrowUpRight className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </Button>
                ),
              }
            : {})}
        >
          {summary}
        </SheetLine>
      )}

      {promote.isError && (
        <SheetLine tone="error" data-testid={`promote-error-${batch.name}`} about={batch}>
          {refusalProse(promote.error)}
        </SheetLine>
      )}
    </div>
  );
}
