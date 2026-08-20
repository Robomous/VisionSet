/**
 * The showcase's design tokens — the repo-root `DESIGN.md` contract, as inline
 * style values.
 *
 * ## Why this file exists beside the design system
 *
 * The design system replaced the *values*, which is the
 * half that mattered: every colour and radius below is read off
 * `@visionset/ui-core`'s `cssVar`/`THEME`, so there is one home for the
 * contract and this is a projection of it. What is left is a shape adapter —
 * `COLOR.primary` as a `var(--primary)` string for a `style={{}}` object, not
 * `bg-primary` as a class.
 *
 * `RADIUS` and `TEXT` are plain literals rather than a token import: the
 * shadcn preset exposes radius only as the seven CSS-side derivations
 * (`--radius-sm` … `--radius-4xl`) and font size only as Tailwind's own
 * scale, neither of which this file's `style={{}}` shape can consume as a
 * bare number without re-deriving it here. The numbers below are that
 * derivation, done once, matching `--radius`'s `0.625rem` step and the type
 * sizes this showcase always used.
 *
 * The showcase keeps inline styles rather than moving to Tailwind utilities. The
 * design system
 * deferred that by giving the design system its own Vite entry, so that Tailwind's
 * preflight — a global reset — would not reach the page 54 Playwright scenarios
 * measure. There is one bundle now and the reset applies
 * here too.
 *
 * These stayed anyway, and the reason is what made the flip safe. Because every
 * value below is already an explicit `style={{}}`, preflight has almost nothing
 * left to reset on this page — its headings, buttons and panels all carry their
 * own. Rewriting them into utilities would be a diff across a page whose layout is
 * load-bearing for the suite, bought for consistency alone. The values come from
 * `@visionset/ui-core` either way, so the contract still has one home.
 *
 * ## The one deliberate exception, recorded here rather than in six components
 *
 * **The canvas well is dark.** `DESIGN.md` describes a light, GitHub-style
 * application, and the panels, buttons and text around the image follow it
 * exactly. The surround the picture sits in does not — a bright frame around a
 * photograph shifts its apparent colour and contrast, which is why every image
 * tool ever shipped puts a dark mat behind one. It is the mat, not a second theme:
 * nothing interactive is drawn on it except the floating tool strip, which is
 * itself a `muted` panel in the light palette. `well` and `wellBorder` below are
 * the only two values this file owns.
 */

import { cssVar, THEME } from "@visionset/ui-core";

/** `DESIGN.md` → colors. Intent names, never the value, at the call site. */
export const COLOR = {
  primary: cssVar("primary"),
  /** The Nova hover idiom (`hover:bg-primary/80`), as a `style={{}}` string. */
  primaryHover: "color-mix(in oklch, var(--primary) 80%, transparent)",
  /** The accent at 10% — chips and selected rows. */
  primarySoft: "color-mix(in oklch, var(--primary) 10%, transparent)",
  background: cssVar("background"),
  card: cssVar("card"),
  muted: cssVar("muted"),
  foreground: cssVar("foreground"),
  mutedForeground: cssVar("muted-foreground"),
  border: cssVar("border"),
  destructive: cssVar("destructive"),
  /** The mat. See the exception above — the two values not in the contract. */
  well: "#0d1117",
  wellBorder: "#30363d",
  /** Ink that reads on the mat. Used only by the two overlays that sit on it. */
  onWell: "#e6edf3",
} as const;

/**
 * `DESIGN.md` → rounded, as numbers, because these land in `style={{}}`.
 *
 * The preset's own derivation from `--radius: 0.625rem` (10px): `sm` is
 * `* 0.6`, `md` is `* 0.8`, `lg` is `--radius` itself, `xl` is `* 1.4`.
 */
export const RADIUS = {
  sm: 6,
  md: 8,
  lg: 10,
  xl: 14,
  full: 9999,
} as const;

/**
 * `DESIGN.md` → spacing: the 4 / 8 / 16 / 24 / 32 rhythm.
 *
 * Not imported: the design system's own rail widths live in `styles.css`'s
 * `--spacing-sidebar*` extensions, which this showcase never draws. Ordinary
 * rhythm is Tailwind's numeric scale over there, which has no meaning in a
 * `style={{}}` object, so it is spelled as numbers here.
 */
export const SPACE = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

export const FONT_STACK = THEME.fontSans;

/** The type scale this showcase always used, kept as literals — see the note above. */
export const TEXT = {
  pageTitle: { fontSize: "1.5rem", fontWeight: 600, letterSpacing: "-0.025em" },
  sectionTitle: { fontSize: "1rem", fontWeight: 600 },
  body: { fontSize: "0.875rem", lineHeight: 1.6 },
  label: { fontSize: "0.875rem", fontWeight: 500 },
  meta: { fontSize: "0.75rem", fontWeight: 400 },
} as const;

/** `DESIGN.md` → elevation. Overlays only; resting surfaces are flat with a border. */
export const SHADOW = {
  card: "0 1px 2px #25294914",
  overlay: "0 8px 24px #25294933",
} as const;
