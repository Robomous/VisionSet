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
 * the page. Nothing here animates: moving through rows is the most frequent
 * thing on the page, and it answers instantly.
 *
 * ## Paged, with the footer always there
 *
 * The table pages client-side over the rows the lens and filter leave, ten at a
 * time to start, from the footer every full table carries (`TableFooter`): the
 * count, rows per page and the four steps. It stays with a single page, because
 * it is also the table's count. Walking rows with the keys stays on the page; a
 * batch opened from outside the table — the URL's `?batch=`, the panel's own
 * J/K — brings its page in, and a new lens or filter starts over at the first.
 *
 * ## Actions are the screen's
 *
 * The actions cell is a render prop: the screen labels the actions from the
 * batch's `allowed_actions` (`ui-capabilities`) and this file only places them,
 * in the row's menu. Nothing appears on hover: a row's step is in its panel, or
 * — for a draft — the row itself opens the approval.
 *
 * ## Data-only
 *
 * Rows arrive as view models, so the screen does the reading and this file
 * only draws and moves.
 */

import { CircleCheckBig, CircleDashed, FolderOpen, Users } from "lucide-react";
import { useMemo, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { cn } from "@robomous/ui-core";
import { assetNoun, type Modality } from "../../lib/assetNoun";
import { formatCount } from "../../lib/format";
import type { BatchPhase } from "./BatchSummary";
import { initials, labeledDetail, lensAdmits, phaseState, type Lens } from "./batchRowModel";
import { StateChip } from "../StateChip";
import { BODY_ROW, ColumnHeader, ListGrid, type ListColumn } from "../ListPage";
import { columnLines } from "../listColumns";
import { usePagination, type Pagination } from "../pagination";
import { TableFooter } from "../TablePager";
import { ProgressReadout } from "../ProgressRing";
import { BatchesBand } from "./BatchesBand";
import { nextRowId, useSlashFocus } from "./rowKeys";

/** The wire's split of a batch's or a job's assets by annotation state. */
export interface LabelCounts {
  readonly total: number;
  readonly accepted: number;
  readonly annotated: number;
  readonly review_pending: number;
  readonly skipped: number;
  readonly pre_labeled: number;
  readonly unannotated: number;
}

export interface BatchRowView {
  readonly id: string;
  readonly name: string;
  readonly phase: BatchPhase;
  readonly schemaVersion: number | null;
  /** Images decided; `null` before the batch has jobs. */
  readonly done: number | null;
  readonly total: number;
  /** What the batch holds; absent, images. */
  readonly modality?: Modality;
  /** A model drafting labels, while it runs. */
  readonly prelabel: { readonly processed: number; readonly total: number | null } | null;
  /** How the batch's assets split by annotation state, once it has jobs — what its progress says when pointed at. */
  readonly counts?: LabelCounts | null;
  /**
   * Who holds the batch's jobs, in job order: `null` before it has any,
   * `undefined` while they are being read.
   */
  readonly assignees: readonly (string | null)[] | null | undefined;
  /** Why this batch's jobs could not be read, in the person's words. Only this row says so. */
  readonly jobsError?: string;
}

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
      .filter((row) => lensAdmits(lens, row.phase))
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
  /** The row's actions, in its menu. */
  readonly actions?: (row: BatchRowView) => { readonly menu?: ReactNode };
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

export function BatchTable({ rows, view, openId, onOpen, actions, tools, note, emptyAction, className }: BatchTableProps): JSX.Element {
  const { lens, setLens, query, setQuery, shown, pagination } = view;
  const filter = useRef<HTMLInputElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());


  useSlashFocus(filter);

  function onTableKey(event: KeyboardEvent<HTMLDivElement>): void {
    const next = nextRowId(event, pagination.slice);
    if (next !== null) rowButtons.current.get(next)?.focus();
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
      <BatchesBand
        rows={rows.length}
        shown={shown.length}
        {...{ lens, setLens, query, setQuery, tools }}
        filterRef={filter}
      />

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
      {rows.length > 0 && <TableFooter pagination={pagination} frameRef={frame} noun="batch" plural="batches" unfiltered={rows.length} />}
    </section>
  );
}

/**
 * The columns, declared once. The menu is the only column that holds
 * controls, so at rest nothing is white for nothing.
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
  readonly actions: { readonly menu?: ReactNode } | undefined;
  readonly buttonRef: (el: HTMLButtonElement | null) => void;
}): JSX.Element {
  return (
    <tr
      className={cn(
        BODY_ROW,
        // The fill a hover reveals.
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
            {formatCount(row.total)} {assetNoun(row.modality ?? "image", row.total, "image")}
            {row.schemaVersion !== null && ` · schema v${row.schemaVersion}`}
          </span>
        </button>
      </td>
      <td>
        <PhaseBadge phase={row.phase} {...(row.done === null || row.total === 0 ? {} : { fraction: row.done / row.total })} />
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

/** The phase as a state chip; no card, because the row it sits in already opens the batch. */
export function PhaseBadge({ phase, fraction }: { readonly phase: BatchPhase; readonly fraction?: number }): JSX.Element {
  return <StateChip state={phaseState(phase, fraction === undefined ? {} : { fraction })} testId="batch-phase" />;
}

/** How much is decided: the count, quiet, then its ring — a model's drafting in its own colour. */
function Progress({ row }: { readonly row: BatchRowView }): JSX.Element {
  if (row.prelabel !== null) {
    const total = row.prelabel.total ?? row.total;
    return (
      <ProgressReadout value={row.prelabel.processed} total={total} tone="info" className="text-xs text-info">
        Drafting {formatCount(row.prelabel.processed)}/{formatCount(total)}
      </ProgressReadout>
    );
  }
  if (row.done === null) return <span className="text-xs text-muted-foreground">Not started</span>;
  return (
    <ProgressReadout value={row.done} total={row.total} className="text-xs" detail={labeledDetail(row)}>
      {formatCount(row.done)}/{formatCount(row.total)}
    </ProgressReadout>
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
