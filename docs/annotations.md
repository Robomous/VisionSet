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
| `delete` | delete the selected annotations | v1 |
| `backspace` | take back the last polygon point (while drawing; silent otherwise) | **#129** — v1 spelled it as a right-click |
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

**`pnpm --filter @visionset/app e2e`** — 42 Playwright scenarios against the demo page,
in one chromium. They exist for the half a unit test structurally cannot reach: whether
a browser delivers a real press to an element that still holds focus. Five of them are
`perf.spec.ts`, which counts work rather than asserting behaviour — see
[The performance benchmark](#the-performance-benchmark).

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

### Two engine behaviours have no adapter path, and #129 settled what to do

Found by writing the port. `AnnotatorCanvas.handlePointerDown` answers **every**
non-primary press with a pan and returns before the machine is told, which is the
adapter honouring `state.ts`'s contract that a pan forwards nothing. Two
interaction-table rows are therefore unreachable by that gesture in a browser.

**The pan stays.** The alternative — forward the press and pan only when the machine
did not consume it — loses twice. A conditional pan is unpredictable: right-drag
would pan on empty canvas and not over a vertex, so whether the gesture works
depends on where the vertices happen to be. And on macOS **ctrl-click *is* a
secondary press**, so routing it would make one ctrl-click raise both spellings of
the vertex delete — v1's own bug, which #44 closed deliberately and
`machine.test.ts` still guards.

What each capability costs then differs:

- The vertex delete costs **nothing**. The toggle modifier reaches the same call;
  only v1's gesture is gone.
- The polygon take-back had **no other spelling at all**, and `mod+z` cannot serve
  because a pending polygon is not in the command log. So it got one: **`Backspace`**
  now raises a `take-back-point` intent, which only `drawing-polygon` answers.

That freed a chord rather than inventing one: `delete` and `backspace` used to mean
the same thing, and the split is the conventional one — `Delete` removes a *thing*,
`Backspace` takes back the *last thing you did*. It costs a synonym and takes away
no capability. `adapter-gaps.spec.ts` still pins the pan; `keyboard.spec.ts` holds
the split and the take-back.

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
`tests/scripts/e2e_discipline.test.mjs` holds it, over `e2e/` **and** `bench/`. When a
sleep looks necessary, the demo has stopped exposing the state the scenario needs, and
the fix is a `data-testid`.

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

## The performance benchmark

M4's exit criterion ends "at 60fps with 200+ annotations", and until #49 nothing had
measured it. The answer is **yes, with roughly ten times the headroom for a drag** — and
one gesture, the zoom, that is O(annotations) by construction and is where the ceiling
will appear first.

### The scene

`?scene=bench` on the demo page. `src/demo/benchScene.ts` builds **200 bboxes and 20
polygons of 32 vertices — 220 annotations and 640 vertices — on a 3840x2160 asset**,
every coordinate from one seeded PRNG so the scene is identical on every machine. The
picture is a raster generated in a `<canvas>` at load and handed over as a blob URL: no
fixture media is committed here any more than in `tests/fixtures/media.py`, and a bitmap
is what a compositor actually has to re-rasterize when the stage zooms, which a vector
image understates.

The page is `BenchmarkHost`, not `AnnotatorDemo`, and the difference is one panel: the
demo's `<pre data-testid="wire">` runs `JSON.stringify` over every annotation on every
snapshot change, and a drag invalidates the snapshot on every pointer-move. That is the
host's debug surface, not the engine — so it is left out, and then *priced*, by a row
that puts it back (`?scene=bench&chrome=wire`).

### Two instruments, and neither replaces the other

| | asserted | runs | sees |
| --- | --- | --- | --- |
| `e2e/perf.spec.ts` | yes | every pull request | **DOM writes per gesture** — deterministic, hardware independent |
| `bench/annotator.bench.ts` | a loose floor only | `pnpm --filter @visionset/app bench`, and a manual CI dispatch | **frame times** — the 60fps claim, and how much headroom is left |

The split is #48's precedent — a wall-clock assertion on a shared runner fails for
reasons nobody chose — and the boundary between them was measured rather than assumed.
Three regressions were introduced deliberately and the drag scenario run against each:

| broken on purpose | the drag scenario | caught |
| --- | --- | --- |
| `memo(AnnotationLayer, () => false)` | 3 records, unchanged | no |
| `committed={snapshot.rendered}` | 3 records, unchanged | no |
| `skipId={null}` | 2 records | yes |
| the last two together | **80** records across the moves | yes |

The first two cost a re-render of 220 shapes on every pointer-move and write *nothing*,
because `paintDocument`'s output is unchanged and React's diff finds no work to do. So
the counter cannot see a wasted render, and does not claim to: its guarantee is that the
committed layer's **output** is constant through a gesture, which is the regression that
costs frames. The price of a render that changes nothing is a question for the clock.
The third is caught by the count going *down* — with nothing skipped the preview never
takes the shape over, so the removal never happens — which is why the total is asserted
with equality rather than as a ceiling.

### What is asserted every pull request

| claim | number |
| --- | --- |
| the committed layer is one `<g>` per annotation | 220 groups, 660 elements: 200 `rect`, 20 `polygon`, 220 `text` |
| a drag's moves cost the committed layer nothing | **0** mutations across the moves, at 4 moves and at 60 |
| …and the whole gesture is a constant | **3** records: removal, re-insertion, hover fill |
| a pan touches neither render layer | **0** and **0**; one style write per move on the stage `<div>` |
| one wheel notch rewrites every shape | **880** records — four attributes on each of 220 |
| drawing a box reaches the committed layer once | **1** |

The 880 is the finding, and it is a consequence of a rule worth keeping: every stroke
width, grip size and label size goes through `screenPx(…, zoom)` so that a 2-pixel stroke
is two *screen* pixels at every zoom (#41's tolerance finding, pointed at rendering). A
wheel notch changes `zoom`, so `AnnotationLayer`'s `memo` correctly fails to bail out and
the whole document is rewritten. Pan and drag are O(1) in the document; zoom is O(n).

### The recorded baseline

```
Darwin 25.6.0 x64 · Intel Core i9-9880H @ 2.30GHz · 16 threads · 32 GB
node 24.13.0 · chromium 151.0.7922.34 · production build via vite preview
frame budget 16.67 ms (60fps); a stall is an interval over 25.0 ms

scenario                                  n         cpu   frames   p50     p95     p99     max   stalls
pan                                     220        full      118  16.7    16.7    16.8    16.8        0
zoom (wheel)                            220        full      182  16.7    16.8    33.3   133.3        6
drag one box                            220        full      120  16.7    16.8    16.8    16.8        0
draw a box                              220        full      119  16.7    16.8    16.8    16.8        0
drag one box (control)                    1        full      118  16.7    16.7    16.8    16.8        0
drag one box + wire pane                220        full      118  16.7    16.7    16.8    16.8        0
drag one box                            220   4x slower      121  16.7    16.7    16.8    16.8        0
zoom (wheel)                            220   4x slower      261  16.7    16.8    33.4   150.0       12
drag one box                            220  10x slower      214  16.7    16.8    33.3    33.4        6
zoom (wheel)                            220  10x slower      313  16.7    83.4   100.1   133.4       64
drag one box                            220  20x slower      220  16.7    50.0    50.1    66.7       61
zoom (wheel)                            220  20x slower      268  16.7   200.0   216.7   250.1       92
```

`p50` and `p95` are stable run to run; the tail is not. `stalls` and `max` move by a
few between runs on the same machine — the unthrottled zoom row has been seen at 1 and
at 6 — so read them as an order of magnitude, and read the medians as the number.

**Acceptance criterion 1 is met**: pan and drag hold 60fps with 220 annotations on a 4K
asset, with no stalls at all.

The rows below `full` are why the table is worth reading. An unthrottled frame interval
is pinned to the display: it reports 16.7 ms whether the work uses a tenth of the budget
or all of it, so on its own it cannot distinguish a healthy build from one about to miss,
and a regression that halved the margin would leave every number identical. Throttling
the main thread turns that into something the same instrument can read:

- **a drag still holds 60fps at 10x slower** and breaks between 10x and 20x, so it has
  roughly an order of magnitude of headroom on this machine;
- **the zoom breaks between 4x and 10x** — the first gesture to go, exactly as the 880
  writes per notch predict. Filed as **#131**, which sets out the shape of a fix
  (`vector-effect="non-scaling-stroke"`, and grips drawn in an unscaled layer) and the
  reason not to reach for it yet.

An input-to-frame **latency** metric was built first and thrown away: with one input per
frame it measures where in the frame the input happened to land, and duly reported a p95
of 16.3 ms for every gesture including the one-annotation control.

### Running it

```
pnpm --filter @visionset/app bench     # about a minute, one worker, no retries
```

Three things about that command are deliberate and easy to get wrong:

- **it serves a production build.** `vite dev` runs React's development build and
  `StrictMode` double-invokes every render; numbers from there are two to five times
  pessimistic and describe a build nobody ships. `vite preview` fixes both.
- **it passes `--base /ui/` by hand.** `vite.config.ts` sets the base from `command`, and
  `vite preview` reports `command` as `"serve"` — so without it the preview server
  answers at `/` while the build has `/ui/assets/…` baked into its HTML, the SPA fallback
  returns **200 with `index.html`** for the missing script, and every scenario fails
  hunting for a canvas on a blank page. Nothing errors.
- **it never reuses an existing server**, on its own port 5373. The build is part of what
  is being measured.

And one trap inside the harness, since the same shape will be wanted again: **a CDP
session's `detach()` silently reverts `Emulation.setCPUThrottlingRate`.** An
8-million-iteration loop in the page took 14.8 ms at rest, **13.4 ms** after a
throttle-then-detach, and **292.4 ms** with the session held open. The first version of
the headroom rows detached, and reported beautiful numbers about nothing.

CI carries the benchmark only on `workflow_dispatch` (`annotator bench (chromium,
manual)`), which is what #49 asks for. Compare a dispatch against a dispatch — a shared
runner is not the machine above.

## The showcase

The demo page at `/` is the annotator's public showcase, and #50 is what made it one. It
is the same page the behavioural contract drives — the shape did not move — restyled onto
the repo-root `DESIGN.md` and given the two pieces of the annotation workspace that cost
nothing to bring forward.

### What is on it

| region | what it proves |
| --- | --- |
| the canvas | the three tools, the wheel and pinch zoom, pan, undo/redo, the whole keyboard |
| the floating tool strip | the tools *this schema* can reach, and the derived tool it currently is |
| the zoom readout | the stage's own scale, reported through `onViewChange` |
| Classes | the hotkey, the class colour and the geometry of every declared class |
| History | `undoLabel` / `redoLabel`, and buttons driving the same log the chords do |
| Tags | the classification tool, which is a panel and never the canvas |
| State + What would be saved | the document, and the exact `AnnotationCreate` payload a host would POST |

Every one of those is **outside** `@visionset/annotator`. The canvas takes a store, a
picture and an active class and gives back callbacks; it fetches nothing, routes nothing,
and owns no UI a product would want to restyle. That is the embeddable contract, and the
demo is the thing that keeps it honest — a control the package had to own would have to
be built here first and would not fit.

### A tool strip over a tool that does not exist

`core/interaction/tool.ts` is emphatic: the tool is **derived from the active class and
never stored**. v1 stored both and spent two mechanisms keeping them from disagreeing. So
the strip does not select a tool — it reports the derived one, and a press moves the
active class to one that derives the tool asked for. Two consequences, both deliberate:

- A press whose tool is **already active is a no-op.** The demo schema declares two bbox
  classes; with `pedestrian` held the box button is already lit, and re-pointing the class
  at `vehicle` would silently change what the next shape is labelled.
- The strip lists **one button per distinct drawable geometry**, built from
  `drawableGeometry`. A `classification_tag` and a `polyline` both answer `null`, and the
  demo schema declares both — so the two omissions are visible rather than theoretical.

### `onViewChange`, and the one place a default is a lie

The readout needed the stage's scale, and the adapter had no way to hand it over. The new
prop is read-only and it is called **on mount**, unlike `onAnnotationsChange` and
`onSelectionChange`, which deliberately are not.

The asymmetry is the point. A document is handed *in*, so a host already knows the initial
one. A viewport is not: the fit is computed in a `useLayoutEffect` against a pane rect only
the component can measure, so a host that was never told would have to display `1` — and
100% is the one number the fit is guaranteed not to be. `showcase.spec.ts` asserts the
readout against the measured scale for exactly that reason; with no jsdom in this
repository, a browser is the only place a mount-time call can be observed at all.

Zoom **controls** — a `−`/`+` pair driving the stage from outside — need an imperative
handle the adapter still does not publish. They land with the top bar that has somewhere to
put them (#56). Until then the readout reports and the wheel, the pinch and `mod+0` drive.

### The one deliberate departure from `DESIGN.md`

**The canvas well is dark.** Everything around the image follows the contract exactly —
white cards, `#d0d7de` borders, Robomous orange strictly as an accent, one type scale — but
the surround the picture sits in does not. A bright frame around a photograph shifts its
apparent contrast, which is why every image tool ships a dark mat. It is a mat and not a
second theme: the only interactive thing drawn on it is the tool strip, which is a `muted`
panel from the light palette.

`frontend/app/src/demo/theme.ts` holds the tokens and records that exception once, rather
than six components each making it. **#128 replaces that file** with `@visionset/ui-core`'s
real `tokens.css` — today a superseded placeholder whose dark surfaces and blue accent
contradict the contract. The components above it do not change when it does, because they
already name intents rather than colours.

The benchmark page keeps the old dark chrome on purpose. It is an instrument, #49's numbers
were recorded against it as it stands, and restyling it would change what its frame times
measure for no reason anybody asked for.


## The side panel

`@visionset/ui-core`'s `AnnotatorPanel` is the Objects/Labels column beside the
canvas. It is driven entirely by the `AnnotatorStore` the page already holds and
adds no second door to the document: every write is a command that already existed,
and the selection is one `Selection` seen twice rather than two kept in step.

**Hiding is a view decision.** The core document has no `hidden` flag and must not
grow one — hiding is per viewer and per session, and a field would travel to the API
and change a release hash. `AnnotatorCanvas` takes a `hiddenIds` prop instead, and
filters both what it draws **and** the document the machine hit tests against,
because a shape you cannot see must not swallow a press. `withoutHidden` returns the
*same object* when nothing is hidden, which is what keeps the committed layer's
`memo` bailing out during a drag.

Hold that set in state. A freshly allocated `Set` on every render defeats the memo
before it is consulted — #49's `skipId` finding, one prop over.


## The annotation page

`@visionset/ui-core`'s `AnnotationPage` is the browser's whole annotation surface,
and three of its decisions are worth knowing before changing it:

- **The schema is the batch's pinned version**, fetched by number. The project's
  active schema is a different question with often a different answer.
- **The navigator is the batch's asset listing filtered to the job**, not
  `next_pending_assets` — that route hands out *pending* assets, so it shrinks as
  the work is done and cannot go back.
- **There is no autosave.** A save is a diff followed by a refetch (the kernel mints
  its own ids), so a timer would rebuild the document mid-gesture. Explicit Save,
  save-on-navigate, and a `beforeunload` guard.

Zoom controls reach `AnnotatorCanvas`'s `viewRef` handle, whose `fit()` is the same
implementation `mod+0` runs — one behaviour, two doors, which is why the chord is
still intercepted by the adapter rather than forwarded.
