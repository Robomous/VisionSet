/**
 * One of the project's headline numbers, as a tile that points at its owner.
 *
 * The Overview's top row. The rule is the dashboard rule in
 * `docs/content/ui/navigation.md`: **Overview never duplicates a section's full
 * function**, so every number on it is a pointer at the section that owns it,
 * drawn as a real `<button>` so a keyboard reaches it and a screen reader
 * announces it as an action. A tile with nowhere to go is a plain statistic and
 * stays a `<div>` — not a disabled button, because it is not a refused action.
 *
 * Data-only, like everything under `patterns/`: the value arrives formatted and
 * the destination arrives as a callback.
 */

import type { LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "@robomous/ui-core";

export interface ProjectKpiProps {
  readonly icon: LucideIcon;
  readonly label: string;
  /** Pre-formatted. `null` while the source is still answering — the tile keeps its height. */
  readonly value: string | null;
  /**
   * A unit drawn quieter than the value it follows, so `76%` reads as a number
   * with a sign rather than as four characters of equal weight.
   */
  readonly unit?: string;
  /** Set the value in the mono face — a release tag is an identifier, not a quantity. */
  readonly mono?: boolean;
  /** One short line under the value: a denominator, a date, a caveat. */
  readonly context?: ReactNode;
  readonly onGo?: () => void;
  readonly className?: string;
  readonly "data-testid"?: string;
}

const TILE =
  "flex min-w-0 flex-col gap-2 rounded-lg bg-card p-4 text-left text-card-foreground ring-1 ring-foreground/10";

export function ProjectKpi({
  icon: Icon,
  label,
  value,
  unit,
  mono = false,
  context,
  onGo,
  className,
  "data-testid": testId,
}: ProjectKpiProps): JSX.Element {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {label}
      </span>
      <span
        className={cn(
          "truncate text-2xl font-semibold tabular-nums tracking-tight text-foreground",
          mono && "font-mono tracking-normal",
        )}
      >
        {value ?? "—"}
        {value !== null && unit !== undefined && (
          <span className="text-base font-normal text-muted-foreground">{unit}</span>
        )}
      </span>
      {/* A context line is reserved even when empty, so a row of tiles keeps one baseline. */}
      <span className="min-h-4 truncate text-xs tabular-nums text-muted-foreground">{context}</span>
    </>
  );

  if (onGo === undefined) {
    return (
      <div className={cn(TILE, className)} data-testid={testId}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onGo}
      data-testid={testId}
      // Instant hover: this is a dashboard someone scans, not a moment to watch.
      className={cn(
        TILE,
        "outline-none transition-transform duration-100 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.99] motion-reduce:transition-none",
        className,
      )}
    >
      {body}
    </button>
  );
}
