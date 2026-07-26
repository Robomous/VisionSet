"""SQLAlchemy table definitions for the SQLite metadata store.

Private on purpose: ``visionset.kernel.adapters`` exports only
``SqliteMetadataStore``, so no SQLAlchemy type ever reaches a domain or port
signature. Rows are translated to and from domain models in ``_mappers``.

Storage decisions, and why (see ``docs/persistence.md`` for the long form):

- Collections that are *relations* get child tables — ``batch_asset`` and
  ``annotation_job_asset``. They are mutated one element at a time and queried
  from the asset side, which a JSON blob cannot serve.
- Collections that are *immutable value objects* get JSON columns —
  ``annotation_schema.classes``, ``annotation.geometry``, ``release.manifest``.
  A schema version must rehydrate byte-identical, and nothing ever queries a
  single ``LabelClass`` by name in SQL.
- Timestamps are TEXT holding an ISO-8601 string WITH its offset. SQLite's
  DATETIME storage format drops the timezone, and a timestamp that silently
  loses its offset is worse than no timestamp at all.

``list()`` ordering is SQLite's implicit ``rowid``, i.e. insertion order.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import ForeignKey, Index, Integer, String, UniqueConstraint
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
    __tablename__ = "annotation_schema"
    __table_args__ = (UniqueConstraint("project_id", "version", name="uq_schema_project_version"),)

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("project.id", ondelete="CASCADE"), index=True, nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    classes: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)


class SourceRow(Base):
    __tablename__ = "source"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("project.id", ondelete="CASCADE"), index=True, nullable=False
    )
    kind: Mapped[str] = mapped_column(String, nullable=False)
    uri: Mapped[str] = mapped_column(String, nullable=False)


class IngestJobRow(Base):
    __tablename__ = "ingest_job"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    source_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("source.id", ondelete="CASCADE"), index=True, nullable=False
    )
    state: Mapped[str] = mapped_column(String, nullable=False)
    error: Mapped[str | None] = mapped_column(String, nullable=True)


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


class BatchRow(Base):
    __tablename__ = "batch"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("project.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    state: Mapped[str] = mapped_column(String, nullable=False)


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
    __tablename__ = "release"

    id: Mapped[UUID] = mapped_column(SaUuid, primary_key=True)
    dataset_id: Mapped[UUID] = mapped_column(
        SaUuid, ForeignKey("dataset.id", ondelete="CASCADE"), index=True, nullable=False
    )
    tag: Mapped[str] = mapped_column(String, nullable=False)
    manifest: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
