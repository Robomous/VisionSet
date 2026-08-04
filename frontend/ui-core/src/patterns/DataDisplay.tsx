/**
 * The parts a data surface is built from: a stat, a bar, a class row, a grid.
 *
 * `DESIGN.md`'s **Project surfaces → Components** (#206), as running code. All
 * four are **data-only** — nothing here fetches, and nothing here knows what an
 * API is. That is what lets them be rendered in the styleguide against fixtures
 * and reviewed before a single screen consumes them.
 *
 * ## Four, not six
 *
 * #209 was written asking for six. Two of them already shipped and are
 * deliberately not rebuilt here:
 *
 * - **`EmptyState`** is in `patterns/AsyncStates.tsx`, and is already icon +
 *   title + description + one action — the spec, down to the "one primary
 *   action, two is a decision" comment.
 * - **Chip** is `primitives/Badge.tsx`. It already carries the tinted-fill and
 *   neutral-outline variants the header chips want.
 *
 * A second spelling of either would be the failure the "one spelling" rule
 * exists to prevent, and it is the same call `palette.ts` makes about `classColor`.
 *
 * ## Why `ThumbnailGrid` does not know what a thumbnail is
 *
 * `AssetThumbnail` fetches — it has to, because the preview route is protected
 * and an `<img src>` sends no `Authorization` header. If the grid imported it,
 * the grid would fetch, and "props are data-only" would stop being true for the
 * one component most likely to be reused with something else in its tiles.
 *
 * So the grid lays out `tiles` it is handed and counts an overflow it is told
 * about. The Overview composes it with `AssetThumbnail`; the styleguide composes
 * it with coloured squares; neither needed the other to exist.
 */

import type { HTMLAttributes, JSX, ReactNode } from "react";

import { cn } from "../lib/cn";
import { formatCount } from "../lib/format";

export interface StatCardProps extends Omit<HTMLAttributes<HTMLElement>, "onClick"> {
  /**
   * Where this card goes, when it goes anywhere.
   *
   * The `information-architecture` skill's dashboard rule: Overview never
   * duplicates a tab's full function, so every number on it is a *pointer* at
   * the section that owns it. A card with no destination is a plain statistic and
   * stays one.
   */
  readonly onGo?: () => void;
  readonly label: ReactNode;
  /** Pre-formatted. A caller with a raw count runs it through `formatCount`. */
  readonly value: ReactNode;
  /** One short line under the value — a delta, a denominator, a caveat. */
  readonly context?: ReactNode;
  readonly className?: string;
}

/**
 * One number, labelled.
 *
 * Tinted surface and **no border**: a grid of three or four of these reads as one
 * block of information, and four borders inside a card is four lines doing
 * nothing. `tabular-nums` on the value is the load-bearing class — without it a
 * number that updates shifts the ones beside it.
 */
export function StatCard({
  label,
  value,
  context,
  className,
  onGo,
  ...rest
}: StatCardProps): JSX.Element {
  const body = (
    <>
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="text-page font-semibold tabular-nums text-foreground">{value}</span>
      {context !== undefined && <span className="text-meta text-muted-foreground">{context}</span>}
    </>
  );
  const shell = "flex flex-col gap-1 rounded-lg bg-muted p-4";

  // A card that goes somewhere is a **button**, not a div with a handler: it has
  // to be reachable by keyboard and announced as an action, and the difference
  // between those two is the difference between a dashboard and a picture of one.
  // A card with nowhere to go stays a div rather than a disabled button, because
  // it is not a refused action — it is not an action.
  if (onGo === undefined) {
    return (
      <div className={cn(shell, className)} {...rest}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onGo}
      className={cn(shell, "text-left transition-colors hover:bg-stage", className)}
      {...rest}
    >
      {body}
    </button>
  );
}

export interface DistributionBarProps {
  readonly label: ReactNode;
  readonly count: number;
  /**
   * The largest count in **this chart**, never in this row.
   *
   * Passed in rather than derived, because a bar's whole meaning is its length
   * relative to its siblings and a component that only sees one row cannot know
   * that. A caller computing it per row would draw every bar full width.
   */
  readonly max: number;
  /** The class colour, from `classColor`. Applied inline — the sanctioned exception. */
  readonly color: string;
  readonly className?: string;
}

/**
 * One row of a bar chart: swatch, label, proportional bar, right-aligned count.
 *
 * The colour arrives as a CSS colour string and is applied as an **inline
 * style**, which is `DESIGN.md`'s one sanctioned exception to the no-hardcoded-
 * colour rule: `classColor` answers with whatever the kernel stored, and Tailwind
 * has never seen it, so no utility could name it.
 *
 * A zero `max` renders an empty track rather than dividing by zero — which is the
 * state a chart is in before anybody has labeled anything.
 */
export function DistributionBar({
  label,
  count,
  max,
  color,
  className,
}: DistributionBarProps): JSX.Element {
  const share = max <= 0 ? 0 : Math.max(0, Math.min(1, count / max));
  return (
    <div className={cn("flex items-center gap-2 text-body", className)}>
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-sm"
        style={{ backgroundColor: color }}
      />
      <span className="w-24 shrink-0 truncate text-foreground" title={String(label)}>
        {label}
      </span>
      {/* The track is the shared scale made visible: every row's track is the
          same width, so the fills are comparable by eye without a gridline. */}
      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full"
          style={{ width: `${share * 100}%`, backgroundColor: color }}
        />
      </span>
      <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
        {formatCount(count)}
      </span>
    </div>
  );
}

export interface ClassListRowProps {
  readonly name: string;
  readonly geometry: string;
  readonly count: number;
  readonly color: string;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
  readonly className?: string;
}

/**
 * One class in a master list: swatch, name, and `geometry · count` beneath.
 *
 * A real `<button>` spanning the whole row, which is two rules at once — the
 * entire row is the click target, and a keyboard reaches it without the list
 * having to manage focus itself. `aria-current` rather than `aria-selected`,
 * because this is navigation within a page and not a listbox option.
 *
 * Selected is a tinted background plus a 2px left accent rule. The **inactive**
 * row carries the same border at `transparent`, so selecting one does not shift
 * the text by two pixels — the trick `Tabs`' underline variant already uses.
 */
export function ClassListRow({
  name,
  geometry,
  count,
  color,
  selected = false,
  onSelect,
  className,
}: ClassListRowProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left transition-colors",
        selected
          ? "border-l-primary bg-primary/10"
          : "border-l-transparent hover:bg-muted focus-visible:bg-muted",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-sm"
        style={{ backgroundColor: color }}
      />
      <span className="flex min-w-0 flex-col">
        <span className={cn("truncate text-body", selected ? "font-semibold" : "text-foreground")}>
          {name}
        </span>
        <span className="truncate text-meta text-muted-foreground">
          {geometry} · <span className="tabular-nums">{formatCount(count)}</span>
        </span>
      </span>
    </button>
  );
}

export interface ThumbnailGridProps {
  /** Already-rendered tiles. Each is placed in a square cell. */
  readonly tiles: readonly ReactNode[];
  /**
   * How many more exist than were handed over. `0` renders no overflow tile.
   *
   * The *count*, not the total — a caller with `total` and `tiles.length` does
   * the subtraction, because only it knows whether `total` was capped.
   */
  readonly overflow?: number;
  readonly onOverflow?: () => void;
  readonly overflowLabel?: string;
  readonly className?: string;
}

/**
 * Square tiles in a grid, with a `+N` tile at the end.
 *
 * The overflow tile is a `<button>` when somebody can be sent somewhere and a
 * plain cell otherwise — `DESIGN.md`'s never-disable rule: a control that leads
 * nowhere is not rendered as a dead control, it is rendered as text.
 */
export function ThumbnailGrid({
  tiles,
  overflow = 0,
  onOverflow,
  overflowLabel = "Browse the rest",
  className,
}: ThumbnailGridProps): JSX.Element {
  const more = Math.max(0, Math.trunc(overflow));
  return (
    <div className={cn("grid grid-cols-3 gap-1.5", className)}>
      {tiles.map((tile, index) => (
        <div key={index} className="aspect-square overflow-hidden rounded-sm bg-muted">
          {tile}
        </div>
      ))}
      {more > 0 &&
        (onOverflow === undefined ? (
          <div
            data-testid="thumbnail-overflow"
            className="flex aspect-square items-center justify-center rounded-sm bg-muted text-body tabular-nums text-muted-foreground"
          >
            +{formatCount(more)}
          </div>
        ) : (
          <button
            type="button"
            data-testid="thumbnail-overflow"
            onClick={onOverflow}
            aria-label={overflowLabel}
            className="flex aspect-square items-center justify-center rounded-sm bg-muted text-body tabular-nums text-muted-foreground transition-colors hover:bg-border hover:text-foreground"
          >
            +{formatCount(more)}
          </button>
        ))}
    </div>
  );
}
