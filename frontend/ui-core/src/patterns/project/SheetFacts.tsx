/**
 * The batch sheet's first three properties.
 *
 * - **State** is its chip, and beside it the batch's next step — the bar's
 *   forward control (`useForwardStep`), or *Open the dataset ↗* once the batch is
 *   in it — which arrives when the row is pointed at or focused, as Images' way
 *   on does.
 * - **Labeled** is the batch table's own readout (`LabeledReadout`): *x of y ·
 *   z%*, the ring, and pointed at, the card that splits the images by state.
 * - **Images** is the count, and a button: the way to them, in the Images
 *   section narrowed to the batch. "Open in Images ↗" arrives beside it when
 *   the row is pointed at or focused.
 *
 * What arrives on hover waits 4px to the left, unseen, and comes in on the
 * strong ease-out in 200ms; it leaves in 120ms. Without a pointer to hover with
 * it is simply there, and keyboard focus brings it too.
 *
 * ## Motion
 *
 * Nothing moves when J/K steps to the next batch: stepping is many times a
 * session and earns no motion. A press scales to 0.97.
 */

import { ArrowUpRight, CircleDashed, Images, ListChecks, type LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "@robomous/ui-core";
import { formatCount } from "../../lib/format";
import { StateChip } from "../StateChip";
import type { BatchRowView } from "./BatchTable";
import { phaseState, rowNoun } from "./batchRowModel";
import { LabeledReadout } from "./LabeledReadout";
import type { ForwardStep } from "./useForwardStep";

/** The house curve: a strong ease-out. */
const EASE = "ease-[cubic-bezier(0.23,1,0.32,1)]";

/** A control lights on hover — instantly, and only where there is a pointer to hover with. */
const HOVER = "[@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted/60";

/** A press presses: 0.97, back in 100ms. */
const PRESS = "transition-[background-color,scale] duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none";

/**
 * Focus on a value is the hover's wash and a hairline ring — visible, and no
 * heavier than the words it surrounds: J/K is pressed with focus here, so it is
 * seen often.
 */
const VALUE_FOCUS = "focus-visible:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring/60";

/** A value that is also a button: 28px tall, its wash reaching 6px past the words on either side. */
const VALUE_BUTTON = cn("-mx-1.5 flex h-7 w-fit max-w-[calc(100%+0.75rem)] items-center rounded-md px-1.5 outline-none", VALUE_FOCUS, PRESS, HOVER);

/** One property: an icon and its label in a fixed column, the value beside it, the label on the value's first line. */
export function Property({ icon: Icon, label, group = false, children }: { readonly icon: LucideIcon; readonly label: string; readonly group?: boolean; readonly children: ReactNode }): JSX.Element {
  return (
    // `group`: what the row's hover brings in (`ARRIVED`) answers the whole row, label included.
    <div className={cn("grid min-h-9 grid-cols-[9.5rem_minmax(0,1fr)] items-start gap-x-3 py-1 text-[13px]", group && "group/fact")}>
      <dt className="flex h-7 items-center gap-2 text-muted-foreground">
        <Icon aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0" />
        {label}
      </dt>
      <dd className="m-0 flex min-h-7 min-w-0 flex-col items-start justify-center tabular-nums [&>*]:max-w-full">{children}</dd>
    </div>
  );
}

/**
 * Arrives with the row: at rest 4px to the left and unseen, pointed at or
 * focused in place, 200ms in and 120ms out. Without a pointer it is simply there.
 */
const ARRIVES = cn(
  "transition-[opacity,translate] duration-120 motion-reduce:translate-x-0",
  EASE,
  "[@media(hover:hover)_and_(pointer:fine)]:-translate-x-1 [@media(hover:hover)_and_(pointer:fine)]:opacity-0",
);

/** Where the arriving part is inside the button that is pointed at or focused. */
const ARRIVED_IN_BUTTON =
  "[@media(hover:hover)_and_(pointer:fine)]:group-hover/browse:translate-x-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/browse:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-hover/browse:duration-200 group-focus-visible/browse:translate-x-0 group-focus-visible/browse:opacity-100 group-focus-visible/browse:duration-200";

/** What the row's own hover or focus brings in: the group is the property's row. */
const ARRIVED =
  "[@media(hover:hover)_and_(pointer:fine)]:group-hover/fact:translate-x-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/fact:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-hover/fact:duration-200 has-focus-visible:translate-x-0 has-focus-visible:opacity-100 has-focus-visible:duration-200";

export function StateFact({ row, next, onOpenDataset }: { readonly row: BatchRowView; readonly next: ForwardStep | null; readonly onOpenDataset: (() => void) | undefined }): JSX.Element {
  const fraction = row.done === null || row.total === 0 ? undefined : row.done / row.total;
  // In the dataset there is no step left, only the way to where its images went.
  const way = row.phase === "in_dataset" ? (onOpenDataset === undefined ? null : { label: "Open the dataset", press: onOpenDataset, away: true }) : next === null ? null : { ...next, away: false };
  return (
    <Property icon={CircleDashed} label="State" group>
      <span className="flex h-7 min-w-0 items-center gap-1.5">
        <StateChip state={phaseState(row.phase, { ...(fraction === undefined ? {} : { fraction }), card: true })} testId="batch-phase" />
        {way !== null && (
          // The arrival is the wrapper's, the press and the wash the button's: one transition each.
          <span className={cn("flex min-w-0", ARRIVES, ARRIVED)}>
            <button
              type="button"
              onClick={way.press}
              className={cn(
                "flex h-7 min-w-0 items-center gap-0.5 rounded-md px-1.5 text-xs text-muted-foreground outline-none [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground",
                VALUE_FOCUS,
                "transition-[background-color,color,scale] duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none",
                HOVER,
              )}
              data-testid="batch-sheet-next"
            >
              <span className="truncate">{way.label}</span>
              {way.away && <ArrowUpRight aria-hidden="true" strokeWidth={1.75} className="size-3.5 shrink-0" />}
            </button>
          </span>
        )}
      </span>
    </Property>
  );
}

export function LabeledFact({ row }: { readonly row: BatchRowView }): JSX.Element {
  const { done } = row;
  return (
    <Property icon={ListChecks} label="Labeled">
      {done === null ? (
        <span className="flex h-7 items-center text-muted-foreground/80">Not started</span>
      ) : (
        // The batch table's own readout, so the two say it alike — pointed at, the same card.
        <span className="flex h-7 min-w-0 items-center">
          <LabeledReadout row={row} done={done} />
        </span>
      )}
    </Property>
  );
}

export function ImagesFact({ row, onBrowse }: { readonly row: BatchRowView; readonly onBrowse: (() => void) | undefined }): JSX.Element {
  const noun = rowNoun(row, row.total);
  const count = (
    <span>
      {formatCount(row.total)} <span className="text-muted-foreground">{noun}</span>
    </span>
  );
  return (
    // Counted in the noun the table's name line uses (`rowNoun`).
    <Property icon={Images} label={rowNoun(row, 2).replace(/^./, (first) => first.toUpperCase())}>
      {onBrowse === undefined ? (
        <span className="flex h-7 items-center">{count}</span>
      ) : (
        <button
          type="button"
          onClick={onBrowse}
          // Starts with what it shows, so a spoken command finds it.
          aria-label={`${formatCount(row.total)} ${noun}, open in Images`}
          className={cn(VALUE_BUTTON, "group/browse gap-2")}
          data-testid="batch-sheet-assets"
        >
          {count}
          <span className={cn("flex items-center gap-0.5 text-xs text-muted-foreground", ARRIVES, ARRIVED_IN_BUTTON)}>
            Open in Images
            <ArrowUpRight aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
          </span>
        </button>
      )}
    </Property>
  );
}
