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
  # Primary action — a near-black with an indigo undertone. NOT the brand.
  primary: "#1e2130"            # filled buttons, active tab rule, active tool
  primary-hover: "#2a2d40"
  primary-foreground: "#ffffff"
  # Brand — Robomous coral, TWO sites in the whole product (see "Where the brand is")
  brand: "#e85d44"              # the rail's wordmark, and the progress bar's fill
  # Surfaces
  background: "#fafafb"         # the page
  card: "#ffffff"               # a surface sitting on it
  popover: "#ffffff"
  muted: "#f3f4f6"              # subtle fills, hover backgrounds, secondary surfaces
  disabled: "#f3f4f6"           # a disabled control's fill
  stage: "#e4e6ec"              # the annotator's surround — the neutral a picture is judged against
  # Text
  foreground: "#1b1d28"         # primary text
  muted-foreground: "#6b6e7e"   # secondary / meta text, inactive tabs
  disabled-foreground: "#a0a3b1"
  # Lines & focus
  border: "#e7e8ec"             # hairlines, dividers
  input: "#dcdde4"              # input and secondary-button borders — a step darker
  ring: "rgba(30, 33, 48, 0.35)"  # the action colour at 35%
  # Status — desaturated, to sit on a near-monochrome page
  success: "#2e7d5b"            # completed states
  warning: "#b98217"
  destructive: "#c93b3b"        # errors, destructive actions
  # Dark chrome (app rail / sidebar) — the same near-black as `primary`
  sidebar: "#1e2130"
  sidebar-accent: "#2a2d40"     # rail hover, and the ACTIVE rail item's fill
  sidebar-strong: "#161823"
  sidebar-muted: "#8b8fa3"      # inactive rail icons and labels
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

VisionSet's interface is **neutral-first, content-first, and accessible**. The screen is
almost monochrome — cool greys with a faint indigo undertone — and the colour a person can
act on is a **near-black** (`#1e2130`): filled buttons, the active tab's rule, the active
tool. A dark rail in that same near-black frames a bright content area.

**Robomous coral (`#e85d44`) is not the interface's colour.** It appears in exactly two
places (see *Where the brand is*, below), and everything else that used to wear it now
wears the near-black. The reasoning is in the token file and worth repeating here: an
interface whose every button is brand-coloured spends the brand on "Cancel". Making colour
scarce is what lets the two places it survives actually mean something.

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
3. **Content over chrome.** Subtle borders, minimal shadows, no gradients, quiet
   hover/focus effects. The interface is neutral; the brand is not a surface fill and is not
   an interaction colour at all. Whitespace is generous
   on forms and lists, where the content is a few things a person reads one at a time —
   and **is not a substitute for information**: see principle 7, which governs the
   surfaces whose content is a dataset.
4. **Accessible by default.** Real `<button>`/`<a>` elements, visible `focus-visible`
   rings, keyboard operability, and every async surface has loading / empty / error
   states (skeletons preserve layout; errors are destructive alerts with a recovery
   action; empty states are a centered card with a muted icon, title, and one primary
   action).
5. **Consistency beats novelty.** A new screen should be indistinguishable in styling
   from the existing ones.

**Added 2026-08-01 (#206)**, for the surfaces whose subject is a dataset rather than a form:

6. **Data first.** VisionSet is a dataset tool, and every project-level screen surfaces real
   data — counts, distributions, samples — before configuration. **The test: if a screen
   would render identically for an empty project and a 100k-image one, it is wrong.** The
   project view failed it for its whole life before #212, because it opened on a schema
   editor and a schema is the same document either way.
7. **Density over whitespace, on data surfaces.** Our users are ML engineers and
   professional annotators working with large ontologies — a fifty-class ontology is
   ordinary. Prefer compact lists, tables and two-panel layouts to spacious single-column
   forms. This does not license crowding: it licenses *showing more of the thing the user
   came for*, which is the same instinct as principle 3 applied to a screen whose content
   is plural.
8. **Action-forward.** Every major screen answers "what do I do next?" with exactly one
   primary CTA. On a project page that action is annotating.
9. **Never disable without explanation.** A button either stays enabled and answers with a
   message, or it carries an adjacent explanation of what would enable it, or it is not
   rendered at all. **A bare disabled grey button is forbidden** — it is a question the
   interface refuses to answer. #160 is the same bug from the other side: a control that
   rendered `disabled` because a callback was missing made the annotator unreachable, and
   nothing on screen said so.

## Colors

Map intent → token; never invent a value:

| Intent | Token |
|--------|-------|
| Primary action / active tool | `primary` (`#1e2130`), hover `primary-hover` |
| Active tab rule | `primary` — see **Tabs** below |
| Accent tint (chips, selected rows) | `primary` at 10% alpha, border `primary` |
| Page surface | `background` (`#fafafb`) |
| Card / popover surface | `card` / `popover` (`#ffffff`) |
| Subtle fill / hover / secondary surface | `muted` (`#f3f4f6`) |
| A disabled control | `disabled` fill, `disabled-foreground` ink, **no border** |
| The stage a picture sits on (annotator surround) | `stage` (`#e4e6ec`) |
| Primary text | `foreground` (`#1b1d28`) |
| Secondary / meta text, inactive tabs | `muted-foreground` (`#6b6e7e`) |
| Borders & dividers | `border` (`#e7e8ec`) |
| Input / secondary-button border | `input` (`#dcdde4`) |
| Focus ring | `ring` — the action colour at 35% |
| Completed / success | `success` (`#2e7d5b`) |
| Warning | `warning` (`#b98217`) |
| Errors / destructive | `destructive` (`#c93b3b`) |
| Dark rail chrome | `sidebar` (`#1e2130`); active item `sidebar-accent` + white; the rest `sidebar-muted` |
| The brand | `brand` (`#e85d44`) — **two sites only**, below |

The palette is defined for light mode; dark mode is a post-beta concern.

### Where the brand is

Coral appears in the product in exactly two places, and adding a third is a design
decision rather than a styling one — raise it in review, do not put it in a diff:

1. **The wordmark** in the rail (`frontend/app/src/shell/AppShell.tsx`).
2. **The ingest progress bar's fill** (`Progress` in `frontend/ui-core/src/primitives/Feedback.tsx`).

A progress bar is the one piece of chrome a person watches rather than reads, which is
where the coral buys attention instead of spending it. The styleguide shows a `brand`
swatch as well — a styleguide is where a value is inspected, not where it is used.

To check the invariant:

```
git grep -nE '\b(bg|text|border|ring|fill|stroke)-brand\b' -- frontend
```

Three hits is the expected state: the two above, plus the styleguide swatch.

### One filled button per view

Principle 8 says a screen answers "what do I do next?" with exactly one primary CTA. With
a near-black primary the rule is *visual* as well as structural: a filled button is now the
loudest thing on a grey page, so two of them compete far more than two coral ones did.
Sibling actions are the outlined `secondary` variant — `card` fill, `input` border,
`foreground` ink. A row action inside a table is per-row, never the view's forward action,
so those are `secondary` too.

The known exceptions, all legitimate: a modal `Dialog`'s confirm button (it overlays the
page, so it is its own view), and the steps of the ingest stepper (only the active step
renders).

### Success and the exception that no longer exists

`success` (`#2e7d5b`) is a real token as of #323. v1's documented exception — a hardcoded
`text-green-600` for the "saved" indicator — is retired with it: there is no longer a
sanctioned hardcoded colour anywhere in the frontend, and `design_tokens.test.mjs` was
already refusing one.

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

## Navigation rules

VisionSet is an **application**, not a website. Somebody who walks into a sub-view has
to be able to walk back out of it *from the screen*, without reaching for the browser
and without knowing the URL scheme. Before **#199** five of the six sub-views offered
nothing at all and the sixth offered history, so this section exists to keep the rule
from being rediscovered one screen at a time.

- **Every sub-view declares a parent, and the back affordance goes there
  structurally.** `navigate(-1)` is not a parent: it means the gallery when you
  clicked a tile, nothing at all on a fresh tab, and one asset at a time after
  walking forward through a job. The destination has to be the same however the page
  was reached — clicked through, pasted, reloaded, or walked forward from a sibling.
  The parents live in one `PARENT` table in `app/src/routes.tsx`, because a parent is
  a fact about the route table and `ui-core` deliberately has no router.
- **The affordance names its destination.** "Back" alone is a promise about history;
  "Projects", or a project's own name, is a promise about structure — the one the
  control can keep. A name that has not loaded yet falls back to the noun
  (`parentLabel`) rather than to nothing, so the control does not change width under
  a cursor that is already aiming at it.
- **Placement follows the pane.** On a padded page it is `patterns/BackLink.tsx`
  directly above the page header: meta-size, muted, a 14px `ArrowLeft`, pulled left
  by the gutter (`-ml-1`) so its text aligns with the `<h1>` beneath it. On the
  full-bleed editor it is the first control in the 44px top bar, as a 36px ghost icon
  button — the shape that bar is already built from.
- **A screen takes it as an optional callback, never a route.** The same rule every
  forward edge follows: `ui-core` may not import a router, so a host that has nowhere
  to send anybody renders no control rather than a dead one.
- **The rail is for top-level destinations only.** Per-screen return navigation never
  lives on it — that is what lets it name where it goes, and what keeps the rail the
  four things `## Layout` gives it.
- **The browser's Back button stays correct, and is never the only way out.** Nothing
  here replaces it; a `replace` navigation is still right where a change is a view of
  the same resource rather than a place (#171's tabs).
- **Two controls may share one destination when they mean different things.** The
  annotation page's arrow means *up* and its grid button means *show me the grid*;
  they coincide because the annotator's parent is the grid. That is not redundancy,
  and the top bar below draws both.
- **Not everything selectable is a place.** A tab is in the query string (#171)
  because somebody links to it and returns to it; the schema version somebody is
  glancing at (#232) is component state, because it is a lens on the tab they are
  already in. The test is whether the thing survives being pasted to a colleague as
  a destination — if the answer is "they would want the current one instead", it is
  view state and the URL should not carry it. Getting this wrong in the other
  direction is worse than it looks: `ui-core` has no router, so every URL-borne
  choice has to be threaded through the host as a prop and a callback.

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

**The space between a tab bar and its content belongs to `TabsContent`, and to nothing
else.** It is `mt-3` (12px), one declaration, for both variants — and a consumer must
not add a gap of its own. `AnnotatorPanel` wrapped this margin in a `flex flex-col
gap-3` and the two added, floating the tabs 24px above the panel they switch (**#188**).
The primitive owns it rather than the consumers because that is the direction nobody can
forget: a `Tabs` which is not a flex column at all still spaces correctly. Asserted by
measurement — the styleguide's two specimens and both real screens — rather than by a
class string, since a class assertion would have seen both rules and been satisfied.

**The active underline is `primary`**, the same near-black as a filled button, so the
section you are in looks like the rest of the interface rather than like an advertisement.
The active label is `foreground` at the base `font-medium`; inactive labels are
`muted-foreground`. There is deliberately **no extra weight bump** on the active tab —
colour and the rule already carry it, and a second signal reflows the row's metrics for
nothing. (Two earlier `Tabs.tsx` docstrings argued over whether this rule could be orange.
#323 settled it by removing the orange: `primary` is not the brand any more.)

Focus is **not** styled per variant: `styles.css`'s base layer gives every
`:focus-visible` element a 2px `ring` outline, and an outline is painted outside the box,
so it never depended on the segmented chip's fill. The underline variant adds
`focus-visible:bg-muted` only so the ring encloses a fill rather than the page.

## Project surfaces

The project view is the face of a project, and principle 6 is the rule it kept failing: it
opened on the schema editor, which is configuration, and a schema renders the same for a
project with nothing in it and a project with a hundred thousand images. This section is
what #207–#213 build against.

### The project header

Four lines and two buttons, in this order:

1. The back affordance (`← Projects`), per **Navigation rules**.
2. The project name, at the page-title role.
3. The description **if there is one**. If there is not, render *nothing* — the string "No
   description." spends a line telling somebody about a field rather than about their
   project, which is principle 6 in miniature.
4. Metadata chips, left to right: task type, sensor modality, active schema version
   (`v1 active`), last ingest (`Ingested 2d ago`).

**A chip with no data is omitted, never rendered as a placeholder.** Half of these have no
source on the wire today — `ProjectOut` carries `id`, `name` and `description` — so a
project shows the chips that can be answered and no others. Inventing a field to fill a
chip, or rendering `Unknown`, is the "No description." mistake with a border around it.

Actions are right-aligned: one **primary CTA**, one **secondary**, and an overflow menu
(`⋯`) for the rest. Never more than two visible buttons plus the overflow. On the project
page the primary is **Annotate**, because principle 8 asks what the user came to do and the
answer is never "rename this".

### Numbers

- Stat values use **tabular figures** (`font-variant-numeric: tabular-nums`), so a number
  that updates does not shift the ones beside it.
- Counts ≥ 1000 carry locale-aware thousands separators. One shared helper, not a call-site
  decision — `6431` and `6,431` appearing on the same screen is how that goes wrong.
- Relative times under 7 days (`2d ago`), absolute beyond (`Jan 14, 2026`).
- A percentage derived from a zero denominator is `0`, never `NaN` and never hidden.

### Versioning is ambient, not modal

Schema version state is a **persistent status line** — `Version 1 active · unsaved changes
create v2` — and not a tooltip, a dialog, or a disabled save button. The user should never
have to press something to discover what pressing it would do.

Its corollary, from principle 9: **Save version is always enabled.** Pressing it with no
changes shows a toast and issues no request. The editor it replaces rendered a permanently
grey button on a project with nothing to save, which told the user their schema was broken.

### Destructive actions state their blast radius

A confirmation dialog names what will be destroyed, counted: *"Deletes the class and 4,372
annotations across 3 versions."* A dialog that asks "are you sure?" without saying what
`yes` costs is not a confirmation, it is a speed bump. Where the count cannot be obtained
accurately, the action does not ship with a dialog that guesses.

### Components

Presentational contracts, all in `ui-core`, all data-only — no fetching, no router:

| component | contract |
|---|---|
| `StatCard` | muted meta-size label above a large value, tinted surface, **no border**. Used in grids of 3–4. Optional context line under the value. |
| `DistributionBar` | one row of a bar chart: swatch · fixed-width label · proportional bar in the class colour · right-aligned count. **All bars in one chart share a single max-value scale.** |
| `ClassListRow` | swatch + name + a `geometry · count` secondary line. Selected = tinted background + 2px left accent rule. The whole row is the click target, and it is a real `<button>`. |
| `EmptyState` | icon + a headline naming the space + one line of body + a verb-first CTA. Never a bare "No items". |
| `ThumbnailGrid` | square tiles, 6px gap, `sm` radius. The last tile becomes a `+N` overflow linking onward. Missing thumbnails show a photo icon on `muted` — **never a broken-image glyph**. |
| Chip | `primitives/Badge.tsx`, which already is one. It gains variants; it is not reimplemented. |

**Class colour is data, not chrome.** It appears as a small swatch or a thin bar and never
floods a card or a row — that is the accent rule (principle 3) applied to a colour the
*kernel* chose. The single derivation lives in `frontend/ui-core/src/palette.ts`
(`classColor`, schema colour first, else a name hash); a second path is what #162 was.

### Lists and filtering

Any list that can exceed ~20 rows carries a filter input. Filtering is client-side and
instant, matches a name substring case-insensitively, and never hides the count of what it
filtered out.

### Copy

- No exclamation marks. No "successfully". No "please".
- An error is **what happened plus what to do**, one sentence each. The API's error contract
  already separates the two (`docs/api.md`); the UI does not merge them back together.
- An empty state is an **invitation**, not an apology: "Ingest your first batch to see stats
  here", never "Nothing here yet".
- Sentence case everywhere — buttons, tabs, labels, headings. "Add class", not "Add Class".

## The annotation workspace

The page the reference design shows (#56), with measurements verified in v1's source:

- **Top bar** (`AnnotationToolHeader` in v1): one 44px (`h-11`) row on `card` with a
  `border-b`, 32px (`h-8`) controls, `h-5 w-px` divider between groups. Left to right:
  back · project name + date in muted text with `·` separators at 40% opacity · asset
  navigator `‹ filename n/m ›` · grid jump · class field · save-state indicator
  ("Saving…" pulsing meta text / "Saved" green check, shown ~3s / error in destructive
  with an underlined Retry) · **Save** (primary, Save icon) · **Accept** (CheckCheck) ·
  `n / m annotated` · zoom out / percent / zoom in · fullscreen (Maximize2) · help.

  The reference draws three more controls between the navigator and the save state —
  version select (GitBranch), create-branch (GitBranchPlus) and **Merge** (GitMerge).
  **They are not rendered**, because the model they operate does not exist: annotation
  versioning is #127, post-beta and blocked on a decision. They were drawn disabled
  until 2026-08-05 to hold the design's shape, which principle 9 forbids — the only
  honest tooltip for them is "this feature does not exist", and that is not an
  explanation of what would enable the button. They return with the model, not before.
- **Tool strip**: floating at the canvas's left edge — 48px (`w-12`) column, `muted`
  surface, `border`, 12px radius, 8px padding; 36px icon buttons; **active tool = primary
  variant** (the near-black), inactive = ghost; a `h-px w-6` divider; help at the bottom.
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

### The canvas surround

The area around the asset is **`stage`** (`#e1e6eb`), never `muted` and never a dark
surface (#185). It is a role of its own for two reasons. A dark surround shifts the
perceived contrast and colour of the photograph inside it, which is a real cost on a
tool whose whole job is looking closely at pixels — and it was also the only dark
surface in the product outside the rail, so the one screen somebody sits in front of
for an hour read as a different application.

It must stay distinguishable from `background` as well as from the image: an asset
with white borders has to show where it ends. That rules out `background`, `card` and
`muted`, whose closest channel is five short of white; `stage` clears the same
measurement by twenty, and `e2e/annotate.spec.ts` asserts the gap rather than the hex.

**The rail keeps its dark treatment.** This is not a theme change.

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
#127 and are post-beta. Their top-bar slots were removed on 2026-08-05: this record is
what re-milestoned #127 out of 0.1.0, and a disabled control whose only explanation is
"this does not exist yet" is the thing principle 9 names.

**2026-08-01 (#206)** added principles 6–9, the whole of **Project surfaces**, and the
qualification to principle 3, ahead of the project view redesign (#207–#213).

That brief also specified a **second type scale** — 1200px content width, 20px page title,
13px body, and "two weights only, no 500" — and it was **deliberately not adopted**. The
shipped scale is 14px base, a 1.5rem title, `max-w-7xl`, and a 500-weight label role, and it
is not prose: `styles.css` carries it as Tailwind `@theme` tokens, `tokens.ts` mirrors it,
`tokens.test.ts` gates the two against each other in both directions, and
`design_tokens.test.mjs` fails the build on a hardcoded colour. Adopting the other scale
meant retuning the tokens and restyling every shipped screen — projects, gallery, dataset,
ingest, batches, and the annotator — in order to change a page that had not been built yet.

So the new **rules** landed on the existing **values**. Nothing in this revision changes a
token, a size, or a weight. Recorded here rather than in a merged pull request body, because
the next person to read the brief will find the same conflict and deserves the answer.
