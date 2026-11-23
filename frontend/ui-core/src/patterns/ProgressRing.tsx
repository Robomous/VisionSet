/**
 * Progress, said the one way the app says it: the number, then a small ring.
 *
 * ## The composition
 *
 * - **The number comes first and is quiet.** `muted-foreground`, regular weight,
 *   tabular figures so it never shifts as it counts; a `%` is the digits' own
 *   size and colour. The ring is its glance, not its label — it trails.
 * - **The ring is small and sure.** 14px by default, a little taller than the
 *   text's capitals; the stroke is about a sixth of the diameter, with round
 *   ends. It starts at twelve o'clock and fills clockwise.
 * - **The track is a tint, not a grey.** `progress` at 15% — the arc's own hue,
 *   faint — so the empty part reads as the same object.
 * - **The arc is `progress` while partway, `success` once done.** A dedicated
 *   colour, apart from warning: partway is not a problem.
 * - **The glance never lies.** While anything is left the ring stays open (a
 *   true 97% would read as closed), and once anything is done it shows (a true
 *   1% would read as empty). The number says the exact value.
 * - **A gap the ring's own width** between number and ring, so the two read as
 *   a pair, not as one smudge.
 *
 * Nothing in it animates: these values are read, and they change on a refetch
 * rather than as you watch.
 */

import { cn } from "@robomous/ui-core";
import type { JSX, ReactNode } from "react";

import { ProgressHoverCard } from "./ProgressHoverCard";
import type { ProgressDetail } from "./progressDetail";

const SIZE = 16;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const LENGTH = 2 * Math.PI * RADIUS;

export type ProgressTone = "progress" | "info";

const ARC: Record<ProgressTone, string> = { progress: "stroke-progress", info: "stroke-info" };
const TRACK: Record<ProgressTone, string> = { progress: "stroke-progress/15", info: "stroke-info/15" };

export interface ProgressRingProps {
  readonly value: number;
  readonly total: number;
  /** `info` for a model's own work (drafting labels); `progress` for everything else. */
  readonly tone?: ProgressTone;
  /**
   * Whether the work is done, when the caller knows better than the count — a
   * project whose images all carry a model's pre-label still has frames nobody
   * read. Unset, done is `value >= total`.
   */
  readonly complete?: boolean;
  /** Sizes the ring; 14px (`size-3.5`) unless told. */
  readonly className?: string;
  readonly "data-testid"?: string;
  /** What it can say beyond the number, when pointed at. */
  readonly detail?: ProgressDetail;
}

/** An indicator with something more to say opens its card when pointed at or focused; one without is just itself. */
function WithDetail({ detail, value, total, tone, complete, children }: Pick<ProgressRingProps, "detail" | "value" | "total" | "tone" | "complete"> & { readonly children: ReactNode }): JSX.Element {
  if (detail === undefined) return <>{children}</>;
  return (
    <ProgressHoverCard detail={detail} value={value} total={total} tone={tone ?? "progress"} complete={complete ?? (total > 0 && value >= total)}>
      {children}
    </ProgressHoverCard>
  );
}

/** The share done as an arc from twelve o'clock, clockwise; a closed `success` ring once all of it is. */
export function ProgressRing({ detail, ...props }: ProgressRingProps): JSX.Element {
  return (
    <WithDetail detail={detail} value={props.value} total={props.total} tone={props.tone} complete={props.complete}>
      <Ring {...props} />
    </WithDetail>
  );
}

function Ring({ value, total, tone = "progress", complete, className, "data-testid": testId }: Omit<ProgressRingProps, "detail">): JSX.Element {
  const fraction = total <= 0 ? 0 : Math.max(0, Math.min(1, value / total));
  const done = complete ?? (total > 0 && value >= total);
  // Open while anything is left, visible once anything is done.
  const shown = done ? 1 : fraction <= 0 ? 0 : Math.min(Math.max(fraction, 0.06), 0.92);
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${SIZE} ${SIZE}`} className={cn("size-3.5 shrink-0 -rotate-90", className)} data-progress-ring={done ? "done" : "partway"} data-testid={testId}>
      <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className={done ? "stroke-success/15" : TRACK[tone]} />
      {shown > 0 && (
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={done ? undefined : `${shown * LENGTH} ${LENGTH}`}
          className={done ? "stroke-success" : ARC[tone]}
        />
      )}
    </svg>
  );
}

export interface ProgressReadoutProps extends Omit<ProgressRingProps, "data-testid"> {
  /** What the number says — "37%", "10/24", "10 of 24 · 42%". The ring is drawn from `value`/`total`. */
  readonly children: ReactNode;
  /** Sizes the ring, as `className` does on `ProgressRing`. */
  readonly ringClassName?: string;
  readonly ringTestId?: string;
  readonly "data-testid"?: string;
}

/** The number, quiet and tabular, then the ring a ring's width after it. */
export function ProgressReadout({ value, total, tone, complete, detail, className, ringClassName, ringTestId, children, "data-testid": testId }: ProgressReadoutProps): JSX.Element {
  return (
    <WithDetail detail={detail} value={value} total={total} tone={tone} complete={complete}>
    <span className={cn("inline-flex min-w-0 items-center gap-2.5 text-muted-foreground tabular-nums", className)} data-testid={testId}>
      <span className="min-w-0 truncate">{children}</span>
      <Ring
        value={value}
        total={total}
        {...(tone === undefined ? {} : { tone })}
        {...(complete === undefined ? {} : { complete })}
        {...(ringClassName === undefined ? {} : { className: ringClassName })}
        {...(ringTestId === undefined ? {} : { "data-testid": ringTestId })}
      />
    </span>
    </WithDetail>
  );
}
