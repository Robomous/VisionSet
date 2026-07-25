"""Default MetadataStore adapter: SQLite via SQLAlchemy.

Only engine setup and (empty) schema creation exist today; table models land
in a later session together with the entity-level operations on the port.
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import Engine, MetaData, create_engine


class SqliteMetadataStore:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._engine: Engine = create_engine(f"sqlite:///{db_path}")
        self._metadata = MetaData()

    @property
    def engine(self) -> Engine:
        return self._engine

    def initialize(self) -> None:
        """Create the storage schema if it does not exist. Idempotent."""
        self._metadata.create_all(self._engine)

    def close(self) -> None:
        self._engine.dispose()
