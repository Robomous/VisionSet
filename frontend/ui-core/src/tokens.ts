/**
 * VisionSet's design-token extensions, layered over `@robomous/ui-core`.
 *
 * The foundation (shadcn preset + `brand`) lives in the package; VisionSet
 * keeps `stage` (the annotator's surround) and the three `origin-*` marks a
 * Models card's accent edge takes. `styles.css` here declares them following
 * shadcn's own extension convention, and `tokens.test.ts` asserts the two
 * agree, declaration for declaration. `LIGHT_THEME`/`DARK_THEME` re-export
 * the *merged* view so a caller reading `LIGHT_THEME.stage` — the styleguide's
 * swatch captions — keeps working unchanged.
 */
import {
  DARK_THEME as FOUNDATION_DARK,
  LIGHT_THEME as FOUNDATION_LIGHT,
} from "@robomous/ui-core";

/** The variable names VisionSet keeps beyond the foundation's vocabulary. */
export const EXTENSIONS = [
  "stage",
  "origin-hub",
  "origin-custom",
  "origin-robomous",
] as const;

export const EXTENSION_LIGHT: Readonly<Record<string, string>> = Object.freeze({
  // The annotator's surround — the neutral a photograph is judged against.
  stage: "oklch(0.94 0 0)",
  // Where a model's weights come from, as a card's accent edge. Theme-stable.
  "origin-hub": "oklch(0.8 0.16 85)",
  "origin-custom": "oklch(0.65 0.15 250)",
  "origin-robomous": "oklch(0.68 0.17 35)",
});

export const EXTENSION_DARK: Readonly<Record<string, string>> = Object.freeze({
  stage: "oklch(0.24 0 0)",
  "origin-hub": "oklch(0.8 0.16 85)",
  "origin-custom": "oklch(0.65 0.15 250)",
  "origin-robomous": "oklch(0.68 0.17 35)",
});

export const LIGHT_THEME: Readonly<Record<string, string>> = Object.freeze({
  ...FOUNDATION_LIGHT,
  ...EXTENSION_LIGHT,
});
export const DARK_THEME: Readonly<Record<string, string>> = Object.freeze({
  ...FOUNDATION_DARK,
  ...EXTENSION_DARK,
});
