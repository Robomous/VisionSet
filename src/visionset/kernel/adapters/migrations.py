"""The storage schema baseline, and the mechanism that carries it forward.

One workspace is one SQLite file, and a ``format_version`` stored inside that
file says which generation of the schema it holds. Opening a workspace runs
whatever is missing. There is no alembic here — a local-first, single-file,
single-writer store does not need a migration framework, and ``format_version``
would then have to be kept in sync with a second ledger by hand.

**There is exactly one migration, and it is the baseline.** A long chain of
generations got the schema to its present shape while VisionSet was unreleased;
every database they could have upgraded was disposable test data in this
repository. Keeping them meant carrying an idempotency argument and an undo line
per generation, plus the scaffolding that proves each one actually ran — all to
protect files that do not exist. So today's ``_tables`` *is* generation 1, and a
fresh database is created directly at it.

**There are no downgrade paths, deliberately.** Nothing here walks a file
backwards and the tests no longer do either. A downgrade is a compatibility
promise, and a promise is owed to somebody: it comes back when there is a
published release whose files this build has to keep opening, and not before.

**Adding a migration.** Append a ``Migration`` with the next version number and
an ``upgrade`` that takes a live connection. Do NOT edit an existing one — a
workspace already stamped at that version will never run it again.
``FORMAT_VERSION`` is derived from the list, so it cannot drift from reality.

Three rules go back into force the moment a second migration exists. They are
written down here rather than left in the deleted code's history, because this
is where the next person will look:

* **Every migration after the first must be idempotent.** Migration 1 is
  ``create_all`` of *today's* metadata, not a frozen snapshot, so adding a
  table, column or index to ``_tables`` retroactively changes what a fresh
  database gets. A later migration therefore exists only for already-stamped
  databases, and yet it still runs against the fresh one that already carries
  its change — hence ``checkfirst`` / ``IF NOT EXISTS``, and hence sharing the
  one schema object with ``_tables`` rather than repeating the DDL. Note that
  SQLAlchemy cannot *reflect* a partial or expression-based index, so
  ``checkfirst`` reports one absent and re-issues a ``CREATE`` that then fails
  on every fresh database; those ask SQLite instead, through
  ``CreateIndex(..., if_not_exists=True)``.
* **A column arriving by ``ALTER`` is declared last on its row class**, because
  SQLite appends it — anywhere else the ``create_all`` path and the migration
  path emit different ``CREATE TABLE`` text.
* **A column carrying a foreign key cannot arrive by ``ALTER`` at all.** SQLite
  spells an added key inline on the column while ``create_all`` spells one as a
  table constraint; the two texts differ. Such a column needs a table rebuild —
  and under ``PRAGMA foreign_keys = ON``, which this store sets on every
  connection, ``DROP TABLE`` runs an implicit ``DELETE`` that cascades to
  children *silently*, so a rebuild has to count those first.

Migrations only run forward. A workspace stamped ahead of this build is
rejected (``WorkspaceFormatTooNew``) rather than silently downgraded.

**The rules above are checked rather than trusted, and it took a bug to get
there.** Every one of them exists so that ``format_version`` means something,
and with a single generation every workspace anybody creates carries the same
number forever — so a file that missed a change is stamped exactly like one that
did not, and nothing about the number can tell them apart. Migration 1 will not
repair it either: ``create_all`` leaves an existing table as it found it, and it
only runs while something is pending, which on a stamped file is nothing. That
file then opens as current and fails at the first statement naming what it
lacks, deep inside a request (#277). So ``SqliteMetadataStore.initialize``
compares the schema it found against the one declared here and raises
``WorkspaceSchemaMismatch`` at the door instead.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import Connection, inspect, text
from sqlalchemy.schema import CreateColumn

from visionset.kernel.adapters._tables import Base


@dataclass(frozen=True)
class Migration:
    """One schema generation: what it is called and how to get there."""

    version: int
    name: str
    upgrade: Callable[[Connection], None]


def _create_baseline_schema(connection: Connection) -> None:
    """Create every table, index and constraint that ``_tables`` declares.

    ``create_all`` is ``checkfirst`` by default, which is what makes running it
    against a file that already has the schema a no-op rather than an error.
    """
    Base.metadata.create_all(connection)


def _add_column(connection: Connection, table: str, column: str) -> None:
    """Append a column a file does not have yet, compiled from its own definition.

    Idempotent by asking the file rather than by ``IF NOT EXISTS``, which SQLite
    has no spelling for on ``ADD COLUMN`` — that check *is* the idempotency the
    module docstring requires, and it matters because migration 1 is
    ``create_all`` of *today's* metadata: a fresh database already carries every
    column below, and then runs this anyway.

    The DDL comes from the shared ``Column`` object through ``CreateColumn``,
    never hand-written, so the two creation paths cannot drift in type or
    nullability. What ``CreateColumn`` silently omits is a ``REFERENCES`` clause,
    which is why neither column here declares a foreign key — see their
    docstrings in ``_tables``.
    """
    if column in {found["name"] for found in inspect(connection).get_columns(table)}:
        return
    definition = CreateColumn(Base.metadata.tables[table].columns[column]).compile(
        bind=connection.engine
    )
    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {definition}"))


def _add_batch_lineage(connection: Connection) -> None:
    """``batch.parent_batch_id``: which batch this one was cut from.

    **Nothing to backfill, and that is a fact rather than a shortcut.** NULL here
    means "not a correction of anything", which is true of every batch that has
    ever existed — correction batches do not exist yet. A backfill would have
    nothing to read and nothing to say.
    """
    _add_column(connection, "batch", "parent_batch_id")


def _add_annotation_provenance(connection: Connection) -> None:
    """``annotation.job_id``: which round of work produced this label.

    **The backfill is honest about what it cannot know.** An annotation records
    only its ``asset_id``, and a job records which assets it carries — so an
    annotation whose asset belongs to exactly one job can be attributed with
    certainty, and one whose asset is carried by two cannot be attributed at all.
    The second case is not rare in principle: nothing stops an asset sitting in
    several batches, and reconciling that is an open question (audit F14).

    So the ``UPDATE`` sets a value only where the count is exactly one, and
    leaves the ambiguous rows NULL. Writing "the first job we found" instead
    would put a confident wrong answer where an honest absent one belongs, and
    every reader downstream would have no way to tell which it had.

    Idempotent twice over: ``_add_column`` returns early on a file that has the
    column, and the ``UPDATE`` is guarded on ``job_id IS NULL`` so a re-run
    cannot overwrite an attribution a *service* has since written.
    """
    _add_column(connection, "annotation", "job_id")
    connection.execute(
        text(
            """
            UPDATE annotation
               SET job_id = (
                     SELECT aja.job_id
                       FROM annotation_job_asset AS aja
                      WHERE aja.asset_id = annotation.asset_id
                   )
             WHERE job_id IS NULL
               AND (
                     SELECT COUNT(*)
                       FROM annotation_job_asset AS aja
                      WHERE aja.asset_id = annotation.asset_id
                   ) = 1
            """
        )
    )


def _add_job_queue(connection: Connection) -> None:
    """``job``: the background executor's queue, created whole.

    **A table, not a column, and that is what makes this the easy kind of
    migration.** The third rule in the module docstring — a column carrying a
    foreign key cannot arrive by ``ALTER`` — never comes up, because ``JobRow``
    declares no key at all (see its own docstring for why that is a decision
    about what a job *is*, not a dodge around this rule).

    ``create_all`` restricted to the one table, rather than a bare
    ``Base.metadata.create_all(connection)``: unrestricted it would also create
    anything else a *later* baseline happens to declare, which would let this
    migration silently do a future one's work on an old file. ``checkfirst`` is
    on by default and is this migration's idempotency — migration 1 is
    ``create_all`` of today's metadata, so a fresh database already has this
    table and then runs this anyway.

    **Nothing to backfill.** A queue's contents are in-flight work, and a
    workspace written before the executor existed had none. The empty table is
    the honest starting state rather than a shortcut.
    """
    Base.metadata.create_all(connection, tables=[Base.metadata.tables["job"]])


MIGRATIONS: list[Migration] = [
    Migration(version=1, name="baseline_schema", upgrade=_create_baseline_schema),
    Migration(version=2, name="batch_lineage", upgrade=_add_batch_lineage),
    Migration(version=3, name="annotation_provenance", upgrade=_add_annotation_provenance),
    Migration(version=4, name="job_queue", upgrade=_add_job_queue),
]

FORMAT_VERSION: int = MIGRATIONS[-1].version
