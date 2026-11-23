/**
 * Every batch at once: where it stands, how far its labelling has come, who
 * holds its jobs, and what can be done with it. A row opens the batch's
 * detail; its actions sit at the row's end.
 *
 * ## The keyboard model
 *
 * Each row's name is a real button, so `Tab` reaches the table and a screen
 * reader announces a row as an action. `J`/`K` or `↓`/`↑` move between rows,
 * `Enter` opens the focused one, and `/` focuses the filter from anywhere on
 * the page. Nothing here animates but the row actions' fade: moving through
 * rows is the most frequent thing on the page, and it answers instantly.
 *
 * ## Ten to a page
 *
 * The table pages client-side over the rows the lens and filter leave, ten at a
 * time, from the band's own pager (`InlinePager`, after the filter; absent
 * while everything fits on one page). Walking rows with the keys stays on the
 * page; a batch opened from outside the table — the URL's `?batch=`, the
 * panel's own J/K — brings its page in, and a new lens or filter starts over at
 * the first.
 *
 * ## Actions are the screen's
 *
 * The actions cell is a render prop: the screen labels the actions from the
 * batch's `allowed_actions` (`ui-capabilities`) and this file only places
 * them — the forward one shown while the row is pointed at or focused, its
 * space held so the row never reflows, and everything in the row's menu.
 *
 * ## Data-only
 *
 * Rows arrive as view models, so the screen does the reading and this file
 * only draws and moves.
 */

import { CircleCheckBig, CircleDashed, FolderOpen, Search, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { Badge, Kbd, cn } from "@robomous/ui-core";
import { formatCount } from "../../lib/format";
import type { BatchPhase } from "./BatchSummary";
import { PHASE_DOT, PHASE_LABEL, initials } from "./batchRowModel";
import { BODY_ROW, ColumnHeader, ListGrid, type ListColumn } from "../ListPage";
import { columnLines } from "../listColumns";
import { usePagination, type Pagination } from "../pagination";
import { InlinePager } from "../TablePager";
import { Meter } from "./ConsolePanel";
import { ViewSwitch } from "./ViewSwitch";

export interface BatchRowView {
  readonly id: string;
  readonly name: string;
  readonly phase: BatchPhase;
  readonly schemaVersion: number | null;
  /** Images decided; `null` before the batch has jobs. */
  readonly done: number | null;
  readonly total: number;
  /** A model drafting labels, while it runs. */
  readonly prelabel: { readonly processed: number; readonly total: number | null } | null;
  /**
   * Who holds the batch's jobs, in job order: `null` before it has any,
   * `undefined` while they are being read.
   */
  readonly assignees: readonly (string | null)[] | null | undefined;
  /** Why this batch's jobs could not be read, in the person's words. Only this row says so. */
  readonly jobsError?: string;
}

type Lens = "all" | "open" | "in_dataset";

const LENSES = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "in_dataset", label: "In dataset" },
] as const;

export interface BatchTableView {
  readonly lens: Lens;
  readonly setLens: (lens: Lens) => void;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  /** Every row the lens and filter leave, in the order the table shows them. */
  readonly shown: readonly BatchRowView[];
  /** The page of them on screen. */
  readonly pagination: Pagination<BatchRowView>;
}

/**
 * The table's lens and filter, held where the rows are, so the caller reads
 * the rows on screen — for its detail's own J/K stepping — in the same render,
 * rather than being told them by an effect after it.
 */
export function useBatchTableView(rows: readonly BatchRowView[], openId: string | null = null): BatchTableView {
  const [lens, setLens] = useState<Lens>("all");
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((row) => (lens === "all" ? true : lens === "open" ? row.phase !== "in_dataset" : row.phase === "in_dataset"))
      .filter((row) => q === "" || row.name.toLowerCase().includes(q));
  }, [rows, lens, query]);
  // Ten to a page. The open batch's page is the one shown when it was named
  // from outside the table; from inside it is already on screen.
  const pagination = usePagination(shown, {
    pageSize: PAGE_SIZE,
    resetKey: `${lens}|${query.trim()}`,
    reveal: openId === null ? null : { token: openId, index: shown.findIndex((row) => row.id === openId) },
  });
  return { lens, setLens, query, setQuery, shown, pagination };
}

const PAGE_SIZE = 10;

export interface BatchTableProps {
  readonly rows: readonly BatchRowView[];
  /** From `useBatchTableView(rows)`. */
  readonly view: BatchTableView;
  /** The row whose detail is open — marked, so the table says which one is shown. */
  readonly openId: string | null;
  readonly onOpen: (batchId: string) => void;
  /** The row's actions: the forward step (`hover`) and the menu (`menu`). */
  readonly actions?: (row: BatchRowView) => { readonly hover?: ReactNode; readonly menu?: ReactNode };
  /** Actions on the batches as a set, first in the panel's tool row. */
  readonly tools?: ReactNode;
  /**
   * A line between the band and the table — an offer about the batches as a
   * set. It owns its own height and motion, and its own absence; the table
   * follows it.
   */
  readonly note?: ReactNode;
  /** The empty table's one next step. */
  readonly emptyAction?: ReactNode;
  readonly className?: string;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el !== null && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}

export function BatchTable({ rows, view, openId, onOpen, actions, tools, note, emptyAction, className }: BatchTableProps): JSX.Element {
  const { lens, setLens, query, setQuery, shown, pagination } = view;
  const filter = useRef<HTMLInputElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());


  // `/` from anywhere on the page, the way search works in most tools — but
  // never while somebody is typing, holding a modifier, or inside a dialog.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent): void {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector("[role=dialog],[role=menu]") !== null) return;
      event.preventDefault();
      filter.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function onTableKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const down = event.key === "j" || event.key === "ArrowDown";
    const up = event.key === "k" || event.key === "ArrowUp";
    if (!down && !up) return;
    // Only from a row's own button: inside a menu or the actions the arrows are theirs.
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.dataset.rowOpen === undefined) return;
    event.preventDefault();
    // Within the page: the next page is the pager's to go to.
    const onPage = pagination.slice;
    const at = onPage.findIndex((row) => row.id === target.dataset.rowOpen);
    const next = onPage[Math.min(onPage.length - 1, Math.max(0, at + (down ? 1 : -1)))];
    if (next !== undefined) rowButtons.current.get(next.id)?.focus();
  }

  // A click anywhere else on a row opens it too — a pointer convenience. The
  // keyboard's way in is the row's name button, so this is delegated to the
  // table's frame rather than put on each (non-focusable) row; the actions stop
  // their own clicks before they get here.
  function onTableClick(event: MouseEvent<HTMLDivElement>): void {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>("tr[data-row-id]") : null;
    if (row?.dataset.rowId !== undefined) onOpen(row.dataset.rowId);
  }

  return (
    <section aria-label="Batches" data-testid="overview-batches" className={cn("flex min-h-0 min-w-0 flex-col bg-background", className)}>
      {/* The section's band: the page header's voice, its tools at the right. */}
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-border/70 px-4 py-2 md:px-6">
        <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <h2 className="text-sm font-semibold tracking-tight">Batches</h2>
        <span className="text-xs text-muted-foreground tabular-nums" data-testid="batches-count">
          {shown.length === rows.length ? formatCount(rows.length) : `${formatCount(shown.length)} of ${formatCount(rows.length)}`}
        </span>
        {rows.length > 0 && (
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {tools}
            <ViewSwitch label="Show" value={lens} options={LENSES} onChange={setLens} data-testid="batches-lens" />
            <label className="relative flex items-center">
              <span className="sr-only">Filter batches by name</span>
              <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden="true" />
              <input
                ref={filter}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") event.currentTarget.blur();
                }}
                placeholder="Filter"
                aria-keyshortcuts="/"
                data-testid="batches-filter"
                className="h-7 w-40 rounded-md border bg-background pr-7 pl-7 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              />
              <Kbd className="pointer-events-none absolute right-1.5" aria-hidden="true">
                /
              </Kbd>
            </label>
            <InlinePager pagination={pagination} frameRef={frame} />
          </div>
        )}
      </header>

      {note}

      {rows.length === 0 ? (
        <Empty data-testid="batches-none">
          No batches yet. Adding images creates the first one, as a draft you look over before anyone labels it.
          {emptyAction}
        </Empty>
      ) : shown.length === 0 ? (
        <Empty>{query.trim() === "" ? "No batch in this view." : `No batch matches “${query.trim()}”.`}</Empty>
      ) : (
        // Fills the section and scrolls inside it; the header row stays on top
        // on the page's own surface, so rows never show through it. Below the
        // last row the column hairlines run on to the cell's foot, so a short
        // list leaves table, not a blank page.
        <div
          className="flex min-h-0 flex-1 flex-col bg-no-repeat [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-background"
          style={columnLines(actions === undefined ? COLUMNS.filter((column) => column.key !== "menu") : COLUMNS)}
          // A wrapper that only catches the rows' bubbled keys and clicks: the
          // interactive things are the rows' own buttons, so it carries no
          // semantics of its own.
          role="presentation"
          onKeyDown={onTableKey}
          onClick={onTableClick}
        >
          <ListGrid
            columns={actions === undefined ? COLUMNS.filter((column) => column.key !== "menu") : COLUMNS}
            minWidth="min-w-[42rem]"
            label="Batches"
            frameRef={frame}
            head={
              <>
                <ColumnHeader icon={FolderOpen} label="Name" />
                <ColumnHeader icon={CircleDashed} label="State" />
                <ColumnHeader icon={CircleCheckBig} label="Labeled" />
                <ColumnHeader icon={Users} label="Jobs" />
                {actions !== undefined && <ColumnHeader label="Actions" hidden />}
              </>
            }
          >
            <tbody>
              {pagination.slice.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  open={row.id === openId}
                  onOpen={() => onOpen(row.id)}
                  actions={actions?.(row)}
                  buttonRef={(el) => {
                    if (el === null) rowButtons.current.delete(row.id);
                    else rowButtons.current.set(row.id, el);
                  }}
                />
              ))}
            </tbody>
          </ListGrid>
        </div>
      )}
    </section>
  );
}

/**
 * The columns, declared once. No column is kept for what shows only on hover:
 * a row's next step rides at the end of its name cell, and the menu is the
 * only column that holds controls — so at rest nothing is white for nothing.
 */
const COLUMNS: readonly ListColumn[] = [
  { key: "batch" },
  { key: "state", width: "w-32" },
  { key: "labeled", width: "w-52" },
  { key: "jobs", width: "w-32" },
  { key: "menu", width: "w-14" },
];

function Empty({ children, "data-testid": testId }: { readonly children: ReactNode; readonly "data-testid"?: string }): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-6 text-sm text-pretty text-muted-foreground md:px-6" data-testid={testId}>
      {children}
    </div>
  );
}

function Row({
  row,
  open,
  onOpen,
  actions,
  buttonRef,
}: {
  readonly row: BatchRowView;
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly actions: { readonly hover?: ReactNode; readonly menu?: ReactNode } | undefined;
  readonly buttonRef: (el: HTMLButtonElement | null) => void;
}): JSX.Element {
  return (
    <tr
      className={cn(
        BODY_ROW,
        // The fill a hover reveals; the next step's fade is painted in the same colour.
        "group/row cursor-pointer [--row-fill:color-mix(in_oklab,var(--color-muted)_40%,var(--color-background))] hover:bg-(--row-fill) focus-within:bg-(--row-fill)",
        open && "bg-muted/60 [--row-fill:color-mix(in_oklab,var(--color-muted)_60%,var(--color-background))]",
      )}
      data-testid={`overview-batch-${row.name}`}
      data-row-id={row.id}
      data-open={open ? "" : undefined}
    >
      <td className="relative">
        {open && <span className="absolute inset-y-0 left-0 w-0.5 bg-foreground" aria-hidden="true" />}
        <button
          ref={buttonRef}
          type="button"
          data-row-open={row.id}
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-baseline gap-2 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="min-w-0 truncate font-medium">{row.name}</span>
          {/* Gives way before the name does. */}
          <span className="min-w-0 shrink-[100] truncate text-xs text-muted-foreground tabular-nums">
            {formatCount(row.total)} {row.total === 1 ? "image" : "images"}
            {row.schemaVersion !== null && ` · schema v${row.schemaVersion}`}
          </span>
        </button>
        {actions?.hover !== undefined && (
          // Over the end of the name cell, on a fade of the row's own fill.
          // Only the step takes the pointer: the fade is the row's, and opens it.
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center bg-linear-to-l from-(--row-fill) from-65% to-transparent pr-2 pl-10 opacity-0 transition-opacity duration-150 ease-out group-focus-within/row:opacity-100 group-hover/row:opacity-100">
            <span className="pointer-events-auto" onClick={(event) => event.stopPropagation()}>
              {actions.hover}
            </span>
          </span>
        )}
      </td>
      <td>
        <PhaseBadge phase={row.phase} />
      </td>
      <td>
        <Progress row={row} />
      </td>
      <td>
        {row.jobsError === undefined ? (
          <Assignees assignees={row.assignees} />
        ) : (
          <span className="text-xs text-muted-foreground" title={row.jobsError} data-testid={`batch-jobs-error-${row.name}`}>
            Unavailable
            <span className="sr-only">: {row.jobsError}</span>
          </span>
        )}
      </td>
      {actions !== undefined && (
        <td className="text-right" onClick={(event) => event.stopPropagation()}>
          {actions.menu}
        </td>
      )}
    </tr>
  );
}

export function PhaseBadge({ phase }: { readonly phase: BatchPhase }): JSX.Element {
  return (
    <Badge variant={phase === "in_dataset" ? "secondary" : "outline"} className="gap-1.5 font-normal" data-testid="batch-phase">
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", PHASE_DOT[phase])} />
      {PHASE_LABEL[phase]}
    </Badge>
  );
}

/** One plain bar — how much is decided — and the count beside it. */
function Progress({ row }: { readonly row: BatchRowView }): JSX.Element {
  if (row.prelabel !== null) {
    const total = row.prelabel.total ?? row.total;
    return (
      <span className="flex items-center gap-2.5 pr-5 text-xs text-info">
        <Meter value={row.prelabel.processed} total={total} tone="bg-info/70" className="w-auto flex-1" />
        <span className="shrink-0 tabular-nums">
          Drafting {formatCount(row.prelabel.processed)}/{formatCount(total)}
        </span>
      </span>
    );
  }
  if (row.done === null) return <span className="text-xs text-muted-foreground">Not started</span>;
  return (
    <span className="flex items-center gap-2.5 pr-5">
      <Meter value={row.done} total={row.total} tone={row.done === row.total ? "bg-success" : "bg-foreground/70"} className="w-auto flex-1" />
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        <span className="text-foreground">{formatCount(row.done)}</span>/{formatCount(row.total)}
      </span>
    </span>
  );
}

/** Up to three job holders as initials, the rest as a count. */
function Assignees({ assignees }: { readonly assignees: BatchRowView["assignees"] }): JSX.Element {
  if (assignees === undefined) return <span className="block h-6" aria-hidden="true" />;
  if (assignees === null || assignees.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  const named = assignees.map((one) => one ?? "Unassigned");
  const extra = assignees.length - 3;
  return (
    <span className="flex items-center gap-1" title={named.join(", ")}>
      <span className="sr-only">
        {assignees.length} {assignees.length === 1 ? "job" : "jobs"}: {named.join(", ")}
      </span>
      {assignees.slice(0, 3).map((one, i) => (
        <span
          // Job order is stable, and two jobs can share a holder.
          key={i}
          aria-hidden="true"
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-medium",
            one === null ? "border border-dashed text-muted-foreground" : "bg-muted",
          )}
        >
          {one === null ? "?" : initials(one)}
        </span>
      ))}
      {extra > 0 && (
        <span aria-hidden="true" className="text-xs text-muted-foreground tabular-nums">
          +{extra}
        </span>
      )}
    </span>
  );
}
