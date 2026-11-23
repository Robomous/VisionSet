/**
 * The Dataset column's building blocks: a panel that folds, and a field — the
 * icon that names it, its label, and the value.
 *
 * ## A panel is the app's band
 *
 * Its heading is the band every project screen draws over a panel (the
 * Overview's *Classes* and *Images*): 48px, the icon that names it, the title
 * in sentence case, its answer quieter beside it — and the chevron at the
 * line's end, because here the band is also the toggle.
 *
 * ## The heading answers when the panel is folded
 *
 * Open, the fields under the band are the answer, so the band is the title and
 * the chevron. Folded, the answer — a count, a state chip — comes in beside the
 * title, so a folded column still reads as a summary. Said once either way.
 *
 * ## The body folds by its row track
 *
 * It stays mounted and closes by its grid row (1fr → 0fr) with its opacity: a
 * transition, so a second press turns it around wherever it is. Folded, it is
 * inert — out of the tab order and the accessibility tree.
 */

import { ChevronRight } from "lucide-react";
import { useMemo, useState, type ComponentType, type JSX, type ReactNode } from "react";

import { cn } from "@robomous/ui-core";
import { FIELD_GRID, Folds, useFold, type FoldState } from "./folds";

/** The column's strong ease-out, for the fold and its chevron. */
const EASE = "ease-[cubic-bezier(0.23,1,0.32,1)]";

/** Holds which sections are folded, for everything inside it. */
export function FoldsProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [folded, setFolded] = useState<Readonly<Record<string, boolean>>>({});
  const state = useMemo<FoldState>(
    () => ({
      isOpen: (id, byDefault) => folded[id] ?? byDefault,
      toggle: (id, byDefault) => setFolded((before) => ({ ...before, [id]: !(before[id] ?? byDefault) })),
    }),
    [folded],
  );
  return <Folds.Provider value={state}>{children}</Folds.Provider>;
}

export function Fold({
  id,
  icon: Glyph,
  title,
  answer,
  answerAlways = false,
  defaultOpen = true,
  flush = false,
  testId,
  children,
}: {
  readonly id: string;
  /** The icon that names the panel, as on every band in the app. */
  readonly icon: FieldIcon;
  readonly title: string;
  /** What the section holds in a few words, said beside the title while it is folded. */
  readonly answer?: ReactNode;
  /** Said open or folded: the work's state, which folding must never hide. */
  readonly answerAlways?: boolean;
  readonly defaultOpen?: boolean;
  /** The body runs to the column's edges — the versions. */
  readonly flush?: boolean;
  readonly testId?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const { open, toggle } = useFold(id, defaultOpen);
  const body = `section-${id}-body`;
  return (
    <section data-testid={testId ?? `section-${id}`} aria-label={title}>
      {/* The accordion's shape: the heading holds the toggle, never the other way round. */}
      <h2 className={cn(open && "border-b border-border/70")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={toggle}
        className={cn(
          "group flex min-h-12 w-full cursor-pointer items-center gap-2.5 px-4 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset md:px-6",
        )}
      >
        <Glyph aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="shrink-0 text-sm font-semibold tracking-tight">{title}</span>
        {(answerAlways || !open) && answer !== undefined && answer !== null && (
          <span className={cn("flex min-w-0 items-center truncate text-xs text-muted-foreground tabular-nums transition-[opacity,translate] duration-200 starting:-translate-x-1 starting:opacity-0 motion-reduce:transition-none", EASE)}>
            {answer}
          </span>
        )}
        <ChevronRight
          aria-hidden="true"
          strokeWidth={1.75}
          className={cn("ml-auto size-4 shrink-0 text-muted-foreground transition-[rotate,color] duration-200 group-hover:text-foreground motion-reduce:transition-none", EASE, open && "rotate-90")}
        />
      </button>
      </h2>
      <div
        id={body}
        inert={!open}
        className={cn("grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none", EASE, open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
      >
        <div className="min-h-0 overflow-hidden">
          <div className={flush ? undefined : "flex flex-col px-4 py-3 md:px-6"}>{children}</div>
        </div>
      </div>
    </section>
  );
}

export type FieldIcon = ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean | "true" | "false" }>;

/**
 * A field: the icon that names it, its label, an action beside the label (the
 * recipe's "+"), and the value. The icon labels the field; a state's glyph is
 * still the only icon a value gets.
 */
export function Field({
  icon: Glyph,
  label,
  htmlFor,
  action,
  testId,
  children,
}: {
  readonly icon: FieldIcon;
  readonly label: string;
  readonly htmlFor?: string;
  readonly action?: ReactNode;
  readonly testId?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className={cn(FIELD_GRID, "min-h-7 items-center")} data-testid={testId}>
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <Glyph aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.5} />
        {htmlFor === undefined ? (
          <span className="truncate">{label}</span>
        ) : (
          <label htmlFor={htmlFor} className="truncate">
            {label}
          </label>
        )}
        {action}
      </span>
      <div className="flex min-w-0 items-center tabular-nums">{children}</div>
    </div>
  );
}
