/**
 * The project's batches at a glance: what is moving, what waits on somebody, and
 * what is already in the dataset.
 *
 * ## A pointer, not a second Batches section
 *
 * `navigation.md`: *Overview never duplicates a section's full function.* So
 * every row opens its batch and nothing on this card changes one — Approve,
 * Start, Complete and Promote stay where their gating, their dialogs and their
 * refusals already live. The row says which of those the batch is waiting on in
 * words ("Draft", "Completed · 1,440 of 4,320 in dataset"), and the batch's own
 * page is one press away.
 *
 * ## Settled batches fold
 *
 * A batch whose every image is in the dataset has nothing left to ask of anyone,
 * so after the first few it folds behind "Show N more" rather than pushing the
 * live ones off the card. The fold is local state: what is unfolded is not a
 * place (`navigation.md`, *Not everything selectable is a place*).
 *
 * ## Phase is a display word
 *
 * `phase` is the adapter's reading of state plus trunk membership, for drawing
 * only. Whether a batch *may* be promoted is `allowed_actions`, read by the
 * Batches section — this card never asks.
 */

import { CircleCheck } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";

import { Button, CardContent, CardFooter, cn } from "@robomous/ui-core";
import { formatCount } from "../../lib/format";
import { ProgressRing } from "../ProgressRing";
import { ProjectCard } from "./ProjectCard";

export type BatchPhase = "draft" | "approved" | "annotating" | "completed" | "in_dataset";

export interface BatchSummaryItem {
  readonly id: string;
  readonly name: string;
  readonly phase: BatchPhase;
  /** Images in the batch. */
  readonly total: number;
  /** Images still waiting on a person; `null` before the batch has jobs. */
  readonly remaining: number | null;
  /** Whole-number share decided; `null` before the batch has jobs. */
  readonly percent: number | null;
  /** Images of this batch currently in the dataset. */
  readonly inDataset: number;
}

export interface BatchSummaryProps {
  /** In display order — live work first. */
  readonly items: readonly BatchSummaryItem[];
  readonly subtitle?: ReactNode;
  readonly onOpenBatch?: (batchId: string) => void;
  /** How many settled batches show before the fold. */
  readonly settledShown?: number;
  /** One pill per batch up to this many; past it the strip is proportional. */
  readonly stripMax?: number;
}

/** The legend's three groups, in work order. */
type Group = "done" | "open" | "draft";

function groupOf(phase: BatchPhase): Group {
  if (phase === "completed" || phase === "in_dataset") return "done";
  if (phase === "draft") return "draft";
  return "open";
}

const GROUP_FILL: Record<Group, string> = {
  done: "bg-success",
  open: "bg-info",
  draft: "bg-transparent ring-1 ring-inset ring-foreground/25",
};

const GROUP_LABEL: Record<Group, string> = { done: "completed", open: "open", draft: "draft" };

export function BatchSummary({
  items,
  subtitle,
  onOpenBatch,
  settledShown = 2,
  stripMax = 30,
}: BatchSummaryProps): JSX.Element {
  const [unfolded, setUnfolded] = useState(false);
  const live = items.filter((item) => item.phase !== "in_dataset");
  const settled = items.filter((item) => item.phase === "in_dataset");
  const folded = unfolded ? 0 : Math.max(0, settled.length - settledShown);
  const shown = [...live, ...settled.slice(0, settled.length - folded)];

  return (
    <ProjectCard title="Batches" subtitle={subtitle} data-testid="overview-batches">
      <CardContent className="flex-1 px-2">
        {items.length === 0 ? (
          <p className="px-2 py-6 text-xs text-muted-foreground" data-testid="batches-none">
            No batches yet. An ingest creates one.
          </p>
        ) : (
          <ul className="flex flex-col">
            {shown.map((item) => (
              <li key={item.id}>
                <BatchRow item={item} {...(onOpenBatch === undefined ? {} : { onOpen: () => onOpenBatch(item.id) })} />
              </li>
            ))}
            {folded > 0 && (
              <li>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-8 h-8 px-2 text-muted-foreground"
                  data-testid="batches-unfold"
                  onClick={() => setUnfolded(true)}
                >
                  Show {folded} more in the dataset
                </Button>
              </li>
            )}
          </ul>
        )}
      </CardContent>
      {items.length > 0 && (
        <CardFooter className="gap-3 border-t text-xs text-muted-foreground">
          <span className="shrink-0 tabular-nums text-foreground">
            {formatCount(items.length)} {items.length === 1 ? "batch" : "batches"}
          </span>
          <Strip items={items} max={stripMax} />
          <Legend items={items} />
        </CardFooter>
      )}
    </ProjectCard>
  );
}

function BatchRow({ item, onOpen }: { readonly item: BatchSummaryItem; readonly onOpen?: () => void }): JSX.Element {
  const settled = item.phase === "in_dataset";
  const body = (
    <>
      <PhaseMark item={item} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={cn("truncate font-medium", settled ? "text-muted-foreground" : "text-foreground")}>
          {item.name}
        </span>
        <PhaseWord item={item} />
      </span>
      <Trailing item={item} />
    </>
  );
  const row = "flex h-10 w-full items-center gap-3 rounded-md px-2 text-left text-sm";
  if (onOpen === undefined) return <div className={row}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`overview-batch-${item.id}`}
      className={cn(row, "outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50")}
    >
      {body}
    </button>
  );
}

/** The state as a shape, so it survives without colour. */
function PhaseMark({ item }: { readonly item: BatchSummaryItem }): JSX.Element {
  if (item.phase === "completed" || item.phase === "in_dataset") {
    return <CircleCheck className="size-5 shrink-0 fill-success text-background" aria-hidden="true" />;
  }
  if (item.phase === "draft") {
    return (
      <svg viewBox="0 0 20 20" className="size-5 shrink-0 text-muted-foreground" aria-hidden="true">
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 2.5" />
      </svg>
    );
  }
  // The shared ring, at the marks' 20px: the share decided as an arc, in `progress`.
  return <ProgressRing value={item.percent ?? 0} total={100} className="size-5" />;
}

function PhaseWord({ item }: { readonly item: BatchSummaryItem }): JSX.Element | null {
  switch (item.phase) {
    case "annotating":
      return <span className="shrink-0 text-xs text-info">In annotation</span>;
    case "approved":
      return <span className="shrink-0 text-xs text-info">Approved</span>;
    case "draft":
      return <span className="shrink-0 text-xs text-muted-foreground">Draft</span>;
    case "completed":
      return (
        <span className="truncate text-xs text-muted-foreground">
          <span className="text-success">Completed</span>
          {item.inDataset > 0 && ` · ${formatCount(item.inDataset)} of ${formatCount(item.total)} in dataset`}
        </span>
      );
    case "in_dataset":
      return null;
  }
}

function Trailing({ item }: { readonly item: BatchSummaryItem }): JSX.Element | null {
  if (item.phase === "in_dataset") {
    return (
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        In dataset · {formatCount(item.inDataset)}
      </span>
    );
  }
  if (item.phase === "draft" || item.phase === "completed") {
    const count = item.phase === "draft" ? item.total : item.total - item.inDataset;
    return (
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatCount(count)} {item.phase === "draft" ? "images" : "not in dataset"}
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
      {item.remaining !== null && (
        <span className="text-xs text-muted-foreground">{formatCount(item.remaining)} left</span>
      )}
      <span className="w-10 text-right font-semibold text-foreground">
        {item.percent === null ? "" : `${item.percent}%`}
      </span>
    </span>
  );
}

/**
 * Every batch as one pill, coloured by its group — the card's shape in one line.
 * Past `max` the pills would be slivers, so the strip turns proportional.
 */
function Strip({ items, max }: { readonly items: readonly BatchSummaryItem[]; readonly max: number }): JSX.Element {
  const ordered = [...items].sort((a, b) => GROUPS.indexOf(groupOf(a.phase)) - GROUPS.indexOf(groupOf(b.phase)));
  if (ordered.length <= max) {
    return (
      <span className="flex min-w-0 flex-1 gap-1" aria-hidden="true">
        {ordered.map((item) => (
          <span key={item.id} className={cn("h-1.5 flex-1 rounded-full", GROUP_FILL[groupOf(item.phase)])} />
        ))}
      </span>
    );
  }
  const counts = countGroups(items);
  return (
    <span className="flex min-w-0 flex-1 gap-1" aria-hidden="true">
      {GROUPS.filter((group) => counts[group] > 0).map((group) => (
        <span key={group} className={cn("h-1.5 rounded-full", GROUP_FILL[group])} style={{ flexGrow: counts[group] }} />
      ))}
    </span>
  );
}

const GROUPS: readonly Group[] = ["done", "open", "draft"];

function countGroups(items: readonly BatchSummaryItem[]): Record<Group, number> {
  const counts: Record<Group, number> = { done: 0, open: 0, draft: 0 };
  for (const item of items) counts[groupOf(item.phase)] += 1;
  return counts;
}

function Legend({ items }: { readonly items: readonly BatchSummaryItem[] }): JSX.Element {
  const counts = countGroups(items);
  return (
    <span className="flex shrink-0 items-center gap-3 tabular-nums" data-testid="batches-legend">
      {GROUPS.filter((group) => counts[group] > 0).map((group) => (
        <span key={group} className="flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", GROUP_FILL[group])} aria-hidden="true" />
          {formatCount(counts[group])} {GROUP_LABEL[group]}
        </span>
      ))}
    </span>
  );
}
