/**
 * The paging arithmetic and the three rules a pager keeps: a narrower view
 * starts at the first page, a page that is gone is clamped, and a new page size
 * keeps the first visible row in view.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { revealTableTop, usePagination, type PaginationOptions } from "./pagination";

const rows = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);

function paged(initial: readonly number[], options: PaginationOptions) {
  return renderHook((props: { rows: readonly number[]; options: PaginationOptions }) => usePagination(props.rows, props.options), {
    initialProps: { rows: initial, options },
  });
}

describe("usePagination", () => {
  it("slices the first page and counts from one", () => {
    const { result } = paged(rows(60), { pageSize: 25 });
    expect(result.current.slice).toEqual(rows(25));
    expect(result.current).toMatchObject({ page: 1, pages: 3, pageSize: 25, total: 60, from: 1, to: 25, isFirst: true, isLast: false });
  });

  it("goes to a page, and the last page holds what is left", () => {
    const { result } = paged(rows(60), { pageSize: 25 });
    act(() => result.current.setPage(2));
    expect(result.current).toMatchObject({ page: 2, from: 26, to: 50 });
    act(() => result.current.setPage(3));
    expect(result.current.slice).toEqual(rows(60).slice(50));
    expect(result.current).toMatchObject({ page: 3, from: 51, to: 60, isFirst: false, isLast: true });
  });

  it("clamps a page outside the pages there are", () => {
    const { result } = paged(rows(60), { pageSize: 25 });
    act(() => result.current.setPage(99));
    expect(result.current.page).toBe(3);
    act(() => result.current.setPage(-4));
    expect(result.current.page).toBe(1);
  });

  it("is one empty page for no rows, counting nothing", () => {
    const { result } = paged([], { pageSize: 25 });
    expect(result.current).toMatchObject({ page: 1, pages: 1, total: 0, from: 0, to: 0, isFirst: true, isLast: true });
    expect(result.current.slice).toEqual([]);
  });

  it("is one page when the rows fit exactly", () => {
    const { result } = paged(rows(25), { pageSize: 25 });
    expect(result.current.pages).toBe(1);
    expect(result.current.isLast).toBe(true);
  });

  it("clamps to the last page that still exists when the rows shrink under the reader", () => {
    const { result, rerender } = paged(rows(60), { pageSize: 25 });
    act(() => result.current.setPage(3));
    rerender({ rows: rows(30), options: { pageSize: 25 } });
    expect(result.current).toMatchObject({ page: 2, pages: 2, from: 26, to: 30 });
    rerender({ rows: rows(5), options: { pageSize: 25 } });
    expect(result.current).toMatchObject({ page: 1, pages: 1, from: 1, to: 5 });
  });

  it("starts over at the first page when the reset key changes, and not before", () => {
    const { result, rerender } = paged(rows(60), { pageSize: 25, resetKey: "a" });
    act(() => result.current.setPage(3));
    rerender({ rows: rows(60), options: { pageSize: 25, resetKey: "a" } });
    expect(result.current.page).toBe(3);
    rerender({ rows: rows(60), options: { pageSize: 25, resetKey: "b" } });
    expect(result.current.page).toBe(1);
    // And pages again from there.
    act(() => result.current.setPage(2));
    expect(result.current.page).toBe(2);
  });

  it("keeps the page holding the first visible row when the size changes", () => {
    const { result } = paged(rows(312), { pageSize: 25 });
    act(() => result.current.setPage(3));
    // The first row on screen is the 51st.
    expect(result.current.from).toBe(51);
    act(() => result.current.setPageSize(10));
    expect(result.current).toMatchObject({ page: 6, pages: 32, pageSize: 10, from: 51, to: 60 });
    act(() => result.current.setPageSize(100));
    expect(result.current).toMatchObject({ page: 1, pages: 4, from: 1, to: 100 });
  });

  it("keeps the page size across a reset", () => {
    const { result, rerender } = paged(rows(312), { pageSize: 25, resetKey: "a" });
    act(() => result.current.setPageSize(50));
    act(() => result.current.setPage(4));
    rerender({ rows: rows(312), options: { pageSize: 25, resetKey: "b" } });
    expect(result.current).toMatchObject({ page: 1, pageSize: 50 });
  });

  describe("reveal", () => {
    it("shows the page of a row named from outside, once per ask", () => {
      const { result, rerender } = paged(rows(60), { pageSize: 10, reveal: null });
      rerender({ rows: rows(60), options: { pageSize: 10, reveal: { token: "x", index: 34 } } });
      expect(result.current.page).toBe(4);
      // Paging away does not bring it back while the same ask stands.
      act(() => result.current.setPage(1));
      rerender({ rows: rows(60), options: { pageSize: 10, reveal: { token: "x", index: 34 } } });
      expect(result.current.page).toBe(1);
      // A new ask does.
      rerender({ rows: rows(60), options: { pageSize: 10, reveal: { token: "y", index: 52 } } });
      expect(result.current.page).toBe(6);
    });

    it("asks again after it was withdrawn", () => {
      const { result, rerender } = paged(rows(60), { pageSize: 10, reveal: { token: "x", index: 34 } });
      expect(result.current.page).toBe(4);
      act(() => result.current.setPage(1));
      rerender({ rows: rows(60), options: { pageSize: 10, reveal: null } });
      rerender({ rows: rows(60), options: { pageSize: 10, reveal: { token: "x", index: 34 } } });
      expect(result.current.page).toBe(4);
    });

    it("waits for a row that is not in the rows yet", () => {
      const { result, rerender } = paged([], { pageSize: 10, reveal: { token: "x", index: -1 } });
      expect(result.current.page).toBe(1);
      rerender({ rows: rows(60), options: { pageSize: 10, reveal: { token: "x", index: 34 } } });
      expect(result.current.page).toBe(4);
    });

    it("wins over a reset that arrives with it", () => {
      const { result, rerender } = paged(rows(60), { pageSize: 10, resetKey: "a" });
      rerender({ rows: rows(60), options: { pageSize: 10, resetKey: "b", reveal: { token: "x", index: 34 } } });
      expect(result.current.page).toBe(4);
    });
  });
});

describe("revealTableTop", () => {
  it("does nothing without a frame", () => {
    expect(() => revealTableTop(null)).not.toThrow();
  });

  it("puts the frame's own scroller back at the top, instantly", () => {
    const frame = document.createElement("div");
    frame.scrollTop = 120;
    const scrollIntoView = vi.spyOn(frame, "scrollIntoView");
    revealTableTop(frame);
    expect(frame.scrollTop).toBe(0);
    // In view (a zero rect is not above the viewport): the page does not move.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("brings a frame that scrolled out above the viewport back, with no smooth scroll", () => {
    const frame = document.createElement("div");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ top: -300 } as DOMRect);
    const scrollIntoView = vi.spyOn(frame, "scrollIntoView").mockImplementation(() => undefined);
    revealTableTop(frame);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
  });
});
