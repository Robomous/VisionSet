# Annotations

An annotation labels an asset with a class, a geometry, and the attribute values required by
that class. A batch pins the schema version so the contract cannot change, while a job assigns
the assets to be labeled. `AnnotationService` brings those constraints together and is the
**only** way to create an `Annotation`.

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
| `DisallowedGeometry` | The geometry is not one that class accepts. |
| `MissingRequiredAttribute` | A `required` attribute has no value. A `default` is *not* filled in. |
| `UnknownAttribute` | The annotation carries an attribute the class does not declare. |
| `InvalidAttributeValue` | Wrong type for the kind, or outside a `select`'s options. |
| `DuplicateClassificationTag` | A second whole-asset tag of a class the asset already carries — see below. |

All six share `InvalidAnnotation`, so a delivery surface answers 422 without enumerating
them. Catching the base is safe here in a way catching `DestructiveSchemaChange` is not: no
flag overrides any of these, so there is nothing to retry into a loop. The remedy is to fix
the annotation, or to write a schema version that describes it.

The geometry rule is **per class**, not per version: a `LabelClass` declares a set of
`geometries` and this is membership in *that* set. `SchemaService.allowed_geometries` is the
union across a version's classes - the right answer to "what may this project draw?" and the
wrong tool here, where it would let a polygon through under a boxes-only class.

A class accepting more than one shape is ordinary, not a corner case: the same sign is worth
boxing at a distance and worth outlining close up, and it is one class either way. Which shape
a given label carries is the annotation's own business. See [schemas.md](schemas.md).

## The version is the batch's, not the project's

```python
schemas.create_version(project.id, [...])  # the project is now on version 2
annotations.add(job.id, [...])  # still judged by version 1
```

Work is judged against `Batch.schema_version`, pinned at approval and moved only by an explicit
`repin` ([batches.md](batches.md)). That is the
whole point of pinning: a schema that evolved mid-batch would change the rules under work
already in flight. See [batches.md](batches.md).

The service **stamps** that version onto what it stores, the way it lets `id` generate itself:
whatever the caller put in `schema_version` is replaced, because the pin is a fact about the
batch rather than an opinion of the writer. `update` does the same with `asset_id` - the stored
one wins, because moving a label from one asset to another is a delete and an add, not an edit.

`Annotation.schema_version` is still a required field with `ge=1`, so a caller has to write
*some* number there and it may as well be `1`. The model cannot default it: an `Annotation`
does not know which batch it is about to be written into, which is the same reason the model
cannot validate the class, the geometry or the attributes either.

## Every call is all-or-nothing

`add`, `update` and `delete` each take a sequence and run in one transaction. A payload with
one bad box stores nothing at all: a half-labeled asset is not a state a caller can reach.

Which is also why each publishes exactly one [`AnnotationsWritten`](events.md) after the commit,
naming its operation - one per call, not one per box, because the call is the thing that
happened.

## Attributes are keyed by exact name

```python
attributes = {"occluded": False, "weather": "wet"}
```

The keys are `Attribute.name` exactly - which is why that field is stored stripped: a trailing
space would be a second attribute nobody can see. The same exact-name matching the change
classifier uses, for the same reason (see [schemas.md](schemas.md)).

Whether a value is acceptable is `Attribute.rejects`, the one method that answers it, and the
same one an attribute's own `default` is checked against. A value and a default can never be
held to different standards.

## Whole-asset tags carry no coordinates, and there is at most one per class

A ``classification_tag`` class produces an annotation whose geometry has **zero
fields**. It says something about the asset, not about a place in it - "this frame is
at night" - so it has nothing to move, nothing to resize and no vertices.

That is also why **an asset carries at most one tag of a given class**. Two boxes
under one class are two facts, because each carries its own coordinates; two tags of
one class are the *same statement made twice*. Since #121 the kernel enforces it:

- a **partial unique index** on `(asset_id, label_class)`, restricted to tag
  geometry, so the second one cannot be stored;
- `AnnotationService.add` and `.update` refuse first, with
  `DuplicateClassificationTag` — the sixth `InvalidAnnotation` refusal in the table
  above — so a caller meets a sentence and an `index` rather than a raw constraint
  failure;
- the check runs **within a call** as well as against the store, because `add` is
  all-or-nothing and the index would otherwise refuse at commit time, where the
  position at fault cannot be reconstructed.

It sits in the `InvalidAnnotation` family even though it is the only one of the six
that reads the store, because the *remedy* is the family's: fix the annotation. There
is no flag that overrides it and no state to change first - the tag is already there.
The status is **422 and not 409** for the same reason: 409 means "change the state
and resubmit", and deleting the existing tag to add an identical one is not a remedy
anybody wants.

`AnnotationService.update` may still *move* a tag to another class, and a no-op
update of a tag is not a duplicate - the row being replaced leaves the comparison
before its replacement is judged.

**A migration collapsed the duplicates workspaces already carried**, because they were
legal before the index existed and refusing to open would have left an owner with a
remedy they cannot apply: this product ships no SQL console. It survives only as
history — the whole pre-release chain was collapsed into the baseline, so
`uq_annotation_asset_classification` is declared in `_tables.py` and a fresh database
is created with it. The rule it applied is worth keeping on record: the survivor was
the lexicographically smallest `id`, an arbitrary tie-break by construction — the rows
are one statement — chosen for being deterministic, so two machines migrating the same
copy of a workspace agreed. It could discard a differing `attributes` map on the losing
row, which was stated rather than hidden. See
[persistence.md](persistence.md#migrations-and-format_version).

The annotator's own rule (`core/interaction/tags.ts`) is unchanged and is now a
mirror rather than a compensation: `tagCommand` on an already-tagged class returns a
command that changes nothing, so a second tag is never *requested*, and `untagCommand`
still removes every tag of the class.

## Provenance is the model's own rule, not the service's

There is no `InvalidProvenance`. `provenance="model"` requiring a `model_ref`, and `confidence`
inside `[0, 1]`, are validators on `Annotation` itself. An annotation that breaks either cannot
be constructed, so it never reaches a service to be reported. That is the division
[schemas.md](schemas.md) already draws: per-value validity is pydantic's, validity that needs
another object is the service's.

An annotation accepted from the editor's suggest tool is written this way and no other: an
ordinary `add` carrying `provenance="model"`, the `model_ref` the suggestion named, and its
`confidence`. There is no separate route for it, no relaxed validation, and no link back to the
connection - the model's identity is **copied** at write time, so deleting the connection later
leaves the record intact. The gesture is in [ui.md](ui.md); what it proposes is in
[inference.md](inference.md).

## `delete` has no `confirm=`

The one exception to the rule in [projects.md](projects.md) and [batches.md](batches.md).
Deleting a box is the ordinary annotator edit loop - draw it, look at it, take it off again -
not the destruction of a lifecycle entity the way deleting a project or a batch is. The
lifecycle gates are the guard instead: once the work closes - the batch, or just this job -
nothing here can touch it at all.

## Progress follows the annotations - two edges of it

| Current | Has annotations | Becomes |
| --- | --- | --- |
| `unannotated` | yes | `annotated` |
| `annotated` | no | `unannotated` |
| anything else | either | *unchanged* |

`skipped`, `review_pending` and `accepted` are people's decisions, not consequences of a row
existing, so annotations never move them. `JobService.mark` is the door for a decision; see
[jobs.md](jobs.md).

The rule is `progress_after_annotating` in `kernel/domain/task.py` - pure, so a test can sweep
it against `ASSET_PROGRESS_TRANSITIONS` rather than against prose - and `AnnotationService`
applies it inside its own transaction, so labels and progress commit together. It never calls
`JobService.mark`, which would open a second session and write from it while the first is
still open.

## Work only happens inside an open batch, and inside an open job

Every write requires the job's batch to be `in_annotation`, else `BatchNotInAnnotation`, **and
the job itself to be open** - `OPEN_JOB_STATES`, else `JobFinished` - the same two errors
`JobService` raises, reached through the same three lookups (`require_job`,
`require_open_batch`, `require_open_job`) rather than a second copy of the ladder.

The second gate is not implied by the first and arrived last, in #439. `JobService.complete`
does not complete the batch, so a finished job ordinarily sits inside one that is still
`in_annotation`: the batch gate had nothing to say, and a job whose work was over went on
accepting labels. See [jobs.md](jobs.md) for the set and the reasoning.

The gates fire **before** the payload is looked at. A write into closed work is a bug whether
or not the annotation is also wrong, and hearing about it only sometimes would hide it.

Reads are not gated: `get` and `for_asset` work long after the batch closed or the job
finished, because a label outlives the work that produced it.

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
response. `asset_id` is likewise absent from `AnnotationUpdate` - the stored one wins.

**A refusal that is about one item carries `detail.index`**, the position in the array the
client sent. Nothing was written, and `LABEL_CLASS_NOT_IN_SCHEMA` on its own cannot say which
of forty boxes meant it. That index is `VisionSetError.index`, set by this service on the way
out of its per-item loop and published by the API - it is a fact about the call, so it lives in
the kernel rather than being reconstructed at the boundary.

The wire models re-spell the geometries rather than publishing the domain's, and each request
body converts through `to_domain()` inside a **parsing-time validator**. That is not decoration:
`provenance='model'` with no `model_ref`, a confidence outside [0, 1] and a zero-area box are
refused by pydantic, and a `ValidationError` raised from a route body is neither a
`VisionSetError` nor a `RequestValidationError` - without the validator it reaches the catch-all
handler and answers **500** to a plainly malformed payload.

## In the editor

`@visionset/annotator` mirrors this contract in TypeScript, and mirrors it **exactly**:
`snake_case` fields, geometry nested under its own key, points as `[x, y]` pairs. There is no
mapping layer, deliberately - a second spelling of twenty fields is free to drift, and a host
would pay the conversion whoever wrote it. What comes back from
`GET /jobs/{id}/assets/{asset_id}/annotations` is what the editor takes; what the editor emits is
what `POST`/`PATCH` accept.

The annotator cannot read the pydantic models, and it must not depend on `@visionset/ui-core` to
reach the generated client - that package carries `openapi-fetch`, and the editor's contract is
"no HTTP, no fetching". So the contract travels as bytes, the way `openapi.json` already does.
`tests/fixtures/wire_annotations.json` is written by `scripts/export_wire_fixtures.py` from
`AnnotationOut` itself, and two independent gates hold it in place: a pytest one keeps the file
matching the application, and a vitest one keeps the TypeScript parsing the file. The frontend CI
job installs no Python and reads only what is committed. Regenerate with:

```
uv run python scripts/export_wire_fixtures.py
```

**Two vocabularies, one union - and the editor keeps both.** `GeometryType` names eight
geometries because that is what a `LabelClass` declares (see [schemas](schemas.md)); `Geometry`
has four variants because that is what an annotation can carry. So `parseGeometry` tells a
`mask` apart from a typo: the first is a declared geometry with no model, refused in the
kernel's own words (`UNSUPPORTED_GEOMETRY`), and the remedy is to wait for a variant rather than
to fix the caller. `polyline` was the example here until #223 shipped its variant and #342 its
tool - the remedy
arriving, which is exactly what the split predicted would happen.

The parser is strict about unknown keys as well as missing ones. That is not fussiness: the editor
hands back what it was given, so a key it silently dropped would be a field the kernel wrote and
the editor erased. It does **not** re-check bounds - a zero-area box and a two-point polygon are
refused above, by the models that own the rule, and a second copy would drift.

## Keys are bound in one place, and the table is data

v1 delivered its whole keyboard with one line - `document.addEventListener("keydown", onKey)` -
over a 210-line `if`/`else` chain, and its polygon confirm button talked to that chain by calling
`document.dispatchEvent(new KeyboardEvent("keydown", …))`. `frontend/annotator/src/core/input/`
replaces both. A chord resolves to an **action**, which is plain data; `runAction` is the only
thing that turns one into a store call.

| chord | action | lineage |
| --- | --- | --- |
| `escape` | cancel whatever is in flight | v1 |
| `enter` | commit whatever is in flight (closes a polygon at ≥3 points) | v1 |
| `delete` | delete the selected annotations | v1 |
| `backspace` | take back the last polygon point (while drawing; silent otherwise) | **#129** - v1 spelled it as a right-click |
| `mod+z` | undo | **new** - v1 has no undo at all |
| `mod+shift+z` | redo | **new** |
| `mod+a` | select all | **new** |
| `mod+c` | copy the selection to the annotator's clipboard | v1 |
| `mod+v` | paste it onto this frame, offset and selected | v1 |
| `mod+0` | ask the host to zoom to 100% | v1 |
| `?` | ask the host for the shortcut sheet | v1 |
| `h` | turn the hand on or off - with it on, any drag pans | **#576** |
| `v` | select mode - no active class | v1 |
| `1`-`9` | the schema's first nine classes, in authored order | **new** |

The three-part fold - defaults, then `classHotkeys(schema)`, then a host's overrides - is
**`defaultRegistry(schema, overrides)`**, exported so the adapter that resolves a keystroke and
the product's shortcut sheet read the same map (#189). A sheet that spelled the fold itself would
be free to drift, which is what v1's hand-written `HelpModal.tsx` did by construction.

`mod` is ctrl **or** meta, folded once, so one table serves both platforms. A class hotkey on a
`classification_tag` class toggles the tag rather than making the class active - pressing it twice
undoes it - and on any other class it sets the active class, emitting a tool change only when the
*derived tool* actually moved. A digit naming a class the schema no longer declares refuses and
does nothing, which is the same posture `tagCommand` takes: a binding outlives the class it names,
and losing a keystroke is better than losing the session.

Not bound, each for a reason: `b`/`p`/`k`/`l`, because the tool is derived from the class here, so
a tool key *is* a class key; and the lane-attribute hotkeys, because attributes belong to a panel.
**`Space` is not here either**, and that one is structural rather than a choice: it is the hand's
transient spelling, held rather than pressed, and a `Keystroke` has no shape for a release. A row
here could turn the hand on and never off again. It is an adapter substitution instead, the class
`enter` and `escape` already belong to.

### Copy and paste, and where a clipboard lives

`mod+c`/`mod+v` were the fourth entry on that list until #123 settled the four questions that
had to be answered before they could be claimed. All four live in
`core/interaction/clipboard.ts`.

**A clipboard is not the store's.** There is one `AnnotatorStore` per open asset - the annotation
page makes that structural, remounting its workspace per frame so `mod+z` cannot walk into the
previous picture's edits - so a clipboard inside one would die on every navigation. It is a
session object instead: an interface and a five-line holder in `core/`, held by whoever outlives
the asset. The annotation page holds one per **job**, which is what makes *copy the car on frame
12, paste it on frame 13* work. `AnnotatorCanvas` makes its own when a host supplies none, so
in-frame duplication needs no wiring at all.

**It is never the system clipboard.** `navigator.clipboard` is a DOM global `core/` may not name,
is asynchronous where a keystroke is not, and is permission-gated - but the deciding reason is
smaller: what is copied is a geometry in *this asset's* pixel frame, meaningless to any other
application and silently wrong if pasted into one.

**A paste re-mints.** Fresh id per annotation, `asset_id` and `schema_version` read off the
document being pasted *into*, `provenance: "human"` whatever the source was, and `job_id` /
`model_ref` / `confidence` left null - the fields a service stamps. It is deliberately not
`draftAnnotation`: that seeds the class's declared *defaults*, which is right for a shape somebody
just drew and wrong for a copy, whose point is that it carries what the original carried.

**The offset is 20 screen pixels**, v1's number, divided by the zoom in `tolerance.ts` - the one
module in `core/` allowed to name one. A fixed asset-pixel offset would be invisible at a fitted
zoom on a large frame and throw the copy half a pane away at 8×; "visibly distinct and grabbable"
is a fact about a screen. Pasting onto a **smaller** frame clamps the way a drag into the edge
does: the shape shifts as far as it can, keeps its size, and one wider than the frame pins at 0
rather than deforming.

**A second paste steps further out.** The rule is stated in terms of the document rather than a
counter - offset by one delta; if that lands on an annotation this document already carries with
the same class and the same geometry, offset again - so an undo frees the slot it took and a
paste onto a fresh frame starts at one delta. Against the asset's edge the search runs out of
room and copies do stack there.

**Pasting a tag the asset already carries does nothing**, the way `tagCommand` makes a second tag
unrepresentable rather than refusing one. The kernel refuses a duplicate outright now
(`DUPLICATE_CLASSIFICATION_TAG`), which makes the local rule matter more: without it a paste would
look like it worked and the whole save would refuse later, blaming an index.

Copy is a **read** and runs in read-only mode - carrying a box out of a batch that can no longer
be edited is how a correction starts. Paste is a write and is refused there by the engine itself.
Inside a text field both chords are the browser's, because the adapter checks `isTextEntry` before
it runs anything.

**Remapping is a fold.** `registryOf([...DEFAULT_BINDINGS, ...classHotkeys(schema), ...overrides])`
 - last wins, and an override with a `null` action unbinds a chord. Nothing throws on a duplicate,
because the fold *is* the remap.

**Nothing here is scoped by a global listener, and it could not be.** `src/core/` cannot name
`document`, so an adapter attaches `onKeyDown` to the annotator's own focusable root; scoping is
subtree bubbling, with no listener lifecycle at all. Two booleans do different jobs and should not
be merged: `resolve(...) !== null` answers *is this keystroke ours*, which is what decides
`preventDefault`, and `runAction(...).changed` answers *did it do anything*. The rest of what an
adapter owes - the text-entry guard, Escape surviving it, IME filtering, the `code`-for-digits
seam on layouts where the digit row is shifted - is listed in `core/input/index.ts`.

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
state the canvas draws. There is deliberately no `asset` or `schema` prop either - an
`AnnotationDocument` already carries both, and a second copy is a second spelling free to drift.
What the document does not carry is the pixels, which is precisely what `imageSrc` is for.

**The image is laid out at the descriptor's width and height, never at its own `naturalWidth`.**
That is [`get_asset_image`](mcp.md)'s finding one layer out: the descriptor is the frame the
coordinates live in, and a picture whose natural size disagrees is a preview. Hand one in and
every annotation is individually plausible and uniformly wrong.

### Who owns the transform

The adapter, entirely. `geometry/tolerance.ts` is the only module inside `src/core/` allowed to
name a zoom, so the screen↔image transform lives in `adapters/viewport.ts` - pure arithmetic, no
DOM, no React, and therefore unit-tested without a browser:

```
screenToImage(v, x, y) = [ (x - v.panX) / v.zoom, (y - v.panY) / v.zoom ]
```

The `<svg>` is laid out at the asset's native size inside one wrapper carrying
`translate(pan) scale(zoom)`, so **an SVG user unit is an asset pixel** and nothing in the paint
path converts anything. The corollary is the trap: a 2-pixel stroke written as `2` is two *asset*
pixels - a hair at 8× and a slab at 10% - so every thickness, radius and font size goes through
`screenPx(px, zoom)`. It is #41's tolerance finding pointed at drawing instead of at hit-testing.

`mod+0` refits, and it is intercepted by the adapter rather than forwarded, because the zoom is
the adapter's - it is the one row of the `InputHost` port that is not a pass-through.

### One input model, and most of it is a wheel branch two lines long

A pan used to have exactly one spelling, a middle- or secondary-button drag. A trackpad has no
second button, a pen has none, and a finger has none - so on a laptop there was no gesture that
moved the picture at all, while the gesture people actually make, a two-finger scroll, zoomed.

The whole of that fix is which side of one branch a wheel event falls on:

| The event | What it means |
| --- | --- |
| `ctrlKey` or `metaKey` held | zoom, anchored at the cursor |
| bare, and shaped like a wheel notch | zoom, anchored at the cursor |
| bare, anything else | pan, both axes |

The first row serves four devices, because **`ctrlKey` on a wheel event is how a browser reports a
trackpad pinch** - on macOS and on a Windows precision touchpad alike, with no gesture API
involved - and `Ctrl`/`Cmd`+wheel is the convention for zooming with a mouse. The two arrive
identically, so they are answered identically.

**A bare event is answered by device, and that is the second question.** The two devices want
opposite things from the same event: a two-finger scroll is how anybody moves around a canvas, and
a wheel notch is how anybody zooms. #576 gave the whole event to the trackpad - which is what made
a trackpad workable rather than a nicety on top, and which took the mouse's zoom away with it. The
device test gives the notch back and leaves the scroll alone.

`isMouseWheel` is that test, and it is the only heuristic in the navigation model, because **no
browser says which device sent a wheel event**. It reads three signals and none of them is
`deltaY`, which the operating system accelerates and which overlaps completely between the two:

- a `deltaMode` other than pixels is a discrete wheel, and nothing else reports lines or pages -
  this is Firefox's mouse;
- anything sideways is a scroll, because a wheel has one axis;
- otherwise a whole number of `wheelDelta` notches. Chrome quantises a discrete wheel to units of
  120 however much it accelerated `deltaY`, and computes a precise device's as `-3 * deltaY`,
  which lands on a multiple of 120 only when the scroll happened to travel an exact multiple of
  40 pixels.

**Every uncertain case answers "trackpad".** A trackpad that zooms when it was asked to scroll is
the failure #576 fixed, while a mouse this declines - a Magic Mouse reports as a precise device -
still zooms with the modifier, with the widget's `-`/`+`, and with `mod+0` to refit. The cost of
being wrong is one stray notch inside a hard flick, never a device with no gesture at all.

### The class of device no single event can name, and how the tie is broken

There is one whole class it declines permanently rather than at the margin, and the cost there is
not a stray notch: it is a mouse with no zoom. A **high-resolution wheel** - every Logitech MX
Master, Microsoft's wheels, and a growing share of everything else - reports a *fraction* of a
detent per event instead of a whole one. No multiple of 120 ever arrives, so the third signal has
no case that ever fires, and the wheel pans forever.

The tempting fix is a fourth signal on the event, and there is no such signal. Linux's own
specification for the axis these devices report on declines to bound the fraction - *"the API does
not specify the smallest fraction a wheel supports"* - and an accumulated value need not align
with a multiple of 120 either. A trackpad reports fractions of the same size, over the same axis,
in the same `deltaMode`. **At the level a single wheel event describes them, the two are the same
event.**

So the model stops interrogating the event and asks which device is on the desk. **It assumes a
mouse and makes the trackpad prove itself**, on the one thing no wheel can fake: **travel on both
axes at once**. `isPreciseDevice` is that evidence, and the "at once" is the whole rule. A vertical
wheel reports `deltaX === 0` always; a horizontal one - a tilt wheel, or the thumb wheel every MX
Master carries as `REL_HWHEEL` - reports `deltaY === 0` always. Each is one axis at a time, because
each is one physical wheel. Two fingers are not, and a drifting gesture puts a component on both
axes in the same event. Reading `deltaX` alone would condemn a mouse for a nudge of its own thumb
wheel, and take its zoom away for good.

Asked of one event the evidence is weak - a trackpad's individual event may well be dead vertical -
but it only ever points one way, so seeing it once is conclusive and never seeing it is what a
mouse looks like.

**The burden of proof sits this way round because the two mistakes are not the same size.** Guess
"mouse" wrongly and a trackpad zooms for the one gesture it takes to drift, after which it is
right forever. Guess "trackpad" wrongly and a mouse *never zooms at all*, because a wheel emits no
evidence that could ever overturn the guess - that is the defect being fixed here, and it is
unbounded. A recoverable error beats an unrecoverable one, so the recoverable one is taken.

The sighting is written down rather than re-derived: the canvas reports it through
`onPreciseDevice`, and the host stores it at `visionset.prefs.annotator.precise-device` - this
browser, not the workspace, because it describes the hardware on the desk. A trackpad therefore
spends at most one gesture zooming, once, ever.

`isMouseWheel` is asked **first** and outranks the sighting, which is what serves a laptop carrying
both: once its trackpad has been seen, an external mouse reporting whole notches still zooms. A
*high-resolution* mouse beside a trackpad is the one arrangement nothing here separates, because
that is precisely the case where the two devices send the same event.

There is deliberately **no setting**. An earlier draft of this carried one - a three-way control on
the zoom widget - and it was surface for a case the inference already covers: it existed only while
the default was wrong.

What `ctrlKey` can no longer do is tell a pinch from a mouse wheel, since it is now set by both.
`wheelZoomFactor` tells them apart by **magnitude** instead: a notch is a large quantised value -
120 pixels, three lines, one page - and a pinch is a stream of small continuous ones, so a
threshold at 40 sits in a gap rather than in a distribution. Being wrong about it costs a gesture
that zooms too briskly, never a wrong answer. The softness on the wheel side is derived rather
than picked: `120 / ln(1.25)` is about 538, which makes one notch worth exactly one press of the
`+` button.

**The split is asked only where the question is real.** It exists because a held `ctrl`/`cmd`
makes a pinch and a wheel arrive identically, and size is then all that is left. A *bare* event is
never in that position - it reaches a zoom at all only once the device has been judged a mouse -
so `wheelZoomFactor` takes `mayBePinch` and the bare path passes `false`. Putting a bare event
through the split anyway was a measured defect rather than a tidiness one: a high-resolution wheel
sends 6-13 pixel fractions of a detent, every one lands under the 40px threshold, and the whole
gesture is zoomed on the pinch curve. Measured in a browser at a softness of **103** where 538 was
intended - **5.4x** the designed rate, which is what it felt like.

The rest of the model is more spellings of the same two verbs.

- **`Space` held** is the hand for as long as it is down. It cannot be a registry row - a
  keystroke is a press and this is a hold - so it is an adapter substitution, and it is cleared on
  blur as well as on keyup, because its release lands in whatever took the focus and never here.
- **The hand tool**, `h`, is the persistent one. Not a fifth `Tool`: `tool.ts` derives the tool
  from the active class and stores nothing, so the mode is the host's and arrives as `panTool`,
  which is the arrangement the suggest tool already established. **While it is on, the canvas
  offers nothing else**: `pointing` is `hover` with the hand spent on it, and both readers of a
  hover - the affordance and the drawing guides - go through it, so no grip lights up and no
  crosshair is drawn. That is not tidiness. `handlePointerDown` answers the next press with a pan
  before the machine or the suggest branch hears it, so a lit grip and a crosshair are offers
  that press cannot keep. Applying the mode to the *cursor* alone, which is where it started,
  made it a cursor rather than a mode - and left two render sites to remember it at, which is two
  more than a mode should have.
- **Two touch pointers** are a gesture whatever tool is armed. `pinchBetween` answers a scale
  about a travelling centroid - one gesture and not two, because a pinch that also drifts is one
  thing and answering it as a zoom followed by a pan makes the picture jump between them. The
  gesture outlives its two contacts and is cleared when the **last** finger lifts, which is what
  stops the survivor of every pinch from being promoted into a drag nobody asked for.

**The non-primary pan is untouched and still unconditional**, for the reason argued below: a
conditional pan is unpredictable, and on macOS ctrl-click *is* a secondary press. The hand is a
second branch beside it, taken on a primary press, and it sits **before** the read-only select -
somebody navigating a batch they may not edit is who most needs to pan.

All of the arithmetic is in `adapters/viewport.ts` beside the transform, so it is unit-tested
without a browser: `normalizedWheel` folds `deltaMode`, `wheelZoomFactor` carries the softness
split, `isMouseWheel` answers the device, `pinchBetween` answers the two-finger case, and
`zoomAbout` and `panBy` were already there. `AnnotatorCanvas` holds only the branches. What no unit
test can reach - that a browser really delivers these events - is `e2e/touch.spec.ts` and the wheel
scenarios, which drive Chromium's own input rather than constructing events.

That division is load-bearing for the device test in particular, because a browser suite can only
reach half of it: **CDP's synthetic wheel reports `wheelDeltaY` as ±120 whatever `deltaY` says** -
measured, 7 and 12 and 40 all arrive as -120 - so Playwright can spell a mouse notch and a sideways
scroll, and has no spelling at all for a trackpad's vertical one. The unit tests are what cover the
rest, and `demo.spec.ts` says so where a reader would otherwise go looking.

### Dragging repaints one layer

`AnnotatorStore.stage` leaves the committed document untouched and moves only the preview, which
is what lets the committed annotation layer sit still through a whole gesture: it is `memo`'d on
`(document, selection, skipId, hotId, zoom)`, and none of those move while the pointer does.
`skipId` is a `string | null` and `hotId` is a `string` for that reason - a freshly allocated
`Set`, or the `Affordance.hot` target object, would be a new prop on every pointer-move and would
defeat the bail-out before `memo` was consulted.

Measured on the demo page with twelve boxes, dragging one across thirty pointer-moves: **1 DOM
mutation in the committed layer and 601 in the transient layer**, plus one more in the committed
layer on release. The committed layer mutates twice per gesture - once when the dragged shape
leaves it, once when it comes back - and not at all in between.

React Compiler is installed nowhere in this repository, and the annotator ships as `tsc` output
that a compiler pass in a consuming app could never reach, so those `memo`/`useMemo` calls are
load-bearing rather than decoration.

### Nothing drawn is a hit target, and that is not a style choice

`resolveTarget` is the only hit test, and nothing between the input surface and the pixels can be
pressed. Without that rule the entire keyboard silently stops working after a polygon is closed by
clicking its first vertex - the shape is the press's hit target, React 19 flushes discrete events
synchronously so the commit removes it *during* the event, and the browser's own focus fixup for
the `mousedown` then resolves a detached node, finds nothing, and moves focus to `<body>`. No
error is reported anywhere.

v1 could not have had this fix: its shapes carried the pointer handlers, so they had to be hit
targets. A headless hit test is what makes an inert render layer possible in the first place.

### The input surface is the pane, not the picture

The pointer handlers used to sit on the `<svg>`, which is laid out at `asset.width ×
asset.height` — so the `<svg>` *was* the image rectangle and the hit-testable region was exactly
the asset. Everything around the picture was dead (#186): a grip on the boundary could not be
grabbed, a shape could not be selected by the part of it that overhangs, and a press on the
surround did not clear the selection the way a press on empty canvas does.

That was never a geometry problem. `screenToImage` has no clamp, `resolveTarget` works at negative
coordinates, and the conversion already read the **pane's** rect - so moving the handlers up one
element changed no arithmetic at all. The pane also spans the whole viewport and is a `<div>` no
commit detaches, which makes it a strictly safer host for the focus rule than the `<svg>` was.

The `<svg>`'s *geometry* is deliberately unchanged: `e2e/_frame.ts` reads its `boundingBox()` as
the asset rect on screen, folding in the zoom, the pan, the pane rect and the body margin in one
measurement, and every scenario in the suite converts coordinates through it.

**Which declaration keeps a shape from being a hit target was measured, and it is not the obvious
one.** `pointer-events` is inherited, so the topmost inert element under the pane decides for
everything below - the **transform wrapper**. Against `e2e/surround.spec.ts`: removing the
wrapper's `none` fails the scenario; removing the `<svg>`'s alone changes nothing; removing
`AnnotationLayer`'s changes nothing either, although that same removal reproduced the focus bug
back when the `<svg>` was the live surface. The redundant declarations stay as defence in depth,
but only one of them is load-bearing today.

### Running the demo

```
pnpm --filter @visionset/annotator build && pnpm --filter @visionset/app dev
```

The annotator builds first, deliberately: the app resolves `@visionset/annotator` through its
`dist/`, so an unbuilt change is simply invisible in the browser rather than a compile error.
The sample image is an SVG `data:` URI generated in code - fixture media is never committed here,
and its rulers are what make a wrong transform visible by eye.

## The behavioural contract

Two suites, and the division is not by speed.

**`pnpm --filter @visionset/annotator test`** — over nine hundred vitest cases across
thirty-odd files, and they need no DOM because the engine cannot have one. The suite
itself runs in **well under a second**, which is a property of the boundary rather than
of the number of tests: there is no jsdom to build, no setup file, no vitest config at
all. The things that would end that are adding a browser environment, adding jsdom, or
adding a setup file — not adding more tests. If the budget ever needs raising, say which
of the three bought it.

**`pnpm --filter @visionset/app e2e`** — a couple of hundred Playwright scenarios in one
chromium, over the demo page and over the product against a stubbed API. They exist for
the half a unit test structurally cannot reach: whether a browser delivers a real press
to an element that still holds focus, and how a layout behaves when jsdom reports every
element as 0×0. `perf.spec.ts` is the handful that counts work rather than asserting
behaviour — see [The performance benchmark](#the-performance-benchmark).

### What the port kept, and what it could not

v1 shipped four annotation specs, 825 lines. They are not transcribed, because more
than half of them describe things this build does not do.

| v1 spec | LOC | Disposition |
| --- | --- | --- |
| `polygon-tool.spec.ts` | 233 | **Ported**, all seven scenarios - one of them inverted, see below |
| `annotation-redesign.spec.ts` | 129 | **One of six ported.** The other five are v1's routing and chrome - a batch list, an `Annotate` link, a sidebar, an image picker, a back button. The demo has no router and no backend; those describe a product surface M5 builds, not a behaviour that moved |
| `polyline-tool.spec.ts` | 257 | **Ported by #342**, as `e2e/polyline.spec.ts`. It was out of scope at #48 because `polyline` had no `Geometry` variant, and out of scope again after #223 for a narrower reason - it drives a *drawing tool*, and there was none. #342 shipped the tool. Six of its seven scenarios port; the seventh asserts a floating point-count bar this product does not have, and the point count lives on the Annotations panel |
| `lane-export.spec.ts` | 206 | **Superseded rather than ported.** #223 landed the lane formats as `visionset.formats` plugins, and they are tested where the other exporters are: `tests/formats/test_lanes.py` ports v1's 53 unit tests, and `test_report_agreement.py` checks each one's report against the bytes it wrote. v1's spec drove per-item HTTP export endpoints that have no counterpart here |

The demo's **sixth** class, `pose`, is that state made visible - it is declared `keypoints`,
`toolFor` answers `select` for it, and a scenario asserts that activating it draws nothing.
`centerline` held the role twice and lost it twice: #223 made it a carryable geometry with
no drawing tool, and #342 gave it the tool. The role moved to a class genuinely still in
that position rather than being deleted along with the case, because a schema really can be
in it and the demo exists to show the states.

### The one place the port asserts the opposite of v1

v1: *clicking a vertex and pressing Delete removes that vertex, and since 3 − 1 = 2 is
below the minimum, the whole triangle goes.* #44 answered the same question the other
way - `removePolygonVertex` returns `null` at `MIN_POLYGON_POINTS`, `deleteVertex` does
nothing, and the polygon survives. Destroying a shape somebody placed three clicks into
because they aimed at a vertex is a punishment for a typo, and `Delete` on the selection
is one key away. Two scenarios hold it: the refusal on a triangle, and the removal on a
quadrilateral - because a refusal with no working sibling is indistinguishable from a
dead code path.

### Two engine behaviours have no adapter path, and #129 settled what to do

Found by writing the port. `AnnotatorCanvas.handlePointerDown` answers **every**
non-primary press with a pan and returns before the machine is told, which is the
adapter honouring `state.ts`'s contract that a pan forwards nothing. Two
interaction-table rows are therefore unreachable by that gesture in a browser.

**The pan stays.** The alternative - forward the press and pan only when the machine
did not consume it - loses twice. A conditional pan is unpredictable: right-drag
would pan on empty canvas and not over a vertex, so whether the gesture works
depends on where the vertices happen to be. And on macOS **ctrl-click *is* a
secondary press**, so routing it would make one ctrl-click raise both spellings of
the vertex delete - v1's own bug, which #44 closed deliberately and
`machine.test.ts` still guards.

#576 did not weaken this. The hand is a *second* branch beside the unconditional one,
taken on a primary press while the mode is on, so both of them forward nothing and
neither is conditional on what the machine would have done. What it changes is only
that a press can now be swallowed for a reason the person chose - which is the
difference between a gesture that works everywhere and one that works where the
vertices are not.

What each capability costs then differs:

- The vertex delete costs **nothing**. The toggle modifier reaches the same call;
  only v1's gesture is gone.
- The polygon take-back had **no other spelling at all**, and `mod+z` cannot serve
  because a pending polygon is not in the command log. So it got one: **`Backspace`**
  now raises a `take-back-point` intent, which only `drawing-polygon` answers.

That freed a chord rather than inventing one: `delete` and `backspace` used to mean
the same thing, and the split is the conventional one - `Delete` removes a *thing*,
`Backspace` takes back the *last thing you did*. It costs a synonym and takes away
no capability. `adapter-gaps.spec.ts` still pins the pan; `keyboard.spec.ts` holds
the split and the take-back.

### The two render layers guarded different halves - until the surface moved

#47 fixed a bug where closing a polygon on its first vertex moved focus to `<body>` and
silently killed every shortcut, and put `pointer-events: none` on both `<g>` layers.
Measured while writing this suite: they were not redundant. Restoring the attribute on
`TransientLayer` alone reproduced the original bug exactly and failed **one** scenario -
the vertex pressed belongs to the polygon still being drawn. Restoring it on
`AnnotationLayer` alone left that one green and failed **five** others, every one of
which presses on a committed shape.

**#186 removed the precondition rather than the finding.** With the input surface moved
off the `<svg>` and the transform wrapper inert, `pointer-events` inheritance covers the
whole subtree, and neither restoration reproduces anything - re-measured against the
whole suite, each leaves **90 of 90** green. The finding above is not falsified; it
described a layout that no longer exists. The layers keep their attributes because they
are what would still hold if the wrapper's were removed, but the scenario that fails
when the guard goes is `surround.spec.ts`'s, and what it names is the wrapper.

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

The config starts its own server - on **5273** in the main checkout and in CI, and on a
port derived from the worktree's own path in a linked worktree, so two of them can run
this suite at once (#346; `frontend/app/e2e-ports.ts` argues the derivation, and every
run prints the number it resolved). Never vite's 5173, which the first run of this suite
found already held by an unrelated stack, and drove for twelve scenarios before failing.
It builds the annotator first, deliberately: the app resolves
`@visionset/annotator` through `dist/`, so an unbuilt engine is invisible rather than a
compile error. `reuseExistingServer` skips that rebuild locally - if the demo behaves
like an older build, kill the dev server you already had open.

## The performance benchmark

M4's exit criterion ends "at 60fps with 200+ annotations", and until #49 nothing had
measured it. The answer is **yes, with roughly ten times the headroom for a drag** - and
one gesture, the zoom, that is O(annotations) by construction and is where the ceiling
will appear first.

### The scene

`?scene=bench` on the demo page. `src/demo/benchScene.ts` builds **200 bboxes and 20
polygons of 32 vertices - 220 annotations and 640 vertices - on a 3840x2160 asset**,
every coordinate from one seeded PRNG so the scene is identical on every machine. The
picture is a raster generated in a `<canvas>` at load and handed over as a blob URL: no
fixture media is committed here any more than in `tests/fixtures/media.py`, and a bitmap
is what a compositor actually has to re-rasterize when the stage zooms, which a vector
image understates.

The page is `BenchmarkHost`, not `AnnotatorDemo`, and the difference is one panel: the
demo's `<pre data-testid="wire">` runs `JSON.stringify` over every annotation on every
snapshot change, and a drag invalidates the snapshot on every pointer-move. That is the
host's debug surface, not the engine - so it is left out, and then *priced*, by a row
that puts it back (`?scene=bench&chrome=wire`).

### Two instruments, and neither replaces the other

| | asserted | runs | sees |
| --- | --- | --- | --- |
| `e2e/perf.spec.ts` | yes | every pull request | **DOM writes per gesture** - deterministic, hardware independent |
| `bench/annotator.bench.ts` | a loose floor only | `pnpm --filter @visionset/app bench`, and a manual CI dispatch | **frame times** - the 60fps claim, and how much headroom is left |

The split is #48's precedent - a wall-clock assertion on a shared runner fails for
reasons nobody chose - and the boundary between them was measured rather than assumed.
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
The third is caught by the count going *down* - with nothing skipped the preview never
takes the shape over, so the removal never happens - which is why the total is asserted
with equality rather than as a ceiling.

### What is asserted every pull request

| claim | number |
| --- | --- |
| the committed layer is one `<g>` per annotation | 220 groups, 660 elements: 200 `rect`, 20 `polygon`, 220 `text` |
| a drag's moves cost the committed layer nothing | **0** mutations across the moves, at 4 moves and at 60 |
| ...and the whole gesture is a constant | **3** records: removal, re-insertion, hover fill |
| a pan touches neither render layer | **0** and **0**; one style write per move on the stage `<div>` |
| one wheel notch touches no annotation | **0** records, and **6** on the stage |
| drawing a box reaches the committed layer once | **1** |

That wheel row read **880** - four attributes on each of 220 shapes - until #131. Every
stroke width, label size and label lift went through `screenPx(…, zoom)`, so that a
2-pixel stroke is two *screen* pixels at every zoom (#41's tolerance finding, pointed at
rendering); `zoom` was therefore an input to every shape, `AnnotationLayer`'s `memo`
correctly failed to bail out, and the whole document was rewritten on every notch.

Those four sizes are now CSS custom properties published once by the stage
(`stageScreenSizes` in `Shapes.tsx`), which inherit, so the per-shape attributes no longer
mention the zoom and a notch costs six style writes on one element instead of `4 × n`.
Pan, drag and zoom are now all O(1) in the document.

**`vector-effect="non-scaling-stroke"`, which #131 proposed, does nothing here**, and that
was measured rather than reasoned about. It compensates for transforms up to the *SVG
viewport*, while this stage scales an HTML **ancestor** of the `<svg>` with a CSS
transform. Two identical rects, one carrying the attribute and one not, paint the same
width at every zoom - 2.05px at zoom 1, 4.05 at 2, 8.05 at 4.

### The 880 was real, and it was not what cost the frames

This is the part worth reading twice, because the obvious inference from the table above
is wrong. Removing all 880 writes **did not move a single frame time**: the zoom still
breaks between 4x and 10x, at the same p95 and the same stall count.

Three measurements, each removing one candidate:

| removed | zoom p95 @ 10x | stalls |
| --- | --- | --- |
| nothing (the shipped build) | 83.3 | 68 |
| the React re-render (`memo` given a comparator that ignores `zoom`) | 83.3 | 74 |
| the 4K image (`display: none` on the `<img>`) | 83.3 | 72 |
| all 220 shapes (`display: none` on the committed layer) | 66.7 | 65 |
| - the same gesture on the small demo scene | **16.8** | **1** |

So neither the DOM writes, nor React's render of 220 components, nor the 4K image is the
cost; and hiding every shape recovers only about a fifth of it while still missing the
budget fourfold. What is left is the browser's own raster and compositing of a scaled
stage, which is not work this codebase does and not work `vector-effect` or an unscaled
grip layer would have avoided either.

The document-size dependence is real - the small scene zooms perfectly at the same
throttle - but it is a raster cost, not a React one. #131's diagnosis named the writes;
the writes are gone and the ceiling has not moved.

### The ceiling is raster, so it is a limit rather than a bug (#228)

That is where the measuring stopped and a decision was taken: **infinite zoom serves
nothing, so the zoom is capped**. The three parts of it are in
`adapters/viewport.ts`, and each answers a different half of "what does a person meet
at the bottom of the range".

| | | |
| --- | --- | --- |
| `MAX_ZOOM` | **8** | one asset pixel as an eight-pixel block |
| `PIXELATED_ABOVE_ZOOM` | **4** | past this the image layer renders `image-rendering: pixelated` |
| `atZoomCeiling` / `atZoomFloor` | - | so a host's controls can be disabled *with the reason* |

**8x is the depth past which the picture has nothing left to show.** An asset pixel is
already an eight-pixel block there; magnifying further produces larger blocks of the same
data, and no render architecture changes that - it is the image's own sampling grid. That
the browser's raster is also struggling by then is a second reason for the same number,
not the primary one.

**Above 4x the image is drawn as pixels rather than smoothed**, and only the image: the
SVG chrome is untouched by the rule. Bilinear smoothing is right where the sampling grid
is not the subject, and wrong once somebody has zoomed in *to look at* individual pixels -
it invents gradients between them, so a blurry magnification reads as a soft image where a
blocky one reads as what it is. `imageRenderingAt` is strictly above the threshold, so 4x
itself still smooths.

**Both bounds are stated in the UI, never silent.** `AnnotationPage`'s `−`/`+` were plain
buttons that stayed enabled at the ends of the range and did nothing when pressed; they
now carry `aria-disabled` and a tooltip naming the limit, and the readout stops at exactly
`800%`. `aria-disabled` and not the native attribute, for `ToolPalette`'s reason: a
disabled `<button>` takes no pointer events, so its tooltip never opens and the reason
cannot be read. The bounds come from `@visionset/annotator` rather than from numbers in
the page, because `clampZoom` is the one thing that decides them.

**Vector re-rendering of the annotation chrome is deferred** to the drawing-tool orbit,
`cf. #342`. It is the remaining lever on sharpness at depth, and drawing precision is the
thing that would justify paying for it; nothing in the annotation loop today does.

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
few between runs on the same machine - the unthrottled zoom row has been seen at 1 and
at 6 - so read them as an order of magnitude, and read the medians as the number.

**Acceptance criterion 1 is met**: pan and drag hold 60fps with 220 annotations on a 4K
asset, with no stalls at all.

The rows below `full` are why the table is worth reading. An unthrottled frame interval
is pinned to the display: it reports 16.7 ms whether the work uses a tenth of the budget
or all of it, so on its own it cannot distinguish a healthy build from one about to miss,
and a regression that halved the margin would leave every number identical. Throttling
the main thread turns that into something the same instrument can read:

- **a drag still holds 60fps at 10x slower** and breaks between 10x and 20x, so it has
  roughly an order of magnitude of headroom on this machine;
- **the zoom breaks between 4x and 10x** - the first gesture to go. This baseline was
  recorded before #131 and is left as it was; #131 removed the 880 writes per notch and
  **these numbers did not move**, which is the finding written up above. The ceiling is
  the browser's raster of a scaled stage, and it is still where it was - #228 accepted it
  as a limit and capped the zoom at 8x rather than chasing it further.

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
- **it passes `--base /app/` by hand.** `vite.config.ts` sets the base from `command`, and
  `vite preview` reports `command` as `"serve"` - so without it the preview server
  answers at `/` while the build has `/app/assets/…` baked into its HTML, the SPA fallback
  returns **200 with `index.html`** for the missing script, and every scenario fails
  hunting for a canvas on a blank page. Nothing errors.
- **it never reuses an existing server**, on a port of its own - 5373 in the main
  checkout, derived from the worktree's path in a linked one (#346). The build is part of
  what is being measured.

And one trap inside the harness, since the same shape will be wanted again: **a CDP
session's `detach()` silently reverts `Emulation.setCPUThrottlingRate`.** An
8-million-iteration loop in the page took 14.8 ms at rest, **13.4 ms** after a
throttle-then-detach, and **292.4 ms** with the session held open. The first version of
the headroom rows detached, and reported beautiful numbers about nothing.

CI carries the benchmark only on `workflow_dispatch` (`annotator bench (chromium,
manual)`), which is what #49 asks for. Compare a dispatch against a dispatch - a shared
runner is not the machine above.

## The showcase

The demo page at `/` is the annotator's public showcase, and #50 is what made it one. It
is the same page the behavioural contract drives - the shape did not move - restyled onto
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
demo is the thing that keeps it honest - a control the package had to own would have to
be built here first and would not fit.

### A tool strip over a tool that does not exist

`core/interaction/tool.ts` is emphatic: the tool is **derived from the active class and
never stored**. v1 stored both and spent two mechanisms keeping them from disagreeing. So
the strip does not select a tool - it reports the derived one, and a press moves the
active class to one that derives the tool asked for. Two consequences, both deliberate:

- A press whose tool is **already active is a no-op.** The demo schema declares two bbox
  classes; with `pedestrian` held the box button is already lit, and re-pointing the class
  at `vehicle` would silently change what the next shape is labelled.
- The strip lists **one button per distinct drawable geometry**, built from
  `drawableGeometry`. A `classification_tag` and a `keypoints` class both answer `null`,
  and the demo schema declares both - so the two omissions are visible rather than
  theoretical. `polyline` was the second of these until #342 gave it a tool.

### `onViewChange`, and the one place a default is a lie

The readout needed the stage's scale, and the adapter had no way to hand it over. The new
prop is read-only and it is called **on mount**, unlike `onAnnotationsChange` and
`onSelectionChange`, which deliberately are not.

The asymmetry is the point. A document is handed *in*, so a host already knows the initial
one. A viewport is not: the fit is computed in a `useLayoutEffect` against a pane rect only
the component can measure, so a host that was never told would have to display `1` - and
100% is the one number the fit is guaranteed not to be. `showcase.spec.ts` asserts the
readout against the measured scale for exactly that reason; with no jsdom in this
repository, a browser is the only place a mount-time call can be observed at all.

Zoom **controls** - a `−`/`+` pair driving the stage from outside - need an imperative
handle the adapter still does not publish. They land with the top bar that has somewhere to
put them (#56). Until then the readout reports and the wheel, the pinch and `mod+0` drive.

### The one deliberate departure from `DESIGN.md`

**The canvas well is dark.** Everything around the image follows the contract exactly -
white cards, `#d0d7de` borders, Robomous orange strictly as an accent, one type scale - but
the surround the picture sits in does not. A bright frame around a photograph shifts its
apparent contrast, which is why every image tool ships a dark mat. It is a mat and not a
second theme: the only interactive thing drawn on it is the tool strip, which is a `muted`
panel from the light palette.

`frontend/app/src/demo/theme.ts` holds the tokens and records that exception once, rather
than six components each making it. **#128 replaces that file** with `@visionset/ui-core`'s
real `tokens.css` - today a superseded placeholder whose dark surfaces and blue accent
contradict the contract. The components above it do not change when it does, because they
already name intents rather than colours.

The benchmark page keeps the old dark chrome on purpose. It is an instrument, #49's numbers
were recorded against it as it stands, and restyling it would change what its frame times
measure for no reason anybody asked for.


## The side panel

`@visionset/ui-core`'s `AnnotatorPanel` is the column beside the canvas: **three
stacked regions, no tabs** - Classes, Tags, Annotations, read top to bottom as three
answers about one frame (*what may I draw*, *what is true of the whole picture*,
*what have I drawn*). It is driven entirely by the `AnnotatorStore` the page already
holds and adds no second door to the document: every write is a command that already
existed, and the selection is one `Selection` seen twice rather than two kept in step.

**A tag is not an object.** The Annotations list holds drawn shapes only, filtered by
`isTagAnnotation`. It used to hold everything in the document, so each tag was a chip
*and* a numbered row - counted in `N objects` at both counting sites, and offered a
hide button that hides nothing. Tags are assigned in their own region instead, as
multi-select chips: one tag per class and as many classes as the schema declares,
which is the kernel's rule (`DuplicateClassificationTag` is keyed
`(asset, label_class)`) rather than one the panel invents.

A region with nothing to show is not rendered, and its divider goes with it - no
drawable class, or no tag class. Annotations is the exception: an empty frame is the
normal state of a fresh one, and it says so in words.

**A class row's shapes are chips, and each is a press target.** On an unarmed row a
chip arms the class *with that shape*; on the armed row it switches the shape and
never the class. Only drawable geometries appear, so a tag never does. A row whose
name and chips do not fit wraps the chips to a second line rather than truncating a
control.

**Hiding is a view decision.** The core document has no `hidden` flag and must not
grow one - hiding is per viewer and per session, and a field would travel to the API
and change a release hash. `AnnotatorCanvas` takes a `hiddenIds` prop instead, and
filters both what it draws **and** the document the machine hit tests against,
because a shape you cannot see must not swallow a press. `withoutHidden` returns the
*same object* when nothing is hidden, which is what keeps the committed layer's
`memo` bailing out during a drag.

Hold that set in state. A freshly allocated `Set` on every render defeats the memo
before it is consulted - #49's `skipId` finding, one prop over.


## The annotation page

`@visionset/ui-core`'s `AnnotationPage` is the browser's whole annotation surface,
and three of its decisions are worth knowing before changing it:

- **The schema is the batch's pinned version**, fetched by number. The project's
  active schema is a different question with often a different answer.
- **The navigator is the batch's asset listing filtered to the job**, not
  `next_pending_assets` - that route hands out *pending* assets, so it shrinks as
  the work is done and cannot go back.
- **There is no autosave.** A save is a diff followed by a refetch (the kernel mints
  its own ids), so a timer would rebuild the document mid-gesture. Explicit Save,
  save-on-navigate, and a `beforeunload` guard.

Zoom controls reach `AnnotatorCanvas`'s `viewRef` handle, whose `fit()` is the same
implementation `mod+0` runs - one behaviour, two doors, which is why the chord is
still intercepted by the adapter rather than forwarded.


## The tool palette

`@visionset/ui-core`'s `ToolPalette` is the floating strip on the canvas's left
edge. It is a **second** implementation of the same rule as the showcase's
`demo/ToolStrip.tsx`, deliberately: the showcase's whole claim is that the engine
ships headless - no Tailwind, no tokens, no chrome - so a showcase importing
product UI would be demonstrating the opposite. What the two share is the rule
below, not a file.

**The strip reports the tool; it does not hold one.** `toolFor` derives the tool
from the active class and nothing stores it (`core/interaction/tool.ts`), so a
press moves the *class* to one that derives the tool asked for. Two consequences
fall out and both are load-bearing:

- A press whose tool is **already active is a no-op**. Two bbox classes are one
  bbox tool, and re-pointing the class would silently change what the next shape is
  labelled without moving the tool. Choosing *which* class is the Labels tab's job.
- The strip lists one button per distinct **drawable geometry**, from
  `drawableGeometry` - never one per class, and never a hardcoded list. A
  `classification_tag` and a `keypoints` class both answer `null` and neither gets
  a canvas tool; `polyline` did until #342.

**Without it the page opened in a mode where dragging did nothing** (#198). The
page starts with no active class, so `toolFor` answers `select`; the capability was
reachable from the Labels tab and the digit row, but neither is discoverable from
the canvas, and neither is a tool. #145 recorded the same absence as ergonomics,
which was too generous.

**A palette press reaches the machine one tick later than a digit does.** The click
sets React state, and `AnnotatorCanvas`'s effect dispatches `tool-changed` on the
next render, where `runAction` dispatches synchronously. Anything driving the
palette in a test waits on the button's own `data-active` rather than on a timer.

**The buttons refuse the focus.** `AnnotatorCanvas` reads the keyboard off its own
root, so a tool press that took the focus would leave every chord dead until the
user clicked back on the picture - the silent failure #47 met from the other
direction. `mousedown` is where a browser moves focus, so that is where it is
refused.

The shortcut in each tooltip is the **digit** `hotkeyForClass` answers, not v1's
`B`/`P` that `DESIGN.md` still draws: this build binds classes to the digit row
(#46), and printing a key that does nothing would be worse than printing none.


## The minimum viewport

The annotation page has a floor, and saying so is the feature. Below
**`ANNOTATOR_MIN_VIEWPORT_PX` (768, a standard iPad in portrait, and Tailwind's
`md`)** it renders an explanation instead of the editor: what the minimum is, why
there is one, and a way back to the batch (#184).

The number is 768 rather than something measured off the top bar's eleven controls
because it has to agree with the breakpoint every other screen already stacks at.
A second number would make the annotator disappear at a width where nothing else
changed, which is a boundary nobody can predict from the outside.

**It follows the viewport, never the device.** `matchMedia`, not a user-agent
read: rotating a tablet, dragging a desktop window narrow and opening devtools all
cross this boundary without changing the device, and a sniff would call a 1400px
iPad Pro a phone and a 700px desktop window a workstation. It is a *subscription*
through `useSyncExternalStore` rather than a read on mount, so there is no window
in which the page believes a stale answer.

**Nothing is mounted and hidden.** The check lives in the exported
`AnnotationPage` and the whole of the old body moved into `JobScreen`, so under
the floor there is no store, no canvas and no engine - because `AnnotatorCanvas`
measures its pane to derive the fit zoom, and a canvas laid out inside a
`display: none` ancestor measures **zero**. A CSS-only treatment would leave the
editor holding a zoom nobody chose the moment somebody widened the window.

The explanation runs exactly two reads - job → batch - so it can offer the way
out, and nothing else. On a phone there is no rail beside this page and, on a
fresh tab, no history behind it, so an explanation with no exit would be the dead
end #199 removed everywhere else.

**Nothing else in the product gains a floor.** Lists, forms and the gallery are
usable on a phone and stay that way; `e2e/viewport.spec.ts` drives them at 390px
and asserts it.
