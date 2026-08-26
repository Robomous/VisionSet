# Product UI principles

VisionSet-specific product rules: how the interface behaves as a *dataset tool*, independent
of the visual language. The visual foundations — colour, typography, spacing, materials,
motion, accessibility — are [`DESIGN.md`](../../../DESIGN.md) at the repository root. This page
owns the rules that would survive a restyle: what a screen must show, offer, and refuse.

Navigation behaviour is [navigation.md](navigation.md); the annotation workspace is
[annotator.md](annotator.md); the data shell is [ui.md](../ui.md).

## Principles

1. **Data first.** VisionSet is a dataset tool, and every project-level screen surfaces real
   data — counts, distributions, samples — before configuration. The test: if a screen would
   render identically for an empty project and a 100k-image one, it is wrong. A schema
   editor is the same document either way, which is why it cannot be a project's face.
2. **Density over whitespace, on data surfaces.** Our users are ML engineers and
   professional annotators working with large ontologies — a fifty-class ontology is
   ordinary. Prefer compact lists, tables and two-panel layouts to spacious single-column
   forms. This does not license crowding: it licenses showing more of the thing the user
   came for.
3. **Action-forward.** Every major screen answers "what do I do next?" with one clear
   primary action. On a project page that action is annotating, never configuration.
4. **Never disable without explanation.** A control either stays enabled and answers with a
   message, or it carries an adjacent explanation of what would enable it, or it is not
   rendered at all. A bare disabled grey button is forbidden — it is a question the
   interface refuses to answer. The corollary runs the other way too: a control that exists
   only because a callback might arrive renders nothing when the callback is absent, rather
   than a dead button.
5. **Destructive actions state their blast radius.** A confirmation dialog names what will
   be destroyed, counted: *"Deletes the class and 4,372 annotations across 3 versions."* A
   dialog that asks "are you sure?" without saying what yes costs is a speed bump, not a
   confirmation. Where the count cannot be obtained accurately, the action does not ship
   with a dialog that guesses.
6. **Empty states invite.** An empty state names the space, explains it in one line, and
   offers the next useful action with a verb-first label — "Ingest your first batch to see
   stats here", never a bare "No items". A section with nothing in it is otherwise not
   rendered at all: not a placeholder, not an apology.

## Status semantics

The visual foundation defines the status families and forbids colour-only status
([`DESIGN.md`](../../../DESIGN.md)); this is the product's authoritative mapping. A status
picks an intent, never a colour, and there is **one mapping product-wide**:

| Family | States |
| --- | --- |
| `success` | Done, settled, succeeded — `annotated`, `accepted`, batch `completed`, ingest `completed`, export `succeeded` |
| `warning` | Waiting on a person — `review_pending` |
| `error` | Failed — ingest `failed`, export `failed`, a corrupt file, a refusal |
| neutral | Nothing has happened, or a decision was taken and nothing is wrong — `unannotated`, `skipped`, batch `draft`, export `queued`/`cancelled` |
| `info` | Work is in flight — batch `in_annotation`, ingest `running`, export `running` |

Three rules follow, and each was a real defect before it was a rule:

1. **`error` styling is for errors only.** A `skipped` frame and a `cancelled` export are
   *decisions*; painting them red tells somebody who chose an outcome that it went wrong.
2. **`warning` means one thing: something is waiting on a person.** It is not "in
   progress" — work in flight is the healthy majority state, and colouring the majority
   state amber makes a list of ordinary work read as a list of problems.
3. **"Finished" has one colour.** A completed batch and a completed ingest run are the same
   fact about two nouns and read the same.

**The word always rides with the colour.** The badge carries its label, the dot carries the
word beside it, and where a dot has no room the accessible name and the tooltip carry it
(`● annotated · Saved`). The per-asset dot also carries a second non-colour channel —
`filled` / `ring` / `hollow` / `muted` says how far along a frame is — so the vocabulary
survives a monochrome screen.

The single spelling for the per-asset states is
`frontend/ui-core/src/screens/batchState.ts` (`PROGRESS_TONE`, `progressDotClass`,
`progressCellClass`). Every other family writes its own small map beside its own labels,
typed against the shared `BadgeTone` union — so a new tone is a compile error rather than a
diff nobody notices.

## Numbers

- Stat values use **tabular figures**, so a number that updates does not shift the ones
  beside it.
- Counts ≥ 1000 carry locale-aware thousands separators, through one shared helper —
  `6431` and `6,431` on the same screen is how a call-site decision goes wrong.
- Relative times under 7 days (`2d ago`), absolute beyond (`Jan 14, 2026`).
- A percentage derived from a zero denominator is `0`, never `NaN` and never hidden.

## Loading and async work

The general feedback baseline (thresholds, minimum visibility, prose for long waits) is in
[`DESIGN.md`](../../../DESIGN.md). Two product rules sit on top of it:

- **Indeterminate progress renders as prose, never as a bar.** An empty track reads as
  *0%* — a lie in the one case where the truth is "this is going, and nobody can say how
  far". A run whose total is unknown gets a sentence; the bar appears when there is a
  fraction to draw.
- **A threshold that hides a state needs evidence that the state occurs**, measured on a
  real machine rather than argued from perception. A delay that suppresses nothing buys a
  second state to maintain.

## Lists and filtering

Any list that can exceed ~20 rows carries a filter input. Filtering is client-side and
instant, matches a name substring case-insensitively, and never hides the count of what it
filtered out.

### A list filtered by what its items enable

Where the items of a list are things a person configures so that *something else* becomes
possible, each item says which abilities it enables, in a user's words, and the list is
filtered rather than sectioned — one dropdown per dimension the items vary on, each at
**All** until somebody chooses, combined so an item is shown only while it answers every
choice. An item enabling two abilities is one item, not two copies. The Models page is the
specimen. Four rules make it honest:

- **The values come from the data's own vocabulary**, never from a client-side reading of
  what an item is. On Models that is `capabilities`, which the server derives from the
  model's weights, and `origin`, which the server records.
- **A filter offers only what is on the page, and is not offered at all until there is a
  choice to make.** The options are the distinct values the items carry; a dimension on which
  every item agrees is withheld, because a dropdown whose every choice shows the same items
  is principle 4's dead control wearing a friendlier label. The set of filters on screen is
  therefore a fact about the data, derived on every render.
- **Nothing declared is invisible.** A value the build has no copy for is offered raw and
  shown raw on the item, and an item declaring no ability at all still appears under **All**.
  An item no filter reaches is an item nobody can act on.
- **An emptied result states the fact and invites nothing.** Every choice on offer is one some
  item answers, so what left nothing is the combination; the page says *nothing here
  matches*, keeps the count of what it hid, and offers **Clear**. The view's dominant action
  stays in the header.

A text filter crossing such a list narrows what the dropdowns show, and is held to the same
emptied-result rule.

## Tabs

One tab shape, product-wide (`frontend/ui-core/src/primitives/Tabs.tsx`): a row on a
full-width hairline; the active tab carries a 2px accent rule sitting on that hairline plus
foreground text; an inactive tab carries no border, no fill and no shadow, and gets a
subtle fill on hover or focus. The inactive tab keeps the same 2px border at `transparent`,
so selecting one does not shift the row. There is deliberately **no extra weight bump** on
the active tab — colour and the rule already carry it, and a second signal reflows the
row's metrics for nothing.

**The space between a tab bar and its content belongs to the primitive's content slot, and
to nothing else** — one declaration, and a consumer must not add a gap of its own. The
primitive owns it because that is the direction nobody can forget. It knows two values: the
segmented switch keeps Nova's 8px, and a `line` bar — navigation over a page's content, as on
the dataset's four views or the project's strip below `lg` — takes the layout unit, 16px.
Asserted by measurement rather than by a class string.

No panel repeats its own tab's name as a heading: the tab already labels the panel, so a
heading saying the same word is a stutter for a reader and for a screen reader both. The
one exception is a tab bar that is the narrow-viewport form of a navigation column — a
project's sections below `lg` — where each section is a page with its own `h1`, and the
strip is how the column collapses rather than a set of panels.

## Screen rules

### Home

Home is the workspace's front page and answers a different question from a list: a list
answers *what exists*; Home answers **what is waiting on me, and where do I carry on** —
which no single project can answer. It carries nothing project-scoped; every row is a
pointer, and pressing it goes to the screen that owns the thing.

- **Two states.** A workspace with no projects renders one invitation and nothing else — a
  headline, a line of body, the dominant **Create Project** action, and three quiet cards
  naming the cycle (ingest, annotate, release) with no controls on them. Once a project
  exists this state never returns, and the dashboard renders with real zeros wherever the
  numbers are genuinely zero.
- **A section with nothing in it is not rendered** — absent, not a placeholder. The stat
  cards are the deliberate exception: a count of zero is a measurement, and cards that came
  and went would make the aside jump on every visit.
- **The resume card** names a project, a batch, a count in tabular figures, and a picture of
  the frame it would open. It holds the view's dominant action. It is ranked by when
  somebody last worked the batch; batches with no recorded work rank behind every batch
  that has some, ordered among themselves by progress.
- **The label is load-bearing, and the wire picks it.** The card renders one of three
  promises: **Continue Annotating** (a frame nobody has judged), **Review Annotations**
  (labeling done, frames waiting on a reviewer), **Open Batch** (nothing to open in the
  editor). The first two go to the editor, the third to the gallery — a button claiming a
  frame that does not exist would land somewhere empty. Which applies is decided by the
  kernel and carried on the response, because a judgment spelled once in the kernel and
  again in the browser is one that drifts.
- **Attention rows** are one line each: a batch holding frames awaiting review, a batch
  holding frames a model labeled and nobody has read, a failed background job, a running
  background job. The two batch rows must not read the same — the first waits on a
  *reviewer*, the second on an *annotator* — and a batch holding both gets both rows, since
  one line cannot ask two people. Either batch row links to its gallery, where the
  model-labeled segment and its bulk verbs are. A job row links nowhere and says so by not
  being a link — no screen shows a background job, and inventing a destination would be
  principle 4's dead button with a friendlier label.
- **Activity** is a projection over timestamps that already exist, never an event log,
  capped at about eight and newest first. The copy must not overstate what a timestamp
  records: an ingest row reports *the last data that arrived*, not a run finishing, and a
  schema row reports a version being created, because which version is active is derived.
- **The dominant action tracks the state.** First run offers Create Project. A workspace
  with somewhere to carry on offers whichever action the resume card resolved to, and the
  header's own New Project steps back to a secondary treatment behind it. Only a workspace
  with nothing open at all — every batch finished, nothing waiting on a reviewer — offers
  New Project as the dominant action. The first-run CTA opens the same dialog the project
  list's button opens, rather than navigating to the screen that carries it: a button
  labelled *Create Project* that only moved somewhere else would promise an action it does
  not perform.

### Project surfaces

The project view is the face of a project, and principle 1 is the rule it exists to keep.

**The project's identity is one eyebrow line above each section's title**
([navigation.md](navigation.md), *Inside a project*): the way out (`Projects`), the project
name, the active-version chip. **A chip with no data is omitted, never rendered as a
placeholder** — inventing a field to fill a chip, or rendering `Unknown`, is the "No
description." mistake with a border around it. The description shows on Overview only,
under its meta line, **if there is one** — if not, render *nothing*, because "No
description." spends a line telling somebody about a field rather than about their
project. How much data the project holds, and when it last arrived, is the Overview
header's one line (`11 images · ingested Aug 7, 2026`) rather than a chip.

The navigation carries the one dominant action and the overflow menu (`⋯`) for the rest;
each section's own header carries that section's actions as `secondary`, right-aligned.
On the project page the dominant action is **Annotate**, because principle 3 asks what the
user came to do and the answer is never "rename this".

**Annotate has three shapes, and the cost of the choice tracks the ambiguity.** With no
batch open for annotation there is nowhere to send anybody, so the button is absent and
Ingest takes the dominant slot — principle 4, rather than a disabled control that never
says what would enable it. While Annotate holds the slot, Ingest stays reachable as a
`secondary` action on the sections ingest feeds (Overview, Batches); it is never in both
places at once. With exactly one, it jumps straight there — into that batch's one job where it
has exactly one, and onto its gallery to pick a job otherwise, since a batch cut into several is
a second choice nobody has made yet. With two or more it
reads `Annotate ▾` and opens a menu of those batches, each row carrying the batch name, its
remaining count, and the schema version it is pinned to. The chevron is not decoration: a
button that opens a choice must not be shaped like one that jumps. The pinned version earns
its place because which batch you pick decides which schema you annotate under. Never a
silent default, and never one remembered from last time: a control's destination may not be
a function of session history.

**The first run renders exactly one invitation, driven by the project's state.** No classes
and no images invites the classes (naming the other order beneath it as prose, because both
are legitimate); classes and no images invites the ingest; images and no classes invites
the classes again. A project with both gets no invitation and is the dashboard. **It guides
and never gates** — Ingest and Schema stay independently reachable throughout, and where
the invitation holds the page's dominant action the navigation steps its own Ingest back
to a secondary treatment.

### Versioning is ambient, not modal

Schema version state is a persistent status line — `Version 1 active · unsaved changes
create v2` — never a tooltip, a dialog, or a disabled save button. The user should never
have to press something to discover what pressing it would do. Its corollary, from
principle 4: **Save Version is always enabled.** Pressing it with no changes shows a toast
and issues no request. It is a `secondary` control: the project's navigation holds the
page's filled one.

## Component contracts

Presentational contracts, all in `ui-core`, all data-only — no fetching, no router:

| Component | Contract |
| --- | --- |
| `StatCard` | Muted meta-size label above a large value, tinted surface, no border. Used in grids of 3–4. Optional context line under the value. |
| `DistributionBar` | One row of a bar chart: swatch · fixed-width label · proportional bar in the class colour · right-aligned count. All bars in one chart share a single max-value scale. |
| `ClassListRow` | Swatch + name + a `geometry · count` secondary line. Selected = tinted background + 2px left accent rule covering the row's full height. The whole row is the click target and a real `<button>` — except when it carries shape chips, which are press targets and cannot nest inside a button: that row is a `role="group"` with an inner name button, addressed by the same `-name` handle in both markups. A row carrying a refusal never takes the group form, because only the button can be disabled. |
| `EmptyState` | Icon + a headline naming the space + one line of body + a verb-first CTA. Never a bare "No items". |
| `ThumbnailGrid` | Square tiles, 6px gap, small radius. The last tile becomes a `+N` overflow linking onward. Missing thumbnails show a photo icon on a subtle fill — never a broken-image glyph. |
| Chip | `primitives/Badge.tsx`, which already is one. It gains variants; it is not reimplemented. |

**Class colour is data, not chrome.** It appears as a small swatch or a thin bar and never
floods a card or a row — the content-over-chrome rule applied to a colour the *kernel*
chose. The single derivation lives in `frontend/ui-core/src/palette.ts` (`classColor`,
schema colour first, else a name hash); a second derivation path is a defect.

**A geometry picker groups its options by category, and the category is presentation
only** — the kernel takes no category concept, because a market segment is not a domain
concept. The single map is `frontend/ui-core/src/data/geometryCategory.ts`, declared total
over the generated `GeometryType` union so an uncategorised geometry fails the build rather
than falling quietly out of a list; headings are non-selectable labels and a category with
nothing under it renders none.

**An option that is an identifier plus the facts about it takes two lines** — the
identifier at the label role, the facts beneath it at the meta role. It is `SelectItem`'s
`meta` prop, so the closed trigger shows the same two lines the open list does; the trigger
grows to fit, leaving every one-line select on the contract's control height. **Nothing
truncates**: an identifier cut off in the middle is not an identifier, so a long one wraps.

## Layout specifics (current implementation)

The visual foundation defines layout *principles* ([`DESIGN.md`](../../../DESIGN.md)); the
exact values below are screen-level decisions of the current implementation and are owned
here.

- **Page widths**: lists/dashboards/detail `max-w-page` — `--container-page: 96rem`, a layout
  extension in `@theme inline` like the rail's widths, consumed by `ui-core`'s
  `PaddedContent`, the one declaration the padded pane and the project shell share; forms/settings
  `max-w-3xl`; centered, `px-4 md:px-6 py-6`. Inside a project the content keeps that
  column beside a `180px` navigation column (`--spacing-project-nav`) at `lg` and above —
  navigation only, since the identity is not in it; the width is the widest control
  (`Annotate ▾`, ~122px) plus room to breathe.
- **Dialog widths**: the primitive's default `max-w-lg` for a confirmation or a form of
  stacked single fields; `max-w-2xl` for a form whose fields sit side by side (its grid
  splits on a *viewport* breakpoint, so the box must be wide enough for a split it cannot
  prevent); `max-w-3xl` for a dialog whose content is a grid rather than a form. Three
  sizes; a fourth needs a written reason rather than an eye-picked value. **Any dialog
  whose content grows with the data carries `max-h-[85vh] overflow-y-auto`** — a centred
  dialog taller than the viewport overflows off both edges and takes its own footer with
  it, which is not a state a person can recover from.
- **Page header**: title + subtitle left, actions right, hairline below, section-scale
  margin beneath.
- **Grids**: cards at `gap-6`, 2/3 columns by breakpoint; 16px is the default layout unit,
  24px separates page sections. Detail two-column: `1fr / 320px`, stacking below `lg`.
  Breakpoints 640 / 768 / 1024 / 1280.
- **Rail widths** live with the rail's other rules in [navigation.md](navigation.md).
