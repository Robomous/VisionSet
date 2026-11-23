/**
 * Paging a table that is already filtered and sorted.
 *
 * `usePagination` is client-side and holds nothing but a page and a page size:
 * the rows go in as the screen has them — filtered, sorted, in the order the
 * table shows — and the page's slice comes out. It never changes a query. The
 * pager components (`TablePager.tsx`) draw it; this file is the arithmetic and
 * the three rules a pager must keep:
 *
 * - **A narrower view starts at the first page.** `resetKey` is the state the
 *   rows were narrowed or ordered by — filter, lens, sort — and a new value
 *   sends the table back to page 1, so a filter never leaves somebody on page 7
 *   of a result with two pages.
 * - **A page that is gone is clamped.** Rows that shrink under the reader (a
 *   delete, a refetch) leave the last page that still exists, never an empty
 *   one.
 * - **A new page size keeps the first visible row in view**, not the page
 *   number: the page that holds what was at the top of the table.
 *
 * `reveal` is for a row that was named from outside the table — a URL, another
 * panel: when its `token` changes to a new value and its `index` is in the
 * rows, the page holding it is the one shown. A row opened from inside the
 * table is already on screen, so the same rule is a no-op there.
 */

import { useState } from "react";

/** The page sizes a footer offers. */
export const PAGE_SIZES: readonly number[] = [10, 25, 50, 100];

export interface PaginationOptions {
  /** Rows per page to start with. */
  readonly pageSize: number;
  /** What the rows were narrowed or ordered by; a change goes back to page 1. */
  readonly resetKey?: string;
  /**
   * A row to bring into view. A new `token` asks again — pass one that is new
   * for each ask — and `index` is the row's place in the rows, `-1` while it is
   * not there (yet).
   */
  readonly reveal?: { readonly token: string; readonly index: number } | null;
}

export interface Pagination<T> {
  /** The current page, from 1. */
  readonly page: number;
  /** How many pages the rows make: at least 1, even with no rows. */
  readonly pages: number;
  readonly pageSize: number;
  /** How many rows are being paged. */
  readonly total: number;
  /** This page's rows. */
  readonly slice: readonly T[];
  /** The first and last row on this page, from 1, for "26–50 of 312". `0` when there are none. */
  readonly from: number;
  readonly to: number;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  /** Goes to a page, clamped to the pages there are. */
  readonly setPage: (page: number) => void;
  /** Changes the size and keeps the page holding the first visible row. */
  readonly setPageSize: (size: number) => void;
}

interface State {
  readonly page: number;
  readonly size: number;
  readonly resetKey: string;
  readonly revealed: string | null;
}

export function usePagination<T>(rows: readonly T[], { pageSize, resetKey = "", reveal = null }: PaginationOptions): Pagination<T> {
  const [state, setState] = useState<State>({ page: 0, size: pageSize, resetKey, revealed: null });

  // Derived from the previous render, in the render itself: React redraws at
  // once and nothing paints the stale page. An effect would show it for a frame.
  let next = state;
  if (next.resetKey !== resetKey) next = { ...next, page: 0, resetKey };
  if (reveal === null) {
    if (next.revealed !== null) next = { ...next, revealed: null };
  } else if (reveal.token !== next.revealed && reveal.index >= 0) {
    next = { ...next, page: Math.floor(reveal.index / next.size), revealed: reveal.token };
  }
  if (next !== state) setState(next);

  const size = next.size;
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const index = Math.min(next.page, pages - 1);
  const start = index * size;

  return {
    page: index + 1,
    pages,
    pageSize: size,
    total,
    slice: rows.slice(start, start + size),
    from: total === 0 ? 0 : start + 1,
    to: Math.min(total, start + size),
    isFirst: index === 0,
    isLast: index >= pages - 1,
    setPage: (page) => setState({ ...next, page: Math.max(1, Math.min(pages, page)) - 1 }),
    setPageSize: (nextSize) => setState({ ...next, size: nextSize, page: Math.floor(start / nextSize) }),
  };
}

/**
 * Brings the top of a table back into view after its page changed: its own
 * scroller to the top, and — where the document is what scrolls — the table's
 * top under the pinned chrome, if it had scrolled out above it. Instant: paging
 * is a frequent move, and a smooth scroll would make every page feel slow. A
 * table that is already in view does not move the page.
 */
export function revealTableTop(frame: HTMLElement | null): void {
  if (frame === null) return;
  frame.scrollTop = 0;
  if (frame.getBoundingClientRect().top < 0) frame.scrollIntoView({ block: "start", behavior: "instant" });
}
