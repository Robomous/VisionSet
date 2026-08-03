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
from visionset.kernel.adapters._tables import Base
from visionset.kernel.adapters.migrations import FORMAT_VERSION, MIGRATIONS
from visionset.kernel.errors import (
    WorkspaceCorrupt,
    WorkspaceFormatTooNew,
    WorkspaceSchemaMismatch,
)

#: Every uniqueness rule the store carries as a real index, and what makes each
#: one recognizable in ``sqlite_master``. A service-level rule with nothing
#: underneath it is a wish (``docs/persistence.md``), and these indexes are the
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
    "uq_source_project_kind_path_fps": ("json_extract", "coalesce"),
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


def test_a_fresh_database_is_created_at_the_baseline(tmp_path: Path) -> None:
    store = SqliteMetadataStore(tmp_path / "visionset.db")
    store.initialize()
    assert store.format_version == FORMAT_VERSION == 1
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
    """The equivalence machinery, kept for the migration that comes after this one.

    While the chain existed this compared a *fresh* file against one walked back
    to generation 1 and migrated forward, and that comparison is what caught a
    column declared in the wrong position. With a single baseline the two paths
    coincide, so today it proves only that schema creation is deterministic —
    a weak claim, deliberately kept, because the second migration turns it back
    into the strong one and ``_schema`` is the piece that would otherwise be
    rewritten from memory.
    """
    first = SqliteMetadataStore(tmp_path / "first.db")
    first.initialize()
    expected = _schema(first)
    first.close()

    second = SqliteMetadataStore(tmp_path / "second.db")
    second.initialize()
    assert _schema(second) == expected
    second.close()


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
    "annotation_schema": ["description", "created_at"],
    "source": ["display_name"],
    "asset": ["thumbnail_hash", "ingested_at"],
}


@pytest.mark.parametrize(("table", "tail"), sorted(_DECLARED_TAILS.items()))
def test_the_newest_columns_are_declared_last_on_their_row_class(
    tmp_path: Path, table: str, tail: list[str]
) -> None:
    """The column-order assertion from #230, kept and widened against the baseline.

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
# *tables* and leaves an existing one as it found it. #277 is what that looks
# like from the outside: an opaque 500 out of a route with no connection to the
# problem, and the real cause only in the server's log.


def _initialized(path: Path) -> SqliteMetadataStore:
    """A store over a fresh file at the current generation."""
    store = SqliteMetadataStore(path)
    store.initialize()
    store.close()
    return SqliteMetadataStore(path)


def test_a_file_missing_a_column_this_build_declares_is_refused_by_name(tmp_path: Path) -> None:
    """#277, reproduced at the layer that should have caught it.

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
