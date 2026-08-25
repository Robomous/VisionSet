# VisionSet design foundations

## Purpose

This document is the visual and interaction contract for every VisionSet interface: the
M5 app (`@visionset/app` + `@visionset/ui-core`), the annotator demo, and any surface
built after them. It answers one question — **how should a VisionSet interface look,
feel, and behave visually?** — and deliberately answers nothing else.

What this document does **not** own: product behaviour
([`docs/content/ui/product-principles.md`](docs/content/ui/product-principles.md)), navigation
([`docs/content/ui/navigation.md`](docs/content/ui/navigation.md)), the annotation workspace
([`docs/content/ui/annotator.md`](docs/content/ui/annotator.md)), the data shell
([`docs/content/ui.md`](docs/content/ui.md)), frontend architecture and library choices
([`docs/content/architecture/frontend/`](docs/content/architecture/frontend/README.md)), or test
mechanics. Rules here are stated as the present contract; enforcement details live with
the tests and contributor docs.

## Source of Truth

VisionSet's visual language is a **shadcn preset**, not a hand-authored system: preset
code `b3bXyyPdWj`, decoded as `style: nova` (on the Radix base — `radix-nova` in
`components.json`), `baseColor: neutral`, `chart: orange`, `icons: tabler`,
`font: inter`, `heading: geist`, `radius: medium`, `menu: inverted/subtle`. The preset
was generated with shadcn CLI **4.18.0** and transcribed verbatim into this repository;
that CLI version is the reference for every value in this document. Nothing here is
invented — every token, every derived radius, every chart colour traces back to the
CLI's own output.

`@visionset/ui-core` owns the implementation, in exactly three files:

| File | Role |
| --- | --- |
| [`frontend/ui-core/components.json`](frontend/ui-core/components.json) | The preset properties shadcn's own tools read — the fields its config schema defines, and no others |
| [`frontend/ui-core/src/styles.css`](frontend/ui-core/src/styles.css) | The tokens that run — `:root`, `.dark`, `@theme inline`, the base layer |
| [`frontend/ui-core/src/tokens.ts`](frontend/ui-core/src/tokens.ts) | The TypeScript mirror, for a caller that cannot read CSS |

**One intent, three layers — and they do not hold the same fields.** `components.json`
carries only what shadcn's config schema defines (`style`, `tailwind.baseColor`,
`iconLibrary`, `menuColor`, `menuAccent`, `rsc`/`tsx`/`rtl`, the aliases, the registries).
That schema is **strict**: a decoded property it has no field for is *rejected*, not
ignored, so the file cannot be made to restate the whole preset even as documentation.
Everything else the preset decides — the radius, both fonts, the chart palette, every
colour — is a *value*, and values live in `styles.css`. A decoded property missing from
`components.json` is therefore the design working as intended, never drift:

| Layer | Owns | Radius, as the worked example |
| --- | --- | --- |
| Preset intent | What the code decodes to (`shadcn preset decode b3bXyyPdWj`) | `radius: medium` |
| Runtime | The value that actually paints, in `styles.css` | `--radius: 0.625rem` |
| CLI configuration | The schema-supported fields, in `components.json` | no `radius` field — the schema defines none |

Three machine gates hold this contract, each in one line: `tokens.test.ts` asserts
`styles.css` and `tokens.ts` agree, declaration for declaration, and that no retired
token has crept back in; `tests/scripts/design_tokens.test.mjs` bans a raw colour in any
class string, bans a second `tailwind.config.js`, confines `brand` to its two identity
sites, holds `components.json` to the schema-supported field set, and re-checks the
retired vocabulary by an independent method; `tests/scripts/docs_links.test.mjs` keeps
every link and heading anchor in this document itself honest.

Radix stays the behaviour layer under every primitive — this is a visual foundation
rewrite, not a component replacement.

## Design Character

Each principle is a decision rule, not a slogan. When two of them conflict on a concrete
screen, the earlier one wins.

1. **Content first.** The interface recedes; the user's data — images, annotations,
   counts — is the loudest thing on screen. Chrome earns its pixels: hairlines, a
   resting shadow, no gradients, no decoration.
2. **One action colour.** `primary` is the one high-emphasis colour, product-wide: the
   dominant action, the active tool, the selected surface. Colour elsewhere is either a
   hover/focus surface (`accent`) or a status hue — never a second reading of emphasis.
3. **Precise.** Alignment, spacing, and geometry sit on the scales below — never
   eyeballed. Two screens built by two people are indistinguishable in styling.
4. **Hierarchy through structure, not volume.** Typography, spacing, hairlines, and
   surfaces carry hierarchy. Reaching for a louder colour or a heavier shadow to make
   something "stand out" is a hierarchy failure upstream.
5. **Dense where the content is plural.** VisionSet's users are ML engineers and
   professional annotators; on data surfaces, showing more of the thing the user came
   for beats whitespace. Generosity belongs to forms and prose, read one thing at a
   time.
6. **Fast and quiet.** Interfaces respond on the frame the user acts; motion orients or
   confirms and never makes anyone wait.
7. **Accessible by default.** Semantic HTML, keyboard operability, visible focus, and
   redundant (never colour-only) signals are part of the definition of done.
8. **Consistent over novel.** Reuse the token, the role, the primitive. A new visual
   treatment is a decision made in this document, not in a component diff.
9. **Roles, not polarity.** Every rule below is written against a semantic role, not a
   fixed light-mode value — "the page" resolves per theme; it is never asserted to be
   white, and the sidebar is never asserted to be dark. Light and dark are both defined
   from the preset, in full, from the start.

## Theme Token Model

shadcn's semantic names are the only vocabulary components speak. There is no second
naming layer (`surface`, `error`, `foreground-secondary`) and no alias that renames what
a token already means.

| Token(s) | Meaning |
| --- | --- |
| `background` / `foreground` | The page, and the ink that sits directly on it |
| `card` / `card-foreground` | A raised surface — panels, cards |
| `popover` / `popover-foreground` | A floating surface — menus, popovers, tooltips, dialogs |
| `primary` / `primary-foreground` | **High-emphasis actions and selected surfaces.** The one dominant-action colour |
| `secondary` / `secondary-foreground` | Lower-emphasis filled actions — a second filled weight, not a second accent |
| `muted` / `muted-foreground` | Subtle fills and lower-emphasis (secondary, meta) content |
| `accent` / `accent-foreground` | **Interactive hover/focus/active surfaces.** Not the action colour — this is the token a row highlights or a menu item lights up with, never what a button fills with |
| `destructive` | Destructive actions and their state. Stays `destructive` — never renamed `error` |
| `border` / `input` / `ring` | Hairlines and dividers; field borders; the focus ring's colour |
| `chart-1` … `chart-5` | Series colours in a chart. Identify a series, never a status |
| `sidebar` / `sidebar-foreground` / `sidebar-primary(-foreground)` / `sidebar-accent(-foreground)` / `sidebar-border` / `sidebar-ring` | The navigation rail's own surface, ink, active-item fill, and hairline — a parallel set so the rail can differ from `card` without inventing a name |
| `radius` | The one geometry constant every radius step derives from |

Both themes are declared **in full** from the preset — `:root` and `.dark` each name
every token above, so switching theme is a variable swap, never a redesign. A rule that
only makes sense in one theme ("the page is near-white") is written as its role instead.

## Surfaces

`background` is the page. `card` and `popover` are the two raised materials — `card` for
content that sits in place, `popover` for anything that floats and closes (see *Sidebar
/ Menu* for the one deliberate exception to popover's own colour). `muted` is a recessed
or subtle fill — a footer strip, a quiet chip, secondary content's backdrop. A component
picks one of these three; it does not compose a fill from scratch.

## Actions and Interactive States

- **One dominant action per view**, in `primary`; supporting actions take `secondary` or
  a quieter (ghost/link) treatment. Which action is dominant on which screen, and how it
  tracks state, is product behaviour — [`docs/content/ui/product-principles.md`](docs/content/ui/product-principles.md).
- **Hover** on a filled control is the same fill at reduced opacity (`hover:bg-primary/80`),
  not a colour change of meaning; a menu or list item highlights with `accent` instead.
- **Press** reads as the control moving, not recolouring.
- **Disabled** is uniform reduced opacity plus `pointer-events-none` — the control dims
  as itself rather than swapping to a separate greyed-out skin. A disabled control still
  explains itself; see the product principles' never-disable-without-explanation rule.
- **Destructive** actions use a soft treatment — tinted background and ink, not a solid
  fill — so the one action that can end something does not read louder than `primary`.
- **Focus** is always visible (see *Borders and Focus*).

## Typography

- **Body copy: Inter**, via `--font-sans` (`'Inter Variable', sans-serif`).
- **Headings: Geist**, via `--font-heading` (`'Geist Variable', sans-serif`), applied at
  the semantic-HTML level — `h1`–`h4` carry it in the base layer, so a screen never has
  to remember `font-heading` on every heading it writes.
- Both are bundled offline through `@fontsource-variable/{inter,geist}` — no runtime
  fetch to a font host, ever.
- **One justified technical role: `font-mono`.** Tailwind's default monospace stack (no
  Geist Mono package is bundled) marks *machine-shaped* content — identifiers, hashes,
  model references, measurements. It is never decoration, and prose never wears it; this
  rule is unchanged from the previous contract.

## Density and Spacing

Two different scales answer two different questions, and conflating them is the
anti-pattern this section exists to prevent:

- **Component geometry is Nova's**, fixed per control by the preset — not a per-screen
  choice, not eyeballed.
- **Page and layout rhythm is VisionSet's own composition**, on Tailwind's ordinary
  spacing scale — gaps between sections, page padding, list rhythm. A screen reaches for
  `p-6`, `gap-4`, `space-y-8`; it does not invent a control's internal geometry.

Nova's component geometry, transcribed from the preset (the concrete defaults every
primitive targets):

| Control | Geometry |
| --- | --- |
| Button — default | `h-8 px-2.5 gap-1.5 text-sm font-medium rounded-lg` |
| Button — sizes | `sm` → `h-7`; `xs` → `h-6`; `lg` → `h-9`; `icon` → `size-8` |
| Button — press / focus / disabled | press `active:translate-y-px`; focus `focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50`; disabled `opacity-50` |
| Button — icon | `svg size-4` (`size-3.5`/`size-3` at `sm`/`xs`) |
| Button — hover | default `hover:bg-primary/80`; secondary `color-mix(in oklch, var(--secondary), var(--foreground) 5%)`; destructive soft |
| Input | `h-8 rounded-lg border-input px-2.5 text-base md:text-sm`; dark theme `bg-input/30` |
| Badge | `h-5 px-2 text-xs rounded-4xl`; icons `size-3`. The `quiet` variant alone is `rounded-md` — a square, colourless label for a fact read beside other facts, never a state |
| Menu — surface | `dark` subtree + `bg-popover p-1 rounded-lg ring-1 ring-foreground/10 shadow-md`, `min-w-32`, `duration-100` enter and **no exit** — see *Motion* |
| Menu — item | `px-1.5 py-1 text-sm rounded-md focus:bg-accent focus:text-accent-foreground`; destructive item soft |
| Card | `rounded-xl ring-1 ring-foreground/10 text-sm`; `--card-spacing` = `--spacing(4)` (16px; 12px at the `sm` size); footer `bg-muted/50` |
| Dialog — overlay | `bg-black/10 supports-backdrop-filter:backdrop-blur-xs duration-100` |
| Dialog — content | `rounded-xl bg-popover p-4 text-sm ring-1 ring-foreground/10 sm:max-w-sm` |
| Sidebar (shadcn's own component; VisionSet's rail is a custom composition — see *Sidebar / Menu*) | `16rem` / `18rem` mobile / `3rem` icon |
| Elevation | `ring-1 ring-foreground/10` + a resting shadow — never a coloured border |

`frontend/ui-core/src/primitives/` carries the table itself, not a family resemblance to
it: the heights, the `ring-3` focus treatment, the `duration-100` enter, the
`--card-spacing` variable and Nova's interaction idioms (uniform disabled opacity, soft
destructive, `/80`-opacity hover, the inverted menu subtree) are the primitives' own
declarations. The table is the contract and the primitives are where it is spelled, so a
control reaching past it is now a diff against this document rather than a gap in a
migration.

Two measurements are deliberately *not* the table's, and both are argued at the
component: `SelectTrigger` is `min-h-8` rather than `h-8`, because a two-line option has
to grow the control instead of being squashed inside it, and `Textarea` is `min-h-16` for
the same reason. A minimum where the table says a fixed height is the one substitution
this document sanctions, and only where the content's own height is the point.

## Radius

The preset's `radius: medium` materialises here and nowhere else: `--radius: 0.625rem`
(10px) in `styles.css` is the authoritative runtime value, mirrored by `tokens.ts` and
pinned by `tokens.test.ts`. `components.json` holds no radius field — shadcn's config
schema defines none, and being strict it rejects one. This stylesheet is the single place
the medium step is spelled.

`--radius` is the one constant; every other radius step is derived from it in
`@theme inline`, verbatim:

| Step | Formula | Result |
| --- | --- | --- |
| `radius-sm` | `var(--radius) * 0.6` | 6px |
| `radius-md` | `var(--radius) * 0.8` | 8px |
| `radius-lg` | `var(--radius)` | 10px |
| `radius-xl` | `var(--radius) * 1.4` | 14px |
| `radius-2xl` | `var(--radius) * 1.8` | 18px |
| `radius-3xl` | `var(--radius) * 2.2` | 22px |
| `radius-4xl` | `var(--radius) * 2.6` | 26px |

No arbitrary radius appears outside this scale.

## Borders and Focus

The base layer applies `border-border` and `outline-ring/50` to every element and
`bg-background text-foreground` to `body` — a hairline and the outline's colour are the
default state of anything on the page, not something each component re-declares.
Nova's component-level focus treatment is stronger and more specific:
`focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` — a 3px ring
in the `ring` token's colour, painted outside the control so it survives any fill. Focus
is never colour-only and never removed; an element that can be focused shows it.

Focus *geometry* is never declared in the base layer. The `*` rule names the outline
colour and stops there; the ring itself belongs to the component, because a single
stylesheet-wide `:focus-visible` declaration overrides every primitive's ring at once and
wins on layer order no matter how specific the component's own selector is. So each
focusable primitive carries the treatment: `Button`, `Badge`, `Input`, `Textarea` and
`SelectTrigger` the `ring-3` ring above, `TabsTrigger` the same ring plus a 1px
`outline-ring` hairline, and menu and select items `focus:bg-accent
focus:text-accent-foreground` (the combobox paints the same fill on its active option,
which it tracks itself because the list keeps DOM focus on the input). An item inside a
floating surface reads focus as the fill it would take on hover, not as a ring inside a
list.

`frontend/app/e2e/styleguide.spec.ts` measures the tab bar's ring in a real browser,
which is the only place the composition can be checked: Tailwind renders `ring-3` as a
`box-shadow` layer, so "the ring is there" is a question about a computed shadow list
rather than about a class string.

## Motion

Motion orients or confirms, and never stands between somebody and their next action —
*Fast and quiet*, applied. An **enter** animation is free to play: nothing is waiting on
it, because the surface it introduces did not exist a frame ago. An **exit** animation is
not, and the difference is not a matter of taste.

**A floating surface leaves on the frame it is dismissed.** While an exit animation runs,
Radix keeps the content mounted, and the dismissable layer stays mounted with it. A press
on the trigger inside that window is read twice — the trigger toggles the surface open,
and the layer still listening reads the same pointer-down as an interaction outside itself
and dismisses — so the two cancel and the surface never appears. At `duration-100` that
window covers the gap between an `Escape` and the click after it, which makes it a defect
a fast hand meets routinely rather than an edge case. The annotation workspace is where
that tempo is normal, and it is where the behaviour was measured; the fix belongs to the
primitive because every menu in the product shared the flaw.

So `DropdownMenuContent` animates in and not out, and
`frontend/app/e2e/annotate.spec.ts` holds the two presses that would catch a fade being
restored. A surface that genuinely needs an exit — one whose trigger cannot be pressed
again straight away, as a modal's cannot — may keep one; the tooltip keeps its own,
because a hover has no toggle to swallow.

`prefers-reduced-motion` sits above all of this: the base layer in `styles.css` collapses
every animation and transition to a single frame under that query, so none of the above is
something a component opts into.

## Sidebar / Menu

- **`menuColor: inverted`.** Every menu and popover subtree — dropdown content, select
  and combobox popovers — carries the literal `dark` class, so a menu is always the dark
  theme's `popover`/`popover-foreground` regardless of the page's own theme. This is
  deliberate contrast, not a bug: a floating surface reads as "above" the page partly by
  not matching it.
- **The tooltip inverts itself instead.** `TooltipContent` is Nova's own recipe:
  `bg-foreground text-background` with a matching `Arrow` and `sideOffset` 0, so it flips
  with the theme by construction rather than by being handed the `dark` class. Same
  intent as the bullet above, reached without a subtree — a tooltip holds one line of
  text and no tokens of its own to keep in step, so the token pair *is* the inversion.
  Menus, selects and the combobox keep the `dark` mechanism, because a surface with its
  own borders, hover fills and destructive items needs a whole palette flipped, not two
  colours swapped.
- **`menuAccent: subtle`.** Items highlight on hover/focus with `bg-accent
  text-accent-foreground` — the same interactive-surface token every other hover state
  uses, not a saturated selection colour.
- **The rail follows the theme.** VisionSet's navigation rail (`AppShell`) is a custom
  composition on the 8 `sidebar-*` tokens above — light in the light theme, dark in the
  dark theme — never a hardcoded dark surface independent of the theme switch. Its
  widths are a VisionSet layout extension in `@theme inline` (`--spacing-sidebar: 240px`,
  `--spacing-sidebar-collapsed: 48px`), consumed by `AppShell`, its collapse toggle, and
  the content offset, which must agree or the layout jumps on collapse. The collapsed
  width is the preset's own icon-sidebar width (`3rem`): with the rail's `p-2` it holds
  exactly one `size-8` control per row, so every icon is centred by construction. The
  expanded width is not the preset's (unused) Sidebar component's — VisionSet does not
  consume that component.

## Charts

The preset's chart palette — five orange steps, **identical in both themes** (a chart
does not restyle when the page switches theme):

| Token | Value |
| --- | --- |
| `chart-1` | `oklch(0.837 0.128 66.29)` |
| `chart-2` | `oklch(0.705 0.213 47.604)` |
| `chart-3` | `oklch(0.646 0.222 41.116)` |
| `chart-4` | `oklch(0.553 0.195 38.402)` |
| `chart-5` | `oklch(0.47 0.157 37.304)` |

These are **series colours, never status.** A chart never leans on `chart-2` to mean
"warning" — status uses the status tokens below, a chart uses these to tell one series
from another.

## VisionSet Extensions

Five roles the preset has no token for, each following shadcn's own extension
convention exactly — a value in `:root`, a dark counterpart in `.dark`, exposure through
`@theme inline` (`--color-<name>: var(--<name>)`), and coverage in both `tokens.test.ts`
and `tests/scripts/design_tokens.test.mjs`:

| Token | Purpose | Light | Dark |
| --- | --- | --- | --- |
| `stage` | The neutral surround an image is judged against in the annotation workspace — not `background`, not `muted`; distinguishable from both so a white-bordered asset still shows where it ends. Usage rules: [`docs/content/ui/annotator.md`](docs/content/ui/annotator.md#the-stage) | `oklch(0.94 0 0)` | `oklch(0.24 0 0)` |
| `brand` | Robomous coral. Identity only — the wordmark, and its styleguide swatch. Never a functional-UI colour; there is no counted quota, and introducing it into a control is a semantic-colour violation whatever the count | `oklch(0.653 0.178 32.3)` | `oklch(0.653 0.178 32.3)` |
| `success` / `success-foreground` | The batch-state family's settled/succeeded state and its one filled control — a green analogue of the preset's own destructive treatment | `oklch(0.577 0.132 152)` / `oklch(1 0 0)` | `oklch(0.696 0.17 152)` / `oklch(0.205 0 0)` |
| `warning` / `warning-foreground` | Something is waiting on a person | `oklch(0.646 0.13 80)` / `oklch(0.205 0 0)` | `oklch(0.75 0.14 80)` / `oklch(0.205 0 0)` |
| `origin-hub` / `origin-custom` / `origin-robomous` | Where a model's weights come from, as a **mark** — the accent edge of a card on the Models page, a few pixels wide on the plain `card` — amber for the hub, blue for the user's own, orange on the brand's hue for the Robomous registry. A mark only: never a surface, never ink, and an origin is a kind, never a state, so these never stand in for a status. Identical in both themes, like the chart palette, because a mark this small must read the same wherever the card is. `origin-robomous` is its own token; `brand` stays identity-only | `oklch(0.8 0.16 85)` / `oklch(0.65 0.15 250)` / `oklch(0.68 0.17 35)` | same |

No sixth extension exists. An `info` family was considered and rejected for now:
in-flight product states keep the current `primary`-tinted treatment; a dedicated `info`
token is a later product decision, not a gap in this rewrite.

## Components

shadcn's model is **open code**: a primitive is source VisionSet owns and edits in
`frontend/ui-core/src/primitives/`, not a package dependency upgraded blindly. Radix
supplies the behaviour (focus management, `aria-*` wiring, keyboard patterns); the style
on top of it is `radix-nova`, recorded as `components.json`'s `style` field. There is no
`shadcn add` run against this package after the initial generation, and no component
replacement — the same primitives from before this rewrite still exist, now speaking the
preset's vocabulary.

Rendered to look at: `pnpm --filter @visionset/app dev`, then the `/styleguide` route
(`frontend/app/src/styleguide/Styleguide.tsx`).

## Accessibility

First-class, and part of every rule above rather than a section to satisfy afterwards:

- **Semantic HTML.** Real `<button>`/`<a>`, native form controls, lists as lists, one
  `<h1>` and a meaningful heading hierarchy below it.
- **Keyboard parity.** Everything a pointer can do, the keyboard can do: real
  interactive elements, logical tab order, arrow-key movement inside composite widgets.
- **Focus is always visible** — the component `ring-3 ring-ring/50` treatment where a
  primitive defines one, the base layer's `outline-ring/50` everywhere else; never
  removed, never colour-only.
- **No colour-only communication.** Status, selection, validity, and provenance all
  carry a redundant channel (a word, an icon, a shape). The product status vocabulary
  itself — the five semantic families and their mapping to product states — is defined
  in [`docs/content/ui/product-principles.md`](docs/content/ui/product-principles.md#status-semantics).
- **`destructive` stays semantically destructive** — the one token that is its own
  status, never repurposed for emphasis and never renamed.
- **`prefers-reduced-motion`** is a standing rule: motion collapses to opacity changes or
  nothing, with no loss of information. The base layer in `styles.css` enforces it: under
  the media query, every animation and transition duration collapses to a single frame,
  so no component needs to opt in individually.
- **Never disable without explanation** stays exactly as the product principles state it
  — [`docs/content/ui/product-principles.md`](docs/content/ui/product-principles.md#principles) — this
  document only fixes disabled's *look* (`opacity-50`), not when a control may be one.
- Dialogs, menus, and tooltips follow their ARIA patterns: roles, labelled-by
  relationships, focus trap and return, `Escape` behaviour — Radix's own guarantees,
  which is why no primitive here is hand-rolled from a `<div>`.

## Responsive / Product Composition

- Designed for mobile, laptop, desktop, and wide displays; standard breakpoints
  640 / 768 / 1024 / 1280.
- **Adaptation reflows; it does not amputate.** Content and controls remain reachable
  and legible at every supported size — nothing simply disappears; see
  [`docs/content/ui/navigation.md`](docs/content/ui/navigation.md) for the rail's own collapse behaviour.
- **Content growth is supported, not fought.** Text wraps rather than truncates unless
  the value is re-readable elsewhere; identifiers wrap rather than truncate mid-token;
  controls are never clipped — a readout yields before a button does.
- Hit targets stay comfortable on touch (44px-order), whatever the pointer.
- Page, section, and list rhythm is Tailwind's ordinary spacing scale (see *Density and
  Spacing*) — exact page and dialog dimensions are screen-level decisions living with
  [`docs/content/ui/product-principles.md`](docs/content/ui/product-principles.md) and
  [`docs/content/ui/navigation.md`](docs/content/ui/navigation.md), not this document.

## Anti-Patterns

- **A raw colour outside the foundation.** Every hex, `rgb()`, `hsl()`, `oklch()`, or
  `var()` inside a Tailwind class string is machine-refused
  (`tests/scripts/design_tokens.test.mjs`); the one sanctioned exception is an inline
  style carrying a schema-supplied class colour, which is user data no token could name.
- **A second token vocabulary.** No `surface`, `error`, `foreground-secondary`, or
  "accent as the action colour" alias — shadcn's names are the only spelling of intent,
  and a parallel naming layer is exactly the drift this rewrite removed.
- **Ad-hoc geometry that fights Nova.** A control's height, padding, or radius is not a
  per-screen decision; reaching past the geometry table above for a bespoke size is a
  design decision to make in this document, not in a component diff.
- **Mixing icon sets in new code.** Tabler is the set, and now the only one: every icon
  the primitives, the screens and the annotation workspace draw is
  `@tabler/icons-react`, no package declares a second icon library, and
  `tests/scripts/design_tokens.test.mjs` refuses one that reappears in a manifest or an
  import. A second set is a decision to make in this document, not a dependency to add.
- **Brand in a functional control.** Robomous coral is identity — the wordmark and its
  styleguide swatch, nothing else. A functional control reaching for `brand` is a
  semantic-colour violation regardless of how many other sites already use it correctly.
