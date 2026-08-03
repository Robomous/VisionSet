# The browser client

How `@visionset/ui-core` talks to the API, and the three decisions every screen
inherits: where the API is, which credential is in use, and what happens when that
credential stops working.

The **visual** contract is [`DESIGN.md`](../DESIGN.md) at the repository root. This
document is the data half.

## What M5 shipped

`@visionset/ui-core` went from a placeholder `tokens.css` and a generated client to
the whole product: a design system, a data shell, six screens, the annotator's side
panel and the annotation page. `@visionset/app` is a router, a rail and nothing else.

| | before M5 | after |
| --- | --- | --- |
| `ui-core` vitest | 0 | **107** |
| Playwright (annotator) | 42 | **76** |
| Playwright (browser cycle) | — | **1**, against a real server |
| Python | 1923 | **1932** |

The exit criterion — *"with `visionset ui` running, a user completes the entire cycle
in the browser"* — is not asserted, it is **driven**: `pnpm --filter @visionset/app
cycle` walks token → project → schema → ingest → approve → annotate → finish →
complete → promote → publish → verify → export → download against the built bundle
and the real kernel, on every pull request.

`FORMAT_VERSION` is still **11** and `openapi.json` is byte-identical to
`v0.0.1-alpha.4`. The milestone's one deliberate Python touch — #58's SPA deep-link
fallback — is an exception handler, and an exception handler is not an operation.

## Routes

`@visionset/app` is shell only, and `src/routes.tsx` is the whole of it.

| route | what | behind the token gate |
| --- | --- | --- |
| `/` | Home | yes |
| `/projects`, `/projects/:id` (`?tab=schema\|batches\|versions`), `/projects/:id/ingest`, `/projects/:id/batches/:id`, `/projects/:id/dataset` | the product | yes |
| `/jobs/:jobId` | the annotation page | yes |
| `/demo` | the annotator showcase (`?scene=bench` for #49's benchmark) | **no** |
| `/styleguide` | the rendered design system | **no** |

The last two need no server and no credential — the showcase's picture is a `data:`
URI and the styleguide is pure CSS — so putting them behind the gate would ask for a
token to look at a page that cannot use one. They are also what lets the browser
suite run with no backend.

The router's basename is `import.meta.env.BASE_URL`, which is what vite substitutes
for its `base` option — so the router and the bundle cannot disagree about the `/ui`
prefix the wheel serves under. A **reload** on a client route is a real request for a
path no file backs; [`api.md`](api.md#where-the-ui-lives) describes the server-side
fallback that answers it.

The rail is the whole shell: logo, collapse toggle, Home, Projects, sign out. Anything
richer growing on it is what the thin-app audit exists to catch — a capability in
`app/` is one the future enterprise UI cannot reuse.

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
tolerance constants — all in *screen* pixels, divided by zoom — at a zoom nobody
chose. `h-screen` *plus* `py-6` also made the document 948px tall in a 900px window,
so the canvas's own badge was cut off and the whole page scrolled.

`FullBleedPane` is `h-screen` rather than `flex-1`: a flex item stretches to its row,
the row is `min-h-screen`, and a page taller than the window would drag the rail down
with it. Pinning the height is what makes "the canvas pane is the only thing with
`overflow`" structural rather than incidental.

The panes are nested under **one** `AppShell` rather than under two sibling shells,
so there is a single copy to keep correct. That is *not* what preserves the rail's
collapsed state across a pane change — measured: two sibling
`<Route element={<AppShell />}>` branches are reconciled into one instance and
preserve it too. The behaviour is asserted directly in `e2e/annotate.spec.ts`, which
is the level that survives either structure.

## Screens

A screen is a component in `@visionset/ui-core` and a route in `@visionset/app`. It
takes **navigation as a callback**, never a router: a screen that called
`useNavigate` would only work inside a `react-router` tree, which is a dependency
the future enterprise UI has no reason to share.

Query keys are hierarchical — `["projects"]` → `["projects", id]` →
`["projects", id, "schema"]` — because TanStack Query matches a **prefix**. So
invalidating `["projects", id]` after a rename refreshes the project, its schema and
its version list, and the mutation never has to enumerate what it affected.

### The project view, and the one screen whose section is in the URL

A project has three sections — its schema, its batches, its version history — and
they are **tabs**, not four things stacked in one column (#171). The header is not a
tab: the project's name and the actions that apply to all of it (ingest, dataset,
rename) sit above the tab list, and the tab list is what says the rest are
alternatives rather than a sequence. `Schema` is the default, because a project
starts schema-less on purpose and nothing downstream can be approved without one.

The section travels as **`?tab=`**, so it survives a reload and can be linked to —
which is most of the point of giving the version history a place of its own. That
does not put a router inside `ui-core`: `ProjectScreen` takes `tab` as a raw string
and hands a normalised one back through `onTabChange`, exactly as every other screen
takes navigation. Normalising is the screen's job, so an unknown value opens on the
default rather than on nothing. With `onTabChange` absent the tabs are uncontrolled
and still work, which is what lets a component test — or a host with no router —
render the screen unchanged.

**Each tab owns its query.** Radix unmounts inactive content, so a query living in
the section that renders it follows the tab: the version list is read when Versions
is opened rather than on every visit to a project, and the batch table stops polling
while another tab is showing. Only `useProject` runs at the top, because the header
is outside the tabs and always drawn.

No panel repeats its own tab's name as a heading. Radix labels each panel with its
trigger, so an `<h2>` saying "Batches" under a tab saying "Batches" is a stutter for
a reader and for a screen reader both; what stays is the line the tab cannot carry —
where a batch comes from, which version a save would create, why a past version has
no edit controls.

### The dataset, its releases, and getting the data out

A release is the only truly immutable artifact, and the screen reflects that: the
timeline offers no edit and no delete, because there is no `ReleaseService.delete`
— only a project's own cascade removes one, and the manifest blob survives even
that.

**Verification is on demand.** `verify` re-reads and re-hashes every blob the
manifest names — `BlobStore.exists` is `is_file()` on a path *named by* the hash and
proves nothing — so it is not something to run because a list rendered. A broken
manifest is reported on its own: the service stops with `checked: 0`, so every other
number would be about a document that is not the one its hash names.

**The split's fractions are compared the kernel's way.** `0.7 + 0.15 + 0.15` is not
`1.0` in binary floating point, and the kernel uses `math.isclose(abs_tol=1e-9)`; a
stricter check in the browser would refuse a recipe the API accepts.

**`allow_lossy` is the third gate word**, and this is where it lives. `confirm=`
guards destroying data, `allow_destructive=` guards narrowing a contract, and this
one guards emitting an **incomplete copy of something that stays intact**. The
kernel never catches the three together and neither does the UI: three dialogs,
three questions.

There is no pre-export validation route, so consent is the schema editor's shape:
attempt → read `LOSSY_EXPORT_NOT_CONSENTED` off the 409 → ask → retry with the flag.
`FormatOut.lossy` makes the question predictable in advance, because lossiness is
declared by the **format** — a bbox-only format loses a polygon whether or not
today's dataset holds one.

### Downloads, and the fourth instance of one finding

`<a href download>` sends no `Authorization` header, exactly as `<img src>` does not.
So an export archive and a manifest are fetched through the typed client and saved
with `saveBlob`: an object URL, an anchor, `a.click()`, and a revoke on the next
tick. `a.click()` rather than a synthesised event — a `MouseEvent` built in script is
not user activation, and a browser may refuse the download outright.

### The annotation page

Where M4's engine meets M3's API. Three findings shaped it.

**`next_pending_assets` is a work queue, not a navigator.** The obvious way to
build `‹ filename n/m ›` is `GET /jobs/{id}/next?n=<count>`; it is wrong, because
that route hands out **pending** assets, so the list shrinks as the user works,
`n/m` counts down under them, and an asset already annotated cannot be navigated
back to. The stable list is the batch's asset listing filtered to this job —
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
deleted against what was loaded, sends up to three all-or-nothing calls — **deletes
first**, so a failure leaves the smaller document a retry can be built from — and
then refetches.

#### There is no autosave, and that is the policy

1. **A save is followed by a reload**, so a debounced autosave would rebuild the
   document under the cursor every few seconds — and a rebuild mid-gesture is a
   dropped drag.
2. **Every call is all-or-nothing.** A partial autosave has no meaning: the kernel
   refuses a batch as a unit and reports the offending index, and firing that on a
   timer reports it about work the user was not doing.
3. **The two cases autosave exists for are covered**: "I forgot" is
   save-on-navigate, "I closed the tab" is the `beforeunload` guard.

#### Reversing a skip is an action, never a side effect of drawing

`progress_after_annotating` moves an asset only `unannotated ↔ annotated`, because
`skipped` is a person's decision and drawing a box does not contradict a decision.
That rule is right, and until #187 the browser simply never offered the one exit
`ASSET_PROGRESS_TRANSITIONS` allows — so a user could label a skipped asset, watch
the save succeed, and lose the work at promotion, since `PROMOTABLE_PROGRESS`
excludes `skipped`.

The page closes that with the **explicit** move rather than an implicit one. The
asset's own progress is always on the bar, and on a skipped asset `Skip` is replaced
by **Un-skip**, which sends `unannotated` and stays on the asset — settling advances
because you are finished with it, reversing does not because you have just come back
to it. Automatic-on-save was rejected: it would overwrite a recorded decision without
asking, and a decision is somebody's action here the same way `confirm=`,
`allow_destructive=` and `allow_lossy` are one layer down. A prompt was rejected too
— a modal in the middle of the annotation loop interrupts the one gesture the page
exists for, and it leaves a user who only wants to un-skip with nothing to press.
What the automatic reading was right about is that `Save` must never look inert; it
does not, because a notice beside the canvas says why the counter stayed put.

#### `?` opens a sheet built from the binding table, not from a copy of it

The page used to pass `onHostAction={(name) => name === TOGGLE_HELP}`. Returning `true`
means *the host handled this action*, so pressing `?` — a real binding in
`core/input/bindings.ts` — was consumed and then discarded: the user got nothing, and
the engine had been told the request was served, so nothing else could pick it up
(#189). An unhandled host action now returns `false`, which is what that value is for.

`ShortcutSheet` takes a `Registry` and renders whatever is in it. It is the same map
the canvas resolves keystrokes against, because both call **`defaultRegistry(schema,
overrides)`** — one exported spelling of the fold, added so the two callers cannot
drift. Delete a binding and a row disappears; add a class to the schema and a digit
appears. Both are mutation-tested, which is the check v1's hand-written
`HelpModal.tsx` never had.

The English is not derived: an action's `kind` is a discriminant, so a
`Record<ActionKind, …>` turns one into a sentence, and a ninth action kind fails to
compile rather than rendering a blank row. Host actions stay open — core enumerates no
capability — so an unknown name renders as itself. `mod+c` / `mod+v` are listed as
**deliberately unbound**, because a user who cannot find them has no way to tell "not
implemented" from "not listed".

**Accept** calls the existing progress endpoint with `accepted`, and is enabled only
where `ASSET_PROGRESS_TRANSITIONS` allows the move — offering it on an untouched
asset would be offering a refusal. It is **not** loosened to cover a skipped asset:
the way to reach `annotated` from `skipped` is to un-skip and annotate, which is
what the machine says. The zoom `−`/`%`/`+` and fit drive
`AnnotatorCanvas`'s new `viewRef` handle, whose `fit` is the same implementation
`mod+0` reaches, which is why that chord stays intercepted rather than forwarded.
The version dropdown and Merge render **disabled**: they are #127 and post-beta, and
drawing them keeps the bar the shape the design shows.

### The annotation side panel

`AnnotatorPanel` — Objects and Labels — lives in **`ui-core`**, not in the
annotator's adapters. The annotator's whole claim is that it *"owns no UI a product
would want to restyle"*: it ships headless, with no Tailwind and no design tokens,
so a styled panel inside `adapters/react` would be the first thing an embedder had
to fight. `ui-core` already depends on the annotator, so the dependency runs the
right way.

The *capability* went the other way and had to. Hiding an object must remove it
from the **hit test** as well as the drawing — `resolveTarget` reads the document
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
  kernel judges geometry per class (`DisallowedGeometry`) — offering the rest would
  be offering a refusal. It applies behind a button, so a keyboard-driven picker
  does not fill the undo history with states nobody chose.

Visibility is view state and returns the **same document object** when nothing is
hidden, which is what keeps `AnnotationLayer`'s `memo` bailing out — #49's finding
about `skipId`, from the other side.

### The gallery, and the `<img>` that cannot work

**Every route but `/health` and `/openapi.json` needs a credential, and an
`<img src>` sends no header.** The browser issues that request itself, with cookies
and nothing else, so pointing an `<img>` at
`GET /projects/{p}/assets/{a}/thumbnail` produces a 401 and a broken-image icon on
every tile whenever the credential is a token — and the API takes no token in the
query string. A browser *session* would in fact carry, since a cookie is exactly
what an `<img>` does send; the mechanism stays because it must work for both, and a
gallery that rendered only for locally-signed-in users would be the kind of bug
nobody reproduces. So `AssetThumbnail` fetches the bytes with the credentialed
client and
hands the result over as an object URL — which it then **revokes**, because a
gallery scrolling a thousand assets would otherwise hold a thousand JPEGs alive
with nothing referencing them.

The cost is smaller than it looks: the route carries
`Cache-Control: public, max-age=31536000, immutable` with the content hash as its
`ETag`, and a `fetch` gets the browser's HTTP cache as much as an `<img>` does.

A **NULL `thumbnail_hash` is a state, not a failure** — a preview that would not
render is deliberately not an `IngestFailure`, because the asset exists and nothing
was lost. It draws a placeholder, and offers no button: the remedy,
`backfill_thumbnails`, is reachable only from the CLI and MCP.

**Paging and virtualization are two problems and both are solved.** `limit`/`offset`
bound the *response*, so the network side is `useInfiniteQuery` — and "have I seen
everything" is `seen < total`, because `total` is the size of the whole batch and
does not move. Ten pages fetched is still ten pages in the DOM, so the render side
virtualizes **rows** (a row is what the browser lays out; virtualizing tiles inside a
CSS grid means reimplementing the grid). The column count is measured with a
`ResizeObserver` rather than guessed from a second breakpoint list.

### Batches, and a machine that only goes forwards

`draft → approved → in_annotation → completed`, with **no route back to `draft`** —
jobs are already cut against the pinned schema. So the table offers exactly one
action per state and never a revert: an action that would be refused is an action
that should not be drawn.

Approval is when the project's active schema version **pins to the batch and stops
moving**, which is why the version column is empty until then. `complete` is
*derived* rather than automatic — the service reads the jobs and refuses while any
is outstanding — so that button is offered and its refusal is real.

The partition dialog offers **single job** and **by size N**. `BySegments` is
deliberately absent, the same call the CLI made: the only caller holding an exact
partition is a program, it is the one strategy that can be *wrong*, and expressing
it means typing tuples of UUIDs. Its `kind` is always sent explicitly — a
discriminated union's tag emitted by default reads as optional in the schema while
pydantic needs it in the dict to pick a variant.

### The ingest flow, and the order the domain forces

The issue asks for an fps parameter "with original-fps display from the probe".
Those two cannot happen in that order, and the screen says so rather than
designing around it.

`extraction_fps` belongs to the **source**, not to the run — "same source, same
assets" only means something if the parameters are part of what the source *is* —
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
  design, so an extraction has no denominator until it is over — a directory states
  its total before the first file. The progress readout shows a count instead of a
  percentage rather than inventing one.
- **The per-file report is grouped by kind**, which is the whole reason
  `IngestFailureKind` exists: `unsupported` is operator noise, `corrupt` is data
  loss, and reading fifty rows to notice the second is the mistake a table can
  prevent. Names are rendered as basenames with the full string in `title`, because
  for a *directory* ingest `IngestFailure.name` is the full server path — a known
  kernel inconsistency, deliberately left alone.

Nothing is filtered in the browser and there is no `react-dropzone`. Every filter
the library would apply — MIME type, size, per-file rejection — is a rule the server
already owns and refuses better, with the kernel's own reason; duplicating it here
would be a second spelling of the accepted-format list.

#### A settled run names the batch it filled, and offers two ways on

A run that reaches `completed` or `failed` renders an outcome: the batch's name, a
button that opens it (`onOpenBatch`, wired to `/projects/{id}/batches/{id}` in
`routes.tsx` — `ui-core` may not import a router), and a second that clears the form
so another source can be ingested without reloading. Before #181 there was neither,
and `Start ingest` stayed `disabled` for the rest of the page's life.

Three things decide the shape:

- **It is offered, never taken.** No redirect on completion, because the same card
  carries the per-file report and a run with `corrupt` rows is exactly the one whose
  report must be read. A `failed` run gets the outcome too — a partial run has a
  batch, and "some of it did land" is the thing nobody would otherwise be told.
- **`batch_id` is not on the row from the first poll.** `enqueue` stores only the id
  it was *handed*, which is null whenever the run creates its own batch; the row
  learns the real one in the transaction that completes the job. So a run in flight
  has nothing to open, and one that failed before materializing a batch never gets
  one — which is why the button is conditional rather than decorative. `batch_name`
  *is* resolved at enqueue, so a partial run can still say where its assets are.
- **The outcome quotes no number.** `processed` is not the size of the batch on
  either path: a directory ingest counts refused items into it and a video ingest
  does not, and content addressing collapses identical items into one asset. The
  count that is honest is the batch's own, one click away.

### The schema editor, and the two 409s

The editor is where `docs/api.md`'s "branch on the code, never on the status" earns
its keep, because both refusals are **409** and only one may be retried:

| code | what it means | what the editor offers |
| --- | --- | --- |
| `DESTRUCTIVE_SCHEMA_CHANGE` | the new version narrows the contract | **Save anyway**, which retries with `?allow_destructive=true` |
| `SCHEMA_CHANGE_WOULD_ORPHAN` | annotations already exist under an affected class | **Close**, and nothing else |

A client branching on the status would offer the override for both and loop forever
on the second — the failure `SchemaChangeWouldOrphan`'s kernel docstring warns
about, and the reason it is deliberately *not* a subclass of
`DestructiveSchemaChange`. The missing button is the feature.

There is still no preview of the change *you are drafting*: `SchemaService.preview`
is unrouted, so the only way to learn that the edit in front of you is destructive is
to attempt it and read the refusal. That is why the refusal surface is the editor's
real subject.

`compare` **is** routed since #231, and it answers the neighbouring question — what
two *published* versions did to each other. The version navigator uses it, and never
computes a diff here: `domain/schema_diff.py` is the one spelling of that rule, and a
TypeScript copy would drift until the screen called a change safe that the API then
refused.

### The version navigator

Every version is reachable, newest first, with its description (#230's commit
message), when it was published, and what it changed against its predecessor.
Selecting a past version renders it with **no edit affordance at all** — not a
disabled Save, not a greyed Add class; those controls are absent, because a
published version is immutable and a disabled control says "not now" when there is
no now. Version 1 shows no diff, because there is nothing before it, and a project
with one version renders no navigator at all.

**Which version is being read is component state, not the URL.** `?tab=` carries the
tab because a tab is a destination; a version somebody is glancing at is a lens on
the tab they are already in. `DESIGN.md`'s navigation rules state the test.

The description is written once, in a field beside Save, and there is nowhere to edit
one afterwards — no route, because no service method, because a version is immutable.
Blank omits the key rather than sending `""`.

### Adding a class from the annotation page

A class that does not exist used to cost a round trip through the Schema tab **and a
new batch**, because the old one pins the old version. The `+` in the tool palette
opens a dialog carrying the same fields (`patterns/ClassFields.tsx`, shared with the
Schema tab so the two cannot drift on geometries, derived colours or how an
attribute's options are typed), and the flow is three calls in one order:

1. **save** the pending annotations,
2. **publish** the next version — the *active* version's classes plus the new one,
   never the batch's pin, because versions are linear and composing on a stale pin
   would silently delete everything published since,
3. **re-pin** the batch (#229) onto it.

**Step 1 is first because the schema refetch rebuilds the annotator store.** The
store is a `useMemo` keyed on the schema, so publishing before saving discards the
user's last few boxes with a success toast on screen — no error, nothing to see.
`addClass.test.ts` asserts the sequence and fails if any pair flips.

Three requests are not a transaction. What each failure leaves behind is stated
rather than hidden, and the one worth naming is the last: **if the re-pin refuses,
the version exists and the pin has not moved.** That refusal has no flag on purpose
— it means somebody else narrowed the schema past this batch's pin — so the dialog
names the Schema tab rather than offering a retry that cannot work.

On success the new class becomes the active one. That state lives on the page rather
than in the store, so it survives the rebuild, and its digit hotkey arrives free
because the palette order *is* the hotkey order (#46).

Three other decisions the editor inherits rather than invents:

- **A version is immutable**, so the editor drafts and *publishes N+1*. Past
  versions are read-only because they are read-only — there are no controls, not
  disabled ones.
- **`?confirm=true` and `?allow_destructive=true` are different words** and are
  never merged. `confirm=` guards destroying data (deleting a project);
  `allow_destructive=` guards narrowing a contract. Each has its own dialog.
- **A 404 from `GET /schema` is an answer**, not a failure: a project starts
  schema-less on purpose, so that code becomes an empty draft rather than an error
  surface.

The geometry picker offers `bbox`, `polygon` and `classification_tag` — the three an
`Annotation` can carry. `GeometryType` declares eight; the kernel refuses the rest
at write time with `UnsupportedGeometry`, and offering a choice the API will refuse
is worse than not offering it.

A class **description** is not editable, because `LabelClassBody` does not carry
one. Left out rather than stored where it would not survive a round trip.

## No screen calls `fetch`

`frontend/ui-core/src/client.ts` is the only hand-written module that knows how a
request is made, and `createApiClient` is the only thing that builds one. Everything
about *what* can be requested — paths, parameters, bodies, response shapes — comes
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
throws — it answers `{data, error, response}` and leaves the branch to the caller —
while TanStack Query's entire model is resolve-or-reject, and "rejected" is what
drives `isError`, retries and the error surface. Because every call goes through
`unwrap`, no screen in this repository writes `if (error)` by hand.

## Reading a refusal

The API emits [one error body](api.md) at every status: `{code, message, detail?}`.
`unwrap` turns it into an `ApiError` whose **first** field is the code, because
`docs/api.md`'s rule is that clients branch on the code and never on the status —
`DESTRUCTIVE_SCHEMA_CHANGE` and `SCHEMA_CHANGE_WOULD_ORPHAN` are both 409 and only
the first is retryable with a flag.

Two codes are the client's own, for answers the contract cannot describe:

| code | when |
| --- | --- |
| `NETWORK_ERROR` | the request never reached a server — the most likely failure on a tool whose server you start by hand |
| `MALFORMED_RESPONSE` | something answered, but not with the contract's shape: a proxy, a gateway, an HTML error page |

`ApiError.incidentId` reads `detail.incident_id`, which is where a 5xx puts the one
thing a person can quote when the message itself is deliberately withheld.

## The credential

There are no accounts, and since #179 there is usually nothing to type either.

**On this machine, the server signs the browser in.** `ApiProvider` asks once, with
`GET /session`; the server answers by setting an `HttpOnly` cookie when the request
came from loopback *and* addressed the server as loopback. The whole argument — the
modes, the DNS-rebinding case, why a cookie is safer here than what it replaced —
is in [auth.md](auth.md#the-browser-session). What matters on this side is that the
credential is one **no script here can read**, so "am I signed in?" is a question
the app has to ask rather than answer by looking.

That is why `ApiSession.access` exists and the gate does not test `token !== null`.
Four states: `checking` (the one round trip, during which `TokenGate` renders
**nothing** — a login form that flashes in front of somebody who never has to see
one is worse than a blank frame), `session`, `token`, `none`. The probe runs once
per mount, which is what keeps `signOut` meaningful: one that could run again would
sign a machine-local user straight back in, and a 401 on a session would oscillate
through the gate forever.

**A token is the other credential**, minted out of band with
`visionset token create --name ui`, presented as `Authorization: Bearer`, and the
only way in for a browser the server will not sign in — a LAN client, a deployment
running `never`. The form **verifies before it adopts**: it spends one
`GET /projects` with a throwaway client and only calls `signIn` on a 200. Storing
whatever was pasted and letting the first screen fail would put the error on a
project list, which then reports a problem about projects when the real problem is
the credential.

In the rail, that same asymmetry is one word: the sign-out control reads **"Use a
token"** during a session, because it cannot delete a cookie it cannot read — it
stops using it here, and a reload signs you back in.

Refusals are told apart by what to do next, not by status: a 401 says the token was
refused (mistyped, revoked, or minted for a different workspace — the API answers
one identical 401 for all four cases and a client must not pretend otherwise), and a
`NETWORK_ERROR` says the server is not answering and names `visionset ui`.

### Where it is kept, and why

**`sessionStorage`.** The credential survives a reload — which matters, because the
annotation page is the one screen somebody sits on for an hour and losing the token
on an accidental refresh, with unsaved geometry on the canvas, is the worst moment
this product has — and it is per tab, so two workspaces in two tabs do not overwrite
each other.

`localStorage` was rejected: it writes a long-lived bearer credential to disk with no
expiry, and VisionSet tokens are valid until somebody runs `visionset token revoke`.
In-memory-only was rejected for the reload. A cookie would need a login endpoint the
API does not have.

Against XSS, `sessionStorage` is not meaningfully safer than a variable — an injected
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
has a job open produces a 401 from whichever request fires next — usually a
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

`usePollingQuery` for the operations that finish on their own schedule — ingest, and
anything else launched with a 202. The predicate is named for the **settled** state
rather than for "keep going", because the terminal states are enumerated in the domain
and the running ones are not; a predicate written the other way round silently keeps
polling a state somebody adds later.

## Where the API is

`ApiProvider` takes `baseUrl` and the app decides it — a library that reads
`import.meta.env` is a library that can only be built one way.

- **Production**: `""`. `visionset ui` serves the API at the root and the bundle at
  `/ui`, so a relative request already lands on it.
- **Development**: `"/api"`, proxied by vite to `http://127.0.0.1:8000` (override with
  `VISIONSET_API`).

The compose stack adds a third case that changes nothing here: nginx on :8080 answers
`/api/` itself and forwards it to the API, so the app's request never reaches vite's
proxy. The app is unchanged either way — it asks its own origin for `/api`, and
something in front of it knows where the API is. Which is the point of the prefix.

The proxy rather than CORS on the server, and the prefix rather than proxying the
API's own paths. CORS would put a middleware in front of every response *in
production too*, and the catch-all `Exception` handler lives in
`ServerErrorMiddleware`, outside the user middleware stack — so a CORS layer would
not run on a 500 anyway. The prefix exists because the API owns the root: `/projects`
is both a real endpoint and a client route the SPA will want.


## Selectors

Every control a test drives carries a **`data-testid`**, and that is the policy
rather than a habit. Three suites depend on it — the annotator's 76 scenarios,
`ui-core`'s component tests, and #59's browser cycle — and the alternatives each
fail in their own way: a CSS class is the design system's to change, and a visible
string is the copy's.

The rules:

- **Name the thing, not the widget.** `save`, `approve-${batch.name}`,
  `object-row-0` — never `primary-button-2`.
- **Interpolate the domain's own identifier** when a control repeats:
  `class-${name}`, `release-${tag}`, `version-${n}`. A test then reads the way the
  product does.
- **State goes on `data-*`, not on a class.** `data-active`, `data-selected`,
  `data-hidden`, `data-collapsed`. #50 moved an assertion off a literal
  `rgb(143, 211, 244)` for exactly this reason: it pinned the design system rather
  than the behaviour, and it got *stronger* in the move, because a `data-` attribute
  can be asserted on every row at once.
- **Roles where a role is the claim.** `getByRole("dialog")`,
  `toHaveAccessibleName`, `aria-current` — if the assertion is about accessibility,
  a `data-testid` would be testing the wrong thing.

## The browser cycle

`pnpm --filter @visionset/app cycle` runs the whole product against a real server:
`visionset ui` serving the built bundle out of `_static/`, the real API, the real
kernel, and no mocks anywhere. Token → project → schema → ingest → approve →
annotate → finish → complete → promote → publish → verify → export → download.

It is one test, deliberately: every step needs the last one's output, and splitting
it would mean either ten sign-ins or shared state that makes the order load-bearing
and invisible. `test.step` gives the reporting a multi-test file would have bought.

**It found three gaps that every other suite was structurally blind to**, because
each is about one screen's effect on another:

1. Nothing invalidated the batch list when an ingest **completed** — only when it
   launched, before the batch exists — so a user who ingested and then walked to the
   batch list saw "No batches yet" about a batch that was right there.
2. Nothing started or completed a **job**. `BatchService.complete` refuses while a
   job is outstanding and `JobService.complete` refuses while an asset is unsettled,
   so a batch annotated entirely in the browser could never leave `in_annotation`.
3. Nothing **promoted** a completed batch into the trunk, so a release could only
   ever be published over an empty dataset.

Each is now owned by the screen the domain says owns it, and the cycle asserts all
three.

It is also the only place a route's callback wiring is exercised at all. The cycle
used to reach the batch by walking back through the project after an ingest —
`jobIdOf`'s shape, the helper #160 deleted for the same reason — so since #181 it
clicks the run card's own **Open batch** instead. Deleting the `onOpenBatch` prop in
`routes.tsx` leaves every unit test green and fails this step.
