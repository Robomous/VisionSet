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
generic repository serves all fifteen entity types:

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
`uq_schema_project_version`, `uq_member_dataset_asset`, `uq_release_dataset_tag`,
`uq_asset_project_content_hash`, `uq_source_project_kind_path_fps` and
`uq_token_workspace_name`. The invariant then survives
a service bug, a forgotten code path, and a second process.

The last of those is the only index here whose terms are not all columns: its fourth is
`coalesce(json_extract(video, '$.extraction_fps'), 0)`. SQLite treats NULLs in a unique index as
distinct, so a nullable column would let every image directory collide with nothing at all — and
an index is not a query, so no service gains a JSON path from it. It is also one of the two that
could never use `checkfirst`, because SQLAlchemy cannot *reflect* an expression-based index — see
[Adding the second migration](#adding-the-second-migration) for what a migration does instead.

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
| Immutable nested values | JSON column — `annotation_schema.classes`, `annotation.geometry`, `annotation.attributes`, `release.split` | A schema version must rehydrate byte-identical, and nothing queries a single `LabelClass` in SQL. Child tables would only add ordering columns. |
| An immutable value too large for a row | The **blob store**, with the row keeping its hash — `release.manifest_hash`, `asset.thumbnail_hash` | A release manifest lists every asset and every label; megabytes of it in a column would have to be read just to list a dataset's releases. Content-addressed, so it is verifiable and two identical releases share one document. See [releases.md](releases.md). A thumbnail is the same storage decision for a different reason: it is a *cache*, so the row keeps a pointer that may be NULL and losing the bytes costs only the time to render them again. |
| Timestamps | TEXT holding ISO-8601 **with offset** | SQLite's `DATETIME` storage drops the timezone. Domain timestamps are timezone-aware UTC and a naive value is rejected at construction. |

Foreign keys are declared `ON DELETE CASCADE` — and the store issues
`PRAGMA foreign_keys = ON` for every connection, because SQLite ships with foreign keys
**off**. Without that pragma every constraint here would be decorative.

## Connection posture

Three settings, and they are applied in two different places for one reason:

| Setting | Where | Why there |
| --- | --- | --- |
| `PRAGMA foreign_keys = ON` | every connection | Per connection, and SQLite forgets it on close. Reads nothing, writes nothing. |
| `PRAGMA busy_timeout = 5000` | every connection | Likewise per connection. Configurable: `SqliteMetadataStore(path, busy_timeout_ms=…)`. |
| `PRAGMA journal_mode = WAL` | `initialize()` only | **Switching to WAL writes the file header.** |

That last row is the interesting one. WAL is recorded in the database header and persists, so
it only ever needs setting once — but turning it on *grows an empty file to a full page*, and
`WorkspaceService.open` reads `format_version` before it has decided the file is a workspace
at all. A connect-time pragma would therefore leave a 4 KB mark on any stranger's file merely
inspected, breaking the invariant that **`open` creates nothing when it refuses**. Setting it
in `initialize()` puts it exactly where the caller has already established the file is ours to
write to, and re-running it there is how a workspace written before WAL converts on its next
open. It also has to sit outside the migration transaction: SQLite refuses to change journal
mode inside one.

The consequences for callers are in
[workspaces.md § Concurrency, plainly](workspaces.md#concurrency-plainly): readers never
block, writers are serialized and wait up to the timeout, and a wait that runs out is
`WorkspaceBusy`.

### No SQLAlchemy exception escapes

Every `DatabaseError` the engine raises goes through one function in the adapter, and the
order of its tests is the dispatch:

| SQLAlchemy raises | Becomes | Because |
| --- | --- | --- |
| `IntegrityError` | `ConstraintViolated` | A constraint refused the write. Ends the transaction. |
| `OperationalError` with a `SQLITE_BUSY` / `SQLITE_LOCKED` result code | `WorkspaceBusy` | Contention. Transient — retry. |
| any other `DatabaseError`, including the rest of `OperationalError` | `WorkspaceCorrupt` | Cannot open the file, disk I/O error, disk full, not a database. Waiting will not fix it. |

Contention is told apart from damage by SQLite's **result code** (`sqlite_errorname`), not by
the wording of the message, so a reworded SQLite release cannot silently reroute a lock into
`WorkspaceCorrupt`. `WorkspaceCorrupt` is the widest of the three deliberately: it is where
everything unusable-for-a-reason-you-cannot-wait-out lands, and splitting it further would
invent errors nobody catches.

`CASCADE` is the rule because the child is normally *part of* the parent. `ingest_job.batch_id`
is the exception and states the other case: a run is a record of work done, not a child of the
batch it filled, so deleting the batch nulls the link rather than erasing the run. The same
argument applies to `asset.source_id` — a source is a receipt and an asset is data — except that
one is not a foreign key at all: SQLite spells a key added by `ALTER TABLE` inline on the column
while `create_all` spells one as a table constraint, the two texts differ, and `asset` is the one
table that could not be rebuilt to escape that (four cascading children, and rows that were
legitimately already there). It is documented on the column, and a future `SourceService.delete`
has to clear it by hand.

## Migrations and `format_version`

There is no alembic. A local-first, single-file, single-writer store does not need a
migration framework, and adding one would mean keeping `format_version` in sync with a
second ledger by hand. Instead:

```python
MIGRATIONS: list[Migration] = [
    Migration(version=1, name="baseline_schema", upgrade=_create_baseline_schema),
    Migration(version=2, name="batch_lineage", upgrade=_add_batch_lineage),
    Migration(version=3, name="annotation_provenance", upgrade=_add_annotation_provenance),
    Migration(version=4, name="job_queue", upgrade=_add_job_queue),
    Migration(version=5, name="schema_provenance", upgrade=_add_schema_provenance),
]
FORMAT_VERSION: int = MIGRATIONS[-1].version  # 5
```

**Generation 1 is the baseline, and everything after it is an ordinary migration.** A long
chain of generations got this schema to its present shape while VisionSet was unreleased.
Every database they could have upgraded was disposable test data inside this repository, so
what they actually bought was an idempotency argument and an undo line per generation, plus
the scaffolding needed to prove each one had really run — the last of which went wrong twice
and was caught twice. They are gone. `_tables.py` **is** generation 1, and a fresh database
is created directly at it; the chain restarted from there, and the three rules below are in
force again for every entry appended after the baseline.

**A column-adding migration must also be undone in `_at_generation_one`**, the helper in
`tests/kernel/test_migrations.py` that builds an old-looking file. The failure is the silent
kind: a column left in place makes its own migration find the column already there and return
early, so `test_a_fresh_database_and_a_migrated_one_have_the_same_schema` compares a file
against itself and passes while proving nothing. Migration 4 is the standing exception — it
creates a *table*, and dropping that in the helper would exercise SQLite rather than this
module.

**There are no downgrade paths, deliberately.** Nothing walks a file backwards and the
tests no longer do either. A downgrade is a compatibility promise and a promise is owed
to somebody: it comes back when there is a published release whose files this build has
to keep opening, and not before. That is the trigger to watch for — the first tagged
release that a user's workspace can outlive.

`initialize()` reads the version stamped in `_visionset_meta` and runs whatever is
missing:

| Stored | What happens |
| --- | --- |
| absent | every migration runs; the file is stamped at `FORMAT_VERSION` |
| equal to `FORMAT_VERSION` | nothing — `initialize()` is idempotent |
| lower | the pending migrations run; the file is restamped |
| higher | `WorkspaceFormatTooNew` — migrations only run forward |
| not a readable database | `WorkspaceCorrupt` |
| held by another writer past the timeout | `WorkspaceBusy` |

`initialize()` also switches the file to WAL, for the reason given under
[Connection posture](#connection-posture).

### The stamp is a claim, and it is checked

Every row of that table rests on one rule: **a schema change arrives with a version to go
with it.** Nothing enforces the rule, and with a single baseline every workspace anybody
creates carries the same number forever — so the second row above, "nothing", is also what
a file that missed a column gets. `create_all` will not repair it: it creates missing
*tables*, leaves an existing one exactly as it found it, and in any case only runs while
something is pending, which on an already-stamped file is nothing. The file opens as
current and the first statement naming the absent column fails inside a request.

That happened ([#277](https://github.com/Robomous/VisionSet/issues/277)): a workspace
missing `source.display_name` opened cleanly and answered **500 `WORKSPACE_CORRUPT`** —
opaque, from three unrelated routes, with the cause only in the server's log.

So after the migrations, `initialize()` compares the reflected schema against
`Base.metadata` and raises **`WorkspaceSchemaMismatch`** naming the first missing table or
column. Three things about it are deliberate:

- **Only *missing* is a mismatch.** A file holding more than `_tables` declares was written
  by a later build; nothing here selects a column it does not name, so the extra one is
  inert, and the version stamp is what is supposed to catch that direction anyway.
- **It is not a `WorkspaceCorrupt`.** Nothing is damaged — this is a valid database of a
  different generation, and "corrupt" sends the reader to look at their disk.
- **It runs on its own connection, after the migrations commit.** Inside that transaction a
  raise would roll back the schema a fresh file had just been given.

It runs on every open, fresh ones included, which is what makes a disagreement between
reflection and `_tables` fail one named test rather than every workspace this build creates.

### Adding the second migration

Append a `Migration` with the next version and an `upgrade` taking a live `Connection`.
Never edit an existing migration — a workspace already stamped at that version will never
run it again. `FORMAT_VERSION` is derived from the list, so it cannot drift.

Four rules come back into force with that second migration. None of them applies to a
lone baseline, which is exactly why they are written down here rather than left in the
history of the deleted code:

**It must be idempotent.** Migration 1 is `create_all` of *today's* metadata, not a frozen
snapshot: adding a table, column or index to `_tables` retroactively changes what a fresh
database gets. So a later migration exists only for already-stamped databases, and yet it
still runs against the fresh one that already carries its change. Share the one schema
object with `_tables` rather than repeating the DDL — `checkfirst=True` on a `Table` or an
`Index`, an inspector check for a column (SQLite has no `ADD COLUMN IF NOT EXISTS`), and
`CreateColumn` / `CreateIndex` to compile the DDL from the object itself.

**SQLAlchemy cannot reflect a partial or expression-based index**, so `checkfirst` reports
one absent and re-issues a `CREATE` that then fails on every fresh database. Those ask
SQLite instead, via `CreateIndex(index, if_not_exists=True)`. Two indexes here are in that
category: `uq_source_project_kind_path_fps` (its fourth term is
`coalesce(json_extract(video, '$.extraction_fps'), 0)`) and
`uq_annotation_asset_classification` (partial, on the tag geometry).

**A column arriving by `ALTER` is declared last on its row class**, because SQLite appends
it. Anywhere else, the `create_all` path and the migration path emit different
`CREATE TABLE` text and a workspace's schema depends on when it was created. A `NOT NULL`
column added this way also needs a `server_default`, because SQLite refuses to add one
without a value for the rows already there — `annotation_job_asset.position`,
`annotation.attributes` and `ingest_job.processed` carry one for that reason and keep it.

**A column carrying a foreign key cannot arrive by `ALTER` at all.** SQLite spells an added
key inline on the column; `create_all` spells one as a table constraint; the two texts
differ. Such a column needs a table rebuild — and under `PRAGMA foreign_keys = ON`, which
this store sets on every connection, `DROP TABLE` runs an implicit `DELETE` that cascades
to children **silently, without raising**. So a rebuild has to count the children first,
and a table that holds real rows cannot be rebuilt at all. `asset` is the standing example
of the second case: four `ON DELETE CASCADE` children and data nobody may lose, which is
why `asset.source_id` is the one reference in this schema that is not a foreign key.

`format_version` here is the *database* generation. Validating the on-disk workspace layout
around it — directories, the blob-store root, what makes a directory a workspace at all —
belongs to `WorkspaceService`; see [workspaces.md](workspaces.md).

### What the tests still guard

`tests/kernel/test_migrations.py` kept the machinery and dropped the per-generation cases.
What remains is what a second migration will be judged against:

- `_schema()`, which normalizes every `CREATE` statement SQLite has on file. This is the
  comparison that caught a column declared in the wrong position, and it is the piece that
  would otherwise be rewritten from memory under time pressure.
- `test_two_fresh_databases_have_the_same_schema` — today only a determinism check, since
  with one baseline both paths coincide. It becomes the fresh-versus-migrated comparison
  again as soon as there is something to migrate.
- `test_running_every_migration_again_changes_nothing`, which now covers the baseline
  rather than starting at `MIGRATIONS[1:]`.
- `test_the_baseline_carries_each_uniqueness_index`, because a service-level uniqueness
  rule with no index under it is a wish, and nothing else asserts the indexes exist.
- `test_the_newest_columns_are_declared_last_on_their_row_class`, which pins the declared
  tail of `annotation_schema` so that the first migration to append a column there has a
  recorded order to extend rather than a schema only ever compared to itself.
