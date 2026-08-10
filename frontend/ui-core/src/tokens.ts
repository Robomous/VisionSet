/**
 * The design tokens, as TypeScript.
 *
 * `styles.css` is the one that *runs* — Tailwind reads its `@theme` block and
 * every utility in the package comes out of it. This module exists because two
 * kinds of caller cannot read CSS: a `<canvas>` or `<svg>` that needs a colour as
 * a string, and a test. `tokens.test.ts` asserts the two agree **declaration for
 * declaration, in both directions**, so this is a mirror rather than a second
 * spelling: adding a token to one file and not the other fails the suite.
 *
 * That gate is the same shape as the repository's other parity gates — the CLI's
 * `--json` against the REST wire models, `ProgressCounts` against `AssetProgress`,
 * `_MEDIA_TYPES` against `ImageFormat`. A rule that lives in two places is only
 * safe when a machine compares them.
 *
 * Every value is recorded in the repository-root `DESIGN.md`, which is the prose
 * half of this contract and the file to read before building any screen. The
 * The palette is the shipped one; the coral that preceded
 * them was v1's, and survives only as `brand`.
 */

/**
 * Colour, by **intent**. A component names the intent; only this file and
 * `styles.css` know a hex.
 *
 * The palette is neutral-first: a near-monochrome cool grey interface, a
 * near-black `primary` for the one action a view is about, and Robomous coral
 * held back to `brand` — two sites in the whole product, both named in
 * `DESIGN.md`. Colour is scarce here so that the places it appears mean
 * something.
 */
export const COLOR = {
  primary: "#1e2130",
  "primary-hover": "#2a2d40",
  "primary-foreground": "#ffffff",

  // Robomous coral. The wordmark and the ingest progress fill, and nothing else.
  brand: "#e85d44",

  background: "#fafafb",
  foreground: "#1b1d28",
  card: "#ffffff",
  "card-foreground": "#1b1d28",
  popover: "#ffffff",
  "popover-foreground": "#1b1d28",
  muted: "#f3f4f6",
  "muted-foreground": "#6b6e7e",

  // A disabled control: `muted`'s value under its own name, because what marks
  // one is the ink and the missing border rather than a colour of its own.
  disabled: "#f3f4f6",
  "disabled-foreground": "#a0a3b1",

  // The stage a picture sits on — the annotator's surround. Its own role:
  // not a subtle fill and not a surface content sits in, but the neutral a
  // photograph is judged against.
  stage: "#e4e6ec",

  border: "#e7e8ec",
  input: "#dcdde4",
  // The action colour at 35%. Same RGB channels as `primary`, asserted in
  // `tokens.test.ts` — a solid near-black ring on a near-black button is a smudge.
  ring: "rgba(30, 33, 48, 0.35)",

  success: "#2e7d5b",
  warning: "#b98217",
  destructive: "#c93b3b",
  "destructive-foreground": "#ffffff",

  // The dark rail. Bright content, dark chrome — the one place a large
  // surface is deliberately not `background`, and the same near-black as
  // `primary` so the rail and a filled button read as one family.
  sidebar: "#1e2130",
  "sidebar-accent": "#2a2d40",
  "sidebar-strong": "#161823",
  "sidebar-muted": "#8b8fa3",
  "sidebar-foreground": "#ffffff",
} as const;

/**
 * Corner radius. `md` is the default — buttons, inputs, badges — and `--radius`
 * in v1's spelling.
 */
export const RADIUS = {
  sm: "4px",
  md: "8px",
  lg: "12px",
  xl: "16px",
} as const;

/**
 * Named spacing beside Tailwind's numeric scale.
 *
 * Only the rail widths live here: they are a *single source of truth* the way
 * `DESIGN.md` demands, because three components (the rail, the collapse toggle
 * and the content offset) have to agree on them or the layout jumps. Ordinary
 * rhythm — 4 / 8 / 16 / 24 / 32 — is `gap-1` … `gap-8` and needs no token.
 */
export const SPACING = {
  sidebar: "240px",
  "sidebar-collapsed": "60px",
  "sidebar-mobile": "280px",
} as const;

/** The type scale. One scale; a screen reuses it and does not invent a size. */
export const TEXT = {
  meta: "0.75rem",
  body: "0.875rem",
  section: "1rem",
  page: "1.5rem",
} as const;

/** The system stack, spelled once. */
export const FONT = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
} as const;

/**
 * The whole registry, keyed by the CSS custom property each entry becomes.
 *
 * This is what `tokens.test.ts` compares against `styles.css`. It is built from
 * the five tables above rather than written out again, so the mirror cannot drift
 * from the thing it mirrors.
 */
export const DESIGN_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  ...prefixed("--color-", COLOR),
  ...prefixed("--radius-", RADIUS),
  ...prefixed("--spacing-", SPACING),
  ...prefixed("--text-", TEXT),
  ...prefixed("--font-", FONT),
});

function prefixed(
  prefix: string,
  table: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(table).map(([name, value]) => [`${prefix}${name}`, value]),
  );
}
