# VisionSet design foundations

## Purpose and Ownership

This document governs how VisionSet interfaces look and behave. It is not a component
catalogue: the components are shadcn's, and their classes, anatomy and states are read from
the files the CLI wrote rather than transcribed here. What it owns is the *governance* — which
layer decides what, what VisionSet may add, what it may not change, and which gate holds each
rule. Where a rule is machine-checked the gate is named, because a rule nothing checks is a
preference. It does not own product behaviour
([`docs/content/ui/product-principles.md`](docs/content/ui/product-principles.md)), navigation
([`docs/content/ui/navigation.md`](docs/content/ui/navigation.md)), the annotation workspace
([`docs/content/ui/annotator.md`](docs/content/ui/annotator.md)), the data shell
([`docs/content/ui.md`](docs/content/ui.md)), or frontend architecture
([`docs/content/architecture/frontend/`](docs/content/architecture/frontend/README.md)).

## Source of Truth

Six layers decide the visual result. **When two disagree, the earlier one wins.**

| # | Layer | Where it lives | Decides |
| --- | --- | --- | --- |
| 1 | CLI configuration | [`frontend/ui-core/components.json`](frontend/ui-core/components.json) | The fields shadcn's own tools read — style, base colour, icon library, menu treatment, aliases |
| 2 | Decoded preset intent | preset code `b2iH`, shadcn CLI **4.19.0** | Every value the config schema has no field for — radius, fonts, chart palette, both themes |
| 3 | Official registry output | [`frontend/ui-core/shadcn/`](frontend/ui-core/shadcn) snapshots, realised in [`frontend/ui-core/src/primitives/`](frontend/ui-core/src/primitives) | A primitive's API, anatomy, variants, sizes, states and styling |
| 4 | VisionSet additive extensions | `primitives/badge.tsx`, `src/tokens.ts`, `src/styles.css` | Semantic variants and tokens the foundation has no name for |
| 5 | Patterns | [`frontend/ui-core/src/patterns/`](frontend/ui-core/src/patterns) | Composition of primitives into VisionSet shapes, and layout rhythm |
| 6 | Screens and the annotator | `src/screens/`, `src/annotator/` | Which shape a page uses, and when |

A screen may not reach past layer 5 to restyle a primitive, and a primitive may not encode a
screen's decision. A value missing from `components.json` is not drift: the config schema is
**strict** and rejects a property it has no field for, so the preset's radius, fonts and chart
palette live in `styles.css` as runtime values instead. The stylesheet is the one that runs;
[`frontend/ui-core/src/tokens.ts`](frontend/ui-core/src/tokens.ts) mirrors it for callers that
cannot read CSS (a `<canvas>`, a test), and `tokens.test.ts` asserts the two agree declaration
for declaration.

## shadcn Foundation

Preset `b2iH`, generated with shadcn CLI **4.19.0**, decodes to:

| Property | Value | Where it lands |
| --- | --- | --- |
| `style` | `nova` on the Radix base | `components.json` → `"style": "radix-nova"` |
| `baseColor` | `neutral` | `components.json` → `tailwind.baseColor` |
| `chart` | `neutral` | `styles.css` → `--chart-1` … `--chart-5` |
| `icons` | `lucide` | `components.json` → `iconLibrary` |
| `font` | `geist` | `styles.css` → `--font-sans: 'Geist Variable', sans-serif` |
| `heading` | `inherit` | `styles.css` → `--font-heading: var(--font-sans)` |
| `radius` | `medium` | `styles.css` → `--radius: 0.625rem` |
| `menu` | `inverted` / `subtle` | `components.json` → `menuColor`, `menuAccent` |
| `pointer` | on | `styles.css` base layer → `cursor: pointer` on pressable controls |

**What `components.json` can hold** is its whole current content: `style`, `rsc` (`false`),
`tsx` (`true`), `tailwind` (`config` empty, `css` `src/styles.css`, `baseColor` `neutral`,
`cssVariables` `true`, `prefix` empty), `iconLibrary`, `rtl` (`false`), the five `aliases`
(`@/components`, `@/lib/cn`, `@/primitives`, `@/lib`, `@/hooks`), `menuColor`, `menuAccent`,
`registries` (empty). **What it cannot hold:** the radius, either font, the chart palette, any
colour — `design_tokens.test.mjs` holds the file to that set, so nobody adds a documentary
field the CLI then rejects. Radix supplies behaviour under every primitive and Nova is the
styling on top; Base UI is an accepted official dependency for the same reason — shadcn's own
Combobox is Base UI-backed, and nothing else here uses it.

## Primitive Governance

> Components in the primitive layer preserve the API, anatomy, official variants, default
> variants, sizes, states, data attributes, accessibility behavior, and Nova styling generated
> by the configured shadcn foundation. VisionSet may add semantic variants only when they are
> additive and do not reinterpret an upstream variant. Product-specific compositions belong
> above primitives. A behavioral deviation from upstream requires a reproduced defect, a
> regression test, and an explicit SHADCN DEVIATION comment.

The primitive layer is exactly these twenty-one files: `alert`, `badge`, `button`, `card`,
`combobox`, `dialog`, `dropdown-menu`, `field`, `input`, `input-group`, `label`, `progress`,
`select`, `separator`, `sheet`, `skeleton`, `sonner`, `table`, `tabs`, `textarea`, `tooltip`.

**The snapshot gate.** `frontend/ui-core/shadcn/<name>.tsx` is the CLI's pristine output, and
`tests/scripts/shadcn_canonical.test.mjs` refuses any primitive that is not its snapshot **plus
added lines** — a removed line, a reworded class, a renamed prop all fail. Import paths are
relativised (`@/lib/cn` → `../lib/cn`, `@/primitives/x` → `./x`) because ui-core is compiled by
`tsc` rather than bundled with a path alias; the gate accounts for that rewrite and nothing
else.

**Allowed:** an added `cva` variant line whose meaning the foundation has no name for (today,
four on the Badge), and a framework adapter under *Allowed shadcn Deviations*. **Forbidden:**
changing an official variant's classes; renaming or dropping a subcomponent; adding a prop;
changing a default variant or size; touching focus, keyboard or `aria` behaviour; adjusting
geometry. Each of those belongs above the primitive — at a call site, or in a pattern.

## Composition Layers

- **Primitives** (`src/primitives/`) are shadcn's, governed above. They know nothing about
  datasets, frames or models.
- **Patterns** (`src/patterns/`) compose primitives into VisionSet shapes, and are where layout
  rhythm and product vocabulary meet.
- **Screens and the annotator** (`src/screens/`, `src/annotator/`) decide which pattern a page
  uses and what it says.

**No wrapper that merely renames.** A component whose whole body forwards props to one
primitive is a second name for the same thing, and the second name is what drifts: compose at
the call site, or add the pattern that earns its name by holding a decision. The rhythm that
follows — content under a `line` `TabsList` takes 16px — is applied in
`patterns/ProjectNav.tsx` (`mt-2` on its `TabsContent`), never in `tabs.tsx`.

## Color and Theme

shadcn's semantic names are the only vocabulary. There is no second layer (`surface`, `error`,
`foreground-secondary`) and no alias renaming what a token already means — `destructive` stays
`destructive`. Two roles are worth restating because they are the two that get confused:
`primary` is the one high-emphasis colour, and `accent` is the interactive hover/focus surface,
the token a row or a menu item lights up with and never what a button fills with.
`chart-1`…`chart-5` identify a series, never a status.

Both themes are declared in full, so switching theme is a variable swap. Every rule here is
written against a role rather than a light-mode value: "the page" resolves per theme and is
never asserted to be white.

**Retained VisionSet extensions**, each for a role the foundation has no name for: `stage` (the
neutral surround a photograph is judged against — distinguishable from both `background` and
`muted`, so a white asset edge still shows where it ends), `brand` (Robomous coral, identity
only), and `origin-hub` / `origin-custom` / `origin-robomous` (a model's provenance as a card's
accent edge — a mark, never a surface, ink or status; theme-stable like the chart palette).

The former `success` and `warning` tokens are **retired**, with their `-foreground` companions:
status colour is a Badge variant or `patterns/statusTone.ts`, so a status hue is spelled in one
place instead of two. `tests/scripts/design_tokens.test.mjs` re-checks the retired vocabulary
by an independent method from `tokens.test.ts`. **There is no `info` token** — the Badge has an
`info` variant and `statusTone.ts` an `info` ink, neither of which implies one; adding one is a
product decision to make here first.

### Where the brand is

Robomous coral is identity: the `AppShell` wordmark and its styleguide swatch. Two sites,
enumerated in `tests/scripts/design_tokens.test.mjs`. A functional control reaching for `brand`
is a semantic-colour violation however many other sites already use it correctly, and the gate
and this section move together or not at all.

### Menus and the inverted subtree

`menuColor: inverted` means every menu, select and combobox surface carries the literal `dark`
class, so a floating surface is the dark theme's `popover` whatever the page is doing. That is
contrast on purpose. The tooltip reaches the same intent without a subtree — Nova gives it
`bg-foreground text-background`, which flips by construction, because one line of text has no
palette of its own to keep in step. `menuAccent: subtle` means items highlight with `accent`,
the token every other hover state uses.

## Action Hierarchy

Six official Button variants, one intent each:

| Variant | Intent |
| --- | --- |
| `default` | The one dominant action in the view |
| `outline` | A supporting action that still reads as a control |
| `secondary` | A filled second weight, quieter than `default` |
| `ghost` | An action inside dense chrome — toolbars, rows, icon-only controls |
| `destructive` | The action that ends something |
| `link` | Navigation wearing a control's affordance |

Sizes are `default`, `xs`, `sm`, `lg`, `icon`, `icon-xs`, `icon-sm`, `icon-lg`. **One dominant
action per view**; which action that is on which screen is product behaviour
([`docs/content/ui/product-principles.md`](docs/content/ui/product-principles.md)).

**A status is not a step in the action hierarchy.** `success` describes an outcome, never a
control's emphasis, and there is no variant for it — a saved form reports itself with a toast or
a Badge while its button stays `default`. Three names a v1 call site may still reach for —
`primary`, `success`, `md` — **do not exist** here, and
`tests/scripts/shadcn_extensions.test.mjs` pins the variant and size lists exactly.

Every `<Button>` inside a `<form>` states its `type`: the canonical primitive adds no default
and HTML's is *submit*, so a Cancel with no `type` submits. `form_buttons.test.mjs` is the gate.

## Status and Feedback

- **Badge** — a state belonging to a row, a card or a heading, that stays on screen.
- **Alert** — a condition about the surface the reader is looking at, in place.
- **Sonner** (`Toaster`, mounted `position="bottom-right"`) — the outcome of something the
  reader just did, which does not need to persist.
- **Progress** — how much of a known quantity is done. It carries **no polarity**: there is no
  variant, and a failing job is not a red bar. The words beside it say what happened.

**Colour is never the only signal.** Every status carries a redundant channel — a word, an icon,
a shape. The product's status vocabulary and its mapping to product states is
[`docs/content/ui/product-principles.md`](docs/content/ui/product-principles.md#status-semantics).

## Badge Variants

Official: `default`, `secondary`, `destructive`, `outline`, `ghost`, `link`. VisionSet adds
exactly four, as four added `cva` entries, verbatim:

| Variant | Classes |
| --- | --- |
| `success` | `bg-emerald-500/10 text-emerald-700 focus-visible:ring-emerald-500/20 dark:bg-emerald-400/10 dark:text-emerald-400 dark:focus-visible:ring-emerald-400/40 [a]:hover:bg-emerald-500/20 dark:[a]:hover:bg-emerald-400/20` |
| `warning` | `bg-amber-500/10 text-amber-700 focus-visible:ring-amber-500/20 dark:bg-amber-400/10 dark:text-amber-400 dark:focus-visible:ring-amber-400/40 [a]:hover:bg-amber-500/20 dark:[a]:hover:bg-amber-400/20` |
| `info` | `bg-sky-500/10 text-sky-700 focus-visible:ring-sky-500/20 dark:bg-sky-400/10 dark:text-sky-400 dark:focus-visible:ring-sky-400/40 [a]:hover:bg-sky-500/20 dark:[a]:hover:bg-sky-400/20` |
| `quiet` | `bg-muted text-muted-foreground [a]:hover:bg-muted/80` |

Each is Nova's own `destructive` recipe on another hue: a `/10` surface, ink at `700` (`400` in
dark), a focus ring at matching opacity, a hover step for the anchor case. `quiet` is the one
that is not a hue — the absence of one, for a state that exists without asking for attention.

**Geometry is untouched.** The base string keeps its height, padding, type size, radius and
transparent hairline, and no added variant names a size, a radius or a border colour.

## Status Palette

One family, five roles: **emerald** settled, **amber** waiting on a person, **sky**
informational, **muted** no signal, **destructive** failed. Those three hues are the only ones
outside the semantic tokens, and the treatment is always **soft surface plus moderate ink** — a
`/10` fill with `700`/`400` text — so a chip carries a hue without competing with `primary`.

The `emerald`, `amber` and `sky` utilities are permitted in exactly three files:
`primitives/badge.tsx`,
[`patterns/statusTone.ts`](frontend/ui-core/src/patterns/statusTone.ts) and its test. A fourth
place naming the family is a fork of the palette, not a use of it. **No competing family** —
`green`, `lime`, `teal`, `yellow`, `orange`, `blue`, `cyan`, `red` — appears anywhere in
`frontend`. `tests/scripts/shadcn_extensions.test.mjs` holds both halves.

**Screen authors never pick a shade.** A status takes a Badge variant, or reads its colour from
`statusTone.ts`, whose utilities are written out whole rather than assembled — Tailwind scans
source text, so a class built at runtime is a rule the build never emitted:

| Export | Values | Use |
| --- | --- | --- |
| `StatusTone` | `neutral · accent · success · warning · destructive` | The type every tone-taking prop speaks |
| `TONE_BORDER` | `border-emerald-500 dark:border-emerald-400`, `border-amber-500 dark:border-amber-400`, `border-border`, `border-primary`, `border-destructive` | A tone's stroke, where the stroke is the mark |
| `TONE_FILL` | `bg-emerald-500 dark:bg-emerald-400`, `bg-amber-500 dark:bg-amber-400`, `bg-muted-foreground`, `bg-primary`, `bg-destructive` | A solid mark — a dot, a timeline cell — where the Badge's `/10` surface would vanish at 4px |
| `STATUS_INK` | `text-emerald-700 dark:text-emerald-400`, `text-amber-700 dark:text-amber-400`, `text-sky-700 dark:text-sky-400` | An icon or a run of inline text carrying a status |

## Alerts

The official anatomy, and only it: `Alert`, `AlertTitle`, `AlertDescription`, `AlertAction` — a
title is a child, never a prop. Variants are `default` and `destructive`; there is no
informational or settled Alert, because a condition worth interrupting the page for is either
neutral or bad.

An Alert's border is **structural**: `default` takes the card surface, and `destructive` keeps
that same surface, recolouring only the ink. No saturated surface, no coloured stroke. An Alert
that needs to shout is a copy problem.

## Surfaces, Borders, and Elevation

`background` is the page; `card` holds content that sits in place; `popover` holds anything that
floats and closes; `muted` recesses. A component picks one — it does not compose a fill.
Elevation is a ring plus a resting shadow, never a coloured border and never a gradient.

**Borders are structural**: a hairline separates or contains. **Status is not a stroke** — no
status is communicated by recolouring a border, which is why every added Badge variant keeps
`border-transparent`, and why `TONE_BORDER` exists only for marks whose whole body *is* the
stroke. `outline` on its own, Badge or Button, takes `border-border`, because `outline` means
"bounded", not "notable".

### Borders and focus

The base layer applies `border-border` and `outline-ring/50` to every element, naming the
outline's **colour only**. Focus *geometry* belongs to the component: one blanket
`:focus-visible` declaration in the stylesheet overrides every primitive's ring at once and wins
on layer order, so each focusable primitive carries Nova's own treatment instead. Focus is never
removed and never colour-only. `frontend/app/e2e/styleguide.spec.ts` measures the ring in a real
browser, because Tailwind renders it as a `box-shadow` layer.

## Typography

- **One family: Geist**, through `--font-sans`, bundled offline through
  `@fontsource-variable/geist`. No runtime fetch to a font host, ever.
- **`font-heading` survives as a hook, not a difference.** It resolves to `--font-sans`, so a
  heading is the same face at another size and weight; `h1`–`h4` carry it in the base layer, so
  a later preset that splits the families again lands in one declaration.
- **One justified technical role: `font-mono`**, on Tailwind's default stack. It marks
  machine-shaped content — identifiers, hashes, model references, measurements. Prose never
  wears it.
- Size and weight come from the primitive, or from Tailwind's ordinary scale. There is no
  VisionSet type-scale token: `--text-page`, `--text-section`, `--text-body` and `--text-meta`
  are retired, and `design_tokens.test.mjs` keeps them retired.

## Density, Spacing, and Radius

Two scales answer two questions, and conflating them is the anti-pattern this section exists to
prevent. **Component geometry is Nova's**, fixed per control by the foundation: a control's
height, padding and internal gaps are not a per-screen choice, and this document does not
restate them — `src/primitives/` carries them and the snapshot gate holds them. **Page and
layout rhythm is VisionSet's own composition**, on Tailwind's ordinary spacing scale: `p-6`,
`gap-4`, `space-y-8`, and the pattern layer's `mt-2` under a `line` tab bar. Dense where the
content is plural — data surfaces show more of the thing the reader came for; generous where
prose and forms are read one thing at a time.

**Radius is a runtime value, not a config field.** The preset's `radius: medium` materialises as
`--radius: 0.625rem` (10px) in `styles.css`, mirrored by `tokens.ts` and pinned by
`tokens.test.ts`; `components.json` holds no radius field because the schema defines none. Every
other step derives from `--radius` in `@theme inline` (`radius-sm` at `× 0.6` through
`radius-4xl` at `× 2.6`), and no arbitrary radius appears outside that scale.

## Icons

`lucide-react` is the set, and the only one. No package declares a second icon library, and
`tests/scripts/design_tokens.test.mjs` refuses one that reappears in a manifest or an import.
The rule is *one* set rather than one particular set — what costs a reader is two of them on a
screen, where the same idea arrives at two weights and two grids. Changing which one is a
decision to make here, not a dependency to add. Icon size comes from the primitive that contains
the icon; a call site does not resize an icon to fit a control it did not measure.

## Motion

Motion orients or confirms, and never stands between somebody and their next action. An
**enter** animation is free to play: the surface it introduces did not exist a frame ago, so
nothing is waiting on it. An **exit** animation is not, and the difference is not taste.

**A menu leaves on the frame it is dismissed.** While Radix runs an exit animation the content
stays mounted and the dismissable layer with it, so a press meant to open the next menu is read
twice — as the open, and as an interaction outside the closing surface — and the two cancel. At a
100ms exit that window covers the gap between an `Escape` and the click after it, which a fast
hand meets routinely. Canonical `dropdown-menu.tsx` animates out like any other floating
surface and the snapshot gate holds it there, so the rule is a **call-site constant**, not a
primitive edit: every
`DropdownMenuContent` applies `menuSurface`
([`frontend/ui-core/src/lib/menu.ts`](frontend/ui-core/src/lib/menu.ts),
`data-closed:animate-none! w-auto`). Both halves are one rule — a menu that behaves like a menu —
and travel together, `w-auto` freeing the surface from canonical's trigger-width pin, which
behind an icon-sized button leaves a 128px floor every longer item wraps against. A surface whose
trigger cannot be pressed again straight away — a dialog's, a tooltip's — keeps its exit animation
and never takes the constant. `TooltipProvider` defaults `delayDuration` to `0`; a screen wanting
Radix's debounce sets it on the provider.

`prefers-reduced-motion` sits above all of this: the base layer collapses every animation and
transition to a single frame under that query, so no component opts in.

## Accessibility

- **Semantic HTML.** Real `<button>`/`<a>`, native controls, lists as lists, one `<h1>` and a
  meaningful hierarchy under it.
- **Keyboard parity.** Everything a pointer can do, the keyboard can do — logical tab order,
  arrow-key movement inside composite widgets.
- **Focus is always visible**, per *Borders and focus*: never removed, never colour-only.
- **No colour-only communication.** Status, selection, validity and provenance each carry a
  redundant channel.
- **Field anatomy carries the wiring.** `Field`, `FieldLabel`, `FieldDescription`, `FieldError`,
  `FieldGroup`, `FieldSet`, `FieldLegend`, `FieldContent`, `FieldTitle`, `FieldSeparator`: a
  description and an error are subcomponents, so `aria-describedby` and `aria-invalid` come from
  the primitive rather than from a screen remembering.
- **Dialog and Sheet keep their official anatomy** — trigger, overlay, content, header, title,
  description, footer, close. Focus trap and return, `Escape`, and the labelled-by relationships
  are Radix's guarantees, which is why no primitive here is hand-rolled from a `<div>`.
- **Never disable without explanation** stays as the product principles state it
  ([`docs/content/ui/product-principles.md`](docs/content/ui/product-principles.md#principles));
  this document fixes only disabled's look.

## Product-Specific Extensions

Everything VisionSet owns above the foundation, in one list:

| Extension | Where | Rule |
| --- | --- | --- |
| `stage` | `styles.css`, `tokens.ts` | The annotator's surround. Usage: [`docs/content/ui/annotator.md`](docs/content/ui/annotator.md#the-stage) |
| `brand` | `styles.css`, `tokens.ts` | Identity only — see *Where the brand is* |
| `origin-hub` / `origin-custom` / `origin-robomous` | `styles.css`, `tokens.ts` | A model's provenance, as a card's accent edge. A mark: never a surface, never ink, and an origin is a kind rather than a state, so these never stand in for a status |
| Badge `success` / `warning` / `info` / `quiet` | `primitives/badge.tsx` | Four added lines — see *Badge Variants* |
| `statusTone.ts` | `patterns/` | The one home for status colour outside the Badge |
| `menuSurface` | `lib/menu.ts` | The call-site menu constant — see *Motion* |
| `--spacing-sidebar` / `--spacing-sidebar-collapsed` | `styles.css` `@theme inline` | 240px and 48px, consumed by `AppShell`, its collapse toggle and the content offset, which must agree or the layout jumps on collapse. The collapsed width is the preset's own icon-sidebar width, so with the rail's `p-2` it holds exactly one `size-8` control per row |
| Patterns | `patterns/` | `AsyncStates`, `BackLink`, `ClassFields`, `DataDisplay`, `ErrorBoundary`, `ExportTargetSelect`, `PaddedContent`, `ProjectEyebrow`, `ProjectNav`, `ProjectShell`, `RecipeEditor`, `RecipeList`, `SectionHeader`, `StaticAnnotationOverlay`, `StepMarker` |

The navigation rail follows the theme on the eight `sidebar-*` tokens — light in the light theme,
dark in the dark one, never a hardcoded dark surface independent of the switch. Layout adapts by
reflowing, not by amputating: standard breakpoints 640 / 768 / 1024 / 1280, content and controls
reachable at every supported size, text wrapping rather than truncating unless the value is
re-readable elsewhere, touch targets comfortable (44px-order) whatever the pointer. The rail's
own collapse behaviour is [`docs/content/ui/navigation.md`](docs/content/ui/navigation.md).

Anything outside this list is not an extension; it is a diff against this document.

## Allowed shadcn Deviations

**Policy.** A behavioural change to a primitive requires all three of: a **reproduced defect**
(not a preference, not a hypothetical), a **regression test** that fails on the canonical file
and passes on the changed one, and an explicit `SHADCN DEVIATION` comment naming the defect.
Absent any one of them, the change belongs at a call site.

**Current list: none.** No primitive carries a `SHADCN DEVIATION` marker. The historic
DropdownMenu rapid-reopen patch was retired — its rule lives in `menuSurface` at the call site,
and `frontend/app/e2e/annotate.spec.ts`'s "the overflow reopens on a press straight after
Escape" passes on the canonical file.

**Framework adapters are a separate, narrower category.** A primitive may replace an upstream
integration that assumes a framework VisionSet does not run, and nothing else. There is exactly
one: `primitives/sonner.tsx` replaces shadcn's `next-themes` `useTheme` — a Next.js integration
— with a hook reading `.dark` on `<html>`, VisionSet's one theme source under Vite. It carries a
`SHADCN FRAMEWORK ADAPTER` comment, it is the only entry in `FRAMEWORK_ADAPTERS` in
`tests/scripts/shadcn_canonical.test.mjs`, and the gate names the exact snapshot lines it may
remove. An adapter is not a licence for divergence in general, and the marker on an unlisted
file fails the gate.

## Updating shadcn Components

Install or refresh from inside Docker:

```
pnpm --filter @visionset/ui-core shadcn:add <name>
```

That writes the CLI's pristine output to `frontend/ui-core/shadcn/<name>.tsx`, then relativises
the import paths in `src/primitives/<name>.tsx`. The CLI version is pinned at **4.19.0** in the
installer, matching the `shadcn` dependency in `frontend/ui-core/package.json`, so a refresh
cannot quietly move the foundation. `shadcn add <name> --diff` reports what upstream changed; it
is inspection only.

**Accept upstream by default.** A refresh that changes a class, a size or an anatomy is the
foundation moving, and VisionSet follows it — keeping the primitives canonical is what makes that
a routine update rather than a merge. `shadcn:add` itself runs `--overwrite --yes`, so the
discipline is not to withhold the flag but to know what it will replace: **`add --diff` first,
then reapply** the additive lines this document names (today, only the Badge's four), re-run the
gates below, and check the visual baselines. An overwrite that drops those four lines, or the
sonner adapter, type-checks and fails the gate — the gate doing its job, but the diff is easier to
read before the fact than after.

Rendered to look at: `pnpm --filter @visionset/app dev`, then the `/styleguide` route.

## Verification

| Gate | Holds |
| --- | --- |
| `tests/scripts/shadcn_canonical.test.mjs` | Every primitive is its snapshot plus added lines; the framework-adapter allow-list |
| `tests/scripts/shadcn_extensions.test.mjs` | Button's variants and sizes exactly; the Badge's four additions and their classes; the status palette's three files; no competing colour family; no retired v1 vocabulary |
| `tests/scripts/design_tokens.test.mjs` | No colour in a class string; `components.json` within the schema-supported set; `brand` confined to its two identity sites; the retired token vocabulary; one icon library |
| `frontend/ui-core/src/tokens.test.ts` | `styles.css` and `tokens.ts` agree declaration for declaration, and no retired token has returned |
| `tests/scripts/docs_links.test.mjs` | Every link and `#anchor` in every tracked Markdown file resolves — this document included |
| `tests/scripts/form_buttons.test.mjs` | Every `<Button>` inside a `<form>` states its `type` |
| `frontend/app/e2e/visual.spec.ts` | The rendered result, against Linux baselines — see [`docs/content/architecture/frontend/visual-baselines.md`](docs/content/architecture/frontend/visual-baselines.md) |

A rule in this document that no gate holds is a rule under review, not an exemption.
