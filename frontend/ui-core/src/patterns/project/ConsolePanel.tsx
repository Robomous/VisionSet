/**
 * The Overview's panel: a titled surface with a count, a tool row and an
 * optional footer, drawn flat so several sit side by side at console density.
 *
 * The header wraps rather than overflowing, because a panel's tools (a view
 * switch, a filter) have widths they cannot shrink past and a phone is narrower
 * than both together.
 */

import type { JSX, ReactNode } from "react";

import { cn } from "@robomous/ui-core";

export interface ConsolePanelProps {
  readonly title: string;
  /** Pre-formatted — "6", or "2 of 6" while a filter narrows the rows. */
  readonly count?: string;
  readonly tools?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  /**
   * The body scrolls inside the panel instead of growing it — for a panel
   * whose height the layout fixes, so its content can never move the page.
   */
  readonly scroll?: boolean;
  readonly "data-testid"?: string;
}

/**
 * The Overview's two-column rows: a wide panel and a fixed side column, the
 * same split on every row so their edges line up down the page.
 */
export const CONSOLE_COLUMNS = "grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]";

/** Every Overview surface — cards and panels — shares one corner and one depth. */
export const CONSOLE_SURFACE = "rounded-xl bg-card text-card-foreground shadow-xs ring-1 ring-foreground/10";

export function ConsolePanel({ title, count, tools, footer, children, className, scroll = false, "data-testid": testId }: ConsolePanelProps): JSX.Element {
  return (
    <section className={cn("flex min-w-0 flex-col overflow-hidden", CONSOLE_SURFACE, className)} aria-label={title} data-testid={testId}>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {count !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{count}</span>}
        {tools !== undefined && <div className="ml-auto flex flex-wrap items-center gap-2">{tools}</div>}
      </div>
      {/* `relative` makes the scroller the containing block of anything absolutely
          placed inside it — a row's screen-reader text included — so it clips
          them, instead of letting them widen the page from outside it. */}
      <div className={cn("min-w-0 flex-1", scroll && "relative min-h-0 overflow-auto")}>{children}</div>
      {footer !== undefined && (
        <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 border-t px-4 py-1 text-[11px] text-muted-foreground">{footer}</div>
      )}
    </section>
  );
}

/** A panel with nothing in it yet: what this place is, and the one next step. */
export function ConsoleEmpty({ children, "data-testid": testId }: { readonly children: ReactNode; readonly "data-testid"?: string }): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-6 text-sm text-pretty text-muted-foreground" data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * A thin progress meter, where a bar's length is the point — a row of them
 * compared down a column. Static: these numbers are read, not watched. The fill
 * is `progress` and the track its own hue at 15%, as a `ProgressRing`'s are; a
 * short readout beside a number is a `ProgressReadout` instead.
 */
export function Meter({ value, total, tone = "bg-progress", className }: { readonly value: number; readonly total: number; readonly tone?: string; readonly className?: string }): JSX.Element {
  const share = total === 0 ? 0 : Math.min(1, value / total);
  return (
    <span className={cn("block h-1 w-16 shrink-0 overflow-hidden rounded-full bg-progress/15", className)} aria-hidden="true">
      <span className={cn("block h-full rounded-full", tone)} style={{ width: `${share * 100}%` }} />
    </span>
  );
}
