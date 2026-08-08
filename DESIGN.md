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
10. **The annotation workspace is self-sufficient.** No flow may force navigation out of
   the editor, and no exit may lose work. Back saves first, the way the asset navigator
   already did; a class the schema lacks is created from the class field without leaving
   the page; **looking at the job's other frames is an overlay, not an exit** (#390 — the
   grid button opens a gallery over the workspace and the URL does not move). Ratified
   2026-08-05 (#368) and **immovable**: this is the one screen somebody sits in for an
   hour, and every trip out of it is a trip back through a list, a tab and a scroll
   position to the frame they were looking at. The grid jump was listed here as a
   sanctioned *exit* until #390; that was the principle's own example failing it, since
   choosing the next frame is a flow **inside** annotating rather than a reason to leave.

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

**The rule is a count, so it is tested as one — in both directions.** A test asserting that
*the* CTA is present, or that a sibling is `secondary`, passes just as happily with two
filled buttons on the page; that is the defect #388 was filed for. The enforcement pattern
is a document-wide sweep — collect every `button.bg-primary` and assert the whole set — which
catches the zero-filled case as well: an invitation whose destination does not exist, beside
a header that stood back for it, leaves the view answering "what do I do next?" with nothing.
Both failures are the same rule violated, counted from opposite sides.

### Status colour

**A status picks an intent, never a colour**, and the intent comes from the three semantic
tokens above plus neutral. One mapping, product-wide (#391) — before it, the same five
per-asset states were drawn in three private vocabularies, so `accepted` was green in the
annotator and near-black in the gallery, and a *skipped* frame was painted `destructive`.

| Family | Token |
|---|---|
| Done, settled, succeeded — `annotated`, `accepted`, batch `completed`, ingest `completed`, export `succeeded` | `success` |
| Waiting on a person — `review_pending` | `warning` |
| Failed — ingest `failed`, export `failed`, a corrupt file, a refusal | `destructive` |
| Nothing has happened, or a decision was taken and nothing is wrong — `unannotated`, `skipped`, batch `draft`, export `queued`/`cancelled` | neutral |
| Work is in flight — batch `in_annotation`, ingest `running`, export `running` | `primary` (the near-black action colour) |

Three rules follow from it, and each was a real defect before it was a rule:

1. **`destructive` is for errors only.** A `skipped` frame and a `cancelled` export are
   *decisions*; painting them red tells somebody who chose an outcome that it went wrong.
2. **`warning` means one thing: something is waiting on a person.** It is not "in
   progress" — work in flight is the healthy majority state, and colouring the majority
   state amber makes a list of ordinary work read as a list of problems.
3. **"Finished" has one colour.** A completed batch and a completed ingest run are the same
   fact about two nouns; they read `outline` and `success` respectively until #391.

**The word always rides with the colour.** Colour alone is never a status — the badge
carries its label, the dot carries the word beside it, and where a dot has no room the
accessible name and the tooltip carry it (`● annotated · Saved`). A second non-colour
channel exists on the per-asset dot as well: `filled` / `ring` / `hollow` / `muted` says how
far along a frame is, so the vocabulary survives a monochrome screen.

The single spelling for the per-asset states is `frontend/ui-core/src/screens/batchState.ts`
(`PROGRESS_TONE`, `progressDotClass`, `progressCellClass`). Every other family writes its
own small map beside its own labels, typed against the shared `BadgeTone` union — so a
sixth colour is a compile error rather than a diff nobody notices.

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
- **A control that means "show me more of what I am already in" does not navigate.**
  The annotation page's arrow means *up*: it exits to the batch, saving first, and
  that is legitimate. Its grid button means *switch frames*, which is the `‹` / `›`
  navigator with pictures — so it opens a **gallery overlay inside the editor** and
  the URL does not move (#390). The two used to share a destination on the reasoning
  that the annotator's parent *is* the grid; the coincidence was real and the
  conclusion was wrong, because going up and looking at your own frames are
  different intentions and only one of them is a reason to leave. The overlay is a
  switcher and nothing else: no batch actions, no selection, no route change. The
  batch view stays the home of batch operations.
- **Not everything selectable is a place.** A tab is in the query string (#171)
  because somebody links to it and returns to it; the schema version somebody is
  glancing at (#232) is component state, because it is a lens on the tab they are
  already in. The test is whether the thing survives being pasted to a colleague as
  a destination — if the answer is "they would want the current one instead", it is
  view state and the URL should not carry it. Getting this wrong in the other
  direction is worse than it looks: `ui-core` has no router, so every URL-borne
  choice has to be threaded through the host as a prop and a callback.

## Tabs

**One shape** (`primitives/Tabs.tsx`) — page sections, GitHub's repository nav. A row on a
full-width `border` hairline; the active tab carries a **2px `primary` rule sitting on
that hairline** plus `foreground` text; an inactive tab carries no border, no fill and no
shadow, and gets a `muted` background on hover or focus. The inactive tab keeps the same
2px border at `transparent`, so selecting one does not shift the row.

There used to be two, chosen by a `variant` on `TabsList` which every trigger inherited.
**#182** made this one the default: the original was a segmented control, and on the
project view that put three pressed-looking buttons directly under the page's real
buttons. **#368** removed the other — `segmented`, the annotation panel's
**Objects | Labels** switch — along with the switch itself, when class selection moved to
the top bar and the panel became one Annotations view. With one caller gone there was no
second shape, so the `variant` prop, the context that carried it and the `data-variant`
attribute went too: three pieces of machinery describing a choice nobody has.

**The space between a tab bar and its content belongs to `TabsContent`, and to nothing
else.** It is `mt-3` (12px), one declaration — and a consumer must not add a gap of its
own. `AnnotatorPanel` wrapped this margin in a `flex flex-col gap-3` and the two added,
floating the tabs 24px above the panel they switch (**#188**). The primitive owns it
rather than the consumers because that is the direction nobody can forget: a `Tabs` which
is not a flex column at all still spaces correctly. Asserted by measurement — the
styleguide specimen and the project view — rather than by a class string, since a class
assertion would have seen both rules and been satisfied.

**The active underline is `primary`**, the same near-black as a filled button, so the
section you are in looks like the rest of the interface rather than like an advertisement.
The active label is `foreground` at the base `font-medium`; inactive labels are
`muted-foreground`. There is deliberately **no extra weight bump** on the active tab —
colour and the rule already carry it, and a second signal reflows the row's metrics for
nothing. (Two earlier `Tabs.tsx` docstrings argued over whether this rule could be orange.
#323 settled it by removing the orange: `primary` is not the brand any more.)

Focus is **not** styled here at all: `styles.css`'s base layer gives every
`:focus-visible` element a 2px `ring` outline, and an outline is painted outside the box,
so it never depended on the segmented chip's fill. The trigger adds
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

### The first run

**The Overview's first-run region is driven by the project's state, and renders exactly one
invitation.** No classes and no images invites the classes (with the other order named
beneath it as prose, because both are legitimate); classes and no images invites the ingest;
images and no classes invites the classes again and says annotation opens from the first
approved batch; a project with both gets no invitation and is the dashboard. **It guides and
never gates** — Ingest and Schema stay independently reachable throughout, and where the
invitation holds the page's one filled button the header steps its own Ingest back to
`secondary`.

**The four-station onboarding checklist is retired (2026-08-07, #388), reversing #289.** It
was not made smarter or better-sequenced: a project three seconds old showed three
invitations at once — a filled header Ingest, a checklist whose active step said *labels*,
and an outlined Ingest in the empty state — so whichever a person followed, the page was
also telling them to do something else. Dismissibility was the answer to "onboarding a
person has read is noise"; it is not an answer to a contradiction met before there is
anything to dismiss. The road is the tab bar.

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

**A geometry picker groups its options by category, and the category is presentation only**
(#375, 2026-08-07) — the kernel takes no category concept, because "Robotics and AD" is a
market segment and the domain does not hold one. The single map is
`frontend/ui-core/src/data/geometryCategory.ts`, declared total over the generated
`GeometryType` union so an uncategorised geometry fails the build rather than falling
quietly out of a list; headings are non-selectable `SelectLabel`s and a category with
nothing under it renders none.

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

- **Top bar**: one 44px (`h-11`) row on `card` with a `border-b`, 32px (`h-8`) controls,
  in **three zones** since #368, regrouped by #416 — *where you are*, *what changes the
  frame*, *the session*.

  | Zone | Contents |
  | --- | --- |
  | Left | back · pinned `v{n}` badge · the frame's identity as a label (the content-hash head — there is no filename on the wire) · the frame microtext `● annotated · Saved` |
  | Centre | the **navigation cluster**: `[⊞] [‹] n/m [›] │ [Skip] [Save and next]` |
  | Right | `n / m annotated` · **Save and stay** (ghost, ⌘S) · the review move (outline) · overflow `⋯` |

  **Everything that changes the picture on screen is in the centre cluster, and nothing
  else is** (#416). The gallery and `‹` `›` used to sit at the far left beside the back
  arrow, and **Skip** and **Save and next** at the far right beside the overflow: two
  motion clusters at opposite ends of a 44px row, same destination, different meanings,
  with nothing on screen to say which was which. Adjacency is the explanation. One
  `h-5 w-px` divider separates the two sub-groups — **browse | resolve** — so the
  difference between *look at another frame* and *finish this one* is a hairline rather
  than something learned.

  **The class field is not on the bar** (#420). #368 put it here and #416 gave it a 192px
  reservation in the middle of the cluster; it is a list in the side panel now, and the
  bar is navigation only. The width it gives back is what pays for the right zone's two
  controls being visible buttons again at every supported width.

  `‹` `›` **browse**: they move without settling progress, under the same save-first
  guard back and the gallery use. `n/m` renders between them in `tabular-nums`, so
  walking a job does not shuffle the arrows under a cursor that has not moved.

  **The centre is anchored on the bar's geometric centre**, not balanced between two flex
  spacers: the header is a `1fr auto 1fr` grid, the two flexible tracks take an equal
  share of what is left by definition, and the side tracks yield — a label truncates,
  never a control. Two widths inside the cluster are pinned so it is the same size on
  every frame: the resolution pair's `min-w-27` (`Skip` is 104px and `Un-skip` 96px) and
  the flow verb's `min-w-36`, the widest of `Next` / `Save and next` / `Finish job` /
  `Finished`. The cluster's controls therefore hold one screen position through every
  frame state.

  **Equal halves is what a centred bar costs, and the right zone is the heavier side.**
  It is measured, not reasoned about. With the class field on the bar, chromium at 1440
  gave left 290px, cluster 616px, right 460px — each side offered 382px against a right
  wanting 460, so #416 had to send the two reabsorbable controls to the overflow one
  breakpoint early. With the field in the side panel (#420) the cluster is **423px** and
  each side is offered **462px** against the same 460px of demand, so both breakpoints are
  back where they were. It clears by a pixel, which is why the readout that gives way is a
  readout: `n / m annotated` truncates, and no button is ever clipped.

  **The filled slot is the flow verb** (#383). After finishing a frame the right move is
  *this one is done, show me the next* — and until #383 that had no button at all: the
  navigator's `›` is chrome rather than a verb, so **Skip** was the most prominent thing
  to press on a frame somebody had just annotated. **Skip and Save and next are
  siblings** — two ways to resolve this frame, skipped or annotated, both advancing — and
  neither ever collapses into the overflow.

  `Save and next` is `go(1)`: the same save-first advance the navigator has always used,
  so there is one save pipeline and one place principle 10 is enforced. It reads **`Next`
  when no save will happen** — an untouched frame, or one that cannot be written to at
  all — because the button never promises a save it will not perform.

  **On the last frame `Finish job` takes the filled slot**, in place: `Save and next` is
  not rendered there, and Finish job is not rendered anywhere else (#416). There is
  nothing to advance to, and finishing is what the job is for. It used to render on every
  frame, greyed with nothing attached for as long as one frame was unannotated — a bare
  disabled control at 0 of 48, which principle 9 forbids. Where it does render it carries
  why it cannot be pressed. The filled slot is therefore contended by nothing — which
  frame you are on is this page's own arithmetic, not a declaration anything else can
  co-claim — and the consequence is worth stating: `complete` is reachable from the last
  frame only.

  **The review move is an outline control**, chosen from the frame's own
  `allowed_actions`: `submit_for_review`, else `accept`. The two are mutually exclusive by
  construction — the kernel offers the first only from `annotated` and the second only
  from `review_pending`. **`complete` is deliberately not in that list**: it is the
  *job's* action, and it co-declares with `submit_for_review` on the commonest path there
  is (an annotated frame in a job whose every frame is settled), so ranking them against
  each other would hide Finish job exactly where most jobs end. Submitting carries a
  tooltip saying what it means, because this product has **no annotator identity**
  (cf. #282) — a submitted frame is marked for a review pass, not routed to a person.

  **Save is a ghost button again** (#383). #368 removed it on the grounds that it
  duplicated an automatic behaviour — ⌘S saves, navigating saves, settling saves — and
  dogfooding showed what that missed: the chord is invisible, and the overflow put the one
  press meaning *store this now, without going anywhere* two clicks from the work. Ghost
  is the honest weight for a control most people never need.

  **Reabsorption order when the bar runs out of room**: `Save and stay` first (below
  `xl`), the review move second (below `lg`), into the overflow; the Skip/Save-and-next
  pair never collapses. Each reabsorbed control carries the exact inverse of its button's
  breakpoint, so it exists in exactly one place at any width. The `n / m annotated`
  readout has no overflow row and needs none — it truncates, which is what a sentence may
  do and a button may not.

  **Hotkey chips go on the ghost and outline controls and on nothing else** — `⌘S` on
  Save and stay, `X` on Skip, both rows in `core/input/bindings.ts`. A chip is a muted
  box on a bordered ground, which is a *lighter-than-the-surface* treatment: on the one
  filled control it inverts into a dark box inside a dark button and reads as a smudge
  rather than as a key, so the flow verb carries none (#385). Its chord is not the loser
  — `enter` is the one key with two meanings, the polygon ring close while a shape is in
  progress and *finish the frame* otherwise, and both are in the shortcut sheet, which
  derives its rows from the live registry rather than from a hand-written table.

  The frame microtext replaces the dot-with-a-tooltip: the word is on the bar beside the
  save state, because **status is never colour alone** and a tooltip is a place a word
  goes to not be read.

  The reference draws three more controls between the navigator and the save state —
  version select (GitBranch), create-branch (GitBranchPlus) and **Merge** (GitMerge).
  **They are not rendered**, because the model they operate does not exist: annotation
  versioning is #127, post-beta and blocked on a decision. They were drawn disabled
  until 2026-08-05 to hold the design's shape, which principle 9 forbids — the only
  honest tooltip for them is "this feature does not exist", and that is not an
  explanation of what would enable the button. They return with the model, not before.
- **Classes region** (#368 as a top-bar field, #420 as the panel's upper region): where
  class selection lives. It was the side panel's Labels tab, then a `Combobox` in the
  centre of the top bar, and it is a **list** now — because what is being chosen between
  is the ontology, and a picker keeps all of it one click away, so the answer to *what can
  I draw here* was never on screen. Rows carry swatch · name · geometry · hotkey badge, in
  the **schema's authored order and only that**: a persistent list that reordered itself
  by recency would move rows under the cursor, and the digits are schema positions, so a
  recency-ordered list would print `3` against the row sitting first. `c` focuses its
  filter, Enter takes the first match, digits 1–9 activate directly, and the derived tool
  follows the class as it always has. When nothing matches what was typed the last row is
  `Create class "<text>"`, which opens the add-a-class dialog on that name; an empty schema
  renders an invitation instead of an empty list. **It shows the drawing class and never
  follows the selection** — re-classing an existing annotation is an object row's menu, a
  different question about a different object. On a frame nothing can be drawn on the list
  still renders — which classes exist stays true there — with every row disabled *and
  carrying why*, which is principle 9 rather than a grey box.

  **The drawing class's lifetime is the job**, not the frame: it survives moving to the
  next asset, because somebody labelling one class across a clip picks it once, and it
  survives a re-pin, which is what makes "you are drawing with the class you just made"
  a promise the page can keep. It stops at the job's edge, the same scope the clipboard
  has (#123) and for the same reason — a paste and a drawing class both belong to one
  pinned schema.
- **Pinned version badge** (#229, made an answer by #368): `v{n}` in the left zone names
  the version *this batch is judged against* — not the project's active one, since #229
  made the pin movable. Pressing it opens a small panel that says whether that is still
  the current version and, when it is not, **what arrived since**, in the kernel's own
  words for the change. Nothing about the active version is fetched until it is opened:
  the editor is judged against the pin, and a page that read the active version on
  arrival would be one refactor from offering classes the API then refuses. A hand-built
  disclosure rather than a Popover, for the `Combobox`'s reason — the annotator reads the
  keyboard off its own root, so focus has to come back to the canvas.
- **Add-a-class dialog** (#233, made a session by #368): **one sitting is one published
  schema version.** `Create and add another` (⌘↵) banks the class and clears the form;
  the primary publishes everything banked plus whatever is still in the form, so nobody
  has to press *and another* before finishing. The banked classes show as chips that can
  be taken back out, the auto-written description names them all, and the primary says
  how many it will publish (`Add 3 classes`). Opened from the class list's create row it
  starts on the name that was typed; opened from the tool strip's `+` or the region's own
  `+` it starts empty,
  because that press means "I want a class", not a particular one. When it lands, the
  **last** class written becomes the drawing class and a toast says so — a session
  publishes one version and arms one class, neither of which anybody watched happen.
  Cancelling with classes banked **asks**, and it asks on Escape and the overlay too:
  everything a session holds lives in the browser, so closing loses exactly what was
  typed and nothing else. It is the only question this dialog asks. What did not change:
  the save-then-publish-then-repin order, the `canRepin` preflight that says *before* the
  press when a completed batch will keep its version, and the refusal that names the
  Schema tab when somebody else narrowed the schema past the pin.
- **Version history grouping** (#368): the project's Schema tab ends in a ledger of every
  version. Since the annotator publishes versions too, a flat table buries the curated
  milestones somebody opened it to read under a run of `Added class "cone" from the
  annotation view`. So **consecutive versions whose `provenance` is `annotation` collapse
  into one expandable row** — `v3–v5`, how many, when the run ended, and the contract it
  left behind — while `curated` and a null from before the field existed always render
  individually. A run of one is not a run: collapsing a single version saves no space and
  makes the commonest case the least readable. Expanding gives back exactly the rows a
  flat table would have had, indented.
- **Tool strip**: floating at the canvas's left edge — 48px (`w-12`) column, `muted`
  surface, `border`, 12px radius, 8px padding; 36px icon buttons; **active tool = primary
  variant** (the near-black), inactive = ghost; a `h-px w-6` divider; help at the bottom.
  Tooltips open right with the shortcut ("Select (V)", "Box (B)", "Polygon (P)").
  Icons: MousePointer2 / Square / Spline; only tools the schema's geometries allow.
  Below a second divider, **undo and redo** (#368): the chords have worked since #46 and
  had no representation on screen at all, so the annotator's headline capability over v1
  was invisible to anybody who did not already know it. Disabled *with the reason*
  (`Nothing to undo`) rather than hidden, because an empty history is a state a person is
  in constantly — every freshly opened frame — and a control that vanished and reappeared
  as they worked would be worse than one that explains itself.
- **Side panel** (#126, reshaped by #368, split in two by #420): 288px (`w-72`) column,
  `muted` surface, `border`, 12px radius. **Two stacked regions, no tabs and no
  splitter.** It was Objects | Labels tabs until #368, which sent class selection to the
  top bar; #420 brings it back and deliberately does not bring the tabs with it. A tab is
  a claim that two things are alternatives, and these are the two halves of one question —
  *what may I draw* and *what have I drawn* — so both are on screen at once.

  **Classes (upper).** Header — the word `Classes`, the class count in muted meta, and a
  24px `+` opening the add-a-class dialog; then a 32px `Filter classes…` input; then the
  rows described under **Classes region** above. Its height is **content-driven and stated
  in rows**: a floor of 3 rows' worth, one row per class after that, a ceiling of 8, after
  which the region is fixed and the list scrolls inside it. A small ontology gets a region
  proportional to what it holds; a large one cannot push the objects region off the bottom.
  The count it is computed from is the **schema's**, never the filtered one — a height
  that tracked the filter would reflow the region below it on every keystroke. The header
  and the filter are not rows and do not scroll away.

  **Annotations (lower).** Takes all remaining height and scrolls independently. Top to
  bottom: **header** (the word `Annotations`, the object count in muted meta text, the
  all-visibility toggle); the **tag chip strip**, rendered only when the pinned schema
  declares a `classification_tag` class — rounded-full chips carrying swatch, name and
  either the hotkey digit or a check; the **filter**, a 32px input that is *always*
  rendered, because a control that appears once a list is long enough is a control nobody
  finds; then the **object rows**: `rounded-md border px-1.5 py-1`, meta-size text
  `N. class`; **selected = `border-primary` + `bg-primary/10`**; hidden = 50% opacity;
  per-row tag, eye and trash as 24px ghost icon buttons.

  The split between them is a **1px rule, not a handle**. The classes region decides its
  own height by the rule above and the objects region takes the rest; a draggable splitter
  would add a third piece of per-user state to a surface whose whole value is being the
  same on every frame. The two regions' selected treatments are deliberately different —
  a class row is a left accent rule plus a tint, an object row is a full border — because
  they are selections of different kinds of thing and a person reads both at once.
  **The number is draw order and filtering does not renumber it** — it is the object's
  identity on the canvas, and a panel that renumbered as somebody typed would disagree
  with the picture about which shape is "3".
  The per-row **tag icon** opens class reassignment: every class the schema declares, with
  the ones whose geometry does not match this annotation disabled and **carrying the
  reason** (`needs a polygon`). Listed-and-refused rather than filtered out, which is what
  shipped before: a short list with no explanation reads as a schema missing its classes,
  and the rule — the kernel judges geometry per class — is invisible exactly when somebody
  is hunting for the class that is not there. Applied on selection, not behind an Apply: a
  menu commits on Enter or a click, so there is no per-keystroke state to keep out of the
  undo history. Each item that *can* be picked shows its **class hotkey**, and pressing
  that digit while the menu is open reassigns; a disabled item spends the same slot on
  the reason instead, because a key chip on a row that refuses the key is a lie.
- **Class picker, second anchor** (#380): the same menu, on the shape. With exactly one
  shape selected a 24px tag button rides **above its top-right corner** — above rather
  than on it, because that corner belongs to the resize grip — and a **right-click on the
  shape** opens it there too, selecting the shape on the way. Same component, so the class
  list, the disabled-with-reason rendering, the hotkeys and the apply are one spelling and
  cannot drift between the two anchors; the panel row keeps its own. It is **absent**, not
  disabled, when the frame is read-only, when nothing or more than one thing is selected,
  and for a classification tag, which the canvas draws nowhere.
- **Frame gallery** (#390): the grid button opens the job's frames as a thumbnail
  overlay over the workspace — the `ThumbnailGrid` pattern, square tiles with the
  photo-icon fallback, each carrying its frame number and its status dot in the
  status tokens above, with the **word** in the tile's accessible name and tooltip
  because a tile has no room for prose. The current frame is marked (`border-primary`
  + `bg-primary/10`) and takes the focus on open, which is also what scrolls it into
  view. Above the grid, the batch view's own four-segment filter
  (`All / Unannotated / In review / Done`), counted over *this job's* frames.
  **One press opens a frame** — no select-then-open — through the same save-first
  path `‹` / `›` use, so a refused save keeps the work and the frame. Escape or the
  scrim returns to exactly the frame, zoom, pan and armed class that were there.
  **No batch actions of any kind**: no approve, no promote, no selection, no bulk
  bar. It is a switcher.
- **Zoom widget**: floating **bottom-right of the stage** since #368, opposite the tool
  strip and sharing its chrome — `− / readout / + / fit / fullscreen`. It was in the top
  bar, which said something false about it: a workflow action changes the work, zoom
  changes only how the work is being looked at. Fullscreen is requested on the **stage**
  element rather than on the document, so the tool strip and the widget go with it, and
  it is **absent rather than disabled** where the browser has no Fullscreen API — unlike
  a capability the wire withholds, there is no state a person could change to get it.
  **5%–800%**, percent readout between the −/+ buttons, showing the capped value
  exactly at each end. The floor is not v1's 30%: an 8K frame does not *fit* a laptop pane
  above about 18%, so a 30% floor makes "zoom out until you can see the whole thing"
  unreachable (`MIN_ZOOM`, since #49). The ceiling is 8x, where one asset pixel is an
  eight-pixel block and the picture has nothing further to show (#228); above 4x the image
  renders `image-rendering: pixelated`, so depth shows real pixel blocks rather than
  interpolated blur. Both bounds are **disabled with the reason** per principle 9 — the
  `−`/`+` carry `aria-disabled` and a tooltip naming the limit, never a press that silently
  does nothing. `docs/annotations.md` carries the argument.

### The read-only mode

The workspace opens as a **viewer** whenever the wire withholds `annotate` on the
frame — a completed batch, or a settled frame inside an open one. The mode is the
frame's own declaration (`allowed_actions`), never this page's arithmetic; it was
made a mode at all by audit F2, which found "open it and let the saves fail"
shipping as the behaviour.

What a viewer is (decision of 2026-08-07, #426):

- **One explanation surface.** The banner under the top bar says `Viewing only.`
  with the cause, and — when the wire declares `create_correction` — the route
  onward: `Correct this batch`. It renders on every frame of a closed batch,
  including skipped ones (#423), where the skipped notice would otherwise promise
  an Un-skip the wire withholds.
- **No classes region.** The side panel is the objects region alone, at full
  height — the region, its filter, its quick-create and its hotkey badges are
  absent, not disabled, and `C` and the digits do nothing. This supersedes #420's
  render-classes-as-information direction: *what may I draw* is not a question a
  viewer can ask.
- **Selection highlights; it does not advertise.** A selected shape renders the
  selected treatment — stroke 3, the label — with **no grips and no vertex
  dots**, and the cursor is the **default arrow everywhere**: no `move`, no
  resize keywords, because no such gesture exists. The tool strip is not
  rendered at all, for the same reason it never was.
- **Selection is one state, reflected everywhere.** A press on a shape selects
  it — the one pointer gesture a viewer keeps, resolved by the same hit rule the
  right-click menu uses — and the objects panel's row highlights and scrolls
  into view. That reflection is both modes' behaviour, not the viewer's alone.
  DOM focus stays with the canvas, which reads its chords off its own root.
- **Reads stay live.** Zoom, pan, fullscreen, the frame gallery, `‹` `›`,
  visibility toggles, the object filter, and copy (`⌘C`) — the road a box takes
  into a correction batch — all work; paste and every other write is refused at
  the engine (`readOnly` on the canvas, `READ_ONLY_KINDS` for the keyboard).

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
