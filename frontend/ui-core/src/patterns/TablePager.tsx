/**
 * How a table is paged: two forms of one pager, and the step button they share.
 *
 * - **`TableFooter`** for a table that is the whole page or section — Projects,
 *   Models, the Classes section. A bar under the table, which the table's area
 *   scrolls above and never takes with it: the count at its start ("26–50 of 312
 *   projects", and under a filter "· filtered from 400"), and at its end rows
 *   per page, "Page 2 of 13" and four steps, « ‹ › ».
 * - **`InlinePager`** for a table inside a page — the Overview's Batches. It
 *   lives in the table's own header band, after its filter: "Page 2 of 9" and
 *   ‹ ›. A table of one page has nothing to page, so it draws nothing.
 *
 * `DESIGN.md`, *Paging a table*, is the recipe. The arithmetic is
 * `pagination.ts`; this file only draws it, and brings the table's top back into
 * view when the page changes. The steps are ordinary buttons: no shortcut is
 * bound to them, so nothing here competes with the rows' own arrow keys.
 */

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import type { JSX, ReactNode, RefObject } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@robomous/ui-core";
import { formatCount } from "../lib/format";
import { PAGE_SIZES, revealTableTop, type Pagination } from "./pagination";

interface PagerProps {
  readonly pagination: Pagination<unknown>;
  /** The table's frame, so a page change can bring its top back into view. */
  readonly frameRef?: RefObject<HTMLElement | null>;
}

/**
 * A bordered square step, pressed like a button: it answers at once, and a
 * step that cannot go anywhere is faded, shadowless and does not press. Its
 * tooltip names it; a spent step has none, since it cannot be used, but it
 * keeps focus (`aria-disabled`) so a keyboard user is never dropped.
 */
function Step({
  label,
  disabled,
  onClick,
  small = false,
  testId,
  children,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly small?: boolean;
  readonly testId: string;
  readonly children: ReactNode;
}): JSX.Element {
  const button = (
    <button
      type="button"
      aria-label={label}
      data-testid={testId}
      // `aria-disabled`, not `disabled`: pressing Next onto the last page must
      // not drop keyboard focus into a control that can no longer hold it.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cn(
        "flex items-center justify-center rounded-md border bg-background text-foreground shadow-xs transition-[background-color,scale] duration-100 ease-out outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] aria-disabled:cursor-default aria-disabled:text-muted-foreground/40 aria-disabled:shadow-none aria-disabled:hover:bg-background aria-disabled:active:scale-100 motion-reduce:transition-none [-webkit-tap-highlight-color:transparent] [&_svg]:size-3.5",
        small ? "size-6" : "size-7",
      )}
    >
      {children}
    </button>
  );
  // One tree whether or not the step is spent: swapping the wrapper would
  // remount the button and drop its focus. A spent step just never opens one.
  return (
    <Tooltip {...(disabled ? { open: false } : {})}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** "Page 2 of 13": the page in the stronger ink, the count in the quiet one. */
function PageOf({ pagination }: { readonly pagination: Pagination<unknown> }): JSX.Element {
  return (
    <span className="whitespace-nowrap tabular-nums" data-testid="table-pager-page">
      Page <span className="font-medium text-foreground">{formatCount(pagination.page)}</span> of {formatCount(pagination.pages)}
    </span>
  );
}

/** A step that goes to a page and brings the table's top back into view. */
function goTo({ pagination, frameRef }: PagerProps): (page: number) => void {
  return (page) => {
    pagination.setPage(page);
    revealTableTop(frameRef?.current ?? null);
  };
}

/** The footer's start: which rows, of how many — and, under a filter, of how many in all. */
function Count({
  pagination,
  noun,
  plural,
  unfiltered,
}: {
  readonly pagination: Pagination<unknown>;
  readonly noun: string;
  readonly plural: string;
  readonly unfiltered: number | undefined;
}): JSX.Element {
  const { total, from, to } = pagination;
  if (total === 0) return <span data-testid="table-pager-range">No {plural} match</span>;
  if (total === 1) {
    return (
      <span className="tabular-nums" data-testid="table-pager-range">
        <span className="font-medium text-foreground">1</span> {noun}
        {unfiltered !== undefined && unfiltered !== total && <> · filtered from {formatCount(unfiltered)}</>}
      </span>
    );
  }
  return (
    <span className="tabular-nums" data-testid="table-pager-range">
      <span className="font-medium text-foreground">{from === to ? formatCount(from) : `${formatCount(from)}–${formatCount(to)}`}</span> of{" "}
      {formatCount(total)} {total === 1 ? noun : plural}
      {unfiltered !== undefined && unfiltered !== total && <> · filtered from {formatCount(unfiltered)}</>}
    </span>
  );
}

function RowsPerPage({ pagination, frameRef, sizes }: PagerProps & { readonly sizes: readonly number[] }): JSX.Element {
  // A size the screen started on is always one of the choices.
  const choices = sizes.includes(pagination.pageSize) ? sizes : [...sizes, pagination.pageSize].sort((a, b) => a - b);
  return (
    <label className="flex items-center gap-2">
      Rows per page
      <Select
        value={String(pagination.pageSize)}
        onValueChange={(value) => {
          pagination.setPageSize(Number(value));
          revealTableTop(frameRef?.current ?? null);
        }}
      >
        <SelectTrigger size="sm" className="h-7 w-[4.5rem] gap-1 bg-background text-xs text-foreground tabular-nums" aria-label="Rows per page" data-testid="table-pager-size">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((size) => (
            <SelectItem key={size} value={String(size)} className="text-xs tabular-nums">
              {size}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

/**
 * The bar under a table that is the whole page or section: `h-12`, one step
 * down from the page's surface under a hairline (`muted` at 40%, mixed into the
 * background so it is opaque when rows pass beneath it), on the page's inset. Pinned
 * above the status bar where the document scrolls, so it is on screen however
 * long the page; in a fitted pane it is the frame's last row and the table
 * above it is what scrolls. Below `sm` it wraps to two lines and drops the
 * page-size choice rather than widen the page.
 */
export function TableFooter({
  pagination,
  frameRef,
  noun,
  plural = `${noun}s`,
  unfiltered,
  sizes = PAGE_SIZES,
}: PagerProps & {
  /** What the rows are, singular: "project". */
  readonly noun: string;
  /** Plural when it is not the noun and an "s". */
  readonly plural?: string;
  /** How many rows there are before a filter narrowed them; said only when it did. */
  readonly unfiltered?: number;
  /** The page sizes offered. */
  readonly sizes?: readonly number[];
}): JSX.Element {
  const go = goTo({ pagination, ...(frameRef === undefined ? {} : { frameRef }) });
  return (
    <nav
      aria-label="Pages"
      data-testid="table-footer"
      className="sticky bottom-(--page-inset-bottom) z-10 flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t max-sm:py-2 sm:h-12 sm:flex-nowrap bg-[color-mix(in_oklab,var(--color-muted)_40%,var(--color-background))] px-4 text-xs text-muted-foreground md:px-6"
    >
      <Count pagination={pagination} noun={noun} plural={plural} unfiltered={unfiltered} />
      <span className="ml-auto flex items-center gap-5">
        {/* Below `sm` the bar is two short lines, and the page size is the one thing it gives up. */}
        <span className="max-sm:hidden">
          <RowsPerPage pagination={pagination} sizes={sizes} {...(frameRef === undefined ? {} : { frameRef })} />
        </span>
        <PageOf pagination={pagination} />
        <span className="flex items-center gap-1">
          <Step label="First page" testId="table-pager-first" disabled={pagination.isFirst} onClick={() => go(1)}>
            <ChevronsLeft aria-hidden="true" />
          </Step>
          <Step label="Previous page" testId="table-pager-prev" disabled={pagination.isFirst} onClick={() => go(pagination.page - 1)}>
            <ChevronLeft aria-hidden="true" />
          </Step>
          <Step label="Next page" testId="table-pager-next" disabled={pagination.isLast} onClick={() => go(pagination.page + 1)}>
            <ChevronRight aria-hidden="true" />
          </Step>
          <Step label="Last page" testId="table-pager-last" disabled={pagination.isLast} onClick={() => go(pagination.pages)}>
            <ChevronsRight aria-hidden="true" />
          </Step>
        </span>
      </span>
    </nav>
  );
}

/**
 * The pager of a table inside a page, for its own header band: "Page 2 of 9"
 * and two small steps. Nothing at all while the rows fit on one page.
 */
export function InlinePager({ pagination, frameRef }: PagerProps): JSX.Element | null {
  const go = goTo({ pagination, ...(frameRef === undefined ? {} : { frameRef }) });
  if (pagination.pages <= 1) return null;
  return (
    <nav aria-label="Pages" data-testid="inline-pager" className="flex items-center gap-2.5 pl-1 text-xs text-muted-foreground">
      <PageOf pagination={pagination} />
      <span className="flex items-center gap-1">
        <Step small label="Previous page" testId="table-pager-prev" disabled={pagination.isFirst} onClick={() => go(pagination.page - 1)}>
          <ChevronLeft aria-hidden="true" />
        </Step>
        <Step small label="Next page" testId="table-pager-next" disabled={pagination.isLast} onClick={() => go(pagination.page + 1)}>
          <ChevronRight aria-hidden="true" />
        </Step>
      </span>
    </nav>
  );
}
