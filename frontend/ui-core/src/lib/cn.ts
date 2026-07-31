/**
 * `cn` — merge class names, last conflicting utility wins.
 *
 * `clsx` handles the conditionals; `tailwind-merge` handles the part a naive join
 * gets wrong. Without it `cn("px-4", props.className)` with `px-6` passed in emits
 * both, and which one applies is decided by the order Tailwind happened to write
 * them into the stylesheet — so a caller's override works or does not depending on
 * a rule nobody can see. That is why the `className` prop on every primitive here
 * is a real extension point rather than a suggestion.
 *
 * ## Why this is `extendTailwindMerge` and not the bare `twMerge`
 *
 * `tailwind-merge` ships a model of Tailwind's *default* utilities and infers the
 * rest. `text-*` is the one place that inference goes wrong for us: the library
 * routes `text-<t-shirt-size>` and `text-[length]` to the **font-size** group and
 * everything else to the **text-color** group, because in stock Tailwind every
 * remaining `text-*` is a colour.
 *
 * `styles.css` declares `--text-meta`, `--text-body`, `--text-section` and
 * `--text-page`, which are font sizes with word-shaped names. So the bare merge
 * treats `text-body` as a colour, decides it conflicts with `text-foreground`, and
 * **silently drops it**:
 *
 *     twMerge("text-body text-foreground")   // → "text-foreground"
 *
 * Every input, every button and every table cell in this package would have been
 * one font size larger than the contract says, with nothing failing anywhere. It
 * was found by reading a rendered `class` attribute out of a component test, which
 * is the only place it is visible at all — `tsc` cannot see inside a string, and
 * the styleguide page looks plausible either way.
 *
 * The remedy is to *tell* the library about the four names. `cn.test.ts` pins each
 * one, in both directions, so a fifth size added to `styles.css` and not to this
 * list fails the suite rather than the layout.
 */

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

import { TEXT } from "../tokens";

/**
 * The custom font-size scale, read off the token table rather than restated.
 *
 * `Object.keys(TEXT)` is `["meta", "body", "section", "page"]`, and `tokens.ts` is
 * already gated against `styles.css` — so this list cannot drift from the sizes
 * that actually exist without `tokens.test.ts` failing first.
 */
const FONT_SIZES = Object.keys(TEXT);

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: FONT_SIZES }],
    },
  },
});

export function cn(...inputs: readonly ClassValue[]): string {
  return twMerge(clsx(inputs));
}
