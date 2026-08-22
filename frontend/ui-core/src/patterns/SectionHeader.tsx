/**
 * A section's page header: its title as the page's `<h1>`, one line of meta
 * under it, and its own actions on the right.
 *
 * Inside a project the navigation column carries the project's identity and the
 * one filled control, so every action here is `secondary` or quieter — the
 * header names the section and offers what only this section can do.
 */

import type { JSX, ReactNode } from "react";

export interface SectionHeaderProps {
  readonly title: string;
  /** `11 images · ingested Aug 7, 2026`, or the one sentence the title cannot carry. */
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  /** The page's `h1` by default; `h2` only where a page already has one — the styleguide. */
  readonly as?: "h1" | "h2";
}

export function SectionHeader({ title, meta, actions, as: Heading = "h1" }: SectionHeaderProps): JSX.Element {
  return (
    <header
      data-testid="section-header"
      className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Heading className="text-2xl font-semibold tracking-tight">{title}</Heading>
        {meta !== undefined && meta !== null && <p className="text-xs text-muted-foreground" data-testid="section-meta">
            {meta}
          </p>}
      </div>
      {actions !== undefined && actions !== null && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
