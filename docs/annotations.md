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
