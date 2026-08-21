/**
 * The table — the batch list, the release timeline.
 *
 * Real `<table>` semantics rather than a grid of `<div>`s, because a screen reader
 * announces "row 3 of 12, column State" only for the former, and both of the
 * screens this exists for are dense lists somebody scans.
 *
 * `TableEmpty` is here rather than in `patterns/` because an empty *table* is not
 * an empty *screen*: the header stays, so the columns still explain what is
 * missing. `EmptyState` is the whole-surface version.
 */

import { forwardRef, type HTMLAttributes, type JSX, type ReactNode, type TdHTMLAttributes, type ThHTMLAttributes } from "react";

import { cn } from "../lib/cn";

export const Table = forwardRef<HTMLTableElement, HTMLAttributes<HTMLTableElement>>(function Table(
  { className, ...props },
  ref,
) {
  return (
    <div className="w-full overflow-x-auto rounded-xl ring-1 ring-foreground/10">
      <table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
});

export const TableHeader = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  function TableHeader({ className, ...props }, ref) {
    return <thead ref={ref} className={cn("bg-muted", className)} {...props} />;
  },
);

export const TableBody = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  function TableBody({ className, ...props }, ref) {
    return <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
  },
);

export const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  function TableRow({ className, ...props }, ref) {
    return (
      <tr
        ref={ref}
        className={cn("border-b hover:bg-muted/50 data-[state=selected]:bg-muted", className)}
        {...props}
      />
    );
  },
);

export const TableHead = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(
  function TableHead({ className, ...props }, ref) {
    return (
      <th
        ref={ref}
        className={cn("h-10 px-2 text-left align-middle text-xs font-medium text-muted-foreground", className)}
        {...props}
      />
    );
  },
);

export const TableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(
  function TableCell({ className, ...props }, ref) {
    return <td ref={ref} className={cn("p-2 align-middle", className)} {...props} />;
  },
);

/** A row spanning every column, so the header keeps explaining what is absent. */
export function TableEmpty({
  colSpan,
  children,
}: {
  readonly colSpan: number;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <tr>
      <td colSpan={colSpan} className="px-2 py-8 text-center text-sm text-muted-foreground">
        {children}
      </td>
    </tr>
  );
}
