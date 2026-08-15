/**
 * The parts a data surface is built from: a stat, a bar, a class row, a grid.
 *
 * `DESIGN.md`'s **Project surfaces → Components**, as running code. All
 * four are **data-only** — nothing here fetches, and nothing here knows what an
 * API is. That is what lets them be rendered in the styleguide against fixtures
 * and reviewed before a single screen consumes them.
 *
 * ## Four, not six
 *
 * The design names six. Two of them already exist and are deliberately not
 * rebuilt here:
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

/**
 * The compact row's height, in CSS pixels — `h-9`, and exported because a
 * caller sizes a viewport in rows.
 *
 * A number rather than a measurement: the classes region's height rule is
 * "three rows minimum, one per class, eight maximum", and a rule stated in rows
 * needs the row to be a known quantity. That is also why the compact variant
 * carries an explicit height instead of letting its content decide — a row whose
 * height depended on whether a hotkey badge was drawn would make the region
 * eight-and-a-bit rows tall.
 */
export const CLASS_ROW_PX = 36;

export interface ClassListRowProps {
  readonly name: string;
  readonly geometry: string;
  /**
   * How many annotations carry the class. **Omit it for the compact variant**:
   * a row with a count stacks `geometry · count` under the name, and a row
   * without one puts the geometry on the same line and stands `CLASS_ROW_PX`
   * tall.
   *
   * Optional rather than a `variant` prop because the two are the same
   * distinction said once: the second line exists to carry the count, so a row
   * with nothing to count has no second line.
   */
  readonly count?: number;
  readonly color: string;
  /** `1`–`9` for the first nine classes in schema order, else absent. */
  readonly hotkey?: string | null;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
  /**
   * Why the row cannot be chosen, or absent when it can.
   *
   * Present means *disabled and explained* — principle 9 in the one shape a
   * list row has room for. A row that were merely `disabled` would state that
   * something is unavailable and nothing about why.
   */
  readonly refusal?: string;
  /**
   * A `data-testid` for the row's own button.
   *
   * This component takes a fixed set of props and does not spread the rest, so a
   * `data-testid` written on it would type-check — JSX permits hyphenated
   * attributes on a component — and reach nothing. A caller that needs to
   * address the row asks for it here.
   */
  readonly testId?: string;
  readonly className?: string;
  /**
   * The shapes this class can be drawn as, when there is a choice between them.
   *
   * Absent is the ordinary row and the ordinary case: a class accepting one
   * geometry has nothing to decide, and a list of fifty of them should carry
   * fifty *names* rather than fifty controls. Present turns the geometry text
   * into a segmented control — the active shape lit, pressing another switching
   * the tool without moving the class.
   *
   * **Present also changes the row's markup**, and that is not an implementation
   * detail worth hiding. This component's whole shape is "a real `<button>`
   * spanning the row"; HTML forbids interactive descendants inside a button, so
   * a row that offers a choice has to become a group with an inner name button
   * instead. The caller decides which rows are worth that, and `ClassRegion`
   * spends it on exactly one — the armed row, which is the only one where the
   * choice is live. The accessible answer and the density answer agree.
   *
   * `geometry` still renders when this is absent, so nothing else moves.
   */
  readonly shapes?: readonly {
    readonly value: string;
    /**
     * The shape's name, which is its **accessible** name whether or not it is
     * the thing drawn. A caller passing `icon` still owes this one.
     */
    readonly label: string;
    /**
     * The glyph to draw instead of the word, or absent to render the word.
     *
     * A `ReactNode` rather than an icon name, because this component is generic
     * and has no business knowing what a polygon looks like — the annotator does,
     * and `GeometryIcon` is where it says so once for the strip and the row. #597
     */
    readonly icon?: ReactNode;
    readonly active: boolean;
    readonly onPick: () => void;
  }[];
}

/**
 * One class in a master list: swatch, name, and `geometry · count` beneath — or,
 * without a count, swatch · name · geometry · hotkey on one `CLASS_ROW_PX` line.
 *
 * A real `<button>` spanning the whole row, which is two rules at once — the
 * entire row is the click target, and a keyboard reaches it without the list
 * having to manage focus itself. `aria-current` rather than `aria-selected`,
 * because this is navigation within a page and not a listbox option.
 *
 * Selected is a tinted background plus a 2px left accent rule. The **inactive**
 * row carries the same border at `transparent`, so selecting one does not shift
 * the text by two pixels — the trick `Tabs`' underline variant already uses.
 *
 * The compact variant is what the annotator's persistent class list in the side
 * panel uses. It is an extension rather than a sibling component deliberately:
 * the selected treatment, the swatch and the truncation are the parts a second
 * spelling would eventually get differently, and the schema editor and the
 * annotator showing "the selected class" two different ways is exactly the
 * drift worth spending a prop to avoid.
 */
export function ClassListRow({
  name,
  geometry,
  count,
  color,
  hotkey,
  selected = false,
  onSelect,
  refusal,
  testId,
  className,
  shapes,
}: ClassListRowProps): JSX.Element {
  const compact = count === undefined;
  const picking = shapes !== undefined && shapes.length > 0;
  // One copy of the row's chrome, whichever element ends up carrying it. The
  // whole reason this component is shared with the schema editor is that the
  // selected treatment should not have two spellings; a group variant that
  // rebuilt it would be that drift arriving through the back door.
  const chrome = cn(
    "flex w-full items-center gap-2 border-l-2 px-3 text-left transition-colors",
    compact ? "h-9 shrink-0" : "py-2",
    selected
      ? "border-l-primary bg-primary/10"
      : "border-l-transparent hover:bg-muted focus-visible:bg-muted",
    refusal !== undefined && "cursor-not-allowed text-disabled-foreground",
    className,
  );
  const swatch = (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-sm"
      style={{ backgroundColor: color }}
    />
  );

  if (picking) {
    // A group, not a button, because the shapes inside are buttons and HTML has
    // no nesting for that. Only the name is the "choose this class" target; the
    // row's own hover still reads as one thing because the chrome is the same.
    return (
      <div
        role="group"
        aria-label={name}
        {...(testId === undefined ? {} : { "data-testid": testId })}
        data-selected={selected ? "true" : undefined}
        className={chrome}
      >
        {swatch}
        <button
          type="button"
          onClick={onSelect}
          {...(testId === undefined ? {} : { "data-testid": `${testId}-name` })}
          aria-current={selected ? "true" : undefined}
          // `title` carries the full name. The chips are press targets and keep
          // their width, so this is the row where a long name still truncates —
          // hovering is how it comes back. #596 bought it the hotkey's ~28px.
          title={name}
          className={cn(
            "min-w-0 flex-1 truncate text-left text-body",
            selected && "font-semibold",
          )}
        >
          {name}
        </button>
        {shapes.map((shape) => (
          <button
            key={shape.value}
            type="button"
            onClick={shape.onPick}
            aria-pressed={shape.active}
            data-active={shape.active ? "true" : "false"}
            data-testid={testId === undefined ? undefined : `${testId}-shape-${shape.value}`}
            // The word is the accessible name whichever is drawn, so a chip that
            // shows a glyph is still announced as "polygon" and still hoverable
            // for it. #597 traded the words for pictures because three of them
            // beside a class name is ~128px of a 240px row.
            aria-label={shape.label}
            title={shape.label}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-sm text-meta transition-colors",
              shape.icon === undefined ? "px-1.5" : "size-6",
              shape.active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-card hover:text-foreground",
            )}
          >
            {shape.icon ?? shape.label}
          </button>
        ))}
        {/* No hotkey chip while picking, and it is bought rather than dropped:
            every shape here is a press target and truncating a control is worse
            than truncating a label, so the ~28px the chip and its gap take comes
            out of the name instead. The digit's job is to *arm* the class, and
            this row is the armed one — the badge is a reminder for the rows that
            are not. #596

            It is not enough on its own: a long name beside three chips still
            truncates, measured at 57px of 185. The chips are press targets and
            keep their width, and wrapping is closed off by the list's
            `rows * CLASS_ROW_PX` height rule, so the remedy is a design change
            rather than a class — filed as #597. */}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      disabled={refusal !== undefined}
      {...(refusal === undefined ? {} : { title: refusal })}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      className={chrome}
    >
      {swatch}
      {compact ? (
        <>
          {/* The same `-name` handle the group variant puts on its inner button,
              so a caller that wants to *choose this class* has one target in both
              markups. Clicking the row's centre works today by about fourteen
              pixels: once a picker is on the row, a longer name or a third shape
              moves that centre onto a shape segment, and the press would switch
              the tool while every "is it selected?" assertion still passed. */}
          <span
            {...(testId === undefined ? {} : { "data-testid": `${testId}-name` })}
            // The same recovery the group variant's name button already carries:
            // this side now wins the space, but a name long enough to truncate
            // against a *short* shape list is still reachable by hovering.
            title={name}
            className={cn("min-w-0 flex-1 truncate text-body", selected && "font-semibold")}
          >
            {name}
          </span>
          {/* Shrinks, where it used to be `shrink-0`, and that one word was the
              whole of #596. The name is `flex-1`, so its flex basis is zero and
              it receives only the *leftover* — a four-shape phrase took 176px of
              a 240px row and left the name 34px, two characters of it. The row's
              identity is the name; the shapes are metadata about it, and metadata
              is what gives way. `summariseGeometries` keeps this off the common
              path, but a long name with two shapes still needs it. */}
          <span className="min-w-0 shrink truncate text-meta text-muted-foreground">
            {geometry}
          </span>
          {/* Rendered only where the key works — `hotkeyForClass` answers null
              past the ninth class, and a chip on a row no digit reaches would be
              the same lie `ReassignMenu` refuses to tell one column over. */}
          {hotkey != null && (
            <kbd className="shrink-0 rounded-sm border border-border px-1 font-mono text-meta text-muted-foreground">
              {hotkey}
            </kbd>
          )}
        </>
      ) : (
        <span className="flex min-w-0 flex-col">
          <span
            className={cn("truncate text-body", selected ? "font-semibold" : "text-foreground")}
          >
            {name}
          </span>
          <span className="truncate text-meta text-muted-foreground">
            {geometry} · <span className="tabular-nums">{formatCount(count)}</span>
          </span>
        </span>
      )}
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
