from pathlib import Path

from sqlalchemy import text

from visionset.kernel.adapters import SqliteMetadataStore
from visionset.kernel.ports import MetadataStore


def test_initialize_creates_database_file(tmp_path: Path) -> None:
    db_path = tmp_path / "meta" / "visionset.db"
    store = SqliteMetadataStore(db_path)
    store.initialize()
    with store.engine.connect() as conn:
        assert conn.execute(text("select 1")).scalar() == 1
    store.close()
    assert db_path.is_file()


def test_initialize_is_idempotent(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    store.initialize()
    store.close()


def test_satisfies_metadata_store_port(tmp_path: Path) -> None:
    assert isinstance(SqliteMetadataStore(tmp_path / "visionset.db"), MetadataStore)
