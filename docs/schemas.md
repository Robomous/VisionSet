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
`allow_destructive=` does here. `preview`, `compare` and `allowed_geometries` have no route yet —
they will get one when a surface needs them. See [api.md](api.md).

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

## The active version is derived, not stored

`get_active` returns the highest version. There is no `active` column, because the version
numbers already carry that fact and a second copy of it is one more thing to keep in sync.
A project with no schema yet raises `SchemaNotFound` — that is the ordinary starting state,
not damage.

## Geometries a class may use

`GeometryType` names eight geometries; three have a model in the `Geometry` union today.
`IMPLEMENTED_GEOMETRIES` is read *off* the union, so shipping a variant widens it with no
second edit, and `create_version` refuses anything outside it:

```python
LabelClass(name="road", geometry=GeometryType.MASK)  # constructs fine
schemas.create_version(project.id, [that])  # UnsupportedGeometry
```

Declaring a class whose geometry has no implementation would create a class nobody could
ever label. Refusing at the schema is better than discovering it at the first annotation.

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
and an annotation's parent is its asset. That is N + 1 reads, and deliberately so at M1
scale — when it starts to cost, the fix is a method on the port, never a SQLAlchemy import
in a service.

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
