/**
 * VisionSet's design-token extensions, layered over `@robomous/ui-core`.
 *
 * The foundation (shadcn preset + `brand`) lives in the package, whose
 * stylesheet is the only copy of its values. VisionSet keeps `stage` (the
 * annotator's surround), the three `origin-*` marks a Models card's accent
 * edge takes, and `progress`, the colour of work partway done. `styles.css` here declares them following shadcn's own extension
 * convention, and `tokens.test.ts` asserts the two agree, declaration for
 * declaration.
 */

/** The variable names VisionSet keeps beyond the foundation's vocabulary. */
export const EXTENSIONS = [
  "stage",
  "origin-hub",
  "origin-custom",
  "origin-robomous",
  "progress",
] as const;

export const EXTENSION_LIGHT: Readonly<Record<string, string>> = Object.freeze({
  // The annotator's surround — the neutral a photograph is judged against.
  stage: "oklch(0.94 0 0)",
  // Where a model's weights come from, as a card's accent edge. Theme-stable.
  "origin-hub": "oklch(0.8 0.16 85)",
  "origin-custom": "oklch(0.65 0.15 250)",
  "origin-robomous": "oklch(0.68 0.17 35)",
  // Work partway done: a ring's arc, a meter's fill. Its track is this at 15%.
  progress: "oklch(0.45 0.045 92)",
});

export const EXTENSION_DARK: Readonly<Record<string, string>> = Object.freeze({
  stage: "oklch(0.24 0 0)",
  "origin-hub": "oklch(0.8 0.16 85)",
  "origin-custom": "oklch(0.65 0.15 250)",
  "origin-robomous": "oklch(0.68 0.17 35)",
  progress: "oklch(0.8 0.05 92)",
});
