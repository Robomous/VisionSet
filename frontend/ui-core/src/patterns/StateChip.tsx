/**
 * A state, as a chip: a tinted ground, a glyph that fills as the thing nears
 * done, and the word.
 *
 * The glyph is the state's whole vocabulary — a dashed ring for not started, a
 * pie for partway (it fills to the real fraction when there is one), a filled
 * check for done, a filled mark for failed — so a chip reads at a glance
 * before its word is read, and the icon-only form still says it. What the
 * state means beyond its word is a card on hover or focus: a title and a line
 * or two, never the word again (`DESIGN.md` → *States*).
 */

import type { JSX } from "react";

import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@robomous/ui-core";

/** Not started · partway · waiting on someone · done · failed. */
export type Tone = "draft" | "progress" | "review" | "done" | "failed";

export interface State {
  readonly tone: Tone;
  readonly label: string;
  /** How far along, 0–1, for a pie that fills with it; the tone's own share otherwise. */
  readonly fraction?: number;
  /** The card's first line: the answer in a few words, never the label again. */
  readonly title?: string;
  readonly lines?: readonly string[];
}

const TONE: Record<Tone, string> = {
  draft: "bg-muted text-muted-foreground",
  progress: "bg-warning/10 text-warning",
  review: "bg-info/10 text-info",
  done: "bg-success/10 text-success",
  failed: "bg-destructive/10 text-destructive",
};

/** The glyph: 14px, on a 14-unit box so every stroke lands on the pixel grid. */
export function StateGlyph({ tone, fraction, className }: { readonly tone: Tone; readonly fraction?: number; readonly className?: string }): JSX.Element {
  const box = cn("size-3.5 shrink-0", className);
  if (tone === "draft") {
    return (
      <svg viewBox="0 0 14 14" className={box} aria-hidden="true">
        <circle cx="7" cy="7" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.1 2.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (tone === "done" || tone === "failed") {
    return (
      <svg viewBox="0 0 14 14" className={box} aria-hidden="true">
        <circle cx="7" cy="7" r="6.5" fill="currentColor" />
        {tone === "done" ? (
          <path d="M4.4 7.2 6.2 9 9.7 5.2" fill="none" stroke="var(--background)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M7 4v3.6M7 9.9v.1" fill="none" stroke="var(--background)" strokeWidth="1.6" strokeLinecap="round" />
        )}
      </svg>
    );
  }
  // A pie from twelve o'clock, never quite empty or full so it is never read as the ring or the check.
  const share = Math.min(0.999, Math.max(0.04, fraction ?? (tone === "progress" ? 0.5 : 0.75)));
  const angle = share * 2 * Math.PI;
  const r = 3.5;
  const x = 7 + r * Math.sin(angle);
  const y = 7 - r * Math.cos(angle);
  return (
    <svg viewBox="0 0 14 14" className={box} aria-hidden="true">
      <circle cx="7" cy="7" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d={`M7 7V${7 - r}A${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`} fill="currentColor" />
    </svg>
  );
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
      <StateGlyph tone={state.tone} fraction={state.fraction} />
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
