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
| `/` | Home - the workspace dashboard | yes |
| `/projects`, `/projects/:id` (`?tab=overview\|schema\|batches\|dataset`), `/projects/:id/ingest`, `/projects/:id/batches/:id`, `/projects/:id/dataset` | the product | yes |
| `/inference` | model connections, workspace-scoped | yes |
| `/jobs/:jobId` (`?asset=<id>`) | the annotation page | yes |
| `/demo` | the annotator showcase (`?scene=bench` for #49's benchmark) | **no** |
| `/styleguide` | the rendered design system | **no** |

The last two need no server and no credential - the showcase's picture is a `data:`
URI and the styleguide is pure CSS - so putting them behind the gate would ask for a
token to look at a page that cannot use one. They are also what lets the browser
suite run with no backend.

Two of the tab values are not in that list. `?tab=versions` is honoured and lands on
Schema, because version history lives inside that tab and a URL somebody bookmarked is a
promise; and `/projects/:id/dataset` is the Dataset tab's old address, kept as a redirect
for the same reason. Neither appears in the tab bar. The
[`information-architecture`](../../.agents/skills/frontend/information-architecture/SKILL.md)
skill is the canonical sitemap.

Two of those query parameters are kept true rather than only read, and it is the same
rule twice: `?tab=` on the project page (#171) and `?asset=` on the annotator (#353)
are both **rewritten** as the page moves, with `replace` rather than `push`. A URL
that no longer describes what is on screen is not a place you can send somebody, and
`replace` is what stops Back from walking back through tabs - or, in the annotator,
one picture at a time through an annotation session. `ui-core` imports no router, so
in both cases the screen reports and `routes.tsx` spells: `resolveProjectTab` and
`assetParamFor` are those two decisions, pure and testable without a browser.

The router's basename is `import.meta.env.BASE_URL`, which is what vite substitutes
for its `base` option - so the router and the bundle cannot disagree about the `/app`
prefix the wheel serves under. A **reload** on a client route is a real request for a
path no file backs; [`api.md`](api.md#where-the-ui-lives) describes the server-side
fallback that answers it.

The rail is the whole shell: logo, collapse toggle, Home, Projects, Inference, sign
out. Anything richer growing on it is what the thin-app audit exists to catch - a
capability in `app/` is one the future enterprise UI cannot reuse. `Inference` joined by
the decision recorded on #421 (2026-08-08): what earns an entry is a workspace-level
object every project uses and that has nowhere else to live, never frequency of use.

### Two panes, and which one a route gets

`AppShell` renders the rail and a bare `<Outlet/>`; the pane beside it is a **nested
layout route**, so choosing one is a routing decision and the shell stays
composition-only.

| pane | routes | treatment |
| --- | --- | --- |
| `PaddedPane` | everything else | `px-4 py-6 md:px-6`, content capped at `max-w-7xl` |
| `FullBleedPane` | `/jobs/:jobId` | the whole viewport beside the rail, `h-screen`, `overflow-hidden` |

A padded, capped column is right for a list or a form and wrong for the one screen
somebody sits in front of for an hour. Boxing the annotator cost more than looks
(#183): `fitToViewport` derives the zoom from `getBoundingClientRect` on the pane, so
a shrunken pane opened every asset smaller than it needed to and applied the
tolerance constants - all in *screen* pixels, divided by zoom - at a zoom nobody
chose. `h-screen` *plus* `py-6` also made the document 948px tall in a 900px window,
so the canvas's own badge was cut off and the whole page scrolled.

`FullBleedPane` is `h-screen` rather than `flex-1`: a flex item stretches to its row,
the row is `min-h-screen`, and a page taller than the window would drag the rail down
with it. Pinning the height is what makes "the canvas pane is the only thing with
`overflow`" structural rather than incidental.

The panes are nested under **one** `AppShell` rather than under two sibling shells,
so there is a single copy to keep correct. That is *not* what preserves the rail's
collapsed state across a pane change - measured: two sibling
`<Route element={<AppShell />}>` branches are reconciled into one instance and
preserve it too. The behaviour is asserted directly in `e2e/annotate.spec.ts`, which
is the level that survives either structure.

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

`/` is the workspace dashboard. It was a redirect to the project list until there
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
does its destination: the first two open the editor, the third the gallery. The two
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
*48 model-labeled frames waiting on an annotator*. Both rows open the batch gallery,
where the model-labeled segment and its bulk verbs are
([below](#reviewing-a-pre-labeled-batch)); a batch holding both kinds gets both rows.

One thing about the page is still a consequence of the storage format rather than a
choice, and it is stated on the endpoint as well as here: the activity feed's
`ingest` entry is the newest `Asset.ingested_at` in a project rather than a run
finishing, because an ingest job records no times at all.

A workspace with no projects reads zeros, nulls and empty lists. That is the
first-run state, and `totals.projects` is how the screen recognises it - not a flag,
which would be a second spelling of a fact the response already carries.

### The project view, and the one screen whose section is in the URL

A project has three sections - its schema, its batches, its version history - and
they are **tabs**, not four things stacked in one column (#171). The header is not a
tab: the project's name and the actions that apply to all of it (ingest, dataset,
rename) sit above the tab list, and the tab list is what says the rest are
alternatives rather than a sequence. `Schema` is the default, because a project
starts schema-less on purpose and nothing downstream can be approved without one.

The section travels as **`?tab=`**, so it survives a reload and can be linked to -
which is most of the point of giving the version history a place of its own. That
does not put a router inside `ui-core`: `ProjectScreen` takes `tab` as a raw string
and hands a normalised one back through `onTabChange`, exactly as every other screen
takes navigation. Normalising is the screen's job, so an unknown value opens on the
default rather than on nothing. With `onTabChange` absent the tabs are uncontrolled
and still work, which is what lets a component test - or a host with no router -
render the screen unchanged.

**Each tab owns its query.** Radix unmounts inactive content, so a query living in
the section that renders it follows the tab: the version list is read when Versions
is opened rather than on every visit to a project, and the batch table stops polling
while another tab is showing. Only `useProject` runs at the top, because the header
is outside the tabs and always drawn.

No panel repeats its own tab's name as a heading. Radix labels each panel with its
trigger, so an `<h2>` saying "Batches" under a tab saying "Batches" is a stutter for
a reader and for a screen reader both; what stays is the line the tab cannot carry -
where a batch comes from, which version a save would create, why a past version has
no edit controls.

### The dataset, its releases, and getting the data out

A release is the only truly immutable artifact, and the screen reflects that: the
timeline offers no edit and no delete, because there is no `ReleaseService.delete`
 - only a project's own cascade removes one, and the manifest blob survives even
that.

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

There is no pre-export validation route, so consent here is attempt-shaped: attempt → read
`LOSSY_EXPORT_NOT_CONSENTED` off the 409 → ask → retry with the flag. The schema editor does
not have this shape - it previews first - and the difference is exactly the routed preview
that export lacks.
`FormatOut.lossy` makes the question predictable in advance, because lossiness is
declared by the **format** - a bbox-only format loses a polygon whether or not
today's dataset holds one.

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

**Saving is a diff, and then a reload.** The annotator mints client-side ids and
the kernel mints its own (#40 declined a `rebaseAnnotationId` for this reason), so
a save cannot merge its own response back in. It computes created / updated /
deleted against what was loaded, sends up to three all-or-nothing calls - **deletes
first**, so a failure leaves the smaller document a retry can be built from - and
then refetches.

#### There is no autosave, and that is the policy

1. **A save is followed by a reload**, so a debounced autosave would rebuild the
   document under the cursor every few seconds - and a rebuild mid-gesture is a
   dropped drag.
2. **Every call is all-or-nothing.** A partial autosave has no meaning: the kernel
   refuses a batch as a unit and reports the offending index, and firing that on a
   timer reports it about work the user was not doing.
3. **The two cases autosave exists for are covered**: "I forgot" is
   save-on-navigate, "I closed the tab" is the `beforeunload` guard.

#### Review is a flow, not an API-only edge

`annotated → review_pending → accepted | annotated` are three legal edges of
`ASSET_PROGRESS_TRANSITIONS`, and until now the browser offered **none** of them.
The gallery's "In review" segment could only be populated through the API or MCP,
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

**The job counter reads "past `unannotated` and `pre_labeled`", not the `annotated`
count.** A readout that counted only `annotated` goes *backwards* when a frame is
accepted, which is the one thing a progress readout must never do. It had that
bug, and it never bit because nothing could produce `accepted`; the real-server
cycle run caught it the moment the review moves landed, at 3 of 3 becoming 2 of 3.
A model's unreviewed guess is excluded from the count the same way `unannotated`
is, for the same reason: nobody has made a decision about the frame yet.

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

The gallery says the same thing one screen earlier: its header button reads **View
frames** and its per-tile link reads **View** when nothing in the batch declares
`annotate`. Same door, honest word.

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

**Three tools since #342**: box, polygon and polyline. `polyline` spent one release
as this section's worked example of declared-but-not-drawable - #223 shipped the
geometry end to end and stopped short of the tool - and it is a live button now.

The rule that example demonstrated is unchanged, and `PENDING_TOOLS` still holds it
with nothing in it: **a geometry a schema declares and no tool draws gets a disabled
button carrying the reason**, placed after every usable tool, never a gap. A missing
control would say "this schema has no lanes", which is false, and it is exactly the
ambiguity `ui-capabilities` forbids: absent and not-yet-available look identical and
only one of them is true. `mask`, `keypoints` and the two 3D geometries are all
still in that position the day a schema declares one.

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
before accepting. It runs through a model
connection (`docs/content/inference.md`), and the server side of it is
`POST /inference/suggest`.

**It runs through a connection that can answer a click**, which is a narrower set
than "the ones that are ready": only those declaring `point_suggest`. A workspace
whose only downloaded model answers text prompts gets a panel saying so, and no
request is sent - the server would refuse each one truthfully, which is a correct
answer to a question the editor should not have asked. The panel tells that case
apart from having nothing configured and from having nothing downloaded, because
each is a different thing to go and do.

Where more than one connection can answer, the panel carries a picker naming the
model under each, and the choice is remembered **per project** - it is a
preference about this browser, so it survives leaving the editor and does not
become a workspace setting that everybody annotating shares. With one candidate
there is no control at all, only a line naming what is answering. The picker
appears on the idle card alone: changing which model answers while a proposal is
on screen would leave a shape nothing on the card explains.

The gesture:

| Press | What it does |
| --- | --- |
| left-click | adds a point on the object, and asks again |
| alt-click | adds a point that is **not** on the object, and asks again |
| `↵` | accepts the proposal as an annotation |
| `[` / `]` | coarser or finer, without opening anything |
| `Esc` | closes the adjustments; then clears the points; then puts the tool away |

Every click sends **all** the points placed so far - the route is stateless - and
the answer replaces the preview. The first click on a frame is the slow one,
because the model reads the whole image once; refining after it is quick.

**A wait says so on the panel, and nowhere else.** The card reads
`Looking at that…` on the same frame the request leaves. Past a second and a half -
long enough that this is plausibly the first click on the frame - it adds the
sentence explaining why that one is slow.

Nothing appears at the cursor or the click point. A ring and a busy cursor used to,
and both were taken away: sitting on the picture beside the pointer, they read as
the machine having seized rather than as work in progress, and they were in the way
of the thing being looked at.

Refining while an answer is still out is fine and is the ordinary way to work: the
shape already on screen stays drawn, so you keep the best answer so far while the
next one is fetched. The panel goes back to `Looking at that…` for the duration,
which is why `Accept` is not offered until the newer shape arrives. `Esc` takes the
whole thing back at once. A refusal replaces the card with prose, so nothing is ever
left saying a request is out when it is over.

**The proposal is not an annotation until it is accepted.** It is drawn faintly
with a dashed outline - solid is what an accepted annotation gets - carries its
class and the model's confidence beside it, and is in neither the document nor the
undo history. `Esc` is its undo. Switching class, switching frames or leaving the
page discards it, and nothing is written.

**Its vertices are drawn the whole time it is up**, which is what makes the detail
setting something you can see rather than a number that changes. A committed shape
shows its vertices only while it is selected; a proposal is not selected and shows
them anyway, because choosing how much outline to keep is exactly a question about
where the points are.

**The shape can be adjusted before it is accepted**, from a section inside the
same card - never a second panel over the picture, which would cover the thing
being adjusted. It is closed until you ask for it, because the default is right
most of the time.

One setting, and whether it appears is the server's answer rather than the
editor's guess (`docs/content/inference.md`). **Detail** is a three-position slider -
coarse, balanced, fine - with a label beside it naming the step and what it costs,
`Fine · 41 pts`. `[` and `]` move it without opening anything. Either way it costs
no request at all: the answer carried the outline it was reduced from, and the
editor re-simplifies it here, so the shape and its vertices move under a held key.

Pressing the slider never takes focus off the canvas, so `[`, `]`, `Esc` and `↵`
keep working while you drag it. Tab still reaches it, for driving it from the
keyboard on purpose.

On a class that stores a box the section does not appear at all, because detail
changes an outline and a box has none. The editor does not know that; the answer
says so, by naming no settings.

**Two settings were here and are not.** Closing the gaps in the mask and proposing
every separate piece are still done, at fixed defaults. As controls they did
nothing to an ordinary clean mask - every position gave the same shape - and each
touch of one re-ran the model to produce it.

**Adjusting into nothing says so and leaves the controls up.** A setting can
empty the proposal - every piece too small, or an outline reduced past being a
shape - and when it does, the card says what happened and every control stays
where it was, so the way back is the way you came. The preview never simply
vanishes.

**Accepting is one action and one undo.** Where an answer proposes more than one
shape, `Accept` writes all of them and a single `mod+z` takes all of them back.
Accepting some and not others is planned rather than present (#548).

**The tool stays armed while you change class.** Arming it is a decision about how
to work, and picking the class to work on is the next thing you do - so a class
switch ends the proposal on screen and not the tool. The next click asks under the
new class, in its geometry and its colour. Only pressing the button again, or
moving to another frame, puts the tool away.

Land on a class that can hold no proposal - a tag, a lane - and the tool **parks**
rather than switching itself off: the button dims and says why, the panel says what
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

Arming it with no usable connection shows an in-editor panel saying what is
missing - none configured, or configured with its weights not yet downloaded - and
one action to fix it. Nothing navigates away, and no exit loses work. A refusal
from the server is rendered where the panel is, in the server's own words, which
is what carries the install command when the optional runtime is absent.

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

### The gallery, and the `<img>` that cannot work

**Every route but `/health` and `/openapi.json` needs a credential, and an
`<img src>` sends no header.** The browser issues that request itself, with cookies
and nothing else, so pointing an `<img>` at
`GET /projects/{p}/assets/{a}/thumbnail` produces a 401 and a broken-image icon on
every tile whenever the credential is a token - and the API takes no token in the
query string. A browser *session* would in fact carry, since a cookie is exactly
what an `<img>` does send; the mechanism stays because it must work for both, and a
gallery that rendered only for locally-signed-in users would be the kind of bug
nobody reproduces. So `AssetThumbnail` fetches the bytes with the credentialed
client and
hands the result over as an object URL - which it then **revokes**, because a
gallery scrolling a thousand assets would otherwise hold a thousand JPEGs alive
with nothing referencing them.

The cost is smaller than it looks: the route carries
`Cache-Control: public, max-age=31536000, immutable` with the content hash as its
`ETag`, and a `fetch` gets the browser's HTTP cache as much as an `<img>` does.

A **NULL `thumbnail_hash` is a state, not a failure** - a preview that would not
render is deliberately not an `IngestFailure`, because the asset exists and nothing
was lost. It draws a placeholder, and offers no button: the remedy,
`backfill_thumbnails`, is reachable only from the CLI and MCP.

**Paging and virtualization are two problems and both are solved.** `limit`/`offset`
bound the *response*, so the network side is `useInfiniteQuery` - and "have I seen
everything" is `seen < total`, because `total` is the size of the whole batch and
does not move. Ten pages fetched is still ten pages in the DOM, so the render side
virtualizes **rows** (a row is what the browser lays out; virtualizing tiles inside a
CSS grid means reimplementing the grid). The column count is measured with a
`ResizeObserver` rather than guessed from a second breakpoint list.

#### The jobs strip

One row per job - ordinal, frame count, state, and who is working it - rendered
only once jobs exist, the same `showsProgress` gate the progress bar above it uses,
so a draft needs no empty state of its own. The assignee is a plain editable name,
not an account: `JobService.assign` gates on nothing, so the control is always
live, and clearing it is the same operation with `null`. A failed read shows its
error instead of the strip silently vanishing - an empty list and a failed one look
identical to the naive `undefined`-or-zero-items check, and only one of them means
there is nothing to assign.

### Batches, and a machine that only goes forwards

`draft → approved → in_annotation → completed`, with **no route back to `draft`** -
jobs are already cut against the pinned schema. So the table offers exactly one
action per state and never a revert: an action that would be refused is an action
that should not be drawn.

Approval is when the project's active schema version **pins to the batch and stops
moving**, which is why the version column is empty until then. `complete` is
*derived* rather than automatic - the service reads the jobs and refuses while any
is outstanding - so that button is offered and its refusal is real.

The partition dialog offers **single job** and **by size N**. `BySegments` is
deliberately absent, the same call the CLI made: the only caller holding an exact
partition is a program, it is the one strategy that can be *wrong*, and expressing
it means typing tuples of UUIDs. Its `kind` is always sent explicitly - a
discriminated union's tag emitted by default reads as optional in the schema while
pydantic needs it in the dict to pick a variant.

#### Deleting a batch, behind `⋯` and at two anchors

The one control on either of these screens that ends a batch rather than moving it
along, and the only irreversible one - so it lives in an overflow menu, where the
things you go looking for live, rather than beside the thing you press next. It is
mounted twice, on the Batches row and in the gallery header, from **one component**
(`screens/DeleteBatch.tsx`): a second spelling of which states may be deleted, of
the blast radius, or of the confirmation would be the hand-mirror one layer up
from the one `capabilities.ts` removes.

Availability is `delete` in the batch's own `allowed_actions`, so a `completed`
batch renders the item **disabled with the reason** - there is an operation behind
it and a state that would enable it, which is the distinction #354 drew when it
removed a control instead. The sentence is `withheldBecause`'s, shared with every
other withheld control on these screens.

What the dialog says is the **verified** blast radius. The batch, its jobs and the
per-frame progress go; the frames and their annotations stay, because
`annotation.asset_id` is a label's only parent and a batch's cascade cannot reach
one. Both numbers it quotes come off `BatchOut`, which is already loaded at both
mounts - a count of *jobs* would need a second request the Batches row never makes,
and a dialog that said "3 jobs" on one screen and nothing on the other would be two
dialogs. From the gallery it navigates to the Batches tab, replacing history: the
screen's whole subject has stopped existing.

#### Pre-labeling: the surface `text_detect` was declared for

Gated on `pre_label` in the batch's own `allowed_actions`, never on the batch's state read
locally - the same rule every control on this screen follows. It is the reason the
capability stopped being an orphan: a connection could declare `text_detect` from the day the
Inference dashboard shipped a section for it, and nothing in the app ever asked one until this
control existed to.

The model select is narrowed to connections whose `capabilities` include `text_detect`, read
off the wire rather than guessed from a name or a model id, on `inferenceQueries.ts`'s standing
rule. The confidence field defaults to `0.35` and is labelled **prompt affinity**, deliberately
never "confidence" or "accuracy": a text-prompt model scores how well a region matches the words
it was asked for, a point-prompt model's suggest tool scores mask quality against a click, and
the two run on different scales - 37-78% observed for the first, 68-98% for the second - so a
bare percentage next to a shape would not say which one it was on. The dialog states how many
of the batch's assets are untouched, because that is what the run will actually consider - an
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
`failed` summary whenever the batch has an untouched asset left, whether or not anything here
is pre-labeled. Where the batch holds
pre-labeled frames, under it sits **Replace the model labels on N pre-labeled frame(s)**,
unticked, saying that frames anyone has edited, confirmed or skipped in this batch are never
touched and that this cannot be undone. Ticked, the count line adds that the run also replaces
the model labels on those N frames, and the launch -
`Start`, `Run again`, `Continue` or `Try again` - goes live. A batch with nothing untouched left
and the box unticked has no run to launch at all, so the press is disabled and the notice names
the tick as what would give the run something to do. A settled run's summary reports how many
earlier model regions it replaced.

The route answers `202` with a background job, on the export and weight-download routes'
contract, and the dialog polls it exactly as `ExportDialog` polls an export: nothing here waits
for the run to finish, but nothing closes over an outcome unseen either. Every refusal the route
can produce reaches the dialog as prose - a batch that stopped being `in_annotation` under the
press, a connection whose model answers places rather than words, a pinned schema with no class
a detection can be written as, and a local runtime that is not installed, whose message carries
the exact `pip install` to run.

#### Pre-labeling every open batch from the Batches tab

The tab's header offers **Pre-label** whenever some batch of the project declares `pre_label` in its
own `allowed_actions` - read off the listing, never derived from state here - and is absent
otherwise. The dialog takes the same model and prompt-affinity controls as the gallery's dialog
(one component, one copy of the prose), then a checklist of the batches that declare the action,
each with its untouched count and checked by default when that count is above zero. Start posts
`POST /projects/{id}/batches/pre-label` with exactly the checked ids, so what runs is what was
seen; the answer is one row per batch, and the dialog lists each as queued or as having joined a
run already in flight, each name a link into its gallery. The batch stays the unit: the row in
the table shows a **pre-labeling…** mark while that batch's own `pre_label_run` is live, and the
gallery's dialog reads the same run afterwards. A refusal - a pin with no class the model's
shapes can be written as, naming the batch to leave out - renders as prose in the dialog, and no
batch is launched.

#### Reviewing a pre-labeled batch

The gallery's segments are answered by the server - `Model-labeled (48)` asks for
`progress=pre_labeled` and the page *is* the segment - and the counts still come off the
batch's `ProgressCounts`. An **Order** control offers *Frame order* or *Lowest prompt
affinity first* (`sort=confidence`): the frame whose weakest model label scored lowest comes
first, so a reviewer's attention lands where the model doubted. A model-labeled card reads
`3 pre-labeled · ≥41% affinity` - the number is always named, because a point-prompt mask
score and a text-prompt affinity are different scales (pre-labeling runs only the second).

The bulk bar adds two verbs over the selection. **Confirm labels** keeps a model's labels as
the frames' own (`pre_labeled → annotated`, the `confirm` action); the annotator offers the
same on an unedited model-labeled frame. **Discard model labels** deletes every label the
model wrote on the selected frames through the existing all-or-nothing delete, after a
dialog, and the frames return to `unannotated`. It cannot be undone; a replacing re-run from the
Pre-label dialog is the way to redo the machine's pass over frames still `pre_labeled`. Per-class
thresholds and a threshold filter are deliberately not here yet.

### The ingest flow, and the order the domain forces

The issue asks for an fps parameter "with original-fps display from the probe".
Those two cannot happen in that order, and the screen says so rather than
designing around it.

`extraction_fps` belongs to the **source**, not to the run - "same source, same
assets" only means something if the parameters are part of what the source *is* -
and the probe result exists only once the clip is registered. So the rate is chosen
first, the clip is registered, and then its native fps, duration, codec and
resolution are shown. Registering the same clip at another rate produces a
**second source**, deliberately: idempotency is on `(kind, path, extraction_fps)`.

Three more things it inherits:

- **Refusals split by when they can be known** (#28). A bad batch target is 404 or
  409 *before a job row exists*, so it renders on the launch form. Everything after
  the launch is on the job: `error` is the one fatal cause, `failures` is the
  per-item report.
- **`total` is `null` for a clip.** `VideoMetadata` carries no frame count by
  design, so an extraction has no denominator until it is over - a directory states
  its total before the first file. The progress readout shows a count instead of a
  percentage rather than inventing one.
- **The per-file report is grouped by kind**, which is the whole reason
  `IngestFailureKind` exists: `unsupported` is operator noise, `corrupt` is data
  loss, and reading fifty rows to notice the second is the mistake a table can
  prevent. Names are rendered as basenames with the full string in `title`, because
  for a *directory* ingest `IngestFailure.name` is the full server path - a known
  kernel inconsistency, deliberately left alone.
- **A `partial` entry is not in that table** (#452). It is the one kind that is not
  a total loss - a damaged clip read as far as its bytes went, whose frames are in
  the batch - so it renders as prose above the table: what arrived, roughly what the
  container claimed, and the remedy, which is a good copy re-ingested. The table
  below counts only the files that produced nothing. This card is the whole of where
  that fact is ever stated: nothing is stamped on the assets, no later view mentions
  it, and a run that read everything renders neither report.

Nothing is filtered in the browser and there is no `react-dropzone`. Every filter
the library would apply - MIME type, size, per-file rejection - is a rule the server
already owns and refuses better, with the kernel's own reason; duplicating it here
would be a second spelling of the accepted-format list.

#### A settled run names the batch it filled, and offers two ways on

A run that reaches `completed` or `failed` renders an outcome: the batch's name, a
button that opens it (`onOpenBatch`, wired to `/projects/{id}/batches/{id}` in
`routes.tsx` - `ui-core` may not import a router), and a second that clears the form
so another source can be ingested without reloading. Before #181 there was neither,
and `Start ingest` stayed `disabled` for the rest of the page's life.

Three things decide the shape:

- **It is offered, never taken.** No redirect on completion, because the same card
  carries the per-file report and a run with `corrupt` rows is exactly the one whose
  report must be read. A `failed` run gets the outcome too - a partial run has a
  batch, and "some of it did land" is the thing nobody would otherwise be told.
- **`batch_id` is not on the row from the first poll.** `enqueue` stores only the id
  it was *handed*, which is null whenever the run creates its own batch; the row
  learns the real one in the transaction that completes the job. So a run in flight
  has nothing to open, and one that failed before materializing a batch never gets
  one - which is why the button is conditional rather than decorative. `batch_name`
  *is* resolved at enqueue, so a partial run can still say where its assets are.
- **The outcome quotes no number.** `processed` is not the size of the batch on
  either path: a directory ingest counts refused items into it and a video ingest
  does not, and content addressing collapses identical items into one asset. The
  count that is honest is the batch's own, one click away.

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
**the editor calls it**, once before a class leaves the draft and once before a publish.
Both are therefore answered before any publish is sent. A class that already
carries labels never reaches a publish request at all: it gets one terminal dialog naming
the annotations and assets that block it, counted, and no button that starts a save the
dialog knows will be refused. A class that carries none gets one confirmation, which names
how many classes narrow and states that nothing already labeled is invalidated.
It also names what the narrowing defers: a batch still open on the outgoing version keeps
writing the class that was dropped, and those labels block a release rather than this save.

That does not demote the 409. Nothing is locked between a preview and the publish, so
somebody can label a class in the gap and turn a preview that looked safe into a refusal -
which is why the publish's own refusal stays authoritative, and why it renders through the
same blocker view the preview feeds rather than through a second presentation that could
drift from it. The preview removes a doomed round trip; it does not decide.

`compare` **is** routed since #231, and it answers the neighbouring question - what
two *published* versions did to each other. The version navigator uses it, and never
computes a diff here: `domain/schema_diff.py` is the one spelling of that rule, and a
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

### The version navigator

Every version is reachable, newest first, with its description (#230's commit
message), when it was published, and what it changed against its predecessor.
Selecting a past version renders it with **no edit affordance at all** - not a
disabled Save, not a greyed Add class; those controls are absent, because a
published version is immutable and a disabled control says "not now" when there is
no now. Version 1 shows no diff, because there is nothing before it, and a project
with one version renders no navigator at all.

**Which version is being read is component state, not the URL.** `?tab=` carries the
tab because a tab is a destination; a version somebody is glancing at is a lens on
the tab they are already in. The navigation rules
([`docs/content/ui/navigation.md`](ui/navigation.md)) state the test.

The description is written once, in a field beside Save, and there is nowhere to edit
one afterwards - no route, because no service method, because a version is immutable.
It now travels as the draft's `note` - a required string the autosave always sends, blank
or not, rather than a field the client omits when there is nothing typed. The point it
protected is not lost, only moved: a blank note still becomes a `null` description, because
`SchemaDraftService.publish` sends `draft.note or None` to `create_version` - the empty
string never reaches the version as itself.

### Frames in the way

The third section of the Schema tab, below the editor and the version history. A refused
publish states how many frames block it and then closes; those frames are still there
afterwards, and this is where they can be reached. It reads the listing behind the
preview's own counts (`POST .../schema/blocking-assets`,
[api.md](api.md#reaching-what-is-in-the-way)) - the same walk over the project, from the
same proposal - so the number the dialog quoted and the rows here cannot come to
disagree.

**It asks about the draft the editor above it is showing**, not a copy of it: the class
list comes from `shownDraft`, the editor's own derivation, because a second spelling of
which classes are on screen is a panel answering about a proposal nobody is looking at.
The read is deferred until that list has held still for the same 400ms the autosave
settles on - `ClassFields` emits an edit per character typed, and every intermediate
name is a walk over every annotation in the project that nobody asked for.

It shows the first twelve and says how many there are, because each row fetches a
thumbnail on mount and a narrowing that orphans five thousand frames would otherwise
open five thousand requests at once. The remainder is stated as text rather than offered
as a "see all", since there is no project-wide asset view to send anybody to. **A row
links to every batch holding its frame, never to one** - an annotation carries an
`asset_id` and no batch, so a frame in three batches has three honest destinations and
no preferred one, and a frame in none gets no link rather than a guess. That makes the
whole section pointless without a batch route, so a host that wires none does not get
it; nor does a project with no published version, which has no contract to narrow yet.

### Adding a class from the annotation page

A class that does not exist used to cost a round trip through the Schema tab **and a
new batch**, because the old one pins the old version. The `+` in the tool palette
opens a dialog carrying the same fields (`patterns/ClassFields.tsx`, shared with the
Schema tab so the two cannot drift on geometries, derived colours or how an
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
row of its own, held apart from the Schema tab's `curated` draft so a half-finished
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

The geometry picker offers `bbox`, `polygon`, `polyline` and `classification_tag` - the
four an `Annotation` can carry. `GeometryType` declares eight; the kernel refuses the rest
at write time with `UnsupportedGeometry`, and offering a choice the API will refuse
is worse than not offering it.

`polyline` was offered here for a release before anything drew one (#223), and #342 closed
that gap: a lane class now gets a real tool on the annotator's strip. The picker did not
change, which is the point - the schema editor offers what an `Annotation` can carry, and
whether a tool exists for it is the annotator's business to state, not this screen's.

The options are **grouped by category** rather than listed flat (#375): `bbox`, `polygon`
and `classification_tag` under *Basic Computer Vision*, `polyline` under *Robotics and AD*.
The headings are `SelectLabel`s - presentation, not selectable, walked past by the keyboard
 - and a category with nothing offered under it renders no heading at all. The same grouping
appears in the annotator's add-a-class dialog without a second call site, because both
render `patterns/ClassFields.tsx`.

A class **description** is not editable, because `LabelClassBody` does not carry
one. Left out rather than stored where it would not survive a round trip.

## No screen calls `fetch`

`frontend/ui-core/src/client.ts` is the only hand-written module that knows how a
request is made, and `createApiClient` is the only thing that builds one. Everything
about *what* can be requested - paths, parameters, bodies, response shapes - comes
from `src/generated/api.ts`, generated from the committed `openapi.json` and gated
against it on every pull request. A screen that mistypes a route fails to compile.

A screen reaches the client through a hook:

```tsx
const client = useApiClient();
const projects = useQuery({
  queryKey: ["projects"],
  queryFn: async () => unwrap(await client.GET("/projects", {})),
});
```

`unwrap` is the single adapter between the two models in play. `openapi-fetch` never
throws - it answers `{data, error, response}` and leaves the branch to the caller -
while TanStack Query's entire model is resolve-or-reject, and "rejected" is what
drives `isError`, retries and the error surface. Because every call goes through
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

**On this machine, the server signs the browser in.** `ApiProvider` asks once, with
`GET /session`; the server answers by setting an `HttpOnly` cookie when the request
came from loopback *and* addressed the server as loopback. The whole argument - the
modes, the DNS-rebinding case, why a cookie is safer here than what it replaced -
is in [auth.md](auth.md#the-browser-session). What matters on this side is that the
credential is one **no script here can read**, so "am I signed in?" is a question
the app has to ask rather than answer by looking.

That is why `ApiSession.access` exists and the gate does not test `token !== null`.
Four states: `checking` (the one round trip, during which `TokenGate` renders
**nothing** - a login form that flashes in front of somebody who never has to see
one is worse than a blank frame), `session`, `token`, `none`. The probe runs once
per mount, which is what keeps `signOut` meaningful: one that could run again would
sign a machine-local user straight back in, and a 401 on a session would oscillate
through the gate forever.

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

## The 401 is handled once

`ApiProvider` subscribes to the query cache and the mutation cache, and any 401 from
anywhere clears the token. It is a **subscription**, not an `onError` on the
`QueryClient` the provider builds, and the difference is load-bearing: the client is
a prop, so a caller may supply their own, and a handler configured at construction is
then simply absent for the whole application.

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

`ApiProvider` takes `baseUrl` and the app decides it - a library that reads
`import.meta.env` is a library that can only be built one way.

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
clicks the run card's own **Open batch** instead. Deleting the `onOpenBatch` prop in
`routes.tsx` leaves every unit test green and fails this step.
