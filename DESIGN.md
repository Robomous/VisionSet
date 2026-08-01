---
version: 1
name: VisionSet
description: >
  VisionSet frontend design system — the authoritative visual contract for the M5 app
  (@visionset/app + @visionset/ui-core) and the annotator demo. GitHub-inspired,
  content-first, accessible UI on Radix primitives + lucide icons (decision H), styled
  with design tokens. Adapted 2026-07-30 from v1's DESIGN.md (computer-vision-lab-app),
  whose values were verified in its source; the reference screenshots are described in
  the 2026-07-30 design comment on issue #51. Implemented by #128 (M5 WS-1):
  frontend/ui-core/src/styles.css carries these values as Tailwind v4 @theme tokens
  and frontend/ui-core/src/tokens.ts mirrors them for callers that cannot read CSS,
  with a test asserting the two agree in both directions. This file is the prose
  half; those two are the running half.
colors:
  # Brand
  primary: "#eb5a47"            # Robomous orange — accent only (CTAs, active states, focus ring)
  primary-hover: "#d94a37"
  # Surfaces
  background: "#ffffff"
  card: "#ffffff"
  popover: "#ffffff"
  muted: "#f6f8fa"              # subtle fills, hover backgrounds, secondary surfaces
  # Text
  foreground: "#252949"         # primary text (Robomous ink)
  muted-foreground: "#57606a"   # secondary / meta text
  # Lines & focus
  border: "#d0d7de"
  input: "#d0d7de"
  ring: "#eb5a47"
  # Status
  destructive: "#dc2626"        # errors, destructive actions
  # Dark chrome (app rail / sidebar)
  sidebar: "#1f2937"
  sidebar-accent-bg: "#2d3748"
  sidebar-foreground: "#ffffff"
typography:
  page-title:
    fontFamily: system-ui
    fontSize: 1.5rem            # text-2xl (1.875rem on md+)
    fontWeight: 600
    letterSpacing: "-0.025em"
  section-title:
    fontFamily: system-ui
    fontSize: 1rem
    fontWeight: 600
  body:
    fontFamily: system-ui
    fontSize: 0.875rem          # 14px base
    lineHeight: 1.6
  meta:
    fontFamily: system-ui
    fontSize: 0.75rem
    fontWeight: 400
  label:
    fontFamily: system-ui
    fontSize: 0.875rem
    fontWeight: 500
rounded:
  sm: 4px                       # chips, small controls
  md: 8px                       # buttons, inputs, badges (default; --radius 0.5rem)
  lg: 12px                      # alerts, dialogs, sheets, tab lists
  xl: 16px                      # cards
  full: 9999px                  # avatars, progress bars, pills
spacing:
  xs: 4px
  sm: 8px                      # inline groups, field gap
  md: 16px                     # default layout unit
  lg: 24px                     # grids and page sections
  xl: 32px                     # form section padding
  page: 24px
elevation:
  none: "none"
  card: "shadow"               # resting cards
  raised: "shadow-md"          # card hover
  overlay: "shadow-lg"         # dialogs, sheets, toasts, dropdowns
layout:
  sidebar-width: 240px
  sidebar-width-collapsed: 60px
  sidebar-width-mobile: 280px
---

## Overview

VisionSet's interface is **GitHub-inspired, content-first, and accessible**. The screen is
mostly calm neutral surfaces and ink-colored text, with a single Robomous orange
(`#eb5a47`) reserved for things the user can act on: primary buttons, active tools and
navigation, links, and focus rings. A dark rail (`#1f2937`) frames a bright content area.

**Design principles** (inherited from v1, kept):

1. **Token-driven, not hardcoded.** Color, radius, and spacing come from the token
   registry above, surfaced as semantic utilities. Never a hex, `rgb()` or raw `var()`
   color in a class string — v1 spent its life migrating away from that; VisionSet starts
   clean and stays clean. **Enforced**: `tests/scripts/design_tokens.test.mjs` scans every
   tracked frontend source for a Tailwind arbitrary colour (`bg-[#eb5a47]`,
   `text-[var(--x)]`) and fails the build. An *inline* style carrying a **schema-supplied**
   colour is the sanctioned exception and the only one — `classColor` answers with whatever
   the kernel stored, and Tailwind has never seen it, so no utility could name it.
2. **Radix + lucide only for primitives** (decision H, epic #51). v1 built on shadcn/ui,
   which is Radix + Tailwind — the same constraint from the other end. FontAwesome is v1
   legacy and does not come along.
3. **Content over chrome.** Generous whitespace, subtle borders, minimal shadows, no
   gradients, quiet hover/focus effects. Orange is an accent, never a surface fill.
4. **Accessible by default.** Real `<button>`/`<a>` elements, visible `focus-visible`
   rings, keyboard operability, and every async surface has loading / empty / error
   states (skeletons preserve layout; errors are destructive alerts with a recovery
   action; empty states are a centered card with a muted icon, title, and one primary
   action).
5. **Consistency beats novelty.** A new screen should be indistinguishable in styling
   from the existing ones.

## Colors

Map intent → token; never invent a value:

| Intent | Token |
|--------|-------|
| Primary action / accent / active tool | `primary` (`#eb5a47`), hover `primary-hover` |
| Active navigation (rail item, tab underline) | `primary` — see **Tabs** below |
| Accent tint (chips, selected rows) | `primary` at 10% alpha, border `primary` |
| Page / app surface | `background` |
| Card / popover surface | `card` / `popover` |
| Subtle fill / hover / secondary surface | `muted` (`#f6f8fa`) |
| Primary text | `foreground` (`#252949`) |
| Secondary / meta text | `muted-foreground` (`#57606a`) |
| Borders & dividers | `border` (`#d0d7de`) |
| Focus ring | `ring` (= primary) |
| Errors / destructive | `destructive` (`#dc2626`) |
| Dark rail chrome | `sidebar` (`#1f2937`), text white |

Success has no dedicated token yet; v1's documented exception (`text-green-600` for the
"saved" indicator) carries over as *the* exception until a token is added. The palette is
defined for light mode; dark mode is a post-beta concern.

## Typography

System font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …`), **14px
base**, line-height 1.6. One scale — reuse it, don't invent sizes:

| Role | Spec |
|------|------|
| Page title | 1.5rem / 600 / tracking -0.025em |
| Section / card title | 1rem / 600 |
| Body | 0.875rem |
| Label | 0.875rem / 500 |
| Meta / helper / timestamps | 0.75rem, muted-foreground |
| Error text | 0.75rem, destructive |

## Layout

- **App shell**: dark left rail (logo, collapse toggle, Home, Projects, account avatar at
  the bottom — nothing else; #58), bright content area. Rail width 240px, 60px collapsed,
  280px mobile — a single source of truth.
- **Page widths**: lists/dashboards/detail `max-w-7xl`; forms/settings `max-w-3xl`;
  centered, `px-4 md:px-6 py-6`.
- **Page header**: title + subtitle left, actions right, `border-b` below, `mb-8`.
- **Grids**: cards at `gap-6`, 2/3 columns by breakpoint; 16px is the default layout
  unit, 24px separates page sections. Detail two-column: `1fr / 320px`, stacking below
  `lg`. Breakpoints 640 / 768 / 1024 / 1280.

## Tabs

Two shapes, one component (`primitives/Tabs.tsx`), chosen by a `variant` on `TabsList`
which every trigger under it inherits. **#182**: they used to be one shape, a segmented
control, and on the project view that put three pressed-looking buttons directly under
the page's real buttons.

- **`underline` (the default)** — page sections, GitHub's repository nav. A row on a
  full-width `border` hairline; the active tab carries a **2px `primary` rule sitting on
  that hairline** plus `font-semibold` and `foreground` text; an inactive tab carries no
  border, no fill and no shadow, and gets a `muted` background on hover or focus. The
  inactive tab keeps the same 2px border at `transparent`, so selecting one does not
  shift the row.
- **`segmented`** — a narrow panel's two-way switch: `muted` list, `border`, 12px radius,
  4px padding, equal-width triggers, the active one raised onto `card` with `shadow-sm`.
  Used by the annotation side panel and nowhere else so far.

**The active underline is `primary`, and that is not an exception to the accent rule.**
The rule reserves orange for "primary buttons, active tools and **navigation**" — the
rail's active item is a solid `bg-primary` fill, and an open section is the same kind of
statement. A 2px rule is also not a surface fill, which is the accent rule this could
have broken. (An earlier docstring in `Tabs.tsx` argued the opposite and cited the rail
as its precedent; the rail says the reverse.)

Focus is **not** styled per variant: `styles.css`'s base layer gives every
`:focus-visible` element a 2px `ring` outline, and an outline is painted outside the box,
so it never depended on the segmented chip's fill. The underline variant adds
`focus-visible:bg-muted` only so the ring encloses a fill rather than the page.

## The annotation workspace

The page the reference design shows (#56), with measurements verified in v1's source:

- **Top bar** (`AnnotationToolHeader` in v1): one 44px (`h-11`) row on `card` with a
  `border-b`, 32px (`h-8`) controls, `h-5 w-px` divider between groups. Left to right:
  back · project name + date in muted text with `·` separators at 40% opacity · asset
  navigator `‹ filename n/m ›` · grid jump · class field · version select (GitBranch
  icon, `h-8` trigger) + create-branch (GitBranchPlus) · save-state indicator ("Saving…"
  pulsing meta text / "Saved" green check, shown ~3s / error in destructive with an
  underlined Retry) · **Save** (primary, Save icon) · **Accept** (CheckCheck) ·
  **Merge** (GitMerge) · `n / m annotated` · zoom out / percent / zoom in ·
  fullscreen (Maximize2) · help.
- **Tool strip**: floating at the canvas's left edge — 48px (`w-12`) column, `muted`
  surface, `border`, 12px radius, 8px padding; 36px icon buttons; **active tool = primary
  variant** (orange), inactive = ghost; a `h-px w-6` divider; help at the bottom.
  Tooltips open right with the shortcut ("Select (V)", "Box (B)", "Polygon (P)").
  Icons: MousePointer2 / Square / Spline; only tools the schema's geometries allow.
- **Side panel** (#126): 288px (`w-72`) column, `muted` surface, `border`, 12px radius;
  two tabs (Objects | Labels) in a 2-col tab list — the **`segmented`** variant, named
  at the call site, and the only surface that uses it (#182): two equal halves at 288px
  are a switch, and an underline's hairline would cut the panel in two rather than run
  under a page. Object rows: `rounded-md border
  px-1.5 py-1`, meta-size text `N. class`; **selected = `border-primary` +
  `bg-primary/10`**; hidden = 50% opacity; per-row eye and trash as 24px ghost icon
  buttons. Header row: object count in muted meta text + all-visibility toggle.
- **Zoom**: minimum 30%, percent readout between the −/+ buttons.

### Annotation shape rendering (canvas)

One class-color rule shared by the canvas, the side panel swatches (#126), and the
gallery badges (#55) — and it **already exists, shipped and unit-tested**:
`classColor` in `frontend/annotator/src/adapters/react/paint.ts` (#47). ui-core
**imports it**; nothing respells it (#128's gate):

- A class **with a schema color** (`LabelClass.color`) uses it — the kernel's own
  docstring settles the precedence. Fill is the same color at an opacity the shape
  applies (alpha is never baked in, because the kernel accepts any CSS color spelling).
- A class **without one** falls back to a deterministic FNV-1a hash of the name →
  `hsl(hash % 360 72% 58%)` — stable per class, per session, per machine, with no
  palette prop to thread down. (v1's fallback used a different hash and a four-value
  palette; not ported — the shipped rule is tested, and a fallback hue is arbitrary,
  not brand.)
- A control that can only take `#rrggbb` — `<input type="color">` in the schema editor — shows
  the same answer **converted**, never a substitute. `hexColor` in `frontend/ui-core/src/palette.ts`
  changes the notation and nothing else; it returns `null` for a CSS spelling it cannot convert,
  and the caller shows a neutral for that case alone. #162: binding such an input to the *stored*
  colour rendered every derived class grey beside a dot showing the real one.
- v1's shape metrics, kept as the reference: stroke width 2, selected 3; vertices render
  only while selected, radius 5 (7 when the vertex itself is selected), with a 2px white
  outline; the class label renders only while selected, 11px / 700, anchored at the
  first vertex, never a pointer target.

## Libraries

| Concern | Choice | Status |
|---------|--------|--------|
| UI primitives | Radix (+ shadcn-style composition with `cva` and `cn`) | **shipped** (#128) |
| Icons | lucide-react | **shipped** (#128) |
| Styling | Tailwind v4, CSS-first `@theme` — **no `tailwind.config.js`, ever** | **shipped** (#128) |
| Toasts | sonner | **shipped** (#128) |
| Component tests | vitest + jsdom + @testing-library/react, in `ui-core` | **shipped** (#128) |
| Server state | TanStack Query v5 | v1-verified default; pinned by #52 |
| Uploads | react-dropzone | v1-verified default; pinned by #54 |

Do not add a library for a covered concern without a documented reason.

## Do's and Don'ts

**Do**: consult this file before building or changing any UI; reuse primitives and
extend with variants; keep the type scale and spacing rhythm; cover loading/empty/error;
keep every interactive element keyboard-reachable with a visible focus ring.

**Don't**: hardcode colors in components; fill large surfaces with the accent; introduce
new colors, sizes, or libraries ad hoc; use `div onClick` for primary actions; add heavy
shadows, gradients, or loud motion.

## Where the contract lives

| | file |
|---|---|
| Prose (this file) | `DESIGN.md` |
| The running tokens | `frontend/ui-core/src/styles.css` — Tailwind v4 `@theme` |
| The TypeScript mirror | `frontend/ui-core/src/tokens.ts` — for callers that cannot read CSS |
| Primitives | `frontend/ui-core/src/primitives/` |
| Loading / empty / error | `frontend/ui-core/src/patterns/AsyncStates.tsx` |
| The class palette | `frontend/annotator/src/adapters/react/paint.ts`, re-exported by `ui-core/src/palette.ts` |
| Rendered, to look at | `frontend/app/styleguide.html` (`pnpm --filter @visionset/app dev`) |

The stylesheet and the mirror are gated against each other by `tokens.test.ts`, exact
equality in both directions. Adding a token to one and not the other fails the suite.

**A consumer imports one line** — `import "@visionset/ui-core/styles.css"` — and adds an
`@source` for its own sources.

## Provenance

Adapted from v1's `DESIGN.md` (`computer-vision-lab-app`, sibling checkout) on
2026-07-30, with every value verified against `frontend/src/styles/global.css`,
`components/annotations/annotation-utils.ts` (`getClassPalette`), and the annotation
workspace components (`AnnotationToolHeader` / `AnnotationToolStrip` /
`AnnotationSidePanel`). The reference screenshots are described in the 2026-07-30 design
comment on #51. The version-control affordances (branch dropdown, Merge) are recorded in
#127 and are post-beta; their top-bar slots render disabled.
