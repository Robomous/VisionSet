# VisionSet design foundations

The design system — the shadcn Nova foundation, its tokens, the primitive governance, the
status palette, and the gates that hold all of it — lives in
[Robomous/ui-core](https://github.com/Robomous/ui-core), consumed here as `@robomous/ui-core`.
That repository's `DESIGN.md` is the governing document; what follows is only what is
VisionSet's own: the extension registry, where the brand paints, the interaction patterns
VisionSet's screens share, and which gate holds each rule in this repo.

## VisionSet extensions

Everything VisionSet owns above the foundation, each following shadcn's extension convention —
a value in `:root`, a dark counterpart in `.dark`, exposure through `@theme inline` — in
`frontend/ui-core/src/styles.css`, mirrored by `src/tokens.ts`:

| Extension | Rule |
| --- | --- |
| `stage` | The annotator's surround — the neutral a photograph is judged against. Its own role: not `muted`'s subtle fill, not `card`'s surface, distinguishable from `background` so a white asset edge still shows where it ends. Usage: [`docs/content/ui/annotator.md`](docs/content/ui/annotator.md#the-stage) |
| `origin-hub` / `origin-custom` / `origin-robomous` | A model's provenance, as the small square beside its origin on the Models table. A mark: never a surface, never ink, and an origin is a kind rather than a state, so these never stand in for a status. Theme-stable, like the chart palette |
| `--container-page` | The 96rem page cap — read by `PaddedContent`, a reusable VisionSet surface |
| `--page-inset-bottom` | Not a declared token: a variable a host sets to the height of chrome it pins to the viewport's bottom, read by the gallery's sticky bulk bar so it floats above it, and by the Images section to fit the window. Unset means 0 |
| `--page-inset-top` | Not a declared token: the same for chrome a host pins to the viewport's top (the standalone app's tab strip), read by the Images section so its pane takes exactly the height between the two. Unset means 0 |

A layout value lives with whoever reads it. The rail's two widths, `--spacing-rail` (48px,
collapsed) and `--spacing-rail-expanded` (208px), are declared in `frontend/app/src/styles.css`
instead of here: `AppShell` is their only reader. Collapsed, the rail holds exactly one 40px-wide,
36px-tall control per row inside a 4px inset. A host mounting VisionSet's screens brings its own global
navigation, so nothing reusable reads the standalone shell's rail widths.

An extension that turns out to be universal is a candidate to move into the package — that is
a design decision and a PR against Robomous/ui-core, with the justification written into its
`DESIGN.md`.

## VisionSet patterns

Interaction patterns the screens share that the foundation does not define. Each is carried by
a component — in `frontend/ui-core/src/patterns/` when several screens use it, beside its screen
when one does — so a screen applies the pattern by using the component rather than restating
its rules.

### Info buttons

**What a choice means beyond its label goes behind an info button beside the label — not in
helper text under the field.** A form row stays one line tall, so the rows of a form read as one
column of labels and one column of controls, and the explanation is one hover or one Tab away.
The pattern is `InfoTip` (`patterns/InfoTip.tsx`), placed with `PropertyRow`'s `labelAction`:

```tsx
<PropertyRow
  label="Model"
  htmlFor="recipe-target"
  labelAction={
    <InfoTip label="About this model" title={target?.label ?? "Any model"}>
      classify · detect · segment. Letterboxes to 640 on its own.
    </InfoTip>
  }
>
  <ExportTargetSelect id="recipe-target" compact … />
</PropertyRow>
```

| Rule | Why |
| --- | --- |
| **Beside the label, outside it.** `labelAction` puts the button right after the label text, in the label column. Never inside the `<label>`, and never at the row's end or under the control. | A label may hold no interactive content of its own, and its truncation would clip the button's focus ring. At the row's end the button takes width from the control and breaks the right edge every control in the form shares. |
| **The card is a title and a line or two.** The title is the answer in a few words (*Training split only*, *Mirrors left to right*, the model's tasks); the body says the rest. Never what the row already shows — not the label, not the selected value. | One glance answers it. A card that needs a third paragraph is a page of documentation, not a hint. |
| **It says the current state.** The model's card gives the chosen model's tasks and fit; it changes with the choice. | A card that explains the field in general, while the field holds a specific value, answers the wrong question. |
| **Said once.** What a card says is not also a line beside the control: the row is the label and the control, and the card is where the explanation lives. A screen reader gets the same words as the control's description (visually hidden), since it reaches the card only through the button. | Two places saying one thing is twice the reading and two copies to keep true. |
| **Supplementary only.** Never the only place for something a person needs to proceed: a problem that holds an action is said where the form says problems (in the recipe modal, between Previous and Next), with the field pointing at it through `aria-describedby`; a reason a control is disabled is said beside the control. | A card is opened by choice. What blocks the person must reach them without one. |
| **No interactive content in the card.** No links, no buttons. | It is a tooltip: the pointer cannot enter it, and the keyboard never lands in it. Something that needs a link is a popover, a different pattern. |
| **Reachable without a pointer.** A real button (`ghost`, `icon-sm`, muted), named *About &lt;the field&gt;*; the card opens on hover and on focus and Escape shuts it; while open it is the button's description. | The keyboard and a screen reader get the same explanation the pointer does. |
| **The icon does not dim with its row.** When a row does not apply and its label dims (*Variants* with nothing switched on), the info button keeps its colour. | What the field is for is still worth knowing — often most when the field is off. |
| **The foundation's tooltip, as it is** — unless the card carries a drawing (below). Its inverted surface and its own enter and exit; `max-w-64`; the title in medium weight, the body at `text-background/70`; opened from the button's start edge (`side="top"`, `align="start"`), so it lies over the label column, not the control it explains. | One card look across the product, and no second motion vocabulary. |

### Illustrated info cards

**When a choice's effect is easier seen than read, its info card carries a drawing.** The pattern
is `ArtTip` (`patterns/ArtTip.tsx`): every rule of an info button above holds — beside the label,
the current state, supplementary, nothing interactive, reachable by focus, Escape shuts it —
except the surface. A drawing needs the surface it was drawn for, so the card is the popover's
light surface, `w-52`, `rounded-xl` over `p-1.5`: the drawing on a `bg-muted/50`, `rounded-md`
panel exactly as tall as the drawing (`px-2.5 py-2`, the drawing at full width), then the title
and a line or two. No fixed panel height: an empty margin around a drawing is space the card
spends saying nothing. The recipe's augmentations and variants use it;
the model's card, which is words, keeps `InfoTip`.

- **The first card waits 400 ms and scales in from its button** (0.96 to 1, 150 ms, strong
  ease-out); one asked for within 300 ms of another closing is there at once and without motion,
  and a card always closes without motion, so running down a column of buttons never shows two.
- **The drawing is decoration.** It is hidden from assistive technology; the title and the line
  say everything it shows.

### Drawings

A drawing explains a behaviour; it is never a preview of the person's own data. VisionSet draws
in one vocabulary, the empty states' (`patterns/EmptyArt.tsx`), and the recipe's drawings
(`screens/dataset/recipe/art.tsx`) follow it:

| Rule | Why |
| --- | --- |
| **A photograph is two hills and a sun in the surface's own greys; the one colour is the annotation box, in `info`.** | What a person decides about an image is what happens to their labels, so the box is the thing to watch — and one accent says which part matters. |
| **Show the result, not the control.** An augmentation is drawn as original → result; a fit as the photograph meeting the frame, the padding hatched. | The drawing answers "what will this do", which is the decision. |
| **One cue per idea, and only where the result alone is ambiguous.** Flip's result carries its dashed mirror line; Rotate's arrow turns where the others' run straight; brightness shows one darker and one lighter result. Nothing else is added. | A drawing earns clarity by subtraction: each extra mark is something else to read. |
| **Drawn to its own edges.** A drawing's box ends where its marks end, so the container sizes to it. | Margins inside a drawing become dead space around it. |
| **Elevation is a layered shadow, never an outline** — a hairline and two soft shadows, pure black, and in dark a pure white hairline. | The edge exists only to lift the card; a tinted neutral would pick up the surface under it. |
| **A drawing that is always on screen sits on a stage**: the `stage` ground, one product surface on it running off its end and bottom edges, a mono caption naming what is drawn. The recipe's *Resize* step is the one such place. | It reads as a glimpse of the product rather than a framed picture, and the caption says in words what changed. |
| **It follows the choice, and the option under the pointer or focus before it is chosen.** | Seeing an option before choosing it is the point; leaving the option hands the drawing back to the choice. |
| **Every change is a transform or an opacity on a part that is always there** (240 ms, strong ease-out), none under reduced motion. | A choice changed mid-move turns the drawing around where it is, and nothing re-mounts. |

### A row that belongs to another

A row that exists only because of the row above it — brightness's *Amount* under its switch — is
drawn as its child: its label indented 20px (`PropertyRow`'s `nested`), tucked 6px under the
parent, and a branch (`border-s` and `border-b` at `foreground/20`, a 5px elbow) running from under
the parent's label to the child's. The branch is hidden from assistive technology; the order of
the rows already says it.

### Detail cards in a list

**When a list's options need more than their name, the list shows names alone and the
highlighted option opens a card beside it.** The list stays scannable, and the detail is there
for the option being considered. The pattern is `ExportTargetSelect`'s `compact` form
(`patterns/ExportTargetSelect.tsx`); the card is the same title-and-lines card as above.

- **The card follows the highlight, for pointer and keyboard alike.** Radix moves a list's
  highlight by focusing the option, so the card is opened from the option's focus and blur —
  never from hover alone, which the keyboard cannot reach.
- **The first card waits, the next ones do not.** The first opens after 400 ms; once one has
  shown, the next follows the highlight at once and without motion — its enter and exit are
  switched off — so scanning the list is not a flicker of cards and two cards never overlap.
  Closing the list starts the wait again.
- **One Escape closes the list, card and all.** The card is not a layer of its own to dismiss:
  an Escape that reaches it closes the list, exactly as it would without the card.
- **A screen reader hears the detail with the option.** The card is visual; the same words are
  in the option as visually hidden text, so the option's accessible name carries them.
- **The card's anchor is the whole row, not the option itself.** An invisible, full-row span
  inside the option anchors it. A tooltip trigger wrapped around a Radix option would overwrite
  the option's own `data-state`.

### States

**A state is a chip: a tinted ground, a glyph that fills as the thing nears done, and the
word.** The pattern is `StateChip` (`patterns/StateChip.tsx`), with the states themselves
computed off the wire as plain functions beside the screen that shows them
(`screens/dataset/states.ts`).

| Tone | Glyph | Ground and ink | Reads as |
| --- | --- | --- | --- |
| `draft` | a dashed ring | `muted` / `muted-foreground` | not started, nothing to do, not asked — *Not verified*, *Same as v0.4* |
| `progress` | a pie, filled to the real fraction when there is one | `warning/10` / `warning` | partway — *40 of 48 labeled*, *Exporting 12/48* |
| `review` | a pie at three quarters, or the fraction | `info/10` / `info` | something to look at — *Changed since v0.4*, *1 of 2 classes used* |
| `done` | a filled check | `success/10` / `success` | done — *Intact*, *All labeled*, *Downloaded* |
| `failed` | a filled mark | `destructive/10` / `destructive` | failed — *Problems found*, *Failed* |

| Rule | Why |
| --- | --- |
| **The glyph carries the state, the word names it.** The icon-only form keeps the word as its accessible name. | A chip reads at a glance before its word is read, and the icon-only form still says it. |
| **The glyph is the only icon a fact gets.** | A state's icon is information; any other icon beside a fact is decoration. |
| **What a state means beyond its word is its card** — a title and a line or two, on hover and on focus (the chip takes focus when it has one). Where the words beside an icon-only chip already say the title, the card drops it (`linesOnly`). | Said once, as an info button's card is. |
| **`cancelled` is `draft`, not `failed`.** | Somebody asked for it: a decision is not an error. |

### Fact sections, and the action a thing is opened for

**What a thing is, and what is done with it, sit in one column of sections — the action is a
section too, not a dialog.** A section is a small heading, the answer under it, and the action
that belongs to it at the heading's end; a section with more to show opens in place. The work
the thing is opened for is one of those sections, open by default, with its controls inside it
and its progress as its answer. The pattern is the Dataset's version facts
(`screens/dataset/VersionFacts.tsx`): a release reads *Contents*, *Integrity*, *Manifest*, then
*Export* — the model, the recipe and the button — above the versions it was picked from.

```text
CONTENTS ⌄                                    one line: the answer
48 images · 427 annotations
─────────────────────────────────────────
INTEGRITY                            Verify   the action rides the heading's line
◌ Not verified                                the answer is a state
─────────────────────────────────────────
MANIFEST                           Download
2e32c95def12b538 ⧉
─────────────────────────────────────────
EXPORT ⌃                                      open by default
✓ Downloaded                                  the work's state is the answer
Model    [ YOLO11                    ⌄ ]      28px, names only, detail on highlight
Recipe   ( ) No recipe
         (•) yolo12-640-aug4    Edit Delete   the chosen row's actions, as words
             New recipe                       the last row writes one
[               Export               ]        the view's one filled control
```

| Rule | Why |
| --- | --- |
| **The heading answers.** Its second line is the answer in a few words — *48 images · 427 annotations*, a state chip, a hash — so a folded section still says what it holds. | The column is read by its headings; the detail is one click down for whoever wants it. |
| **A section opens only when it has more to show.** Then its heading is a toggle (`aria-expanded`, a chevron that turns); otherwise it is only words. | A row that pretends to open and does not is a lie the pointer finds out. |
| **A section's action rides its heading's line, outside the toggle** — a quiet text button (`ghost`, `sm`, `text-xs`): *Verify* beside Integrity, *Download* beside Manifest. The answer under it keeps the column's whole width. | The action sits by the fact it acts on, and a button never nests inside the toggle. |
| **The action a thing is opened for is a section, open by default, last** — not a dialog over the page and not a button in the project bar. Its controls are inside it; its one filled button spans the column, and it is that view's one filled control, so the bar draws nothing beside it. | It is read with the facts it depends on, and nothing has to be opened to reach the thing the page is for. |
| **The work's state is the section's answer** — *Not exported this session*, then *Exporting 12/48*, then *Downloaded* — so folding the section never hides how it is going. | A job's progress is a fact about the thing, like its integrity. |
| **The form lives above the column, not in it.** The section only lays out what the form hands it (`ExportForm`, a render prop), so folding the section — or anything else the column does — never stops a job. | Layout and work have different lifetimes; a fold must not cancel an export. |
| **What the action needs is chosen inside it.** A recipe exists for an export, so it is chosen in the Export section: a list, the chosen row's *Edit* and *Delete* as words, and a last row that writes a new one. Writing opens its own dialog over the page — one deep, never a dialog over a dialog. | A thing chosen where it is used needs no shelf of its own, and a single modal is a single place to be. |
| **Controls are the app's size and labels share one column** — 28px controls, a 5.5rem label column, names alone in lists with the detail on the highlighted option (*Detail cards in a list*). | The section is a form among facts; it reads as one column of labels and one of values. |
| **Problems are sentences in the section, under what they are about** — a refusal, a consent the format asks for, a download that failed — and a stale report never stays under a failed one. | The person finds the reason where the action is (`ui-capabilities`: no swallowed refusal). |
| **One scroll for the whole column.** The sections and whatever lies under them scroll together. | A second scrollbar inside the column hides the action at its foot. |

### One image detail

**An image opens in the same detail wherever it is opened.** The Images section's
`ImageDetail` (`screens/images/ImageDetail.tsx`) — its well, header, arrows and focus mode —
is the Dataset's too; what only a surface knows comes in through its two openings, `overlay`
(drawn over the picture, in a box exactly the picture's) and `children` (under the picture's
own facts). A second viewer for the same picture is a second set of keys, sizes and words to
keep true.

## Where the brand is

Robomous coral is identity: the VisionSet logo — drawn once, in `frontend/app/src/shell/Brand.tsx`,
as the icon on the rail and as the full logo on the sign-in screen — and its styleguide swatch. Two sites,
enumerated in `tests/scripts/design_tokens.test.mjs` (the package exposes no `bg-brand`, so a site
paints with `var(--brand)`). A functional control reaching for `brand`
is a semantic-colour violation however many other sites already use it correctly, and the gate
and this section move together or not at all.

## Verification

| Gate | Holds |
| --- | --- |
| `frontend/ui-core/src/tokens.test.ts` | The extension stylesheet and token module agree declaration for declaration; no extension shadows a foundation name |
| `frontend/{ui-core,app}/eslint.config.js` | No colour inside a class string (`bg-[#fff]`, `ring-[var(--x)]`); the package closes Tailwind's default palette, so a named one produces no CSS |
| `tests/scripts/design_tokens.test.mjs` | `brand` confined to its two identity sites; one icon library; no `tailwind.config.js` |
| `frontend/ui-core/src/screens/preprocessing.test.tsx` | The resize's stage draws the chosen fit and the one pointed at, and is hidden from assistive technology; each augmentation's illustrated card opens beside its label, says it in words, and one Escape closes only it; the amount's branch is decorative. The recipe's info buttons open on hover and say the current choice; the model list shows names alone, opens a card on the highlighted option, and one Escape closes both. Where an info button sits on other screens is held by review, not a gate |
| `frontend/ui-core/src/screens/dataset.test.tsx` | A release's export is a section of its facts — open, last, holding the model, the recipe and the button — and Publish is the project bar's on the working copy only; the section's answer is the job's state, and the job keeps going while the section is folded; verify and download failures are sentences, and a stale report leaves; the recipe is chosen in the section, its writer opens as a single modal, and a delete asks first and falls back to no recipe. How the heading, its action and the answer are laid out is held by review |
| `frontend/ui-core/src/screens/screens.test.tsx` | The Dataset keeps one filled control: Publish release in the bar on the working copy, and on a release none in the bar — its export's button in the column |

The foundation's own token and palette gates run in `Robomous/ui-core`. A rule no gate holds is a rule under review, not an exemption.
