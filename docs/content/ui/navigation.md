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
/                                  Home — the workspace dashboard (rail destination)
    └─ deep-links out to: /jobs/:jobId?asset= (resume), /projects/:id/batches/:id
       (review rows and the resume fallback), /projects/:id, /projects
/projects                          Projects list
/models                            Models — model connections as cards (workspace-scoped)
/projects/:id                      → redirects to /projects/:id/overview
/projects/:id/<section>            Project — sections as path segments, drawn as a navigation
                                   column beside the content at ≥lg and a tab strip below, in
                                   this order:
    overview                         Overview (dashboard)
    batches                          Batches (workflow) — omitted when the host wires no batch route
    schema                           Schema (contract)
                                       ├─ version history: subsection INSIDE Schema, not a sibling
                                       └─ frames in the way: subsection INSIDE Schema; each row links
                                          out to /projects/:id/batches/:batchId, once per holding batch
    dataset                          Dataset — a section, not a buried route; four views as tabs
                                       (component state, Overview by default): Overview (counts,
                                       per class) · Assets (the trunk) · Pre-processing (the
                                       project's recipes, applied at export) · Releases (the
                                       timeline)
/projects/:id/ingest               Ingest flow
/projects/:id/batches/:batchId     Batch workspace (gallery)
/jobs/:jobId                       Annotator (full-bleed)

Redirects kept as promises (a bookmarked URL is one):
/projects/:id?tab=X             → /projects/:id/X, every other query parameter kept;
                                  `versions` → schema, an unknown X → overview
/inference                      → /models, the page's address before it was named for
                                  the noun it catalogues
```

The section order is work order: what a project *is* (Overview), what came *in* (Batches — an
ingest lands in one), what it *means* (Schema), what came *out* (Dataset).

**Single route definition site**: `frontend/app/src/routes.tsx`. No routes are defined
elsewhere, every destination is declared in its `PARENT` map, and `ui-core` imports no router —
so `resolveProjectTab` can only say what a stale `?tab=` value resolves to, never change the
URL. An unknown section segment is a 404, because nothing ever linked to one; an unknown
`?tab=` value redirects to `overview`, because old links exist.

## Entry points

- **Annotate enters by job.** A project's `Annotate` control opens the chosen `in_annotation`
  batch's one job directly (`/jobs/:jobId`) when it has exactly one, and the batch gallery
  otherwise — the gallery is where a job is chosen when there are several, and the job's own
  door is the only door. The gallery header carries the `approved → in_annotation` transition
  and nothing that opens the editor. A job's `Annotate` takes a `pending` job to `in_progress`
  before opening it; `Continue` and `View` only open.
- **A batch shows one job's frames at a time, and one job is the batch.** With exactly one job
  the gallery draws no accordion: that job's controls sit under the batch header, followed by
  its filter, order, strip and frames. From two jobs it is an accordion with at most one panel
  open, each header naming its assignee, the panel open on arrival being the first job with
  work left. A draft batch, having no jobs, keeps the flat grid. The rule is observability — a
  batch-wide grid beneath a per-job control puts two scopes for the same frames on one screen.
  None of this changes an address; the open panel is not in the URL.
- **A correction batch is reached from the batch that needs correcting**, never from a "new
  batch" form: the gallery header and the Batches row both offer it on a `completed` batch,
  capability-gated. The annotator's read-only notice and the gallery's bulk bar *link* to it
  rather than duplicating it — a second place batches are made is a second place the rules can
  drift.
- **Dataset is first-class.** It is the product's central object and is reachable in ≤1 click
  from any project section. It is never gated behind, or discoverable only through, onboarding.
- **The 4-step checklist is onboarding, not navigation.** It gates nothing and is never the
  sole path to a screen, and it retires itself twice over: when the journey is finished, and
  when somebody dismisses it. Dismissal is per project and persisted.

## What is a section, and what is a subsection

- **Pre-processing is a view of the Dataset**, not a section and not a dialog-only control. A
  recipe is a named project resource with no state, chosen at export beside the target model,
  so it lives where releases are exported from. The Export dialog's recipe control offers what
  this view made; it never makes one.
- **Version history lives inside the Schema section**, not beside it. The two overlap on
  purpose: the `VersionNavigator` is the *reader* (one version, with what it changed), the
  history is the *ledger* (every version at once). `?tab=versions` survives as a redirect and
  does not appear in the navigation.
- **The frames blocking a narrowing are a subsection of Schema, not a screen** — a view *of*
  the draft on the editor above them. A row links to **every** batch holding its frame rather
  than one, because an annotation carries an `asset_id` and no batch. It shows a window of the
  frames and states the total as text rather than a "see all": the destination such a control
  would need is a project-wide asset view, and there is none.

## Two dashboards, and what separates them

**Home is the workspace's dashboard; Overview is the project's.** They do not overlap, because
they answer different questions: Home asks *what is waiting on me, anywhere*, which no single
project can answer, and Overview asks *what does this project hold*. So Home carries nothing
project-scoped — no class distribution, no samples, no schema state — and every row on it is a
deep link into the screen that owns the thing. Home's resume target is **derived, never
persisted**, and ranked by progress rather than recency because no timestamp exists on a batch,
an annotation or an asset's progress.

**Overview never duplicates a section's full function.** Every number on it is a *pointer* at
the section that owns it, rendered as a real button so it is keyboard-reachable and announced
as an action, and a section with nothing yet says so in words rather than showing a zero.

## Ways out

- **A sub-view inside a project carries one way out, and a section carries none.** With the
  project's sections in a navigation column and the workspace's destinations on the rail,
  an ancestor chain inside a project says nothing they do not. So a page that sits *below*
  a section — the batch gallery, the ingest flow — carries one control back to the level
  above it (`patterns/BackLink.tsx`: `← Batches`, `← <project name>`), and a section — the
  four views of a project — carries nothing: the column is its way around and the rail's
  *Projects* its way up. The annotation editor keeps its own arrow for the same reason —
  it is a tool that takes the whole screen, and its arrow means *up* to the batch.
- **Structural, never `navigate(-1)`.** History is not a parent: it means the gallery when
  you clicked a tile, nothing at all on a fresh tab, and one asset at a time after walking
  forward through a job. Every destination has to be the same however the page was reached
  — clicked through, pasted, reloaded, or walked forward from a sibling. The destinations
  live in one `PARENT` table in `app/src/routes.tsx`, because a destination is a fact about
  the route table and `ui-core` deliberately has no router.
- **A project's section is a level.** Sections are path segments
  (`/projects/:id/batches`) because somebody links to one and returns to it — that makes it
  somewhere you were, so it is somewhere you can be sent back to. The gallery's way out is
  the Batches section for that reason, never the project's default one.
- **The affordance names its destination.** "Back" alone is a promise about history;
  "Batches", or a project's own name, is a promise about structure — the one the control
  can keep. A name that has not loaded yet falls back to the noun (`parentLabel`) rather
  than to nothing, so the control does not change width under a cursor that is already
  aiming at it; the full label rides in `title` where the width cuts it short.
- **Placement follows the pane.** On a padded page the control is the first thing above the
  page header — a ghost `xs` button, pulled left by the gutter so its label aligns with the
  `<h1>` beneath it. On the full-bleed annotation editor it is the first control in the top
  bar, a ghost back-arrow, because that bar's left zone is already truncating to hold the
  navigation cluster on the bar's centre.
- **A screen takes navigation as an optional callback, never a route.** `ui-core` may not
  import a router, so a host that has nowhere to send anybody renders no control rather
  than a dead one. The host spells every URL; the screen supplies every label.

## Inside a project

- **The sections are a navigation column, not a tab bar.** At `lg` and above, every route
  under `/projects/:id/` — the four sections (Overview, Batches, Schema, Dataset), the
  ingest flow and the batch gallery — renders inside a `180px` column between the rail and
  the content (`patterns/ProjectNav.tsx`, laid out by `ProjectShell`, composed by
  `screens/ProjectFrame.tsx`). It renders nowhere else: not on the project list, Home,
  Models, or the annotator — the one page of a project that stands outside its frame,
  because an editor needs the whole screen. A sub-view lights the section it belongs to
  (the gallery lights Batches; an ingest, which is the project's rather than any one
  section's, lights nothing) and carries its own one way out — see *Ways out*.
- **The column is only as wide as its controls, and carries navigation alone.** Top to
  bottom, on a section: **Annotate** as the one `primary` control of the project shell, or
  Ingest in its place when no batch is open for annotation; one item per section, a real
  link with `aria-current="page"` on the open one; the overflow (rename, delete) at the
  bottom. Every section's own header uses `secondary` actions — Ingest beside Annotate on
  Overview and Batches, Publish on Dataset, Save version on Schema. On a sub-view (the
  gallery, the ingest flow) the column draws no filled control at all: that page owns its
  dominant action, and a second one beside it would be two answers to "what now?". A view
  *inside* a section can own it too: while the Dataset's Pre-processing view is showing, its
  editor's *Save recipe* — or, with no recipe yet, the invitation to write one — is the page's
  one filled control, and the column's Annotate or Ingest steps back to `secondary` for as
  long as that view is open, the way it does for the Overview's first-run invitation.
- **The Dataset's views are component state.** Overview, Assets, Pre-processing and Releases
  are four lenses on one section, chosen with the product's one tab row; none is a path
  segment or a query parameter, on the rule below that not everything selectable is a place.
  The open view is held by the project screen rather than by the section, because the
  navigation column has to know when the Pre-processing editor holds the filled control.
- **The project's identity is an eyebrow above the content, not part of the column.** One
  line above a section's `h1`, at every width: the project's name and the active-version
  chip, omitted when there is no schema (`patterns/ProjectEyebrow.tsx`). It is identity and
  not navigation — it carries no control. The description shows on Overview only, under its
  meta line. A sub-view heads itself, with its own way out, and gets no eyebrow.
- **Below `lg` the same component collapses to the tab strip.** The eyebrow stays above; the
  tab list sits on the left with the filled control and the overflow on its right, the
  content in the panel beneath; the switch is a `matchMedia` answer, so one navigation is in
  the DOM at a time and nothing is read twice. Same items, same data, two layouts.
- **The column's surface is `background` with a hairline**, not the rail's `sidebar-*`
  tokens: it belongs to one project and reads as part of the page, where the rail belongs
  to the workspace.

## The rail

- **The rail is for top-level destinations only.** Per-screen return navigation never lives
  on it — that is what lets it name where it goes. A rail destination has no way out of
  its own, for the reason a section has none: the rail *is* it, and a second answer to
  "where am I" inside the pane would contradict it.
- **What earns a rail entry**: a workspace-level object every project uses, which has
  nowhere else to live. Model connections carry no project id, so a project tab would state
  a scope the object does not have. A destination that belongs to one project does not
  qualify, however often it is visited. The current entries: logo, collapse toggle, Home,
  Projects, Models, account at the bottom — nothing else. The entry is named for the noun
  it lists — the models a workspace can run — rather than for one use of them, and its
  route is `/models`; `/inference`, the address it had before, redirects there.
- **Rail widths** (current implementation, a single source of truth): 240px expanded, 48px
  collapsed — the preset's icon-sidebar width, one `size-8` control per row, centred.

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
