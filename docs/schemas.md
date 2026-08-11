# Annotation schemas

A schema is a project's ontology: which classes it labels, what shape each one takes, and
what extra information a label carries. It is what the previous system called the "task
type", except that a task type was fixed for the life of a project and a schema is not —
it is **versioned**, and every version is immutable.

`SchemaService` owns that lifecycle, and it is the **only** way a version comes into
existence. `ProjectService` deliberately does not seed one, so a project starts without an
ontology and gets version 1 the moment somebody decides what it labels.

```python
from visionset.kernel.domain import Attribute, GeometryType, LabelClass
from visionset.kernel.services import ProjectService, SchemaService, WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    project = ProjectService(workspace).create("Speed limits")
    schemas = SchemaService(workspace)

    sign = LabelClass(
        name="sign",
        geometry=GeometryType.BBOX,
        attributes=[
            Attribute(name="occluded", kind="boolean", default=False),
            Attribute(name="weather", kind="select", options=["dry", "wet"]),
        ],
    )
    lane = LabelClass(name="lane", geometry=GeometryType.POLYGON)

    schemas.create_version(project.id, [sign, lane])  # → version 1

    schemas.get_active(project.id)  # the highest version
    schemas.get(project.id, 1)  # any version, forever
    schemas.list_versions(project.id)  # oldest first
    schemas.allowed_geometries(project.id)  # {BBOX, POLYGON}
```

**Over HTTP:** `POST`/`GET /projects/{project_id}/schema/versions`,
`GET /projects/{project_id}/schema/versions/{version}`, and `GET /projects/{project_id}/schema`
for the version in force. Narrowing needs `?allow_destructive=true`, exactly as
`allow_destructive=` does here. `compare` has one too:
`GET /projects/{project_id}/schema/compare?from={n}&to={m}` returns the classification below,
which is what a version history renders and what a client reads before deciding whether it needs
the flag. `allowed_geometries` still has no route — it gets one when a surface needs it. See
[api.md](api.md).

**Over MCP:** `get_schema`, `create_schema_version`, `compare_schema_versions` and
`preview_schema_change`. The second-to-last is what an agent reads before `repin_batch`
([batches.md](batches.md)); the last is
`preview`'s first caller anywhere: plan-before-apply matters most for the surface that cannot see
the consequences of a change until it has made one, so an agent gets the diff before it decides
whether it needs `allow_destructive`. See [mcp.md](mcp.md).

## Versions are 1..N, and none of them changes

The next version is one past the highest stored, so the numbers have no gaps and no reuse.
`create_version` always **inserts** — there is no `update` and no `delete` on this service —
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

Creating a version identical to the active one is allowed. Versions are cheap, and refusing
a no-op would need an equality rule that then has to defend itself against reordered
attributes and changed colors.

Schema rows are deleted only as part of deleting their project, through the database's
`ON DELETE CASCADE` — see [projects.md](projects.md).

## A version says why it exists, and when

```python
schemas.create_version(project.id, classes, description="split 'vehicle' into car and truck")
```

`description` is the version's **commit message**, and `created_at` is stamped by the
service at publish. Together they are what makes a version history readable as history
rather than as a pile of class lists.

**The description is written once and can never be edited.** That is not a missing feature —
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

A blank description is legal and stored as `None` — an empty commit message is an ordinary
thing to publish, so this is not [`normalize_name`](../src/visionset/kernel/domain/names.py)
and it does not refuse. What it *does* borrow from that rule is the tidying: NFC-normalized
and stripped, in a validator on the domain model, so no door can write an untidied one.

**`description` is `None` when nobody wrote one, and nothing invents one.** `created_at` is
stamped by `SchemaService` at publication, which is the only moment that can answer it
honestly — a timestamp taken anywhere else names when somebody ran something, not when the
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

**Absent is not a third kind — it means nobody said**, and a reader groups it with `curated`.
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
A project with no schema yet raises `SchemaNotFound` — that is the ordinary starting state,
not damage.

## Geometries a class may use

`GeometryType` names eight geometries; four have a model in the `Geometry` union today —
`bbox`, `polygon`, `polyline` and `classification_tag`.
`IMPLEMENTED_GEOMETRIES` is read *off* the union, so shipping a variant widens it with no
second edit, and `create_version` refuses anything outside it:

```python
LabelClass(name="road", geometry=GeometryType.MASK)  # constructs fine
schemas.create_version(project.id, [that])  # UnsupportedGeometry
```

Declaring a class whose geometry has no implementation would create a class nobody could
ever label. Refusing at the schema is better than discovering it at the first annotation.

**`polyline` is the one that is writable before it is drawable.** It joined the union in
#223 so that lane datasets work end to end — the SDK, the REST API and MCP all accept one,
`visionset.formats.lanes` exports five lane formats from it, and the annotator renders and
reviews them. What does not exist yet is an interactive tool for *drawing* a lane; that is
0.2. A polyline class is therefore a perfectly ordinary class that an agent or a script
fills in and a person checks, which is the workflow it was added for.

### The categories a picker groups them by

The eight fall into two families, and the grouping is **presentation only** — the kernel has
no category concept and takes none (#375). "Basic Computer Vision" holds the geometries an
ordinary image task produces: `bbox`, `polygon`, `mask`, `keypoints` and
`classification_tag`. "Robotics and AD" holds the ones that describe a scene the camera
alone does not give you — `polyline` for lanes today, and the reserved `cuboid_3d` and
`polyline_3d`.

The map lives in `frontend/ui-core/src/data/geometryCategory.ts`, declared total over the
generated `GeometryType` union so a ninth member fails the frontend build until somebody
categorises it. Nothing on the wire carries a category, and an exporter's capability
declaration never names one: `supported_geometries` is per geometry, because a lane exporter
supports `polyline` and has said nothing at all about `cuboid_3d`.

`allowed_geometries` is the flip side, derived the same way: the set of geometries a
version's classes are bound to. It is what an annotation's `geometry.type` is
membership-tested against — the union's discriminator values *are* `GeometryType` members,
so nothing translates in between.

## Additive versus destructive

One question draws the line: **does an annotation that was valid under the previous version
stay valid under this one?**

| Change | Kind |
| --- | --- |
| Class added | additive |
| Class removed | **destructive** |
| Class renamed | **destructive** (a removal) plus an addition |
| Class geometry changed | **destructive** |
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
beside `car` is two classes that read as one to everybody except the code.

The classifier lives in `kernel/domain/schema_diff.py` and is pure — two sequences in, a
verdict out. `preview` runs it against the active version without writing, so a surface can
warn before it asks:

```python
diff = schemas.preview(project.id, proposed)
diff.is_destructive  # True
diff.destructive_classes  # frozenset({'lane'})
diff.describe(ChangeKind.DESTRUCTIVE)  # "class 'lane' removed"
```

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

The second gate has no flag at all:

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

The order matters — the missing flag is reported before the labels are counted. The first
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
value a surface should offer when it does not. They are independent — a required attribute
with a default is an ordinary, useful thing.

Per-value validity is the model's, enforced in `kernel/domain/schema.py`, so a malformed
attribute cannot be constructed at all and never reaches a service:

- a `select` needs at least one option, with no repeats; nothing else may carry options;
- a `default` must match its own kind, and a `select` default must be one of its options;
- names are stripped and never blank, and one class cannot carry two attributes whose names
  differ only by case.

Rules that need the *whole* version — duplicate class names, an unimplemented geometry —
are `SchemaService`'s, and both raise `InvalidSchema` (`UnsupportedGeometry` is a subclass,
so one `except` covers every way a version can be malformed).

What is validated here is attribute **definitions**. Attribute **values** are validated
somewhere else and at a different time: at annotation write time, by `AnnotationService`,
against the version the annotation's batch pinned at approval — not against the project's
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
      "geometry": "bbox",
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
to keep honest, and two shapes that can disagree — while the surface a schema file has to
interoperate with speaks JSON already. `yq . schema.yaml | visionset schema apply /dev/stdin` is one
pipe away for whoever wants one.

**The document parses through the domain models themselves**, so `LabelClass`'s and `Attribute`'s
own validators do the refusing and no rule here is restated in the CLI. Those refusals are **exit
2**, not 1: a pydantic `ValidationError` is not a `VisionSetError`, and a malformed file is a usage
error in the same sense a malformed request body is a 422. The message carries the domain's own
words and the path to the offending field (`classes.0.name`).

`--allow-destructive` is the flag for the first of the two gates above. The second — a change that
would orphan annotations — has no flag, here as everywhere.

## Concurrency

The next version number is computed from the versions already stored, so two writers can
agree on it. The unique index on `(project_id, version)` refuses the second, and the service
translates that into `SchemaVersionConflict`. The remedy is to retry, which re-reads the
maximum and lands on the version after.

The translation happens **outside** the `unit_of_work` block: a constraint violation ends
its transaction, so it cannot be caught and recovered from inside one. Any other constraint
travels on unchanged — it is not this service's to reinterpret. See
[persistence.md](persistence.md).


## In the browser

`@visionset/ui-core`'s schema editor is the surface over everything above, and the
two rules it exists to honour are the two on this page: a version is **immutable**,
so the editor drafts and publishes N+1 rather than saving in place; and the two
refusals are **both 409** with only one override between them, so it branches on the
`code` and shows "Save anyway" for `DESTRUCTIVE_SCHEMA_CHANGE` and nothing but
"Close" for `SCHEMA_CHANGE_WOULD_ORPHAN`.

It has no preview of the change being drafted, because `SchemaService.preview` is unrouted;
`compare` is routed, and the version navigator uses it to show what two *published* versions did
to each other. See [ui.md](ui.md#the-schema-editor-and-the-two-409s).
