# Persistence

One workspace is one SQLite file. `SqliteMetadataStore` is the default
`MetadataStore` adapter; everything above it — services, the REST surface, the CLI —
talks to the **port**, never to SQLAlchemy.

```
kernel/ports/metadata_store.py     Repository[T], UnitOfWork, MetadataStore — no SQL
kernel/adapters/_tables.py         SQLAlchemy tables (private)
kernel/adapters/_mappers.py        row <-> pydantic translation (private)
kernel/adapters/migrations.py      the ordered migration list
kernel/adapters/sqlite_metadata_store.py
```

`kernel/adapters/__init__.py` exports only `SqliteMetadataStore`, so no SQLAlchemy type
appears in a domain or port signature. If you find yourself wanting one there, the
mapping layer is the thing to extend.

## The repository contract

Every persisted entity has a UUID primary key and **at most one parent** — a Project
belongs to a Workspace, an Annotation to an Asset. That regularity is why a single
generic repository serves all fourteen entity types:

```python
with store.unit_of_work() as uow:
    project = uow.projects.add(Project(workspace_id=workspace.id, name="road-signs"))
    assets = uow.assets.list(project.id)  # scoped by the one parent FK
```

- `add` raises `EntityAlreadyExists` on a primary-key collision; `update` raises
  `EntityNotFound`. They are deliberately not one upsert — a service that inserts a
  duplicate or updates something deleted has a bug and should hear about it.
- `delete` returns `False` rather than raising when there was nothing to remove.
- `list(parent_id)` on `workspaces` — the one root entity — raises `ValueError`.
- Ordering is insertion order (SQLite's implicit `rowid`).

Uniqueness beyond the primary key (project names, schema versions) is a **service**
concern. The store persists shapes; it does not know the rules.

## Unit of work

The transaction boundary is one operation on a Project aggregate:

```python
with store.unit_of_work() as uow:
    ...  # everything here commits together
```

Clean exit commits; any exception rolls the whole block back. A batch approval that
partitions into jobs must never leave half its jobs behind, which is why the scope is
the operation and not the individual write.

## What is a column, what is a table, what is JSON

| Kind | Storage | Why |
| --- | --- | --- |
| Relations that get mutated element by element | Child table — `batch_asset`, `annotation_job_asset` | Membership and per-asset progress are edited one row at a time and queried from the asset side. `batch_asset.position` preserves order. |
| Immutable nested values | JSON column — `annotation_schema.classes`, `annotation.geometry`, `release.manifest` | A schema version must rehydrate byte-identical, and nothing queries a single `LabelClass` in SQL. Child tables would only add ordering columns. |
| Timestamps | TEXT holding ISO-8601 **with offset** | SQLite's `DATETIME` storage drops the timezone. Domain timestamps are timezone-aware UTC and a naive value is rejected at construction. |

Foreign keys are declared `ON DELETE CASCADE` — and the store issues
`PRAGMA foreign_keys = ON` for every connection, because SQLite ships with foreign keys
**off**. Without that pragma every constraint here would be decorative.

## Migrations and `format_version`

There is no alembic. A local-first, single-file, single-writer store does not need a
migration framework, and adding one would mean keeping `format_version` in sync with a
second ledger by hand. Instead:

```python
MIGRATIONS: list[Migration] = [
    Migration(version=1, name="initial_schema", upgrade=_create_initial_schema),
]
FORMAT_VERSION: int = MIGRATIONS[-1].version
```

`initialize()` reads the version stamped in `_visionset_meta` and runs whatever is
missing:

| Stored | What happens |
| --- | --- |
| absent | every migration runs; the file is stamped at `FORMAT_VERSION` |
| equal to `FORMAT_VERSION` | nothing — `initialize()` is idempotent |
| lower | the pending migrations run; the file is restamped |
| higher | `WorkspaceFormatTooNew` — migrations only run forward |

**Adding migration 002:** append a `Migration` with the next version and an `upgrade`
taking a live `Connection`. Never edit an existing migration — a workspace already
stamped at that version will never run it again. `FORMAT_VERSION` is derived from the
list, so it cannot drift.

`format_version` here is the *database* generation. Validating the on-disk workspace
layout around it (directories, blob-store root) belongs to `WorkspaceService`.
