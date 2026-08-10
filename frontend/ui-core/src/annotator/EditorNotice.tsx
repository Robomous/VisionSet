/**
 * The annotation editor's one notice surface: everything the editor has to say
 * about itself, in one corner, in one treatment.
 *
 * ## Why one surface at all
 *
 * The editor used to answer in four places. A suggest refusal was a card
 * bottom-right, a save refusal was a destructive badge inside the top bar's
 * `● annotated · Saved` microtext, an opening refusal was a second badge beside
 * it, and a refused Skip / Un-skip / Accept / Finish job was a full-bleed strip
 * under the header. Four placements and three treatments for one class of
 * message, so *where* a sentence appeared depended on which mutation produced
 * it — which is a fact about this file's history and not about anything a person
 * could learn.
 *
 * ## Top-right, and the bottom-right corner is why
 *
 * `ZoomWidget` sits at `bottom-3 right-3` and the suggest card cleared it with an
 * explicit `bottom-16` — one component holding a constant about another, and a
 * card that had already been observed *under* the widget, where the widget's
 * subtree swallowed the presses meant for the card's own buttons. Top-right is
 * unoccupied: the tool strip is top-left, the object counter bottom-left, the
 * zoom cluster bottom-right.
 *
 * The inset is `4` (16px, the `md` step) from the stage's top and right edges.
 * The stage already begins below the 44px top bar, so this is measured against
 * the surface the notice floats over rather than against the header.
 *
 * ## A stack, not a slot
 *
 * More than one thing can be true at once — a suggest session is live and the
 * save just refused — so the surface is a column, most-blocking first. A single
 * slot would have to choose, and choosing means hiding a refusal behind a
 * spinner.
 *
 * `pointer-events-none` on the column with `pointer-events-auto` on each card:
 * the column spans a fixed width down the side of the picture, and an invisible
 * strip that ate drags along the right edge of the canvas would be a worse defect
 * than the one this replaces.
 *
 * ## Wrapping is the invariant; width is comfort
 *
 * A model reference is a single unbroken token —
 * `IDEA-Research/grounding-dino-tiny@<40 hex>` — and **no fixed width guarantees
 * the next one fits**, so the body wraps mid-token (`wrap-anywhere`) and the
 * width is chosen so the common case never has to. `max-w-md` (448px) leaves the
 * `w-12` tool strip roughly 190px of clearance at the narrowest supported
 * desktop; see `MAX_WIDTH` below.
 */

import type { JSX, ReactNode } from "react";

/**
 * The surface's width, stated here because the number is a measurement rather
 * than a taste.
 *
 * At a 1280px viewport the rail takes 240px, the editor's row spends 24px of
 * padding and a 12px gap, and the side panel is a fixed `w-72` (288px) — so the
 * stage is 716px. Inset 16px from its right edge, a 448px card's left edge lands
 * at 252px, and the tool strip ends at 60px. Roughly 190px of clearance, which
 * is what "clear of the tool strip" has to mean for a surface that may grow a
 * line.
 *
 * 448px also fits a full `owner/model@revision` reference on one line at
 * `text-meta`, which is the width the previous 320px could not manage.
 */
const MAX_WIDTH = "max-w-md";

/**
 * The stage's notice column. Rendered once, whether or not it holds anything.
 *
 * `z-20` puts it over the tool strip and the zoom widget — both of which sit in
 * the stage's own stacking order with no `z` of their own — and leaves the
 * header's `z-50` popover untouched.
 */
export function EditorNotices({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div
      className={`pointer-events-none absolute right-4 top-4 z-20 flex w-full ${MAX_WIDTH} flex-col items-end gap-2`}
      data-testid="editor-notices"
    >
      {children}
    </div>
  );
}

export interface EditorNoticeProps {
  /** The card's own handle, so a test names the message and not the column. */
  readonly testId: string;
  /**
   * `warn` is the destructive-alert skin — a `destructive` hairline over a 5%
   * fill, the treatment the suggest card shipped with. `calm` is for the states
   * where nothing is wrong and a red card would teach somebody to distrust a
   * working tool.
   */
  readonly tone: "calm" | "warn";
  readonly icon: ReactNode;
  readonly children: ReactNode;
  /** The kernel's identifier, where a bug report can quote it. Never the message. */
  readonly title?: string;
}

export function EditorNotice({
  testId,
  tone,
  icon,
  children,
  title,
}: EditorNoticeProps): JSX.Element {
  return (
    <div
      data-testid={testId}
      data-tone={tone}
      role="status"
      {...(title === undefined ? {} : { title })}
      className={`pointer-events-auto flex w-full gap-2 rounded-lg border p-3 text-meta shadow-lg ${
        tone === "warn" ? "border-destructive/40 bg-destructive/5" : "border-border bg-card"
      }`}
    >
      <span
        className={`mt-0.5 shrink-0 ${tone === "warn" ? "text-destructive" : "text-muted-foreground"}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      {/* `min-w-0` lets the column shrink below its content's intrinsic width,
          which is the half of the wrap rule flexbox owns — without it a long
          token widens the flex item instead of breaking. */}
      <div className="flex min-w-0 flex-col gap-1 wrap-anywhere">{children}</div>
    </div>
  );
}
