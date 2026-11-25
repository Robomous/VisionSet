/**
 * The project's classes as one composition, at the top of the Overview's rail.
 *
 * One bar split by each class's share of all annotations — the whole at a
 * glance — over a legend that is the way in: pointing at a key row lifts its
 * block and quiets the rest, and choosing one pins its figures above the list.
 * The bar and the list answer each other, so a class is never told by colour
 * alone. Shares are of annotations only: an asset can show several classes, so
 * per-asset shares overlap and would not sum to a whole.
 *
 * ## Eight, then Others
 *
 * The largest `CLASS_RAIL_ROWS` classes are named; the rest fold into one
 * Others row — one block in the bar, its members and their counts on hover —
 * so the panel is the same height for a project of nine classes or ninety.
 *
 * ## Warnings where the eye already is
 *
 * A class under the imbalance threshold carries a warning dot in a slot every
 * row reserves, so the numbers stay in one column. What it means is said on
 * hover and on focus, like every other detail here — and the band's "N thin"
 * badge holds the project's whole imbalance note — rather than a sentence that
 * pushes the list down whether anybody needs it or not.
 */

import { ArrowUpRight, Tags, TriangleAlert } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger, cn } from "@robomous/ui-core";
import { formatCount } from "../../lib/format";
import { ClassShareBar } from "./ClassShareBar";

export interface ClassRow {
  readonly name: string;
  readonly color: string;
  readonly annotations: number;
  /** Images showing the class at least once. */
  readonly images: number;
  /** Under the imbalance threshold — a model will struggle with it. */
  readonly thin: boolean;
}

/** How many classes the legend names before it folds the rest into Others. */
export const CLASS_RAIL_ROWS = 8;

export interface ClassRailProps {
  /** Ranked, largest first. */
  readonly rows: readonly ClassRow[];
  readonly totalAnnotations: number;
  /** The project's imbalance note, said on the band's badge. */
  readonly note: string | null;
  /** The Classes section. Absent, the band has no way in. */
  readonly onOpen?: () => void;
  readonly className?: string;
}

interface Shown extends ClassRow {
  /** Set on the Others row: the classes it stands for. */
  readonly members?: readonly ClassRow[];
}

function legend(rows: readonly ClassRow[]): readonly Shown[] {
  if (rows.length <= CLASS_RAIL_ROWS) return rows;
  const rest = rows.slice(CLASS_RAIL_ROWS);
  return [
    ...rows.slice(0, CLASS_RAIL_ROWS),
    {
      name: "Others",
      color: "var(--color-muted-foreground)",
      annotations: rest.reduce((sum, row) => sum + row.annotations, 0),
      images: rest.reduce((sum, row) => sum + row.images, 0),
      thin: rest.some((row) => row.thin),
      members: rest,
    },
  ];
}

function share(part: number, whole: number): string {
  if (whole === 0 || part === 0) return "—";
  const v = (part / whole) * 100;
  return v < 1 ? "<1%" : `${Math.round(v)}%`;
}

const thinNote = (row: ClassRow, whole: number): string =>
  `${row.name} is ${share(row.annotations, whole)} of annotations — a model will struggle to learn it.`;

/** A detail said on hover and on focus. Its trigger is always a real button. */
function Hint({ content, children }: { readonly content: ReactNode; readonly children: ReactNode }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-64 text-pretty">
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

export function ClassRail({ rows, totalAnnotations, note, onOpen, className }: ClassRailProps): JSX.Element {
  const shown = legend(rows);
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const quiet = (name: string): boolean => hover !== null && hover !== name;
  const thin = rows.filter((row) => row.thin).length;

  return (
    <section className={cn("flex min-w-0 shrink-0 flex-col bg-background", className)} aria-label="Classes" data-testid="overview-distribution">
      <header className="flex min-h-12 shrink-0 items-center gap-2.5 border-b border-border/70 px-4 py-2 md:px-6">
        <Tags aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <h2 className="text-sm font-semibold tracking-tight">Classes</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{formatCount(rows.length)}</span>
        <span className="ml-auto flex items-center gap-3">
          {thin > 0 && note !== null && (
            <Hint content={<span data-testid="imbalance-note">{note}</span>}>
              <button
                type="button"
                className="relative flex items-center gap-1 rounded-sm text-xs text-warning tabular-nums outline-none after:absolute after:-inset-2 focus-visible:ring-2 focus-visible:ring-ring/50"
                data-testid="classes-thin"
              >
                <TriangleAlert className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                {formatCount(thin)} thin
              </button>
            </Hint>
          )}
          {onOpen !== undefined && (
            <button
              type="button"
              onClick={onOpen}
              aria-label="Edit classes"
              data-testid="overview-edit-classes"
              className="vs-link relative flex items-center gap-1 rounded-sm text-xs text-muted-foreground underline-offset-4 outline-none after:absolute after:-inset-2 hover:text-foreground"
            >
              Edit
              <ArrowUpRight aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
            </button>
          )}
        </span>
      </header>

      {rows.length === 0 ? (
        <p className="px-4 py-4 text-xs text-pretty text-muted-foreground md:px-6">No classes yet. A class is what an annotation can say a shape is.</p>
      ) : (
        <div className="flex flex-col gap-3 px-4 pt-4 pb-3 md:px-6" onMouseLeave={() => setHover(null)}>
          <ClassShareBar rows={shown} totalAnnotations={totalAnnotations} pointed={hover} onPoint={setHover} emphasis={pinned} className="gap-3" />

          {/* Two columns wherever the rail has stacked under the batches at full
              width, ranked down each column; one inside the rail. */}
          <ol
            className="-mx-2 grid grid-cols-1 sm:grid-flow-col sm:grid-cols-2 sm:gap-x-6 xl:grid-flow-row xl:grid-cols-1"
            style={{ gridTemplateRows: `repeat(${Math.ceil(shown.length / 2)}, auto)` }}
            aria-label="Classes by annotations"
          >
            {shown.map((row) => (
              <li key={row.name} className="flex items-center" data-testid={`overview-class-${row.name}`}>
                <button
                  type="button"
                  aria-pressed={pinned === row.name}
                  disabled={row.annotations === 0}
                  onMouseEnter={() => row.annotations > 0 && setHover(row.name)}
                  onFocus={() => setHover(row.name)}
                  onBlur={() => setHover(null)}
                  onClick={() => setPinned(row.name)}
                  className={cn(
                    "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none transition-colors duration-150 ease-out hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:hover:bg-transparent aria-pressed:bg-muted",
                    quiet(row.name) && "text-muted-foreground",
                  )}
                >
                  <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: row.color }} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    {row.name}
                    {row.members !== undefined && <span className="text-muted-foreground tabular-nums"> ({formatCount(row.members.length)})</span>}
                  </span>
                  <span className="w-12 text-right tabular-nums">{row.annotations === 0 ? "" : formatCount(row.annotations)}</span>
                  <span className="w-8 text-right text-xs text-muted-foreground tabular-nums">{share(row.annotations, totalAnnotations)}</span>
                </button>
                {/* Reserved on every row, so the numbers line up thin or not; the detail is on hover. */}
                <span className="flex w-6 shrink-0 justify-center">
                  {row.members !== undefined ? (
                    <Hint
                      content={
                        <span className="flex flex-col gap-0.5 tabular-nums">
                          {row.members.map((member) => (
                            <span key={member.name} className="flex justify-between gap-4">
                              <span>{member.name}</span>
                              <span>{member.annotations === 0 ? "—" : formatCount(member.annotations)}</span>
                            </span>
                          ))}
                        </span>
                      }
                    >
                      <button
                        type="button"
                        aria-label={row.members.length === 1 ? "The 1 other class" : `The ${formatCount(row.members.length)} other classes`}
                        data-testid="overview-class-others"
                        className={cn(
                          "relative size-1.5 rounded-full outline-none after:absolute after:-inset-2 focus-visible:ring-2 focus-visible:ring-ring/50",
                          row.thin ? "bg-warning" : "bg-muted-foreground/50",
                        )}
                      />
                    </Hint>
                  ) : row.thin ? (
                    <Hint content={thinNote(row, totalAnnotations)}>
                      <button
                        type="button"
                        aria-label={`Thin: ${thinNote(row, totalAnnotations)}`}
                        className="relative size-1.5 rounded-full bg-warning outline-none after:absolute after:-inset-2 focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                    </Hint>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
