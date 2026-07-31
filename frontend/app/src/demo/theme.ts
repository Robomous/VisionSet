/**
 * The showcase's design tokens — the repo-root `DESIGN.md` contract, as inline
 * style values.
 *
 * ## Why this file still exists after #128
 *
 * #50 wrote that #128 would replace it. #128 replaced the *values*, which is the
 * half that mattered: every colour, radius and size below is now imported from
 * `@visionset/ui-core`, so there is one home for the contract and this is a
 * projection of it. What is left is a shape adapter — `COLOR.primary` as a string
 * for a `style={{}}` object, not `bg-primary` as a class.
 *
 * The showcase keeps inline styles rather than moving to Tailwind utilities. #128
 * deferred that by giving the design system its own Vite entry, so that Tailwind's
 * preflight — a global reset — would not reach the page 54 Playwright scenarios
 * measure. #58 retired both entries: there is one bundle now and the reset applies
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

import {
  COLOR as TOKEN_COLOR,
  FONT,
  RADIUS as TOKEN_RADIUS,
  TEXT as TOKEN_TEXT,
} from "@visionset/ui-core";

/** `DESIGN.md` → colors. Intent names, never the value, at the call site. */
export const COLOR = {
  primary: TOKEN_COLOR.primary,
  primaryHover: TOKEN_COLOR["primary-hover"],
  /** The accent at 10% — chips and selected rows. */
  primarySoft: `${TOKEN_COLOR.primary}1a`,
  background: TOKEN_COLOR.background,
  card: TOKEN_COLOR.card,
  muted: TOKEN_COLOR.muted,
  foreground: TOKEN_COLOR.foreground,
  mutedForeground: TOKEN_COLOR["muted-foreground"],
  border: TOKEN_COLOR.border,
  destructive: TOKEN_COLOR.destructive,
  /** The mat. See the exception above — the two values not in the contract. */
  well: "#0d1117",
  wellBorder: "#30363d",
  /** Ink that reads on the mat. Used only by the two overlays that sit on it. */
  onWell: "#e6edf3",
} as const;

/** `DESIGN.md` → rounded, as numbers, because these land in `style={{}}`. */
export const RADIUS = {
  sm: px(TOKEN_RADIUS.sm),
  md: px(TOKEN_RADIUS.md),
  lg: px(TOKEN_RADIUS.lg),
  xl: px(TOKEN_RADIUS.xl),
  full: 9999,
} as const;

/**
 * `DESIGN.md` → spacing: the 4 / 8 / 16 / 24 / 32 rhythm.
 *
 * Not imported, because `ui-core`'s `SPACING` holds only the rail's three widths —
 * the values three components must agree on. Ordinary rhythm is Tailwind's numeric
 * scale over there, which has no meaning in a `style={{}}` object, so it is spelled
 * as numbers here.
 */
export const SPACE = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

export const FONT_STACK = FONT.sans;

export const TEXT = {
  pageTitle: { fontSize: TOKEN_TEXT.page, fontWeight: 600, letterSpacing: "-0.025em" },
  sectionTitle: { fontSize: TOKEN_TEXT.section, fontWeight: 600 },
  body: { fontSize: TOKEN_TEXT.body, lineHeight: 1.6 },
  label: { fontSize: TOKEN_TEXT.body, fontWeight: 500 },
  meta: { fontSize: TOKEN_TEXT.meta, fontWeight: 400 },
} as const;

/** `DESIGN.md` → elevation. Overlays only; resting surfaces are flat with a border. */
export const SHADOW = {
  card: "0 1px 2px #25294914",
  overlay: "0 8px 24px #25294933",
} as const;

/** `"12px"` → `12`. React writes a bare number as pixels; a string it takes verbatim. */
function px(value: string): number {
  return Number.parseFloat(value);
}
