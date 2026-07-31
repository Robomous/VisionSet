# Annotations

An annotation is a label on an asset: a class, a geometry, and whatever attribute values that
class asks for. Everything else in the kernel exists to protect what lands here — a batch pins
a schema version so the contract stops moving, a job says who is labeling which assets.
`AnnotationService` is where those two meet the thing they were guarding, and it is the **only**
door to an `Annotation`.

```python
from visionset.kernel.domain import Annotation, BboxGeometry
from visionset.kernel.services import AnnotationService, JobService, WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    annotations, jobs = AnnotationService(workspace), JobService(workspace)

    for asset in jobs.next_pending(job.id, 20):
        annotations.add(
            job.id,
            [
                Annotation(
                    asset_id=asset.id,
                    label_class="sign",
                    schema_version=1,  # ignored — the batch's pin is stamped in
                    geometry=BboxGeometry(x=12.0, y=40.0, width=80.0, height=64.0),
                    attributes={"occluded": False, "weather": "wet"},
                    provenance="human",
                )
            ],
        )
        # the asset moved to `annotated` on its own; no jobs.mark needed

    jobs.complete(job.id)
```

## Schema violations are a hard reject, at write time, in the kernel

Not a warning, not a surface's good faith, not a nightly report. Every write is validated
before anything is stored, and the whole call rolls back on the first refusal.

| Refusal | When |
| --- | --- |
| `LabelClassNotInSchema` | The class is not in the pinned version. Matched by **exact** name. |
| `DisallowedGeometry` | The geometry is not the one that class declares. |
| `MissingRequiredAttribute` | A `required` attribute has no value. A `default` is *not* filled in. |
| `UnknownAttribute` | The annotation carries an attribute the class does not declare. |
| `InvalidAttributeValue` | Wrong type for the kind, or outside a `select`'s options. |

All five share `InvalidAnnotation`, so a delivery surface answers 422 without enumerating
them. Catching the base is safe here in a way catching `DestructiveSchemaChange` is not: no
flag overrides any of these, so there is nothing to retry into a loop. The remedy is to fix
the annotation, or to write a schema version that describes it.

The geometry rule is **per class**, not per version: a `LabelClass` declares one `geometry`, so
this is an equality test. `SchemaService.allowed_geometries` is the union across a version's
classes — the right answer to "what may this project draw?" and the wrong tool here, where it
would let a polygon through under a bbox class.

## The version is the batch's, not the project's

```python
schemas.create_version(project.id, [...])  # the project is now on version 2
annotations.add(job.id, [...])  # still judged by version 1
```

Work is judged against `Batch.schema_version`, pinned at approval and never moved. That is the
whole point of pinning: a schema that evolved mid-batch would change the rules under work
already in flight. See [batches.md](batches.md).

The service **stamps** that version onto what it stores, the way it lets `id` generate itself:
whatever the caller put in `schema_version` is replaced, because the pin is a fact about the
batch rather than an opinion of the writer. `update` does the same with `asset_id` — the stored
one wins, because moving a label from one asset to another is a delete and an add, not an edit.

`Annotation.schema_version` is still a required field with `ge=1`, so a caller has to write
*some* number there and it may as well be `1`. The model cannot default it: an `Annotation`
does not know which batch it is about to be written into, which is the same reason the model
cannot validate the class, the geometry or the attributes either.

## Every call is all-or-nothing

`add`, `update` and `delete` each take a sequence and run in one transaction. A payload with
one bad box stores nothing at all: a half-labeled asset is not a state a caller can reach.

Which is also why each publishes exactly one [`AnnotationsWritten`](events.md) after the commit,
naming its operation — one per call, not one per box, because the call is the thing that
happened.

## Attributes are keyed by exact name

```python
attributes = {"occluded": False, "weather": "wet"}
```

The keys are `Attribute.name` exactly — which is why that field is stored stripped: a trailing
space would be a second attribute nobody can see. The same exact-name matching the change
classifier uses, for the same reason (see [schemas.md](schemas.md)).

Whether a value is acceptable is `Attribute.rejects`, the one method that answers it, and the
same one an attribute's own `default` is checked against. A value and a default can never be
held to different standards.

## Whole-asset tags carry no coordinates, and the kernel does not deduplicate them

`ClassificationGeometry` is a variant with no fields, rather than `geometry: None`, so that every
annotation has a geometry with a discriminator and the union stays the single place that answers
"what shape is this label?". A class declares one geometry (see [schemas.md](schemas.md)), so a
class is *either* tagged or drawn — labelling an asset with a box, a polygon and a whole-frame tag
takes three classes.

Two classification annotations on the same asset are distinguishable only by `id`, `label_class`
and `attributes`, and **nothing in the kernel stops two identical ones existing.**
`AnnotationService._validate` judges an annotation against the pinned schema alone and never reads
the store; `annotation` has no unique index; no route and no MCP tool deduplicates. Passing the
same `(asset_id, label_class, ClassificationGeometry())` twice in one `add` call stores two rows.

That is deliberate for now rather than settled: the constraint would be a unique index and a
migration, and no surface has needed it. What it means in practice is that **"tagged" is a
property of the annotation set, not a flag**, and any surface offering a toggle owns the
invariant itself. The annotator does exactly that — `frontend/annotator/src/core/interaction/tags.ts`
makes "at most one tag per class" structural by answering with a command that changes nothing when
the tag is already there, and its untag removes *every* tag of the class, so a duplicate that
arrived from the API is healed by one toggle cycle.

One consequence worth knowing: a classification tag alone moves an asset from `unannotated` to
`annotated`, and removing the last one moves it back — the same rule as any other annotation.

## Provenance is the model's own rule, not the service's

There is no `InvalidProvenance`. `provenance="model"` requiring a `model_ref`, and `confidence`
inside `[0, 1]`, are validators on `Annotation` itself. An annotation that breaks either cannot
be constructed, so it never reaches a service to be reported. That is the division
[schemas.md](schemas.md) already draws: per-value validity is pydantic's, validity that needs
another object is the service's.

## `delete` has no `confirm=`

The one exception to the rule in [projects.md](projects.md) and [batches.md](batches.md).
Deleting a box is the ordinary annotator edit loop — draw it, look at it, take it off again —
not the destruction of a lifecycle entity the way deleting a project or a batch is. The batch
gate is the guard instead: once the work closes, nothing here can touch it at all.

## Progress follows the annotations — two edges of it

| Current | Has annotations | Becomes |
| --- | --- | --- |
| `unannotated` | yes | `annotated` |
| `annotated` | no | `unannotated` |
| anything else | either | *unchanged* |

`skipped`, `review_pending` and `accepted` are people's decisions, not consequences of a row
existing, so annotations never move them. `JobService.mark` is the door for a decision; see
[jobs.md](jobs.md).

The rule is `progress_after_annotating` in `kernel/domain/task.py` — pure, so a test can sweep
it against `ASSET_PROGRESS_TRANSITIONS` rather than against prose — and `AnnotationService`
applies it inside its own transaction, so labels and progress commit together. It never calls
`JobService.mark`, which would open a second session and write from it while the first is
still open.

## Work only happens inside an open batch

Every write requires the job's batch to be `in_annotation`, else `BatchNotInAnnotation` — the
same error `JobService` raises, reached through the same two lookups (`require_job`,
`require_open_batch`) rather than a second copy of the ladder.

The gate fires **before** the payload is looked at. A write into a closed batch is a bug
whether or not the annotation is also wrong, and hearing about it only sometimes would hide it.

Reads are not gated: `get` and `for_asset` work long after the batch closed, because a label
outlives the work that produced it.

## Over HTTP

The [API](api.md) is this service's four methods, under the job that owns the work.

```
GET    /jobs/{id}/assets/{asset_id}/annotations     → 200 AnnotationPage
POST   /jobs/{id}/annotations   [AnnotationCreate]  → 201 AnnotationPage
PATCH  /jobs/{id}/annotations   [AnnotationUpdate]  → 200 AnnotationPage
DELETE /jobs/{id}/annotations?id=&id=               → 204
```

Bulk delete takes **repeated `id` query parameters** rather than one id per request, and that is
the all-or-nothing rule showing through: three DELETEs would be three transactions, so a partial
failure would be reachable over HTTP that the SDK refuses to allow. A request body on DELETE is
legal in OpenAPI 3.1 and stripped by enough proxies to be a bad thing to require.

`schema_version` is on neither request body. The pinned version is stamped onto whatever is
sent, so a field a client could set and never observe would be a lie; it comes back on the
response. `asset_id` is likewise absent from `AnnotationUpdate` — the stored one wins.

**A refusal that is about one item carries `detail.index`**, the position in the array the
client sent. Nothing was written, and `LABEL_CLASS_NOT_IN_SCHEMA` on its own cannot say which
of forty boxes meant it. That index is `VisionSetError.index`, set by this service on the way
out of its per-item loop and published by the API — it is a fact about the call, so it lives in
the kernel rather than being reconstructed at the boundary.

The wire models re-spell the geometries rather than publishing the domain's, and each request
body converts through `to_domain()` inside a **parsing-time validator**. That is not decoration:
`provenance='model'` with no `model_ref`, a confidence outside [0, 1] and a zero-area box are
refused by pydantic, and a `ValidationError` raised from a route body is neither a
`VisionSetError` nor a `RequestValidationError` — without the validator it reaches the catch-all
handler and answers **500** to a plainly malformed payload.

## In the editor

`@visionset/annotator` mirrors this contract in TypeScript, and mirrors it **exactly**:
`snake_case` fields, geometry nested under its own key, points as `[x, y]` pairs. There is no
mapping layer, deliberately — a second spelling of twenty fields is free to drift, and a host
would pay the conversion whoever wrote it. What comes back from
`GET /jobs/{id}/assets/{asset_id}/annotations` is what the editor takes; what the editor emits is
what `POST`/`PATCH` accept.

The annotator cannot read the pydantic models, and it must not depend on `@visionset/ui-core` to
reach the generated client — that package carries `openapi-fetch`, and the editor's contract is
"no HTTP, no fetching". So the contract travels as bytes, the way `openapi.json` already does.
`tests/fixtures/wire_annotations.json` is written by `scripts/export_wire_fixtures.py` from
`AnnotationOut` itself, and two independent gates hold it in place: a pytest one keeps the file
matching the application, and a vitest one keeps the TypeScript parsing the file. The frontend CI
job installs no Python and reads only what is committed. Regenerate with:

```
uv run python scripts/export_wire_fixtures.py
```

**Two vocabularies, one union — and the editor keeps both.** `GeometryType` names eight
geometries because that is what a `LabelClass` declares (see [schemas](schemas.md)); `Geometry`
has three variants because that is what an annotation can carry. So `parseGeometry` tells a
`polyline` apart from a typo: the first is a declared geometry with no model, refused in the
kernel's own words (`UNSUPPORTED_GEOMETRY`), and the remedy is to wait for a variant rather than
to fix the caller.

The parser is strict about unknown keys as well as missing ones. That is not fussiness: the editor
hands back what it was given, so a key it silently dropped would be a field the kernel wrote and
the editor erased. It does **not** re-check bounds — a zero-area box and a two-point polygon are
refused above, by the models that own the rule, and a second copy would drift.

## Keys are bound in one place, and the table is data

v1 delivered its whole keyboard with one line — `document.addEventListener("keydown", onKey)` —
over a 210-line `if`/`else` chain, and its polygon confirm button talked to that chain by calling
`document.dispatchEvent(new KeyboardEvent("keydown", …))`. `frontend/annotator/src/core/input/`
replaces both. A chord resolves to an **action**, which is plain data; `runAction` is the only
thing that turns one into a store call.

| chord | action | lineage |
| --- | --- | --- |
| `escape` | cancel whatever is in flight | v1 |
| `enter` | commit whatever is in flight (closes a polygon at ≥3 points) | v1 |
| `delete` / `backspace` | delete the selected annotations | v1 |
| `mod+z` | undo | **new** — v1 has no undo at all |
| `mod+shift+z` | redo | **new** |
| `mod+a` | select all | **new** |
| `mod+0` | ask the host to zoom to 100% | v1 |
| `?` | ask the host for the shortcut sheet | v1 |
| `v` | select mode — no active class | v1 |
| `1`–`9` | the schema's first nine classes, in authored order | **new** |

`mod` is ctrl **or** meta, folded once, so one table serves both platforms. A class hotkey on a
`classification_tag` class toggles the tag rather than making the class active — pressing it twice
undoes it — and on any other class it sets the active class, emitting a tool change only when the
*derived tool* actually moved. A digit naming a class the schema no longer declares refuses and
does nothing, which is the same posture `tagCommand` takes: a binding outlives the class it names,
and losing a keystroke is better than losing the session.

Not bound, each for a reason: `b`/`p`/`k`/`l`, because the tool is derived from the class here, so
a tool key *is* a class key; the lane-attribute hotkeys, because attributes belong to a panel; and
`mod+c`/`mod+v`, which stay unclaimed so the browser keeps them — a clipboard is session state the
store cannot own, a paste must re-mint ids, v1's 20 px offset is screen pixels where every
coordinate here is asset pixels, and pasting a tag would break the at-most-one invariant above.

**Remapping is a fold.** `registryOf([...DEFAULT_BINDINGS, ...classHotkeys(schema), ...overrides])`
— last wins, and an override with a `null` action unbinds a chord. Nothing throws on a duplicate,
because the fold *is* the remap.

**Nothing here is scoped by a global listener, and it could not be.** `src/core/` cannot name
`document`, so an adapter attaches `onKeyDown` to the annotator's own focusable root; scoping is
subtree bubbling, with no listener lifecycle at all. Two booleans do different jobs and should not
be merged: `resolve(...) !== null` answers *is this keystroke ours*, which is what decides
`preventDefault`, and `runAction(...).changed` answers *did it do anything*. The rest of what an
adapter owes — the text-entry guard, Escape surviving it, IME filtering, the `code`-for-digits
seam on layouts where the digit row is shifted — is listed in `core/input/index.ts`.

## The React adapter, and what "embeddable" means

`<AnnotatorCanvas>` is the first renderer over the headless engine, and the whole of the React
that exists in `@visionset/annotator`. It takes a store, a picture and an active class, and it
gives back callbacks:

```tsx
const store = useAnnotatorStore({ asset, schema, annotations });   // what the API returned
<AnnotatorCanvas
  store={store}
  imageSrc={url}
  activeClass={activeClass}
  onActivateClass={setActiveClass}
  onAnnotationsChange={(document) => …}
/>
```

**No HTTP, no routing, no fetching, and no chrome.** The class palette, the undo buttons, the tag
panel and the shortcut sheet in `frontend/app/src/demo/` are all *outside* the package. That is
what makes the canvas embeddable rather than a small application: a product restyles its own
palette and never forks the annotator to do it.

The **store is a prop**, not something the canvas builds, so a host's controls read exactly the
state the canvas draws. There is deliberately no `asset` or `schema` prop either — an
`AnnotationDocument` already carries both, and a second copy is a second spelling free to drift.
What the document does not carry is the pixels, which is precisely what `imageSrc` is for.

**The image is laid out at the descriptor's width and height, never at its own `naturalWidth`.**
That is [`get_asset_image`](mcp.md)'s finding one layer out: the descriptor is the frame the
coordinates live in, and a picture whose natural size disagrees is a preview. Hand one in and
every annotation is individually plausible and uniformly wrong.

### Who owns the transform

The adapter, entirely. `geometry/tolerance.ts` is the only module inside `src/core/` allowed to
name a zoom, so the screen↔image transform lives in `adapters/viewport.ts` — pure arithmetic, no
DOM, no React, and therefore unit-tested without a browser:

```
screenToImage(v, x, y) = [ (x - v.panX) / v.zoom, (y - v.panY) / v.zoom ]
```

The `<svg>` is laid out at the asset's native size inside one wrapper carrying
`translate(pan) scale(zoom)`, so **an SVG user unit is an asset pixel** and nothing in the paint
path converts anything. The corollary is the trap: a 2-pixel stroke written as `2` is two *asset*
pixels — a hair at 8× and a slab at 10% — so every thickness, radius and font size goes through
`screenPx(px, zoom)`. It is #41's tolerance finding pointed at drawing instead of at hit-testing.

Zoom is the wheel, and `ctrlKey` on a wheel event **is** how a browser reports a trackpad pinch.
Pan is a middle- or secondary-button drag. `mod+0` refits, and it is intercepted by the adapter
rather than forwarded, because the zoom is the adapter's — it is the one row of the `InputHost`
port that is not a pass-through.

### Dragging repaints one layer

`AnnotatorStore.stage` leaves the committed document untouched and moves only the preview, which
is what lets the committed annotation layer sit still through a whole gesture: it is `memo`'d on
`(document, selection, skipId, hotId, zoom)`, and none of those move while the pointer does.
`skipId` is a `string | null` and `hotId` is a `string` for that reason — a freshly allocated
`Set`, or the `Affordance.hot` target object, would be a new prop on every pointer-move and would
defeat the bail-out before `memo` was consulted.

Measured on the demo page with twelve boxes, dragging one across thirty pointer-moves: **1 DOM
mutation in the committed layer and 601 in the transient layer**, plus one more in the committed
layer on release. The committed layer mutates twice per gesture — once when the dragged shape
leaves it, once when it comes back — and not at all in between.

React Compiler is installed nowhere in this repository, and the annotator ships as `tsc` output
that a compiler pass in a consuming app could never reach, so those `memo`/`useMemo` calls are
load-bearing rather than decoration.

### The render layers are inert, and that is not a style choice

Both `<g>` layers carry `pointer-events: none`; the `<svg>` is the only input surface and
`resolveTarget` is the only hit test. Without it the entire keyboard silently stops working after
a polygon is closed by clicking its first vertex — the shape is the press's hit target, React 19
flushes discrete events synchronously so the commit removes it *during* the event, and the
browser's own focus fixup for the `mousedown` then resolves a detached node, finds nothing, and
moves focus to `<body>`. No error is reported anywhere.

v1 could not have had this fix: its shapes carried the pointer handlers, so they had to be hit
targets. A headless hit test is what makes an inert render layer possible in the first place.

### Running the demo

```
pnpm --filter @visionset/annotator build && pnpm --filter @visionset/app dev
```

The annotator builds first, deliberately: the app resolves `@visionset/annotator` through its
`dist/`, so an unbuilt change is simply invisible in the browser rather than a compile error.
The sample image is an SVG `data:` URI generated in code — fixture media is never committed here,
and its rulers are what make a wrong transform visible by eye.

## The behavioural contract

Two suites, and the division is not by speed.

**`pnpm --filter @visionset/annotator test`** — 700 vitest cases over 30 files, and they
need no DOM because the engine cannot have one. It runs in **about four seconds**
(6.7 s wall including process startup, measured on an idle developer machine), which
is a property of the boundary rather than of the number of tests: there is no jsdom to
build, no setup file, no vitest config at all. The things that would end it are adding
a browser environment, adding jsdom, or adding a setup file — not adding more tests.
If that budget ever needs raising, say which of the three bought it.

**`pnpm --filter @visionset/app e2e`** — 37 Playwright scenarios against the demo page,
in one chromium. They exist for the half a unit test structurally cannot reach: whether
a browser delivers a real press to an element that still holds focus.

### What the port kept, and what it could not

v1 shipped four annotation specs, 825 lines. They are not transcribed, because more
than half of them describe things this build does not do.

| v1 spec | LOC | Disposition |
| --- | --- | --- |
| `polygon-tool.spec.ts` | 233 | **Ported**, all seven scenarios — one of them inverted, see below |
| `annotation-redesign.spec.ts` | 129 | **One of six ported.** The other five are v1's routing and chrome — a batch list, an `Annotate` link, a sidebar, an image picker, a back button. The demo has no router and no backend; those describe a product surface M5 builds, not a behaviour that moved |
| `polyline-tool.spec.ts` | 257 | **Out of scope.** `polyline` is a nameable `GeometryType` with no `Geometry` variant — `parseGeometry` refuses it as `UNSUPPORTED_GEOMETRY`, *declared with no implementation*. It becomes live the day a `PolylineGeometry` joins the union |
| `lane-export.spec.ts` | 206 | **Out of scope**, same reason, plus two lane-export formats that do not exist here |

The demo's fifth class, `centerline`, is that state made visible: it is declared
`polyline`, `toolFor` answers `select` for it, and a scenario asserts that activating it
draws nothing. That is the closest honest port of the polyline spec's premise.

### The one place the port asserts the opposite of v1

v1: *clicking a vertex and pressing Delete removes that vertex, and since 3 − 1 = 2 is
below the minimum, the whole triangle goes.* #44 answered the same question the other
way — `removePolygonVertex` returns `null` at `MIN_POLYGON_POINTS`, `deleteVertex` does
nothing, and the polygon survives. Destroying a shape somebody placed three clicks into
because they aimed at a vertex is a punishment for a typo, and `Delete` on the selection
is one key away. Two scenarios hold it: the refusal on a triangle, and the removal on a
quadrilateral — because a refusal with no working sibling is indistinguishable from a
dead code path.

### Two engine behaviours have no adapter path

Found by writing the port. `AnnotatorCanvas.handlePointerDown` answers **every**
non-primary press with a pan and returns before the machine is told, which is the
adapter honouring `state.ts`'s contract that a pan forwards nothing. The cost is that
two interaction-table rows are unreachable in a browser: the secondary press that
deletes a vertex (reachable instead through the toggle modifier, so the capability
survives — only v1's gesture for it does not), and the secondary press that takes back
the last placed polygon point, which has **no other spelling**. `adapter-gaps.spec.ts`
pins today's behaviour so a later change goes red and says what to update. Filed as
**#129**, which sets out the two defensible answers.

### The two render layers guard different halves

#47 fixed a bug where closing a polygon on its first vertex moved focus to `<body>` and
silently killed every shortcut, and put `pointer-events: none` on both `<g>` layers.
Measured while writing this suite: they are not redundant. Restoring the attribute on
`TransientLayer` alone reproduces the original bug exactly and fails **one** scenario —
the vertex pressed belongs to the polygon still being drawn. Restoring it on
`AnnotationLayer` alone leaves that one green and fails **five** others, every one of
which presses on a committed shape.

### No scenario waits on a clock

v1's specs are built on `waitForTimeout` between gestures, because nothing on its page
exposed a settled state. This demo publishes `counts` and `wire`, and React 19 flushes
discrete events synchronously, so every assertion is web-first or an `expect.poll`.
`tests/scripts/e2e_discipline.test.mjs` holds it. When a sleep looks necessary, the demo
has stopped exposing the state the scenario needs, and the fix is a `data-testid`.

### Running it

```
pnpm --filter @visionset/app e2e
```

The config starts its own server on **port 5273** — not vite's 5173, which the first run
of this suite found already held by an unrelated stack, and drove for twelve scenarios
before failing. It builds the annotator first, deliberately: the app resolves
`@visionset/annotator` through `dist/`, so an unbuilt engine is invisible rather than a
compile error. `reuseExistingServer` skips that rebuild locally — if the demo behaves
like an older build, kill the dev server you already had open.
