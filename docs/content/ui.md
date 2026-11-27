# The browser client

This page explains how `@visionset/ui-core` communicates with the API and the
three decisions inherited by every screen: the API location, the active
credential, and the response to an invalid credential.

The **visual** contract is [`DESIGN.md`](../../DESIGN.md) at the repository root. This
document is the data half.

## What M5 shipped

`@visionset/ui-core` went from a placeholder `tokens.css` and a generated client to
the whole product: a design system, a data shell, six screens, the annotator's side
panel and the annotation page. `@visionset/app` is a router, a rail and nothing else.

| | before M5 | after it |
| --- | --- | --- |
| `ui-core` vitest | 0 | **107** |
| Playwright (annotator) | 42 | **76** |
| Playwright (browser cycle) | - | **1**, against a real server |
| Python | 1923 | **1932** |

The exit criterion - *"with `visionset server` running, a user completes the entire cycle
in the browser"* - is not asserted, it is **driven**: `pnpm --filter @visionset/app
cycle` walks token → project → schema → ingest → approve → annotate → finish →
complete → promote → publish → verify → export → download against the built bundle
and the real kernel, on every pull request.

M5 moved neither the storage format nor `openapi.json`: the milestone's one deliberate
Python touch - #58's SPA deep-link fallback - is an exception handler, and an exception
handler is not an operation.

## Routes

`@visionset/app` is shell only, and `src/routes.tsx` is the whole of it.

| route | what | behind the token gate |
| --- | --- | --- |
| `/` | redirects to `/projects`; there is no Home page | yes |
| `/projects`, `/projects/:id/overview\|images\|batches\|schema\|dataset` (`?batch=<id>`, `?add=images`), `/projects/:id/ingest` (redirects to `…/overview?add=images`), `/projects/:id/batches/:id` | the product | yes |
| `/models` | model connections, workspace-scoped; `/inference` redirects here | yes |
| `/jobs/:jobId` (`?asset=<id>`) | the annotation page, outside the shell: the whole viewport, no main rail | yes |
| `/demo` | the annotator showcase (`?scene=bench` for #49's benchmark) | **no** |
| `/styleguide` | the rendered design system | **no** |

The last two need no server and no credential - the showcase's picture is a `data:`
URI and the styleguide is pure CSS - so putting them behind the gate would ask for a
token to look at a page that cannot use one. They are also what lets the browser
suite run with no backend.

Two addresses in that region are redirects kept as promises. `/projects/:id` lands on
the project's default section, Overview; and `/projects/:id?tab=X` - the form the
sections had before they were path segments - lands on `/projects/:id/X` with every other
query parameter kept, `versions` going to Schema because the history lives inside it and
an unknown value going to Overview, because a URL somebody bookmarked is a promise. An
unknown *segment* is a 404: nothing ever linked to one.
[`docs/content/ui/navigation.md`](ui/navigation.md) is the canonical sitemap.

The section segment and the annotator's `?asset=` (#353) are both kept true rather than
only read, and it is the same rule twice: each is **rewritten** as the page moves, with
`replace` rather than `push`. A URL that no longer describes what is on screen is not a
place you can send somebody, and `replace` is what stops Back from walking back through
sections - or, in the annotator, one picture at a time through an annotation session.
`ui-core` imports no router, so in both cases the screen reports and `routes.tsx`
spells: `resolveProjectTab` (what a stale `?tab=` became) and `assetParamFor` are those
two decisions, pure and testable without a browser; `projectRedirectTarget` in
`routes.tsx` turns the first into an address and `src/routes.test.tsx` holds every row.

The router's basename is `import.meta.env.BASE_URL`, which is what vite substitutes
for its `base` option - so the router and the bundle cannot disagree about the `/app`
prefix the wheel serves under. A **reload** on a client route is a real request for a
path no file backs; [`api.md`](api.md#where-the-ui-lives) describes the server-side
fallback that answers it.

The shell is the workbench: a collapsible rail (the logo, Projects, Models, the collapse
toggle, sign out — 48px collapsed by default, 208px expanded), the open-project tabs across the top, the status bar along the bottom — the rules
are in [`ui/navigation.md`](ui/navigation.md#the-workbench-frame). Anything richer growing on the rail is what the thin-app audit exists to catch - a
capability in `app/` is one the future enterprise UI cannot reuse. `Models` joined by
the decision recorded on #421 (2026-08-08), as *Inference* until the page was renamed for
the noun it lists: what earns an entry is a workspace-level object every project uses and
that has nowhere else to live, never frequency of use.

### Panes, and which one a route gets

`AppShell` renders the rail and a bare `<Outlet/>`; the pane beside it is a **nested
layout route**, so choosing one is a routing decision and the shell stays
composition-only. `ListPane`, `PaddedPane` and `ProjectPane` sit inside the shell and its
workbench frame — the open-project tabs above, the status bar below. `FullBleedPane` is a
**sibling** of `AppShell` under the same token gate, not a child: the annotator stands
outside the shell, so it has no rail either. It is left by its own back control.

| pane | routes | treatment |
| --- | --- | --- |
| `ListPane` | `/projects`, `/models` | tabs and status bar; the whole width beside the rail, unpadded and uncapped: the page is a full-bleed table (`ui-core`'s `ListPage`) that sets its own inset |
| `PaddedPane` | everything else | tabs and status bar; `ui-core`'s `PaddedContent`: `px-4 py-6 md:px-6`, content capped at `max-w-page` (`--container-page: 96rem`) |
| `ProjectPane` | `/projects/:id/<section>`, and the two old addresses that redirect into one: `/projects/:id/ingest`, `/projects/:id/batches/:id` | tabs and status bar; the whole width beside the rail, no padding of its own: `ProjectFrame` lays out the project's section toolbar across the pane and the same padded, capped content column under it |
| `FullBleedPane` (outside `AppShell`) | `/jobs/:jobId` | the whole viewport, `h-screen`, `overflow-hidden` — no main rail, no tabs, no status bar |

A padded, capped column is right for a form and wrong for the one screen
somebody sits in front of for an hour. Boxing the annotator cost more than looks
(#183): `fitToViewport` derives the zoom from `getBoundingClientRect` on the pane, so
a shrunken pane opened every asset smaller than it needed to and applied the
tolerance constants - all in *screen* pixels, divided by zoom - at a zoom nobody
chose. `h-screen` *plus* `py-6` also made the document 948px tall in a 900px window,
so the canvas's own badge was cut off and the whole page scrolled.

`FullBleedPane` is `h-screen` rather than `min-h-screen` or `flex-1`: pinning the height
is what makes "the canvas pane is the only thing with `overflow`" structural rather than
incidental. The rail's ⌘B chord belongs to the shell, so it does nothing on the
annotator.

The shell's panes are nested under **one** `AppShell` rather than under two sibling shells,
so there is a single copy to keep correct. The open-project tabs' state lives in that
shell (`OpenProjectsProvider`) rather than in the strip, because the strip is drawn
inside each pane and the panes are siblings: crossing from a project to the list
remounts the strip, and state held there forgot where each tab was. That the annotator
has no rail and no workbench chrome, and that its back control returns to a shell that
has both, is asserted in `e2e/annotate.spec.ts`.

The document scrolls rather than an inner pane, so a sideways overflow stays a fact
about the document — what the responsive-floor checks measure. The status bar's height
is published as `--page-inset-bottom`, which the sections that fit the window subtract
from their height, and the Classes commit bar adds to its own offset, so each stops above
the bar rather than running under it.

## Screens

A screen is a component in `@visionset/ui-core` and a route in `@visionset/app`. It
takes **navigation as a callback**, never a router: a screen that called
`useNavigate` would only work inside a `react-router` tree, which is a dependency
the future enterprise UI has no reason to share.

Query keys are hierarchical - `["projects"]` → `["projects", id]` →
`["projects", id, "schema"]` - because TanStack Query matches a **prefix**. So
invalidating `["projects", id]` after a rename refreshes the project, its schema and
its version list, and the mutation never has to enumerate what it affected.

### Home, and the one screen the server composes

**Not mounted by the standalone app.** The Home route was removed: `/` redirects to the project list, and the rail carries no Home entry. `HomeScreen` and `GET /home` still exist (a reusable `ui-core` screen and its API read), and what follows describes them for a host that mounts it.

`/` was the workspace dashboard. It was a redirect to the project list until there
were numbers worth showing, and what makes it a page rather than a second list is
that it answers a different question: a list says what exists, this says what is
waiting and where to carry on - which spans every project, so no project-scoped
screen can answer it.

**One query, `useHome`, over one endpoint.** `GET /home` returns the whole page in
one response: totals, the batch to resume, what needs attention, a short list of
recent projects and a derived activity feed. Composed on the server because the
alternative is a request per project per question with the browser doing the
joining, which is slower and renders in pieces as they land.

The summary is a **read-only projection**. It declares no `allowed_actions` and no
mutation takes it as input; every row deep-links to a resource whose own wire shape
says what may be done to it. A second copy of those declarations here would be the
hand-mirrored table the capabilities contract forbids, one layer up.

**The resume target declares its own kind, and the screen renders it rather than
working it out.** `annotate` means `next_asset_id` is a frame nobody has judged -
unlabeled or carrying only a model's unreviewed guess, either way a frame the
annotator can write to - `review` means it is one awaiting a reviewer, and `open`
means the batch is settled throughout and there is no frame at all. The card's
label follows - *Continue annotating*, *Review annotations*, *Open batch* - and so
does its destination: the first two open the editor, the third the batch's panel on the
Overview. The two
editor cases are the same route because a `review_pending` frame opens read-only
with the review actions on it, which is the position
[the annotator section below](#review-is-a-flow-not-an-api-only-edge) already
takes.

The order between the three is resolved on the server. It is a judgment about what
somebody should do next rather than a fact the rest of the response restates, so a
client deriving it again would be keeping a second copy of a rule that can drift -
the shape of defect the capabilities contract exists to prevent. Batches are ranked
by when somebody last worked them, with ones nobody has worked since that became
recordable ranked last and ordered among themselves by progress. That second group
is every batch in a workspace created before the stamp existed, since it was added
without a backfill.

**The attention list names who is being waited on.** A batch holding frames awaiting
review is waiting on a reviewer; a batch holding frames a model labeled and nobody has
read is waiting on an annotator, and its row says so rather than reading like the first -
*48 model-labeled frames waiting on an annotator*. Both rows open the batch's panel
on the Overview, where its jobs are and each opens in the editor
([below](#reviewing-a-pre-labeled-batch)); a batch holding both kinds gets both rows.

One thing about the page is still a consequence of the storage format rather than a
choice, and it is stated on the endpoint as well as here: the activity feed's
`ingest` entry is the newest `Asset.ingested_at` in a project rather than a run
finishing, because an ingest job records no times at all.

A workspace with no projects reads zeros, nulls and empty lists. That is the
first-run state, and `totals.projects` is how the screen recognises it - not a flag,
which would be a second spelling of a fact the response already carries.

### The workspace lists: full-bleed tables

The project list and the Models page share one composition (`patterns/ListPage.tsx`), laid out
in a pane with no padding and no width cap (`ListPane`), so the table is the page:

1. **A header band**, 48px: the page's icon and name, nothing else.
2. **A toolbar band** under a hairline: how the list is being looked at - search, filters, the
   order it is in - and, at its end, the page's one filled action, **New** with a plus (named
   *New project*, *New model*). It is there even before there is anything to filter, since it is
   how the first one is made.
3. **The grid**, edge to edge, with no card around it: hairlines between columns as well as rows,
   every column named in its header with an icon and a word, 36px header cells on a faint fill
   and 44px rows.

A list is **paged**, 25 rows to a page (`DESIGN.md`, *Paging a table*): under the grid a footer
says which rows are on screen - *26-50 of 312 projects*, *1-2 of 2 models · filtered from 4* while
a search or filter narrows them - and carries rows per page and the steps. The grid's area scrolls;
the footer stays under it. A search, a filter or a new order starts over at the first page.

Nothing is said twice. How many rows there are, and of how many, is the footer's. What the rows add
up to - their images, how many are ready, how many wait on a review, over every row the search
leaves and not only the page on screen - is said in the status bar's left half (`PageStatus`). No
count beside the heading, no totals line at the foot. The header's button is the page's one way to
create: no second "New ..." row under the last one, and an empty list's message names that button
rather than repeating it.

The header's text, the toolbar's first control and the first column all start on the pane's
inset, the status bar's, so the page has one left edge.

### The project list, a ledger

`/projects` is that table, one 44px row per project: the project (cover thumbnail, its name
with a link's hairline under it and an arrow that appears when the row is pointed at, and one
truncated line of description beside it), **Assets**, **Annotated**, **Classes**, **Status**,
**Release** (the latest release's tag, its asset count and date in the tooltip; a dash without one
- the Status column already says *Not released*) and **Activity**.

**Annotated says the work left, not the work done** - *248 to annotate* beside a 14px ring for the
glance, *All annotated* with a check once nothing is, and a dash for a project with no images (its
Status already says so). Left means left for a person: the larger of the images with no annotation
and the frames in active batches an annotator still has to do, so a project of model pre-labels
nobody has read never reads *All annotated* beside a Status of *Annotating*. The ring is the
images' share, held open while anything is left and visible once anything is done; the count is in
tabular figures and the ring a fixed size, so nothing in the row moves when a number changes. The
Status column says no "left" of its own: the column beside it does.

**The columns come in two widths.** A column holding a short figure - Images, Classes, Release,
Activity - is 112px; one holding a few words - Annotated, Status - is 176px; the project's column
takes the rest. Equal columns read as a rhythm, and one a few pixels off its neighbour reads as a
mistake. Images, Annotated, Classes, Activity and the
name sort, from their headers or from **Sorted by** in the toolbar, which says the order the
list is in and changes it - a key, then ascending or descending; Activity, newest first, is the
default, and a project the workspace never dated goes last in both directions. A search field in
the toolbar filters by name or description as you type; when it matches nothing the grid says
so and offers **Clear search**. The status bar counts the projects (*1 of 2 projects* while a
search narrows them), their images and how much of them is left to annotate - the same count the
rows say, summed - and how many are in review
- the one stage waiting on a person. The whole
row opens the project; the name is the row's one real control for a keyboard; Rename and Delete
sit behind the row's `⋯`, so neither can be an accidental open.

Every number is in the **same request** as the list: each item of `GET /projects` carries a
`digest` the kernel computes for the whole workspace in one pass
(`ProjectService.digests`). The **Status** column says the digest's `stage` in words with
the product-wide status families — `In review` (warning, with the frames waiting),
`Annotating` (info; what is left is the Annotated column's), `Ready to add` and `Up to date` (success),
`Not released`, `Not started` and `No assets` (neutral). The stage is the kernel's
description of where a project is, never a capability: nothing on the page is gated on it,
and the screen derives none of it from batch states.

### The project view, and the one screen whose section is in the URL

A project has four sections - Overview, Assets, Classes, Dataset - and they are
**navigation**, not five things stacked in one column (#171): at `lg` and above a
toolbar across the pane, below `lg` a tab strip above the content, one
component (`ProjectNav`) drawing whichever layout `ProjectShell`'s `matchMedia`
answer hands it. The bar is the section's header: the tabs with their counts, one line about
the open section, and the actions that section is about — Add images on Images, Publish on
Dataset (Classes draws its **New** in its own band; the Overview's Add images and Annotate end its
batches band) — then the overflow, where Add images sits on Classes and Dataset. The project's identity is the
open-project tab above the bar, so no eyebrow line sits over the content, and the content
opens straight on the section. Overview is the default, because a schema
editor is configuration and renders the same for an empty project and a full one;
the rules are in [navigation.md](ui/navigation.md), *Inside a project*.

The section travels as the URL's **last path segment**, so it survives a reload and can
be linked to. That does not put a router inside `ui-core`: `ProjectScreen` takes `tab`
as a raw string and hands a normalised one back through `onTabChange`, and takes
`hrefFor` so its items are real links, exactly as every other screen takes navigation.
Normalising is the screen's job, so an unknown value opens on the default rather than
on nothing. With `onTabChange` absent the screen holds the section itself and the
navigation still works, which is what lets a component test - or a host with no router -
render the screen unchanged.

**The labels are not the segments.** Classes is `/projects/:id/schema`: the segments stay the
product's nouns, because a bookmarked URL is a promise, and only the words a person reads were
changed. Images, `/projects/:id/images`, is the one new segment. **Batches have no section.** They
are listed on the Overview, and `/projects/:id/batches`, which was a section, redirects to
`/projects/:id/overview`, replacing the history entry. A batch's own address,
`/projects/:id/batches/:batchId`, was a page of its own (the batch gallery) and now redirects,
replacing the history entry, to `/projects/:id/overview?batch=:batchId`: a batch opens in the
Overview's panel, and the open batch is that query parameter, written with `replace` and removed
when the panel closes, so a reload or a pasted link opens the same one. `PARENT.batch` in
`routes.tsx` spells it, which is why Add images' *Open the batch*, the annotator's back arrow and
*Correct this batch*, the pre-label dialog's links and a correction's lineage all land there.
**Add images is a dialog, not a page**, and whether it is open is the URL's too: `?add=images` on
whichever section it was opened over, written and removed with `replace` like `?batch=`, so a reload
or a pasted link opens it and Back leaves the page rather than reopening it. `/projects/:id/ingest`,
its old page, redirects to `/projects/:id/overview?add=images`, replacing the history entry
(see [The Add images dialog](#the-add-images-dialog-and-the-order-the-domain-forces)).

**Each section owns its query.** Only the open section is mounted, so a query living in
the section that renders it follows the section: the version list is read when Schema
is opened rather than on every visit to a project, and the Overview's batch table stops polling
while another section is showing. What runs at the top is what the project bar always draws - the project, its active schema,
its stats, its dataset's counts and its batches - shared by key with the sections that also
want them.

A section has no header of its own: its tab names it, and the bar's line says what the
counts cannot - the project's description on Overview (or how far labelling has come, without
one), *Version 3 in force* on Classes, *Latest release v1 · Sep 29* on Dataset, nothing on
Images, whose band describes its sources. Each section keeps an `sr-only` `h1` with the tab's
word.

**Images is every image the project holds, grouped by where it came from, and changes none.**
The section is laid out as a pane rather than a page: at `lg` and above it takes the project pane
edge to edge (`ProjectShell`'s `bleed`) and exactly the height between the host's pinned chrome
(`--page-inset-top`, `--page-inset-bottom`) and the project bar, so only its grid scrolls; below
`lg` the same pane sits in the padded column as a framed panel. The project bar names it; its
`h1` is for whoever navigates by headings, and nothing above the grid says the same thing twice.
Removing an image or changing its labels belongs to the batch that holds it. A project with none
is an invitation to *Add images*, which replaces the pane rather than repeating the bar's
control, and opens the same dialog.

*Sources, a page at a time.* Every source with images is a section, newest source first, read
from `GET /projects/{id}/assets?source_id=…` sixty at a time (`useAssetPages`); the rest of a
source is asked for as the end of what has arrived comes within reach, with placeholder tiles
holding its place. A project with no registered source reads the unfiltered listing as one run.
Every count is a `total` from the wire, never a tally of tiles — the status bar says the
project's (*61 images · 3 sources*, or *13 of 61 images* while narrowed) — and an image the
listing holds but no source claims (only data from before sources were recorded) is counted in a
line under the grid rather than hidden.

*One batch's images.* `/projects/:id/images?batch=:batchId` narrows the section to the images that
batch holds, which the Overview's batch panel links to from the count on its Images property. They are read from
`GET /batches/{id}/assets` (a hundred at a time, in the batch's own order, the next page as the end
comes within reach) — the project's listing has no batch filter, so nothing narrows it by hand. The
band's source menu gives way to a chip, *Batch: drive-01 ×*, whose × lifts the narrowing (written
with `replace`) and returns the whole project with the tile size kept. The batch's images are one
run rather than a section per source: the batch listing carries no per-source count, and a heading
claiming a source's whole over a partial read would be wrong. No source menu or headings, then; the
image's source is still named in its detail. The status bar says *4 of 61 images* once the batch's
read has answered, and nothing before; the unsourced
note is the whole project's and is not shown; density, the selection, the keys and Focus work as
on the whole project. A batch with no images says so, and one that cannot be read shows the
refusal, with the chip still there to remove. Only a batch the project's own batches hold is read:
an id they do not hold - deleted, or another project's - is *Unknown batch*, says it is not on
record, and fetches nothing.

*The band.* One row over the grid says what it holds. With several sources it is the source
menu: a button naming the source in use and its count, and beside it that choice's one-line
description. The menu shows each source with its first image as a cover, its name, a short line
of what it is, and its count; it groups them under *Videos*, *Sequences* and *Folders* when a
project has more than one kind. A *sequence* is an `image_sequence` source an import wrote, such as
one OpenLane segment: it carries its own icon and reads *Sequence · 40 images · …*, its tiles are
captioned *Image N* like a folder's, because an asset does not carry its position in a sequence.
With one source the band is that source's name and description. The tile size (three densities)
sits at the band's right.

*Source headings.* With more than one source on the page each section is headed by its icon and
name, then what the source is, said once — *Video · 48 frames · 854 × 480 · JPEG · one every
second · added Sep 29*. The icon and name are one control that narrows the page to the source,
the same as choosing it in the menu. A heading pins while its images scroll: pinned, it lifts —
a hairline and a soft shadow — and trades its description for where you are in the source
(*Showing 21–48 of 4,812*), the two cross-fading in one cell; the next source's heading pushes it
off. The position is not a live region, because it changes on every scroll.

*Tiles.* A tile is the thumbnail and nothing over it until the pointer arrives: then, or while
it is selected, a caption on a dark scrim names it (*Frame 12* for a video frame, *Image 3* — its
place in its source — otherwise) with its time in the video, or its size when a folder's images
differ in size. A folder of mixed shapes shows its thumbnails whole rather than cropped. Each
source's tiles are a `listbox` whose options are the images; the selected image is the only one
in the Tab order, so the grid is one Tab stop and Tab moves on to the next source's heading. The
selection is a 2px ink ring with a gap of page colour; keyboard focus adds a 3px band in the ring
colour outside it.

*The selected image* sits beside the grid: the image fitted on the stage colour, its facts under
it — Source, Frame (index and time, for a frame), Size, Format, Added and a short, copyable
Content hash — and a header with its position (*n of total*), previous and next, and the focus
toggle at its right end. *Focus* (Enter, the well, a second press on the selected tile, or the
toggle) widens the image to the pane and folds the grid into a two-column rail beside it, where
every image but the selected one steps back; the same toggle, Enter or `Esc` folds it back. The
two columns never swap places, so the toggle that expanded is under the pointer to collapse.

*A point-cloud scan* takes the picture's place as its cached top-down thumbnail (`ScanPreview`),
and fetches no points until **Open in 3D** asks for them; the live view then fades in over it, in
place, and **Back to picture** returns. Open stays open across focus and closes with the next
image. Its facts read Points and the scan's format where an image reads Size and Format. Every
control sits on the view, and each is the readout of what it controls: the angle — 3D, Top, or
Both side by side (stacked in the narrow detail) — at its top; at its foot a legend pill, the
colour ramp with the values at its ends (the 2nd–98th percentiles the canvas stretches it over,
in metres for height), which chooses Height, Intensity or RGB; and a points pill, *27,400 pts*,
which lists the densities the scan can be read at — 1/16, 1/8, 1/4, 1/2 and all of it, at two
significant figures inside the route's 1,000–2,000,000 — each with its share of the scan and
what it costs to load. A new density keeps the current points and camera until its own arrive.
The well holds these controls, so a scan's well is not itself the focus button. A dataset
member's 3D labels are drawn in the view and follow the member's label switch. Without WebGL2
the view is the thumbnail.

*Keys.* The grid acts on a key only while one of its images holds focus — a heading, a button or
the menu keeps its own — and, with nothing focused, the arrows still walk and bring focus in.
Arrows move selection and focus together across sources (up and down keep the column); walking
off the last image that has arrived for a source asks for its next page and lands there. The
section reads and changes nothing; an image does not know its batch, so it offers no way into one.

**Overview is the project's console, composed from project components**
(`patterns/project/`), and it changes nothing but for the batches' controls, described below. It is drawn
the way the Projects and Models lists are: full width under the project bar, no cards, one sheet
of cells with a hairline between them, and every text starting on the pane's one inset. From
`xl` the page is exactly the window between the project bar and the status bar - the document
never scrolls; the batch table and the images scroll inside their own cells - with a floor below
which the page scrolls rather than crushing the table.

**Four cells** across the top - Assets, Labeled, In dataset, Classes - each with its icon and
name, its figure, and one context line, with a short meter ahead of it where the figure is a
share of something; the Classes cell, last, draws its bar of shares instead (below). Three are a door into the section that owns them: the whole cell is the
target (Assets to Images, Classes to Classes, In dataset to Dataset), with an arrow on hover.
*Labeled* is a plain figure, because the batches that answer it are the table right below.
**Labeled counts the images a person has decided**, read from batch progress: across every batch
that has been cut into jobs (a draft has none), the images that are neither unannotated nor
merely pre-labeled by a model (an image awaiting review counts as labeled). Its context line says
how many are left and in how many open batches, so the two always add up; neither uses the
project statistics' `annotated_pct`, which counts model drafts nobody has reviewed. The In
dataset cell's context line says how many images have arrived since the latest release (*120 since
v2*), or *all in v2*. **What needs somebody is a badge in a cell's label row**, never a row of its
own, so the cells stay compact and level: *N to review* on Images when batches declare `approve`,
*N to start* on Labeled when they declare `start`, *N to promote* on In dataset when finished
batches declare `promote` (or *Unreleased* when the trunk holds images no release has). The badge
opens its steps in a popover - on hover after a short delay, on click, and on Enter - one per
batch, each a pointer labelled from what the batch declares (*Review and approve*, *Review and
start*, *Review and add to dataset*) into that batch's panel, plus *Publish a release* into the
Dataset's releases where it applies.

Under the cells, on the same four columns so each vertical hairline continues one above, the
**Batches table** takes three and a rail takes the fourth. Batches have no section of their own,
so this table is where they are listed and opened. Its band carries the name and count, then
the *Auto-label* icon when it applies ([below](#auto-labeling-from-the-overview)), the *All / Open /
In dataset* lens and a filter; between the band and the table sits the auto-label line while
images are waiting for labels. The table has the list pages' icon-and-word column headers, which
stay on top while it scrolls. Each row is the batch's name
with its size and schema pin - the size counted in what the batch holds, read off
`BatchOut.modalities` with the batch itself (*12 images*, *12 scans*, or *12 assets* for a batch
holding both) - its state, one plain meter of how much is labeled (or *Drafting
n/m* while a model pre-labels it, or *Not started* for a draft), and the initials of whoever holds
its jobs (a dashed circle for an unassigned one). Below the last row the column hairlines run on
to the cell's foot, so a short list leaves table rather than blank page. The table is driven from
the keyboard: J/K or the arrow keys move between rows, Enter opens one, and `/` focuses the
filter. **Opening a row opens the batch's detail panel** - except a draft's row, which opens its
approval directly, and the panel once it is approved (a draft's panel is still reached from the
row's menu, *Jobs and details*, or its `?batch=` address) - as a **sheet over the page**, the
batch panel's own exception to [`DESIGN.md`](../../DESIGN.md#detail-panels): it comes from the
right over the page's scrim, as a dialog does, a press anywhere outside it puts it away, and its
left edge resizes it (the width is the person's, remembered). The panel is the batch's only home:
a batch has no page, and the old `/projects/:id/batches/:batchId` address redirects here. **One
bar across the top** holds, at its start, the close (`≫`), previous and next (J/K walk the batches
without closing it) and *n of N*; at its end, every action on the batch. Under it the batch reads
as a page: its name as a large title, and its **properties** one per row, an icon and a label beside the value (read, not
edited, so they do not light on hover, except State's next step and Images, which are also controls), and *Empty* where a property has no value yet. The state is one of them - a state chip whose glyph says the phase
(the dashed ring, the ring, the labeling pie, the arrow to the dataset, the check) and whose
card says what it means, not a badge beside the name. Pointing at the State row or focusing it brings in, beside the chip,
the batch's next step: the bar's own forward control by its own name (*Approve*, *Start annotating*, *Annotate*,
*Complete batch*, *Add to dataset*), which it presses, and nothing while the bar withholds it; *Open the dataset ↗* once
the batch is in it (`patterns/project/useForwardStep.ts`). Labeled is the batch table's own readout (`LabeledReadout`): *18 of 48 · 38%*, the
way every surface says labeled progress - the table's Labeled column and the job rows too - with its ring, and,
pointed at, the same card that splits the images by annotation state. Images (Scans or Assets, by the row's rule) says *48 images* and is the way to them: *Open in
Images ↗* arrives beside it on hover or focus and opens the Assets section narrowed to the batch, `?batch=`. What
arrives on hover waits 4px to the left, comes in in 200ms and leaves in 120ms, and is simply there without a pointer
(`patterns/project/SheetFacts.tsx`).
Assigned says who holds the jobs, and how many nobody does. The rest - Review (accepted, waiting, skipped), the schema
version, Kind (a correction or not) and how many of its images are In dataset - are always the
same four, and wait behind *4 more properties* (*Hide 4 properties* once open), which opens in
place, cannot be tabbed into while folded, and stays open as J/K walks the batches. A hairline,
then its **jobs**, one 44px row each with no frame and no rules between them: the job's
number, its state as a glyph (a ring not started, a pie filling by the quarter, the check once
done), who holds it, how far it has come (`done/images`, read per job; pointed at, it opens the
job's split by annotation state), and where the row leads - *Open* into the editor on that job,
or *View* once it is done, read-only. The whole row is the way in, and ↑/↓ walk the rows; a host
with no editor to send a job to says its state in words instead. The panel opens with focus on
the batch's forward step, and Escape closes it. There is no footer.

**The top bar's end carries every action on the batch, each a ghost icon button named by its
tooltip** (`patterns/IconAction.tsx`) - except *Annotate*, which says its name because it is
where most visits to a labeling batch are going, and *Correct* (below). *Auto-label* comes first, when the batch declares
`pre_label`; then the lifecycle controls, each offered from the batch's `allowed_actions` - never
from its state read here - and each with its own gating, refusals and outcome. A withheld control
stays, disabled, and its tooltip says why. **The panel has no footer: what a control says is a
toast** (`SheetLine`, the house `Toaster` at the bottom right). The outcome of a press and a
refusal are raised once per batch - keyed by its id and named for it, since the panel may have
moved on by the time it is read - with their words and the way on (*Open the dataset ↗*), and their words
follow the control's report if it settles after the press; a refusal stays up twice as long. A
lasting state (*All 48 images in the dataset*) says nothing in the panel, because State, its *Open
the dataset ↗* and the In dataset property already say it. So words never squeeze under a 32px
square, the top bar stays one 48px row whichever batch is open, and the page never moves for a
message (a label flip is not feedback). Outside a panel a line stays in place, as a row. At the first or last batch, the arrow that goes disabled hands its
focus to the other, so a keyboard walking the batches keeps its place. The interface says *add to dataset* for the
kernel's `promote`.

**First, what ends or branches the batch:** *Delete batch*, quiet like the rest and in the
destructive colour only under the pointer or the focus, and disabled with its reason wherever the
batch does not declare `delete`; and on a
completed batch *Correct*, a ghost button that says its name (its tooltip: *Create correction
batch*), whose new correction then opens in the panel. A hairline parts them from what follows,
and is drawn only where it parts something. **Then
one forward step per state**, as
the batch declares them: *Approve* (it opens the approve dialog, because approval pins the
schema, cuts the jobs and has no route back - and, switch on, starts the batch too), *Start annotating*, *Annotate* (only when
the batch has exactly one job, straight into it), *Complete* and, on a completed batch with
images still outside the dataset, *Add to dataset*. All are quiet - no control in the bar is
filled - and the forward step is the one the panel opens on: *Annotate* while there is work left,
*Complete* once nothing is outstanding. The batch declares `complete` only once every frame is
settled, so while frames are still to do *Complete* is withheld and its tooltip counts them.

**Complete asks first, and the answer holds the choice.** A press opens a small confirmation -
*Complete this batch?*, that any open job closes with it and that a completed batch cannot be
reopened - with one switch, *Add the labeled images to the dataset*, on by default and keeping
the person's last answer; its button says *Complete* whatever the switch says. On, it completes
and adds in one go; off, it completes and says *Nothing is in the dataset yet*, and *Add to
dataset* appears beside it. A completed batch wholly in the dataset has no forward step: its
State says *In dataset*, with *Open the dataset ↗* beside it, instead of offering a press that
could only report that nothing moved - a curator taking one of its images out puts *Add to
dataset* back, and that press is how it is restored. What the panel does not do is draw frames:
there is no frame grid, no bulk moving of frames between states, no removing frames from a draft
and no thumbnail density here or anywhere in the app - per-frame work happens in the annotator.

Nothing on a row appears on hover. A menu - the only column of controls - carries everything
the row can do: *Jobs and details*, the forward step, and *Auto-label*. The table is paged from
the footer every full table carries (`DESIGN.md`, *Paging a table*): *1–8 of 8 batches*, rows per
page from 10, and the four steps, always there because it is also the table's count. The forward step is a pointer labelled from the batch's `allowed_actions` -
*Review and approve*, *Review and start*, *Review and add to dataset*, *Annotate* - and opens the batch's
panel (or, for *Annotate* on a batch of one job, that job), because Approve, Start and Promote
stay in the panel with their gating and refusals.

The page's exception to changing nothing is batches, which have no section to act in.
**Auto-label** - a model drafting labels on images nobody has labeled yet - is offered for the
project as a whole over the table, as the line or the band's icon described
[below](#auto-labeling-from-the-overview), and only where some batch declares `pre_label`. A batch
that declares it also offers **Auto-label** in its row menu and its panel, which opens the same
dialog over that one batch, titled for it. **Add images** and **Annotate** end the batches band,
after the filter and a hairline (`patterns/project/BatchesActions.tsx`), at the filter's 28px:
Add images is a `ghost` icon button named by its tooltip, always on offer and never the urgent thing; Annotate
is the page's one filled control, drawn only while a batch is open for annotation. A project with
no images has no band, so its invitation's *Add images* is the filled one.

**The Classes card is the last of the four, and it draws the classes rather than describing
them**: the class count beside its label, one bar split by each class's share of all annotations,
and a readout of one class — its share, its annotation count and how many assets show it (*31 on 8
assets*) — the
largest until another block is pointed at (`patterns/project/ClassShareBar.tsx`). Shares are of
annotations only: an asset can show several classes, so per-asset shares overlap and would not
sum to a whole. When a class falls under the imbalance threshold, the card carries a warning
glyph whose card is the project's imbalance note ([`DESIGN.md`](../../DESIGN.md#warnings)); the
card's door opens the Classes section, where the full legend lives. The rail under it holds the
**Images** panel alone. It previews the
project's first images in a grid that fills what the classes leave and scrolls past it, the
cut edge fading; each image's frame and size are on hover, and each, like the band's *Browse*,
opens the Assets section. There is no releases panel: the In dataset cell's badge points at the
Dataset's releases. The
components are data-only - view models in, callbacks out - and `screens/overviewView.ts` is where
the wire becomes those view models.
There is no activity card: no per-project feed exists on the wire.

### The dataset, its releases, and getting the data out

A release is the only truly immutable artifact, and the screen reflects that: a
release offers no edit and no delete, because there is no `ReleaseService.delete`
 - only a project's own cascade removes one, and the manifest blob survives even
that.

**The section is a line of versions, in two columns.** The left column holds the open
version's facts in its top region and, docked at its foot, *Releases*: the *working copy* — the
trunk as it stands — and under it every release, newest first. The wall of pictures takes the
rest, and the selected image opens beside it. There is no third pane: a version's facts sit above
the list that picks it, so the wall keeps the width. **The releases are docked so that opening one
never moves the list:** the facts differ in height from one version to the next, so the facts
scroll in their own region and the releases keep a region of their own — capped, scrolling inside
itself, its place set by its own height — and the entry just pressed stays under the pointer
(`screens/dataset/VersionNav.tsx`). Folding the dock hands its height to the facts. The section is full-bleed and fitted to the window at `lg` and up, each column
scrolling inside it; below that they stack.

**A version reads as four numbers over the page and a rail of panels under them** — the
Overview's sheet, so the Dataset reads like every other project screen: cells on hairlines, no
cards, one inset (`screens/dataset/VersionKpis.tsx`, `VersionFacts.tsx`; the pattern is
[`DESIGN.md`](../../DESIGN.md#fact-sections-and-the-action-a-thing-is-opened-for)). The working
copy's numbers are what the next release would freeze: its *Assets* against the newest release
(*Same as v0.4*, *+12 since v0.4*), how much is *Labeled* with a meter, its *Classes* with the
annotations and how many per asset, and the *Releases* so far. Its rail is its classes — the
Overview's own panel, read off the trunk: one bar of every class's share and a legend in which a
declared class nobody labelled is drawn too, because that is the gap a person training on this
needs to see. A release's numbers are what it froze: *Assets* against the release before,
*Annotations*, its *Split* (the shares and the seed) and its *Schema* with the VisionSet that
built it. Its rail holds *Proof* — this session's integrity check, *Not verified*, *Verifying*,
*Intact*, *Problems found*, with **Verify** beside it, and the manifest hash with two icon
buttons, copy and download — and *Export*, open by default since it is what a release is opened
for, holding the model, the recipe and the button with the job's state as its answer open or
folded. Every panel folds, and folded, its band says its answer.

**What is worth knowing and holds nothing back is a warning glyph beside what it is about**
([`DESIGN.md`](../../DESIGN.md#warnings)): assets without labels and a class nobody labelled on
their numbers, a schema a publish would move to on *Releases*, a format that cannot carry every
shape beside *Model*, recipes that could not be read beside *Recipe*, assets that have left the
dataset since a release beside its wall's title. What blocks — a refusal, a consent, a failed
download — stays a sentence under its row.

**States are chips** (`patterns/StateChip.tsx`, [`DESIGN.md`](../../DESIGN.md#states)): a
tinted ground, a glyph that fills as the thing nears done — lucide's dashed ring, a pie in
quarters, a check, a mark — and the word; what it means beyond the word is a card on hover or focus.

The history reads as a changelog: each version's entry says only what changed against the
release before it — the assets and annotations it gained or lost, a schema version or a split
that moved — so a quiet release says *Nothing changed since v0.3* and a busy one is longer. A
release verified this session says so in its entry (*Verified intact*, or *Failed
verification*), read from the same on-demand check its facts run; the history never starts
one. The differences are **net** — a release carries counts, not a membership a client can
compare — so *+28 assets* is how much larger the version is than the one before, never a
list of which assets or the batches they came from. The working copy's gains are written in
the informational colour, and it notes no schema or split, because it has pinned neither yet.

A release's wall is its images **that are still in the dataset** — the listing is the
trunk's, narrowed by `release_id` — and the head says how many have left since when the
counts differ. In the working copy a dot marks an image the newest release does not have.

**Publish is in the project bar; Export is in the column.** The working copy's forward action is
**Publish** (with its icon, named *Publish release* for assistive technology), the bar's one filled control. A release's is its *Export* section, with the
rest of its facts, so the bar draws nothing for a release. The export's form (`ExportForm`, a
render prop) wraps the release's facts alone: a folded Export keeps its body — and its job —
mounted, and opening another version never re-mounts the column or the wall. `DatasetScreen` still takes
`tab`/`onTabChange` like every other screen, so no host has to change; every name opens the
working copy.

**A recipe is chosen, written and edited where it is used: in a release's export.** A recipe
is a named project resource — no state, no `allowed_actions`, every write unconditional
(`docs/content/preprocessing.md`) — and it exists for an export, so it is not shelved beside
the versions. The Export section's *Recipe* is a select: *No recipe* first, then the project's
recipes by name — what one does, the model its hints came from and the export that last ran it
are its card beside the highlighted option. The "+" beside the field's label writes a new one.
Once a recipe is chosen, what it does is a line under the select, with *Edit recipe* and
*Delete* behind the "⋯" at its end (`screens/dataset/RecipeChoice.tsx`).
Writing and editing open the recipe in a modal over the page
(`screens/dataset/recipe/RecipeDialog.tsx`); a recipe saved there is the one the export runs,
and a deleted one falls back to *No recipe*. Escape, the close button or a press outside closes
it, and closing asks the modal whether its draft holds unsaved
work (`RecipeEditorHandle`, asked at that moment, never mirrored into the page) and, when it
does, asks *Discard changes to yolo-640?* first — *Keep editing* leaves everything as it was.

**A recipe is written in three steps**: *Name and model*, *Resize*, *Augmentation*. The header
names the step, counts it on the right (*2/3*, tabular) and draws one bar per step under them,
each filling from its start edge as it is reached (250 ms, strong ease-out); a screen reader
hears *New recipe, step 2 of 3* or *Editing yolo-640, step 2 of 3*. The bottom bar holds
**Previous and Next, nothing else** — Previous keeps its place, hidden, on the first step, and
on the last step Next is the save: *Create recipe*, or *Save changes*, shut until something
changed. Enter in a field is Next. The modal **fits each step**, in both directions: it is as
wide as the view needs — 22 rem for the steps, 24 rem for the saved view, with a 6 rem label
column since every label is short and 36 px rows, so two controls stand 8 px apart — and its height follows the
step that arrives (measured, so it is exact). Width and height move together (250 ms, strong
ease-out) and the step settles in with a short blur-fade just behind them, so no step leaves
empty room on either axis; the frame's size is the one layout the surface animates, because
the frame is what changes. While it moves the
frame clips rather than scrolls, so no scrollbar flashes, and it scrolls only when a step is
taller than the window allows. Under reduced motion the size changes at once and the step fades. Focus moves to the step that arrived, so a screen
reader says where it is and Tab starts there.

**A step's own problem holds Next on it, and only its own.** It is said once, between Previous
and Next — two lines at most, at the buttons' height, so a problem never moves the bar — in
the destructive colour (*Width is a whole number from 32 to 8192.*); the field it is about is
`aria-invalid` and points at it (`aria-describedby`). What the last save was refused for is
said in the same place, until the draft changes. For a recipe an export ran, the first step
has a *Used by* row — *The v0.5 YOLO11 export and 2 earlier* — read from its `used_by`, with
the target's catalog label or, for an export that named a format, the format. The export form
reads the recipes again when an export through one succeeds, so the row is current by the time
the recipe is reopened. The match is by name, so the row follows the caveats
[preprocessing.md](preprocessing.md#which-exports-ran-a-recipe) states.

**The body is the inspector's grid.** Every row is `PropertyRow` — the label in a 7 rem column,
the control at the value edge — so labels share one edge and controls another, and every
control fills the value column at the app's control height (28 px), so their right edges line
up too, on every step. Every control that does not apply — the size under *Original*, the
variants with nothing switched on — stays where it is, dimmed and disabled on the control
itself, so no browser takes a keystroke into it.

*Name* is a mono field that says *Suggested* inside it while the name is suggested from the
choices (`yolo11-640-aug2`), until somebody types. *Model* is the Export section's grouped picker
(`patterns/ExportTargetSelect.tsx`) in its `compact` form — one line, the model's name alone —
optional, with *Any model* as the list's first option, which clears it. In that form the list's
options are the names alone too: what a model takes, and the format it writes, is a card beside
the option the pointer or the keyboard highlights. The first card waits 400 ms and the next
ones follow the highlight at once and without motion, the way tooltips do, so scanning the list
is not a flicker of cards; a screen reader hears the tasks with the option, and one Escape
closes the list, card and all. What the chosen model takes and how it trains — *classify ·
detect · segment*, then *Letterboxes to 640 on its own.* when `trainer_resizes` is set, else
*Trains with letterbox at 640.*, or the format it writes — is behind an info button beside the
*Model* label (outside the `<label>`, through `PropertyRow`'s `labelAction`); the card's title is
the tasks, not the name, because the select already shows the name. The select keeps the value
column's full width. A new recipe starts from the model the project last exported a recipe with, when there
is one. Choosing a model preselects the size from its hints — `recommended_strategy` as the fit
and `recommended_size` in the width and height. The hints are read off the wire; nothing in the
browser computes a size. **Changing the model rewrites the suggestion only for fields nobody has
typed in**, so a size chosen on purpose survives a change of model (`recipeDraft.ts`,
`touched`). *Resize* opens on a drawing of what the fit does (`art.tsx`): a wide photograph meeting
the frame of the size below — shrunk with the rest hatched as padding for Letterbox, bent to fill
it for Stretch, grown past the frame for Fill, spilling past it unscaled for Crop, unframed for
Original — on a stage whose caption is what the drawn fit does (*Keeps the shape and pads the rest.*) — the
fit and the size are the fields under it, so the caption does not repeat them. It
draws the chosen fit, and the option under the pointer or focus before it is chosen. It is a
diagram, never the person's images, and hidden from assistive technology. Under it, the fit as a five-way toggle group — Letterbox, Stretch, Fill, Crop, Original; the two cropping fits' lines say that labels cut mostly away are dropped —
(its line is the stage's caption, and the toggle group's description for a screen reader); the width and height as numeric fields in
pixels, with the common sizes under them (320 to 1280) as a second toggle group. The pad is not
asked: a letterbox or a crop keeps the grey the recipe has (114 for a new one). *Augmentation* is one row
per step — *Flip*, *Brightness* (brightness and contrast), *Rotate* (quarter turns) — each a
switch labelled by its row and nothing else beside it. What it does is said once, in the card of
the info button beside its label (`ArtTip`): it draws it — original → result, brightness as one
darker and one lighter result as far apart as its amount — titles it with the answer (*Mirrors
left to right*) and says the rest in a line. A screen reader hears the same words as the switch's
description. Brightness's amount (±5 to ±50 %) is a
nested row under its switch, drawn as its child with a branch from under the switch's label, there only while the switch is on: it opens by its height (220 ms,
strong ease-out) and shuts back into it, and the frame follows it. Last, the variants per
training image as a stepper, with an info button beside its label whose card draws the three splits,
the training one's stack growing by a card per variant, and says variants are written for
the training split only, so an export with augmentation needs a release published with a split. Switching the first augmentation on
sets one variant and switching the last off clears it, which are the spec's own two cross-field
rules; every other bound of the request body is said between Previous and Next and holds its step.
Those are the body's shape, not a kernel rule the client is mirroring: the server still answers
422 to a body the form did not build. The modal draws no preview;
`POST /projects/{id}/preprocessing-preview` remains the API's ([preprocessing.md](preprocessing.md)).

Saving is a create for a new recipe and a whole-replace `PUT` at the stored name for one that
exists; `PREPROCESSING_RECIPE_NAME_TAKEN` and every other refusal render through the
vocabulary between Previous and Next. Success is a view of its own — *yolo-640 is ready*, or *Changes to yolo-640 are saved*,
with what the recipe does — with *Done* and *Keep editing*. Delete asks first — the recipe
alone goes, and an export already run keeps its own copy; a refusal such as
`PREPROCESSING_RECIPE_NOT_FOUND` is prose in the dialog. The export sends the chosen name as
`recipe=`, and nothing for *No recipe*; a recipes read that failed is said, and the export
runs without one. The two 409s an export can answer —
`AUGMENTATION_REQUIRES_SPLIT`, `PREPROCESSING_STEP_UNSUPPORTED_GEOMETRY` — are refusals, never
consents: prose with the remedy, and no checkbox.

**The trunk is a grid of pictures, looked at one at a time.** Every promoted asset is a
tile — the picture, with how many labels it carries and its frame number over its foot, both
read off the listing itself — forty-eight to a page, in promotion order. The grid is a listbox,
as the Images sheet is: a press selects a tile, the arrows move the selection by tile and by
row (turning the page at its edge), Enter puts the image in focus and Escape steps back. The
selected image opens beside the wall **in the Assets section's own detail**
(`screens/images/ImageDetail.tsx`) — the same well, header, arrows and focus mode, so a
picture reads the same wherever it is opened — with what only a member has coming in through
its two openings (`screens/dataset/Member.tsx`): its labels drawn over the picture in the
annotator's own shapes and colours, exactly in the picture's frame, with *Hide* and *Show*;
and under the picture's own facts, what is on it counted by class, its provenance — who made
the labels and which models — and the releases that hold it. The labels are read through the
dataset (`GET /datasets/{id}/assets/{asset_id}/annotations`) and not through a job, because a
trunk member carries no job id and a label outlives the work that produced it. It is a viewer:
the one write it offers is the removal — in the working copy only, since a release holds what
it froze — through a confirmation, because correcting a label is a correction batch's job.

**Verification is on demand.** `verify` re-reads and re-hashes every blob the
manifest names - `BlobStore.exists` is `is_file()` on a path *named by* the hash and
proves nothing - so it is not something to run because a list rendered. A broken
manifest is reported on its own: the service stops with `checked: 0`, so every other
number would be about a document that is not the one its hash names.

**A release the active schema no longer describes is refused with its classes.** Publishing
revalidates every trunk annotation against the active schema, and the 409
`RELEASE_CONTENT_WOULD_VIOLATE_SCHEMA` carries the per-class counts in `detail.blockers` — the
same `ClassCount` shape the schema editor's orphan dialog reads. The publish dialog renders
them under the sentence, one line per class, and says what to do: correct those labels in a
new batch, remove the frames, or publish a version that describes the classes again.

**The split's fractions are compared the kernel's way.** `0.7 + 0.15 + 0.15` is not
`1.0` in binary floating point, and the kernel uses `math.isclose(abs_tol=1e-9)`; a
stricter check in the browser would refuse a recipe the API accepts.

**`allow_lossy` is the third gate word**, and this is where it lives. `confirm=`
guards destroying data, `allow_destructive=` guards narrowing a contract, and this
one guards emitting an **incomplete copy of something that stays intact**. The
kernel never catches the three together and neither does the UI: three dialogs,
three questions.

**An export is addressed to a target model, never to a format.** The section's first control
is *Model*: the catalog `GET /export-targets` answers, grouped under *Ultralytics YOLO*,
*Community YOLO* and *Other formats*, the options names alone at the app's control size, and
what each model takes — the tasks it accepts or, for a format with no task vocabulary, the
geometries it carries — a card beside the one highlighted. The choice is sent as `target=`; the format it resolves to is the server's to
work out, and the retired `yolo` alias is never offered. A family the build has no heading
for lands under *Other formats* rather than out of the list.

`GET /releases/{id}/export-compatibility` would answer the lossy question before anything
is attempted; the dialog does not call it. Consent here is attempt-shaped: attempt → read
`LOSSY_EXPORT_NOT_CONSENTED` off the 409 → ask → retry with the flag. The 409 carries the
compatibility report as `detail.compatibility`, judged for the chosen target, and the
consent banner reads it twice over: one sentence naming the target, what it accepts and
how much of this release it would drop or degrade — *YOLOv10 accepts boxes only — 1,204
polygons would be dropped.* — and beneath it the classes lost, each with its annotation
and asset counts and the exporter's own reason. So the question names what is lost rather
than only that something is. `FormatOut.lossy`, read through the target's format, makes
the question predictable in advance, because lossiness is declared by the **format** — a
bbox-only format loses a polygon whether or not today's dataset holds one.

### Downloads, and the fourth instance of one finding

`<a href download>` sends no `Authorization` header, exactly as `<img src>` does not.
So an export archive and a manifest are fetched through the typed client and saved
with `saveBlob`: an object URL, an anchor, `a.click()`, and a revoke on the next
tick. `a.click()` rather than a synthesised event - a `MouseEvent` built in script is
not user activation, and a browser may refuse the download outright.

### The annotation page

Where M4's engine meets M3's API. Three findings shaped it.

**`next_pending_assets` is a work queue, not a navigator.** The obvious way to
build `‹ filename n/m ›` is `GET /jobs/{id}/next?n=<count>`; it is wrong, because
that route hands out **pending** assets, so the list shrinks as the user works,
`n/m` counts down under them, and an asset already annotated cannot be navigated
back to. The stable list is the batch's asset listing filtered to this job -
`BatchAssetOut` carries `job_id` and `progress`, exactly the pair a navigator
needs.

**The schema is the batch's pinned version, never the project's active one.**
Approval pins the active version, and it moves only through an explicit `repin`. An
annotator judged against a newer schema would offer classes the API then refuses, and
the refusal would be correct while the screen looked broken. The page walks job → batch
→ *that version*.

**Saving is a diff against what the server holds, and the answer is kept.** The
annotator mints client-side ids and the kernel mints its own (#40 declined a
`rebaseAnnotationId` for this reason). A save computes created / updated / deleted
against the page's record of the server and sends up to three all-or-nothing calls -
**deletes first**, so a failure leaves the smaller document a retry can be built from.
The kernel answers each with the rows it stored, in the order they were sent, and that
answer becomes the page's record (`settledSave`): the stored rows, and which local id the
server knows by which of its own. **The document itself is never rewritten by a save** -
the next plan reads a shape created here through that map, so it addresses the server's
id while the shape, its undo history and its selection keep their own.

#### Saving

**The page saves on its own.** Once the document has been still for 1.2s, whatever
differs from the server is sent. Navigating saves first and at once - `‹`, Next, the
gallery, back and the review moves all wait for it - and `⌘S` saves now. There is no
Save button: the bar's save state says where the work is (`Edited`, `Saving`, `Saved`, or
`Not saved` after a refusal), and the refusal itself is a sentence in the stage's notice
column. A read-only frame never saves; no dirty state is possible there.

This replaces a documented *no autosave* policy, whose three reasons each have an answer
now rather than being waved away:

1. **A save used to be followed by a rebuild.** The page refetched after every save to
   learn the kernel's ids and rebuilt the document from the answer - so a timed save would
   have rebuilt it under the cursor, dropped a drag, taken back anything drawn while the
   save was out, and emptied the undo history every few seconds. Now one `FrameSession`
   per open frame (`frameSession.ts`) builds the document **once**, from the first read,
   and keeps the kernel's own answer to each save as its record of the server. A later
   read is taken in only when it arrives while there is nothing to take back - no unsaved
   work, no save out, nothing in progress on the canvas - which is also how a stale cached
   read is corrected when a frame is reopened. A read that arrives while somebody is
   working is left: what the page writes is a diff against what it knows the server holds,
   so a row somebody else added is never deleted from here.
2. **Every call is all-or-nothing, and a refusal names an index.** So an autosave never
   fires mid-gesture - not during a drag, not while a polygon's points are being placed
   (the canvas reports a gesture in flight, `onGestureChange`), not while a suggestion
   waits to be accepted - and saves go one at a time, each planned against what the one
   before it left. A refused autosave is **not retried on a timer**: it waits for the
   document to change, so the refusal on screen is about the work just done, once.
3. **"I forgot" and "I closed the tab"** are still covered as they were: navigating saves
   first, and the `beforeunload` guard holds the tab while anything is unsaved *or a save
   is still out*.

#### Review is a flow, not an API-only edge

`annotated → review_pending → accepted | annotated` are three legal edges of
`ASSET_PROGRESS_TRANSITIONS`, and until now the browser offered **none** of them.
The "In review" state could only be populated through the API or MCP,
and `accepted` - the one state that records that a human checked the work - was
unreachable by any sequence of clicks.

The annotator's toolbar carries all three, each drawn from the frame's own
`allowed_actions`:

- **Submit for review** on an `annotated` frame (`submit_for_review`);
- **Return to annotator** on one in review (`return_to_annotator`) - named for the
  act rather than for the edge it rides, the same call `capabilities.py` makes:
  "back to annotated" describes the table, "return to annotator" describes what is
  being done;
- **Accept** on one in review (`accept`), which is the only origin that edge has.
  Offering Accept on an `annotated` frame - which the toolbar used to do - was
  offering a refusal, and a silent one.

**There is one screen, not two.** Which controls appear is the frame's state, so
the annotator and the reviewer are the same page wearing what it is looking at.
That is deliberate: the product has no annotator identity to assign work to, so
"reviewer" is something somebody is *doing* rather than somebody they *are*.

A frame out for review is **not writable** - `review_pending` is outside
`WRITABLE_PROGRESS` - so the page is read-only and its banner names the control
that undoes that, which is on the same toolbar. `accepted` has no exit at all,
which is why correcting accepted work needs a correction batch rather than a
progress move, and the banner says that instead.

**The job's progress reads *settled* frames, not the `annotated` count** - the total
less `outstandingWork`, which is `SETTLED_PROGRESS`'s complement. A readout that counted
only `annotated` goes *backwards* when a frame is accepted, which is the one thing a
progress readout must never do. It had that
bug, and it never bit because nothing could produce `accepted`; the real-server
cycle run caught it the moment the review moves landed, at 3 of 3 becoming 2 of 3.
A model's unreviewed guess is excluded from the count the same way `unannotated`
is, for the same reason: nobody has made a decision about the frame yet - and so is a
frame waiting on a review, which is still work somebody owes it.

#### Read-only is a mode, not an accident

The annotator opens as a **viewer** whenever the frame it is showing does not
declare `annotate` - which the kernel derives from all three dimensions at once:
the batch must be `in_annotation`, the job must be in `OPEN_JOB_STATES`, *and*
the frame's progress must be in `WRITABLE_PROGRESS`. One question, three causes.

**And it is a transition, not only a way to open** (#439). Pressing `Finish job`
closes the job under a window that is already open, so the workspace flips to the
viewer *in place* - same page, no navigation, no reload, on every frame of the
job rather than the last one. Nothing on the page computes that: the mutation
invalidates the frames' declarations and the wire's answer has moved, because
`asset_actions` reads the job's state. Before #439 it did not move, and the page
stayed a live editor over work it had just been told was over.

Before this it had no such notion. `batchState` reached the page and was consumed
only by the two auto-start effects, so a `completed` batch opened a fully live
editor: the canvas drew, the palette armed tools, the panel deleted objects, and
the first Save rendered `BATCH_NOT_IN_ANNOTATION` as a raw badge - with navigation
blocked while dirty, because moving between frames commits first. The only way out
was to undo your own work.

What a viewer looks like:

- a banner at the top saying it is viewing only, and **why**. A closed batch and a
  settled frame are different causes with different remedies, so they get different
  sentences; the closed-batch one names the correction batch, because forward-only
  correction is the answer to "then how do I fix this".
- `readOnly` on `AnnotatorCanvas` itself, which is where the guarantee has to live:
  pointer input goes straight into the interaction machine, so a greyed-out toolbar
  would still let a drag draw a box. A **primary press does nothing at all** and a
  keystroke runs only if it resolves to a *host* action. Panning, the wheel zoom,
  `mod+0`, hover and the cursor all stay live - a read-only mode you cannot move
  around in is a screenshot.
- the tool palette hidden outright (every control on it picks a drawing tool), and
  the side panel's writes gone: no delete, no class reassignment, no tag toggle.
  **Visibility toggles stay**, because hiding is a view decision the document has no
  field for.
- Save, Skip and Accept disabled, each from its own declaration rather than from the
  mode.

The batch's panel says the same thing one screen earlier: a job that is finished reads
*Done* rather than offering *Open* into the editor.

**Viewing never starts a batch.** A tile of an `approved` batch opens the frame or scan
read-only - nothing in that batch declares `annotate` - and the page sends no transition on
mount. The banner carries **Start annotating** while the batch declares `start`: it sends
`POST /batches/{id}/start`, and once the re-read job declares `start` the page takes the job
(`POST /jobs/{id}/start`) and becomes the editor in place, with no reload. A refused start is
said in the editor's notice column and the page stays a viewer. If the batch was started
elsewhere first, the `INVALID_TRANSITION` is not said: the page re-reads both the batch and the
job, so the job is taken just as it would have been. Inside a batch that is
already `in_annotation`, opening a `pending` job still takes it, as before.

#### Adding a class where the pin cannot move

The add-class chain used to be save → publish → re-pin, running the third step
unconditionally. `REPINNABLE_STATES` excludes `completed`, so on a settled batch the
version published and the pin then refused: a new version in the project, a batch
still judged against the old one, and an error about a step nobody asked for.

Publishing an additive version now moves every open batch's pin inside the kernel's
own transaction, so a completed batch simply is not one of them - there is no
second request left to refuse. What remains is **saying so before the press**: the
page reads the batch's `repin` declaration before anything is published; when it is
absent the dialog says the batch will keep its current version - and that the
version is still published, and that a correction batch approved from now on will
pin to it - and the button reads **Publish without re-pinning**. Two acts, two
words, and the user reads which one they are about to perform instead of learning
it from a refusal.

#### Reversing a skip is an action, never a side effect of drawing

`progress_after_annotating` never moves an asset to or from `skipped`, because
that is a person's decision and drawing a box does not contradict a decision.
That rule is right, and until #187 the browser simply never offered the one exit
`ASSET_PROGRESS_TRANSITIONS` allows - so a user could label a skipped asset, watch
the save succeed, and lose the work at promotion, since `PROMOTABLE_PROGRESS`
excludes `skipped`.

**The kernel now refuses that write outright**, so the silent loss is unreachable
rather than merely un-offered: `WRITABLE_PROGRESS` gates all three annotation
writes and a skipped asset answers `AssetNotWritable` (409 `ASSET_NOT_WRITABLE`)
 - see [jobs.md](jobs.md). Everything below still stands and is now the *good*
path rather than the only guard: Un-skip first, then label. The batch asset's
`allowed_actions` declares `annotate` exactly when the write will be accepted, so
the page reads that rather than deriving it.

The page closes that with the **explicit** move rather than an implicit one. The
asset's own progress is always on the bar, and on a skipped asset `Skip` is replaced
by **Un-skip**, which sends `unannotated` and stays on the asset - settling advances
because you are finished with it, reversing does not because you have just come back
to it. Automatic-on-save was rejected: it would overwrite a recorded decision without
asking, and a decision is somebody's action here the same way `confirm=`,
`allow_destructive=` and `allow_lossy` are one layer down. A prompt was rejected too
 - a modal in the middle of the annotation loop interrupts the one gesture the page
exists for, and it leaves a user who only wants to un-skip with nothing to press.
What the automatic reading was right about is that `Save` must never look inert; it
does not, because a notice beside the canvas says why the counter stayed put.

#### `?` opens a sheet built from the binding table, not from a copy of it

The page used to pass `onHostAction={(name) => name === TOGGLE_HELP}`. Returning `true`
means *the host handled this action*, so pressing `?` - a real binding in
`core/input/bindings.ts` - was consumed and then discarded: the user got nothing, and
the engine had been told the request was served, so nothing else could pick it up
(#189). An unhandled host action now returns `false`, which is what that value is for.

`ShortcutSheet` takes a `Registry` and renders whatever is in it. It is the same map
the canvas resolves keystrokes against, because both call **`defaultRegistry(schema,
overrides)`** - one exported spelling of the fold, added so the two callers cannot
drift. Delete a binding and a row disappears; add a class to the schema and a digit
appears. Both are mutation-tested, which is the check v1's hand-written
`HelpModal.tsx` never had.

The English is not derived: an action's `kind` is a discriminant, so a
`Record<ActionKind, …>` turns one into a sentence, and an eleventh action kind fails to
compile rather than rendering a blank row. Host actions stay open - core enumerates no
capability - so an unknown name renders as itself. `mod+c` / `mod+v` were listed as
**deliberately unbound** until #123 claimed them; they are ordinary rows now, and the
slot that held the note carries the fact that became the surprising one - inside a text
field the two chords are still the browser's.

**Accept** calls the existing progress endpoint with `accepted`, and is enabled only
where `ASSET_PROGRESS_TRANSITIONS` allows the move - offering it on an untouched
asset would be offering a refusal. It is **not** loosened to cover a skipped asset:
the way to reach `annotated` from `skipped` is to un-skip and annotate, which is
what the machine says. The zoom `−`/`%`/`+` and fit drive
`AnnotatorCanvas`'s new `viewRef` handle, whose `fit` is the same implementation
`mod+0` reaches, which is why that chord stays intercepted rather than forwarded.
The version dropdown and Merge that the original reference design draws are **not on the bar**. The
branch-and-merge model behind them was settled on 2026-08-10 as superseded by the
batch, review and release model the product already has (cf. #127), and until
2026-08-05 they rendered disabled to keep the bar the shape the design shows. That
is the one case disabled-with-reason cannot serve - the reason would be "this
feature does not exist", which says nothing about what would enable the control -
so they were removed.

#### The tool strip, and the geometries with no tool behind them

The strip lists `select` plus one button per distinct **drawable** geometry the
schema declares, built from `drawableGeometry`. A `classification_tag` gets no
button and never will: there is nothing to draw, because the label is about the
whole image, and the Labels tab is where it is toggled.

**Four tools**: box, rotated box (#1160), polygon and polyline. `polyline` spent one release
as this section's worked example of declared-but-not-drawable - #223 shipped the
geometry end to end and stopped short of the tool - and it is a live button now.

The rule that example demonstrated is kept as a mechanism, and `PENDING_TOOLS` holds it
with nothing in it: **a geometry listed there that a schema declares gets a disabled
button carrying the reason**, placed after every usable tool, never a gap. A missing
control would say "this schema has no lanes", which is false, and it is exactly the
ambiguity `ui-capabilities` forbids: absent and not-yet-available look identical and
only one of them is true. While the record is empty, no geometry gets that button:
`mask` and `keypoints` are refused when a schema version is written, so no schema
declares one, and a class declaring `polyline_3d` or `cuboid_3d` gets **no** button on
an image - those two are drawn on a scan, in its own
[editor](ui/annotator.md#editing-cuboids-and-polylines-on-a-scan), and drawn read-only
on an image (see [below](#3d-labels-are-drawn-not-edited)).

When a button is disabled it uses **`aria-disabled`, never the native `disabled`
attribute**. A disabled `<button>` receives no pointer events, so the tooltip would
never open - and a disabled-with-reason control whose reason cannot be read is a
bare disabled control. The press is refused in the handler instead, because
activating a class whose tool does not exist would leave `toolFor` answering
`select` with that class held: a canvas whose primary gesture is inert, which is the
bug #198 fixed.

Two things follow that are worth stating so they are not "fixed": a lane is **not
selectable from the canvas** (`geometryContains` refuses an open path - hitting one
is distance-to-segment with a zoom-independent tolerance, and it is only worth
solving beside the tool that edits the result), and it is **not draggable**. The
object list is how a lane is selected, which is a real affordance rather than a gap.

#### Suggesting a shape from a click

The sparkles button - hotkey `S` - arms the **suggest tool**: click the thing you
want and a segmentation model proposes its shape, which you can then adjust
before accepting. It answers from one of two places - a model connection on the
server, or a model running in this browser - and the tool's bar, the row above the
picture, carries that choice along with everything else the tool says.
Through a connection it is `POST /inference/suggest`
(`docs/content/inference.md`).

**It runs through a connection that can answer a click**, which is a narrower set
than "the ones that are ready": only those declaring `point_suggest`. A workspace
whose only downloaded model answers text prompts gets a bar saying so, and no
request is sent - the server would refuse each one truthfully, which is a correct
answer to a question the editor should not have asked. The bar tells that case
apart from having nothing configured and from having nothing downloaded, because
each is a different thing to go and do.

Where more than one connection can answer, the bar carries a picker naming the
model under each, and the choice is remembered **per project** - it is a
preference about this browser, so it survives leaving the editor and does not
become a workspace setting that everybody annotating shares. With one candidate
there is no control at all, only the name of what is answering. The picker - like
the Server | Local choice and the shape - is drawn only while nothing is pending:
changing which model answers while a proposal is on screen would leave a shape
nothing in the bar explains.

**Server, or Local.** The bar's `Server | Local` choice is where a click goes.
**Server** is the connection described above. **Local** runs a smaller segmentation model
in this browser, which answers without the picture or the click leaving the machine
and without a connection being configured at all - useful where the workspace has no
model that can answer a click, or where the server is slow to reach.

It has to be downloaded first, and the bar says so: `Download` with its size, about
41 MB, on an explicit press, never on its own. Before that press the bar names the
model's download size on the button, and its license and upstream source behind the ⓘ
and in the small menu on the model's name. Verified weights are stored in this browser and normally
survive a reload; the browser can still evict its storage, and a removed or evicted
model can be downloaded again. If storage is unavailable, a verified download may be
ready for the current session without being described as installed.

Opening the app, arming Suggest, or choosing **Local** never downloads missing
weights. A stored choice for a known model remains selected and shows the Download
action when that model is not installed. An installed model is loaded only when the
suggestion surface needs it, and loading from browser storage does not fetch the model
again. **Remove from this browser**, in the model's menu, releases the running model and removes its stored
weights. The model source receives artifact requests during an explicit download, but
the image and points being annotated remain local during browser inference. Self-hosted
deployments can replace the public model source with `VITE_MODEL_CDN_BASE_URL`.

**Alt-click needs Server.** The model running here takes only points that are *on*
the object; a point marking something that is not part of it is refused rather than
answered with something that is not an exclusion. Switch to Server to refine that
way. Everything else - the first click, refining with more points, the tolerance,
`↵` and `Esc` - works the same on both.

The gesture:

| Press | What it does |
| --- | --- |
| left-click | adds a point on the object, and asks again |
| alt-click | adds a point that is **not** on the object, and asks again |
| `↵` | accepts the proposal as an annotation |
| `[` / `]` | coarser or finer - doubles or halves the tolerance, without opening anything |
| `Esc` | clears the points; then puts the tool away |

Every click sends **all** the points placed so far - the route is stateless - and
the answer replaces the preview. The first click on a frame is the slow one,
because the model reads the whole image once; refining after it is quick.

**A wait says so in the bar, and nowhere else.** It reads `Looking at that…` on the
same frame the request leaves. Past a second and a half - long enough that this is
plausibly the first click on the frame - an ⓘ appears beside it whose card explains
why that one is slow.

Nothing appears at the cursor or the click point. A ring and a busy cursor used to,
and both were taken away: sitting on the picture beside the pointer, they read as
the machine having seized rather than as work in progress, and they were in the way
of the thing being looked at.

Refining while an answer is still out is fine and is the ordinary way to work: the
shape already on screen stays drawn, so you keep the best answer so far while the
next one is fetched. The bar goes back to `Looking at that…` for the duration,
which is why `Accept` is not offered until the newer shape arrives. `Esc` takes the
whole thing back at once. A refusal replaces it with `Suggestion refused`, and the
server's own words - which carry the remedy - are the ⓘ's card, verbatim, and the
button's description for a screen reader; so nothing is ever left saying a request is
out when it is over.

**The proposal is not an annotation until it is accepted.** It is drawn faintly
with a dashed outline - solid is what an accepted annotation gets - carries its
class and the model's confidence beside it, and is in neither the document nor the
undo history. `Esc` is its undo. Switching class, switching frames or leaving the
page discards it, and nothing is written.

**Its vertices are drawn the whole time it is up**, which is what makes the tolerance
setting something you can see rather than a number that changes. A committed shape
shows its vertices only while it is selected; a proposal is not selected and shows
them anyway, because choosing how far the polygon may drift from the mask is
exactly a question about where the points are.

**The shape can be adjusted before it is accepted**, from the Detail slider in the
same bar - never a panel over the picture, which would cover the thing being
adjusted. It sits inline beside the proposal's state, with nothing to open first.

One setting, and whether it appears is the server's answer rather than the
editor's guess (`docs/content/inference.md`). **Detail** is a slider on a
doubling track over the tolerance, from `0.25` px to `16` px, defaulting to
`1.0`, with a label beside it naming the value and what it costs,
`2.0 px · 23 pts`. `[` doubles it and `]` halves it from the keyboard.
Either way it costs no request at all: the answer carried the outline it was
reduced from, and the editor re-simplifies it here, so the shape and its
vertices move under a held key. On a small object a coarse tolerance can leave
nothing to show; step finer and the shape comes back.

The slider hands focus back to the canvas the moment a drag ends, and none of the
bar's buttons takes it on press, so `[`, `]`, `Esc` and `↵` keep working. Tab still reaches it, for driving it from the
keyboard on purpose.

On a class that stores a box the slider does not appear at all, because the
tolerance changes an outline and a box has none. The editor does not know that;
the answer says so, by naming no settings.

**Two settings were here and are not.** Closing the gaps in the mask and proposing
every separate piece are still done, at fixed defaults. As controls they did
nothing to an ordinary clean mask - every position gave the same shape - and each
touch of one re-ran the model to produce it.

**Adjusting into nothing says so and leaves the controls up.** A setting can
empty the proposal - every piece too small, or an outline reduced past being a
shape - and when it does, the bar says what happened and every control stays
where it was, so the way back is the way you came. The preview never simply
vanishes.

**A click proposes one shape.** A mask that comes back in several pieces is one
object seen around an occlusion, not several objects, so a point answer never
splits into several proposals.

**Detect all proposes every instance, and you choose which to keep.** Beside the
state, *Detect all* asks a text-detection model connection - one declaring
`text_detect` - for every instance of the held class on this image, by the
class's name (`POST /inference/detect`, `docs/content/inference.md`). It runs on
Server only: there is no detector in the browser, so on Local the button is not
there, and nothing asked on Local is ever sent to the server instead. Without a
ready detection connection that draws a shape the class holds, the button is
disabled and its description says which is missing. A box-only model answers
boxes, even for a class that also takes polygons.

Every candidate starts chosen, each with its own confidence, and the bar's state
reads as one count, `N of M chosen`, a button that opens the list of candidates.
Click a candidate on the picture, or untick it in that list, to leave it out; it
stays on screen so it can be taken back, drawn as excluded - a dotted outline, a
black-and-white hatch instead of its fill, muted vertices, and `left out` after
its label. In a detection a click only chooses: a click on no candidate places no
point. `Accept N` names how many it will write; with none chosen it is disabled and
the count's place says why (`Choose a candidate to accept`, or `None chosen` where
the bar is narrow), and `↵` writes nothing and does not move to the next frame -
nor does `↵` while an answer is still out. `Esc` discards every candidate. A
detection carries no outline to reduce, so Detail does not appear for it.

**Accepting is one action and one undo.** `Accept` writes the chosen shapes and a
single `mod+z` takes all of them back; `mod+shift+z` brings all of them back. The
ones left out go with the proposal and are never written. Changing class or frame
while candidates are up, or while the answer is out, discards them and writes
nothing.

**The tool stays armed while you change class.** Arming it is a decision about how
to work, and picking the class to work on is the next thing you do - so a class
switch ends the proposal on screen and not the tool. The next click asks under the
new class, in its geometry and its colour. Only pressing the button again, or
moving to another frame, puts the tool away.

Land on a class that can hold no proposal - a tag, a lane - and the tool **parks**
rather than switching itself off: the button dims and says why, the bar says what
to pick, and the canvas goes back to drawing that class normally. Choose a box or a
polygon class again and the tool carries on, with nothing to press.

Accepting creates ordinary annotations, in one undo step, carrying
`provenance: model`, the `model_ref` the answer named and its `confidence` - the
same write path a hand-drawn shape takes, so the same schema rules apply and the
frame settles the same way.

**The tool is offered only for a class that can hold the answer.** The proposal
comes back as a polygon for a polygon class and as the shape's bounding box for a
box class; a schema whose classes are tag-only or lane-only gets no button at all,
because there is no kind the answer could be expressed in. That is the *project*
answered; the parked state above is the same question asked of the class you are
holding, and it dims the button rather than removing it because the answer changes
again the moment you pick another class.

Arming it with no usable connection shows, in the tool's bar, what is missing -
none configured, or configured with its weights not yet downloaded - with the full
explanation behind its ⓘ and one action to fix it. Nothing navigates away, and no
exit loses work. A refusal from the server is said in the same bar, with the
server's own words behind the ⓘ, which is what carries the install command when
the optional runtime is absent.

#### 3D labels are drawn, not edited

A frame carrying a `polyline_3d` or a `cuboid_3d` asks for its calibration
(`GET /projects/{id}/assets/{asset_id}/calibration`); a 2D-only frame never does. Each 3D label
is projected through the **effective** calibration by the annotator's headless
`projectLabels3D` and drawn beneath the 2D annotations exactly as an unselected 2D polyline is,
occluded runs dashed. Only the intrinsics and the plumb-bob distortion take part: the points
are already in the camera's sensor frame, and the extrinsics map that frame to the rig. A
segment is clipped at a near plane 1 cm in front of the camera, and, under distortion, at the
radius where the lens model starts to fold back, radially or tangentially; a label wholly behind
the camera draws nothing.
Under distortion a straight segment is sampled so it bends as the lens bends it.

A `cuboid_3d` is drawn as its twelve edges, each projected and clipped exactly as a two-point
segment of a path is: an edge that crosses the near plane is cut at it rather than dropped, an
edge wholly behind the camera is dropped, and the edges in front still draw. Its corners are the
centre plus half the size along the heading `(cos yaw, 0, -sin yaw)`, the width axis
`(sin yaw, 0, cos yaw)` and the sensor's y axis (`cuboidCorners`). A box records no visibility,
so every edge is drawn solid.

The overlay is not in the document: it is not counted, listed, hit-tested, selected, undone or
saved. It draws **nothing** when the frame has no calibration, or when the calibration was
measured at another size than the asset (it is never rescaled). Each of those says so in a calm
editor notice, *3D labels are not drawn on this image*, with the reason. A calibration that
cannot be read at all draws nothing under the same notice, carrying the refusal: a lens model
this build does not know is refused by the response check before any projection, so it shows
the generic *The server answered with something this app does not recognise.* under
`MALFORMED_RESPONSE`. A refetch that fails while a calibration is already drawn keeps drawing it
and raises no notice.

#### Point-cloud scans are viewed in 3D, and their labels edited there

A `point_cloud` asset appears in galleries and lists with its top-down thumbnail, and its tile,
timeline cell and frame-gallery entry name it as a scan rather than as a frame (the timeline cell
reads `Scan 2, annotated`; a scan has no frame number). On the
annotation page its stage is a WebGL2 view instead of the image canvas: the page fetches
`GET /projects/{id}/assets/{asset_id}/points` (at most 500,000 points, thinned by the server;
the corner of the view says how many of the scan's points are shown) and draws them with the
annotator's `PointCloudCanvas`. Nothing is re-expressed: the view orbits about the **up axis of
the frame the scan's source declares** (`+z` for `lidar_flu` and `lidar_rfu`, `-y` for `camera_rdf`), and a
source that declares no frame is shown with `z` up and has no labels to draw.

The open job's `cuboid_3d` labels on the scan are drawn as their twelve edges, and a
`polyline_3d` as its segments, in the class colour, in the scan's own frame - no calibration is
asked for or used. A cuboid's corners are its centre plus half its size along the heading
`cos(yaw)·forward + sin(yaw)·left`, across it, and along up (`cuboidCorners3D`). Edges are drawn
over the points rather than hidden inside them. Both kinds live in the page's scan document, so
in **Edit** mode, which adds an orthographic top-down view beside the perspective one, cuboids
can be selected, drawn, moved, resized, turned, deleted and saved, and polylines drawn on the
ground plane (Enter or a double-click finishes, Escape cancels), their vertices dragged, inserted
by a click on the selected polyline's segment and removed by alt-click (never below two), and the
whole label deleted with Delete (see
[the scan editor](ui/annotator.md#editing-cuboids-and-polylines-on-a-scan)). A scan polyline's
vertex visibility is not editable: a new polyline leaves it out, so it stays unknown, and an
imported polyline keeps its declared visibility, with an inserted vertex recorded as unlabeled.
The Annotations panel and the object badge count both kinds.

Outside Edit, drag orbits, a right or middle drag (or shift-drag) pans, and the wheel zooms; with the view
focused, the arrow keys orbit, `+`/`-` zoom and `0` resets. The orbit's pitch is held between
level with the target and just short of straight down from above, measured about the declared
up, so the scan is never seen from underneath. The controls in the corner colour
the points by height along up, by intensity, or by the scan's own colour - a mode the scan
does not record is disabled with the reason - turn the labels off and on, and reset the view.
The opening view frames the body of the scan, ignoring the farthest 2% of returns on each axis.
The image stage's tool strip, zoom cluster and canvas shortcuts are not shown on a scan.

A browser with no WebGL2 gets a notice instead, with the scan's point count, format, frame and
bounds and its top-down thumbnail. A points request that fails, or a buffer this build cannot
read, says the scan's points could not be loaded. A lost graphics context says so and the view
comes back when the browser restores it.

### The annotation side panel

`AnnotatorPanel` - Classes, Tags and Annotations, three stacked regions with no
tabs - lives in **`ui-core`**, not in the annotator's adapters. The annotator's whole claim is that it *"owns no UI a product
would want to restyle"*: it ships headless, with no Tailwind and no design tokens,
so a styled panel inside `adapters/react` would be the first thing an embedder had
to fight. `ui-core` already depends on the annotator, so the dependency runs the
right way.

The *capability* went the other way and had to. Hiding an object must remove it
from the **hit test** as well as the drawing - `resolveTarget` reads the document
the machine is given, so filtering only the render layer leaves an invisible shape
catching every click over it, which is worse than not hiding it at all. Only the
canvas owns that document, so `AnnotatorCanvas` grew a `hiddenIds` prop and the
panel drives it. **The annotator gained an ability; `ui-core` gained the UI.**

Three rules the panel inherits:

- **One `Selection`, two views of it.** The panel reads and writes the same store
  the canvas does, so the round trip is a property rather than a synchronisation.
- **Every write is a command.** Delete goes through `removeAnnotationsCommand`, the
  path the keyboard takes, so one history entry reads the same however it was
  asked for.
- **Class reassignment offers only geometry-compatible classes**, because the
  kernel judges geometry per class (`DisallowedGeometry`) - offering the rest would
  be offering a refusal. It applies behind a button, so a keyboard-driven picker
  does not fill the undo history with states nobody chose.
- **The object list is drawn shapes only.** A classification tag has no coordinates
  and renders in neither layer, so it is assigned in the Tags region and counted
  there; listing it here gave it a hide button that hides nothing and made a
  tagged-but-undrawn frame read `1 object` over an empty canvas.

Visibility is view state and returns the **same document object** when nothing is
hidden, which is what keeps `AnnotationLayer`'s `memo` bailing out - #49's finding
about `skipId`, from the other side.

### Thumbnails, and the `<img>` that cannot work

**Every route but `/health` and `/openapi.json` needs a credential, and an
`<img src>` sends no header.** The browser issues that request itself, with cookies
and nothing else, so pointing an `<img>` at
`GET /projects/{p}/assets/{a}/thumbnail` produces a 401 and a broken-image icon on
every tile whenever the credential is a token - and the API takes no token in the
query string. A browser *session* would in fact carry, since a cookie is exactly
what an `<img>` does send; the mechanism stays because it must work for both, and a
grid of previews that rendered only for locally-signed-in users would be the kind of bug
nobody reproduces. So `AssetThumbnail` fetches the bytes with the credentialed
client and
hands the result over as an object URL - which it then **revokes**, because a
grid scrolling a thousand assets would otherwise hold a thousand JPEGs alive
with nothing referencing them.

The cost is smaller than it looks: for an image the route carries
`Cache-Control: public, max-age=31536000, immutable` with the thumbnail hash as its
`ETag`, and a `fetch` gets the browser's HTTP cache as much as an `<img>` does. A scan's
preview is `private, no-cache` and revalidated against its `ETag` (a 304 when unchanged),
because declaring another frame for its source redraws it.

A **NULL `thumbnail_hash` is a state, not a failure** - a preview that would not
render is deliberately not an `IngestFailure`, because the asset exists and nothing
was lost. It draws a placeholder, and offers no button: the remedy,
`backfill_thumbnails`, is reachable only from the CLI and MCP.

**Paging bounds the response, and a count that does not move is how "have I seen
everything" is answered.** `limit`/`offset` bound the *response*, and a client reading a
batch's frames pages it with `useInfiniteQuery` (`useBatchAssets`, exported for hosts):
"have I seen everything" is `seen < total`, because `total` is the size of what the request
matched - the whole batch, or one job's frames where `job=` narrows it - and does not move
while you page it. The standalone app's Overview and Assets sections read the project's own
listing instead (`useProjectAssets`), a window at a time; no screen of it draws a batch's
frames, which is the annotator's to show.

#### A batch's jobs, in its panel

**Once a batch has jobs, the panel lists them, and nothing draws their frames.** A batch is
partitioned, and a person works one part of it, so the job is the unit the panel shows: who
holds it (or *Unassigned*), `done/images` read from that job's own progress
(`GET /jobs/{id}/progress`, never the batch's), a meter, and *Open* into the editor on that job
or, when it is finished, *Done*. There is no accordion and no per-job frame grid: a batch-wide
grid beneath a per-job control would put two scopes for the same frames on one screen, and the
frames are the annotator's to show, in its frame gallery overlay. The assignee is shown, not
edited - the browser does not reassign a job; `PUT /jobs/{id}/assignee` does. Jobs are listed
only once they exist, the same `hasJobs` gate the progress reads use, so a draft reads *No jobs
yet. Approving the batch cuts it into jobs.* A failed read shows its refusal, with *Try again*,
instead of the jobs silently vanishing - an empty list and a failed one look identical to the
naive `undefined`-or-zero-items check, and only one of them means there is nothing to open.

**Frames are not curated in bulk in the browser.** A batch has no frame grid, no bulk progress
moves and no draft-membership editing; per-frame work - labeling, skipping, un-skipping,
submitting for review, accepting, confirming a model's labels - happens in the annotator, one
frame at a time, and a draft's membership is edited through the API and MCP only
([batches.md](batches.md#membership-is-editable-in-draft-and-nowhere-else)).

#### The way in

**`Start annotating` is in the panel's top bar only for an `approved` batch, and there it is the
transition rather than a door.** That press is `POST /batches/{id}/start`, the batch's own next
step declared as `start` in its `allowed_actions` - and it navigates nowhere: the panel re-reads
the batch as `in_annotation`, and the job's own door is then what opens it. There is no icon on
it; it is a state change, not a link.

**Once the batch is open, the way into the annotator is the job's own door, because only a job
answers which frames.** A batch is partitioned, so a bar control would have to pick a job
silently; the panel lists the jobs, and each unfinished one carries *Open*, straight into the
editor on that job. The one exception hides no choice: a batch with exactly one job has *Annotate*
in its top bar, which opens that job, and the panel opens on it while there is work left. Neither takes the job: opening one only navigates, and the editor itself takes a
`pending` job to `in_progress` when it opens it.

**The batches band's `Annotate` follows the same rule one level up.** It says its name, with the
pen before it, and its tooltip says where it goes. It opens the batch that is open
for annotation - straight into that batch's one job where it has exactly one, and onto the
batch's panel to pick a job otherwise. With two or more batches open it is a **split button**: the
label opens the newest open batch that still has work (its tooltip names it and what is left), and
the chevron welded to it lists every open batch, because the batch decides which schema version
the work is judged against; picking one then applies the same rule, its single job or its panel.
The label's batch is read off the list's order, never a remembered choice.

### Batches, and a machine that only goes forwards

`draft → approved → in_annotation → completed`, with **no route back to `draft`** -
jobs are already cut against the pinned schema. So the panel offers one
forward action per state and never a revert: an action that would be refused is an action
that should not be drawn.

Approval is when the project's active schema version **pins to the batch and stops
moving**, which is why a batch's row and panel on the Overview show no schema pin until then. `complete` is
*derived* rather than automatic - the service reads the jobs and refuses while any
is outstanding - so that button is offered and its refusal is real.

**The approve dialog** asks *Approve {name}?* and says what it costs in one sentence: its images
freeze, the project's schema version pins (named when known - never read to pre-empt the
server's refusal, whose *Define your labels* remedy stays), and a draft cannot come back. Its one
switch, **Start annotating now**, is on by default: approving then sends `start`, the same two
requests *Approve and start* sends, and a refused start leaves the batch approved and says so in
the dialog. Off, the batch stops at `approved`, the window for assigning its jobs, and starting
stays the explicit act it is. The button always reads *Approve*. **Jobs** are folded behind their
answer (*One job*, *3 jobs of up to 25*), because the common batch is one job; open, it is *One job*
or *Split*, and a split is images per job on a stepper (by fives on a batch over 20 images, by ones below, or typed; it starts at 25, or at half a smaller batch) with the jobs it makes beside
it - **single job** and **by size N** on the wire. Each opening starts from those defaults. `BySegments` is
deliberately absent, the same call the CLI made: the only caller holding an exact
partition is a program, it is the one strategy that can be *wrong*, and expressing
it means typing tuples of UUIDs. Its `kind` is always sent explicitly - a
discriminated union's tag emitted by default reads as optional in the schema while
pydantic needs it in the dict to pick a variant.

#### Two steps as one

Two pairs of lifecycle steps are offered as one control, on the screens where a person
takes them together. **Approve** with its *Start annotating now* switch on, its default, takes a
draft through `approved` to `in_annotation` - in the batch's approve dialog, and in place as the
Add images dialog's last step, which draws the same form. **Complete**, with its *Add the labeled images to the dataset* switch on, closes
the batch and moves its work into the trunk; it is the panel's one way to finish a batch,
withheld until the batch declares it, and says what the press moved in the same sentence *Add to
dataset* uses. Its press is one request, `POST /batches/{id}/finish`, which closes the open
jobs and the batch in one kernel transaction; a refusal is said in words and closes no job, even
when an asset was reopened after the panel last read the batch.

Neither is a new transition. Each control sends the two requests a person could send one
at a time, in order, and stops where the kernel stops it: a refusal on the second step
leaves the batch where the first step put it, and the control says so - the first step's
outcome as a line (*Approved against v3*, *Completed, closing 1 open job*), the second
step's refusal beneath it in the shared vocabulary, never in its place. The line stays
once the batch's own declaration has moved on, because it is the only thing on the
screen that explains the state the batch is now in.

*Approve and start* is offered only while the project has an active schema. Approval pins
one, and `allowed_actions` cannot say whether there is one to pin: that is a fact about
the project rather than a state of the batch, so the surface reads the schema itself.
Without one, the batch keeps its existing controls and the run card says in words
what approving needs, with the way to the schema section beside it, and keeps *Open
batch* filled. Only a schema that does not exist counts as none - any other failure of
that read says nothing about the project, and the card offers what it always did.

#### Deleting a batch

The one control in the panel's top bar that ends a batch rather than moving it
along, and the only irreversible one - so it sits first among the batch's actions, parted by a
hairline from the forward step at their end, quiet until pointed at or focused, when it takes the
destructive colour, and asks before it acts. It is
a single component (`screens/DeleteBatch.tsx`) so that there is one spelling of which
states may be deleted, of the blast radius, and of the confirmation, rather than a
hand-mirror of the rule one layer up from the one `capabilities.ts` removes.

Availability is `delete` in the batch's own `allowed_actions`. Where it is not declared, the
button is **disabled with the reason** in its tooltip (the sentence
is `withheldBecause`'s, shared with every other withheld control on these screens). That includes
a `completed` batch: the button stays, disabled, and its tooltip points at a correction batch -
the onward route, *Correct*, beside it. The declaration decides, never the state word: a completed
batch whose declaration does include `delete` (a newer server) gets a live button.

What the dialog says is the **verified** blast radius. The batch, its jobs and the
per-frame progress go; the frames and their annotations stay, because
`annotation.asset_id` is a label's only parent and a batch's cascade cannot reach
one. Both numbers it quotes come off `BatchOut`, which the panel has already loaded - a count
of *jobs* would need a second request. After the deletion the panel closes, dropping `?batch=`
from the address: its whole subject has stopped existing, and the table beside it is still
the Overview.

#### Pre-labeling: the surface `text_detect` was declared for

**The control is in the batch's panel, gated on `pre_label` in the batch's own `allowed_actions`** -
never on the batch's state read locally, the same rule every control on these screens follows.
A batch's frames are partitioned into jobs and a run reaches each open job's assets, so the
launch is one run per open job, and the dialog opened from the panel is over the batch
([below](#auto-labeling-from-the-overview)). The dialog first built for this - over
one job, titled for both, *Pre-label BATCH · job N*, gated on `pre_label` in that job's own
`allowed_actions` - is still in `ui-core` as `PreLabelDialog`, and it holds the pieces the batch
dialog reuses (the settings, the prompt listing, the replace tick), so everything below about
those is true of both; no screen of the standalone app mounts the per-job launch. It is the reason the capability stopped being an orphan: a connection could
declare `text_detect` from the day the Models page (then named Inference) described the ability,
and nothing in the app ever asked one until this control existed to.

The model select is narrowed to connections whose `capabilities` include `text_detect`, read
off the wire rather than guessed from a name or a model id, on `inferenceQueries.ts`'s standing
rule. The confidence field defaults to `0.35` and is labelled **prompt affinity**, deliberately
never "confidence" or "accuracy": a text-prompt model scores how well a region matches the words
it was asked for, a point-prompt model's suggest tool scores mask quality against a click, and
the two run on different scales - 37-78% observed for the first, 68-98% for the second - so a
bare percentage next to a shape would not say which one it was on. The per-job dialog states how many
of **the job's** assets are untouched, read from `GET /jobs/{id}/progress` and never from the
batch's counts, because that is what the run will actually consider and a batch-wide number here
would offer to label frames somebody else is holding - an
asset already pre-labeled, annotated, skipped, awaiting review or accepted is passed over, and a
label that lands enters at `pre_labeled`, never `annotated`, so an annotator corrects a machine's
guess rather than inheriting it silently as their own work.

**The prompt is named, and so is everything left out of it.** A count of assets says nothing about
which classes a run will look for, so a schema whose `vehicle` requires an attribute completes a
run, labels no vehicles, and reads exactly like a run that should have labeled something. The
dialog reads `GET /batches/{id}/pre-label?connection_id=` for the chosen model - and again when
the model changes, because a schema of polygon classes is a prompt for a segmenter and a refusal
for a detector - and shows three things: the classes it asks for; beside them each class it does
not, with the reason - no shape this model produces, or an attribute a prediction cannot supply;
and what the run writes (*Writes boxes.*). The lists come off the wire rather than being derived
from the pinned schema in the browser, because the same narrowing decides what the run really
prompts with. They
are shown again under a settled run's summary, which is where a run that labeled nothing is
actually read. A schema with no askable class at all refuses this read, and the dialog renders
that refusal and leaves `Start` dead rather than waiting for the press to produce it.

**Replacing an earlier pass is a tick, off by default.** The live configuration - the model,
the minimum prompt affinity, the prompt classes, and the count of what a run would consider -
sits below whichever summary the mode wrote, in every mode with something left to reach:
during a run too, with its fields and the tick disabled, and under a `done`, `stopped` or
`failed` summary whenever the job has an untouched asset left, whether or not anything in it
is pre-labeled. Where the job holds
pre-labeled frames, under it sits **Replace the model labels on N pre-labeled frame(s)**,
unticked, saying that frames anyone has edited, confirmed or skipped in this job are never
touched and that this cannot be undone. Ticked, the count line adds that the run also replaces
the model labels on those N frames, and the launch -
`Start`, `Run again`, `Continue` or `Try again` - goes live. A job with nothing untouched left
and the box unticked has no run to launch at all, so the press is disabled and the notice names
the tick as what would give the run something to do. A settled run's summary reports how many
earlier model regions it replaced.

`POST /jobs/{id}/pre-label` answers `202` with a background job, on the export and
weight-download routes' contract, and the dialog polls it exactly as `ExportDialog` polls an
export: nothing here waits for the run to finish, but nothing closes over an outcome unseen
either. A dialog reopened after a reload, in a second tab, or over a run launched from a
terminal reads `JobOut.pre_label_run` - the job's own memory of its most recent run - rather
than an id a component happened to keep. Every refusal the route can produce reaches the dialog
as prose - a job whose batch stopped being `in_annotation` under the press, a job somebody
completed under it, a connection whose model answers places rather than words, a pinned schema
with no class a detection can be written as, and a local runtime that is not installed, whose
message carries the exact `pip install` to run.

#### Auto-labeling from the Overview

The product's word for a pre-label run is **auto-label**: the person reads *Auto-label*, the wire
and the CLI keep `pre_label`, and what a run writes is still *pre-labeled*. It is offered over the
Batches table whenever some batch of the project declares `pre_label` in its own
`allowed_actions` - read off the listing, never derived from state here - and is absent otherwise.

**While images are waiting, it is a line between the band and the table**: a boxed robot, *233
assets have no labels yet. A model can draft them for you to check.*, then **Auto-label them** and
a ✕ (*Not now*). The count is the `progress.unannotated` of every batch that declares the run,
leaving out a batch a model is drafting now (its `pre_label_run` queued or running), so starting a
run is what makes the line go. **Not now** puts it away into the band as a quiet icon button
(*Auto-label*, its tooltip *Auto-label 233 assets*) and is remembered per project in this
browser, against the count it was said to: the line comes back only when more images are waiting
than that - new images arrived. With batches that declare the run and nothing waiting, there is no
line and the band's icon still offers it, since a re-run over pre-labeled work is legal where
declared. Both open the project's dialog over every batch that declares the run; a batch's row
menu and panel open it over that batch alone, titled *Auto-label* and the batch's name.

The line arrives during a session - a batch approved, images ingested - by opening its row and
rising into place, and leaves by closing it, the table following; a page that loads with work
waiting simply shows it. Put away, its button travels into the band and becomes the icon
([`DESIGN.md`](../../DESIGN.md#a-line-that-offers-work)).

The dialog takes the same model and prompt-affinity controls as the per-job dialog
(one component, one copy of the prose), then a checklist of the batches that declare the action,
each with its untouched count and checked by default when that count is above zero. Its start
button says what it will reach - *Auto-label · 233 images*, the untouched images of the checked
batches - and posts `POST /projects/{id}/batches/pre-label` with exactly the checked ids, so what
runs is what was seen. **The pick is per batch and the launch is per job**: the answer holds one row for every
open job of every checked batch, and the dialog lists each as queued or as having joined a run
already in flight, under its batch's name and linking into that batch's panel, so a batch cut into
three jobs contributes three rows - each read as `BATCH · job N`, since a batch that fanned out
would otherwise repeat one name over rows nothing tells apart. The batch's row in the Overview table shows a **Drafting n/m** meter while the
batch's `pre_label_run` - the newest run across its jobs - is live, and each job's own dialog
reads that job's run afterwards. A refusal - a pin with no class the model's shapes can be
written as, naming the batch to leave out - renders as prose in the dialog, and no job is
launched.

#### Reviewing a pre-labeled batch

A model's labels are reviewed in the annotator, a frame at a time. The batch's panel carries the
run's progress (the row's **Drafting n/m** meter and the panel's *A model is drafting labels* line,
while it is live) and the labeled share afterwards, and nothing more of them: confirming or discarding a model's labels is not available in bulk
anywhere in the browser.
In the editor a frame holding only a model's labels is `pre_labeled`, and an unedited one offers
**Confirm labels** (`pre_labeled → annotated`, the `confirm` action) from its own
`allowed_actions`. Removing a model's labels is the editor's ordinary delete, and a replacing
re-run from the Pre-label dialog is the way to redo the machine's pass over frames still
`pre_labeled`. Per-class thresholds and a threshold filter are deliberately not here yet.

### The Add images dialog, and the order the domain forces

Add images is **a dialog over the project, not a page**: centred, three steps on a track -
**1. Upload**, **2. Frames & settings**, **3. Batch** - opened from the project bar's *Add
images* (a button on Overview and Images, the overflow's first entry elsewhere) and from an empty
section's invitation. `ProjectScreen` owns it (`AddImagesDialog`, `screens/addImages/`), so every
door opens the same one, and the host holds whether it is open in the URL as `?add=images` on the
section it was opened over. `/projects/:id/ingest`, the page it used to be, redirects to
`/projects/:id/overview?add=images` with `replace`.

**The flow outlives the dialog.** Its state lives in the component above the `Dialog`, which
`ProjectScreen` keeps mounted while it is closed, so closing hides the flow rather than discarding
it: a run keeps polling and still refreshes the batch table when it lands, a clip keeps decoding,
and *Add images* reopens on it. Once the flow has settled - a batch made, an import cancelled or
failed - closing starts the next one over. Leaving the project unmounts it, which is a clip
import's cancel by the same path the Cancel button takes.

**The track.** Three segments fill as the flow moves - a `scaleX` transform, 300ms on the strong
ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`) - and a reached segment before the one shown can be
pressed to walk back to it, until a run exists: a run is a row on the server and cannot be
un-launched, so from step 3 there is no walking back. Each step's page enters from the side the
walk is heading (24px and opacity, 220ms); under reduced motion nothing moves. The footer carries
a way back, a secondary, and the step's one filled action. Which step the flow has *reached* is
derived from the data - a run or an import is step 3, a registered source or a read clip somebody
chose to cut is step 2 - never stored beside it.

The dialog runs **three mechanisms, picked by what the files turn out to be rather than by a mode
switch**: images, `.pcd`/`.ply` scans, and a clip. Scans are routed by extension first and a drop
mixing them with anything else is refused in words; a single file the browser calls video is a
clip, *where the host has a media runtime*; everything else is images, including a directory that
happens to hold a clip. With no media runtime (`useMediaRuntime()` is `null`) the dialog never
mentions video, and there is no server-side decoder to offer instead. The two directory kinds
share their run (`useIngestRun`); the clip shares no lifecycle with them, because the things
behind them do not - a directory is one `IngestJob`, a clip is a `VideoImportService` session
with an arbitrary stretch of time in the middle (`useClipImport`). See
[ingest.md](ingest.md#a-video-import-is-a-session-not-a-run).

#### Step 1, Upload: the selection read back, then sent

A dropzone takes files or a folder (*Choose files*, *Choose a folder*, or a drop anywhere on the
step, which replaces the selection). What was chosen is read back before anything is sent, as
**one card per selection**: its line heads it with the count and the size and the ✕ that clears
it, over the pictures themselves (the first seventeen, then a count), the scans by name, or - for
a clip - the decoder's own reading of it: name, duration · size on screen · bytes, the container,
codec and source rate, and whether *this browser* can decode it. Images and scans are named here
(*Source name*, suggesting the first file's stem, because without one the server names the source
- and the batch after it - by the upload's content digest), and scans state their **coordinate
frame** here too, with no default: it rides on the registration itself, and the server cannot read
it from the bytes. The primary is *Upload N images* / *Upload N scans*, which registers the source
- one multipart request, so there is a pending state and no percentage - or, for a clip, *Choose
frames*, offered once the decoder has read it. Nothing about a clip is uploaded at all.

A refused registration renders in the shared prose under the selection; walking back to step 1
after a registration reads the choice back with the way on forward, and its ✕ is a full restart
(the registered source stays on the server; registration is idempotent).

#### A clip is inspected before anything is registered

Nothing about a clip reaches the server until a person has already seen what it is:
`@visionset/media` opens the file in this browser and answers container, codec, display size,
duration and source rate, and only then is a rate chosen, a session opened and the first frame
sent. The facts come off the container, never off the extension, and each can be missing without
the card falling apart: an unparsed container reads `unreadable`, and the rate reads `variable`
where the inspection's `sourceFps` is null. That field is **optional on purpose** - it is the rate
the clip was *shot* at, and a variable-frame-rate clip has no single one. It rides to the server as
`VideoMetadata.fps`, still null, and the rate the import is being *cut* at is never written there
to fill the gap: that one is `extraction_fps`.

A clip the browser's decoder will not take never reaches step 2. It gets one of `VideoRefusal`'s
closed set of reasons, each written as its own title and remedy: no video track, a container that
would not parse, a codec this browser's `VideoDecoder` does not handle (another browser may;
re-encoding to H.264 will), or a browser with no WebCodecs, `OffscreenCanvas` or module worker to
offer - which is also what a page served outside a secure context looks like. No session is opened
in any of those cases, so a refusal costs the project nothing.

**Every import is a new source, and none of them collide.** A `VIDEO` source's locator is the
opaque `video-import:<uuid4>` the session mints, so importing the same clip twice produces two
sources and re-does the work. Only content addressing saves the storage: identical frames collapse
to one asset, which is why the outcome says the batch can hold fewer frames than the estimate.

#### Step 2, Frames & settings, and Into

A clip is cut here: a compact preview player and the hand-rolled multi-range **timeline editor**
under it, its empty track inviting the drag from inside itself. Selection is whole seconds: a drag
paints second cells, a range starts on an exact second and ends just before its last one closes
(the clip's partial final second is the one shorter cell), and only the marker seconds are
labelled under the track. The handles drag and nudge by one second (shift for ten), Delete removes
a range, and a click scrubs the player - inside a selected range it previews, playing from that
moment and stopping where the range ends. Beside it, **Frames per second** is a typed number (any
positive one; a blank or a zero withholds the import, with the reason under the field), and
**Size** is a select of percentages per side, 10% to 100% in fives, each option saying the
resolution it stores. The estimate under them is exact - the mirrored `ceil` arithmetic over the
merged selection, ported from the kernel - so the number on *Import N frames* is the number the
server will expect.

**Into** is the same for all three kinds: a select of **New batch** (then its name, defaulting to
the source's or the clip's) or one of the project's **draft** batches. Which drafts may take more is
read off the wire, never off `state`: a draft not declaring `edit_membership` is listed and
withheld with its reason, and a batch that declares it is offered whatever its state reads. A bad
target is 404 or 409 *before a job row exists*, so that refusal renders on this step, beside the
choice that caused it. For images and scans the primary is *Create batch* (or *Add to batch* for a
draft); the source card above it names what was uploaded.

#### Step 3, Batch: the run, then two ways on

The directory run shows `processed of total` against a bar and its state - a directory states how
many files it holds before the first is read - and says the run keeps going if the dialog is
closed. Everything after the launch is on the job: `error` is the one fatal cause, and `failures`
the per-file report, **grouped by kind** (`unsupported` is operator noise, `corrupt` is data loss),
names as basenames with the full string in `title` because for a directory ingest
`IngestFailure.name` is the full server path. A `failed` run offers **Resume**, which is a redo,
not a skip, and a refused resume is titled apart from the run's own error.

A clip shows `materialized of expected` frames: `expected_frame_count` was computed server-side at
`start`, so there is a denominator before the first frame exists, and the count is the main
thread's own tally of what the sink took (see [`media`](architecture/frontend/media.md)). **Cancel
import** is the footer's while the import is in flight: it stops decoding and throws the staged
frames away, and no assets and no batch exist yet, so there is nothing to undo. It goes disabled,
with the reason beside it, once the commit is in flight - one transaction that cannot be taken
back. A refused commit renders as prose apart from a decode failure, because the two have
different remedies. There is no Resume for a clip: a stalled session is aborted and restarted.

A settled flow names the batch it filled - **“name” is ready, as a draft**, with the batch's own
count, because `processed` is not the size of the batch once content addressing collapses
identical items - and offers two ways on:

- **Approve batch** swaps the step's content for the approval, in place: the same form the
  batch's own approve dialog draws (`ApproveFields`, `useApproveForm` in `BatchLifecycle.tsx`) -
  *Start annotating now*, the folded Jobs with *One job* / *Split* and its stepper - with its
  buttons in the footer, because a dialog over a dialog is the one thing a modal flow must not
  open. Approved, the step says what landed (*Approved against v3, cut into 2 jobs, and open for
  annotation.*) and offers **Open the batch** - its panel on the Overview, through `onOpenBatch`,
  which also closes the dialog because the destination's address does not hold it. Approval is
  offered on the batch's `approve` declaration and an active schema; without a schema the step says
  what approving needs and where to define it, and offers the batch instead.
- **Add another source** starts the walk over. The batches this session made are kept and listed.

For images and scans the footer's way back is **Into another batch** - the same source, back to
step 2: re-ingesting a registered source is free. **It is offered, never taken**: no redirect on
completion, because the same step carries the per-file report, and a `failed` run gets the
outcome too - a partial run has a batch. `batch_id` is not on the job row until it completes, so a
run in flight has nothing to open, and one that never reached a batch says so in words rather than
offering a button that cannot work.

Nothing is filtered in the browser and there is no `react-dropzone`. Every filter the library
would apply - MIME type, size, per-file rejection - is a rule the server already owns and refuses
better, with the kernel's own reason; duplicating it here would be a second spelling of the
accepted-format list. There is no `partial` failure kind any more: it went with the server-side
decoder (#452), and a half-decoded clip is now a session holding frames and zero assets.

### The schema editor, and the three 409s

The editor is where `docs/content/api.md`'s "branch on the code, never on the status" earns
its keep, because all three refusals it can meet are **409**, and each has its own
remedy - branching on the status would tell none of them apart:

| code | what it means | what the editor offers |
| --- | --- | --- |
| `DESTRUCTIVE_SCHEMA_CHANGE` | the new version narrows the contract | **Save anyway**, which retries with `?allow_destructive=true` |
| `SCHEMA_CHANGE_WOULD_ORPHAN` | annotations already exist under an affected class | **Close**, and nothing else |
| `STALE_WRITE` | the draft moved since it was last read - a second writer's save, or a publish, landed first | **Reload the draft**, which discards the local copy and re-seeds from the server |

A client branching on the status would offer the override for both of the first two and
loop forever on the second - the failure `SchemaChangeWouldOrphan`'s kernel docstring
warns about, and the reason it is deliberately *not* a subclass of
`DestructiveSchemaChange`. The third has a remedy of its own, and it is neither of the
other two's: "Save anyway" would silently overwrite whatever the other writer put there,
which is the lost update `STALE_WRITE` exists to prevent, and "Close" would leave the
editor showing a draft the server no longer recognises. Reloading is the only remedy that
does not either lose work or leave the screen lying.

`SchemaService.preview` is routed at `POST .../schema/preview` - it answers both gates the
publish itself would, `is_destructive` and `is_refused`, without writing anything - and
**the editor calls it**: once before a class leaves the draft, once before a publish, and
once the draft has held still for 400ms, so the commit bar can list what saving would publish.
The first two are therefore answered before any publish is sent. A class that already
carries labels never reaches a publish request at all: it gets one terminal dialog naming
the annotations and assets that block it, counted, and no button that starts a save the
dialog knows will be refused. A class that carries none gets one confirmation, which names
how many classes narrow and states that nothing already labeled is invalidated.
It also names what the narrowing defers: a batch still open on the outgoing version keeps
writing the class that was dropped, and those labels block a release rather than this save.

**The Classes section is a table, and a class is edited in a panel beside it.** The section runs edge to
edge under the project bar, as the Overview and Images do (below `lg`, inside the strip's
column, it is framed instead), and from `lg` it is fitted to the window: the table scrolls
inside it under a sticky header, its column hairlines carried on below the last row. It is
composed top to bottom as:

1. **A band**, 48px: the tag icon, **Classes** and how many (*12*, or *3 of 12* while a lens or
   filter narrows it), and at the right how the table is looked at - a lens, **All** / **Changed
   in draft** / **Not used**; a **Filter** by name, which `/` focuses from anywhere on the page and
   Escape clears; the **History** icon button (named *History, version N active*, its tooltip
   *History · vN*), which opens the history panel (below); and beside it **New**, the section's
   forward action and, until the draft holds a change, its one filled control.
2. **Notices**, only when there is something to say, each a line across the section: a version
   published underneath a dirty draft, a stale draft, an autosave or publish refusal - always in
   prose, never as a code.
3. **The table** (`ListGrid`), one row per class in hotkey order, 44px rows, each column headed by
   an icon and a word: **Class** - its colour, its name (*New class* while it has none) and how
   many attributes, inline and muted; **Shapes** - a glyph for each shape it may be drawn with,
   drawn the way the annotator draws it (a box with its corner handles, a polygon or line with its
   vertices - hollow, as on the canvas - and a tag as a pill), in the class's colour;
   **Attributes** - by name, with *\** on the required ones, truncated, the whole list with each
   one's kind in a tooltip, or a dash;
   **Annotations** - the count, right-aligned, beside a thin bar in the class's colour measured
   against the project's most-used class, or *Not used yet*; **Images** - how many carry it;
   **Key** - its hotkey, 1 to 9 for the first nine classes, none after; and a **⋯** menu. Hover
   fills a row at once.
4. **The commit bar**, floating over the table's foot once the draft holds something (below) -
   it takes no row of the layout.

Pressing a row's name opens its class in the **class panel**, at the right edge of the page;
**New** opens the same sheet on a class that does not exist yet. ↑ and ↓ (or J and K) move
between the rows, and Enter opens the focused one. A row's **⋯** menu offers **Edit class**,
**Undo its changes** for a class the draft has edited, and **Remove class** - asked of the server
first, like every removal, so a class frames already carry is refused in the dialog that says
which frames; the item is never greyed out ahead of the answer. The panel's
header names the class - *Edit* and its name as the panel opened, beside its colour, or **Add
class** - over one status line: how much is drawn with the class, the version that introduced it and
whether the draft has touched it (*427 annotations · since v1 · edited in draft*), or, when adding,
that it joins the draft and ships with the next version. The same line says what stops the class
saving - a name that is empty or belongs to another class, ignoring case, as the API requires, or an
attribute without a name - so an error never moves the rows below it.

The body is an **inspector**: one row per property, its label in a left column and its value in the
right, so the labels share one edge and the values another. **Name**. **Colour**, shown as its
swatch and hex (with *from the name* while none is declared); pressing it opens the twelve colours of
the class palette and, under them, a custom picker - saturation and brightness on a field, hue on a
strip (both also move with the arrow keys), and the hex it comes to, typed or pasted and only taken
once it is a whole six-digit colour - and **Use the name's colour** goes back to the derived one.
**Shortcut**, the class's place in the list, picked as a number, each naming the class whose place it
takes; the first nine places are the annotator's hotkeys 1 to 9, and the row says which key picks
the class or whose place it would take. A class's position is part of the published version, so
moving it is an unsaved change like any other. **Drawn as**, a segmented row of the seven shapes as
the annotator draws them - box, rotated box, polygon, polyline and tag for images, 3D box and 3D polyline for
point-cloud scans - their names said under it; a class may accept several, image and scan shapes
together (each label is checked against its own asset when it is written), and the last one
that is on cannot be switched off, and says why. When editing, **In use** says what an edit costs. A
class that is not used yet changes freely (*Not used yet, so any change here is free.*). A class in
use, counted as its labels on its frames, cannot be removed, and cannot lose a shape its labels are
drawn as, until those labels are cleared.

**Attributes** follow, with their count, each a group: a row with its name and what it asks
(*Choice of 3 · required*), marked *new* when the active version does not have it, which opens -
one at a time - onto its own rows on the same grid, indented under its name: **Name**; **Kind** -
**Text**, **Number**, **Yes / no** or **Choice**; for a choice, **Choices** as chips typed into the
same row, where Enter or a comma adds what is typed, Backspace in the empty field takes the last one
back, each chip has its own remove, pressing a chip makes it the default (pressing the default clears
it), and a choice the active version does not have is marked *new*; for any other kind, **Default**,
in the control its kind asks for; **Required**; and **Remove attribute**. Changing the kind clears
the default, and removing the option that was the default clears it. **Add attribute** sits in the
section's heading, above the groups, so it stays where it was pressed; the new group arrives last,
open, with its name in focus, and scrolls itself into view. The API refuses an attribute without a
name, so none reaches the draft: Save quietly drops one nobody touched, and refuses one that was
filled in but not named, saying so on the status line (*Name every attribute, or remove the one
without a name.*) and putting focus in its name.

The panel edits a copy. Nothing reaches the draft until **Save** - or, when adding, **Add … to
draft** - or ⌘↵ (Ctrl+Enter), and then the class, its fields and its place arrive as one change.
**Cancel**, Escape and the close button leave the draft as it was. While the panel holds changes,
pressing another row, **New** or **History** does not replace it — a toast says *Finish this
class first* and the name field takes the focus back — so a stray click cannot throw them away. When editing, **Remove**
sits at the left of the footer and is checked with the server before the class leaves the draft; a
refusal opens over the panel, and closing it comes back to the class. Closing the panel returns
focus to the class's row, where it now sits. The body is the same `ClassFields` component the
annotator's add-a-class dialog uses, in its stacked layout.

While the draft holds unsaved changes, a row carries a mark - a dot in the inset beside its
swatch, its slot reserved so nothing shifts, whose tooltip says what changed in the kernel's own
words: green for a name the active version does not declare (also said as *New* beside the name),
blue for a class the preview's diff mentions, amber for a class the preview says frames still
carry. A class the draft removed stays in the table where it stood, struck through, marked red,
with **Restore**, which puts it back as the version in force declares it - a removal is a change
saving would publish, and it is seen as one. The filter never changes which class an edit
addresses; when nothing matches, the table says so in its place. A schema with no classes shows
an empty state under the band, *No classes yet. A class is a name for what you draw, and the
shapes it may be drawn with.*, with its own **New class**; otherwise **New** sits in the section's
band beside the History button, and the project bar draws no Classes action. Which class the panel is open on is component state, not the URL: it is
a lens on the section the person is already in, the same test the version being read passes. The
status bar says what the section holds: *12 classes · 14,971 annotations*.

**A class that has no name yet takes neither path.** The draft may hold one - naming a
class is typed work, and the draft exists so typed work survives - but the published
contract refuses a blank name, so the preview refuses it too. The editor therefore keeps
an unnamed class out of every preview body: removing one is a local edit with no request,
and removing a *named* class while one waits for a name previews the named classes only.
The panel keeps new ones from arriving: **New** writes nothing until it is submitted, and
it refuses a blank name in place (*Name this class.*). An unnamed class can still come from a
draft saved before that; Save refuses the blank with its own message and opens that class's
sheet - an answer rather than a greyed button.

That does not demote the 409. Nothing is locked between a preview and the publish, so
somebody can label a class in the gap and turn a preview that looked safe into a refusal -
which is why the publish's own refusal stays authoritative, and why it renders through the
same blocker view the preview feeds rather than through a second presentation that could
drift from it. The preview removes a doomed round trip; it does not decide.

`compare` **is** routed since #231, and it answers the neighbouring question - what
two *published* versions did to each other. The History panel uses it for every version against
the one before, and the table for the marks on a version being read, and the section
never computes a diff here, any more than it does for the draft's own list: `domain/schema_diff.py` is the one spelling of that rule, and a
TypeScript copy would drift until the screen called a change safe that the API then
refused.

**The draft autosaves, on the server, on a debounce.** There is no "save draft" button to
remember to press: every edit reschedules a 400ms timer, and when it fires the whole draft
- classes, note and the version it was based on - is written through `PUT
.../schema/drafts/curated`, naming the revision it was last read at. The response's
`revision` is folded back into the locally-held draft so the next keystroke's write names
it in turn; nothing about that write ever invalidates the query that seeds the editor,
because doing so would refetch on every keystroke and hand the derivation a fresh object to
re-seed from mid-sentence - overwriting what is being typed, with no unmount to blame it on.
Switching to another project while a write is still pending does not lose it either: the
timer lives above the tabs, on `ProjectScreen`, and a route change flushes the pending write
to the project it belongs to rather than simply cancelling it.

**Save flushes the pending autosave first.** Publishing goes through the draft - sending
only `{revision, allow_destructive}`, never the classes themselves, so there is
structurally no way to publish something other than what is on screen - which means the
revision it names has to be current. Awaiting the flush before publishing is what stops a
fast typist from publishing the version that predates their last keystroke.

### The commit bar and the History panel

**Versioning appears when there is something to version.** While the draft matches the version
in force, nothing at the foot of the section says so. The first edit raises the **commit bar**:
an island floating over the table's foot, centred - a pill with a hairline edge and a soft,
layered shadow that lifts it off the table in either theme. It rises from its own foot with a
short fade, scale and lift (200ms on a strong ease-out, not at all under reduced motion) and
takes no row of the layout: the table keeps its full height, nothing above it moves, and the
table keeps room below its last row so every row scrolls clear of the island. While it is down
it is inert, and a status line that is always present (*Version N active · unsaved changes
create vN+1*) says to a screen reader what the island says to the eye. Below `lg`, where the page
scrolls, it sticks above the status bar and the room for the last row is held at the page's end;
on a phone its words fold to the count, the warning's number and *Save*, still spoken whole. It
holds:

- **N changes in draft** - counted from what `POST .../schema/preview` says, in the kernel's own
  wording and never computed in the client, asked once the draft has held still for 400ms
  (`ClassFields` emits an edit per character typed, and every intermediate name is a walk over
  every annotation in the project that nobody asked for). A draft whose only changes the kernel's
  diff does not list - a colour, a class's place - reads *Unsaved changes*; a project's first
  version counts the classes it would declare.
- **Review**, a popover above the island listing those changes, each line opening the class it is
  about, and a removed class's line offering **Restore**.
- A *N frames in the way* badge when the preview is refused (see *Frames in the way* below).
- **Discard**, which makes the draft the version in force again. Nothing is asked first: the
  toast that says so offers **Undo**.
- **Save version N+1**, the page's filled control while the bar is up - the project bar's
  **New** steps back to `outline` meanwhile.

The bar has no field for a version's message: a version is published without one, except a
restored version, whose draft carries *Restore version N* and publishes it as its description.

The band's **History** icon button opens the **History panel** at the page's right edge: every
version, newest first, one line each - its message (*No message* when it has none), and at the
line's end when it was published, or *Active* on the one in force - on a graph of lanes. The main
lane is the curated contract; versions published while annotating, grouped by `provenance` (see
[the annotator](ui/annotator.md#the-pinned-version-and-adding-a-class)), branch off it on a lane
of their own and rejoin it. Pointing at or focusing a line puts **Restore** where its time was -
not offered for the active one, which the draft already starts from. Pressing a line opens that
version and puts the panel away; pressing the version already open goes back to the draft. The
sheet says nothing about what changed: that is read in the table, where there is room for it.

**Viewing a published version** shows its classes in the same table, read-only, under a head of
one fixed height. On its left, the version's message as its title and one line under it: where it
came from (*Published from Classes*, *From the annotator*, or its annotating session), when, the
version it is compared with, and what it changed - *2 new · 1 removed · 1 narrows*. On its right,
**Back to draft**; the version navigator - steps to the older and newer version (`[` and `]` from
anywhere on the page), a window of at most nine dots in their lanes' colours that tapers at an
edge with more beyond it, and *vN of M*, which opens every version as a list searchable by number
or message; and **Restore vN**, or *Active version* in the same room. Nothing in the head changes
size from one version to the next, so the steps stay under the pointer and the table never moves.

The table is marked against the version before (`GET .../schema/compare`): a touched row carries
a bar at its edge in its status colour and *New*, *Changed* or *Removed* after its name, with the
kernel's sentences about it on hover. A class the version dropped keeps the row it held, struck
through. In a changed row the cell that changed is lifted, and in it only what moved is a chip -
**+** added, **−** removed and struck, *optional → required* - while what stayed reads plain. A
class the comparison calls destructive carries *Narrows*; whether a change narrows is the
kernel's alone, and a class it speaks about is marked changed even when no cell shows what. A
hotkey that moved shows its old digit struck beside the new one. Pressing a row opens the class
in full, in a panel laid out like the class panel - the same inspector rows - with nothing to
change: its colour, key and shapes, and its attributes with their kind, whether each is required,
and their choices or default, closed by **Close**. The section has no edit affordance at all - no
commit bar, no New, no row menu, no restore of a class and no field - and those controls
are absent rather than disabled, because a published version is immutable and a disabled control
says "not now" when there is no now. A version that declares no classes says so in place of the
table.

**Restore does not rewrite history.** It makes the draft that version's classes, with the note
*Restore version N*; nothing is published until Save, which publishes them as the next version.
Restoring over unsaved work replaces it, so the toast that announces the restore offers **Undo**.

**Which version is being read is component state, not the URL.** The section is a
destination; a version somebody is glancing at is a lens on the section they are already in.
The navigation rules ([`docs/content/ui/navigation.md`](ui/navigation.md)) state the test.

The page writes no description of its own: the commit bar has no field for one, so a version
is published without a message unless it is a restore, whose draft carries *Restore version N*.
There is nowhere to edit a description afterwards - no route, because no service method,
because a version is immutable.
It now travels as the draft's `note` - a required string the autosave always sends, blank
or not, rather than a field the client omits when there is nothing typed. The point it
protected is not lost, only moved: a blank note still becomes a `null` description, because
`SchemaDraftService.publish` sends `draft.note or None` to `create_version` - the empty
string never reaches the version as itself.

### Frames in the way

A refused publish states how many frames block it, and those frames are still there
afterwards. They have no section of their own: they live in one dialog, reached three ways -
the *N frames in the way* badge in the commit bar, a Save the preview refuses (*This
draft can't be saved yet*), and a class removal the preview refuses (*"<class>" can't be removed
yet*, closed with **Keep <class>**). It reads the listing behind the preview's own counts
(`POST .../schema/blocking-assets`, [api.md](api.md#reaching-what-is-in-the-way)) - the same walk
over the project, from the same proposal - so the number the dialog quotes and the rows in it
cannot come to disagree. The refusal is still terminal: there is no override, only **Close** or
**Keep <class>**.

**It asks about the draft the editor is showing**, not a copy of it: the class list comes from
the editor's own derivation, because a second spelling of which classes are on screen is a
panel answering about a proposal nobody is looking at. The read is deferred until that list
has held still for the same 400ms the autosave settles on.

The dialog lists the narrowing changes and the per-class counts and, for a host that can open a
batch, the first twelve blocking frames and the total, because each row fetches a thumbnail on
mount and a narrowing that orphans five thousand frames would otherwise open five thousand
requests at once. The remainder is stated as text rather than offered as a "see all", since
there is no view narrowed to those frames to send anybody to; the Assets section lists every
image of the project, and can be narrowed to a source but not to those frames. **A row
links to every batch holding its frame, never to one** - an annotation carries an
`asset_id` and no batch, so a frame in three batches has three honest destinations and
no preferred one, and a frame in none gets no link rather than a guess. That makes the
list pointless without a batch route, so a host that wires none gets the counts and no frames.

### Adding a class from the annotation page

A class that does not exist used to cost a round trip through the Classes section **and a
new batch**, because the old one pins the old version. The `+` in the tool palette
opens a dialog carrying the same fields (`patterns/ClassFields.tsx`, shared with the
Classes section so the two cannot drift on geometries, derived colours or how an
attribute's options are typed), and the flow is two calls in one order:

1. **save** the pending annotations,
2. **publish** the next version - the *active* version's classes plus the new one,
   never the batch's pin, because versions are linear and composing on a stale pin
   would silently delete everything published since.

Re-pinning the batch used to be a third step here; publishing an additive version
now moves every open batch's pin in the same kernel transaction, so there is no
second request left to order, refuse or skip.

**Step 1 is first because the schema refetch rebuilds the annotator store.** The
store is a `useMemo` keyed on the schema, so publishing before saving discards the
user's last few boxes with a success toast on screen - no error, nothing to see.
`addClass.test.ts` asserts the sequence and fails if any pair flips.

On success the new class becomes the active one. That state lives on the page rather
than in the store, so it survives the rebuild, and its digit hotkey arrives free
because the palette order *is* the hotkey order (#46).

**`Create and add another` accumulates on the server, not only in this component.**
The classes a sitting has written are the project's `annotation` schema draft - a
row of its own, held apart from the Classes section's `curated` draft so a half-finished
editor composition can never leak into what this dialog publishes. Every bank
writes through, so a closed tab loses nothing, and Cancel's confirm discards the
shared row along with the local form. Because the draft has no author, opening the
dialog onto one that already holds classes does not fold them into a fresh sitting
silently: it says what is pending and offers a discard, since those classes may be
somebody else's and confirming without asking would publish classes this person
never typed.

Confirming publishes *through the draft*: one more write, composed on the
project's active classes plus this sitting's - folding in whatever is typed but
not yet banked - and then a publish naming only the revision that write
returned. The server publishes exactly what the draft holds and nothing a
client could send instead, which is what makes it structurally impossible to
publish a version other than the one on screen. The read itself is gated on the
dialog being open, the same discipline `activeSchema` above already keeps: an
annotator page that asked for it on every mount would be a request nothing on
that page needed yet.

Three other decisions the editor inherits rather than invents:

- **A version is immutable**, so the editor drafts and *publishes N+1*. Past
  versions are read-only because they are read-only - there are no controls, not
  disabled ones.
- **`?confirm=true` and `?allow_destructive=true` are different words** and are
  never merged. `confirm=` guards destroying data (deleting a project);
  `allow_destructive=` guards narrowing a contract. Each has its own dialog.
- **A 404 from `GET /schema` is an answer**, not a failure: a project starts
  schema-less on purpose, so that code becomes an empty draft rather than an error
  surface.

The geometry picker offers what `GET /geometries` publishes - the kernel's
`IMPLEMENTED_GEOMETRIES`, the geometries an `Annotation` can carry. `GeometryType` declares
more; the kernel refuses the rest at write time with `UnsupportedGeometry`, and offering a
choice the API will refuse is worse than not offering it. The client keeps no list of its
own, only the order the shapes are shown in (`GEOMETRY_ORDER` in `data/geometryCategory.ts`).
While the set loads, or if the read fails, the picker shows the class's own shapes disabled,
and a failure is said with a retry (#1128).

`polyline` was offered here for a release before anything drew one (#223), and #342 closed
that gap: a lane class now gets a real tool on the annotator's strip. The picker did not
change, which is the point - the schema editor offers what an `Annotation` can carry, and
whether a tool exists for it is the annotator's business to state, not this screen's.

The shapes are offered as a set of **toggle buttons, one per shape**, each showing the shape as the
annotator draws it and its name, and the toggles are **grouped by category** rather than listed flat
(#375): `bbox`, `obb`, `polygon` and `classification_tag` under *Basic Computer Vision*, `polyline` under
*Robotics and AD*. Each category is a labelled group, and a category with nothing offered under it
renders no heading at all. The same grouping and toggles appear in the annotator's add-a-class
dialog without a second call site, because both render `patterns/ClassFields.tsx`. A class keeps at
least one shape: the last one standing cannot be turned off, and says why.

A class **description** is not editable, because `LabelClassBody` does not carry
one. Left out rather than stored where it would not survive a round trip.

## No screen calls `fetch`

Nothing in `@visionset/ui-core` calls `fetch`, constructs a transport, or knows a base
URL or a credential - `tests/scripts/ui_core_boundary.test.mjs` holds that line. A
screen reaches data through `VisionSetDataClient`, the port the package declares and a
host satisfies; the OSS app's own implementation is `createOssDataClient`. Everything
about *what* can be requested - paths, parameters, bodies, response shapes - comes
from `src/generated/api.ts`, generated from the committed `openapi.json` and gated
against it on every pull request. A screen that mistypes a route fails to compile.

A screen reaches the client through a hook:

```tsx
const client = useApiClient();
const projects = useQuery({
  queryKey: ["projects"],
  queryFn: async () => unwrap(await client.GET("/projects", {}), checks.checkListProjects),
});
```

`unwrap` is the single adapter between the two models in play. The port's `DataResult`
never throws - it answers `{ok, data, error, failure, status}` and leaves the branch to
the caller - while TanStack Query's entire model is resolve-or-reject, and "rejected" is
what drives `isError`, retries and the error surface. Because every call goes through
`unwrap`, no screen in this repository writes `if (error)` by hand.

## Reading a refusal

The API emits [one error body](api.md) at every status: `{code, message, detail?}`.
`unwrap` turns it into an `ApiError` whose **first** field is the code, because
`docs/content/api.md`'s rule is that clients branch on the code and never on the status -
`DESTRUCTIVE_SCHEMA_CHANGE` and `SCHEMA_CHANGE_WOULD_ORPHAN` are both 409 and only
the first is retryable with a flag.

Two codes are the client's own, for answers the contract cannot describe:

| code | when |
| --- | --- |
| `NETWORK_ERROR` | the request never reached a server - the most likely failure on a tool whose server you start by hand |
| `MALFORMED_RESPONSE` | something answered, but not with the contract's shape: a proxy, a gateway, an HTML error page |

`ApiError.incidentId` reads `detail.incident_id`, which is where a 5xx puts the one
thing a person can quote when the message itself is deliberately withheld.

## The credential

There are no accounts, and since #179 there is usually nothing to type either.

**On this machine, the server signs the browser in.** The app asks once, with
`GET /session`; the server answers by setting an `HttpOnly` cookie when the request
came from loopback *and* addressed the server as loopback. The whole argument - the
modes, the DNS-rebinding case, why a cookie is safer here than what it replaced -
is in [auth.md](auth.md#the-browser-session). What matters on this side is that the
credential is one **no script here can read**, so "am I signed in?" is a question
the app has to ask rather than answer by looking.

That is why the app's own session state exists and the gate does not test
`token !== null`. Four states: `checking` (the one round trip, during which the
app's `TokenGate` renders **nothing** - a login form that flashes in front of
somebody who never has to see one is worse than a blank frame), `session`, `token`,
`none`. The probe runs once per mount, which is what keeps `signOut` meaningful: one
that could run again would sign a machine-local user straight back in, and a 401 on
a session would oscillate through the gate forever. This whole state machine - the
probe, the four states, the gate - is the standalone application's; the reusable
package underneath takes a client already carrying a credential and never asks how
one was obtained.

**A token is the other credential**, minted out of band with
`visionset token create --name ui`, presented as `Authorization: Bearer`, and the
only way in for a browser the server will not sign in - a LAN client, a deployment
running `never`. The form **verifies before it adopts**: it spends one
`GET /projects` with a throwaway client and only calls `signIn` on a 200. Storing
whatever was pasted and letting the first screen fail would put the error on a
project list, which then reports a problem about projects when the real problem is
the credential.

In the rail, that same asymmetry is one word: the sign-out control reads **"Use a
token"** during a session, because it cannot delete a cookie it cannot read - it
stops using it here, and a reload signs you back in.

Refusals are told apart by what to do next, not by status: a 401 says the token was
refused (mistyped, revoked, or minted for a different workspace - the API answers
one identical 401 for all four cases and a client must not pretend otherwise), and a
`NETWORK_ERROR` says the server is not answering and names `visionset server`.

### Where it is kept, and why

**`sessionStorage`.** The credential survives a reload - which matters, because the
annotation page is the one screen somebody sits on for an hour and losing the token
on an accidental refresh, with unsaved geometry on the canvas, is the worst moment
this product has - and it is per tab, so two workspaces in two tabs do not overwrite
each other.

`localStorage` was rejected: it writes a long-lived bearer credential to disk with no
expiry, and VisionSet tokens are valid until somebody runs `visionset token revoke`.
In-memory-only was rejected for the reload. A cookie would need a login endpoint the
API does not have.

Against XSS, `sessionStorage` is not meaningfully safer than a variable - an injected
script can read a React context just as easily, and does not need the token at all
when it is already running on an authenticated page. The defence is a
Content-Security-Policy, not a storage choice.

Every access is guarded: `sessionStorage` **throws** rather than returning null when
a browser refuses it, during the first render, before any error boundary exists. The
fallback is an in-memory store, so the session degrades to "until you reload" instead
of to a blank page.

## The theme, and where the choice is kept

Light and dark are one stylesheet: every token has a counterpart under `.dark` on
`<html>`, and a screen follows that class through `useTheme` and never sets it. The
standalone app sets it from a **System / Light / Dark** control on the rail, above
account ([navigation.md](ui/navigation.md#the-rail)). System follows
`prefers-color-scheme`, light when the system says nothing, and keeps following it
live; Light and Dark pin it.

**The choice is the viewer's, kept in this browser and never on the server.** It is a
view preference like a thumbnail size, so it goes through `ui-core`'s `data/prefs.ts`
into `localStorage` under `visionset.prefs.theme`, with the same probe-write guard and
in-memory fallback as every preference there. Nothing about a theme is sent to the API,
two browsers on one workspace each keep their own, and losing it costs one click.

The app's `index.html` reads the same key in an inline script and sets `.dark` before
the first paint, because the module entry is deferred and a dark page would otherwise
flash light; `startTheme` in `ui-core`'s `lib/theme.ts` takes over from it, and the
app's `src/prePaint.test.ts` holds the two to the same answers. A host that mounts the
screens brings its own control and calls `startTheme` and `setThemePreference`, or
sets the class itself.

## The 401 is handled once

`VisionSetDataProvider` observes every normalized `unauthorized` answer from the
port, including a direct asset or thumbnail request, and calls the host's
`onUnauthorized` once per active authorization/data-scope activation - in this app, that clears the
token. Cache subscriptions remain a backstop rather than the sole mechanism: the
client is a prop, so a caller may supply their own, and a handler configured at
construction is then simply absent for the whole application.

Handling it per screen fails in a specific way. A token revoked while an annotator
has a job open produces a 401 from whichever request fires next - usually a
background refetch nobody is looking at. A per-screen check would leave that screen
showing an error and every other screen showing stale data that will never refresh.

Retries follow: a 401 is not transient, and retrying one is three more requests with
a credential already known to be bad.

## Loading, empty, error

```tsx
<Async query={projects} empty={{ title: "No projects yet", action: <Button>New project</Button> }}>
  {(page) => <ProjectTable rows={page.items} />}
</Async>
```

The three branches a hurried screen skips are the ones `Async` writes. Emptiness is
**opt-in and asked for**: the default predicate is the API's own list envelope
(`total === 0`) and nothing else, because a component that guessed would be wrong for
`dataset_stats`, whose zeroes are a real answer about a real dataset.

## Polling

`usePollingQuery` for the operations that finish on their own schedule - ingest, and
anything else launched with a 202. The predicate is named for the **settled** state
rather than for "keep going", because the terminal states are enumerated in the domain
and the running ones are not; a predicate written the other way round silently keeps
polling a state somebody adds later.

## Where the API is

The reusable package never reads `import.meta.env` - a library that did could only
be built one way. The app decides `baseUrl` and hands it to `createOssDataClient`
when it builds the client the reusable package will use.

- **Production**: `""`. `visionset server` serves the API at the root and the bundle at
  `/app`, so a relative request already lands on it.
- **Development**: `"/api"`, proxied by vite to `http://127.0.0.1:8000` (override with
  `VISIONSET_API`).

The compose stack adds a third case that changes nothing here: nginx on :8080 answers
`/api/` itself and forwards it to the API, so the app's request never reaches vite's
proxy. The app is unchanged either way - it asks its own origin for `/api`, and
something in front of it knows where the API is. Which is the point of the prefix.

The proxy rather than CORS on the server, and the prefix rather than proxying the
API's own paths. CORS would put a middleware in front of every response *in
production too*, and the catch-all `Exception` handler lives in
`ServerErrorMiddleware`, outside the user middleware stack - so a CORS layer would
not run on a 500 anyway. The prefix exists because the API owns the root: `/projects`
is both a real endpoint and a client route the SPA will want.


## Selectors

Every control a test drives carries a **`data-testid`**, and that is the policy
rather than a habit. Three suites depend on it - the annotator's 76 scenarios,
`ui-core`'s component tests, and #59's browser cycle - and the alternatives each
fail in their own way: a CSS class is the design system's to change, and a visible
string is the copy's.

The rules:

- **Name the thing, not the widget.** `save`, `approve-${batch.name}`,
  `object-row-0` - never `primary-button-2`.
- **Interpolate the domain's own identifier** when a control repeats:
  `class-${name}`, `release-${tag}`, `version-${n}`. A test then reads the way the
  product does.
- **State goes on `data-*`, not on a class.** `data-active`, `data-selected`,
  `data-hidden`, `data-collapsed`. #50 moved an assertion off a literal
  `rgb(143, 211, 244)` for exactly this reason: it pinned the design system rather
  than the behaviour, and it got *stronger* in the move, because a `data-` attribute
  can be asserted on every row at once.
- **Roles where a role is the claim.** `getByRole("dialog")`,
  `toHaveAccessibleName`, `aria-current` - if the assertion is about accessibility,
  a `data-testid` would be testing the wrong thing.

## The browser cycle

`pnpm --filter @visionset/app cycle` runs the whole product against a real server:
`visionset server` serving the built bundle out of `_static/`, the real API, the real
kernel, and no mocks anywhere. Token → project → schema → ingest → approve →
annotate → finish → complete → promote → publish → verify → export → download.

It is one test, deliberately: every step needs the last one's output, and splitting
it would mean either ten sign-ins or shared state that makes the order load-bearing
and invisible. `test.step` gives the reporting a multi-test file would have bought.

**It found three gaps that every other suite was structurally blind to**, because
each is about one screen's effect on another:

1. Nothing invalidated the batch list when an ingest **completed** - only when it
   launched, before the batch exists - so a user who ingested and then walked to the
   batch list saw "No batches yet" about a batch that was right there.
2. Nothing started or completed a **job**. `BatchService.complete` refuses while a
   job is outstanding and `JobService.complete` refuses while an asset is unsettled,
   so a batch annotated entirely in the browser could never leave `in_annotation`.
3. Nothing **promoted** a completed batch into the trunk, so a release could only
   ever be published over an empty dataset.

Each is now owned by the screen the domain says owns it, and the cycle asserts all
three.

It is also the only place a route's callback wiring is exercised at all. The cycle
used to reach the batch by walking back through the project after an ingest -
`jobIdOf`'s shape, the helper #160 deleted for the same reason - so since #181 it
clicks the settled run's own **Open** instead, in the Add images dialog. Deleting the `onOpenBatch` prop in
`routes.tsx` leaves every unit test green and fails this step.
