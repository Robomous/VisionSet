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
 * The batch table and the gallery header both render this. Two spellings of "did
 * my work reach the dataset" would eventually disagree in front of a user, and
 * the gallery is the screen somebody is actually on when they finish a batch —
 * F18 is that it had no promote control at all.
 */

import { ArrowUpFromLine, ArrowRight } from "lucide-react";
import type { JSX } from "react";

import { BATCH_ACTION, declares } from "../data/capabilities";
import { refusalProse } from "../data/refusals";
import { Button } from "../primitives/Button";
import { FieldError } from "../primitives/Input";
import { usePromoteBatch, type Batch } from "./queries";

export interface PromoteButtonProps {
  readonly batch: Batch;
  readonly projectId: string;
  /** The dataset screen, so a promotion can be followed to where it landed. */
  readonly onOpenDataset?: () => void;
  readonly className?: string;
}

/**
 * What a press promoted, said in one sentence.
 *
 * Exported and pure because it is the part with a decision in it, and the
 * decision is not obvious: **zero promoted is not a failure**, and the sentence
 * for it has to say why without sounding like one.
 *
 * `moved` is what the response carried; `settled` is how many of the batch's
 * assets are in the trunk now. A press that moved nothing over a batch that is
 * entirely in the trunk means "already there"; a press that moved nothing over a
 * batch with nothing in the trunk means every frame was skipped.
 */
export function promotionSummary(
  moved: number,
  settled: number,
  total: number,
): string {
  if (moved > 0) {
    const excluded = total - settled;
    const tail =
      excluded > 0
        ? ` ${excluded} skipped frame${excluded === 1 ? "" : "s"} stayed out.`
        : "";
    return `Promoted ${moved} asset${moved === 1 ? "" : "s"} to the dataset.${tail}`;
  }
  if (settled > 0) {
    // The idempotent no-op, which is the case that looked most like a bug: a
    // second press, or a first press in a fresh session after an earlier one.
    return `Already in the dataset — nothing new to promote.`;
  }
  return "Nothing here can be promoted: every frame was skipped, and a skipped frame never enters the dataset.";
}

export function PromoteButton({
  batch,
  projectId,
  onOpenDataset,
  className,
}: PromoteButtonProps): JSX.Element | null {
  const promote = usePromoteBatch(projectId);

  if (!declares(batch, BATCH_ACTION.promote)) return null;

  const summary = promote.isSuccess
    ? promotionSummary(promote.data.total, batch.promoted_asset_count, batch.asset_count)
    : null;

  return (
    <div className={className ?? "flex flex-col items-end gap-1"}>
      <Button
        variant="secondary"
        size="sm"
        data-testid={`promote-${batch.name}`}
        disabled={promote.isPending}
        onClick={() => promote.mutate(batch.id)}
      >
        <ArrowUpFromLine className="size-4" aria-hidden="true" />
        {/*
          The label no longer carries the outcome. It said "Promoted" after a
          press and that was the entire feedback — a label flip is not a report,
          and it also made a second press look forbidden when it is merely a
          no-op. The sentence below is the report; the button stays a button.
        */}
        {promote.isPending ? "Promoting…" : "Promote"}
      </Button>

      {/*
        What is in the trunk already, before anybody presses anything. This is
        the half that survives a reload — `promoted_asset_count` is derived per
        read, so it is still right in a session that did not do the promoting.
      */}
      {summary === null && batch.promoted_asset_count > 0 && (
        <span
          className="text-xs text-muted-foreground"
          data-testid={`promoted-count-${batch.name}`}
        >
          {batch.promoted_asset_count} of {batch.asset_count} in the dataset
        </span>
      )}

      {summary !== null && (
        <span className="text-xs text-muted-foreground" data-testid={`promoted-${batch.name}`}>
          {summary}
        </span>
      )}

      {/*
        The way onward. Promotion's whole evidence lives on the dataset screen,
        and until now nothing linked there from the place the work was finished —
        so a person was told something had happened and left to find it.
      */}
      {promote.isSuccess && onOpenDataset !== undefined && (
        <Button
          variant="link"
          className="h-auto p-0"
          data-testid={`promoted-open-dataset-${batch.name}`}
          onClick={onOpenDataset}
        >
          Open the dataset
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Button>
      )}

      {promote.isError && (
        <FieldError data-testid={`promote-error-${batch.name}`}>
          {refusalProse(promote.error)}
        </FieldError>
      )}
    </div>
  );
}
