from pathlib import Path

from sqlalchemy import inspect, text

from visionset.kernel.adapters import SqliteMetadataStore
from visionset.kernel.adapters.migrations import FORMAT_VERSION, MIGRATIONS


def test_format_version_is_derived_from_the_last_migration() -> None:
    assert MIGRATIONS[-1].version == FORMAT_VERSION


def test_migration_versions_are_unique_and_start_at_one() -> None:
    versions = [migration.version for migration in MIGRATIONS]
    assert versions == list(range(1, len(versions) + 1))


def test_every_migration_is_named() -> None:
    for migration in MIGRATIONS:
        assert migration.name


def _schema(store: SqliteMetadataStore) -> set[str]:
    """Every ``CREATE`` statement SQLite has on file, normalized to a set."""
    with store.engine.connect() as connection:
        rows = connection.execute(
            text("select sql from sqlite_master where sql is not null")
        ).scalars()
        return {" ".join(sql.split()) for sql in rows}


def _downgrade_to_version_one(store: SqliteMetadataStore) -> None:
    """Undo everything after migration 1, and restamp the file as generation 1.

    Every migration added here needs its undo added here too — the fresh-versus-
    migrated test below is only as strong as how far back this walks.
    """
    with store.engine.begin() as connection:
        connection.execute(text("drop index if exists uq_project_workspace_name"))
        connection.execute(text("alter table batch drop column schema_version"))
        connection.execute(text("alter table annotation_job_asset drop column position"))
        connection.execute(text("alter table annotation drop column attributes"))
        connection.execute(text("update _visionset_meta set format_version = 1"))


def test_migration_two_creates_the_project_name_index(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    assert any("uq_project_workspace_name" in sql for sql in _schema(store))
    store.close()


def test_migration_three_gives_a_batch_its_schema_version_pin(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        columns = {c["name"] for c in inspect(connection).get_columns("batch")}
    assert "schema_version" in columns
    store.close()


def test_migration_four_gives_per_asset_progress_an_explicit_order(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        columns = {c["name"] for c in inspect(connection).get_columns("annotation_job_asset")}
    assert "position" in columns
    store.close()


def test_migration_five_gives_an_annotation_its_attribute_values(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        columns = {c["name"] for c in inspect(connection).get_columns("annotation")}
    assert "attributes" in columns
    store.close()


def test_a_fresh_database_and_a_migrated_one_have_the_same_schema(tmp_path: Path) -> None:
    """Migration 1 is ``create_all`` of *current* metadata, so the two paths differ.

    A fresh file gets every later migration's change from migration 1; an
    existing file gets each one from the migration itself. If those ever
    disagree, a workspace's behavior depends on when it was created — which is
    the bug this test exists to catch.
    """
    fresh = SqliteMetadataStore(tmp_path / "fresh.db")
    fresh.initialize()
    expected = _schema(fresh)
    fresh.close()

    legacy = SqliteMetadataStore(tmp_path / "legacy.db")
    legacy.initialize()
    _downgrade_to_version_one(legacy)
    assert _schema(legacy) != expected  # the downgrade really removed something
    legacy.initialize()  # migrates 1 -> FORMAT_VERSION

    assert _schema(legacy) == expected
    assert legacy.format_version == FORMAT_VERSION
    legacy.close()


def test_every_migration_after_the_first_is_idempotent(tmp_path: Path) -> None:
    """They run against fresh databases that already carry their change."""
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.begin() as connection:
        for migration in MIGRATIONS[1:]:
            migration.upgrade(connection)
    store.close()
