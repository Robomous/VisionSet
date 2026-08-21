# Annotation schemas

A schema is a project's ontology. It defines the classes being labeled, the geometries each
class may be drawn as, and the additional information carried by a label. The previous system called this the
"task type," but a task type remained fixed for the life of a project. A schema is
**versioned**, and every version is immutable.

`SchemaService` owns that lifecycle and is the **only** way to create a version.
`ProjectService` deliberately does not seed one, so a project starts without an ontology and
receives version 1 when somebody defines what it labels.

```python
from visionset.kernel.domain import Attribute, GeometryType, LabelClass
from visionset.kernel.services import ProjectService, SchemaService, WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    project = ProjectService(workspace).create("Speed limits")
    schemas = SchemaService(workspace)

    sign = LabelClass(
        name="sign",
        # A set: the same sign is worth boxing at the end of the street and
        # worth outlining close up, and it is one class either way.
        geometries=(GeometryType.BBOX, GeometryType.POLYGON),
        attributes=[
            Attribute(name="occluded", kind="boolean", default=False),
            Attribute(name="weather", kind="select", options=["dry", "wet"]),
        ],
    )
    lane = LabelClass(name="lane", geometries=(GeometryType.POLYGON,))

    published = schemas.create_version(project.id, [sign, lane])
    published.published.version  # 1
    published.advanced_batches  # the open batches this version took with it

    schemas.get_active(project.id)  # the highest version
    schemas.get(project.id, 1)  # any version, forever
    schemas.list_versions(project.id)  # oldest first
    schemas.allowed_geometries(project.id)  # {BBOX, POLYGON} — the union, not the test
```

**Over HTTP:** `POST`/`GET /projects/{project_id}/schema/versions`,
`GET /projects/{project_id}/schema/versions/{version}`, and `GET /projects/{project_id}/schema`
for the version in force. Narrowing needs `?allow_destructive=true`, exactly as
`allow_destructive=` does here. `compare` has one too:
`GET /projects/{project_id}/schema/compare?from={n}&to={m}` returns the classification below,
which is what a version history renders and what a client reads before deciding whether it needs
the flag. `allowed_geometries` still has no route - it gets one when a surface needs it. See
[api.md](api.md).

**Over MCP:** `get_schema`, `create_schema_version`, `compare_schema_versions` and
`preview_schema_change`. The second-to-last is what an agent reads before `repin_batch`
([batches.md](batches.md)); the last is
`preview`'s first caller anywhere: plan-before-apply matters most for the surface that cannot see
the consequences of a change until it has made one, so an agent gets the diff before it decides
whether it needs `allow_destructive`. See [mcp.md](mcp.md).

## Versions are 1..N, and none of them changes

The next version is one past the highest stored, so the numbers have no gaps and no reuse.
`create_version` always **inserts** - there is no `update` and no `delete` on this service -
and the domain models are frozen, so a rehydrated version cannot be edited even by
accident:

```python
schema = schemas.get(project.id, 1)
schema.version = 2  # ValidationError
schema.classes[0].name = "x"  # ValidationError
```

That is the point of the whole design. Every `Annotation` records the `schema_version` it
was created under, so a version read three milestones from now still says exactly what it
said when the label was made. A version that could be edited would make that record a
guess.

Schema rows are deleted only as part of deleting their project, through the database's
`ON DELETE CASCADE` - see [projects.md](projects.md).

## Publishing the contract already in force writes nothing

`create_version` compares the classes it is given against the active version, and when they
are identical it returns that version and inserts no row:

```python
first = schemas.create_version(project.id, [SIGN])
again = schemas.create_version(project.id, [SIGN])
assert again == first  # one version, not two
```

It is not a refusal - the call succeeds, and the version the caller holds afterwards is the
one in force, which is the only thing it asked for. Over HTTP the answer is `201` either
way: the API declares one 2xx response per operation, and a client that branched on "did
this succeed" would see no difference in any case.

**Identical means the classes compare equal** - names, geometries, colours, attributes and
order. That is deliberately *not* the same question as an empty diff:
[additive versus destructive](#additive-versus-destructive) classifies whether existing
annotations survive and ignores `color` on purpose, so gating this on the diff would answer
"saved" to somebody who changed a swatch and then throw the swatch away. Equality implies an
empty diff and never the reverse, so the diff stays the one definition of *changed in a way
that matters*.

Only the **active** version is compared. Re-publishing an older version's classes is a real
change - it is what a revert is - and answering it with that old version would leave the
newer one in force.

`description` and `provenance` are not part of the comparison, because they are not part of
the contract. A save that changes only the commit message is a no-op, and the message is not
recorded: there is no version for it to describe.

## A version says why it exists, and when

```python
schemas.create_version(project.id, classes, description="split 'vehicle' into car and truck")
```

`description` is the version's **commit message**, and `created_at` is stamped by the
service at publish. Together they are what makes a version history readable as history
rather than as a pile of class lists.

**The description is written once and can never be edited.** That is not a missing feature -
it is the immutability rule this whole page is about, applied to one more field. There is no
`update` on `SchemaService`, no `PATCH` route, and the model is frozen, so the three doors
that would have to exist all deliberately do not:

```python
version = schemas.get(project.id, 1)
version.description = "second thoughts"  # ValidationError
```

Ongoing, editable discussion *about* a version is a different feature and does not belong on
a frozen artifact. Write the description the way you would write a commit message: for
whoever reads it later, not for yourself this afternoon.

A blank description is legal and stored as `None` - an empty commit message is an ordinary
thing to publish, so this is not [`normalize_name`](../../src/visionset/kernel/domain/names.py)
and it does not refuse. What it *does* borrow from that rule is the tidying: NFC-normalized
and stripped, in a validator on the domain model, so no door can write an untidied one.

**`description` is `None` when nobody wrote one, and nothing invents one.** `created_at` is
stamped by `SchemaService` at publication, which is the only moment that can answer it
honestly - a timestamp taken anywhere else names when somebody ran something, not when the
version was written, and a plausible-looking wrong timestamp is worse than an admitted gap
because nothing downstream can tell it is wrong. `Asset.ingested_at` made the same call for
the same reason.

## A version also says which kind of work published it

```python
schemas.create_version(project.id, classes, provenance=SchemaProvenance.CURATED)
```

`provenance` is `curated`, `annotation`, or absent. It exists because a version history
becomes unreadable otherwise: a project annotated for a week accumulates a version for every
class somebody turned out to need, and those bury the handful a person actually sat down and
designed. A surface reading the history collapses consecutive `annotation` versions into one
row and renders every other version individually.

**What makes a version incidental is the surface it came from, never the size of the
change.** A one-class save in the schema editor is `curated`; a one-class save from the
annotator's add-class dialog is `annotation`. So each writer states its own answer and the
kernel stores it verbatim:

| Writer | Records |
| --- | --- |
| The browser's Schema tab | `curated` |
| `visionset schema apply` | `curated` |
| MCP `create_schema_version` | `curated`, unless the caller passes `provenance` |
| The annotator's add-class dialog | `annotation` |
| An SDK call that says nothing | absent |

Nothing infers it, because nothing else can: the only thing that knows which kind of work is
happening is the surface the person is using. It is not a gate, it does not appear in a
[diff](#additive-versus-destructive), and two versions differing only in provenance are the
same contract.

**Absent is not a third kind - it means nobody said**, and a reader groups it with `curated`.
Every version published before this field existed is absent and nothing backfills them: no
build ever recorded which surface published a version, so the alternative is a guess, and a
history that groups on a guess is confidently wrong about exactly the milestones somebody
opened it to find. Showing a version that deserved collapsing is the smaller error.

> **Two different things are called provenance**, and they are about different entities.
> This one is on a **schema version** and says whether the *version* was designed or fell
> out of labeling. [`Annotation.provenance`](annotations.md) is on a **label** and says
> whether the *box* was drawn by a person, produced by a model, or imported. They share a
> word and nothing else; neither is derivable from the other.

## The active version is derived, not stored

`get_active` returns the highest version. There is no `active` column, because the version
numbers already carry that fact and a second copy of it is one more thing to keep in sync.
A project with no schema yet raises `SchemaNotFound` - that is the ordinary starting state,
not damage.

## Geometries a class may use

**A class accepts a set, not one.** `LabelClass.geometries` is non-empty, deduplicated, and
kept in one sorted order; an annotation carries **one** of them, and `AnnotationService`
tests membership in *that class's* set. Splitting `car` into `car` and `car_polygon` to label
the same object two ways is what this replaces - two classes that mean one thing, which every
consumer downstream then has to re-unify.

The order is sorted rather than authored on purpose. `release.canonical_bytes` dumps these
straight into the document it hashes, so a set whose order depended on how a caller typed it
would make two identical schemas produce two different release hashes. Class *order* is
authored and preserved; geometry order carries no meaning and nobody can read one into it.

`GeometryType` names eight geometries; four have a model in the `Geometry` union today -
`bbox`, `polygon`, `polyline` and `classification_tag`.
`IMPLEMENTED_GEOMETRIES` is read *off* the union, so shipping a variant widens it with no
second edit, and `create_version` refuses a class naming anything outside it:

```python
LabelClass(name="road", geometries=(GeometryType.MASK,))  # constructs fine
schemas.create_version(project.id, [that])  # UnsupportedGeometry
```

A document written before this was plural spells the field `geometry` and singular.
`LabelClass` reads one and lifts it into a set of one, which is why #584 needed **no
migration**: schema classes live in a JSON column and release manifests carry these
verbatim, so every stored version and every published release still loads. The REST body
deliberately does *not* accept the old key - a client sending it is told so rather than
silently reinterpreted.

Declaring a class whose geometry has no implementation would create a class nobody could
ever label. Refusing at the schema is better than discovering it at the first annotation.

**`polyline` is the newest of the four, and it is now complete end to end.** It joined the
union in #223 so that lane datasets work — the SDK, the REST API and MCP all accept one, and
`visionset.formats.lanes` exports five lane formats from it — and its interactive drawing
tool followed in #342, so a lane is drawn, hit-tested and edited on the canvas like any other
shape. A polyline class is an ordinary class whichever way it is filled in: by hand, by a
script, or by an agent with a person checking.

**`classification_tag` now has an export path too.** It could always be declared and labelled,
but until `visionset.formats.classification` existed there was nowhere for it to go on export —
every other installed format has a branch that drops a tag outright, having nowhere to put a
label with no location. The new plugin writes it as a multi-label CSV, one row per tag
annotation, with `classes.txt` naming the tag-capable slice of the schema.

### The categories a picker groups them by

The eight fall into two families, and the grouping is **presentation only** - the kernel has
no category concept and takes none (#375). "Basic Computer Vision" holds the geometries an
ordinary image task produces: `bbox`, `polygon`, `mask`, `keypoints` and
`classification_tag`. "Robotics and AD" holds the ones that describe a scene the camera
alone does not give you - `polyline` for lanes today, and the reserved `cuboid_3d` and
`polyline_3d`.

The map lives in `frontend/ui-core/src/data/geometryCategory.ts`, declared total over the
generated `GeometryType` union so a ninth member fails the frontend build until somebody
categorises it. Nothing on the wire carries a category, and an exporter's capability
declaration never names one: `supported_geometries` is per geometry, because a lane exporter
supports `polyline` and has said nothing at all about `cuboid_3d`.

`allowed_geometries` is the flip side, derived the same way: the **union** across a version's
classes. It answers *what may this project draw?* and it is deliberately **not** the test a
write goes through - an annotation is judged against its own class's `geometries`, which the
union is wider than as soon as two classes accept different shapes. The union's discriminator
values *are* `GeometryType` members, so nothing translates in between.

## Publishing catches the open batches up

A batch is judged against the version it pinned at approval, and that pin used to move only
when somebody asked. **A version that only widens the contract now takes every open batch with
it**, in the same transaction that publishes it (#381), and `create_version` answers with the
batches it moved so a surface can say so rather than leave it to be discovered.

The whole safety argument is the section below: additive means every annotation valid under the
old version is valid under the new one, so a wider contract cannot invalidate anything already
drawn. A **narrowing** version moves nothing, `allow_destructive` or not — that flag says
*publish this*, never *and drag every open batch across it* — and crossing one is
`BatchService.repin`, judged against a single batch's own labels. See
[batches.md](batches.md).

Publishing the contract already in force writes nothing and therefore moves nothing: an
operation that writes nothing cannot have an effect.

## Additive versus destructive

One question draws the line, and it is the same question the paragraph above rests on: **does an
annotation that was valid under the previous version stay valid under this one?**

| Change | Kind |
| --- | --- |
| Class added | additive |
| Class removed | **destructive** |
| Class renamed | **destructive** (a removal) plus an addition |
| Class re-cased (`car` → `Car`) | **destructive** — a rename, and the diff says so |
| Geometry added to a class | additive |
| Geometry removed from a class | **destructive** |
| Class color changed | not a change at all |
| Optional attribute added | additive |
| Required attribute added | **destructive** |
| Attribute removed | **destructive** |
| Attribute became required | **destructive** |
| Attribute became optional | additive |
| Attribute kind changed | **destructive** |
| `select` option added | additive |
| `select` option removed | **destructive** |
| Attribute default changed | additive |
| Attributes reordered | not a change at all |

Classes and attributes are matched by **exact name**, which is why a rename reads as a
removal plus an addition. That looks lossy until you remember that `Annotation.label_class`
is matched by exact string too: a rename really does orphan every annotation under the old
name. The kernel cannot see intent, and guessing at it would be guessing with somebody's
labels.

Within one version, class names must be unique ignoring case, for the same reason: `Car`
beside `car` is two classes that read as one to everybody except the code. That rule is also
what makes a re-casing the one rename whose intent is not a guess: a version cannot hold both,
so `car` leaving as `Car` arrives can only be a rename. The verdict does not move — the labels
still carry `car` — but the change's `detail` names the re-casing and its cost, so a surface
explains it instead of reporting a removal nobody made. A re-casing with labels under the old
name is refused like any removal; re-case it before labeling, or keep the casing.

The classifier lives in `kernel/domain/schema_diff.py` and is pure - two sequences in, a
verdict out. `preview` runs it against the active version without writing, and adds the half the
classifier cannot know - which of the classes being dropped already carry labels - so a surface can
warn before it asks:

```python
preview = schemas.preview(project.id, proposed)
preview.diff.is_destructive  # True   - needs allow_destructive
preview.diff.destructive_classes  # frozenset({'lane'})
preview.is_refused  # False  - and no flag would change that if True
preview.blockers  # () - or (ClassCount(label_class='lane', ...),)
```

**`is_destructive` and `is_refused` are different questions**, and conflating them is the loop
`SchemaChangeWouldOrphan` sits outside `DestructiveSchemaChange`'s hierarchy to prevent: the first
is answered by passing a flag, the second by nothing at all. `blockers` is the same structure
`SCHEMA_CHANGE_WOULD_ORPHAN` puts in its `detail`, so one renderer serves the warning and the
refusal.

The preview is advisory: nothing is locked, so a label written between the preview and the publish
makes the publish refuse, and that refusal is the authoritative one. What it removes is the round
trip that was doomed before it was sent.

`compare(project_id, from_version, to_version)` does the same between two stored versions,
in either direction.

## Two gates on narrowing the contract

```python
schemas.create_version(project.id, narrower)  # DestructiveSchemaChange
schemas.create_version(project.id, narrower, allow_destructive=True)  # → next version
```

The flag is `allow_destructive`, **not** `confirm`. The two guard different things and
should not be caught by one `except`: `confirm` stands in front of destroying data (see
`ProjectService.delete`), and this stands in front of narrowing a contract, whose usual
remedy is "write a wider version", not "say yes harder".

An open batch keeps the version it pinned, so a destructive version can be published before that
batch writes another annotation. Its later annotation is valid under that batch's pin, not under
the newer active schema. If that content is promoted, release publication validates it against the
active schema and refuses the release with affected class counts until the content is reconciled.

The second gate has no flag at all when the proposed change would orphan annotations the schema
publication path must preserve:

```python
# annotations already exist under 'lane'
schemas.create_version(project.id, without_lane, allow_destructive=True)
# → SchemaChangeWouldOrphan: annotations already exist under 'lane' (37)
```

Migrating existing annotations onto a new version does not exist yet, and until it does the
kernel refuses rather than leaving labels pointing at a class the contract no longer
describes. `SchemaChangeWouldOrphan` is deliberately **not** a subclass of
`DestructiveSchemaChange`: a caller that caught the base class and retried with the flag
would loop forever.

The order matters - the missing flag is reported before the labels are counted. The first
refusal is about intent, the second about facts on disk, and they have different fixes.
Only classes named by a *destructive* change are checked, so labels under a class the
version merely widened never block anything, and neither do labels in another project.

Counting those labels walks the project's assets and reads each one's annotations, because
the persistence port has no cross-table query: `Repository.list` takes a single `parent_id`,
and an annotation's parent is its asset. That is N + 1 reads, and deliberately so at the
scale this runs at — when it starts to cost, the fix is a method on the port, never a
SQLAlchemy import in a service.

## Attributes

An attribute is `string`, `number`, `boolean` or `select` (the roadmap sometimes calls the
last one "enum"). `required` says an annotation must carry a value; `default` says which
value a surface should offer when it does not. They are independent - a required attribute
with a default is an ordinary, useful thing.

Per-value validity is the model's, enforced in `kernel/domain/schema.py`, so a malformed
attribute cannot be constructed at all and never reaches a service:

- a `select` needs at least one option, with no repeats; nothing else may carry options;
- a `default` must match its own kind, and a `select` default must be one of its options;
- names are stripped and never blank, and one class cannot carry two attributes whose names
  differ only by case.

Rules that need the *whole* version - duplicate class names, an unimplemented geometry -
are `SchemaService`'s, and both raise `InvalidSchema` (`UnsupportedGeometry` is a subclass,
so one `except` covers every way a version can be malformed).

What is validated here is attribute **definitions**. Attribute **values** are validated
somewhere else and at a different time: at annotation write time, by `AnnotationService`,
against the version the annotation's batch pinned at approval - not against the project's
active version. The judgement itself is shared rather than reimplemented: `Attribute.rejects`
is the one method that answers "does this attribute take this value", and both a default and
a label go through it. See [annotations.md](annotations.md).

## At a terminal

```bash
visionset schema apply schema.json --project road-signs
visionset schema list --project road-signs
```

The file is **JSON**, and it is byte-for-byte the same document
`POST /projects/{id}/schema/versions` takes:

```json
{
  "classes": [
    {
      "name": "sign",
      "geometries": ["bbox"],
      "color": "#ff0000",
      "attributes": [
        {"name": "occluded", "kind": "boolean", "required": false, "default": false}
      ]
    }
  ]
}
```

That is a tested claim rather than a promise: `tests/cli/test_json_contract.py` asserts that
`visionset.wire`'s `label_class` and `attribute` projections have exactly `LabelClassBody`'s and
`AttributeBody`'s fields, and `tests/cli/test_schemas.py` validates the example document as a request body.

**JSON and not YAML.** A second format means a runtime dependency in every wheel, a second parser
to keep honest, and two shapes that can disagree - while the surface a schema file has to
interoperate with speaks JSON already. `yq . schema.yaml | visionset schema apply /dev/stdin` is one
pipe away for whoever wants one.

**The document parses through the domain models themselves**, so `LabelClass`'s and `Attribute`'s
own validators do the refusing and no rule here is restated in the CLI. Those refusals are **exit
2**, not 1: a pydantic `ValidationError` is not a `VisionSetError`, and a malformed file is a usage
error in the same sense a malformed request body is a 422. The message carries the domain's own
words and the path to the offending field (`classes.0.name`).

`--allow-destructive` is the flag for the first of the two gates above. The second - a change that
would orphan annotations - has no flag, here as everywhere.

## Concurrency

The next version number is computed from the versions already stored, so two writers can
agree on it. The unique index on `(project_id, version)` refuses the second, and the service
translates that into `SchemaVersionConflict`. The remedy is to retry, which re-reads the
maximum and lands on the version after.

The translation happens **outside** the `unit_of_work` block: a constraint violation ends
its transaction, so it cannot be caught and recovered from inside one. Any other constraint
travels on unchanged - it is not this service's to reinterpret. See
[persistence.md](persistence.md).

That is the concurrency story for a **version** - two writers racing to publish. A **draft**
races differently, because nothing about it is append-only: see
[Drafts](#drafts) below, and its own `STALE_WRITE`.

## In the browser

`@visionset/ui-core`'s schema editor is the surface over everything above, and the
two rules it exists to honour are the two on this page: a version is **immutable**,
so the editor drafts and publishes N+1 rather than saving in place; and the two
refusals are **both 409** with only one override between them, so it branches on the
`code` and shows "Save anyway" for `DESTRUCTIVE_SCHEMA_CHANGE` and nothing but
"Close" for `SCHEMA_CHANGE_WOULD_ORPHAN`.

`POST /projects/{id}/schema/preview` now routes `SchemaService.preview`, so a client can ask
both questions about a *draft* before it publishes; `compare` remains the question about two
*published* versions, which is what the version navigator asks.
`POST /projects/{id}/schema/blocking-assets` routes `SchemaService.blocking_assets`, which is the
listing behind the counts. It surfaces as **"Frames in the way"**, a section under the editor in
the Schema tab rather than anything inside the refusal dialog: the dialog states a number and
closes, and the frames it counted are still there to be dealt with afterwards. Each row links to
every batch holding its frame — an annotation names no batch, so there is no single one to send
anybody to. Both readings walk the project once, the same way, so the count and the rows never
disagree. See
[ui.md](ui.md#frames-in-the-way),
[api.md](api.md#asking-before-you-are-refused) and
[api.md](api.md#reaching-what-is-in-the-way).

## Drafts

`SchemaEditor.tsx`'s `draft` above and `AddClassDialog`'s `session` are both **local** state -
they die on a reload, on navigating away, and on the machine they were typed on.
`SchemaDraftService` is the server-side entity that survives all three, and it is deliberately
not a method added to `SchemaService`: that service states as doctrine that it has no `update`
and no `delete`, and a draft needs both.

**One draft per project per `kind`, and nothing more specific.** `kind` is a `SchemaProvenance`
- `curated` for the Schema tab, `annotation` for the annotator's add-a-class dialog - and a
project holds at most one draft of each, a singleton the store enforces with a unique index on
`(project_id, kind)`. There is no name, no history and no notion of who wrote one.

**Shared, with no author, because the workspace has no identities.** `Token` is a named
credential rather than a person, and nothing else here claims to be one. A draft therefore
belongs to the project and to everybody holding a credential to it - not to whoever typed
last - which is also why two people editing the same kind of draft is the ordinary case this
design has to answer for, not an edge case.

**Storage is permissive; publishing is where it is validated.** `DraftLabelClass` mirrors
`LabelClass` with every field optional and no cross-field rule checked - a class with no name
yet, a select with no options yet, an attribute nobody has typed a kind for. Validation is not
weakened by that; it moves to the one moment it can actually run. `publish` converts each draft
class into the real thing and calls `create_version` exactly as any other caller would, so every
refusal a version can give - `InvalidSchema`, `UnsupportedGeometry`, `DestructiveSchemaChange`,
`SchemaChangeWouldOrphan` - a draft can still give, on the version it is about to become. A class
that will not convert is refused as `InvalidSchema`, named by its position (`classes.3`), the
same locator a malformed class gets through every other door.

**`revision` counts writes, and a write decided against a stale one is refused, not merged.**
Every write to an existing draft names the revision it read; omitting the revision asks to
*create*, which is refused if a draft already exists - a writer that never read the draft has,
by definition, not seen what it is about to overwrite. A write naming a revision the draft has
since moved past raises `StaleWrite`: somebody else's write landed first, and applying this one
on top would silently discard it. `publish` runs the identical check against its own
`expected_revision`, so a draft cannot be published out from under the person about to save it
either. There is deliberately no flag that writes or publishes anyway - re-reading and deciding
again is the only way past it, the same rule [Concurrency](#concurrency) above states for a
version's own race.

**Publishing spends the draft.** A successful `publish` discards the row whether or not a new
version was actually written - a draft that proposed the contract already in force has nothing
left to say once that question is answered. `get` afterwards finds none, and the next `save`
starts a fresh draft at revision 1, seeded from whatever is now active. Publishing is not one
transaction with the discard that follows it: `create_version` opens its own, so a crash between
the two can leave a spent draft whose `based_on` is behind the version it just helped create.
That is not a new failure mode - every surface here already announces a draft moving underneath
a reader, and this is the same state reached by a different door.

## The rescue flow, when a class already exists

Creating a class whose name the published version already declares is **not** answered with
an error. It is answered with an offer: the annotator's add-a-class dialog says what that
class accepts today and what publishing would add to it, and its primary button reads
`Add polygon to "sign"`. Somebody typing a name that exists almost always wants to draw that
class as a shape it does not have yet, and the product can simply do that.

The widening carries the **existing** class's colour and attributes, not the form's: the
dialog was opened to make a new class, so publishing its blank colour would quietly wipe what
the class already declared. Only the geometries move. It goes out through the ordinary
`create_version` path, so it is an ordinary schema change - additive, needing no flag, and
producing the next version like any other.

Two collisions, and only one of them is an offer. A name typed twice in **one sitting** stays
a refusal: both entries are being written now, so merging them would be guessing which of the
two was meant.

Class names are still unique within a version, ignoring case. What changed is what the
interface does about it.

## Taking a geometry away asks about the shape, not the class

Removing one of a class's geometries is destructive — the contract narrows — so it needs
`allow_destructive`. Whether it is *refused outright* is a separate question, and it is asked at
the grain an annotation actually has: an annotation carries one class **and one shape**, so that
pair is what decides it.

A `car` accepting `bbox · polygon` whose labels are all boxes loses nothing when `polygon` goes,
and the publish goes through. The same change is refused, by the refusal no flag overrides, the
moment one `car` polygon exists — and the count in that refusal is the number of annotations
that would actually be orphaned, not the number the class holds.

Three kinds of narrowing, and they differ only in how much of a class they doom:

| The change | What it can orphan |
| --- | --- |
| a geometry removed from a class | annotations of that class carrying **that shape** |
| the class removed | every annotation of it, whatever shape |
| an attribute added as required, removed, or narrowed | every annotation of it, whatever shape |

The last two enumerate every shape the class *used to* declare, which is complete because an
annotation was validated against that declaration when it was written.

`preview` answers with the same set the publish will match on, so the warning a client shows
before it asks and the refusal it may get back cannot disagree.

## Export is unchanged

A format declares which geometries it can carry and which it carries reduced, and every
exporter branches on the geometry **an annotation** holds - never on its class. So a class
accepting two shapes needs no exporter change: YOLO writes its boxes whole and writes its
polygons as bounding boxes, COCO carries both, and the pre-export report names all of it
before anything is written. See [releases.md](releases.md).

The one thing that did move is the report's shape. It is now one row per `(class, geometry)`
rather than per class, because a class holding boxes and polygons is *two* answers under a
boxes-only format and a single row could only carry one of them - describing half its own
output wrongly whichever it picked.
