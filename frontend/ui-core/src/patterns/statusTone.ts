/**
 * The one home for status colour outside the `Badge`.
 *
 * `badge.tsx` earns its own emerald/amber/sky because a chip's `/10` surface
 * and hairline are a treatment nothing else draws. Everything else that paints
 * a status — a dot, a timeline cell, an inline icon or word — reads its colour
 * from here instead of naming a Tailwind family at its own call site, so a
 * sixth place inventing a fourth spelling of "warning" is a type error, not a
 * diff nobody notices.
 */
export type StatusTone = "neutral" | "accent" | "success" | "warning" | "destructive";

/**
 * A tone's border and its fill, as whole utility names.
 *
 * Whole names rather than a `border-${tone}` template, because Tailwind scans
 * source *text*: a class assembled at runtime is a class the build never saw and
 * therefore a rule that is never emitted. The failure is silent and looks like a
 * styling mistake, which is why these are written out.
 *
 * A status **dot** and a timeline **cell** are solid marks, not `Badge`s — a
 * full-strength `*-500` fill is right there, where the `Badge`'s `/10` surface
 * would vanish at 4px.
 */
export const TONE_BORDER: Record<StatusTone, string> = {
  neutral: "border-border",
  accent: "border-primary",
  success: "border-emerald-500 dark:border-emerald-400",
  warning: "border-amber-500 dark:border-amber-400",
  destructive: "border-destructive",
};

export const TONE_FILL: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground",
  accent: "bg-primary",
  success: "bg-emerald-500 dark:bg-emerald-400",
  warning: "bg-amber-500 dark:bg-amber-400",
  destructive: "bg-destructive",
};

/**
 * Ink for an icon or a run of inline text carrying a status — a `warning`
 * triangle beside a sentence, not a dot or a cell, so it wants a legible
 * foreground rather than `TONE_FILL`'s solid mark. `info` has no `StatusTone`
 * counterpart: it names sky for surfaces that are informational without being
 * any of `neutral`/`accent`/`success`/`warning`/`destructive`.
 */
export const STATUS_INK = {
  success: "text-emerald-700 dark:text-emerald-400",
  warning: "text-amber-700 dark:text-amber-400",
  info: "text-sky-700 dark:text-sky-400",
} as const;
