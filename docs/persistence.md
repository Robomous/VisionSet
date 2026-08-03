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
an index is not a query, so no service gains a JSON path from it. It is also the one index that
cannot use `checkfirst`, because SQLAlchemy cannot *reflect* an expression-based index; migration
008 issues `CREATE UNIQUE INDEX IF NOT EXISTS` compiled from the same `Index` object instead.

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
    Migration(version=1, name="initial_schema", upgrade=_create_initial_schema),
    Migration(version=2, name="project_name_unique_per_workspace", upgrade=...),
    Migration(version=3, name="batch_schema_version_pin", upgrade=...),
    Migration(version=4, name="annotation_job_asset_position", upgrade=...),
    Migration(version=5, name="annotation_attributes", upgrade=...),
    Migration(version=6, name="release_manifest_pointer", upgrade=...),
    Migration(version=7, name="source_provenance", upgrade=...),
    Migration(version=8, name="ingest_pipeline", upgrade=...),
    Migration(version=9, name="ingest_job_progress", upgrade=...),
    Migration(version=10, name="asset_thumbnail", upgrade=...),
    Migration(version=11, name="api_tokens", upgrade=...),
    Migration(version=12, name="one_classification_tag_per_asset_and_class", upgrade=...),
    Migration(version=13, name="asset_ingested_at", upgrade=...),
    Migration(version=14, name="schema_description_and_created_at", upgrade=...),
]
FORMAT_VERSION: int = MIGRATIONS[-1].version  # 14
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
| held by another writer past the timeout | `WorkspaceBusy` |

`initialize()` also switches the file to WAL, for the reason given under
[Connection posture](#connection-posture).

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
all sit at the end of their tables for that reason alone, and migration 008 put
`asset.format`, `asset.source_id`, `asset.frame_index` and `asset.frame_timestamp` there too.
`source` is exempt — migration 007 rebuilds it from `_tables` rather than altering it, so both
paths run the same `CREATE TABLE` and the rule has nothing to bite on — but **that exemption
expires for any column added after 007**, because a database this build wrote is already stamped
at 7 and will never re-run it. Declared anywhere else, the
`create_all` path and the `ALTER` path emit different `CREATE TABLE` text and the
fresh-versus-migrated test fails — which is exactly what it is for.

Migration 009 is where that expiry actually bit. `ingest_job` was rebuilt by 008, so its column
order was free *then*; by 009 the table holds real rows and its four new columns —
`batch_name`, `processed`, `total`, `failures` — arrive by `ALTER` and sit last, in the order
the migration adds them. That path has a test of its own
(`test_migration_nine_alters_a_table_migration_eight_rebuilt`), because the fresh-versus-migrated
test walks back to generation 1, from where 008 re-creates the table whole and 009 finds its
columns already present. A migration whose only exercise is through an earlier rebuild is not
exercised at all.

**A column that carries a foreign key cannot arrive by `ALTER` at all.** SQLite spells an added
key inline on the column; `create_all` spells one as a table constraint. The two texts differ, so
the fresh-versus-migrated test fails — and dropping the key instead is not free either.
Migration 008 met this twice and answered it twice: `ingest_job` was **rebuilt** so `batch_id`
could keep a real key (no children, provably empty), while `asset.source_id` was added without
one, because `asset` has four cascading children and rows that were legitimately already there.
SQLite also refuses to *drop* such a column, which is why the undo in
`_downgrade_to_version_one` rebuilds `ingest_job` rather than altering it.

**Migrations 006 and 007 drop a table**, and the bar they had to clear is worth writing down.
`release` gained three `NOT NULL` columns with no honest default — an `ALTER` would have baked
`manifest_hash DEFAULT ''` into every fresh database forever — and, decisively, a pre-#12 release
row carries its manifest as a JSON column with *no blob behind it*, so there is no value
`manifest_hash` could be given that `verify` would ever accept. `source` is the same shape of
argument twice over: `registered_at` is `NOT NULL` with no honest default, and a pre-#18 row's
`kind` reads `'local_folder'`, which is not a value `SourceKind` has — those rows would come back
as validation errors rather than as sources. Adding the columns would have manufactured rows that
are broken by construction. Both are idempotent the same way 003–005 are (an inspector check for
the new column), and the emptiness each relies on is **checked** rather than argued: a workspace
that somehow holds such a row raises `WorkspaceCorrupt` instead of being quietly emptied. A
migration that would lose real data does not clear this bar.

Migration 007 carries one extra obligation that 006 did not. `ingest_job.source_id` is
`ON DELETE CASCADE`, and this store sets `PRAGMA foreign_keys = ON` for every connection — so
`DROP TABLE source` runs an implicit `DELETE FROM source` that takes the ingest jobs with it,
**silently, without raising**. A rebuild of a table with children has to count the children too.
`release` had none, which is why the precedent alone was not enough.

Migration 008 is the worked example of the **other** answer to that question. `asset` has four
cascading children *and* rows that are perfectly legitimate — M1's example wrote assets through
the same public port a service uses — so there is nothing to refuse and nothing that could be
dropped. It alters instead, and every column it adds is nullable and honest: NULL means "this row
predates the ingest pipeline", where a `server_default` would invent a format nobody probed. What
it does refuse is data its two new unique indexes cannot accept, counted before either index is
created so an `IntegrityError` never escapes `initialize()`.

Migration 009 is the plainest in the file, and the plainness is the point after 008: four
columns, none carrying a foreign key, so `ALTER` can express all of them — and every one has an
honest value for a row written before it. A pre-#19 run counted nothing and reported nothing,
which is exactly what `0` and `[]` say; NULL is what a run that named no batch meant. So unlike
006, 007 and 008 it refuses nothing and drops nothing. `failures` is a JSON column rather than a
child table on the criteria above: a per-file report is an immutable value read whole, and
nothing queries a single failed file in SQL.

Migration 010 is plainer still: one nullable column, `asset.thumbnail_hash`, pointing at a cached
preview in the blob store. No foreign key, so 008's "a column carrying a key cannot arrive by
`ALTER` at all" limit does not bite, and no data pre-check to make — the column is a *cache*, so
NULL is not a legacy value something has to tolerate but the ordinary state of an asset nobody
has rendered a preview for yet. `IngestService.backfill_thumbnails` reads exactly that state.

Migration 011 is the first since 001 to create a **table** rather than alter one, and that
changes which tool does the idempotency: `checkfirst=True` on the `Table` asks `has_table`, a
plain catalogue lookup, and brings both of `token`'s indexes with it — so neither is issued
separately and 008's expression-index trap cannot be met here at all. Nothing to refuse and
nothing to count, which is a claim rather than an oversight: the table existed on no earlier
generation, so there is no legacy row to be honest about, and nothing references it, so
`PRAGMA foreign_keys = ON` has nothing to cascade.

The fresh-versus-migrated test is only as strong as how far back
`_downgrade_to_version_one` walks, so every migration added there needs its undo added too.
Migrations 006 and 007 are the two places that undo cannot borrow its DDL from `_tables`,
because `_tables` no longer describes the shape it is restoring. Migration 009 is the one
place that needs no undo of its own: its columns live on `ingest_job`, which 008's undo rebuilds
from scratch, so restoring the generation-1 shape removes them along with everything else.
Migration 010 gets no such ride and has its own `DROP COLUMN` line — `asset` is only ever
altered, for the reasons 008 gives, so nothing later rebuilds it. The compensation is that 010's
real `ALTER` runs on the way back up from generation 1, which is why it needs no generation twin
of `test_migration_nine_alters_a_table_migration_eight_rebuilt`.

Migration 011's undo is a single `DROP TABLE`, and it carries a sharper obligation than 010's:
**without it the fresh-versus-migrated test would still pass.** The table would simply survive the
downgrade and 011 would `checkfirst`-skip, so the `CREATE` nobody ran would be reported as
agreeing with itself. The undo is not what keeps an existing test honest — it is the only thing
that exercises the migration at all.

`format_version` here is the *database* generation. Validating the on-disk workspace layout
around it — directories, the blob-store root, what makes a directory a workspace at all —
belongs to `WorkspaceService`; see [workspaces.md](workspaces.md).

## Migration 12 — one classification tag per (asset, class)

`FORMAT_VERSION` moves to **12**, the first time since #25 and the only move M6
expects. It adds a **partial, expression-based** unique index on
`annotation (asset_id, label_class)` restricted to
`json_extract(geometry, '$.type') = 'classification_tag'`.

Partial because the rule is about tags and nothing else: two boxes under one class
are two facts, and two tags of one class are the same statement twice.

Expression-based, so #20's trap applies for the second time — SQLAlchemy can reflect
neither a partial nor an expression index, so `checkfirst` reports it absent and
re-issues the `CREATE`, which fails on every fresh database. The migration uses
`CreateIndex(..., if_not_exists=True)` and asks SQLite instead, with the DDL still
compiled from the one `Index` object in `_tables.py`.

**The backfill collapses rather than refusing.** Migration 6's precedent — count and
raise `WorkspaceCorrupt` — was right for a table nobody could have written to yet.
Duplicates were legal before this migration, so refusing would leave a workspace
unopenable with a remedy its owner cannot apply. The survivor is the
lexicographically smallest `id`: arbitrary by construction, and deterministic, which
is the property that matters when two machines migrate the same copy.

## Migration 14 — a schema version says why it exists, and when

`FORMAT_VERSION` moves to **14**. Two nullable columns on `annotation_schema`:
`description` TEXT and `created_at` TEXT (ISO-8601 with offset, the timestamps rule
in `_tables.py`). Both land together because they answer the same question from two
sides, and splitting them would mean two `ALTER` passes over one table for one
feature.

Migration 13's shape: an alter-only table, so both columns are declared **last** on
`AnnotationSchemaRow` — SQLite appends an added column, and anywhere else the
`create_all` and migration paths would emit different `CREATE TABLE` text.

**No backfill.** A version published before this migration has no description because
nobody wrote one, and no creation moment because nothing recorded it; migration time
would record when somebody upgraded, which is a different fact wearing the right type.
[schemas.md](schemas.md) states the same rule from the caller's side.

**Its undo in the tests' `_downgrade_to_version_one` is what exercises it**, and this
one is in migrations 11 and 12's position rather than 13's — the *quiet* one. Nothing
above rebuilds `annotation_schema` and nothing else was ever added to it by `ALTER`,
so without the two drop lines the columns would survive the downgrade, migration 14
would `checkfirst`-skip, and a pair of `ALTER`s nobody ran would be reported as
agreeing with themselves. `test_migration_fourteen_alters_the_schema_table_for_real`
is the second guard for exactly that, and it asserts column *order*, not just presence.
