"""Forward-only schema migrations for the SQLite metadata store.

The mechanism is deliberately small: an ordered list of migrations, and a
``format_version`` stored in the workspace itself saying how far that file has
been taken. Opening a workspace runs whatever is missing. There is no alembic
here — a local-first, single-file, single-writer store does not need a
migration framework, and ``format_version`` would then have to be kept in sync
with a second ledger by hand.

**Adding a migration.** Append a ``Migration`` with the next version number and
an ``upgrade`` that takes a live connection. Do NOT edit an existing one — a
workspace already stamped at that version will never run it again.
``FORMAT_VERSION`` is derived from the list, so it cannot drift from reality.

**Every migration after the first must be idempotent.** Migration 1 is
``create_all`` of *today's* metadata, not a frozen snapshot: adding a table,
column or index to ``_tables`` retroactively changes what a fresh database gets.
So a later migration exists only for already-stamped databases, yet it still
runs against the fresh one that already has its change — hence ``checkfirst`` /
``IF NOT EXISTS``. Sharing the one schema object between ``_tables`` and the
migration (rather than repeating the DDL) is what keeps the two paths from
drifting; ``tests/kernel/test_migrations.py`` proves they agree.

**A migration may drop, but it has to earn it.** Migration 6 rebuilds the
``release`` table instead of altering it, because the columns it needed could
not be added honestly and because the rows it discards could not have been made
correct. It checks that there are none rather than taking the argument on trust.
That is the bar; a migration that would lose real data does not clear it.

Migrations only run forward. A workspace stamped ahead of this build is
rejected (``WorkspaceFormatTooNew``) rather than silently downgraded.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import cast

from sqlalchemy import Column, Connection, Table, inspect, text
from sqlalchemy.schema import CreateColumn

from visionset.kernel.adapters._tables import (
    PROJECT_NAME_UNIQUE,
    AnnotationJobAssetRow,
    AnnotationRow,
    Base,
    BatchRow,
    ReleaseRow,
)
from visionset.kernel.errors import WorkspaceCorrupt


@dataclass(frozen=True)
class Migration:
    """One schema generation: what it is called and how to get there."""

    version: int
    name: str
    upgrade: Callable[[Connection], None]


def _create_initial_schema(connection: Connection) -> None:
    Base.metadata.create_all(connection)


def _add_project_name_uniqueness(connection: Connection) -> None:
    """Make project names unique per workspace, case-insensitively.

    ``checkfirst`` because a database created by migration 1 already carries the
    index — ``_tables`` declares it, and migration 1 is ``create_all`` of the
    current metadata. See the module docstring.
    """
    PROJECT_NAME_UNIQUE.create(connection, checkfirst=True)


def _add_column(connection: Connection, column: Column[object]) -> None:
    """``ALTER TABLE ... ADD COLUMN``, but only if it is not already there.

    SQLite has no ``ADD COLUMN IF NOT EXISTS``, so the inspector check *is* this
    migration's ``checkfirst`` — a database created by migration 1 already
    carries the column, because migration 1 is ``create_all`` of the current
    metadata. See the module docstring.

    The DDL is compiled from the column object in ``_tables`` rather than typed
    out here, for the same reason migration 2 shares its ``Index``: two spellings
    of one column are two things that can drift.
    """
    table: Table = column.table
    stored = {existing["name"] for existing in inspect(connection).get_columns(table.name)}
    if column.name in stored:
        return
    definition = CreateColumn(column).compile(bind=connection).string
    connection.execute(text(f"ALTER TABLE {table.name} ADD COLUMN {definition}"))


def _add_batch_schema_version(connection: Connection) -> None:
    """Give a batch somewhere to record the schema version pinned at approval."""
    # ``.c`` is typed as the generic column collection; the entry is a real
    # ``Column``, which is what ``CreateColumn`` needs.
    _add_column(connection, cast(Column[object], BatchRow.__table__.c.schema_version))


def _add_job_asset_position(connection: Connection) -> None:
    """Give per-asset progress an explicit order instead of an accidental one.

    Until now the order rows came back in was whatever SQLite chose. It happened
    to match ingest order, but only because the whole child collection is
    rewritten on every save — an accident, not a guarantee, and
    ``JobService.next_pending`` needs a guarantee.
    """
    _add_column(connection, cast(Column[object], AnnotationJobAssetRow.__table__.c.position))


def _add_annotation_attributes(connection: Connection) -> None:
    """Give an annotation somewhere to record its attribute values.

    Until now a schema could declare attributes that no annotation could carry.
    Existing rows default to ``{}``, which is exactly what they meant: no values
    recorded — and any class that requires one will refuse the next write to it.
    """
    _add_column(connection, cast(Column[object], AnnotationRow.__table__.c.attributes))


def _repoint_release_at_its_manifest_blob(connection: Connection) -> None:
    """Rebuild ``release`` around a manifest that lives in the blob store.

    The only migration here that drops a table, and the only one that could not
    have been an ``ALTER``. Three of the columns it adds are ``NOT NULL`` with no
    honest default — SQLite refuses such a column without one, so the ``ALTER``
    route would have baked ``manifest_hash DEFAULT ''`` and two more fictions
    into every fresh database forever. And decisively: a pre-#12 row carries its
    manifest as a JSON column with *no blob behind it*, so there is no value
    ``manifest_hash`` could be given that ``verify`` would ever accept. Adding
    the columns would manufacture rows that are broken by construction; dropping
    the table is the honest answer.

    Idempotent the way migrations 3 to 5 are: the inspector check *is* the
    ``checkfirst``, because migration 1 is ``create_all`` of current metadata.
    That check comes first so the fresh path never reaches the count below.

    The emptiness this all rests on is checked rather than asserted in a
    comment. Nothing could write a release before ``ReleaseService`` existed, but
    "nothing could" is a claim about a build, not about a file on disk — so a
    workspace that somehow holds one is refused rather than quietly emptied.
    """
    # ``__table__`` is declared as the general ``FromClause``; for a mapped class
    # it is always the ``Table``, which is what ``drop``/``create`` need.
    table = cast(Table, ReleaseRow.__table__)
    stored = {existing["name"] for existing in inspect(connection).get_columns(table.name)}
    if "manifest_hash" in stored:
        return
    # Raw text: the table still has its pre-#12 shape here, so the mapped columns
    # in ``_tables`` no longer describe the thing being counted.
    if connection.execute(text("SELECT count(*) FROM release")).scalar_one():
        raise WorkspaceCorrupt(
            "this workspace holds release rows written before ReleaseService existed. Their "
            "manifests were never stored in the blob store, so there is nothing to migrate "
            "them to; publish new releases instead."
        )
    table.drop(connection)
    table.create(connection)


MIGRATIONS: list[Migration] = [
    Migration(version=1, name="initial_schema", upgrade=_create_initial_schema),
    Migration(
        version=2,
        name="project_name_unique_per_workspace",
        upgrade=_add_project_name_uniqueness,
    ),
    Migration(
        version=3,
        name="batch_schema_version_pin",
        upgrade=_add_batch_schema_version,
    ),
    Migration(
        version=4,
        name="annotation_job_asset_position",
        upgrade=_add_job_asset_position,
    ),
    Migration(
        version=5,
        name="annotation_attributes",
        upgrade=_add_annotation_attributes,
    ),
    Migration(
        version=6,
        name="release_manifest_pointer",
        upgrade=_repoint_release_at_its_manifest_blob,
    ),
]

FORMAT_VERSION: int = MIGRATIONS[-1].version
