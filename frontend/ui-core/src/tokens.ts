/**
 * The design tokens, as TypeScript.
 *
 * `styles.css` is the one that *runs* — Tailwind reads its `:root`, `.dark`
 * and `@theme inline` blocks and every utility in the package comes out of
 * them. This module exists for the two kinds of caller that cannot read CSS:
 * a `<canvas>`/`<svg>` that needs a colour as a string, and `tokens.test.ts`,
 * which parses the stylesheet and asserts the two agree, declaration for
 * declaration.
 *
 * `LIGHT_THEME`/`DARK_THEME` are the shadcn preset (`b3bXyyPdWj` — style
 * `nova`, base colour `neutral`, chart palette `orange`) exactly as the CLI
 * 4.18.0 scratch generated it, plus VisionSet's four justified extensions:
 * `stage` (the annotator's surround), `brand` (Robomous coral — identity
 * only), and the `success`/`warning` status pair, each with its own
 * `-foreground`. Everything else is shadcn's own vocabulary.
 */

export const LIGHT_THEME: Readonly<Record<string, string>> = Object.freeze({
  background: "oklch(1 0 0)",
  foreground: "oklch(0.145 0 0)",
  card: "oklch(1 0 0)",
  "card-foreground": "oklch(0.145 0 0)",
  popover: "oklch(1 0 0)",
  "popover-foreground": "oklch(0.145 0 0)",
  primary: "oklch(0.205 0 0)",
  "primary-foreground": "oklch(0.985 0 0)",
  secondary: "oklch(0.97 0 0)",
  "secondary-foreground": "oklch(0.205 0 0)",
  muted: "oklch(0.97 0 0)",
  "muted-foreground": "oklch(0.556 0 0)",
  accent: "oklch(0.97 0 0)",
  "accent-foreground": "oklch(0.205 0 0)",
  destructive: "oklch(0.577 0.245 27.325)",
  border: "oklch(0.922 0 0)",
  input: "oklch(0.922 0 0)",
  ring: "oklch(0.708 0 0)",
  "chart-1": "oklch(0.837 0.128 66.29)",
  "chart-2": "oklch(0.705 0.213 47.604)",
  "chart-3": "oklch(0.646 0.222 41.116)",
  "chart-4": "oklch(0.553 0.195 38.402)",
  "chart-5": "oklch(0.47 0.157 37.304)",
  sidebar: "oklch(0.985 0 0)",
  "sidebar-foreground": "oklch(0.145 0 0)",
  "sidebar-primary": "oklch(0.205 0 0)",
  "sidebar-primary-foreground": "oklch(0.985 0 0)",
  "sidebar-accent": "oklch(0.97 0 0)",
  "sidebar-accent-foreground": "oklch(0.205 0 0)",
  "sidebar-border": "oklch(0.922 0 0)",
  "sidebar-ring": "oklch(0.708 0 0)",

  // The annotator's surround — the neutral a photograph is judged against.
  // Distinguishable from `background` in both themes, so a white asset edge
  // still shows where it ends.
  stage: "oklch(0.94 0 0)",
  // Robomous coral. Identity only (the wordmark and the ingest progress
  // fill) — never a functional-UI colour.
  brand: "oklch(0.653 0.178 32.3)",
  // The batch-state family's filled control, a green analogue of the
  // preset's own destructive treatment.
  success: "oklch(0.577 0.132 152)",
  "success-foreground": "oklch(1 0 0)",
  warning: "oklch(0.646 0.13 80)",
  "warning-foreground": "oklch(0.205 0 0)",
});

export const DARK_THEME: Readonly<Record<string, string>> = Object.freeze({
  background: "oklch(0.145 0 0)",
  foreground: "oklch(0.985 0 0)",
  card: "oklch(0.205 0 0)",
  "card-foreground": "oklch(0.985 0 0)",
  popover: "oklch(0.205 0 0)",
  "popover-foreground": "oklch(0.985 0 0)",
  primary: "oklch(0.922 0 0)",
  "primary-foreground": "oklch(0.205 0 0)",
  secondary: "oklch(0.269 0 0)",
  "secondary-foreground": "oklch(0.985 0 0)",
  muted: "oklch(0.269 0 0)",
  "muted-foreground": "oklch(0.708 0 0)",
  accent: "oklch(0.269 0 0)",
  "accent-foreground": "oklch(0.985 0 0)",
  destructive: "oklch(0.704 0.191 22.216)",
  border: "oklch(1 0 0 / 10%)",
  input: "oklch(1 0 0 / 15%)",
  ring: "oklch(0.556 0 0)",
  "chart-1": "oklch(0.837 0.128 66.29)",
  "chart-2": "oklch(0.705 0.213 47.604)",
  "chart-3": "oklch(0.646 0.222 41.116)",
  "chart-4": "oklch(0.553 0.195 38.402)",
  "chart-5": "oklch(0.47 0.157 37.304)",
  sidebar: "oklch(0.205 0 0)",
  "sidebar-foreground": "oklch(0.985 0 0)",
  "sidebar-primary": "oklch(0.488 0.243 264.376)",
  "sidebar-primary-foreground": "oklch(0.985 0 0)",
  "sidebar-accent": "oklch(0.269 0 0)",
  "sidebar-accent-foreground": "oklch(0.985 0 0)",
  "sidebar-border": "oklch(1 0 0 / 10%)",
  "sidebar-ring": "oklch(0.556 0 0)",

  stage: "oklch(0.24 0 0)",
  brand: "oklch(0.653 0.178 32.3)",
  success: "oklch(0.696 0.17 152)",
  "success-foreground": "oklch(0.205 0 0)",
  warning: "oklch(0.75 0.14 80)",
  "warning-foreground": "oklch(0.205 0 0)",
});

/** The two provenance facts a colour string alone cannot carry. */
export const THEME = {
  radius: "0.625rem",
  fontSans: "'Inter Variable', sans-serif",
  fontHeading: "'Geist Variable', sans-serif",
} as const;

/** The six variable names the audit kept beyond shadcn's own vocabulary. */
export const EXTENSIONS = [
  "stage",
  "brand",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
] as const;

/** `cssVar("popover")` → `"var(--popover)"` — for a runtime caller that needs a string. */
export function cssVar(name: string): string {
  return `var(--${name})`;
}
