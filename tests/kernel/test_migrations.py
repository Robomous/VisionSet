"""What the schema baseline creates, and the machinery that guards the next one.

There is one migration now — see ``migrations.py`` for why the fourteen that
preceded it are gone — so the questions worth asking here changed shape. What a
particular generation added is no longer a question anybody can have. What
``_tables`` produces on disk still is, and so does whether re-running the list
is safe, because both of those become load-bearing again the moment a second
migration is appended.

The comparison helper (``_schema``) and the fresh-versus-fresh equivalence test
are kept for exactly that reason: they are what a second migration will be
judged against. They caught two real bugs while the chain existed (an added
column declared in the wrong position, and a migration whose only exercise ran
through an earlier rebuild), and rebuilding them from scratch under time
pressure is how that class of bug gets back in.
"""

from pathlib import Path

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from visionset.kernel.adapters import SqliteMetadataStore
from visionset.kernel.adapters._tables import META_TABLE, Base
from visionset.kernel.adapters.migrations import FORMAT_VERSION, MIGRATIONS
from visionset.kernel.errors import (
    WorkspaceCorrupt,
    WorkspaceFormatTooNew,
    WorkspaceSchemaMismatch,
)

#: Every uniqueness rule the store carries as a real index, and what makes each
#: one recognizable in ``sqlite_master``. A service-level rule with nothing
#: underneath it is a wish (``docs/content/persistence.md``), and these indexes are the
#: backstop — so the baseline creating all of them is asserted directly rather
#: than left to whichever service happens to exercise one.
_UNIQUENESS_INDEXES = {
    # Case-insensitive, so that two projects cannot differ only in capitals.
    "uq_project_workspace_name": ("workspace_id", "NOCASE"),
    "uq_token_workspace_name": ("workspace_id", "NOCASE"),
    # Per project, not globally: two projects may hold one photograph.
    "uq_asset_project_content_hash": ("project_id", "content_hash"),
    # The fourth term is an *expression*, and it is the half that can rot
    # silently: a three-column index would refuse a clip's second extraction
    # rate, and a nullable fourth column would collide with nothing at all,
    # because SQLite treats NULLs in a unique index as distinct.
    "uq_source_project_kind_path_fps_ranges": ("json_extract", "coalesce", "$.ranges"),
    # Partial, so it constrains classification tags and nothing else: two boxes
    # under one class are two facts, two tags of one class are one statement
    # made twice.
    "uq_annotation_asset_classification": ("classification_tag", "WHERE"),
}


def _schema(store: SqliteMetadataStore) -> set[str]:
    """Every ``CREATE`` statement SQLite has on file, normalized to a set."""
    with store.engine.connect() as connection:
        rows = connection.execute(
            text("select sql from sqlite_master where sql is not null")
        ).scalars()
        return {" ".join(sql.split()) for sql in rows}


def test_format_version_is_derived_from_the_last_migration() -> None:
    assert MIGRATIONS[-1].version == FORMAT_VERSION


def test_migration_versions_are_unique_and_start_at_one() -> None:
    versions = [migration.version for migration in MIGRATIONS]
    assert versions == list(range(1, len(versions) + 1))


def test_every_migration_is_named() -> None:
    for migration in MIGRATIONS:
        assert migration.name


def test_a_fresh_database_is_created_at_the_current_generation(tmp_path: Path) -> None:
    """Every migration runs, and the file is stamped with the last one's version.

    It asserted ``== 1`` while the baseline was the only generation. The chain
    exists again, so the claim is the general one: a fresh file ends up at
    ``FORMAT_VERSION``, whatever that is.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    assert store.format_version == FORMAT_VERSION
    assert len(MIGRATIONS) == FORMAT_VERSION
    store.close()


def test_the_baseline_creates_every_table_the_row_classes_declare(tmp_path: Path) -> None:
    """``_tables`` is generation 1, so nothing may be declared and not created."""
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        created = set(inspect(connection).get_table_names())
    assert set(Base.metadata.tables) <= created
    store.close()


@pytest.mark.parametrize(("index", "terms"), sorted(_UNIQUENESS_INDEXES.items()))
def test_the_baseline_carries_each_uniqueness_index(
    tmp_path: Path, index: str, terms: tuple[str, ...]
) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    statement = next((sql for sql in _schema(store) if index in sql), None)
    assert statement is not None, f"{index} is not in the baseline schema"
    for term in terms:
        assert term in statement
    store.close()


def test_a_uniqueness_index_actually_refuses_a_duplicate(tmp_path: Path) -> None:
    """One of them exercised for real, so the parametrized test above means something.

    ``token`` is the subject because its rule is the case-insensitive one, which
    a plain ``CREATE UNIQUE INDEX`` would not give: without ``COLLATE NOCASE``
    ``token revoke ci`` could find two credentials.
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


def test_two_fresh_databases_have_the_same_schema(tmp_path: Path) -> None:
    """Schema creation is deterministic — the weaker half of the pair below."""
    first = SqliteMetadataStore(tmp_path / "first.db")
    first.initialize()
    expected = _schema(first)
    first.close()

    second = SqliteMetadataStore(tmp_path / "second.db")
    second.initialize()
    assert _schema(second) == expected
    second.close()


def _at_generation_one(path: Path) -> None:
    """Build a file the way a workspace created before migration 2 would look.

    **Not by walking a current file backwards** — there are no downgrade paths
    and inventing one here would be inventing the thing under test. It creates
    the tables from today's metadata and then *drops the columns the later
    migrations add*, which is what a generation-1 file genuinely lacked, and
    re-stamps the version to match. Dropping is safe for exactly the reason the
    columns are the shape they are: none carries a foreign key, and SQLite
    refuses to drop one that does. Migration 16 reshaped an index rather than
    adding a column, so the old four-term spelling is recreated here by hand —
    the current declaration no longer knows it.

    **Every column-adding migration must be undone here, and the failure is the
    silent kind.** A column left in place makes its migration find the column
    already there and return early, so the migration never runs and
    ``test_a_fresh_database_and_a_migrated_one_have_the_same_schema`` compares a
    file against itself and passes. Migration 4 is the standing exception and is
    deliberately not undone: it creates a *table*, and dropping ``job`` here
    would test SQLite's DDL rather than anything this module owns.
    """
    store = SqliteMetadataStore(path)
    store.initialize()
    with store.engine.begin() as connection:
        connection.execute(text("ALTER TABLE batch DROP COLUMN parent_batch_id"))
        connection.execute(text("ALTER TABLE annotation DROP COLUMN job_id"))
        connection.execute(text("ALTER TABLE annotation_schema DROP COLUMN provenance"))
        connection.execute(text("ALTER TABLE inference_connection DROP COLUMN model_family"))
        connection.execute(text("ALTER TABLE annotation_job_asset DROP COLUMN touched_at"))
        connection.execute(text("ALTER TABLE annotation_job DROP COLUMN assignee"))
        connection.execute(text("ALTER TABLE inference_connection DROP COLUMN provider_id"))
        connection.execute(text("ALTER TABLE job DROP COLUMN error_code"))
        connection.execute(text("ALTER TABLE inference_connection DROP COLUMN credential_env"))
        connection.execute(text("ALTER TABLE project DROP COLUMN created_at"))
        connection.execute(text("ALTER TABLE inference_connection DROP COLUMN origin"))
        # The index reads image_scales, and SQLite refuses to drop a column an
        # index still references — the index has to go first.
        connection.execute(text("DROP INDEX uq_source_project_kind_path_fps_ranges_scale"))
        connection.execute(text("ALTER TABLE source DROP COLUMN image_scales"))
        connection.execute(
            text(
                "CREATE UNIQUE INDEX uq_source_project_kind_path_fps ON source"
                " (project_id, kind, path,"
                " coalesce(json_extract(video, '$.extraction_fps'), 0))"
            )
        )
        connection.execute(text(f"UPDATE {META_TABLE} SET format_version = 1"))
    store.close()


def test_a_fresh_database_and_a_migrated_one_have_the_same_schema(tmp_path: Path) -> None:
    """The strong claim, and the whole reason the chain's rules exist.

    A column declared anywhere but last, or one carrying a foreign key, makes
    ``create_all`` and ``ALTER TABLE`` emit different ``CREATE TABLE`` text — and
    nothing else in this suite would notice, because each path is internally
    consistent. This is the comparison that catches it, and it became possible
    again the moment there was a second generation to migrate *from*.
    """
    fresh = SqliteMetadataStore(tmp_path / "fresh.db")
    fresh.initialize()
    expected = _schema(fresh)
    fresh.close()

    old = tmp_path / "old.db"
    _at_generation_one(old)
    migrated = SqliteMetadataStore(old)
    migrated.initialize()
    assert migrated.format_version == FORMAT_VERSION
    assert _schema(migrated) == expected
    migrated.close()


def test_a_project_written_before_the_column_reads_back_without_a_date(tmp_path: Path) -> None:
    """Migration 14 backfills nothing: nothing on disk says when an old project was made."""
    old = tmp_path / "old.db"
    _at_generation_one(old)
    with SqliteMetadataStore(old).engine.begin() as connection:
        connection.execute(text("insert into workspace (id, name) values ('w', 'ws')"))
        connection.execute(
            text("insert into project (id, workspace_id, name) values ('p', 'w', 'signs')")
        )

    migrated = SqliteMetadataStore(old)
    migrated.initialize()
    with migrated.engine.connect() as connection:
        rows = connection.execute(text("select name, created_at from project")).all()
    assert rows == [("signs", None)]
    migrated.close()


def test_a_connection_written_before_the_column_is_given_the_origin_its_kind_implies(
    tmp_path: Path,
) -> None:
    """Migration 15 backfills from the kind, because the kind is the whole of what
    an old row knows: a local connection could only ever have fetched from the
    hub, and an http one points at an endpoint somebody stood up."""
    old = tmp_path / "old.db"
    _at_generation_one(old)
    with SqliteMetadataStore(old).engine.begin() as connection:
        connection.execute(
            text(
                "insert into inference_connection (id, name, connection_type, model_id,"
                " model_revision, device, precision, setup_state, created_at, updated_at)"
                " values ('l', 'local', 'local', 'some/model', 'abc', 'cpu', 'fp32',"
                " 'not_set_up', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')"
            )
        )
        connection.execute(
            text(
                "insert into inference_connection (id, name, connection_type, model_id,"
                " model_revision, endpoint_url, setup_state, created_at, updated_at)"
                " values ('h', 'remote', 'http', 'some/model', 'abc',"
                " 'https://example.invalid/predict', 'ready',"
                " '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')"
            )
        )

    migrated = SqliteMetadataStore(old)
    migrated.initialize()
    with migrated.engine.connect() as connection:
        rows = connection.execute(
            text("select name, origin from inference_connection order by name")
        ).all()
    assert rows == [("local", "huggingface"), ("remote", "custom")]
    migrated.close()


def test_the_reshaped_source_index_still_refuses_a_duplicate_origin(tmp_path: Path) -> None:
    """Migration 16 exercised for real: the index it creates has teeth on an old file.

    Both rows spell a whole-clip source the way every generation has — no
    ``$.ranges`` key — so the new fifth term reads ``''`` for each and the
    four shared terms collide.
    """
    provenance = (
        '{"metadata": {"width": 64, "height": 48, "fps": 10.0,'
        ' "duration_seconds": 2.0, "codec": "h264"}, "extraction_fps": 1.0}'
    )
    old = tmp_path / "old.db"
    _at_generation_one(old)
    with SqliteMetadataStore(old).engine.begin() as connection:
        connection.execute(text("insert into workspace (id, name) values ('w', 'ws')"))
        connection.execute(
            text("insert into project (id, workspace_id, name) values ('p', 'w', 'clips')")
        )
        connection.execute(
            text(
                "insert into source (id, project_id, kind, path, registered_at,"
                " capture_params, video) values ('s1', 'p', 'video', '/clips/a.mp4',"
                f" '2026-01-01T00:00:00+00:00', '{{}}', '{provenance}')"
            )
        )

    migrated = SqliteMetadataStore(old)
    migrated.initialize()
    with pytest.raises(IntegrityError), migrated.engine.begin() as connection:
        connection.execute(
            text(
                "insert into source (id, project_id, kind, path, registered_at,"
                " capture_params, video) values ('s2', 'p', 'video', '/clips/a.mp4',"
                f" '2026-01-02T00:00:00+00:00', '{{}}', '{provenance}')"
            )
        )
    migrated.close()


def test_the_scale_terms_fork_the_migrated_index(tmp_path: Path) -> None:
    """Migration 18 exercised for real: scale forks identity, its absence collides.

    The first pair differs only in ``$.scale_percent``; the second only in
    ``image_scales`` — both must land. A row repeating an existing spelling
    exactly must still be refused.
    """
    whole = (
        '{"metadata": {"width": 64, "height": 48, "fps": 10.0,'
        ' "duration_seconds": 2.0, "codec": "h264"}, "extraction_fps": 1.0}'
    )
    scaled = whole[:-1] + ', "scale_percent": 50}'
    old = tmp_path / "old.db"
    _at_generation_one(old)
    with SqliteMetadataStore(old).engine.begin() as connection:
        connection.execute(text("insert into workspace (id, name) values ('w', 'ws')"))
        connection.execute(
            text("insert into project (id, workspace_id, name) values ('p', 'w', 'clips')")
        )
        connection.execute(
            text(
                "insert into source (id, project_id, kind, path, registered_at,"
                " capture_params, video) values ('s1', 'p', 'video', '/clips/a.mp4',"
                f" '2026-01-01T00:00:00+00:00', '{{}}', '{whole}')"
            )
        )

    migrated = SqliteMetadataStore(old)
    migrated.initialize()
    with migrated.engine.begin() as connection:
        connection.execute(
            text(
                "insert into source (id, project_id, kind, path, registered_at,"
                " capture_params, video) values ('s2', 'p', 'video', '/clips/a.mp4',"
                f" '2026-01-02T00:00:00+00:00', '{{}}', '{scaled}')"
            )
        )
        connection.execute(
            text(
                "insert into source (id, project_id, kind, path, registered_at,"
                " capture_params) values ('d1', 'p', 'image_directory', '/stills',"
                " '2026-01-02T00:00:00+00:00', '{}')"
            )
        )
        connection.execute(
            text(
                "insert into source (id, project_id, kind, path, registered_at,"
                " capture_params, image_scales) values ('d2', 'p', 'image_directory',"
                " '/stills', '2026-01-02T00:00:00+00:00', '{}',"
                " '{\"a.png\": 50}')"
            )
        )
    with pytest.raises(IntegrityError), migrated.engine.begin() as connection:
        connection.execute(
            text(
                "insert into source (id, project_id, kind, path, registered_at,"
                " capture_params, video) values ('s3', 'p', 'video', '/clips/a.mp4',"
                f" '2026-01-03T00:00:00+00:00', '{{}}', '{scaled}')"
            )
        )
    migrated.close()


def test_running_every_migration_again_changes_nothing(tmp_path: Path) -> None:
    """Idempotency, and now it covers the baseline rather than skipping it.

    While the chain existed this loop started at ``MIGRATIONS[1:]``, because
    migration 1 was the thing every later one had to be idempotent *against*.
    The baseline is ``create_all``, which is ``checkfirst`` by default, so it can
    be held to the same standard as anything appended after it — and the next
    migration inherits a test that already runs the whole list.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    before = _schema(store)

    with store.engine.begin() as connection:
        for migration in MIGRATIONS:
            migration.upgrade(connection)

    assert _schema(store) == before
    assert store.format_version == FORMAT_VERSION
    store.close()


#: The tail of every table whose last columns arrived by ``ALTER TABLE``, and
#: which therefore must not be reordered. See the test below.
_DECLARED_TAILS = {
    # Migration 5 appends ``provenance`` after the two before it, so the tail is
    # three deep and its *order* is the assertion — swapping any two would split
    # the ``create_all`` path from the migration path.
    "annotation_schema": ["description", "created_at", "provenance"],
    "source": ["display_name", "image_scales"],
    "asset": ["thumbnail_hash", "ingested_at"],
    # Migration 2 and migration 3, in that order. Both arrive by ``ALTER`` and
    # SQLite appends, so declaring either anywhere but last would split the
    # ``create_all`` path from the migration path — which is exactly what the
    # docstring below says this exists to catch.
    "batch": ["parent_batch_id"],
    "annotation": ["job_id"],
    "annotation_job_asset": ["touched_at"],
    "annotation_job": ["assignee"],
    # Migration 7 then migration 11, in that order — the second appended column
    # is what gives this table an order to get wrong, which is why it earns an
    # entry only now.
    "inference_connection": ["model_family", "provider_id", "credential_env", "origin"],
    "job": ["error_code"],
    "project": ["created_at"],
}


@pytest.mark.parametrize(("table", "tail"), sorted(_DECLARED_TAILS.items()))
def test_the_newest_columns_are_declared_last_on_their_row_class(
    tmp_path: Path, table: str, tail: list[str]
) -> None:
    """The column-order assertion, widened against the baseline.

    SQLite *appends* a column added by ``ALTER TABLE``, so a column declared
    anywhere but last makes the ``create_all`` path and the migration path emit
    different ``CREATE TABLE`` text. That is what this asserted while the chain
    existed, by comparing a fresh file against a migrated one.

    With one baseline there is no migrated file to compare against, and this is
    deliberately the weaker claim: it pins the *declared* tail and asserts the
    baseline puts it on disk in that order. A tautology today — ``create_all``
    emits declared order — and not one tomorrow, because the moment a migration
    appends a column to one of these tables, a reordering silently splits the two
    creation paths and there would be nothing on record saying which order was
    right. This is that record.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    with store.engine.connect() as connection:
        created = [c["name"] for c in inspect(connection).get_columns(table)]
    declared = [column.name for column in Base.metadata.tables[table].columns]
    assert created == declared
    assert declared[-len(tail) :] == tail
    store.close()


# --- the stamp is a claim, and this is what checks it -----------------------
#
# ``format_version`` says which generation a file holds, and that claim rests
# entirely on every schema change arriving with a version to go with it. Nothing
# enforces that rule, and with one baseline every workspace anybody creates is
# stamped ``1`` forever — so a file that missed a column is stamped exactly like
# one that did not, and ``create_all`` will not notice: it creates missing
# *tables* and leaves an existing one as it found it. This is what that looks
# like from the outside: an opaque 500 out of a route with no connection to the
# problem, and the real cause only in the server's log.


def _initialized(path: Path) -> SqliteMetadataStore:
    """A store over a fresh file at the current generation."""
    store = SqliteMetadataStore(path)
    store.initialize()
    store.close()
    return SqliteMetadataStore(path)


def test_a_file_missing_a_column_this_build_declares_is_refused_by_name(tmp_path: Path) -> None:
    """A stale schema under a current stamp, at the layer that catches it.

    ``source.display_name`` is the column the real report was about, and the
    shape is what matters: the file is stamped at this build's own
    ``FORMAT_VERSION``, so nothing about the stamp can tell it apart from a
    current one.
    """
    db = tmp_path / "visionset.db"
    store = _initialized(db)
    with store.engine.begin() as connection:
        connection.execute(text("alter table source drop column display_name"))
    store.close()

    reopened = SqliteMetadataStore(db)
    assert reopened.format_version == FORMAT_VERSION
    with pytest.raises(WorkspaceSchemaMismatch) as refusal:
        reopened.initialize()
    reopened.close()

    # Named, both halves. The remedy depends on which way the gap runs, and
    # neither answer is reachable from "it broke".
    assert "source" in str(refusal.value)
    assert "display_name" in str(refusal.value)


def test_a_file_missing_a_table_this_build_declares_is_refused_by_name(tmp_path: Path) -> None:
    """The other half of the same gap, and the baseline does not repair it.

    Worth stating, because the opposite is the natural guess: migration 1 is
    ``create_all``, which does put back a table it finds missing — but it only
    runs while something is *pending*, and nothing is pending on a file already
    stamped at this generation. So the baseline never gets the chance, and the
    check below is the whole of what stands between a missing table and the same
    runtime failure a missing column produces.
    """
    db = tmp_path / "visionset.db"
    store = _initialized(db)
    with store.engine.begin() as connection:
        connection.execute(text("pragma foreign_keys = off"))
        connection.execute(text("drop table release"))
    store.close()

    reopened = SqliteMetadataStore(db)
    with pytest.raises(WorkspaceSchemaMismatch) as refusal:
        reopened.initialize()
    reopened.close()

    assert "release" in str(refusal.value)


def test_a_column_this_build_does_not_declare_is_not_a_mismatch(tmp_path: Path) -> None:
    """Only *missing* is checked, and the asymmetry is deliberate.

    A file holding more than ``_tables`` declares was written by a later build.
    Nothing here ever selects a column it does not name, so the extra one is
    inert — and the version stamp is what is supposed to catch that direction.
    Refusing it would turn every forward-compatible read into a hard stop.
    """
    db = tmp_path / "visionset.db"
    store = _initialized(db)
    with store.engine.begin() as connection:
        connection.execute(text("alter table source add column invented_later varchar"))
    store.close()

    reopened = SqliteMetadataStore(db)
    reopened.initialize()
    reopened.close()


def test_a_file_stamped_ahead_is_refused_for_being_ahead_and_not_for_its_schema(
    tmp_path: Path,
) -> None:
    """Order matters: the stated difference is answered before the unstated one.

    A file from a later build is both newer *and* likely to be missing nothing —
    but if it were missing something, the useful answer is still that it is
    newer, because that is the one the holder can act on.
    """
    db = tmp_path / "visionset.db"
    store = _initialized(db)
    with store.engine.begin() as connection:
        connection.execute(
            text("update _visionset_meta set format_version = :ahead"),
            {"ahead": FORMAT_VERSION + 1},
        )
        connection.execute(text("alter table source drop column display_name"))
    store.close()

    reopened = SqliteMetadataStore(db)
    with pytest.raises(WorkspaceFormatTooNew):
        reopened.initialize()
    reopened.close()


def test_the_refusal_does_not_pretend_the_file_is_damaged() -> None:
    """A valid database of a different generation is not a corrupt one.

    Catching ``WorkspaceCorrupt`` must not catch this: its docstring sends the
    reader to look at the file and the disk, and here there is nothing wrong
    with either.
    """
    assert not issubclass(WorkspaceSchemaMismatch, WorkspaceCorrupt)
    assert not issubclass(WorkspaceSchemaMismatch, WorkspaceFormatTooNew)


def test_a_fresh_file_is_not_refused_by_the_check_that_guards_the_stale_one(
    tmp_path: Path,
) -> None:
    """The tripwire runs on every open, including the one that just created it.

    Worth its own test rather than riding on the rest of the suite: the check
    compares reflection against ``_tables``, so a disagreement between the two
    would fail *every* workspace this build creates, and the failure should say
    so here rather than everywhere.
    """
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    store.initialize()
    assert store.format_version == FORMAT_VERSION
    store.close()


# --- what migration 3 can and cannot know -----------------------------------
#
# An annotation records only its `asset_id`; a job records which assets it
# carries. So "which round produced this label" is answerable exactly when the
# asset belongs to one job, and unanswerable when it belongs to two — because the
# schema never recorded it, not because the migration is lazy. The backfill sets
# a value only in the first case, and these are the two halves of that claim.


def _annotated_at_generation_one(path: Path, jobs_per_asset: int) -> None:
    """A generation-1 file holding one annotation whose asset sits in N jobs."""
    _at_generation_one(path)
    store = SqliteMetadataStore(path)
    with store.engine.begin() as connection:
        # Dependency order, because `PRAGMA foreign_keys = ON` is set on every
        # connection this store opens — a row inserted before its parent is a
        # constraint failure rather than a row.
        for statement in (
            "insert into workspace (id, name) values ('w', 'ws')",
            "insert into project (id, workspace_id, name, description) "
            "values ('p', 'w', 'highway', null)",
            "insert into asset (id, project_id, modality, content_hash, uri) "
            "values ('a', 'p', 'image', 'deadbeef', '/tmp/a.png')",
            "insert into batch (id, project_id, name, state) "
            "values ('b', 'p', 'first', 'in_annotation')",
            "insert into task_group (id, batch_id, name) values ('g', 'b', 'first_round')",
            "insert into annotation "
            "(id, asset_id, label_class, schema_version, geometry, provenance, attributes) "
            "values ('n', 'a', 'sign', 1, '{}', 'human', '{}')",
        ):
            connection.execute(text(statement))
        for index in range(jobs_per_asset):
            connection.execute(
                text(
                    "insert into annotation_job (id, task_group_id, state) "
                    f"values ('j{index}', 'g', 'in_progress')"
                )
            )
            connection.execute(
                text(
                    "insert into annotation_job_asset (job_id, asset_id, progress, position) "
                    f"values ('j{index}', 'a', 'annotated', 0)"
                )
            )
    store.close()


def _job_of(store: SqliteMetadataStore, annotation_id: str) -> str | None:
    with store.engine.connect() as connection:
        return connection.execute(
            text("select job_id from annotation where id = :id"), {"id": annotation_id}
        ).scalar_one()


def test_the_backfill_attributes_a_label_whose_asset_belongs_to_one_job(tmp_path: Path) -> None:
    path = tmp_path / "one.db"
    _annotated_at_generation_one(path, jobs_per_asset=1)

    store = SqliteMetadataStore(path)
    store.initialize()

    assert _job_of(store, "n") == "j0"
    store.close()


def test_the_backfill_leaves_an_ambiguous_label_alone_rather_than_guessing(tmp_path: Path) -> None:
    """Two jobs over one asset: the schema never said which, so neither does this.

    Writing "the first one we found" would put a confident wrong answer where an
    honest absent one belongs, and no reader downstream could tell which it had.
    """
    path = tmp_path / "two.db"
    _annotated_at_generation_one(path, jobs_per_asset=2)

    store = SqliteMetadataStore(path)
    store.initialize()

    assert _job_of(store, "n") is None
    store.close()


def test_a_second_run_does_not_overwrite_an_attribution_already_there(tmp_path: Path) -> None:
    """The ``job_id IS NULL`` guard, which is what makes re-running safe.

    Migration 1 is ``create_all`` of *today's* metadata, so a fresh database
    already carries the column and then runs this migration anyway — and a
    service may have written a value the migration must not touch.
    """
    path = tmp_path / "again.db"
    _annotated_at_generation_one(path, jobs_per_asset=1)
    store = SqliteMetadataStore(path)
    store.initialize()
    with store.engine.begin() as connection:
        connection.execute(text("update annotation set job_id = 'chosen' where id = 'n'"))
        connection.execute(text(f"update {META_TABLE} set format_version = 1"))
    store.close()

    reopened = SqliteMetadataStore(path)
    reopened.initialize()

    assert _job_of(reopened, "n") == "chosen"
    reopened.close()


def test_schema_provenance_starts_null_because_nothing_recorded_who_published(
    tmp_path: Path,
) -> None:
    """Migration 5 backfills nothing, and unlike migration 3 there is nothing it could.

    Migration 3 can attribute a label because ``annotation_job_asset`` recorded
    enough to answer it in the unambiguous case. Nothing anywhere recorded which
    surface published a schema version, so every pre-existing version stays NULL
    — which the domain reads as "nobody said" rather than as a third kind.

    Worth its own test rather than riding on the schema comparison above: that one
    proves the *column* arrives, and this proves the migration does not invent a
    value for the rows that were already there.
    """
    path = tmp_path / "provenance.db"
    _at_generation_one(path)
    store = SqliteMetadataStore(path)
    with store.engine.begin() as connection:
        for statement in (
            "insert into workspace (id, name) values ('w', 'ws')",
            "insert into project (id, workspace_id, name, description) "
            "values ('p', 'w', 'highway', null)",
            "insert into annotation_schema (id, project_id, version, classes) "
            "values ('s', 'p', 1, '[]')",
        ):
            connection.execute(text(statement))
    store.close()

    reopened = SqliteMetadataStore(path)
    reopened.initialize()

    with reopened.engine.connect() as connection:
        assert (
            connection.execute(
                text("select provenance from annotation_schema where id = 's'")
            ).scalar_one()
            is None
        )
    reopened.close()


def test_batch_lineage_starts_null_because_nothing_was_a_correction_of_anything(
    tmp_path: Path,
) -> None:
    """Migration 2 backfills nothing, and that is a fact rather than a shortcut."""
    path = tmp_path / "lineage.db"
    _at_generation_one(path)
    store = SqliteMetadataStore(path)
    with store.engine.begin() as connection:
        for statement in (
            "insert into workspace (id, name) values ('w', 'ws')",
            "insert into project (id, workspace_id, name, description) "
            "values ('p', 'w', 'highway', null)",
            "insert into batch (id, project_id, name, state) values ('b', 'p', 'first', 'draft')",
        ):
            connection.execute(text(statement))
    store.close()

    reopened = SqliteMetadataStore(path)
    reopened.initialize()

    with reopened.engine.connect() as connection:
        assert (
            connection.execute(
                text("select parent_batch_id from batch where id = 'b'")
            ).scalar_one()
            is None
        )
    reopened.close()
