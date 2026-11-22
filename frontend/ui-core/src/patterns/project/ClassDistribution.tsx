/**
 * How the project's labels split across its classes.
 *
 * One row per class inside an inset panel: swatch and name, the count quiet and
 * the share loud, then a bar whose length **is** that share. The bar is measured
 * against the whole rather than against the largest row, so a bar and the
 * percentage beside it never disagree — the largest class at 35% fills a third
 * of its track, not all of it.
 *
 * ## Two lenses
 *
 * *Annotations* answers "where did the labeling effort go"; *Assets* answers "how
 * many images show this class". They are different questions — a thousand labels
 * over ten crowded images and over a thousand sparse ones are the same total —
 * so the card offers both rather than picking one. An image can show several
 * classes, so asset shares do not sum to 100% and a folded "Other" row has no
 * honest count in that lens: the adapter says so with a `null`, and the row then
 * names how many classes it holds and draws no number.
 *
 * Data-only. The colour is resolved by the caller (`classColor`, the canvas's own
 * spelling) and applied inline — `DESIGN.md`'s sanctioned exception, since
 * Tailwind has never seen a colour the schema authored.
 */

import { Scale } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { CardContent, CardFooter } from "@robomous/ui-core";
import { formatCount, formatShare } from "../../lib/format";
import { ProjectCard } from "./ProjectCard";
import { ViewSwitch } from "./ViewSwitch";

export type DistributionLens = "annotations" | "assets";

export interface ClassShareRow {
  readonly key: string;
  readonly label: string;
  /** The class colour; `null` for the folded remainder, which is drawn neutral. */
  readonly color: string | null;
  /** `null` where the lens has no honest count for the row (assets, folded). */
  readonly count: number | null;
  /** 0–1 of the lens's whole; `null` alongside a `null` count. */
  readonly share: number | null;
}

export interface ClassDistributionProps {
  readonly lens: DistributionLens;
  readonly onLensChange: (lens: DistributionLens) => void;
  readonly subtitle?: ReactNode;
  readonly rows: readonly ClassShareRow[];
  /** Shown in place of the rows when there are none. */
  readonly empty: ReactNode;
  /** One line about the shape of the distribution, e.g. the imbalance note. */
  readonly note?: string | null;
}

const LENSES = [
  { value: "annotations", label: "Annotations" },
  { value: "assets", label: "Assets" },
] as const;

export function ClassDistribution({
  lens,
  onLensChange,
  subtitle,
  rows,
  empty,
  note,
}: ClassDistributionProps): JSX.Element {
  return (
    <ProjectCard
      title="Class distribution"
      subtitle={subtitle}
      data-testid="overview-distribution"
      action={
        <ViewSwitch
          label="Count by"
          value={lens}
          options={LENSES}
          onChange={onLensChange}
          data-testid="distribution-lens"
        />
      }
    >
      {/* Inset by half the card's gutter, so the panel reads as a well in the card. */}
      <CardContent className="flex flex-1 flex-col px-2">
        {rows.length === 0 ? (
          <div className="flex min-h-40 flex-1 items-center justify-center rounded-md bg-muted/50 p-6 text-center text-xs text-muted-foreground" data-testid="distribution-none">
            {empty}
          </div>
        ) : (
          <ul className="flex flex-1 flex-col justify-between gap-5 rounded-md bg-muted/50 px-3 py-4 ring-1 ring-inset ring-foreground/5">
            {rows.map((row) => (
              <ShareRow key={row.key} row={row} />
            ))}
          </ul>
        )}
      </CardContent>
      {note !== undefined && note !== null && (
        <CardFooter className="gap-2 text-xs text-muted-foreground" data-testid="imbalance-note">
          <Scale className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="text-pretty">{note}</span>
        </CardFooter>
      )}
    </ProjectCard>
  );
}

function ShareRow({ row }: { readonly row: ClassShareRow }): JSX.Element {
  const swatch = row.color === null ? undefined : { backgroundColor: row.color };
  return (
    <li className="flex flex-col gap-2" data-testid="distribution-row">
      <div className="flex items-center gap-2 text-sm">
        <span
          className={row.color === null ? "size-2 shrink-0 rounded-[2px] bg-muted-foreground" : "size-2 shrink-0 rounded-[2px]"}
          style={swatch}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-foreground">{row.label}</span>
        {row.count !== null && (
          <span className="text-xs tabular-nums text-muted-foreground">{formatCount(row.count)}</span>
        )}
        <span className="w-14 shrink-0 text-right font-semibold tabular-nums text-foreground">
          {row.share === null ? "" : formatShare(row.share)}
        </span>
      </div>
      {row.share !== null && (
        // The bar repeats the percentage beside it, so it is decoration to a
        // screen reader — the row's text already says everything it does.
        <div className="h-1.5 overflow-hidden rounded-[2px] bg-foreground/10" aria-hidden="true">
          <div
            className={row.color === null ? "h-full rounded-[2px] bg-muted-foreground" : "h-full rounded-[2px]"}
            style={{ width: `${Math.min(100, row.share * 100)}%`, ...swatch }}
          />
        </div>
      )}
    </li>
  );
}
