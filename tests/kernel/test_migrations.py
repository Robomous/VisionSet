from pathlib import Path

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

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
        # Migrations 10 and 8's undo, newest column first. The index goes before
        # the columns it names, because SQLite refuses to drop a column an index
        # still references.
        #
        # Migration 10 needs its own line where migration 9 needed none:
        # ``asset`` is only ever altered — it has four cascading children and
        # legitimate pre-pipeline rows — so nothing below rebuilds it and takes
        # ``thumbnail_hash`` away for free. The compensation is that migration
        # 10's real ``ALTER`` runs on the way back up from here, which is why it
        # has no generation twin of
        # ``test_migration_nine_alters_a_table_migration_eight_rebuilt``.
        connection.execute(text("drop index if exists uq_asset_project_content_hash"))
        # Migration 13's undo, and it needs its own line for migration 10's
        # reason: ``asset`` is only ever altered, so nothing below takes this
        # column away for free.
        #
        # Unlike migrations 11 and 12, leaving this line out fails the test
        # rather than passing quietly — and the mechanism is worth knowing,
        # because it is the reverse of the trap. The column would survive the
        # downgrade and migration 13 would ``checkfirst``-skip, exactly as
        # migration 11 would; but the four columns dropped *below* this line get
        # re-added by ``ALTER`` on the way up, and SQLite appends. So the
        # migrated table would carry ``ingested_at`` in the middle where the
        # fresh one has it last, and ``_schema`` compares ``CREATE TABLE`` text.
        # Being the newest column on an alter-only table is what makes the
        # omission loud; the next one added here will be in the same position.
        connection.execute(text("alter table asset drop column ingested_at"))
        connection.execute(text("alter table asset drop column thumbnail_hash"))
        connection.execute(text("alter table asset drop column frame_timestamp"))
        connection.execute(text("alter table asset drop column frame_index"))
        connection.execute(text("alter table asset drop column source_id"))
        connection.execute(text("alter table asset drop column format"))
        # ``ingest_job.batch_id`` sits in a foreign-key clause, and SQLite
        # refuses to drop such a column at all — the constraint would be left
        # naming something that is gone. Migration 8 rebuilds this table for the
        # same underlying reason, so its undo is a rebuild too. It is empty here.
        #
        # This rebuild is also migration 9's undo: its four columns live on this
        # same table, so restoring the generation-1 shape removes them with
        # everything else. That is why nothing below mentions them — and why
        # ``test_migration_nine_alters_a_table_migration_eight_rebuilt`` exists,
        # because from here migration 8 re-creates the table whole and 9 never
        # runs as the ``ALTER`` that a real generation-8 database gets.
        connection.execute(text("drop table ingest_job"))
        connection.execute(
            text(
                "CREATE TABLE ingest_job ("
                " id CHAR(32) NOT NULL,"
                " source_id CHAR(32) NOT NULL,"
                " state VARCHAR NOT NULL,"
                " error VARCHAR,"
                " PRIMARY KEY (id),"
                " FOREIGN KEY(source_id) REFERENCES source (id) ON DELETE CASCADE)"
            )
        )
        connection.execute(text("CREATE INDEX ix_ingest_job_source_id ON ingest_job (source_id)"))
        # Migration 11's undo. One line, because SQLite drops a table's indexes
        # with it, and order-free, because nothing references ``token``.
        #
        # This line is also the only thing that exercises migration 11. Without
        # it the fresh-versus-migrated test below would still pass: the table
        # would survive the downgrade and migration 11 would ``checkfirst``-skip,
        # so the ``CREATE`` nobody ran would be reported as agreeing with itself.
        connection.execute(text("drop table token"))
        # Migration 12's undo. One line, and it is the *only* thing that
        # exercises that migration: ``annotation`` is only ever altered, so
        # nothing above rebuilds it and takes the index away for free — the same
        # position migration 11 is in, and the opposite of migration 9's.
        connection.execute(text("drop index if exists uq_annotation_asset_classification"))
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


def test_migration_eight_gives_an_asset_its_origin(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        columns = {c["name"] for c in inspect(connection).get_columns("asset")}
    assert {"format", "source_id", "frame_index", "frame_timestamp"} <= columns
    store.close()


def test_migration_eight_links_an_ingest_job_to_its_batch(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        columns = {c["name"] for c in inspect(connection).get_columns("ingest_job")}
    assert "batch_id" in columns
    store.close()


def test_migration_eight_makes_content_unique_within_a_project(tmp_path: Path) -> None:
    """Per project, not globally: two projects may hold one photograph."""
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    index = next(sql for sql in _schema(store) if "uq_asset_project_content_hash" in sql)
    assert "project_id" in index
    store.close()


def test_migration_eight_puts_an_index_under_the_source_idempotency_rule(tmp_path: Path) -> None:
    """The fourth term is the expression, and it is the half that can rot silently.

    A three-column index over ``(project_id, kind, path)`` would look right and
    would refuse a clip's second extraction rate, which is a legitimate second
    source; a nullable fourth column would collide with nothing at all, because
    SQLite treats NULLs in a unique index as distinct.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    index = next(sql for sql in _schema(store) if "uq_source_project_kind_path_fps" in sql)
    assert "json_extract" in index
    assert "coalesce" in index
    store.close()


def test_migration_eight_refuses_a_workspace_holding_duplicate_assets(tmp_path: Path) -> None:
    """Refused, not merged: each duplicate may carry its own annotations."""
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    _downgrade_to_version_one(store)
    with store.engine.begin() as connection:
        connection.execute(text("insert into workspace (id, name) values ('w', 'ws')"))
        connection.execute(
            text("insert into project (id, workspace_id, name) values ('p', 'w', 'proj')")
        )
        for asset_id in ("a1", "a2"):
            connection.execute(
                text(
                    "insert into asset (id, project_id, modality, content_hash, uri) "
                    f"values ('{asset_id}', 'p', 'image', 'deadbeef', '/x.png')"
                )
            )

    with pytest.raises(WorkspaceCorrupt, match="duplicate assets"):
        store.initialize()

    # And the rows are still there — refused, not emptied.
    with store.engine.connect() as connection:
        assert connection.execute(text("select count(*) from asset")).scalar_one() == 2
    store.close()


def test_migration_eight_refuses_a_workspace_holding_duplicate_sources(tmp_path: Path) -> None:
    """The rule #18 shipped as a pre-check, meeting data written while it was one."""
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.begin() as connection:
        connection.execute(text("insert into workspace (id, name) values ('w', 'ws')"))
        connection.execute(
            text("insert into project (id, workspace_id, name) values ('p', 'w', 'proj')")
        )
        # The index has to go before the rows it would refuse, which is exactly
        # the situation a workspace written by the previous build is in.
        connection.execute(text("drop index uq_source_project_kind_path_fps"))
        for source_id in ("s1", "s2"):
            connection.execute(
                text(
                    "insert into source (id, project_id, kind, path, registered_at, "
                    f"capture_params) values ('{source_id}', 'p', 'image_directory', '/in', "
                    "'2026-07-27T00:00:00+00:00', '{}')"
                )
            )
        connection.execute(text("update _visionset_meta set format_version = 7"))

    with pytest.raises(WorkspaceCorrupt, match="duplicate sources"):
        store.initialize()

    with store.engine.connect() as connection:
        assert connection.execute(text("select count(*) from source")).scalar_one() == 2
    store.close()


def test_migration_eight_refuses_a_workspace_that_still_holds_a_pre_ingest_job(
    tmp_path: Path,
) -> None:
    """``ingest_job`` is rebuilt, so like migrations 6 and 7 it counts first.

    Set up at generation 7 rather than 1, so that migration 8's own count is
    what fires: from generation 1 migration 7 refuses the workspace before this
    ever runs, because a pre-#18 source is what such a job always hangs from.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.begin() as connection:
        connection.execute(text("insert into workspace (id, name) values ('w', 'ws')"))
        connection.execute(
            text("insert into project (id, workspace_id, name) values ('p', 'w', 'proj')")
        )
        connection.execute(
            text(
                "insert into source (id, project_id, kind, path, registered_at, capture_params) "
                "values ('s', 'p', 'image_directory', '/in', '2026-07-27T00:00:00+00:00', '{}')"
            )
        )
        # Rebuilt rather than altered, for the reason migration 8 rebuilds it:
        # SQLite will not drop a column that a foreign-key clause names.
        connection.execute(text("drop table ingest_job"))
        connection.execute(
            text(
                "CREATE TABLE ingest_job ("
                " id CHAR(32) NOT NULL,"
                " source_id CHAR(32) NOT NULL,"
                " state VARCHAR NOT NULL,"
                " error VARCHAR,"
                " PRIMARY KEY (id),"
                " FOREIGN KEY(source_id) REFERENCES source (id) ON DELETE CASCADE)"
            )
        )
        connection.execute(
            text("insert into ingest_job (id, source_id, state) values ('j', 's', 'pending')")
        )
        connection.execute(text("update _visionset_meta set format_version = 7"))

    with pytest.raises(WorkspaceCorrupt, match="before IngestService existed"):
        store.initialize()

    with store.engine.connect() as connection:
        assert connection.execute(text("select count(*) from ingest_job")).scalar_one() == 1
    store.close()


#: What migration 9 adds, and therefore what generation 8 did not have.
_MIGRATION_NINE_COLUMNS = ("batch_name", "processed", "total", "failures")


def _downgrade_to_generation_eight(store: SqliteMetadataStore) -> None:
    """Take ``ingest_job`` back to the shape migration 8's rebuild left it in.

    Four ``DROP COLUMN``s rather than a hand-written ``CREATE TABLE``, and that
    is not only convenience. These tests compare ``sqlite_master`` *text*, and
    SQLite rewrites the stored statement by deleting the dropped column's
    definition and leaving every other character alone — so what is left is
    exactly what ``table.create()`` wrote, where a retyped baseline would differ
    in whitespace and fail for a reason about this file rather than the schema.

    That these drops are even possible is migration 9's own argument restated:
    none of the four carries a foreign key, which is why it could be an ``ALTER``
    at all where migration 8 needed a rebuild.
    """
    with store.engine.begin() as connection:
        for column in _MIGRATION_NINE_COLUMNS:
            connection.execute(text(f"alter table ingest_job drop column {column}"))
        connection.execute(text("update _visionset_meta set format_version = 8"))


def test_migration_nine_gives_a_run_its_progress_and_its_report(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        columns = {c["name"] for c in inspect(connection).get_columns("ingest_job")}
    assert {"batch_name", "processed", "total", "failures"} <= columns
    store.close()


def test_migration_nine_alters_a_table_migration_eight_rebuilt(tmp_path: Path) -> None:
    """The ``ALTER`` path, which the fresh-versus-migrated test cannot reach.

    That test walks back to generation 1, from where migration 8 re-creates
    ``ingest_job`` whole — including migration 9's columns, since it builds from
    ``_tables`` — so migration 9 finds them present and does nothing. A database
    this build actually wrote is stamped at 8, and migration 9 reaches it as four
    ``ALTER TABLE ... ADD COLUMN`` statements instead.

    That is the path the declared-last rule exists for: SQLite appends an added
    column, so the two spellings of ``CREATE TABLE ingest_job`` agree only while
    those four stay at the end of ``IngestJobRow``.
    """
    fresh = SqliteMetadataStore(tmp_path / "fresh.db")
    fresh.initialize()
    expected = _schema(fresh)
    fresh.close()

    legacy = SqliteMetadataStore(tmp_path / "legacy.db")
    legacy.initialize()
    _downgrade_to_generation_eight(legacy)
    assert _schema(legacy) != expected  # the four columns really are gone

    legacy.initialize()  # migration 9 alone, as an ALTER
    assert _schema(legacy) == expected
    assert legacy.format_version == FORMAT_VERSION
    legacy.close()


def test_migration_nine_keeps_the_runs_a_workspace_already_recorded(tmp_path: Path) -> None:
    """Four columns with an honest value for a row written before them.

    Nothing is refused and nothing is dropped here, unlike migrations 6 to 8:
    a pre-#19 run counted nothing and reported nothing, which is exactly what
    ``0`` and ``[]`` say, and NULL is what a run that named no batch meant.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.begin() as connection:
        connection.execute(text("insert into workspace (id, name) values ('w', 'ws')"))
        connection.execute(
            text("insert into project (id, workspace_id, name) values ('p', 'w', 'proj')")
        )
        connection.execute(
            text(
                "insert into source (id, project_id, kind, path, registered_at, capture_params) "
                "values ('s', 'p', 'image_directory', '/in', '2026-07-27T00:00:00+00:00', '{}')"
            )
        )
    _downgrade_to_generation_eight(store)
    with store.engine.begin() as connection:
        connection.execute(
            text("insert into ingest_job (id, source_id, state) values ('j', 's', 'completed')")
        )

    store.initialize()

    with store.engine.connect() as connection:
        row = connection.execute(
            text("select batch_name, processed, total, failures from ingest_job where id = 'j'")
        ).one()
    assert row == (None, 0, None, "[]")
    store.close()


def _downgrade_to_generation_nine(store: SqliteMetadataStore) -> None:
    """Take ``asset`` back to the shape migration 8's ``ALTER``s left it in.

    A ``DROP COLUMN`` rather than a hand-written ``CREATE TABLE``, for the
    reason ``_downgrade_to_generation_eight`` gives: these tests compare
    ``sqlite_master`` *text*, and SQLite rewrites the stored statement by
    deleting the dropped column's definition and leaving every other character
    alone, where a retyped baseline would differ in whitespace and fail for a
    reason about this file rather than about the schema.
    """
    with store.engine.begin() as connection:
        connection.execute(text("alter table asset drop column thumbnail_hash"))
        connection.execute(text("update _visionset_meta set format_version = 9"))


def test_migration_ten_gives_an_asset_a_place_for_its_preview(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        columns = {c["name"] for c in inspect(connection).get_columns("asset")}
    assert "thumbnail_hash" in columns
    store.close()


def test_migration_ten_leaves_an_asset_it_did_not_render_alone(tmp_path: Path) -> None:
    """NULL is the ordinary state of a cache, not a legacy value to tolerate.

    Nothing is refused and nothing is dropped, and here that is easier to claim
    than it was for migration 9: an asset written before this column has no
    preview, which is precisely what NULL says, and
    ``IngestService.backfill_thumbnails`` is the remedy that reads it.

    There is no schema twin of
    ``test_migration_nine_alters_a_table_migration_eight_rebuilt`` because
    migration 10 does not need one. That test exists because migration 8
    *rebuilds* ``ingest_job``, so a walk back to generation 1 re-creates
    migration 9's columns from ``_tables`` and 9 never runs as an ``ALTER``.
    ``asset`` is only ever altered, so
    ``test_a_fresh_database_and_a_migrated_one_have_the_same_schema`` already
    exercises this migration's real ``ALTER TABLE ... ADD COLUMN``.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.begin() as connection:
        connection.execute(text("insert into workspace (id, name) values ('w', 'ws')"))
        connection.execute(
            text("insert into project (id, workspace_id, name) values ('p', 'w', 'proj')")
        )
    _downgrade_to_generation_nine(store)
    with store.engine.begin() as connection:
        connection.execute(
            text(
                "insert into asset (id, project_id, modality, content_hash, uri) "
                f"values ('a', 'p', 'image', '{'a' * 64}', '/in/one.png')"
            )
        )

    store.initialize()

    with store.engine.connect() as connection:
        row = connection.execute(
            text("select thumbnail_hash from asset where id = 'a'")
        ).scalar_one()
    assert row is None
    assert store.format_version == FORMAT_VERSION
    store.close()


def test_migration_eleven_gives_a_workspace_somewhere_to_keep_its_tokens(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        columns = {c["name"] for c in inspect(connection).get_columns("token")}
    assert columns == {"id", "workspace_id", "name", "secret_hash", "created_at", "revoked_at"}
    store.close()


def test_migration_eleven_brings_its_indexes_with_it(tmp_path: Path) -> None:
    """``Table.create`` emits the indexes too, which is why none is issued alone.

    Migration 8 had to learn the hard way that an index can go missing from a
    creation path — it re-issued a ``CREATE`` for one SQLAlchemy could not
    reflect. Here the claim is the opposite one and it is worth pinning: if
    ``checkfirst`` on a table ever stopped carrying its indexes, uniqueness would
    quietly stop being enforced and every name collision would land in the store.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        indexes = {i["name"] for i in inspect(connection).get_indexes("token")}
    assert {"ix_token_workspace_id", "uq_token_workspace_name"} <= indexes
    store.close()


def test_migration_eleven_creates_the_table_on_a_database_that_predates_it(
    tmp_path: Path,
) -> None:
    """The real exercise: from generation 1 the table is gone, so this one builds it.

    ``_downgrade_to_version_one`` drops ``token``, and that line is the only
    thing that makes this migration run at all — see the comment there. Without
    it the fresh-versus-migrated test would compare a table nobody re-created
    against itself.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    _downgrade_to_version_one(store)
    with store.engine.connect() as connection:
        assert not inspect(connection).has_table("token")

    store.initialize()

    with store.engine.connect() as connection:
        assert inspect(connection).has_table("token")
        indexes = {i["name"] for i in inspect(connection).get_indexes("token")}
    assert {"ix_token_workspace_id", "uq_token_workspace_name"} <= indexes
    assert store.format_version == FORMAT_VERSION
    store.close()


def test_migration_eleven_makes_a_token_name_unique_within_its_workspace(tmp_path: Path) -> None:
    """The index is the guarantee; ``TokenService`` supplies the sentence.

    Case-insensitively, so that ``token revoke ci`` cannot find two credentials.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.begin() as connection:
        connection.execute(text("insert into workspace (id, name) values ('w', 'ws')"))
        connection.execute(
            text(
                "insert into token (id, workspace_id, name, secret_hash, created_at) "
                f"values ('t1', 'w', 'ci', '{'a' * 64}', '2026-07-27T08:00:00+00:00')"
            )
        )
    with pytest.raises(IntegrityError), store.engine.begin() as connection:
        connection.execute(
            text(
                "insert into token (id, workspace_id, name, secret_hash, created_at) "
                f"values ('t2', 'w', 'CI', '{'b' * 64}', '2026-07-27T08:00:00+00:00')"
            )
        )
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


def test_migration_twelve_makes_a_second_tag_on_one_asset_impossible(tmp_path: Path) -> None:
    """The index is partial, so it constrains tags and nothing else."""
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    assert any("uq_annotation_asset_classification" in sql for sql in _schema(store))
    store.close()


def test_migration_twelve_collapses_duplicates_a_workspace_already_carried(
    tmp_path: Path,
) -> None:
    """The backfill, and the reason it collapses rather than refusing.

    Duplicates were legal before this migration, so a workspace can hold them —
    and refusing to open one would leave its owner with a remedy they cannot
    apply, since this product ships no SQL console. The survivor is the
    lexicographically smallest id, which is arbitrary by construction (the rows
    are one statement) and, more importantly, deterministic.
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
        connection.execute(
            text(
                "insert into asset (id, project_id, modality, uri, content_hash)"
                " values ('0000000000000000000000000000000a', 'p', 'image', 'f.png', 'h')"
            )
        )
        for annotation_id, geometry in (
            ("00000000000000000000000000000001", '{"type": "classification_tag"}'),
            ("00000000000000000000000000000002", '{"type": "classification_tag"}'),
            # A second class on the same asset is a different statement and stays.
            ("00000000000000000000000000000003", '{"type": "classification_tag"}'),
            # And two boxes under one class are the normal case, which is why the
            # index is partial rather than a rule about the table.
            (
                "00000000000000000000000000000004",
                '{"type": "bbox", "x": 0, "y": 0, "width": 1, "height": 1}',
            ),
            (
                "00000000000000000000000000000005",
                '{"type": "bbox", "x": 2, "y": 2, "width": 1, "height": 1}',
            ),
        ):
            label = "night" if annotation_id.endswith("3") else "daytime"
            connection.execute(
                text(
                    "insert into annotation (id, asset_id, label_class, schema_version,"
                    " geometry, provenance)"
                    " values (:id, :asset, :label, 1, :geometry, 'human')"
                ),
                {
                    "id": annotation_id,
                    "asset": "0000000000000000000000000000000a",
                    "label": label,
                    "geometry": geometry,
                },
            )

    store.initialize()

    with store.engine.begin() as connection:
        surviving = sorted(
            row[0] for row in connection.execute(text("select id from annotation")).fetchall()
        )
    # The first of the two `daytime` tags survives; the second is gone; the
    # `night` tag and both boxes are untouched.
    assert surviving == [
        "00000000000000000000000000000001",
        "00000000000000000000000000000003",
        "00000000000000000000000000000004",
        "00000000000000000000000000000005",
    ]
    store.close()
