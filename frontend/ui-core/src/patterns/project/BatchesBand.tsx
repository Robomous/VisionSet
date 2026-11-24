/**
 * The batch table's band: the page header's voice, its count beside the title
 * and its tools — the lens and the filter — at the right.
 */

import { FolderOpen, Search } from "lucide-react";
import type { JSX, ReactNode, RefObject } from "react";

import { Kbd } from "@robomous/ui-core";
import { formatCount } from "../../lib/format";
import { LENSES, type Lens } from "./batchRowModel";
import { ViewSwitch } from "./ViewSwitch";

export function BatchesBand({
  rows,
  shown,
  lens,
  setLens,
  query,
  setQuery,
  tools,
  filterRef,
}: {
  /** Every batch the project has. */
  readonly rows: number;
  /** The ones the lens and filter leave. */
  readonly shown: number;
  readonly lens: Lens;
  readonly setLens: (lens: Lens) => void;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly tools?: ReactNode;
  readonly filterRef: RefObject<HTMLInputElement | null>;
}): JSX.Element {
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-border/70 px-4 py-2 md:px-6">
      <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <h2 className="text-sm font-semibold tracking-tight">Batches</h2>
      <span className="text-xs text-muted-foreground tabular-nums" data-testid="batches-count">
        {shown === rows ? formatCount(rows) : `${formatCount(shown)} of ${formatCount(rows)}`}
      </span>
      {rows > 0 && (
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {tools}
          <ViewSwitch label="Show" value={lens} options={LENSES} onChange={setLens} data-testid="batches-lens" />
          <BatchFilter query={query} onQuery={setQuery} inputRef={filterRef} />
        </div>
      )}
    </header>
  );
}

function BatchFilter({
  query,
  onQuery,
  inputRef,
}: {
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}): JSX.Element {
  return (
    <label className="relative flex items-center">
      <span className="sr-only">Filter batches by name</span>
      <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
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
  );
}
