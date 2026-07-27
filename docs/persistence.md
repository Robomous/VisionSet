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
- Any write may raise `ConstraintViolated` — a missing parent, or a uniqueness rule the
  store enforces. **A violation ends the transaction it happened in**, so it cannot be
  caught and recovered from inside a unit of work. A service that needs a friendly error
  has to check before writing, not translate afterwards.

## Uniqueness

The *rule* — which name, what counts as equal, which error the caller sees — is a service
concern. The store does not know that project names are compared case-insensitively, and it
never raises `ProjectNameTaken`.

But a rule with no backstop is a wish, so the store carries the constraint too:
`uq_project_workspace_name` on `project (workspace_id, name COLLATE NOCASE)`, alongside
`uq_schema_project_version` and `uq_member_dataset_asset`. The invariant then survives a
service bug, a forgotten code path, and a second process.

The two layers reach different distances on purpose. `COLLATE NOCASE` folds ASCII only;
`WorkspaceService` compares with Unicode `casefold` over an NFC-normalized, stripped string.
The service is stricter, never looser, so nothing slips past it into a state the index would
have allowed. See [workspaces.md](workspaces.md) for the full rule.

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
| Immutable nested values | JSON column — `annotation_schema.classes`, `annotation.geometry`, `annotation.attributes`, `release.manifest` | A schema version must rehydrate byte-identical, and nothing queries a single `LabelClass` in SQL. Child tables would only add ordering columns. |
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
    Migration(version=2, name="project_name_unique_per_workspace", upgrade=...),
    Migration(version=3, name="batch_schema_version_pin", upgrade=...),
    Migration(version=4, name="annotation_job_asset_position", upgrade=...),
    Migration(version=5, name="annotation_attributes", upgrade=...),
]
FORMAT_VERSION: int = MIGRATIONS[-1].version  # 5
```

`initialize()` reads the version stamped in `_visionset_meta` and runs whatever is
missing:

| Stored | What happens |
| --- | --- |
| absent | every migration runs; the file is stamped at `FORMAT_VERSION` |
| equal to `FORMAT_VERSION` | nothing — `initialize()` is idempotent |
| lower | the pending migrations run; the file is restamped |
| higher | `WorkspaceFormatTooNew` — migrations only run forward |
| not a readable database | `WorkspaceCorrupt` |

`OperationalError` — "database is locked", "unable to open database file" — is deliberately
*not* translated. Those are environmental, not structural, and calling them corruption would
be a lie. It is a known gap: a SQLAlchemy exception can still escape on a locked file.

**Adding a migration:** append a `Migration` with the next version and an `upgrade` taking a
live `Connection`. Never edit an existing migration — a workspace already stamped at that
version will never run it again. `FORMAT_VERSION` is derived from the list, so it cannot
drift.

**Every migration after the first must be idempotent.** Migration 001 is `create_all` of
*today's* metadata, not a frozen snapshot: adding a table, column or index to `_tables`
retroactively changes what a fresh database gets. So a later migration exists only for
already-stamped databases, and yet it still runs against the fresh one that already has its
change. Migration 002 is the worked example — it creates the project-name index with
`checkfirst=True`, and it shares the one `Index` object with `_tables` rather than repeating
the DDL, so the fresh path and the upgrade path cannot drift apart.
`test_a_fresh_database_and_a_migrated_one_have_the_same_schema` proves they agree.

A **column** has no `checkfirst`, and SQLite has no `ADD COLUMN IF NOT EXISTS`, so migrations
003, 004 and 005 ask the inspector instead — that check *is* their idempotency. They still
compile the DDL from the `Column` object in `_tables` (via `CreateColumn`) rather than typing
the type out, for the same anti-drift reason. A column arriving by `ALTER` and declared
`NOT NULL` also needs a `server_default`, because SQLite refuses to add one without a value for
the rows already there — `annotation_job_asset.position` and `annotation.attributes` both carry
one, where `batch_asset.position`, which was there from migration 001, does not.

And a column arriving by `ALTER` must be declared **last** on its row class, because SQLite
appends it: `batch.schema_version`, `annotation_job_asset.position` and `annotation.attributes`
all sit at the end of their tables for that reason alone. Declared anywhere else, the
`create_all` path and the `ALTER` path emit different `CREATE TABLE` text and the
fresh-versus-migrated test fails — which is exactly what it is for.

The fresh-versus-migrated test is only as strong as how far back
`_downgrade_to_version_one` walks, so every migration added there needs its undo added too.

`format_version` here is the *database* generation. Validating the on-disk workspace layout
around it — directories, the blob-store root, what makes a directory a workspace at all —
belongs to `WorkspaceService`; see [workspaces.md](workspaces.md).
