from pathlib import Path

import pytest
from sqlalchemy import inspect, text

from visionset.kernel import WorkspaceCorrupt
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
        # Migration 6 rebuilt this table rather than altering it, so undoing it
        # means writing the old shape out by hand. This is the only DDL in the
        # file that cannot be borrowed from ``_tables``, for the good reason that
        # ``_tables`` no longer describes it.
        connection.execute(text("drop table release"))
        connection.execute(
            text(
                "CREATE TABLE release ("
                " id CHAR(32) NOT NULL,"
                " dataset_id CHAR(32) NOT NULL,"
                " tag VARCHAR NOT NULL,"
                " manifest JSON NOT NULL,"
                " PRIMARY KEY (id),"
                " FOREIGN KEY(dataset_id) REFERENCES dataset (id) ON DELETE CASCADE)"
            )
        )
        connection.execute(text("CREATE INDEX ix_release_dataset_id ON release (dataset_id)"))
        # Migration 7 rebuilt ``source`` for the same kind of reason, so its undo
        # is hand-written too. ``ingest_job`` keeps a ``REFERENCES source (id)``
        # across this window; SQLite resolves foreign-key targets at DML time,
        # not at DDL time, so the gap between the drop and the create is safe.
        connection.execute(text("drop table source"))
        connection.execute(
            text(
                "CREATE TABLE source ("
                " id CHAR(32) NOT NULL,"
                " project_id CHAR(32) NOT NULL,"
                " kind VARCHAR NOT NULL,"
                " uri VARCHAR NOT NULL,"
                " PRIMARY KEY (id),"
                " FOREIGN KEY(project_id) REFERENCES project (id) ON DELETE CASCADE)"
            )
        )
        connection.execute(text("CREATE INDEX ix_source_project_id ON source (project_id)"))
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


def test_migration_six_repoints_a_release_at_a_manifest_in_the_blob_store(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        columns = {c["name"] for c in inspect(connection).get_columns("release")}
    assert "manifest_hash" in columns
    assert "manifest" not in columns
    store.close()


def test_migration_six_makes_a_release_tag_unique_within_its_dataset(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    assert any("uq_release_dataset_tag" in sql for sql in _schema(store))
    store.close()


def test_migration_six_refuses_a_workspace_that_still_holds_a_pre_release_row(
    tmp_path: Path,
) -> None:
    """A row it cannot make correct is refused, never silently dropped.

    Nothing could write one before ``ReleaseService`` existed, which is what
    licences the drop — but that is a claim about a build, not about a file, so
    the migration checks rather than assumes.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    _downgrade_to_version_one(store)
    with store.engine.begin() as connection:
        # A real parent chain, because foreign keys are on: the point of the test
        # is the row in ``release``, not a way around the constraints.
        connection.execute(text("insert into workspace (id, name) values ('w', 'ws')"))
        connection.execute(
            text("insert into project (id, workspace_id, name) values ('p', 'w', 'proj')")
        )
        connection.execute(
            text("insert into dataset (id, project_id, name) values ('d', 'p', 'proj')")
        )
        connection.execute(
            text(
                "insert into release (id, dataset_id, tag, manifest) values ('r', 'd', 'v1', '{}')"
            )
        )

    with pytest.raises(WorkspaceCorrupt, match="before ReleaseService existed"):
        store.initialize()
    store.close()


def test_migration_seven_gives_a_source_its_provenance(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        columns = {c["name"] for c in inspect(connection).get_columns("source")}
    assert {"path", "registered_at", "capture_params", "video"} <= columns
    assert "uri" not in columns
    store.close()


def test_migration_seven_keeps_the_source_project_index(tmp_path: Path) -> None:
    """The rebuild re-creates the table from ``_tables``, indexes included.

    Worth its own test: migration 6 dropped a table carrying a
    ``UniqueConstraint``, not an ``Index``, so this path was never exercised.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    assert any("ix_source_project_id" in sql for sql in _schema(store))
    store.close()


@pytest.mark.parametrize(
    ("table", "insert"),
    [
        (
            "source",
            "insert into source (id, project_id, kind, uri) "
            "values ('s', 'p', 'local_folder', '/in')",
        ),
        (
            "ingest_job",
            "insert into source (id, project_id, kind, uri) "
            "values ('s', 'p', 'local_folder', '/in');"
            "insert into ingest_job (id, source_id, state) values ('j', 's', 'pending')",
        ),
    ],
)
def test_migration_seven_refuses_a_workspace_that_still_holds_pre_provenance_rows(
    tmp_path: Path, table: str, insert: str
) -> None:
    """Neither the source nor its children are dropped on the quiet.

    ``ingest_job.source_id`` is ``ON DELETE CASCADE`` and the store turns foreign
    keys on for every connection, so ``DROP TABLE source`` would take the jobs
    with it *without raising*. Counting only ``source`` would let a workspace
    with jobs slip through, which is why the migration counts both — and why the
    second case here exists at all.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    _downgrade_to_version_one(store)
    with store.engine.begin() as connection:
        # A real parent chain, because foreign keys are on.
        connection.execute(text("insert into workspace (id, name) values ('w', 'ws')"))
        connection.execute(
            text("insert into project (id, workspace_id, name) values ('p', 'w', 'proj')")
        )
        for statement in insert.split(";"):
            connection.execute(text(statement))

    with pytest.raises(WorkspaceCorrupt, match="before SourceService existed"):
        store.initialize()

    # And the rows are still there — refused, not emptied.
    with store.engine.connect() as connection:
        assert connection.execute(text(f"select count(*) from {table}")).scalar_one() == 1
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
