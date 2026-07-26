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

Migrations only run forward. A workspace stamped ahead of this build is
rejected (``WorkspaceFormatTooNew``) rather than silently downgraded.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import Connection

from visionset.kernel.adapters._tables import Base


@dataclass(frozen=True)
class Migration:
    """One schema generation: what it is called and how to get there."""

    version: int
    name: str
    upgrade: Callable[[Connection], None]


def _create_initial_schema(connection: Connection) -> None:
    Base.metadata.create_all(connection)


MIGRATIONS: list[Migration] = [
    Migration(version=1, name="initial_schema", upgrade=_create_initial_schema),
]

FORMAT_VERSION: int = MIGRATIONS[-1].version
