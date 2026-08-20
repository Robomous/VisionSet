/**
 * `cn` — merge class names, last conflicting utility wins.
 *
 * `clsx` handles the conditionals; `tailwind-merge` handles the part a naive
 * join gets wrong. Without it `cn("px-4", props.className)` with `px-6`
 * passed in emits both, and which one applies is decided by the order
 * Tailwind happened to write them into the stylesheet — so a caller's
 * override works or does not depending on a rule nobody can see. That is why
 * the `className` prop on every primitive here is a real extension point
 * rather than a suggestion.
 *
 * The shadcn preset's own vocabulary needs no custom `tailwind-merge`
 * configuration — unlike v1's `--text-*` scale, none of its names collide
 * with a stock Tailwind class group — so this is the bare merge, the same
 * shape the CLI scratch's own `lib/utils.ts` ships.
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: readonly ClassValue[]): string {
  return twMerge(clsx(inputs));
}
