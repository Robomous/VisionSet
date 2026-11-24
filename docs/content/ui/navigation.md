# Navigation

How a person moves through VisionSet, and how the interface says where they are. This page is
the canonical sitemap and the UX rules the implementation must satisfy; the routing
implementation is [`docs/content/ui.md`](../ui.md) and
[`docs/content/architecture/frontend/app.md`](../architecture/frontend/app.md).

VisionSet is an **application**, not a website. Somebody who walks into a sub-view has to
be able to walk back out of it *from the screen*, without reaching for the browser and
without knowing the URL scheme.

## The sitemap

Navigation maps 1:1 to domain objects. This is the target structure; where implementation
differs, implementation is what is wrong. **Any change that moves a screen, adds or removes a
section or nav entry, or changes an entry point updates this block in the same pull request.**

```
/                                  → /projects (no Home page; the list is the front door)
/projects                          Projects list (rail destination)
/models                            Models — model connections as cards (workspace-scoped)
/projects/:id                      → redirects to /projects/:id/overview
/projects/:id/<section>            Project — sections as path segments, drawn as a section
                                   toolbar across the pane at ≥lg and a tab strip below, in
                                   this order (segment → the label a person reads):
    overview                         Overview (console) — the project's batches are listed here
                                     and opened in a panel beside the table (?batch=:batchId,
                                     written with replace; closing removes it)
    images                           Images — every image ingested, regardless of batch or
                                     dataset membership; read-only. Narrowed by source
                                     chips (component state); an image opens in a viewer
                                     dialog (component state, no route of its own)
    schema                           Classes (contract)
                                       ├─ History: a panel INSIDE Classes, not a sibling; View shows a
                                       │  version read-only in the section's own table
                                       └─ frames in the way: a dialog opened from Classes; each row opens
                                          the holding batch's panel on the Overview, once per batch
    dataset                          Dataset — a section, not a buried route; a line of versions
                                       (component state, the working copy by default): the
                                       open version's facts over the docked releases, and the wall;
                                       a release's export is a section of its facts, and the
                                       project's recipes are chosen there, each written in a
                                       dialog over the page
    (any section)?add=images         Add images — a three-step dialog over the section it was
                                     opened from (written with replace; closing removes it)
/jobs/:jobId                       Annotator (outside the shell: full viewport, no rail)

Redirects kept as promises (a bookmarked URL is one):
/projects/:id?tab=X             → /projects/:id/X, every other query parameter kept;
                                  `versions` → schema, an unknown X (`batches` among them)
                                  → overview
/projects/:id/batches           → /projects/:id/overview, replacing the history entry: it was
                                  a section until the batch list moved onto the Overview
/projects/:id/batches/:batchId  → /projects/:id/overview?batch=:batchId, replacing the history
                                  entry: it was a page of the batch's own (a gallery) until the
                                  batch moved into the Overview's panel
/projects/:id/ingest            → /projects/:id/overview?add=images, replacing the history
                                  entry: Add images was a page until it became a dialog
/inference                      → /models, the page's address before it was named for
                                  the noun it catalogues
```

The section order is work order: what a project *is* and what needs doing (Overview, where its
batches are listed and opened), what came *in* (Images — every one), what it *means* (Classes),
what came *out* (Dataset). A project has four sections.

**Batches have no section and no page of their own.** A batch is listed on the Overview's
Batches table and opened from there, in a panel beside the table (a sheet below `lg`). The open
batch is the Overview's `?batch=` query parameter, so a reload or a pasted link opens the same
panel; it is written with `replace`, because walking through batches one after another is
looking, not going, and closing the panel removes it. The table is paged ten to a page from its
band, so a batch named by the URL, or stepped to from its panel, brings its own page into view. Everything that names a batch — Add images'
*Open the batch*, the annotator's way back, a correction's lineage, a pre-label dialog's link —
opens it there (`PARENT.batch`). The old addresses redirect to the Overview, replacing the
history entry: `/projects/:id/batches`, which was a section, and
`/projects/:id/batches/:batchId`, which was a page.

**A section's label is not its segment.** The segments stay the product's nouns —
`/projects/:id/schema` is what links, the CLI and the API call it — while the labels are the
words a person reads: Classes for `schema`. A bookmarked URL is a promise, so a relabel never
renames a segment; `images` is the one segment added, and it is new rather than renamed. Where
this page says *Batches* or *Schema* as a domain concept it means the batch or the schema, not a
section.

**Single route definition site**: `frontend/app/src/routes.tsx`. No routes are defined
elsewhere, every destination is declared in its `PARENT` map, and `ui-core` imports no router —
so `resolveProjectTab` can only say what a stale `?tab=` value resolves to, never change the
URL. An unknown section segment is a 404, because nothing ever linked to one; an unknown
`?tab=` value redirects to `overview`, because old links exist.

## Entry points

- **Annotate enters by job.** A project's `Annotate` control opens the chosen `in_annotation`
  batch's one job directly (`/jobs/:jobId`) when it has exactly one, and the batch's panel
  otherwise — the panel lists the jobs, each with its own *Open*, so it is where a job is
  chosen when there are several, and the job's own door is the only door. The panel's footer
  carries the `approved → in_annotation` transition, and an *Annotate* only for a batch with
  exactly one job. Opening a job only navigates: the editor itself takes a `pending` job to
  `in_progress` when it opens it.
- **Per-frame work happens in the annotator, not beside the batch.** The panel states a batch's
  facts and its jobs; it draws no frames. Looking at a job's frames, moving them through the
  states and picking among them is the editor's (its frame gallery overlay), so a batch-wide
  grid never sits beneath a per-job control with two scopes for the same frames.
- **A correction batch is reached from the batch that needs correcting**, never from a "new
  batch" form: the panel's footer offers it on a `completed` batch, capability-gated, and the
  new correction then opens in the panel. The annotator's read-only notice *links* to it
  rather than duplicating it — a second place batches are made is a second place the rules can
  drift.
- **Dataset is first-class.** It is the product's central object and is reachable in ≤1 click
  from any project section. It is never gated behind, or discoverable only through, onboarding.
- **The 4-step checklist is onboarding, not navigation.** It gates nothing and is never the
  sole path to a screen, and it retires itself twice over: when the journey is finished, and
  when somebody dismisses it. Dismissal is per project and persisted.

## What is a section, and what is a subsection

- **Recipes live in a release's export**, not a section of their own and not shelved beside the
  versions: a recipe is a named project resource with no state that exists for an export, so it
  is chosen, written, edited and deleted where it is used — the Export section's recipe select,
  with a "+" beside its label that writes a new one. Each opens in a dialog over the page, never
  on a route.
- **Editing a class happens in a panel at the right of the Classes section, not on a route or a sub-view.**
  The section is a table of classes; a row opens its class in the class panel, and closing it
  returns to the same table, focus on that row. Which class is open
  is component state and not the URL - nobody links to "the open class", the same test that keeps
  the version being read out of the address. A published version's rows open too, to read the class
  in full; they never open to edit.
- **Version history lives inside the Classes section**, not beside it, as a panel opened from
  the section's band (the **History** icon button, beside **New**): every version on a graph of lanes, each opening on a
  press, with **Restore** on its line. A version opens in the section's own table, read-only and
  marked against the one before it, under a head that leads back to the draft, steps to the older
  and newer versions (`[` and `]`), and restores it - and which version is shown is component
  state, not the URL. What saving the draft would publish is not a place either: it rises in the
  section's commit bar once the draft holds something. `?tab=versions` survives as a redirect
  and does not appear in the navigation.
- **The frames blocking a narrowing are a dialog over Classes, not a screen** — a view *of*
  the draft the editor is showing, reached from the commit bar's *frames in the way* badge, from a Save
  the preview refuses, and from a class removal it refuses. A row links to **every** batch
  holding its frame rather than one, because an annotation carries an `asset_id` and no batch.
  It shows a window of the frames and states the total as text rather than a "see all": the
  destination such a control would need is a view narrowed to exactly those frames, and the
  Images section, which lists every image of the project and narrows only by source, has no
  such filter.

## Two dashboards, and what separates them

**Not mounted by the standalone app.** The Home route was removed: `/` redirects to the project list, and the rail carries no Home entry. `HomeScreen` and `GET /home` still exist (a reusable `ui-core` screen and its API read), and what follows describes them for a host that mounts it.

**Home is the workspace's dashboard; Overview is the project's.** They do not overlap, because
they answer different questions: Home asks *what is waiting on me, anywhere*, which no single
project can answer, and Overview asks *what does this project hold*. So Home carries nothing
project-scoped — no class distribution, no samples, no schema state — and every row on it is a
deep link into the screen that owns the thing. Home's resume target is **derived, never
persisted**, and ranked by progress rather than recency because no timestamp exists on a batch,
an annotation or an asset's progress.

**Overview never duplicates a section's full function.** A number on it that has a section to
answer it is a *door* into that section: the whole card is a real button, keyboard-reachable and
announced as an action (Images, Classes and In dataset); *Labeled* is a plain figure, because
the batches that answer it are the panel directly below. The four figures are four equal cards,
each with a meter where the number is a share of something and at most one action - a pointer,
labelled from what the batches declare (*Review draft*, *Review and add to dataset*, *Publish a
release*), that opens the place where the action lives. *Labeled* counts the images a person has
decided, read from the batches' progress - the images of every batch that has been cut into
jobs, less those still unannotated and those holding only an unjudged model draft - and its
context line says how many are left, so the two always add up; it does not use the project
statistics' `annotated_pct`, which counts model drafts nobody has reviewed. The active schema
version is not a chip above the page; it is the Classes section's to say. A section with nothing
yet says so in words rather than showing a zero. There is no releases panel: the *In dataset*
card says what no release holds yet and points at the Dataset's releases. The *Classes* card,
last of the four, draws the classes as one bar of shares and opens the Classes section, where the
full legend lives. A batch's row opens its panel - its jobs, who holds them and how far each
has come - except a draft's, which opens its approval: approving is the one thing a draft is
opened for, and once approved the panel opens on the batch's next step. Its pointers ("Review and
approve", "Review and start", "Review and add to dataset", "Annotate") live in the row's menu -
nothing appears on hover - and are labelled from the batch's `allowed_actions`; they open the
batch's panel (a draft's, its approval; *Annotate* on a batch of one job, that job), where the
action itself lives with its gating and refusals. Browsing images is the Images section's job, not the Overview's.

**The Overview acts on nothing except batches, and why.** A batch has no section and no page
of its own - the Overview is where batches are listed - so what a batch may be asked to do is
done here, in its panel's footer, and nowhere else. The project-wide **Auto-label** dialog runs a
model over the batches that declare `pre_label`: it opens from a line between the Batches band
and the table while images are waiting for labels, or from the band's quiet icon once that line
is put away. A batch that declares it offers the same dialog over itself alone from its row menu
and its panel's top bar. The panel - a sheet over the page's scrim, put away by a press outside it
and resized from its left edge - holds every other action in its footer, every one an icon button
named by its tooltip: *delete* and *create correction batch* at its start, and **one forward
control per state** at its end - approve, start annotating, annotate, *complete* (whose
confirmation holds the *add to the dataset* switch) and *add to dataset*. Each is offered only
where the batch's `allowed_actions` declare it, each with its own gating, refusals and outcome
line. The interface says *add to dataset* for what the kernel, API, CLI and MCP call
`promote`: the same operation, named for what a person sees it do. Nothing else on the Overview mutates: the numbers, the class rail and the
images are pointers. **Add images** is not on the Overview at all as a panel control: it is the project bar's, and it
opens the dialog whose result is a new batch (see *Inside a project*).

## Ways out

- **A sub-view inside a project carries one way out, and a section carries none.** With the
  project's sections in a toolbar, the open projects in tabs and the workspace's
  destinations on the rail, an ancestor chain inside a project says nothing they do not. So a page that sits *below*
  a section would carry one control back to the level above it (`patterns/BackLink.tsx`:
  `← <project name>`), and a section — the four sections of a project — carries nothing: the
  toolbar is its way around and the rail's *Projects* its way up. There is no such page today:
  Add images, the last one, is a dialog over the section it was opened from, and closing it is
  its way out. The annotation editor keeps its own arrow for the same reason —
  it is a tool that takes the whole screen, and its arrow means *up* to the batch.
- **Structural, never `navigate(-1)`.** History is not a parent: it means the previous
  frame when you walked through a job, nothing at all on a fresh tab, and one asset at a time after walking
  forward through a job. Every destination has to be the same however the page was reached
  — clicked through, pasted, reloaded, or walked forward from a sibling. The destinations
  live in one `PARENT` table in `app/src/routes.tsx`, because a destination is a fact about
  the route table and `ui-core` deliberately has no router.
- **A project's section is a level.** Sections are path segments
  (`/projects/:id/schema`) because somebody links to one and returns to it — that makes it
  somewhere you were, so it is somewhere you can be sent back to. The annotator's way up is
  the batch's panel on the Overview, because that is where the project's batches are listed and
  the job was opened from. Deleting a batch from its panel closes the panel and stays there.
- **The affordance names its destination.** "Back" alone is a promise about history;
  "Overview", or a project's own name, is a promise about structure — the one the control
  can keep. A name that has not loaded yet falls back to the noun (`parentLabel`) rather
  than to nothing, so the control does not change width under a cursor that is already
  aiming at it; the full label rides in `title` where the width cuts it short.
- **Placement follows the pane.** On a padded page the control is the first thing above the
  page header — a ghost `xs` button, pulled left by the gutter so its label aligns with the
  `<h1>` beneath it. On the full-bleed annotation editor it is the first control in the
  bar, a ghost back-arrow heading the tool rail's column, because the bar's breadcrumb
  beside it already names the batch it returns to.
- **A screen takes navigation as an optional callback, never a route.** `ui-core` may not
  import a router, so a host that has nowhere to send anybody renders no control rather
  than a dead one. The host spells every URL; the screen supplies every label.

## Inside a project

- **The sections are a toolbar across the pane.** At `lg` and above, every route under
  `/projects/:id/` — the four sections (Overview, Images, Classes, Dataset), and the Add images
  dialog over whichever is open — renders under a 48px project bar that spans the pane from the
  rail's edge, directly under the open-project tabs (`patterns/ProjectNav.tsx`'s `bar`
  layout, laid out by `ProjectShell`, composed by `screens/ProjectFrame.tsx`). It replaced a
  180px column: the toolbar costs height the pages have to spare instead of width the panel
  and the tables need. It renders nowhere else: not on the project list, Models, or
  the annotator — the one page of a project that stands outside its frame, because an
  editor needs the whole screen. A dialog over a section — Add images among them — leaves that
  section lit underneath. Under the toolbar a section reads
  in the padded, capped column every page does — except **Images**, which lays its grid and the
  selected image across the whole pane (`ProjectShell`'s `bleed`) and fits the window, so only
  its grid scrolls.
- **The bar is the section's header.** Sections draw no header of their own: the open tab
  names the page (each section keeps an `sr-only` `h1`), and the bar carries, left to right,
  one tab per section — a real link with `aria-current="page"`, the section's count beside
  its name — then one line about the open section after a hairline divider, then the
  section's actions and the overflow. The line says what the counts do not: the project's
  description on Overview (or how far labelling has come, without one), the version in force
  on Classes, the latest release on Dataset; Images has none, because its own band describes
  its sources. The counts arrive together, once every one has answered, and a tab keeps its
  width when it opens (its medium-weight label is reserved underneath), so changing section
  moves nothing in the bar.
- **The bar offers what the open section is about, and only that.** Overview: **Annotate**,
  with **Add images** outlined before it while a batch is open for annotation, or Add images
  as the filled control when none is. Images: **Add images**. Classes: none in the bar — **New**
  sits in the section's band beside the History icon button while the draft has classes (the
  empty table keeps its own **New class**; a past version, which nobody adds to, offers none),
  stepping back to `outline` while the commit bar's **Save version** is up. Dataset: **Publish release**. On Classes and Dataset, Add
  images is the overflow's first entry, so it is one click from every section without
  crowding the sections it is not about; the overflow also holds Rename and Delete project.
  A section's own actions belong to state the section holds (the class dialog, the publish
  dialog), so the section renders them and they portal into the bar
  (`patterns/SectionActions.tsx`). Labels are the fewest words that still say what happens,
  each after an icon. One filled control per view still holds: the Add images dialog's footer
  has its own, over a scrim, so the bar's is out of reach while it is open. The Dataset
  draws *Publish release* for the working copy and nothing for a release, whose export is a
  section of its facts in the column.
- **The Dataset's views are component state.** Which version is open is chosen in the
  section's left column, and a recipe is a dialog; none is a path segment or a
  query parameter, on the rule below that not everything selectable is a place.
- **The project's identity is the open-project tab, not a line above the content.** The tab
  across the top already names the project, so no eyebrow line carries the name or an
  active-version chip over the content. The schema version shows where it is used — in the
  Overview's *Annotations* card (`schema v4`), in the Classes section and its bar line, and
  in the annotator's pinned badge. The description shows on Overview only, as its bar line.
- **Below `lg` the same component becomes the tab strip.** The tab list sits on the left
  with the section's actions and the overflow on its right, the content in the panel
  beneath; the switch is a `matchMedia` answer, so one navigation is in
  the DOM at a time and nothing is read twice. Same items, same data, two layouts.
- **The bar's surface is `background` with a hairline**, not the chrome's `sidebar-*`
  tokens: it belongs to one project and reads as part of the page, where the rail, the tabs
  and the status bar belong to the workspace.

## The workbench frame

- **Every page but the annotator sits in one frame**: the rail on the left, the open-project
  tabs across the top, the status bar along the bottom (`app/src/shell/AppShell.tsx`). The
  document scrolls; the rail and the tabs stick to the top and the status bar to the
  bottom. The annotator stands outside the shell: the whole viewport, with no main rail,
  no tabs and no status bar, because its fit zoom is measured off its pane. It is left by
  its own back control (see *Ways out*), not by the rail, and ⌘B does nothing there.
- **Visiting a project opens its tab, and the tab stays until it is closed.** Projects are
  held the way an editor holds files: two projects are one click apart, not a trip through
  the list. A tab is a real link to the last address you were at inside that project, so
  returning lands where you left. Closing the open tab goes to the tab that slides into its
  place, or to the project list when it was the last. The `+` at the end of the strip opens
  any project not already open. The list persists per browser (`localStorage`, capped at
  eight, oldest dropped first); a tab whose project the server answers 404 for closes
  itself (`app/src/shell/openProjects.ts`, `ProjectTabs.tsx`).
- **The tabs are not a second sitemap.** They are a shortcut to project routes that already
  exist, and carry no destination of their own; the project list on the rail stays the one
  place that answers "what projects exist".
- **The status bar states, and changes nothing.** Two halves. At the left, the page's own
  facts, written there by the screen (`ui-core`'s `PageStatus`): what the list on screen
  adds up to - *13 images · 11 to annotate*, *3 ready · 1 not set up* - which the page then does
  not repeat. How many rows the list holds, and of how many while a filter narrows it, is the
  paged table's footer's (`DESIGN.md`, *Paging a table*), not the bar's. At the right, the workspace's: any
  weight download in flight with its progress, how many model connections are ready, and
  which credential this page is using - read from the server through the same queries and
  predicates the Models page uses. Its models summary links to Models; on Models it and the
  downloads step aside, because the grid shows every state and run. It draws no health
  light: one failed read is not proof the server is down.

## The rail

- **The rail is for top-level destinations only.** Per-screen return navigation never lives
  on it — that is what lets it name where it goes. A rail destination has no way out of
  its own, for the reason a section has none: the rail *is* it, and a second answer to
  "where am I" inside the pane would contradict it.
- **What earns a rail entry**: a workspace-level object every project uses, which has
  nowhere else to live. Model connections carry no project id, so a project tab would state
  a scope the object does not have. A destination that belongs to one project does not
  qualify, however often it is visited. The current entries: the mark, Projects, Models,
  the collapse toggle in the mark's row, and account at the bottom — nothing else. The entry is named for the noun
  it lists — the models a workspace can run — rather than for one use of them, and its
  route is `/models`; `/inference`, the address it had before, redirects there.
- **The rail collapses and expands**: 48px collapsed (`--spacing-rail`, the default), 208px
  expanded (`--spacing-rail-expanded`), toggled with ⌘B / Ctrl+B or from the rail's top row,
  and remembered per browser (`app/src/shell/railState.ts`). Collapsed, the mark is the
  expand button — it turns into the panel icon under the pointer or focus; expanded, the
  collapse button sits at the right end of the logo's row. Collapsed, every entry is an icon
  whose label is its accessible name and its tooltip; expanded, the full logo and the labels
  show and the tooltips go. Every icon sits in the same 40px-wide slot in both states and the
  logo's mark at the same x, so expanding only adds labels.
- **The change is instant.** A panel flipped many times a day is where motion costs more
  than it tells, and animating the width would re-lay out the Overview's panel and the
  tables beside it on every frame. The pages beside the rail reflow once, to the new width.

## The browser, and what belongs in the URL

- **The browser's Back button stays correct, and is never the only way out.** Nothing here
  replaces it; a `replace` navigation is still right where a change is a view of the same
  resource rather than a place (a project's section, or the annotator's current asset). A
  URL that no longer describes what is on screen is not a place you can send somebody, and
  `replace` is what stops Back from walking back through sections — or one picture at a
  time through an annotation session.
- **A control that means "show me more of what I am already in" does not navigate.** The
  annotation page's arrow means *up*: it exits to the batch, saving first. Its grid button
  means *switch frames* — so it opens a gallery overlay inside the editor and the URL does
  not move. Going up and looking at your own frames are different intentions, and only one
  of them is a reason to leave. The overlay is a switcher and nothing else: no batch
  actions, no selection, no route change.
- **Not everything selectable is a place.** A project's section is a path segment because
  somebody links to it and returns to it; the schema version somebody is glancing at is
  component state, because it is a lens on the section they are already in. The test is whether the thing
  survives being pasted to a colleague as a destination — if the answer is "they would want
  the current one instead", it is view state and the URL should not carry it. Getting this
  wrong in the other direction is worse than it looks: `ui-core` has no router, so every
  URL-borne choice has to be threaded through the host as a prop and a callback.
