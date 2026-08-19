# VisionSet design foundations

## Purpose

This document is the visual and interaction contract for every VisionSet interface: the
M5 app (`@visionset/app` + `@visionset/ui-core`), the annotator demo, and any surface
built after them. It answers one question — **how should a VisionSet interface look,
feel, and behave visually?** — and deliberately answers nothing else.

The design language is inspired by Vercel's Geist design system: minimal, precise,
neutral-first, monochrome-leaning, with colour reserved for meaning. VisionSet does not
use Vercel's components; Geist is the reference for the language, and VisionSet owns its
own implementation. The intended layering, from foundation to screen:

```text
Geist-inspired foundations            (this document)
        ↓
VisionSet semantic design tokens      (frontend/ui-core — implementation)
        ↓
shadcn-derived / project-owned primitives
        ↓
VisionSet patterns
        ↓
Product screens
```

What this document does **not** own: product behaviour
([`docs/ui/product-principles.md`](docs/ui/product-principles.md)), navigation
([`docs/ui/navigation.md`](docs/ui/navigation.md)), the annotation workspace
([`docs/ui/annotator.md`](docs/ui/annotator.md)), the data shell
([`docs/ui.md`](docs/ui.md)), frontend architecture and library choices
([`docs/architecture/frontend/`](docs/architecture/frontend/README.md)), or test
mechanics. Rules here are stated as the present contract; enforcement details live with
the tests and contributor docs.

## Design Philosophy

Each principle is a decision rule, not a slogan. When two of them conflict on a concrete
screen, the earlier one wins.

1. **Content first.** The interface recedes; the user's data — images, annotations,
   counts — is the loudest thing on screen. Chrome earns its pixels: subtle borders,
   minimal shadows, no gradients, no decoration.
2. **Neutral first.** The screen is near-monochrome. Colour is scarce so that colour can
   mean something: one accent for action and focus, and the status hues for state. A
   surface is never flooded with a hue to make it interesting.
3. **Precise.** Alignment, spacing, and type sit on the scales below — never eyeballed.
   Two screens built by two people should be indistinguishable in styling.
4. **Hierarchy through structure, not volume.** Typography, spacing, hairlines, and
   materials carry hierarchy. Reaching for a louder colour or a heavier shadow to make
   something "stand out" is a hierarchy failure upstream.
5. **Dense where the content is plural.** VisionSet's users are ML engineers and
   professional annotators; on data surfaces, showing more of the thing the user came for
   beats whitespace. Generosity belongs to forms and prose, read one thing at a time.
6. **Fast.** Interfaces respond on the frame the user acts; waits are acknowledged
   immediately and quietly. Motion never makes anyone wait.
7. **Accessible by default.** Semantic HTML, keyboard operability, visible focus, and
   redundant (never colour-only) signals are part of the definition of done, not a pass
   afterwards.
8. **Consistent over novel.** Reuse the token, the role, the material, the pattern. A new
   visual treatment is a design decision made in this document, not in a component diff.
9. **Theme-agnostic.** Every rule below is written against semantic roles, not against
   light-mode values, so light and dark themes are a token swap — never a redesign.

## Foundations

### Color

The colour system has two layers, and application code speaks only the second.

**Primitive palette.** Neutral-anchored scales in the Geist manner — `Gray`, `Gray Alpha`
(for borders and fills that must composite over any surface), `Blue`, `Red`, `Amber`,
`Green`, `Teal`, `Purple`, `Pink` — each a numeric ramp from subtle background steps to
high-contrast foreground steps. Primitives are the vocabulary tokens are defined *from*;
no component names one directly.

**Semantic aliases.** What components consume. Each names an intent, resolves to a
primitive step per theme, and is the only spelling of that intent:

| Alias | Intent |
| --- | --- |
| `background` | The page |
| `background-subtle` | A recessed area of the page |
| `surface` | A raised element sitting on the background (card, popover, input) |
| `surface-hover` / `surface-active` | Its pointer states |
| `border` | Hairlines and dividers |
| `border-hover` / `border-active` | Interactive-element borders under pointer / active |
| `foreground` | Primary text |
| `foreground-secondary` | Secondary and meta text |
| `accent` | The action colour: primary actions, active states, focus, selection tint |
| `info` | Work in flight; neutral-positive information |
| `success` | A settled, succeeded state |
| `warning` | Something is waiting on a person |
| `error` | Failure, refusal, destruction |

Rules:

- **Map intent to alias; never invent a value.** Raw colour values appear only in token
  definitions. This is a standing invariant, machine-enforced; one exception exists — an
  inline style carrying a *schema-supplied* class colour, which is user data no token
  could name.
- **Status hues are for status** (see *Status* below), never for emphasis, branding, or
  action hierarchy.
- **The accent is one colour product-wide.** Active tool, active tab, primary action,
  selection tint, and focus ring are all readings of the same accent, so the interface has
  one voice for "this is where the action is".
- Aliases are defined for both light and dark resolutions from the start. A rule that
  only makes sense in light mode ("near-white page") is written as its intent
  ("`background` at the theme's base step") instead.

**VisionSet-specific extension:** **`stage`** — the neutral surround an image is judged
against in the annotation workspace. It is not `background` and not a generic fill: it
must shift the perceived colour of a photograph as little as possible while staying
distinguishable from both the page and a white-bordered asset. It stays in the token set
as a product-owned semantic role; its usage rules are in
[`docs/ui/annotator.md`](docs/ui/annotator.md).

**Migration note.** The current implementation still spells several intents as
implementation-artifact tokens — `primary`/`primary-hover` (the accent), `sidebar`,
`sidebar-accent`, `sidebar-strong`, `sidebar-muted` (a hardcoded dark rail),
`disabled`/`disabled-foreground`, `success-hover`, `muted`, `card`, `popover`,
`destructive`. These are not part of this contract; the token-implementation phase maps
them onto the aliases above (e.g. the rail becomes surfaces of the dark theme's own
scale, disabled states become reduced-emphasis readings of existing roles, `destructive`
becomes `error`).

#### Brand

Robomous coral is **brand identity, not interface semantics**. The logo and wordmark may
use it; functional UI — buttons, states, progress, focus — uses semantic colour based on
meaning. There is no counted quota of brand appearances and no rule tying any control's
colour to the brand; introducing brand colour into a functional control is simply a
semantic-colour violation, whatever the count.

### Typography

- **Interface text: Geist Sans.** With a real fallback stack, until and unless the
  implementation phase decides otherwise for offline-first reasons.
- **Technical values: Geist Mono** — identifiers, hashes, model references, measurements,
  code-like values, technical metadata. Mono marks *machine-shaped* content; it is never
  decoration, and prose never wears it.
- **Semantic roles, not utility soup.** Text styles are named roles; a screen picks a
  role, never a free combination of size/weight/tracking:

```text
heading-32  heading-24  heading-20  heading-16     page and section headings
copy-16     copy-14     copy-13                    prose, descriptions, help
label-14    label-13    label-12                   form labels, meta, table headers
button-14   button-12                              control text
mono-14     mono-13     mono-12                    technical values
```

  Exact metrics (size, line-height, weight, tracking per role) are fixed by the token
  implementation; the roles and their hierarchy are the contract. The default reading
  size for application UI is the 14 tier; 16 is for prose-first surfaces.
- **Numbers that change use tabular figures** wherever layout stability matters — stat
  values, counters, anything a user watches update.
- One scale. A size or weight that is not a role does not appear.

### Spacing

A 4px-based scale: `4, 8, 12, 16, 24, 32, 48, 64`. 16px is the default layout unit
inside a surface; 24px separates page sections; 8px groups inline elements; 4px is for
intra-control geometry. Spacing states *relationship*: things spaced alike are related
alike, and a one-off gap value is a relationship the reader cannot parse.

### Grid and Layout

- **Prefer intrinsic CSS layout.** Grid and Flexbox, sized by content and constraints —
  not JavaScript measurement where CSS can solve it, and not fixed widths where a
  min/max constraint says what is actually meant.
- **Preserve alignment.** Edges align across siblings; a screen has a small number of
  vertical rhythm lines, and content snaps to them.
- **Support content growth.** Text wraps rather than truncates unless the value is
  re-readable elsewhere; identifiers wrap rather than truncate mid-token; controls are
  never clipped — a readout yields before a button does.
- **Prevent accidental overflow.** A container that can scroll declares it; nothing
  overflows a dialog, a panel, or the viewport as a side effect of long data.
- Exact page, dialog, rail, and column dimensions are screen-level decisions and live
  with the product docs ([`docs/ui/product-principles.md`](docs/ui/product-principles.md),
  [`docs/ui/navigation.md`](docs/ui/navigation.md)) — the foundation constrains *how*
  layout is done, not each width.

### Radius

A compact scale, assigned by material level rather than picked per component:

```text
small   6px    chips, inputs, small controls, tiles
medium  12px   cards, panels, menus, dialogs' inner surfaces
large   16px   large floating surfaces, modals
full    pill / circular surfaces: avatars, pills, progress tracks
```

Nested surfaces step down: a control inside a card is `small` on a `medium` parent.
Arbitrary radii do not appear.

### Materials and Elevation

A surface's appearance is a **material**: one named combination of fill, border, radius,
shadow, and contrast against the parent surface. Components pick a material; they never
compose fills, borders, and shadows freehand — that is how a product ends up with nine
almost-identical cards.

```text
material-base        the page itself — background, no border, no shadow
material-small       inline raised elements: inputs, chips, quiet cards
material-medium      standard cards and panels
material-large       prominent floating surfaces
material-tooltip     tooltips — smallest floating material, highest contrast text
material-menu        menus and popovers
material-modal       dialogs and sheets — strongest separation, with scrim
material-fullscreen  a surface that temporarily is the app (the fullscreen stage)
```

Elevation is expressed *through* materials — in a light theme mostly by border and a
restrained shadow, in a dark theme mostly by fill step — so "how raised is this" and
"which shadow utility" are never asked separately. Exact values belong to the token
implementation.

### Iconography

- **One icon set product-wide**, stroke-based, at a consistent stroke weight; mixing
  sets or weights reads as broken. Which set is an architecture decision
  ([`docs/architecture/frontend/ui-core.md`](docs/architecture/frontend/ui-core.md)),
  not a per-screen one.
- Icons align to the type grid: sized to the text tier they sit beside, optically
  centred, tinted with the text's own colour role.
- **An icon never carries meaning alone.** It accompanies a word, or carries an
  accessible name and tooltip where there is genuinely no room for one — and "no room"
  is a layout decision to justify, not a default.
- Decorative icons are marked as such (`aria-hidden`); functional ones are labelled.

### Motion

- **Motion is functional**: it orients (where did this come from), confirms (this
  registered), or directs attention (this changed). Decorative animation does not ship.
- **Fast and quiet.** Transitions run in the 120–240ms range with standard easing; a
  surface entering is subtler than a surface the user summoned; nothing bounces.
- **Motion never blocks.** No interaction waits for an animation to finish.
- **`prefers-reduced-motion` is honoured everywhere**: movement collapses to opacity
  changes or nothing, with no loss of information.

## Component Principles

### Action Hierarchy

**Every decision context has a clear action hierarchy.** Where there is a clear next
step, prefer **one dominant action** — the filled, accent-coloured treatment — with
supporting actions in secondary (outlined) or tertiary (ghost) treatments. Where a
context genuinely offers peers, no action pretends to dominance.

- Hierarchy is expressed by **treatment** (filled / outline / ghost), never by semantic
  status colour. A save button is not green because saving is good; `success` describes a
  resulting state, not an action's importance. A destructive action may use `error`
  styling — there the colour *is* the semantics.
- Row- and item-level actions inside tables and lists are never the view's dominant
  action; they take secondary or tertiary treatments.
- An overflow menu (`⋯`) is where the undominant rest lives; a view never lines up more
  than a dominant action, one secondary, and the overflow.
- Which action is dominant on which product screen — and how it tracks state — is
  product behaviour: [`docs/ui/product-principles.md`](docs/ui/product-principles.md).

### Forms

- Labels sit above fields, in a label role, Title Case. A placeholder is a hint or an
  example — never the label, because it vanishes exactly when the user starts answering.
- Help text is `copy-13` in `foreground-secondary`, under the field; an error replaces or
  joins it in `error`, adjacent to the field it concerns, and names both what is wrong
  and what would fix it.
- Inputs share one control height per density tier, one radius (`small`), one border
  behaviour (`border` → `border-hover` → `border-active`/focus ring). A two-line option
  (identifier plus its facts) grows the control; nothing truncates an identifier.
- Submission follows the never-disable rule
  ([`docs/ui/product-principles.md`](docs/ui/product-principles.md)): a submit control
  stays pressable and explains, or explains what would enable it, or is not rendered.
- Required is the default; optional fields are the ones marked.

### Feedback

Loading, empty, error, and success are **designed states**, specified with the screen —
never leftovers. The baseline for async feedback:

- **Short operations avoid loading flashes.** Work expected to finish within perception
  is not announced retroactively.
- **Transient loading UI appears after roughly 150–300ms** of unresolved wait — early
  enough that working and broken never look alike, late enough that instant answers
  never flicker. A surface may justify announcing immediately where measurement shows
  the wait always crosses the threshold; **a threshold that hides a state needs evidence
  that the state occurs.**
- **Once shown, loading UI stays visible long enough not to flicker** (a floor on the
  order of 250ms), because appearing is free and vanishing after two frames reads as a
  glitch.
- **Long-running operations get explicit progress or status prose** — a fraction when
  one exists, a sentence when it does not. An unknown total is never drawn as an empty
  progress track.
- A wait is reported **in one place**, in the user's line of sight but out of the
  content's way — never at the cursor, never on the data itself.
- Skeletons preserve the layout they stand in for. Success feedback prefers the visible
  result; a toast confirms only what the user cannot already see.

### Status

**Status is never communicated by colour alone.** The word, an icon, a shape, or another
redundant channel always rides with the hue — a status vocabulary must survive a
monochrome screen and a colour-blind reader.

Five semantic families, product-wide:

```text
neutral   nothing has happened, or a decision was taken and nothing is wrong
info      work is in flight; neutral-positive information
success   settled, succeeded, done
warning   something is waiting on a person
error     failed, refused, destructive
```

As an illustration (the authoritative product mapping lives in
[`docs/ui/product-principles.md`](docs/ui/product-principles.md)): an unannotated or
skipped frame is `neutral`, a running job `info`, a frame awaiting review `warning`, a
completed batch `success`, a failed export `error`. Two corollaries: `error` is for
things that went wrong, never for decisions someone chose; and `warning` is not "in
progress" — colouring the healthy majority state amber makes ordinary work read as a
list of problems.

### Overlays

- Every floating surface is one of the floating materials (`tooltip`, `menu`, `modal`,
  `fullscreen`) — no freehand popovers.
- **Tooltips** hint and label; they never carry status, errors, or content the user must
  read to proceed. If a word is load-bearing, it is on the surface.
- **Menus** open adjacent to their trigger, are fully keyboard-operable, commit on
  selection, and render an unavailable item disabled *with its reason* rather than
  omitting it silently.
- **Dialogs** are sized by their content's shape from a small fixed set of widths (the
  set is a product decision); any dialog whose content grows with data scrolls *inside*
  itself rather than growing past the viewport. A dialog that asks a question names the
  consequence of yes. Focus moves in on open, is trapped while open, and returns to the
  trigger on close; Escape and the scrim close anything non-destructive, and a dialog
  holding unsaved user input asks first.
- Stacking is exceptional: one modal at a time; a menu or tooltip may sit above it.

## Responsive Design

- Designed for mobile, laptop, desktop, and wide displays; the standard breakpoints are
  640 / 768 / 1024 / 1280.
- **Adaptation reflows; it does not amputate.** Content and controls remain reachable
  and legible at every supported size — a chain collapses to its essential form, a bar
  reabsorbs controls into an overflow in a stated order; nothing simply disappears.
- Information density is preserved on data surfaces: small screens get the same data
  with adapted layout, not a brochure.
- Hit targets stay comfortable on touch (44px-order targets), whatever the pointer.
- Layout adapts in CSS (container- and viewport-driven); JavaScript measurement is a
  last resort with a stated reason.

## Interaction

- **Keyboard parity.** Everything a pointer can do, the keyboard can do: real
  interactive elements, logical tab order, arrow-key movement inside composite widgets,
  chords documented where they exist.
- **Focus is visible, always** — a `focus-visible` ring in the accent, painted outside
  the element so it survives any fill.
- **Hover is quiet**: a `surface-hover` step or `border-hover`, never a colour change of
  meaning. Pressed states darken one further step.
- **The cursor promises the common outcome.** Default arrow for select, pointer for
  links, text beam for text; specialised cursors (grab, resize axes) appear only where
  the gesture is real and current.
- **Selection is one state, reflected everywhere it is visible** — the canvas, the list
  row, the count — never a per-surface impression.
- Ongoing direct manipulation (drag, draw, pan) is never interrupted by background
  updates; the interface defers reflow until the gesture ends.

## Accessibility

First-class, and part of every rule above rather than a section to satisfy afterwards:

- Semantic HTML: real `<button>`/`<a>`, native form controls, lists as lists, one `<h1>`
  and a meaningful heading hierarchy below it.
- Full keyboard operability and correct focus management (see *Interaction*, *Overlays*).
- Every interactive element has an accessible name; every form control a programmatic
  label; icon-only controls a text alternative.
- **No colour-only communication** — status, selection, validity, and provenance all
  carry a redundant channel.
- Text and essential UI meet contrast requirements in both themes; disabled-looking is
  still legible.
- Hit targets are large enough to press without aiming (44px-order for touch, 24px
  minimum otherwise).
- `prefers-reduced-motion` support (see *Motion*).
- Dialogs, menus, and tooltips follow their ARIA patterns: roles, labelled-by
  relationships, focus trap and return, Escape behaviour.
- Async states are announced: loading and error regions use live regions where a sighted
  user would notice the change peripherally.
- Responsive accessibility: zoom to 200% and small viewports keep everything reachable.

Verification mechanics (which suites, which tools) live with the tests and contributor
documentation, not here.

## Content and Copy

- **Concise, active, verb-first.** Action labels start with a precise verb ("Create
  Project", "Ingest Batch"); filler ("just", "simply", "please") does not ship.
- **Capitalization has a hierarchy.** Title Case for interface labels: page titles,
  section titles, buttons, form labels, menu items, tabs. Sentence case for prose:
  descriptions, helper text, error descriptions, empty-state copy, toast bodies.
- **Errors explain what happened and what the user can do next** — one sentence each.
  The API's error contract already separates the two; the UI never merges them back.
- **Empty states name the next useful action** when one exists (see the product
  principles for the invitation pattern).
- Consistent product terminology: one name per concept, the domain's own words
  (`batch`, `schema version`, `release`), never internal codenames or raw backend codes
  where human-readable copy exists.
- State the result, not the ceremony: when the resulting state is already visible, the
  copy does not also announce that it happened "successfully". Exclamation marks
  virtually never earn their place; enthusiasm is not information.

## Implementation Boundaries

**What implements this contract today.**

| | file |
| --- | --- |
| Prose (this file) | `DESIGN.md` |
| The running tokens | `frontend/ui-core/src/styles.css` — Tailwind v4 `@theme` |
| The TypeScript mirror | `frontend/ui-core/src/tokens.ts` — for callers that cannot read CSS |
| Primitives | `frontend/ui-core/src/primitives/` |
| Loading / empty / error | `frontend/ui-core/src/patterns/AsyncStates.tsx` |
| The class palette | `frontend/annotator/src/adapters/react/paint.ts`, re-exported by `ui-core/src/palette.ts` |
| Rendered, to look at | `frontend/app/styleguide.html` (`pnpm --filter @visionset/app dev`) |

The stylesheet and the mirror are gated against each other in both directions; a
consumer imports one line — `import "@visionset/ui-core/styles.css"` — and adds an
`@source` for its own sources.

**Standing invariants**, enforced in the test suites (the mechanics live there):

- Raw colour values are not introduced outside approved token definitions; the one
  sanctioned exception is an inline style carrying a schema-supplied class colour.
- The tokens have exactly one home (no `tailwind.config.js`, ever).

**Architecture boundaries this document leans on, owned elsewhere**
([`docs/architecture/frontend/`](docs/architecture/frontend/README.md)):
`@visionset/app` is the shell and router layer; `@visionset/ui-core` is the shared
product UI layer and imports no router; `@visionset/annotator`'s core is headless and
framework-independent. Library and primitive-stack choices are architecture decisions
recorded there, not visual foundations.

**Contract vs. implementation.** The running tokens and primitives still carry the
previous visual language (system font stack, the `primary` near-black accent, the
implementation-artifact tokens named under *Color*, per-component shadow utilities).
This document states the target contract; the next phase implements it — semantic
tokens per the alias model above, the Geist type roles, the material set, and the
shadcn-derived primitive layer in `@visionset/ui-core` — without changing what the
product's screens *do*.
