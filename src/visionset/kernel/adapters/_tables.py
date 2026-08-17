"""SQLAlchemy table definitions for the SQLite metadata store.

Private on purpose: ``visionset.kernel.adapters`` exports only
``SqliteMetadataStore``, so no SQLAlchemy type ever reaches a domain or port
signature. Rows are translated to and from domain models in ``_mappers``.

Storage decisions, and why (see ``docs/persistence.md`` for the long form):

- Collections that are *relations* get child tables — ``batch_asset`` and
  ``annotation_job_asset``. They are mutated one element at a time and queried
  from the asset side, which a JSON blob cannot serve.
- Collections that are *immutable value objects* get JSON columns —
  ``annotation_schema.classes``, ``annotation.geometry``, ``annotation.attributes``,
  ``release.split``, ``source.video``, ``ingest_job.failures``. A schema version
  must rehydrate byte-identical, and nothing ever queries a single
  ``LabelClass`` by name — or a single failed file — in SQL.
- A value object too large to belong in a row at all goes in the blob store, and
  the row keeps its hash — that is ``release.manifest_hash``. The line between
  the two is size and verifiability, not shape.
- Timestamps are TEXT holding an ISO-8601 string WITH its offset. SQLite's
  DATETIME storage format drops the timezone, and a timestamp that silently
  loses its offset is worse than no timestamp at all.

``list()`` ordering is SQLite's implicit ``rowid``, i.e. insertion order.

**Column order matters, and the rule is one rule for the whole file.** This
module is the schema baseline — ``migrations.py`` holds a single migration that
is ``create_all`` of what is declared here — so today every column arrives the
same way and its position is free. That stops being true for the first column a
*second* migration adds: SQLite appends a column added by ``ALTER TABLE``, so
one declared anywhere but last makes the two creation paths emit different
``CREATE TABLE`` text, and a workspace's schema then depends on when it was
created. So a column added by a migration goes **last on its row class**, in the
order that migration adds it, and stays there. Several columns below already sit
last for that reason and are marked; leave them where they are.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import ForeignKey, Index, Integer, String, UniqueConstraint, text
from sqlalchemy import Uuid as SaUuid
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import JSON, Float

META_TABLE = "_visionset_meta"


class Base(DeclarativeBase):
    """Declarative base for every VisionSet table."""


class MetaRow(Base):
    """The one-row schema ledger: which migration generation this file is at."""

    __tablename__ = META_TABLE

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    format_version: Mapped[int] = mapped_column(Integer, nullable=False)


class WorkspaceRow(Base):
    __tablename__ = "workspace"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    root_dir: Mapped[str | None] = mapped_column(String, nullable=True)


class ProjectRow(Base):
    __tablename__ = "project"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    workspace_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("workspace.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(String, nullable=True)


#: Project names are unique per workspace, case-insensitively.
#:
#: Declared as an ``Index`` rather than a ``UniqueConstraint`` because only an
#: index can carry a collation. ``COLLATE NOCASE`` folds ASCII only, and that is
#: deliberate: it catches the collision users actually make ("Road Signs" vs
#: "road signs") at the storage layer, while
#: ``WorkspaceService.require_project_name`` handles the rest — Unicode case
#: folding, NFC/NFD, surrounding whitespace — where the full normalized string
#: is in hand. The service reports the error; this index is the guarantee.
PROJECT_NAME_UNIQUE = Index(
    "uq_project_workspace_name",
    ProjectRow.workspace_id,
    ProjectRow.name.collate("NOCASE"),
    unique=True,
)


class AnnotationSchemaRow(Base):
    """One version of a project's labeling contract.

    ``description``, ``created_at`` and ``provenance`` are the newest columns
    here, in that order, and they stay **last** — see the module docstring's
    ordering rule. ``provenance`` arrived by ``ALTER`` after the other two, so it
    goes after them; reordering the three would split the ``create_all`` path
    from the migration path, which
    ``test_the_newest_columns_are_declared_last_on_their_row_class`` exists to
    catch. All three are nullable because a version can be published without a
    description, and because nothing invents an answer for a version written
    before the column existed; ``SchemaService`` is what decides when each is
    written.
    """

    __tablename__ = "annotation_schema"
    __table_args__ = (UniqueConstraint("project_id", "version", name="uq_schema_project_version"),)

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("project.id", ondelete="CASCADE"), index=True, nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    classes: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[str | None] = mapped_column(String, nullable=True)
    #: A ``SchemaProvenance``, or NULL for a version whose writer said nothing.
    #: Stored as its text value rather than as a constrained column: the domain
    #: enum is what validates, and a CHECK here would be a second spelling that
    #: a new member has to be remembered into. The newest column, so it is
    #: declared last — see the class docstring.
    provenance: Mapped[str | None] = mapped_column(String, nullable=True)


class SchemaDraftRow(Base):
    """The schema version a project is still writing, one row per kind.

    The unique index is the singleton: two rows of one kind for one project is
    not a state any operation produces, and the store refuses it rather than
    leaving a service to be careful. ``ON DELETE CASCADE`` for
    ``AnnotationSchemaRow``'s reason — a draft is meaningless without the project
    it drafts for.
    """

    __tablename__ = "schema_draft"
    __table_args__ = (UniqueConstraint("project_id", "kind", name="uq_schema_draft_project_kind"),)

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("project.id", ondelete="CASCADE"), index=True, nullable=False
    )
    #: A ``SchemaProvenance``, stored as its text value — ``AnnotationSchemaRow``'s
    #: rule, and for its reason: the domain enum is what validates, and a CHECK
    #: here would be a second spelling a new member has to be remembered into.
    kind: Mapped[str] = mapped_column(String, nullable=False)
    classes: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    note: Mapped[str] = mapped_column(String, nullable=False)
    based_on: Mapped[int | None] = mapped_column(Integer, nullable=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    #: ISO-8601 with offset, never SQLite ``DATETIME``. See the module docstring.
    updated_at: Mapped[str] = mapped_column(String, nullable=False)


class SourceRow(Base):
    """Registered origins: where a project's bytes came from.

    ``display_name`` sits at the bottom rather than beside ``path``, where it
    would read more naturally, because it is the newest column here — see the
    module docstring's ordering rule.
    """

    __tablename__ = "source"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("project.id", ondelete="CASCADE"), index=True, nullable=False
    )
    kind: Mapped[str] = mapped_column(String, nullable=False)
    #: The canonical absolute path of the origin — see ``domain.canonical_path``.
    path: Mapped[str] = mapped_column(String, nullable=False)
    #: ISO-8601 with offset, never SQLite ``DATETIME``. See the module docstring.
    registered_at: Mapped[str] = mapped_column(String, nullable=False)
    capture_params: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    #: A ``VideoProvenance``, or NULL for anything that is not a clip.
    video: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    #: What a caller asked this source to be called; NULL means nobody said.
    #: The newest column here, so it is declared last — see the class docstring.
    display_name: Mapped[str | None] = mapped_column(String, nullable=True)


#: One origin is one source: the backstop under ``SourceService``'s idempotency
#: rule — see that service's module docstring for why ingest is when it had to
#: acquire teeth.
#:
#: The fourth term is an **expression**, not a column, and it is ``coalesce``d
#: rather than left to be NULL. SQLite treats NULLs in a unique index as
#: distinct, so an image directory — whose ``video`` is NULL — would never
#: collide with itself, which is most of what this index is for. ``0`` cannot be
#: confused with a real rate: ``VideoProvenance.extraction_fps`` is ``gt=0``.
#:
#: This is SQL reading a JSON column, which the module docstring above reserves
#: for values "nothing ever queries". An index is not a query: no service gains
#: a JSON path, ``_source_to_domain`` still rehydrates ``VideoProvenance`` whole,
#: and the doctrine's purpose — no service building SQL over JSON — is intact.
SOURCE_ORIGIN_UNIQUE = Index(
    "uq_source_project_kind_path_fps",
    SourceRow.project_id,
    SourceRow.kind,
    SourceRow.path,
    text("coalesce(json_extract(video, '$.extraction_fps'), 0)"),
    unique=True,
)


class IngestJobRow(Base):
    """Ingestion runs: what was read, how far it got, and what it could not read.

    ``batch_id`` carries a foreign key, and that is worth knowing before adding
    another one like it: an ``ALTER TABLE ... ADD COLUMN`` cannot express a key
    the way ``create_all`` does — SQLite spells an added key inline on the
    column, a created table spells it as a table constraint, and the two texts
    differ. A migration that wants a key on a new column has to rebuild the
    table, which this one can no longer afford: its rows are legitimate work
    records, and under ``PRAGMA foreign_keys = ON`` a ``DROP TABLE`` takes
    children with it silently.
    """

    __tablename__ = "ingest_job"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    source_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("source.id", ondelete="CASCADE"), index=True, nullable=False
    )
    state: Mapped[str] = mapped_column(String, nullable=False)
    #: The fatal cause that stopped the run, as opposed to ``failures`` below.
    error: Mapped[str | None] = mapped_column(String, nullable=True)
    #: The batch this run materialized into. NULL until it reaches one — a run
    #: that dies during the decode never does. ``SET NULL`` and not ``CASCADE``:
    #: deleting the batch does not un-happen the run.
    batch_id: Mapped[UUID | None] = mapped_column(
        SaUuid, ForeignKey("batch.id", ondelete="SET NULL"), nullable=True
    )
    #: The name a batch this run creates will take, so a resumed run lands where
    #: the first attempt meant it to. Nullable: a run may name no batch.
    batch_name: Mapped[str | None] = mapped_column(String, nullable=True)
    #: Items read so far. The ``server_default`` is what lets a ``NOT NULL``
    #: column be re-added by ``ALTER TABLE`` — SQLite refuses one without a value
    #: for the rows already there — and is kept for that reason rather than
    #: removed now that the baseline creates the column outright.
    processed: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    #: Items the source offered, or NULL when that is not knowable up front —
    #: a directory can be listed, a clip cannot. See ``IngestJob.total``.
    total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: The per-file report: a list of ``IngestFailure``. JSON rather than a child
    #: table because it is read whole and never queried by field, the rule
    #: ``source.video`` follows. ``server_default`` on
    #: ``AnnotationRow.attributes``' terms.
    failures: Mapped[list[Any]] = mapped_column(JSON, nullable=False, server_default=text("'[]'"))


class AssetRow(Base):
    __tablename__ = "asset"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("project.id", ondelete="CASCADE"), index=True, nullable=False
    )
    modality: Mapped[str] = mapped_column(String, nullable=False)
    content_hash: Mapped[str] = mapped_column(String, index=True, nullable=False)
    uri: Mapped[str] = mapped_column(String, nullable=False)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # ``asset`` is the table a migration can only ever *alter*: four tables carry
    # ``ON DELETE CASCADE`` keys into it (``batch_asset``, ``annotation``,
    # ``dataset_member``, ``annotation_job_asset``), and under
    # ``PRAGMA foreign_keys = ON`` a ``DROP TABLE`` runs an implicit ``DELETE``
    # that takes all four silently. So a column added here arrives by ``ALTER``,
    # goes last, and cannot carry a foreign key — the six below are in that
    # position already, and ``source_id`` says what the last part costs.
    #: The decoded format, never the filename's suffix.
    format: Mapped[str | None] = mapped_column(String, nullable=True)
    #: The source these bytes were *first* seen in.
    #:
    #: **Deliberately not a foreign key**, and it is the only reference in this
    #: schema that is not. It became one by force: it arrived by ``ALTER TABLE``,
    #: which cannot express a key the way ``create_all`` does, and ``asset`` is
    #: the one table that could not be rebuilt to escape that — see the comment
    #: above. The baseline *could* declare the key now, and that is left undone
    #: on purpose: it is a decision about what happens to an asset when its
    #: source is deleted, which nobody has taken, not a leftover of the chain.
    #: What is given up meanwhile is small: there is no ``SourceService.delete``,
    #: and on the
    #: one deletion path that does exist — a project's cascade — the asset and
    #: the source both die by their own ``project_id`` keys. When a source
    #: delete is added it must clear these itself, and say so where it is
    #: written. Unindexed too: nothing lists assets by source.
    source_id: Mapped[UUID | None] = mapped_column(SaUuid, nullable=True)
    #: Position in the *extracted* sequence, for an asset cut out of a clip.
    frame_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Seconds into the clip. The locator that survives a different rate.
    frame_timestamp: Mapped[float | None] = mapped_column(Float, nullable=True)
    #: A cached preview in the blob store.
    #:
    #: Nullable because this one is a *cache*: NULL means "no preview yet",
    #: whether the bytes will not render or the asset simply has not been
    #: reached, and ``IngestService.backfill_thumbnails`` reads it to find both.
    #:
    #: Unindexed, and deliberately: the one query over it walks a project's
    #: assets and filters in Python, which is the shape ``Repository.list``
    #: already has. No foreign key either — it names a blob, not a row.
    thumbnail_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    #: When these bytes first arrived in this project.
    #:
    #: ISO-8601 text, the convention every timestamp in this schema follows —
    #: SQLite's ``DATETIME`` drops the timezone, and a stored offset is the whole
    #: point. Sorting works anyway: ISO-8601 in UTC is lexicographically ordered.
    #:
    #: Nullable, and unlike ``thumbnail_hash`` this NULL has no remedy. A preview
    #: can be rendered later; an arrival nobody recorded cannot be recovered —
    #: see ``Asset``'s own note, and the consumers that define what unknown means
    #: rather than inventing a value. Unindexed: the one query over it sorts a
    #: project's assets after
    #: ``Repository.list`` has already read them.
    ingested_at: Mapped[str | None] = mapped_column(String, nullable=True)


#: The same bytes are the same asset: the backstop under the ingest pipeline's
#: deduplication, a claim ``Asset``'s docstring has made since M1 with nothing
#: enforcing it.
#:
#: Per project, not global. Two projects ingesting one photograph are two assets
#: over one blob — that is what makes ``project_id`` the parent — and a release
#: keyed on content hash still sees them as the same content.
#:
#: ``ix_asset_content_hash`` stays beside it: neither subsumes the other, and
#: removing an index is its own migration for a benefit nobody has measured.
ASSET_CONTENT_UNIQUE = Index(
    "uq_asset_project_content_hash", AssetRow.project_id, AssetRow.content_hash, unique=True
)


class BatchRow(Base):
    __tablename__ = "batch"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("project.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    state: Mapped[str] = mapped_column(String, nullable=False)
    #: The annotation schema version pinned at approval. NULL while a draft.
    schema_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: The batch this one was cut from, when it is a correction of another.
    #:
    #: **Deliberately not a foreign key**, and the second in this schema after
    #: ``asset.source_id`` — for the same forced reason. It arrives by ``ALTER
    #: TABLE``, which cannot express a key the way ``create_all`` does, and
    #: ``batch`` cannot be rebuilt to escape that: ``batch_asset`` carries an
    #: ``ON DELETE CASCADE`` key into it, so a ``DROP TABLE`` under
    #: ``PRAGMA foreign_keys = ON`` would silently take every membership row with
    #: it. A rebuild is only available for a table that is childless *and*
    #: provably empty, and this is neither.
    #:
    #: Declared **last** for the ordering rule the module docstring states.
    #:
    #: What is given up: nothing enforces that the parent exists, and a project
    #: cascade that deletes both leaves no dangling row only because both die by
    #: their own ``project_id`` key. A future `BatchService.delete` of a *parent*
    #: has to decide what happens to its children and say so — the same debt
    #: ``asset.source_id`` records.
    #:
    #: NULL is not "unknown" here. It means **this batch is not a correction of
    #: anything**, which is true of every batch that exists today, so the
    #: migration backfills nothing and is not being lazy about it.
    #:
    #: Unindexed: the one query over it walks a project's batches, which
    #: ``Repository.list`` already reads by ``project_id``.
    parent_batch_id: Mapped[UUID | None] = mapped_column(SaUuid, nullable=True)


class BatchAssetRow(Base):
    """Batch membership. ``position`` preserves the order assets were added in."""

    __tablename__ = "batch_asset"

    batch_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("batch.id", ondelete="CASCADE"), primary_key=True
    )
    asset_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("asset.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)


class TaskGroupRow(Base):
    __tablename__ = "task_group"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    batch_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("batch.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False)


class AnnotationJobRow(Base):
    __tablename__ = "annotation_job"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    task_group_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("task_group.id", ondelete="CASCADE"), index=True, nullable=False
    )
    state: Mapped[str] = mapped_column(String, nullable=False)
    # Added by migration 9 (job_assignee) — must stay the last column declared.
    assignee: Mapped[str | None] = mapped_column(String, nullable=True)


class AnnotationJobAssetRow(Base):
    """Per-asset annotation progress inside a job."""

    __tablename__ = "annotation_job_asset"

    job_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("annotation_job.id", ondelete="CASCADE"), primary_key=True
    )
    asset_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("asset.id", ondelete="CASCADE"), primary_key=True
    )
    progress: Mapped[str] = mapped_column(String, nullable=False)
    #: The asset's place in the batch, i.e. ingest order. What makes
    #: ``JobService.next_pending`` deterministic.
    #:
    #: Carries a ``server_default`` where ``BatchAssetRow.position`` does not,
    #: and the asymmetry is a fossil worth keeping: this column reached existing
    #: databases by ``ALTER TABLE``, and SQLite refuses ``ADD COLUMN ... NOT
    #: NULL`` without a default. That is the price of every future ``NOT NULL``
    #: column too, so it stays rather than being tidied away.
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    #: When somebody last moved this asset's progress, or NULL if nobody has
    #: since the column existed. The only timestamp in the schema that dates a
    #: person's work rather than a record's creation, which is what lets the
    #: workspace summary rank open batches by recency instead of by progress.
    #:
    #: Written exclusively inside ``UnitOfWork.set_asset_progress``'s guarded
    #: ``UPDATE``, so it is stamped in the same statement as the transition it
    #: records and cannot drift from it.
    #:
    #: Declared last, after ``position``, because it arrives by ``ALTER TABLE``
    #: — see the column-order rule at the top of this module. Nullable, so
    #: unlike ``position`` it needs no ``server_default``: NULL is the honest
    #: value for a row nobody has touched, and it is what the ranking's fallback
    #: population is keyed on.
    touched_at: Mapped[str | None] = mapped_column(String, nullable=True)


class AnnotationRow(Base):
    __tablename__ = "annotation"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    asset_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("asset.id", ondelete="CASCADE"), index=True, nullable=False
    )
    label_class: Mapped[str] = mapped_column(String, index=True, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    geometry: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    provenance: Mapped[str] = mapped_column(String, nullable=False)
    model_ref: Mapped[str | None] = mapped_column(String, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    #: Attribute values keyed by ``Attribute.name``. JSON for the reason
    #: ``geometry`` is: an immutable value object that must rehydrate exactly,
    #: and nothing ever looks one attribute up by name in SQL.
    #:
    #: Declared **last**, and carrying a ``server_default``, for the two things
    #: ``ALTER TABLE`` demands — the same pair ``BatchRow.schema_version`` and
    #: ``AnnotationJobAssetRow.position`` carry, and for the same reason: SQLite
    #: appends an added column, and refuses ``ADD COLUMN ... NOT NULL`` without a
    #: value for the rows already there. See the module docstring's ordering
    #: rule for why the position is not free to change.
    attributes: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )
    #: The job this label was written in — where it came from, not where it is.
    #:
    #: An annotation hangs off its ``asset_id`` and nothing else, so "which round
    #: of work produced this box" had no answer anywhere: the batch id travelled
    #: only on a transient event. Correction batches need it, because a second
    #: round over the same asset produces a second set of labels and telling them
    #: apart afterwards is the whole question.
    #:
    #: **Not a foreign key**, and declared **last**, for the reasons
    #: ``BatchRow.parent_batch_id`` gives: it arrives by ``ALTER TABLE`` and
    #: ``annotation`` cannot be rebuilt — it is not empty in any workspace that
    #: has ever been annotated.
    #:
    #: **NULL means genuinely unknown**, unlike ``parent_batch_id``'s. The
    #: migration backfills every annotation whose asset belongs to exactly one
    #: job; an asset carried by two jobs is ambiguous *because the schema never
    #: recorded which one*, and guessing would put a confident wrong answer where
    #: an honest absent one belongs. A reader must treat NULL as "before this
    #: column existed, or written into an asset that two rounds both hold".
    job_id: Mapped[UUID | None] = mapped_column(SaUuid, nullable=True)


#: One classification tag per (asset, class), and no rule for the other two
#: geometries.
#:
#: ``ClassificationGeometry`` has **zero fields** and is frozen, so two tags of
#: one class on one asset are the same statement made twice — not two facts. A
#: bbox and a polygon are the opposite: two boxes on one asset under one class is
#: the normal case, which is why this index is *partial* rather than a rule about
#: ``annotation`` as a whole.
#:
#: Partial and expression-based, which is a trap for anything that has to create
#: it *conditionally*: SQLAlchemy can reflect neither kind, so ``checkfirst``
#: reports the index absent and re-issues a ``CREATE`` that then fails. The
#: baseline runs ``create_all`` and never meets that; a future migration touching
#: an index like this one asks SQLite instead, through
#: ``CreateIndex(..., if_not_exists=True)``, with the DDL still compiled from
#: this one object. ``SOURCE_ORIGIN_UNIQUE`` is the other of the two.
#:
#: SQL reading a JSON column, which the module docstring reserves for values
#: "nothing ever queries" — the same exemption ``SOURCE_ORIGIN_UNIQUE`` takes, and
#: for the same reason: an index is not a query. No service gains a JSON path and
#: ``_annotation_to_domain`` still rehydrates the geometry whole. The alternative
#: was a redundant ``geometry_type`` column written by the mapper and read by
#: nobody.
ANNOTATION_TAG_UNIQUE = Index(
    "uq_annotation_asset_classification",
    AnnotationRow.asset_id,
    AnnotationRow.label_class,
    unique=True,
    sqlite_where=text("json_extract(geometry, '$.type') = 'classification_tag'"),
)


class DatasetRow(Base):
    __tablename__ = "dataset"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("project.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(String, nullable=True)


class DatasetMemberRow(Base):
    __tablename__ = "dataset_member"
    __table_args__ = (UniqueConstraint("dataset_id", "asset_id", name="uq_member_dataset_asset"),)

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    dataset_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("dataset.id", ondelete="CASCADE"), index=True, nullable=False
    )
    asset_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("asset.id", ondelete="CASCADE"), nullable=False
    )


class DatasetChangeRow(Base):
    __tablename__ = "dataset_change"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    dataset_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("dataset.id", ondelete="CASCADE"), index=True, nullable=False
    )
    operation: Mapped[str] = mapped_column(String, nullable=False)
    subject_ids: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    actor: Mapped[str | None] = mapped_column(String, nullable=True)
    occurred_at: Mapped[str] = mapped_column(String, nullable=False)


class ReleaseRow(Base):
    """A published release: a pointer at its manifest, plus how it was made.

    The manifest itself is NOT here. It is canonical JSON in the blob store,
    named by ``manifest_hash`` — content-addressed like every other blob, which
    is what makes it verifiable and what lets two releases of identical content
    share one document. A megabyte of inventory in a column would also have to be
    read to list a dataset's releases, which is the operation that must stay
    cheap.

    ``schema_version``, ``asset_count`` and ``annotation_count`` duplicate facts
    from inside that document on purpose: they are the read cache a listing
    renders from. ``ReleaseService.verify`` cross-checks them against the parsed
    manifest, so the duplication is checkable rather than trusted.

    No column here carries a ``server_default``, and none should acquire one:
    not one of these values has an honest default, so a migration that needed to
    add a ``NOT NULL`` column to this table would have to rebuild it rather than
    invent a default and bake the fiction into every fresh database.
    """

    __tablename__ = "release"
    __table_args__ = (UniqueConstraint("dataset_id", "tag", name="uq_release_dataset_tag"),)

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    dataset_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("dataset.id", ondelete="CASCADE"), index=True, nullable=False
    )
    tag: Mapped[str] = mapped_column(String, nullable=False)
    manifest_hash: Mapped[str] = mapped_column(String, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    asset_count: Mapped[int] = mapped_column(Integer, nullable=False)
    annotation_count: Mapped[int] = mapped_column(Integer, nullable=False)
    #: A JSON column stores Python ``None`` as the JSON literal ``null`` rather
    #: than as SQL ``NULL``. It reads back as ``None``, which is all any caller
    #: needs; nothing queries this column, and ``WHERE split IS NULL`` would not
    #: be the way to ask if anything ever did.
    split: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[str] = mapped_column(String, nullable=False)
    visionset_version: Mapped[str] = mapped_column(String, nullable=False)


class TokenRow(Base):
    """API credentials, hashed.

    ``secret_hash`` holds a SHA-256 digest and never a plaintext; ``domain.token``
    argues why a digest rather than a KDF is the right call here. It carries no
    index: verification hashes the presentation and scans the workspace's tokens,
    which is a handful of rows, and an index on a credential-derived value buys a
    lookup nothing measures.
    """

    __tablename__ = "token"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    workspace_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("workspace.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    secret_hash: Mapped[str] = mapped_column(String, nullable=False)
    #: ISO-8601 with offset, never SQLite ``DATETIME``. See the module docstring.
    created_at: Mapped[str] = mapped_column(String, nullable=False)
    #: When the credential was burned, or NULL while it still works.
    revoked_at: Mapped[str | None] = mapped_column(String, nullable=True)


#: Token names are unique per workspace, case-insensitively.
#:
#: The ``PROJECT_NAME_UNIQUE`` reasoning one entity over, and the same division
#: of labour: ``COLLATE NOCASE`` folds ASCII at the storage layer while
#: ``TokenService`` handles Unicode folding and whitespace where the normalized
#: string is in hand. The service reports the error; this index is the guarantee.
#:
#: It is load-bearing rather than tidy: ``visionset token revoke <name>`` can only
#: mean something if a name resolves to exactly one credential.
TOKEN_NAME_UNIQUE = Index(
    "uq_token_workspace_name",
    TokenRow.workspace_id,
    TokenRow.name.collate("NOCASE"),
    unique=True,
)


class JobRow(Base):
    """The background executor's queue: one row per unit of machine work.

    **No foreign key, and that is a decision rather than an omission.** A job is
    workspace-scoped plumbing: what it is *about* lives in ``payload``, keyed by
    id, and different job types are about different entities — an export is about
    a release, an ingest about an ingest job. A ``project_id`` would be null for
    some types, wrong for others, and would make ``ON DELETE CASCADE`` quietly
    destroy the record of work that already happened. The row outlives its
    subject on purpose: "this export ran and here is where it put the archive"
    stays true after the release is gone.

    It also keeps this table free of the rebuild rule. A column carrying a key
    cannot arrive by ``ALTER TABLE`` — SQLite spells an added key inline while
    ``create_all`` spells one as a table constraint — so a table with no keys at
    all is one a later migration can widen without touching its rows.

    ``payload``, ``result`` and ``failures`` are JSON for the reason
    ``ingest_job.failures`` is: they are read whole, never queried by field.
    ``payload`` in particular is opaque to everything but its own handler, which
    is what makes the executor generic.
    """

    __tablename__ = "job"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    #: The registry key that resolves to a handler. Indexed because "what are all
    #: the exports doing?" is the one question a list is filtered by after state.
    type: Mapped[str] = mapped_column(String, index=True, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )
    #: Indexed because the dispatcher polls it: ``WHERE state = 'queued' ORDER BY
    #: created_at`` runs on an interval for as long as the server is up, which is
    #: the one read here whose cost is paid whether or not anything is happening.
    state: Mapped[str] = mapped_column(String, index=True, nullable=False)
    idempotent: Mapped[bool] = mapped_column(Integer, nullable=False, server_default=text("0"))
    processed: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    failures: Mapped[list[Any]] = mapped_column(JSON, nullable=False, server_default=text("'[]'"))
    error: Mapped[str | None] = mapped_column(String, nullable=True)
    result: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, server_default=text("'{}'")
    )
    #: A request, not a state. See ``BackgroundJob.cancel_requested``.
    cancel_requested: Mapped[bool] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    #: Who claimed it. Recorded, never validated — it is for a person reading a
    #: list, not for the queue to trust.
    worker: Mapped[str | None] = mapped_column(String, nullable=True)
    #: ISO-8601 with offset, never SQLite ``DATETIME``. See the module docstring.
    #: Indexed with ``state`` below: the claim orders by it.
    created_at: Mapped[str] = mapped_column(String, nullable=False)
    started_at: Mapped[str | None] = mapped_column(String, nullable=True)
    finished_at: Mapped[str | None] = mapped_column(String, nullable=True)


#: The dispatcher's poll, in one index.
#:
#: ``claim`` is ``WHERE state = 'queued' ORDER BY created_at LIMIT 1``, issued
#: every poll interval for the life of the server whether or not there is work.
#: Composite rather than two indexes because that is the only read shape here
#: that runs unattended: SQLite can satisfy both the filter and the ordering from
#: this one, so an idle queue costs an index seek rather than a scan that grows
#: with every job the workspace has ever run.
JOB_QUEUE_ORDER = Index("ix_job_state_created_at", JobRow.state, JobRow.created_at)


class InferenceConnectionRow(Base):
    """A configured place a model can be asked to predict.

    **No foreign key, on ``JobRow``'s terms rather than ``TokenRow``'s.** A
    connection belongs to the workspace, and the workspace is the file this row
    lives in — so a ``workspace_id`` would be a column with one value in it. That
    also keeps the table free of the rebuild rule: a table with no keys is one a
    later migration can widen with ``ALTER``.

    Nullable per-type parameters rather than a JSON blob: there are three of them
    across two kinds, they are read individually, and ``InferenceConnection``
    already refuses the combinations that make no sense. A blob would move a rule
    the domain enforces into a shape nothing can index or inspect.

    No credential column, and its absence is deliberate rather than pending:
    where an HTTP connection's secret lives is still an open decision, and a
    nullable column added "for later" would answer it by default, in the
    direction nobody chose.
    """

    __tablename__ = "inference_connection"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    #: ``local`` or ``http``. Indexed by nothing: a workspace holds a handful of
    #: these, and every read is the whole list.
    connection_type: Mapped[str] = mapped_column(String, nullable=False)
    model_id: Mapped[str] = mapped_column(String, nullable=False)
    model_revision: Mapped[str] = mapped_column(String, nullable=False)
    device: Mapped[str | None] = mapped_column(String, nullable=True)
    precision: Mapped[str | None] = mapped_column(String, nullable=True)
    endpoint_url: Mapped[str | None] = mapped_column(String, nullable=True)
    setup_state: Mapped[str] = mapped_column(String, nullable=False)
    #: ISO-8601 with offset, never SQLite ``DATETIME``. See the module docstring.
    created_at: Mapped[str] = mapped_column(String, nullable=False)
    updated_at: Mapped[str] = mapped_column(String, nullable=False)
    #: Last on the class because it arrives by ``ALTER TABLE``, which SQLite
    #: appends — the module docstring's rule, and the same pair
    #: ``BatchRow.parent_batch_id`` and ``AnnotationSchemaRow.provenance``
    #: already stand in.
    #:
    #: Nullable in the schema *and* meaningful when empty: NULL is "nobody has
    #: read this connection's config yet", the empty string is "somebody read it
    #: and it declared nothing". ``InferenceConnection.model_family`` carries the
    #: reason those are worth telling apart.
    model_family: Mapped[str | None] = mapped_column(String, nullable=True)


#: Connection names are unique in the workspace, case-insensitively.
#:
#: ``TOKEN_NAME_UNIQUE`` without the workspace column, for the reason the row
#: carries no workspace key: the table *is* the workspace's. ``NOCASE`` so that
#: ``local`` and ``Local`` cannot name two connections a person then has to tell
#: apart in a list.
INFERENCE_CONNECTION_NAME_UNIQUE = Index(
    "uq_inference_connection_name",
    InferenceConnectionRow.name.collate("NOCASE"),
    unique=True,
)
