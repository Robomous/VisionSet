/**
 * A workspace list as a full-bleed table: the shape the Projects and Models
 * pages share.
 *
 * ## Three bands, then the grid
 *
 * The page is composed the way a data tool's list is, top to bottom:
 *
 * 1. **The header** — the page's icon and name, and its one filled action at
 *    the right. A 48px band, not a hero title: the list is what somebody came
 *    for, and a big heading pushes it down.
 * 2. **The toolbar** — how the list is being looked at: search, filters, the
 *    order it is in. A second band under a hairline, so changing the view never
 *    reads as changing the data.
 * 3. **The grid** — the table from edge to edge of the pane, with no card around
 *    it and no gutter outside it. Columns are separated by hairlines as well as
 *    rows, so a column reads down as one thing; every header names its column
 *    with an icon and a word.
 *
 * Nothing is said twice. What the list holds — how many, of how many while a
 * search or filter narrows it, and what they add up to — is said in the
 * workbench's status bar (`PageStatus`), and nowhere on the page: no count
 * beside the heading, no totals row at the foot, no second "New …" row under
 * the last one competing with the header's action.
 *
 * ## One edge, from the header down
 *
 * The header's text, the toolbar's first control and the first column's content
 * all start on the same x — the pane's inset, `px-4`, `md:px-6`, which is also
 * the status bar's — so the eye runs down one edge.
 *
 * ## Columns are declared once
 *
 * The table is laid out `table-fixed` from one list of widths. The first column
 * takes what the others leave, so a long name truncates inside it rather than
 * widening the grid; below `minWidth` the grid scrolls sideways inside its own
 * frame, never the document. A cell whose content changes while somebody
 * watches — a run's bar replacing a button — keeps its column's width, so
 * nothing beside it moves.
 */

import { ArrowDown, ArrowUp, type LucideIcon } from "lucide-react";
import type { CSSProperties, JSX, ReactNode } from "react";

import { cn } from "@robomous/ui-core";

/** One column: what its `<col>` is set to. The first should be left to take the rest. */
export interface ListColumn {
  readonly key: string;
  /** A width class for the `<col>`, e.g. `w-28`; omit for the column that takes the rest. */
  readonly width?: string;
}

/** The pane's inset — the one left edge everything in the page starts on. */
export const PAGE_INSET = "px-4 md:px-6";

export function ListPage({
  icon: Icon,
  title,
  action,
  toolbar,
  children,
  testId,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  /** The page's one filled action. */
  readonly action?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
}): JSX.Element {
  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col" data-testid={testId}>
      <header className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b", PAGE_INSET)}>
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
        {action !== undefined && <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>}
      </header>
      {toolbar !== undefined && (
        <div className={cn("flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b py-2", PAGE_INSET)}>{toolbar}</div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/**
 * The grid's frame: the table on its declared columns, scrolling sideways
 * inside the frame below `minWidth`.
 */
export function ListGrid({
  columns,
  minWidth,
  label,
  head,
  children,
  testId,
}: {
  readonly columns: readonly ListColumn[];
  /** Below this the grid scrolls inside its frame, e.g. `min-w-[1100px]`. */
  readonly minWidth: string;
  readonly label: string;
  readonly head: ReactNode;
  /** One or more `<tbody>`s. */
  readonly children: ReactNode;
  readonly testId?: string;
}): JSX.Element {
  return (
    // `relative`: the header's visually hidden labels are absolutely positioned
    // and must be contained by this frame, not by the page.
    <div className="relative flex min-h-0 flex-1 flex-col overflow-x-auto">
      <div className={minWidth}>
        <table aria-label={label} className={cn(GRID, "text-sm")} data-testid={testId}>
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} className={column.width} />
            ))}
          </colgroup>
          <thead>
            <tr>{head}</tr>
          </thead>
          {children}
        </table>
      </div>
    </div>
  );
}

/**
 * The grid's lines and insets.
 *
 * Hairlines between columns as well as rows; cells inset 12px, the outermost
 * ones by the pane's inset so the first column starts where the header's text
 * does. Header cells are 36px on a faint fill, body cells 44px.
 */
const GRID = cn(
  "w-full table-fixed border-collapse",
  "[&_th]:h-9 [&_th]:border-b [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:text-left [&_th]:text-xs [&_th]:font-normal [&_th]:text-muted-foreground",
  "[&_td]:px-3",
  // Column hairlines: between cells, never at the frame's edges.
  "[&_th+th]:border-l [&_td+td]:border-l [&_th]:border-border/70 [&_td]:border-border/70",
  "[&_th:first-child]:pl-4 [&_td:first-child]:pl-4 md:[&_th:first-child]:pl-6 md:[&_td:first-child]:pl-6",
  "[&_th:last-child]:pr-4 [&_td:last-child]:pr-4 md:[&_th:last-child]:pr-6 md:[&_td:last-child]:pr-6",
);

/** A body row's cell classes: 44px, a hairline under it. Spread on a `<tr>`. */
export const BODY_ROW = "[&>td]:h-11 [&>td]:border-b";

/** Tailwind's spacing step, for turning a column's `w-N` into pixels. */
const STEP_PX = 4;

/**
 * The column hairlines, carried on below a grid's last row.
 *
 * A grid that fills a cell taller than its rows would otherwise stop as a
 * table and go on as a blank page; painting each hairline down the whole cell
 * keeps a short list reading as table to the cell's foot. Spread as the
 * `style` of the element the grid fills, with `bg-no-repeat` on it.
 *
 * Only the fixed columns at the right are drawn: each one's left edge sits a
 * constant distance from the right edge whatever the width, so one 1px
 * gradient per line, on the cell border's own colour, is the whole of it. The
 * widths are read off the same `w-N` the grid's `<col>`s are declared with, so
 * the two cannot disagree.
 */
export function columnLines(columns: readonly ListColumn[]): CSSProperties {
  const offsets: number[] = [];
  let fromRight = 0;
  for (const column of [...columns].reverse()) {
    const step = /^w-(\d+)$/.exec(column.width ?? "")?.[1];
    if (step === undefined) break;
    fromRight += Number(step) * STEP_PX;
    offsets.push(fromRight - 1);
  }
  const line = "linear-gradient(color-mix(in oklab, var(--color-border) 70%, transparent), color-mix(in oklab, var(--color-border) 70%, transparent))";
  return {
    backgroundImage: offsets.map(() => line).join(", "),
    backgroundSize: offsets.map(() => "1px 100%").join(", "),
    backgroundPosition: offsets.map((px) => `right ${px}px top`).join(", "),
  };
}

/**
 * A column's header: its icon and its name, in the muted ink a header reads in.
 * With `onSort`, the name is a button that sorts by the column and the cell
 * carries `aria-sort`; the arrow's room is kept on every column, so sorting
 * never shifts a header.
 */
export function ColumnHeader({
  icon: Icon,
  label,
  align = "left",
  sort,
  onSort,
  testId,
  hidden = false,
}: {
  readonly icon?: LucideIcon;
  readonly label: string;
  readonly align?: "left" | "right";
  /** This column's sort state, when the grid sorts by it. */
  readonly sort?: "ascending" | "descending" | "none";
  readonly onSort?: () => void;
  readonly testId?: string;
  /** Named for a screen reader only — the actions column. */
  readonly hidden?: boolean;
}): JSX.Element {
  if (hidden) {
    return (
      <th scope="col">
        <span className="sr-only">{label}</span>
      </th>
    );
  }
  const content = (
    <>
      {Icon !== undefined && <Icon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />}
      <span className="truncate">{label}</span>
    </>
  );
  const active = sort === "ascending" || sort === "descending";
  const Arrow = sort === "ascending" ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={onSort === undefined ? undefined : (sort ?? "none")} className={align === "right" ? "text-right" : undefined}>
      {onSort === undefined ? (
        <span className={cn("flex min-w-0 items-center gap-1.5", align === "right" && "justify-end")}>{content}</span>
      ) : (
        <button
          type="button"
          data-testid={testId}
          onClick={onSort}
          className={cn(
            // The cell's height is the hit area; hover answers at once.
            "-my-1 flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
            active && "font-medium text-foreground",
            align === "right" && "ml-auto",
          )}
        >
          {/* The arrow leads a right-aligned label, so the label's own edge
              stays on the numbers' edge below it. */}
          {align === "right" && <Arrow aria-hidden="true" className={cn("size-3 shrink-0", !active && "invisible")} />}
          {content}
          {align === "left" && <Arrow aria-hidden="true" className={cn("size-3 shrink-0", !active && "invisible")} />}
        </button>
      )}
    </th>
  );
}
