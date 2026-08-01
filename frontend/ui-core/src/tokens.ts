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
 * Every value is verified against v1's `frontend/src/styles/global.css` and
 * recorded in the repository-root `DESIGN.md`, which is the prose half of this
 * contract and the file to read before building any screen.
 */

/**
 * Colour, by **intent**. A component names the intent; only this file and
 * `styles.css` know a hex.
 *
 * Robomous orange is an *accent*: primary buttons, the active tool, links and the
 * focus ring. It is never a surface fill, and `DESIGN.md` says so in the one place
 * a reviewer will look.
 */
export const COLOR = {
  primary: "#eb5a47",
  "primary-hover": "#d94a37",
  "primary-foreground": "#ffffff",

  background: "#ffffff",
  foreground: "#252949",
  card: "#ffffff",
  "card-foreground": "#252949",
  popover: "#ffffff",
  "popover-foreground": "#252949",
  muted: "#f6f8fa",
  "muted-foreground": "#57606a",

  // The stage a picture sits on (#185) — the annotator's surround. Its own role:
  // not a subtle fill and not a surface content sits in, but the neutral a
  // photograph is judged against.
  stage: "#e1e6eb",

  border: "#d0d7de",
  input: "#d0d7de",
  ring: "#eb5a47",

  destructive: "#dc2626",
  "destructive-foreground": "#ffffff",

  // The dark rail (#58). Bright content, dark chrome — the one place a large
  // surface is deliberately not `background`.
  sidebar: "#1f2937",
  "sidebar-accent": "#2d3748",
  "sidebar-strong": "#111827",
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
