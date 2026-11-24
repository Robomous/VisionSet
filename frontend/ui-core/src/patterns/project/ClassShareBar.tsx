/**
 * The classes as one composition: a bar split by each class's share of all
 * annotations, and the readout of the class under the pointer — the largest
 * until one is pointed at. The Classes panel draws it over its legend
 * (`ClassRail`); the Overview draws it alone, in its Classes KPI, where the
 * legend is one door away.
 *
 * Shares are of annotations only: an asset can show several classes, so
 * per-asset shares overlap and would not sum to a whole. The bar is one image
 * to assistive technology, named with every share, so no class is told by
 * colour alone.
 */

import { useState, type JSX } from "react";

import { cn } from "@robomous/ui-core";
import { formatCount } from "../../lib/format";

export interface ShareRow {
  readonly name: string;
  readonly color: string;
  readonly annotations: number;
  readonly images: number;
}

function share(part: number, whole: number): string {
  if (whole === 0 || part === 0) return "—";
  const v = (part / whole) * 100;
  return v < 1 ? "<1%" : `${Math.round(v)}%`;
}

export function ClassShareBar({
  rows,
  totalAnnotations,
  pointed,
  onPoint,
  emphasis,
  className,
}: {
  /** Ranked, largest first; a class with no annotations draws no block. */
  readonly rows: readonly ShareRow[];
  readonly totalAnnotations: number;
  /** The class under the pointer — or pinned — whose figures the readout says. */
  readonly pointed: string | null;
  readonly onPoint: (name: string | null) => void;
  /** The class whose figures the readout says when none is pointed at; the largest by default. */
  readonly emphasis?: string | null;
  readonly className?: string;
}): JSX.Element {
  const drawn = rows.filter((row) => row.annotations > 0);
  const focus = rows.find((row) => row.name === (pointed ?? emphasis)) ?? drawn[0];
  const quiet = (name: string): boolean => pointed !== null && pointed !== name;
  if (drawn.length === 0) {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <span className="block h-2 rounded-[3px] bg-muted" aria-hidden="true" />
        <p className="flex h-6 items-center text-xs text-muted-foreground">No annotations yet.</p>
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-2", className)} onMouseLeave={() => onPoint(null)}>
      <div className="flex h-2 w-full gap-0.5 overflow-hidden" role="img" aria-label={drawn.map((row) => `${row.name} ${share(row.annotations, totalAnnotations)}`).join(", ")}>
        {drawn.map((row) => (
          <span
            key={row.name}
            // Pointing lifts a block and quiets the rest: instant, the pointer sweeps across these.
            onMouseEnter={() => onPoint(row.name)}
            className={cn("h-full transition-opacity duration-150 ease-out first:rounded-l-[3px] last:rounded-r-[3px]", quiet(row.name) && "opacity-30")}
            style={{ flexGrow: row.annotations, flexBasis: 0, minWidth: 2, background: row.color }}
          />
        ))}
      </div>
      {focus !== undefined && (
        <p className="flex h-6 min-w-0 items-baseline gap-2 tabular-nums" aria-live="polite" data-testid="class-readout">
          <span className="text-base font-semibold tracking-tight">{share(focus.annotations, totalAnnotations)}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            <span className="text-foreground">{focus.name}</span> · {formatCount(focus.annotations)} on {formatCount(focus.images)} {focus.images === 1 ? "asset" : "assets"}
          </span>
        </p>
      )}
    </div>
  );
}

/** The bar on its own, holding which class is pointed at: the Overview's Classes cell. */
export function ClassShares({ rows, totalAnnotations, className }: { readonly rows: readonly ShareRow[]; readonly totalAnnotations: number; readonly className?: string }): JSX.Element {
  const [pointed, setPointed] = useState<string | null>(null);
  return <ClassShareBar rows={rows} totalAnnotations={totalAnnotations} pointed={pointed} onPoint={setPointed} className={className} />;
}
