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
| `--page-inset-bottom` | Not a declared token: a variable a host sets to the height of chrome it pins to the viewport's bottom, read by the sections that fit the window (Overview, Images, Classes, Dataset and Models) and by the Classes commit bar, which floats above it. Unset means 0 |
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

### Warnings

**What is true of a field and worth knowing, but holds nothing back, is a warning glyph beside
its label — never a sentence under the field.** A format that cannot carry every shape, images
exported without labels, a class nobody labelled, a schema a publish would move to. The pattern
is `WarnTip` (`patterns/WarnTip.tsx`): `InfoTip`'s shape in the warning colour and glyph, so
"here is something to know" reads apart from "here is what this means" at a glance. A KPI cell
carries one in its label row (`KpiCards`' `warning`).

```text
⌗ Model ⚠   [ YOLOv10                 ⌄ ]    the glyph beside the label; the card on hover and focus
            ┌──────────────────────────────┐
            │ YOLOv10 cannot take every-   │    the title: the warning in a few words
            │ thing the schema allows      │
            │ The export asks before it    │    a line on why it matters
            │ drops a shape.               │
            └──────────────────────────────┘
```

| Rule | Why |
| --- | --- |
| **Beside the label, outside it**, as an info button is; in a KPI, at the label row's end. | The row stays one line, and the glyph sits by what it is about. |
| **`TriangleAlert`, in `warning`, a real button** — 24 or 28px drawn, a 40px hit area, no fill until hovered. Its name is *Warning:* and the title; its description is the rest, so a screen reader hears both without opening the card. | A warning is never only a colour, and the keyboard reaches what the pointer does. |
| **The card is a title and a line** — the warning in a few words, then why it matters or what happens next. Nothing interactive. | One glance answers it, and a tooltip takes no focus. |
| **Only what holds nothing back.** A problem that blocks an action — a consent the format asks for, a refusal — stays a sentence where the form says problems. | A card is opened by choice; what stops the person must reach them without one. |

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

### Paging a table

**A table that has more rows than a screen is paged, client-side, over the rows it already
filters and sorts.** The pager is `patterns/TablePager.tsx`, its arithmetic is
`patterns/pagination.ts` (`usePagination(rows, { pageSize, resetKey, reveal })`), and no query or
API changes: a table that can grow past a page pages, and a gallery that already loads one source
at a time (the Images section) does not. It comes in two forms, by what the table is to its page.

| Form | When | Where | Says |
| --- | --- | --- | --- |
| **Footer** (`TableFooter`) | the table is the whole page or section — Projects, Models, the Classes section; 25 to a page | a bar under the table: `h-12 shrink-0 border-t` (below `sm` it wraps to two lines and drops the page-size choice), `muted` at 40% mixed into the background, `text-xs text-muted-foreground`, the page's inset | at the start, *26–50 of 312 projects* (the range in `font-medium text-foreground`, tabular figures), plus *· filtered from 400* when a filter narrows it and *No projects match* when it leaves none; at the end *Rows per page* with a compact select (10 / 25 / 50 / 100), *Page 2 of 13* and four steps « ‹ › » |
| **Inline** (`InlinePager`) | the table sits inside a page — the Overview's Batches; 10 to a page, no rows-per-page choice | the table's own header band, after its filter | *Page 2 of 9* and ‹ › — small steps |

- **The step is one recipe.** A bordered square — `size-7` in the footer, `size-6` inline —
  `rounded-md border bg-background shadow-xs`, icon `size-3.5`, hover `bg-muted`, pressed
  `active:scale-[0.97]`, `transition-[background-color,scale] duration-100 ease-out` and none under
  `motion-reduce`. A step that cannot go anywhere is faded (`text-muted-foreground/40`), shadowless
  and does not press, and has no tooltip; an enabled one is named by its tooltip — *First page*,
  *Previous page*, *Next page*, *Last page*. The steps are ordinary buttons: no shortcut is bound
  to them.
- **A table of one page has nothing to page.** The inline pager draws nothing; the footer stays,
  because it is also the table's count.
- **The footer stays; the table scrolls.** In a fitted pane the table's frame scrolls above it. Where
  the document scrolls it sticks above the status bar (`--page-inset-bottom`), opaque, so rows pass
  beneath it.
- **A page change returns to the table's top, instantly.** Its own scroller goes to the top, and a
  table the document had scrolled past is brought back under the tabs. Never a smooth scroll: paging
  is frequent. Changing *Rows per page* keeps the page that holds the first visible row.
- **A narrower view starts at the first page.** The filter, lens and sort feed `resetKey`; rows that
  shrink under the reader clamp to the last page that exists.
- **A row named from outside is on the page shown.** The URL's open batch, the panel's own *J* and
  *K*, a class a review line opens, the row focus returns to: `reveal` brings the page holding it.
  Walking rows with the arrow keys stays within the page.
- **A count is said once.** The footer says how many rows and of how many; the status bar keeps what
  the rows add up to (*13 images · 11 to annotate*, *3 ready*), over every row the filter leaves and
  not only the page on screen.

### A line that offers work

**When the product could do something for the person, it says so once, in a line, and only while
there is something to do.** The one so far is the Overview's auto-label offer
(`screens/AutoLabel.tsx`, its reading in `screens/autoLabelOffer.ts`, its state in
`screens/useAutoLabel.ts`): a line between the Batches band and the table while images nobody
has labeled sit in batches that declare `pre_label`.

```text
┌ ▢ Batches  3 ───────────────────────────────── [▣ All Open In dataset] [⌕ Filter /] ┐
│ ⧉ 233 images have no labels yet. A model can draft them…   [✦ Auto-label them]  ✕  │  h-11, muted/40
├ Name ─────────── State ──────── Labeled ──────── Jobs ──────────────────────────────┤
          Not now ↓   the wand travels into the band and becomes the icon
┌ ▢ Batches  3 ─────────────────────────────── [✦] [▣ All Open In dataset] [⌕ Filter /] ┐
```

| Rule | Why |
| --- | --- |
| **The line is `h-11 border-b bg-muted/40`, the page's inset, `text-sm`**: a boxed icon (`size-6 rounded-md bg-background shadow-xs ring-1 ring-foreground/10`), the count in `font-medium tabular-nums` and the rest muted, then an outline button that names the verb and its object (*Auto-label them*) and a ghost ✕ named *Not now*. | One sentence a person reads without stopping, and one press to act on it. |
| **It is there only while there is work.** Nothing waiting, no line. Where the action is declared but nothing is waiting, the band keeps a quiet outline icon button for it. Where nothing declares it, neither. | An offer that is always there is furniture; legality is the wire's (`ui-capabilities`). |
| **Put away, it goes into the band, and is remembered against its number.** *Not now* is kept per project (`data/prefs`) with the count it was said to; the line returns only when more is waiting than that. | Dismissing is "not these", not "never": new work earns a new offer, the same work does not. |
| **It arrives and leaves; it is never animated in on load.** It stays mounted and opens by its grid row (`0fr` → `1fr`) with its words fading in and rising 4px, 220 ms on the strong ease-out; it closes the same way in 180 ms, and the table follows its height. CSS transitions, so a change mid-way turns around where it is. A page that loads with the line already there just shows it. | Motion says something changed; on load nothing did. |
| **Put away, it morphs.** The wand on the line's button flies — a FLIP on the Web Animations API (`lib/motion.ts`: `flipFirst` before the change, `flipPlay` after it) — onto the band's icon, 260 ms on `cubic-bezier(0.32, 0.72, 0, 1)`, fully drawn the whole way. The button's surface, its words gone in the first 100 ms, shrinks into the icon's box and blurs out (`blur(2px)`) while the icon's own surface fades in there; the line closes under it. The icon itself never moves, so pressing it mid-flight lands. Cancelled when the line comes back or the page goes. | The person sees where the offer went, so the icon is not a mystery later. |
| **Left any other way — a run started, so nothing waits — it closes without a morph** and the band's icon fades in. | The morph answers a press; a change from the wire only moves what must. |
| **Under reduced motion only opacity changes**: the line's words fade, its row opens at once and closes once they have faded, and the icon fades in. Nothing flies or rises. | A fade carries the change without the journey. |
| **The band's icon presses, it does not hover.** `active:scale-[0.97]`, 100 ms ease-out, none under `motion-reduce`; no transition on hover. | Restraint where the pointer rests; feedback where it acts. |

The motion values are named once, in `lib/motion.ts` (`EASE_OUT`, `EASE_SETTLE`, `DURATION`), and
read from there.

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
| **The glyph is the only icon a value gets.** A field's label may carry the icon that names the field (*Fact sections*, below); the value beside it never carries one but a state's glyph. | A state's icon is information; any other icon on a value is decoration. |
| **What a state means beyond its word is its card** — a title and a line or two, on hover and on focus (the chip takes focus when it has one). Where the words beside an icon-only chip already say the title, the card drops it (`linesOnly`). | Said once, as an info button's card is. |
| **`cancelled` is `draft`, not `failed`.** | Somebody asked for it: a decision is not an error. |

### Fact sections, and the action a thing is opened for

**What a thing is, and what is done with it, sit on one sheet: its numbers in a KPI row over the
page, and what the numbers cannot say in a rail of panels that fold — the action is a panel too,
not a dialog.** The sheet is the Overview's — cells on a 1px gap over the border colour, no cards,
every text on the pane's one inset (`px-4 md:px-6`), fitted to the window — so the page reads like
every other project screen. A panel is the app's band and its fields; folded, the band says the
panel's answer instead. The work the thing is opened for is one of those panels, last, with its
controls inside it and its progress as its answer. The pattern is the Dataset (`DatasetScreen`,
`screens/dataset/VersionKpis.tsx`, `Fold.tsx`, `VersionFacts.tsx`, `VersionNav.tsx`): a release
reads *Images*, *Annotations*, *Split* and *Schema* over the page, and *Proof* then *Export* — the
model, the recipe and the button — in the rail, above the *Releases* it was picked from, docked at
the rail's foot.

```text
◫ Images     ◎ Annotations   ⑂ Split        {} Schema         the KPI row: one fixed height, ⚠ in a label row
48           427             70/15/15       v3
Same as v2   8.9 per image   Seed 0         Built with 0.0.1b4
────────────────────────────────────────────────────────────
⛨ Proof  ◌ Not verified                ›   folded: the answer beside the title
⬚ Export  ✓ Downloaded                 ⌄   the work's state is said open or folded
⌗ Model ⚠    [ YOLO11               ⌄ ]     a field: the icon that names it, its label, the value
⚗ Recipe +   [ yolo12-640-aug4      ⌄ ]     the "+" beside the label writes a new one
             Letterbox 640×640 · flip  ⋯    what the chosen one does; Edit recipe, Delete
[               Export                 ]     the view's one filled control
═══════════════════════════════════════════   the dock: its own region, its own height
◷ Releases                             ⌄
● Working copy        unpublished · 48       capped; scrolls inside itself
```

| Rule | Why |
| --- | --- |
| **The numbers are the KPI row** (`KpiCards`), four cells of one fixed height over the page, and the work row under it takes the same four columns from `xl` — the rail one, the wall three — so every vertical hairline continues one from the KPIs. A cell whose source has not answered shows a dash and keeps its height. | The page opens on the Overview's KPI row, and opening another version changes text, never the layout. |
| **Every panel folds, and its band is the toggle** — the app's band: 48px, the icon that names the panel, the title in sentence case and semibold, its answer quieter beside it, the chevron at the line's end. The heading holds the toggle (`<h2><button aria-expanded aria-controls>`), never the other way round. The screen holds which panels are folded, so opening another version keeps them as the person left them. | One band across the app, and folding is how a person makes room for what matters to them now. |
| **Open, the fields answer; folded, the heading does.** The answer — *48 images · 427 annotations*, a state chip — comes in beside the title only while the section is folded. | Said once: an open section already shows its answer in its fields. |
| **A fold is a transition on what is always there.** The body stays mounted and closes by its grid row (`1fr` → `0fr`) with its opacity, 200 ms on the strong ease-out, and the chevron turns with it; none under reduced motion. Folded, the body is `inert`. | A second press turns it around mid-way, nothing re-mounts, and what is folded is out of the tab order and the accessibility tree. |
| **A field is the icon that names it, its label and the value**, on one 6.5rem label column (`Field`). The icon is lucide at 14px and a 1.5 stroke, in the label's colour; it names the field, never the value. | The column is scanned by shape before it is read, and the values start on one edge. |
| **A field's action is a quiet button in its row** — *Verify* beside the integrity state, the manifest's copy and download as icon buttons after the hash, each 28px with a 40px hit area. | The action sits by the fact it acts on. |
| **The action a thing is opened for is a panel, open by default, last** — not a dialog over the page and not a button in the project bar. Its controls are inside it; its one filled button spans the column, and it is that view's one filled control, so the bar draws nothing beside it. | It is read with the facts it depends on, and nothing has to be opened to reach the thing the page is for. |
| **The work's state is the section's answer, open or folded** — *Not exported this session*, then *Exporting 12/48*, then *Downloaded* — the one heading that answers while open. | A job's progress is a fact about the thing, like its integrity, and folding must never hide it. |
| **The form wraps the release's facts alone, and a fold never unmounts it.** The section only lays out what the form hands it (`ExportForm`, a render prop); folding keeps the body mounted, so a folded Export keeps its job. The form never wraps the column or the wall: opening another version must not re-mount them. | Layout and work have different lifetimes, and a re-mounted column loses its scroll and moves what the person was pointing at. |
| **What the action needs is chosen inside it.** A recipe exists for an export, so it is chosen in the Export section: a select of names (*Detail cards in a list*), a "+" beside the field's label that writes a new one, and — once one is chosen — what it does on a line under the select, with *Edit recipe* and *Delete* behind the "⋯" at its end. Writing opens its own dialog over the page — one deep, never a dialog over a dialog. | A thing chosen where it is used needs no shelf of its own, and a single modal is a single place to be. |
| **Controls are the app's size** — 28px controls, names alone in lists with the detail on the highlighted option. | The section is a form among facts; it reads as one column of labels and one of values. |
| **Warnings are glyphs, problems are sentences.** What holds nothing back — a lossy format, recipes that could not be read, images without labels — is a warning beside its label (*Warnings*); what blocks — a refusal, the consent a format asks for, a download that failed — is a sentence in the panel, under what it is about, and a stale report never stays under a failed one. | The person finds the reason where the action is (`ui-capabilities`: no swallowed refusal), and a one-line row stays one line. |
| **The list a thing is picked from is docked, never under what changes.** The facts scroll in the column's top region; the releases sit in a region of their own at its foot, capped (`min(38dvh, 18rem)`) and scrolling inside themselves, so their place is set by their own height and never by the facts. Folding the dock hands its height to the facts. | The facts differ in height from one version to the next; a list under them moves under the pointer every time an entry is opened. |

### Detail panels

**The detail of a selected item is a panel at the right of the screen's row — never a sheet over
the page on a desktop.** An image, a batch, a class, a model: the list stays where it was, the
detail opens beside it, and the two are read together. The pattern is `DetailPane`
(`patterns/DetailPane.tsx`); a screen gives it the row's last place and the detail its children.

```text
┌ list / grid / table ─────────────────────┐┃┌ detail ────────────────────┐
│ ▣ Images  48  …                          │┃│ Frame 0 · 0:00   1/48 ‹ › ⤢ ✕│  one 48px line across the row
│                                          │┃│                            │
│                                          │┃│  the item, read at the     │
│                                          │┃│  width the person chose    │
└──────────────────────────────────────────┘┃└────────────────────────────┘
                                   the handle ┘  drag, or focus and ←/→
```

| Rule | Why |
| --- | --- |
| **The person sets the width.** The panel's left edge is a window splitter (`role="separator"`, `aria-orientation="vertical"`, the width as its value): drag it, or focus it and press ←/→ (Shift for 64px), Home/End for the floor and the ceiling, Enter or a double press for the screen's own width. The width is remembered per screen, between a floor that keeps the panel usable and a ceiling of 62% of the row. | A wide image, a long form and a table of jobs each want a different width, and only the reader knows which they are reading. |
| **Its header is 48px, the band's height,** with the item's title, its place and its controls, and a close button at the end (`X`, named for what it closes; Escape does the same). | The list's band and the detail's header read as one line across the row. |
| **It comes from the right and goes back there.** It takes its width at once — the list beside it moves once — and its content slides in from the right edge with its opacity, 240 ms on the strong ease-out; it leaves the same way in 180 ms, holding what it showed, inert, then gives its width back. Transform and opacity only; a fade under reduced motion. Choosing another item while it is open swaps the content in place. | The motion says where the detail lives, and a selection change, made tens of times a session, never waits on an animation. |
| **Not a dialog.** It is an `aside` labelled for what it holds; the page beside it stays live and nothing traps focus. | The list and the detail are one surface, read and used together. |
| **Below `lg`, a sheet** — the same content from the right, with its own close and Escape. | A phone has no row to share. |

### One image detail

**An image opens in the same detail wherever it is opened.** The Images section's
`ImageDetail` (`screens/images/ImageDetail.tsx`) — its well, header, arrows and focus mode, in a
`DetailPane` that focus expands to the whole row — is the Dataset's too; what only a surface knows comes in through its two openings, `overlay`
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
| `frontend/ui-core/src/screens/dataset.test.tsx`, `preprocessing.test.tsx` | The working copy reads as four KPIs with their warnings named and described; a release's export is a panel of its facts — open, last, holding the model, the recipe and the button — and Publish is the project bar's on the working copy only; a folded section's heading says its answer and its fields stay mounted but inert; the export's answer is the job's state, open or folded, and the job keeps going while the section is folded; verify and download failures are sentences, and a stale report leaves; the recipe is a select with the "+" that writes one, the chosen one's Edit recipe and Delete are behind its "⋯", its writer opens as a single modal, and a delete asks first and falls back to no recipe. How a heading, a field's icon and its action are laid out is held by review |
| `frontend/ui-core/src/screens/screens.test.tsx` | The Dataset keeps one filled control: Publish release in the bar on the working copy, and on a release none in the bar — its export's button in the column |
| `frontend/ui-core/src/screens/overview.test.tsx` (*auto-label over the batches*) | The offer's line says the waiting count only where batches declare `pre_label` and leaves out a batch being drafted; *Not now* puts it into the band, is remembered per project and returns when the count grows; a run starting closes it; both places open the dialog; on load nothing animates; *Not now* flies the wand onto the band's icon and shrinks the button's copy into it, cleans up on landing or unmount, and under reduced motion only fades |

The foundation's own token and palette gates run in `Robomous/ui-core`. A rule no gate holds is a rule under review, not an exemption.
