/**
 * A state, as a chip: a tinted ground, a glyph that fills as the thing nears
 * done, and the word.
 *
 * The glyph is the state's whole vocabulary, one grammar for every family
 * (`DESIGN.md` → *States*): a dashed ring is not committed, a solid ring is
 * committed and not started, the fill is how far along (in quarters), the
 * arrow is on its way somewhere else, the slash is decided against, the check
 * is done — dashed, done but not yet somebody's. So a chip reads at a glance
 * before its word is read, and the icon-only form still says it. What the
 * state means beyond its word is a card on hover or focus: a title and a line
 * or two, never the word again.
 *
 * The glyphs are lucide's where lucide has them, drawn on lucide's own grid
 * where it does not (the quarter and three-quarter pies, the dashed cross), so
 * the set reads as one family at one stroke.
 */

import { Ban, Circle, CircleAlert, CircleCheck, CircleDashed, CircleDashedCheck, CircleFadingArrowUp } from "lucide-react";
import type { JSX } from "react";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@robomous/ui-core";

/**
 * Not started · partway · something to look at · done · failed — and the two
 * lifecycle families of the product-wide status mapping
 * (`docs/content/ui/product-principles.md` → *Status semantics*): `active`, work
 * in flight (`info`), and `waiting`, waiting on a person (`warning`).
 */
export type Tone = "draft" | "progress" | "review" | "done" | "failed" | "active" | "waiting";

/**
 * The shapes, by what they say: `backlog` a dashed ring, `todo` a ring,
 * `partway` a pie, `review` the pie at three quarters, `ready` the ring with an
 * arrow, `skipped` the slashed ring, `done` the check, `drafted` the dashed
 * check, `cancelled` the dashed cross, `failed` the ring with a mark.
 */
export type GlyphKind = "backlog" | "todo" | "partway" | "review" | "ready" | "skipped" | "done" | "drafted" | "cancelled" | "failed";

export interface State {
  readonly tone: Tone;
  readonly label: string;
  /** The shape, where the tone's own one does not say it (`TONE_GLYPH`). */
  readonly glyph?: GlyphKind;
  /** How far along, 0–1, for a pie that fills with it, in quarters; the tone's own share otherwise. */
  readonly fraction?: number;
  /** The card's first line: the answer in a few words, never the label again. */
  readonly title?: string;
  readonly lines?: readonly string[];
}

const TONE: Record<Tone, string> = {
  draft: "bg-muted text-muted-foreground",
  progress: "bg-progress/10 text-progress",
  review: "bg-info/10 text-info",
  done: "bg-success/10 text-success",
  failed: "bg-destructive/10 text-destructive",
  active: "bg-info/10 text-info",
  waiting: "bg-warning/10 text-warning",
};

/** A tone's own shape, when the state names none. */
const TONE_GLYPH: Record<Tone, GlyphKind> = {
  draft: "backlog",
  progress: "partway",
  review: "review",
  done: "done",
  failed: "failed",
  active: "partway",
  waiting: "review",
};

/** One stroke for the whole set, whatever the size: lucide's grid, 1.5px on screen. */
const STROKE = 1.5;

/** lucide's own dashed ring (`CircleDashed`), so the drawn glyphs carry exactly its dashes. */
const DASHES = [
  "M10.1 2.182a10 10 0 0 1 3.8 0",
  "M13.9 21.818a10 10 0 0 1-3.8 0",
  "M17.609 3.721a10 10 0 0 1 2.69 2.7",
  "M2.182 13.9a10 10 0 0 1 0-3.8",
  "M20.279 17.609a10 10 0 0 1-2.7 2.69",
  "M21.818 10.1a10 10 0 0 1 0 3.8",
  "M3.721 6.391a10 10 0 0 1 2.7-2.69",
  "M6.391 20.279a10 10 0 0 1-2.69-2.7",
];

/**
 * A pie's share in quarters, as the glyph set draws it: never empty or full, so
 * it is never read as the ring or the check.
 */
function quarters(fraction: number): number {
  return Math.min(0.75, Math.max(0.25, Math.round(fraction * 4) / 4));
}

/** `Contrast`'s inner disc (r=6, from twelve o'clock clockwise), at any share. */
function sector(share: number): string {
  const a = share * 2 * Math.PI;
  const x = 12 + 6 * Math.sin(a);
  const y = 12 - 6 * Math.cos(a);
  return `M12 12V6A6 6 0 ${share > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`;
}

/**
 * The glyph, 14px unless sized. Lucide's icons as shipped where it has the
 * shape — `CircleDashed`, `Circle`, `CircleCheck`, `CircleDashedCheck`,
 * `CircleAlert`; `CircleFadingArrowUp` turned to point on; `Ban` mirrored to the
 * set's slant — and the pies and the dashed cross drawn on its grid.
 */
export function StateGlyph({
  tone,
  glyph,
  fraction,
  size = 14,
  className,
}: {
  readonly tone: Tone;
  readonly glyph?: GlyphKind;
  readonly fraction?: number;
  readonly size?: number;
  readonly className?: string;
}): JSX.Element {
  const kind = glyph ?? TONE_GLYPH[tone];
  const icon = { size, strokeWidth: STROKE, absoluteStrokeWidth: true, "aria-hidden": true, className: cn("shrink-0", className) } as const;
  switch (kind) {
    case "backlog":
      return <CircleDashed {...icon} />;
    case "todo":
      return <Circle {...icon} />;
    case "ready":
      return <CircleFadingArrowUp {...icon} className={cn(icon.className, "rotate-90")} />;
    case "skipped":
      return <Ban {...icon} className={cn(icon.className, "-scale-x-100")} />;
    case "done":
      return <CircleCheck {...icon} />;
    case "drafted":
      return <CircleDashedCheck {...icon} />;
    case "failed":
      return <CircleAlert {...icon} />;
    case "cancelled":
    case "partway":
    case "review":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={(STROKE * 24) / size}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn("shrink-0", className)}
          aria-hidden="true"
        >
          {kind === "cancelled" ? (
            <>
              {DASHES.map((d) => (
                <path key={d} d={d} />
              ))}
              <path d="m14.5 9.5-5 5" />
              <path d="m9.5 9.5 5 5" />
            </>
          ) : (
            <>
              <circle cx="12" cy="12" r="10" />
              <path d={sector(quarters(fraction ?? (kind === "review" ? 0.75 : 0.5)))} fill="currentColor" stroke="none" />
            </>
          )}
        </svg>
      );
  }
}

/**
 * A state as a chip. With a card, the chip takes focus so the keyboard reaches
 * the card the pointer does; without one it is only words. Icon-only, the
 * word is its accessible name.
 */
export function StateChip({
  state,
  iconOnly = false,
  linesOnly = false,
  className,
  testId,
}: {
  readonly state: State;
  readonly iconOnly?: boolean;
  /** The card leaves its title out, because the words beside the chip already say it. */
  readonly linesOnly?: boolean;
  readonly className?: string;
  readonly testId?: string;
}): JSX.Element {
  const title = linesOnly ? undefined : state.title;
  const said = [title, ...(state.lines ?? [])].filter((line): line is string => line !== undefined && line !== "");
  const chip = (
    <span
      data-testid={testId}
      data-tone={state.tone}
      tabIndex={said.length > 0 ? 0 : undefined}
      aria-label={iconOnly ? state.label : undefined}
      role={iconOnly ? "img" : undefined}
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-md text-xs font-medium whitespace-nowrap tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        iconOnly ? "w-6 justify-center" : "gap-1.5 pr-2 pl-1.5",
        TONE[state.tone],
        className,
      )}
    >
      <StateGlyph tone={state.tone} glyph={state.glyph} fraction={state.fraction} />
      {!iconOnly && state.label}
    </span>
  );
  if (said.length === 0) return chip;
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" sideOffset={6} className="max-w-64 flex-col items-start gap-1 px-3 py-2.5 text-left">
        {title !== undefined && <span className="font-medium">{title}</span>}
        {(state.lines ?? []).map((line) => (
          <span key={line} className={title === undefined ? undefined : "text-background/70"}>
            {line}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
