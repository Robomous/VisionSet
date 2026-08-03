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

**A migration may drop, but it has to earn it.** Migrations 6 and 7 rebuild the
``release`` and ``source`` tables instead of altering them, because the columns
they needed could not be added honestly and because the rows they discard could
not have been made correct. Both check that there are none rather than taking
the argument on trust. That is the bar; a migration that would lose real data
does not clear it — and note that under ``PRAGMA foreign_keys = ON``, which this
store sets on every connection, ``DROP TABLE`` runs an implicit ``DELETE`` that
cascades to children *silently*. A rebuild of a table with children has to count
those too. Migration 7 does; migration 6 had none to count. Migration 8 is the
worked example of the other answer: ``asset`` has four cascading children *and*
rows that are perfectly legitimate, so it alters and keeps them.

Migrations only run forward. A workspace stamped ahead of this build is
rejected (``WorkspaceFormatTooNew``) rather than silently downgraded.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import cast

from sqlalchemy import Column, Connection, Table, inspect, text
from sqlalchemy.schema import CreateColumn, CreateIndex

from visionset.kernel.adapters._tables import (
    ANNOTATION_TAG_UNIQUE,
    ASSET_CONTENT_UNIQUE,
    PROJECT_NAME_UNIQUE,
    SOURCE_ORIGIN_UNIQUE,
    AnnotationJobAssetRow,
    AnnotationRow,
    AnnotationSchemaRow,
    AssetRow,
    Base,
    BatchRow,
    IngestJobRow,
    ReleaseRow,
    SourceRow,
    TokenRow,
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

    The first migration here that drops a table (migration 7 is the other), and
    it could not have been an ``ALTER``. Three of the columns it adds are
    ``NOT NULL`` with no honest default — SQLite refuses such a column without one, so the ``ALTER``
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


def _rebuild_source_with_provenance(connection: Connection) -> None:
    """Rebuild ``source`` around real provenance: where, when, and at what rate.

    Before this, a source was ``(kind, uri)`` and nothing else — a placeholder
    with no service behind it. It gains a registration timestamp, the capture
    parameters an operator supplied, and for a clip the probe result plus the
    decomposition rate; ``uri`` becomes ``path``, which is what it always held.

    A rebuild rather than five ``ALTER``s, on migration 6's terms.
    ``registered_at`` is ``NOT NULL`` with no honest default — SQLite refuses
    such a column without one, so the ``ALTER`` route would bake a fictional
    epoch into every fresh database forever. And decisively: ``kind`` on a
    pre-#18 row reads ``'local_folder'``, which is not a value ``SourceKind``
    has, so those rows would come back as validation errors rather than as
    sources. Adding the columns would manufacture rows that are broken by
    construction.

    Idempotent the way migrations 3 to 6 are: the inspector check *is* the
    ``checkfirst``, because migration 1 is ``create_all`` of current metadata.
    That check comes first so the fresh path never reaches the counts below.

    **Two counts, not one.** ``ingest_job.source_id`` is ``ON DELETE CASCADE``
    and the store sets ``PRAGMA foreign_keys = ON`` on every connection, so
    ``DROP TABLE source`` performs an implicit ``DELETE FROM source`` that takes
    the ingest jobs with it — silently, without an error. Migration 6 dropped a
    table with no children and so never met this. Counting only ``source`` would
    let a workspace with orphan-parented jobs pass the check and lose them.

    Nothing could write either row before ``SourceService`` existed, but "nothing
    could" is a claim about a build, not about a file on disk — so a workspace
    that somehow holds one is refused rather than quietly emptied.
    """
    # ``__table__`` is declared as the general ``FromClause``; for a mapped class
    # it is always the ``Table``, which is what ``drop``/``create`` need.
    table = cast(Table, SourceRow.__table__)
    stored = {existing["name"] for existing in inspect(connection).get_columns(table.name)}
    if "registered_at" in stored:
        return
    # Raw text: the table still has its pre-#18 shape here, so the mapped columns
    # in ``_tables`` no longer describe the thing being counted.
    counts = {
        name: connection.execute(text(f"SELECT count(*) FROM {name}")).scalar_one()
        for name in ("source", "ingest_job")
    }
    if any(counts.values()):
        raise WorkspaceCorrupt(
            "this workspace holds source rows written before SourceService existed "
            f"({counts['source']} sources, {counts['ingest_job']} ingest jobs). They record no "
            "registration date and their 'local_folder' kind no longer exists, so there is "
            "nothing to migrate them to; register the sources again instead."
        )
    table.drop(connection)
    table.create(connection)


#: What a workspace written before the ingest pipeline may hold that the two new
#: unique indexes will not accept. Raw text, because these are *duplicate*
#: groups rather than rows and the mapped columns cannot express the grouping.
_DUPLICATE_COUNTS = {
    "asset": (
        "SELECT count(*) FROM (SELECT project_id, content_hash FROM asset "
        "GROUP BY project_id, content_hash HAVING count(*) > 1)"
    ),
    "source": (
        "SELECT count(*) FROM (SELECT project_id, kind, path, "
        "coalesce(json_extract(video, '$.extraction_fps'), 0) AS fps FROM source "
        "GROUP BY project_id, kind, path, fps HAVING count(*) > 1)"
    ),
}


def _rebuild_ingest_job_with_its_batch_link(connection: Connection) -> None:
    """Re-create ``ingest_job`` so its new ``batch_id`` can carry a real key.

    The third rebuild in this file, and the cheapest: no children to cascade to,
    and nothing has ever written a row here. Migration 7 refuses any workspace
    that holds one, and no build before this one had an ``IngestService``, so at
    this point the table is empty on every path. "Nothing could" is a claim about
    a build rather than about a file, so it is counted, and a workspace that
    somehow holds one is refused rather than quietly emptied.
    """
    # ``__table__`` is declared as the general ``FromClause``; for a mapped class
    # it is always the ``Table``, which is what ``drop``/``create`` need.
    table = cast(Table, IngestJobRow.__table__)
    stored = {existing["name"] for existing in inspect(connection).get_columns(table.name)}
    if "batch_id" in stored:
        return
    if connection.execute(text("SELECT count(*) FROM ingest_job")).scalar_one():
        raise WorkspaceCorrupt(
            "this workspace holds ingest job rows written before IngestService existed. They "
            "record no batch, and the assets they claim to have produced cannot be identified; "
            "there is nothing to migrate them to, so run the ingests again instead."
        )
    table.drop(connection)
    table.create(connection)


def _add_ingest_origin_and_uniqueness(connection: Connection) -> None:
    """Give an asset its origin, a run its batch, and both rules an index.

    **``asset`` is altered and ``ingest_job`` is rebuilt**, and the split is not
    arbitrary. A key added by ``ALTER TABLE ... ADD COLUMN`` is spelled inline on
    the column, while ``create_all`` spells one as a table constraint: the two
    texts differ, so any column carrying a foreign key has to arrive by a
    rebuild or not carry one at all. ``ingest_job.batch_id`` needs its key —
    batches *are* deleted, and a run pointing at one that is gone is a lie — and
    that table has no children and is provably empty here, so it is rebuilt (and
    counted rather than assumed, on migrations 6 and 7's terms).
    ``asset.source_id`` cannot have either: ``asset`` has four ``ON DELETE
    CASCADE`` children (``batch_asset``, ``annotation``, ``dataset_member``,
    ``annotation_job_asset``) and under ``PRAGMA foreign_keys = ON`` a
    ``DROP TABLE`` runs an implicit ``DELETE`` that takes all four *silently*,
    and unlike a pre-#12 release or a pre-#18 source its rows are perfectly
    legitimate — M1's example wrote them through the same public port a service
    uses. So it is altered, and the column is a plain reference; see
    ``_tables.AssetRow`` for what that costs and why it is little.

    Every added column is nullable and honest: NULL means "this row predates the
    ingest pipeline", which is true, where a ``server_default`` would invent a
    format nobody probed.

    Idempotent the way 3 to 5 are for the columns (the inspector check inside
    ``_add_column`` *is* the ``checkfirst``), the way 6 and 7 are for the rebuild
    (an inspector check ahead of it), and the way 2 is for the indexes, which
    share one object each with ``_tables`` rather than restating DDL.

    **Two duplicate pre-checks, because an index can fail on data already on
    disk.** Both uniqueness rules existed before this migration as service-level
    pre-checks with nothing underneath them — ``docs/persistence.md`` calls such
    a rule a wish — so a workspace written by an earlier build may hold rows the
    index refuses. It is refused with a sentence naming both counts rather than
    letting an ``IntegrityError`` escape from ``initialize()``. Nothing is
    dropped on that path, so it is a stop rather than a rescue: duplicate assets
    cannot be merged automatically, because each may carry its own annotations.
    """
    counts = {
        name: connection.execute(text(query)).scalar_one()
        for name, query in _DUPLICATE_COUNTS.items()
    }
    if any(counts.values()):
        raise WorkspaceCorrupt(
            f"this workspace holds {counts['asset']} group(s) of duplicate assets (one project, "
            f"one content hash) and {counts['source']} group(s) of duplicate sources (one "
            "project, kind, path and extraction rate). Ingest makes content the identity of an "
            "asset and an origin the identity of a source, so neither set can be kept as it "
            "stands; each duplicate may carry its own annotations, so merge or remove them by "
            "hand first."
        )
    # ``.c`` is typed as the generic column collection; each entry is a real
    # ``Column``, which is what ``CreateColumn`` needs.
    for column in (
        AssetRow.__table__.c.format,
        AssetRow.__table__.c.source_id,
        AssetRow.__table__.c.frame_index,
        AssetRow.__table__.c.frame_timestamp,
    ):
        _add_column(connection, cast(Column[object], column))
    _rebuild_ingest_job_with_its_batch_link(connection)
    ASSET_CONTENT_UNIQUE.create(connection, checkfirst=True)
    # Not ``checkfirst``, unlike every other index here, and the reason is worth
    # the two lines: ``checkfirst`` asks the inspector, and SQLAlchemy cannot
    # reflect an **expression-based** index — it skips it with a warning, reports
    # the index as absent and re-issues the ``CREATE``, which then fails on
    # every fresh database. ``IF NOT EXISTS`` asks SQLite instead. The DDL is
    # still compiled from the one object in ``_tables``, so nothing is restated.
    connection.execute(CreateIndex(SOURCE_ORIGIN_UNIQUE, if_not_exists=True))


def _add_ingest_progress_and_report(connection: Connection) -> None:
    """Give a run somewhere to record how far it got, and what it could not read.

    Four plain columns, and the plainness is the point after migration 8: none
    of them carries a foreign key, so ``ALTER TABLE`` can express all four and
    the rebuild that migration 8 needed is neither available nor wanted here.
    Not available, because this table is no longer empty — the build that
    shipped migration 8 writes rows to it, and those rows are legitimate. Not
    wanted, because nothing about them requires it.

    Idempotent the way 3 to 5 are: the inspector check inside ``_add_column``
    *is* the ``checkfirst``, because migration 1 is ``create_all`` of current
    metadata. No data pre-check either, and that is a claim rather than an
    oversight: every added column has an honest value for a row written before
    it. ``batch_name`` is NULL — that run recorded none, and a resume falls back
    to naming the batch after the source, exactly as the first attempt did.
    ``processed`` is ``0`` and ``failures`` is ``[]`` — that run counted nothing
    and reported nothing, which is true. ``total`` is NULL, which is the same
    "not knowable" a video run writes today.

    The two ``NOT NULL`` columns carry their ``server_default`` in ``_tables``
    rather than here, because SQLite refuses ``ADD COLUMN NOT NULL`` without a
    value for the rows already there and the DDL is compiled from the column
    object either way.
    """
    # ``.c`` is typed as the generic column collection; each entry is a real
    # ``Column``, which is what ``CreateColumn`` needs.
    for column in (
        IngestJobRow.__table__.c.batch_name,
        IngestJobRow.__table__.c.processed,
        IngestJobRow.__table__.c.total,
        IngestJobRow.__table__.c.failures,
    ):
        _add_column(connection, cast(Column[object], column))


def _add_asset_thumbnail(connection: Connection) -> None:
    """Give an asset somewhere to point at its cached preview.

    The plainest migration in the file, and every way it is plain is an
    argument rather than an omission. One column, so there is no ordering
    question between siblings. No foreign key — it names a blob, not a row — so
    migration 8's limit, that a column carrying a key cannot arrive by ``ALTER``
    at all, does not bite. Nothing to refuse and nothing to rebuild: ``asset``
    has four ``ON DELETE CASCADE`` children, and under ``PRAGMA foreign_keys =
    ON`` dropping it would take them silently.

    No data pre-check, and here that is easier to claim than it was for
    migration 9: the column is a *cache*, so NULL is not a legacy value that
    something has to tolerate but the ordinary state of an asset nobody has
    rendered a preview for yet. ``IngestService.backfill_thumbnails`` reads
    exactly that state and is the remedy for it.

    Idempotent the way 3 to 5 and 9 are — the inspector check inside
    ``_add_column`` *is* the ``checkfirst``, because migration 1 is
    ``create_all`` of current metadata.

    Unlike migration 9, this one **needs its own undo** in the tests'
    ``_downgrade_to_version_one``. Migration 9's columns rode back on migration
    8's rebuild of ``ingest_job``; ``asset`` is only ever altered, so nothing
    later removes this column on the way to generation 1. The flip side is that
    the walk back to generation 1 does exercise this ``ALTER`` for real, which
    is why there is no generation-9 schema twin of
    ``test_migration_nine_alters_a_table_migration_eight_rebuilt``.
    """
    # ``.c`` is typed as the generic column collection; the entry is a real
    # ``Column``, which is what ``CreateColumn`` needs.
    _add_column(connection, cast(Column[object], AssetRow.__table__.c.thumbnail_hash))


def _add_api_tokens(connection: Connection) -> None:
    """Give a workspace somewhere to keep the credentials that reach it.

    The first migration since 1 that creates a **table** rather than altering
    one, and that changes which tool does the idempotency. ``checkfirst`` on a
    ``Table`` asks ``has_table`` — a plain catalogue lookup — where migration 8
    had to reach for ``CREATE INDEX IF NOT EXISTS`` because SQLAlchemy cannot
    *reflect* an expression-based index and re-issued a ``CREATE`` that failed on
    every fresh database. Nothing here can meet that trap: the two indexes on
    this table come along inside ``Table.create`` and are never issued
    separately.

    Nothing to refuse and nothing to count, and that is a claim rather than an
    oversight. Migrations 6, 7 and 8 each had to prove a table was empty before
    dropping or rebuilding it; this table existed on no earlier generation, so
    there is no legacy row to be honest or dishonest about, and no child table
    references it, so ``PRAGMA foreign_keys = ON`` has nothing to cascade. The
    one thing ``checkfirst`` does *not* check is the shape of a table that is
    already there — and on the only path that can reach this migration with one,
    it was written by migration 1 from this same class.

    Unlike migration 9 and like migration 10, this one **needs its own undo** in
    the tests' ``_downgrade_to_version_one``, and the reason is sharper here:
    without a ``drop table token`` line the fresh-versus-migrated test would
    still *pass*, because the table would survive the downgrade and this
    migration would ``checkfirst``-skip. The undo is what gives it a real
    exercise, not what keeps a test honest that was already watching.
    """
    cast(Table, TokenRow.__table__).create(connection, checkfirst=True)


def _enforce_one_tag_per_asset_and_class(connection: Connection) -> None:
    """Make a duplicate classification tag unrepresentable, and collapse any there.

    #121: nothing prevented two identical whole-asset tags.
    ``AnnotationService._validate`` judges against the pinned schema alone and
    never reads the store, ``add`` writes the proposed list unchanged, and no
    index touched ``annotation``. ``ClassificationGeometry`` has zero fields and
    is frozen, so two tags of one class on one asset differed only by ``id`` —
    the same statement, made twice.

    **The backfill collapses rather than refusing**, and that is the one decision
    here worth arguing. Migration 6's precedent — count the rows and raise
    ``WorkspaceCorrupt`` — was right for a table nobody could have written to
    yet. Duplicates are *legal today*, so refusing would leave a workspace
    unopenable with a remedy its owner cannot apply: there is no SQL console in
    this product. Collapsing loses nothing that the model distinguishes.

    The survivor is the **lexicographically smallest id**. Any tie-break is
    arbitrary by construction — the rows are one statement — so the one that
    matters is that it is *deterministic*, and two machines migrating the same
    copy of a workspace agree.

    The one thing it can discard is a differing ``attributes`` map on the losing
    row. Stated rather than hidden: a classification tag is the least likely place
    for meaningful divergence, and the alternative is the unopenable workspace
    above.

    Not ``checkfirst``: the index is partial **and** expression-based, and
    SQLAlchemy can reflect neither — it would report the index absent and re-issue
    the ``CREATE``, which fails on every fresh database. ``IF NOT EXISTS`` asks
    SQLite. #20's trap, met a second time.
    """
    connection.execute(
        text(
            """
            delete from annotation
            where json_extract(geometry, '$.type') = 'classification_tag'
              and id not in (
                select min(id) from annotation
                where json_extract(geometry, '$.type') = 'classification_tag'
                group by asset_id, label_class
              )
            """
        )
    )
    connection.execute(CreateIndex(ANNOTATION_TAG_UNIQUE, if_not_exists=True))


def _add_asset_ingested_at(connection: Connection) -> None:
    """Give an asset somewhere to record when it arrived.

    #216: nothing in the schema answered "when did this data get here".
    ``Asset`` carried identity, provenance and a thumbnail hash, ``IngestJob``
    carried state and counters, and neither carried a clock — so "the six most
    recent images" and "last ingest" were both unanswerable, and #207 and #208
    shipped without them.

    Migration 10's shape exactly: a nullable column added to ``asset``, the one
    table that can only ever be *altered*. It has four ``ON DELETE CASCADE``
    children (``batch_asset``, ``annotation``, ``dataset_member``,
    ``annotation_job_asset``) and under ``PRAGMA foreign_keys = ON`` a rebuild
    would take all four silently.

    **No backfill, and that is the decision rather than the omission.** Existing
    rows get NULL and keep it forever. Every candidate value would be a
    fabrication: migration time records when somebody upgraded, file mtime
    describes a file this store does not own, and ``Source.registered_at`` is
    idempotent on ``(kind, path, extraction_fps)`` and never rewritten — so it
    would report the *first* registration for assets that arrived on the
    thousandth. A plausible-looking wrong timestamp is worse than an admitted
    gap, because nothing downstream can tell it is wrong. The consumers define
    what unknown means instead: ``last_ingest_at`` goes NULL, and
    ``IngestService.assets`` sorts these last.

    So NULL here is unlike ``thumbnail_hash``'s NULL, which looks identical and
    is not: that one has a remedy (``backfill_thumbnails``) because a preview
    can be re-rendered from bytes that are still there. This one has none.

    Idempotent the way 3 to 5, 9 and 10 are — the inspector check inside
    ``_add_column`` *is* the ``checkfirst``, because migration 1 is
    ``create_all`` of current metadata.

    Needs its own undo in the tests' ``_downgrade_to_version_one``, for
    migration 10's reason: nothing below rebuilds ``asset``, so nothing removes
    this column on the way to generation 1. The flip side is the same too — the
    walk back exercises this ``ALTER`` for real on the way up.
    """
    # ``.c`` is typed as the generic column collection; the entry is a real
    # ``Column``, which is what ``CreateColumn`` needs.
    _add_column(connection, cast(Column[object], AssetRow.__table__.c.ingested_at))


def _add_schema_description_and_created_at(connection: Connection) -> None:
    """Give a schema version somewhere to say why it exists, and when.

    #230: ``AnnotationSchema`` was ``(project_id, version, classes)``, so a
    version history had nothing to show but class lists — no reason, no date.
    Both columns land here together because they answer the same question from
    two sides, and splitting them across migrations would mean two ``ALTER``
    passes over one table for one feature.

    Migration 13's shape: nullable columns added to a table that can only ever be
    *altered*. ``annotation_schema`` has no children to cascade, but a rebuild
    would still be gratuitous — the two creation paths already agree once the
    columns are declared last on ``AnnotationSchemaRow``.

    **No backfill, and that is the decision rather than the omission.** A version
    published before this migration has no description because nobody wrote one,
    and no creation moment because nothing recorded it; migration time would
    record when somebody upgraded, which is a different fact wearing the right
    type. Migration 13 made the same call for ``asset.ingested_at`` and for the
    same reason: a plausible-looking wrong timestamp is worse than an admitted
    gap, because nothing downstream can tell it is wrong.

    Idempotent the way 3 to 5, 9, 10 and 13 are — the inspector check inside
    ``_add_column`` *is* the ``checkfirst``, because migration 1 is
    ``create_all`` of current metadata.

    Needs its own undo in the tests' ``_downgrade_to_version_one``, for migration
    10's reason: nothing below rebuilds ``annotation_schema``, so nothing removes
    these columns on the way to generation 1. The flip side is the same too — the
    walk back is what exercises this ``ALTER`` for real on the way up, and it
    fails loudly if the undo is missing, because column order would differ.
    """
    for name in ("description", "created_at"):
        # ``.c`` is typed as the generic column collection; each entry is a real
        # ``Column``, which is what ``CreateColumn`` needs.
        _add_column(connection, cast(Column[object], AnnotationSchemaRow.__table__.c[name]))


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
    Migration(
        version=7,
        name="source_provenance",
        upgrade=_rebuild_source_with_provenance,
    ),
    Migration(
        version=8,
        name="ingest_pipeline",
        upgrade=_add_ingest_origin_and_uniqueness,
    ),
    Migration(
        version=9,
        name="ingest_job_progress",
        upgrade=_add_ingest_progress_and_report,
    ),
    Migration(
        version=10,
        name="asset_thumbnail",
        upgrade=_add_asset_thumbnail,
    ),
    Migration(
        version=11,
        name="api_tokens",
        upgrade=_add_api_tokens,
    ),
    Migration(
        version=12,
        name="one_classification_tag_per_asset_and_class",
        upgrade=_enforce_one_tag_per_asset_and_class,
    ),
    Migration(
        version=13,
        name="asset_ingested_at",
        upgrade=_add_asset_ingested_at,
    ),
    Migration(
        version=14,
        name="schema_description_and_created_at",
        upgrade=_add_schema_description_and_created_at,
    ),
]

FORMAT_VERSION: int = MIGRATIONS[-1].version
