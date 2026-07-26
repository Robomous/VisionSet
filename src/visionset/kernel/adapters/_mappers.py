"""Translation between SQLAlchemy rows and pydantic domain models.

This module is the reason the domain never sees a SQLAlchemy type. Each entity
gets one ``EntityMapping`` describing its table, its parent column, and the two
directions of the conversion; the repository in
``sqlite_metadata_store`` is written once against that description rather than
fourteen times against fourteen tables.

Most entities are flat — every field is a column — and share
``_flat_mapping``. The six that are not say so explicitly:

- ``AnnotationSchema``, ``Annotation`` and ``Release`` hold immutable nested
  values, encoded as JSON.
- ``Batch`` and ``AnnotationJob`` own child tables, so their mappings carry a
  ``sync_children`` hook and rebuild their collections on read.
- ``DatasetChange`` encodes its UUID list and its timezone-aware timestamp.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol, cast
from uuid import UUID

from pydantic import BaseModel, TypeAdapter
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from visionset.kernel.adapters import _tables as t
from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    AnnotationSchema,
    Asset,
    AssetProgress,
    Batch,
    Dataset,
    DatasetChange,
    DatasetMember,
    Geometry,
    IngestJob,
    LabelClass,
    Manifest,
    Project,
    Release,
    Source,
    TaskGroup,
    Workspace,
)

_geometry_adapter: TypeAdapter[Geometry] = TypeAdapter(Geometry)


class Entity(Protocol):
    """Anything the store persists: a pydantic model addressed by a UUID."""

    id: UUID


@dataclass(frozen=True)
class EntityMapping[T: Entity]:
    """How one domain model is stored, read back, and scoped to its parent.

    ``parent_column`` is ``None`` only for ``Workspace``, the single root
    entity; for everything else it names the one foreign key that
    ``Repository.list`` filters on.
    """

    row: type[t.Base]
    parent_column: str | None
    to_row: Callable[[T], t.Base]
    to_domain: Callable[[Session, Any], T]
    sync_children: Callable[[Session, T], None] | None = None


def _columns(row: Any) -> dict[str, Any]:
    return {column.name: getattr(row, column.name) for column in row.__table__.columns}


def _flat_mapping[M: Entity](
    domain: type[M], row: type[t.Base], parent_column: str | None
) -> EntityMapping[M]:
    """Mapping for an entity whose fields are exactly its table's columns.

    The casts bridge ``Entity`` (which promises only a ``id``) and pydantic's
    API. Every call site below passes a real ``BaseModel`` subclass; expressing
    that as a bound would need an intersection type, which Python has no syntax
    for.
    """
    model = cast(type[BaseModel], domain)

    def to_row(entity: M) -> t.Base:
        return row(**cast(BaseModel, entity).model_dump())

    def to_domain(_: Session, stored: Any) -> M:
        return cast(M, model.model_validate(_columns(stored)))

    return EntityMapping(row=row, parent_column=parent_column, to_row=to_row, to_domain=to_domain)


# --- Entities with nested immutable values, stored as JSON ------------------


def _schema_to_row(entity: AnnotationSchema) -> t.Base:
    return t.AnnotationSchemaRow(
        id=entity.id,
        project_id=entity.project_id,
        version=entity.version,
        classes=[c.model_dump(mode="json") for c in entity.classes],
    )


def _schema_to_domain(_: Session, row: Any) -> AnnotationSchema:
    return AnnotationSchema(
        id=row.id,
        project_id=row.project_id,
        version=row.version,
        classes=tuple(LabelClass.model_validate(c) for c in row.classes),
    )


def _annotation_to_row(entity: Annotation) -> t.Base:
    return t.AnnotationRow(
        id=entity.id,
        asset_id=entity.asset_id,
        label_class=entity.label_class,
        schema_version=entity.schema_version,
        geometry=entity.geometry.model_dump(mode="json"),
        provenance=entity.provenance,
        model_ref=entity.model_ref,
        confidence=entity.confidence,
    )


def _annotation_to_domain(_: Session, row: Any) -> Annotation:
    return Annotation(
        id=row.id,
        asset_id=row.asset_id,
        label_class=row.label_class,
        schema_version=row.schema_version,
        geometry=_geometry_adapter.validate_python(row.geometry),
        provenance=row.provenance,
        model_ref=row.model_ref,
        confidence=row.confidence,
    )


def _release_to_row(entity: Release) -> t.Base:
    return t.ReleaseRow(
        id=entity.id,
        dataset_id=entity.dataset_id,
        tag=entity.tag,
        manifest=entity.manifest.model_dump(mode="json"),
    )


def _release_to_domain(_: Session, row: Any) -> Release:
    return Release(
        id=row.id,
        dataset_id=row.dataset_id,
        tag=row.tag,
        manifest=Manifest.model_validate(row.manifest),
    )


def _change_to_row(entity: DatasetChange) -> t.Base:
    return t.DatasetChangeRow(
        id=entity.id,
        dataset_id=entity.dataset_id,
        operation=entity.operation,
        subject_ids=[str(s) for s in entity.subject_ids],
        actor=entity.actor,
        occurred_at=entity.occurred_at.isoformat(),
    )


def _change_to_domain(_: Session, row: Any) -> DatasetChange:
    return DatasetChange(
        id=row.id,
        dataset_id=row.dataset_id,
        operation=row.operation,
        subject_ids=[UUID(s) for s in row.subject_ids],
        actor=row.actor,
        occurred_at=datetime.fromisoformat(row.occurred_at),
    )


# --- Entities owning a child table -----------------------------------------


def _batch_to_row(entity: Batch) -> t.Base:
    return t.BatchRow(
        id=entity.id, project_id=entity.project_id, name=entity.name, state=entity.state
    )


def _batch_to_domain(session: Session, row: Any) -> Batch:
    members = session.scalars(
        select(t.BatchAssetRow.asset_id)
        .where(t.BatchAssetRow.batch_id == row.id)
        .order_by(t.BatchAssetRow.position)
    ).all()
    return Batch(
        id=row.id,
        project_id=row.project_id,
        name=row.name,
        state=row.state,
        asset_ids=list(members),
    )


def _batch_sync_children(session: Session, entity: Batch) -> None:
    session.execute(delete(t.BatchAssetRow).where(t.BatchAssetRow.batch_id == entity.id))
    session.add_all(
        t.BatchAssetRow(batch_id=entity.id, asset_id=asset_id, position=position)
        for position, asset_id in enumerate(entity.asset_ids)
    )


def _job_to_row(entity: AnnotationJob) -> t.Base:
    return t.AnnotationJobRow(id=entity.id, task_group_id=entity.task_group_id, state=entity.state)


def _job_to_domain(session: Session, row: Any) -> AnnotationJob:
    rows = session.execute(
        select(t.AnnotationJobAssetRow.asset_id, t.AnnotationJobAssetRow.progress).where(
            t.AnnotationJobAssetRow.job_id == row.id
        )
    ).all()
    return AnnotationJob(
        id=row.id,
        task_group_id=row.task_group_id,
        state=row.state,
        progress={asset_id: AssetProgress(progress) for asset_id, progress in rows},
    )


def _job_sync_children(session: Session, entity: AnnotationJob) -> None:
    session.execute(
        delete(t.AnnotationJobAssetRow).where(t.AnnotationJobAssetRow.job_id == entity.id)
    )
    session.add_all(
        t.AnnotationJobAssetRow(job_id=entity.id, asset_id=asset_id, progress=progress)
        for asset_id, progress in entity.progress.items()
    )


WORKSPACES = _flat_mapping(Workspace, t.WorkspaceRow, None)
PROJECTS = _flat_mapping(Project, t.ProjectRow, "workspace_id")
SOURCES = _flat_mapping(Source, t.SourceRow, "project_id")
INGEST_JOBS = _flat_mapping(IngestJob, t.IngestJobRow, "source_id")
ASSETS = _flat_mapping(Asset, t.AssetRow, "project_id")
TASK_GROUPS = _flat_mapping(TaskGroup, t.TaskGroupRow, "batch_id")
DATASETS = _flat_mapping(Dataset, t.DatasetRow, "project_id")
DATASET_MEMBERS = _flat_mapping(DatasetMember, t.DatasetMemberRow, "dataset_id")

SCHEMAS: EntityMapping[AnnotationSchema] = EntityMapping(
    row=t.AnnotationSchemaRow,
    parent_column="project_id",
    to_row=_schema_to_row,
    to_domain=_schema_to_domain,
)
ANNOTATIONS: EntityMapping[Annotation] = EntityMapping(
    row=t.AnnotationRow,
    parent_column="asset_id",
    to_row=_annotation_to_row,
    to_domain=_annotation_to_domain,
)
RELEASES: EntityMapping[Release] = EntityMapping(
    row=t.ReleaseRow,
    parent_column="dataset_id",
    to_row=_release_to_row,
    to_domain=_release_to_domain,
)
DATASET_CHANGES: EntityMapping[DatasetChange] = EntityMapping(
    row=t.DatasetChangeRow,
    parent_column="dataset_id",
    to_row=_change_to_row,
    to_domain=_change_to_domain,
)
BATCHES: EntityMapping[Batch] = EntityMapping(
    row=t.BatchRow,
    parent_column="project_id",
    to_row=_batch_to_row,
    to_domain=_batch_to_domain,
    sync_children=_batch_sync_children,
)
ANNOTATION_JOBS: EntityMapping[AnnotationJob] = EntityMapping(
    row=t.AnnotationJobRow,
    parent_column="task_group_id",
    to_row=_job_to_row,
    to_domain=_job_to_domain,
    sync_children=_job_sync_children,
)
