/**
 * The showcase's design tokens — the repo-root `DESIGN.md` contract, spelled once.
 *
 * `DESIGN.md`'s first principle is *token-driven, not hardcoded*: no component
 * names a hex. This module is where the hexes live until **#128** lands the real
 * thing — `@visionset/ui-core`'s `tokens.css`, which today is a superseded
 * placeholder (dark surfaces, a blue accent) that contradicts the contract and is
 * to be replaced rather than extended. When it lands, the demo imports from there
 * and this file goes away; the components above it do not change, because they
 * already name intents rather than colours.
 *
 * A deliberate exception is recorded here rather than in a component, so it is one
 * decision instead of six: **the canvas well is dark.** `DESIGN.md` describes a
 * light, GitHub-style application, and the panels, buttons and text around the
 * image follow it exactly. The surround the picture sits in does not — a bright
 * frame around a photograph shifts its apparent colour and contrast, which is why
 * every image tool ever shipped puts a dark mat behind one. It is the mat, not a
 * second theme: nothing interactive is drawn on it except the floating tool strip,
 * which is itself a `muted` panel in the light palette.
 */

/** `DESIGN.md` → colors. Intent names, never the value, at the call site. */
export const COLOR = {
  primary: "#eb5a47",
  primaryHover: "#d94a37",
  /** The accent at 10% — chips and selected rows. */
  primarySoft: "#eb5a471a",
  background: "#ffffff",
  card: "#ffffff",
  muted: "#f6f8fa",
  foreground: "#252949",
  mutedForeground: "#57606a",
  border: "#d0d7de",
  destructive: "#dc2626",
  /** The mat. See the exception above. */
  well: "#0d1117",
  wellBorder: "#30363d",
  /** Ink that reads on the mat. Used only by the two overlays that sit on it. */
  onWell: "#e6edf3",
} as const;

/** `DESIGN.md` → rounded. */
export const RADIUS = { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 } as const;

/** `DESIGN.md` → spacing. */
export const SPACE = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

/** `DESIGN.md` → typography. 14px base, line-height 1.6, system stack. */
export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

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
