/**
 * What a progress indicator says when pointed at: one line, one bar, the parts
 * named — read in passing along a column.
 *
 * ## The card
 *
 * Whose progress and how far — *Labeled 10 of 24 · 42%* — on one line; the
 * whole split as one segmented bar, each part in its state's colour; the parts
 * named inline under it, the count first in tabular figures; and, where there
 * is one, whose it is (the batch, who holds the job) under a hairline. Where
 * the wire has no split, the bar is the share done and the note says the rest.
 *
 * ## When it opens, and how
 *
 * - **The first card waits** (`PROGRESS_CARD_DELAY`, 450ms) for intent; a
 *   pointer crossing the table does not set cards flashing.
 * - **The next opens at once, without motion** (`PROGRESS_CARD_CHAIN`): once
 *   one has been open, the person is reading along the column.
 * - **Keyboard focus opens it at once**, and the indicator takes focus, so
 *   what the pointer can learn the keyboard can too.
 * - **It enters from its trigger** — Radix's transform origin — scaled from
 *   0.96 and faded over 160ms on the strong ease-out, and leaves in 100ms; its
 *   bar's parts grow from their left edges, 30ms apart, just behind it. Under
 *   reduced motion only its opacity changes, and the bar is simply there.
 */

import { HoverCard, HoverCardContent, HoverCardTrigger, cn } from "@robomous/ui-core";
import { useEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from "react";

import { formatCount } from "../lib/format";
import { percentDone, segmentShare, SEGMENT_FILL, type ProgressDetail } from "./progressDetail";
import { inProgressChain, markProgressCardClosed, PROGRESS_CARD_DELAY } from "./progressHoverTiming";
import type { ProgressTone } from "./ProgressRing";

export interface ProgressHoverCardProps {
  readonly detail: ProgressDetail;
  readonly value: number;
  readonly total: number;
  readonly tone: ProgressTone;
  readonly complete: boolean;
  /** The indicator itself: the card's trigger. */
  readonly children: ReactNode;
}

export function ProgressHoverCard({ detail, value, total, tone, complete, children }: ProgressHoverCardProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function change(next: boolean): void {
    window.clearTimeout(timer.current);
    if (!next) {
      if (open) markProgressCardClosed();
      setOpen(false);
      return;
    }
    if (inProgressChain()) {
      setInstant(true);
      setOpen(true);
      return;
    }
    setInstant(false);
    timer.current = window.setTimeout(() => setOpen(true), PROGRESS_CARD_DELAY);
  }

  return (
    <HoverCard open={open} onOpenChange={change} openDelay={0} closeDelay={80}>
      <HoverCardTrigger asChild>
        {/* Above a cell's stretched link, so the pointer reaches it; a tab stop, so the keyboard does. */}
        <span
          tabIndex={0}
          className="relative z-10 inline-flex min-w-0 cursor-default rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          onFocus={() => {
            window.clearTimeout(timer.current);
            setInstant(inProgressChain());
            setOpen(true);
          }}
          onBlur={() => change(false)}
          data-progress-trigger=""
        >
          {children}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        sideOffset={8}
        collisionPadding={12}
        data-instant={instant ? "" : undefined}
        className="vs-progress-card w-60 p-2.5 data-open:animate-none data-closed:animate-none"
        data-testid="progress-card"
      >
        <Card detail={detail} value={value} total={total} tone={tone} complete={complete} />
      </HoverCardContent>
    </HoverCard>
  );
}

function Card({ detail, value, total, tone, complete }: Omit<ProgressHoverCardProps, "children">): JSX.Element {
  const segments = detail.segments ?? [];
  const plain = complete ? "bg-success" : tone === "info" ? "bg-info" : "bg-progress";
  return (
    <div className="flex flex-col gap-2 text-xs tabular-nums">
      <p className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-medium text-foreground">{detail.title}</span>
        <span className="min-w-0 truncate text-muted-foreground">
          {formatCount(value)} of {formatCount(total)} · {percentDone(value, total, complete)}%
        </span>
      </p>
      {/* One bar, the whole: each part grows from its own left edge, 30ms after the one before it. */}
      <span aria-hidden="true" className={cn("flex h-1.5 w-full gap-px overflow-hidden rounded-full", segments.length === 0 && "bg-progress/15")}>
        {segments.length === 0 ? (
          <span className={cn("vs-progress-grow h-full rounded-full", plain)} style={{ width: `${total <= 0 ? 0 : Math.min(1, value / total) * 100}%` }} />
        ) : (
          segments.map((one, i) => (
            <span
              key={one.key}
              className={cn("vs-progress-grow h-full first:rounded-l-full last:rounded-r-full", SEGMENT_FILL[one.tone])}
              style={{ width: `${segmentShare(one, total) * 100}%`, "--vs-i": i } as CSSProperties}
            />
          ))
        )}
      </span>
      {segments.length > 0 ? (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground" data-testid="progress-card-parts">
          {segments.map((one) => (
            <span key={one.key} className="inline-flex items-center gap-1.5">
              {/* Not started is a hollow dot: it holds nothing yet, and a 15% tint would vanish on the dark theme. */}
              <span aria-hidden="true" className={cn("size-1.5 rounded-full", one.tone === "empty" ? "border border-muted-foreground/60" : SEGMENT_FILL[one.tone])} />
              <span className="text-foreground">{formatCount(one.count)}</span>
              {one.label.toLowerCase()}
            </span>
          ))}
        </p>
      ) : (
        detail.note !== undefined && <p className="text-pretty text-muted-foreground">{detail.note}</p>
      )}
      {segments.length > 0 && detail.caption !== undefined && <p className="truncate border-t border-border/70 pt-2 text-muted-foreground">{detail.caption}</p>}
    </div>
  );
}
