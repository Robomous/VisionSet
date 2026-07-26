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

Migrations only run forward. A workspace stamped ahead of this build is
rejected (``WorkspaceFormatTooNew``) rather than silently downgraded.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import Connection

from visionset.kernel.adapters._tables import PROJECT_NAME_UNIQUE, Base


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


MIGRATIONS: list[Migration] = [
    Migration(version=1, name="initial_schema", upgrade=_create_initial_schema),
    Migration(
        version=2,
        name="project_name_unique_per_workspace",
        upgrade=_add_project_name_uniqueness,
    ),
]

FORMAT_VERSION: int = MIGRATIONS[-1].version
