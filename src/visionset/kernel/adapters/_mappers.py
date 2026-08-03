"""Translation between SQLAlchemy rows and pydantic domain models.

This module is the reason the domain never sees a SQLAlchemy type. Each entity
gets one ``EntityMapping`` describing its table, its parent column, and the two
directions of the conversion; the repository in
``sqlite_metadata_store`` is written once against that description rather than
fifteen times against fifteen tables.

Most entities are flat — every field is a column — and share
``_flat_mapping``. The ten that are not say so explicitly:

- ``AnnotationSchema``, ``Annotation`` and ``IngestJob`` hold immutable nested
  values, encoded as JSON.
- ``Batch`` and ``AnnotationJob`` own child tables, so their mappings carry a
  ``sync_children`` hook and rebuild their collections on read.
- ``Asset``, ``DatasetChange``, ``Release``, ``Source`` and ``Token`` encode a
  timezone-aware timestamp, which a ``String`` column must be handed as text
  rather than as a ``datetime``. ``Source`` also carries a nested
  ``VideoProvenance`` as JSON.

``Asset`` is the newest of those and the only one that *became* one: it was flat
until migration 13 gave it ``ingested_at``. Adding a timestamp to an entity
costs it its flat mapping, which is worth knowing before adding the next one.
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
    ImageFormat,
    IngestFailure,
    IngestJob,
    IngestState,
    LabelClass,
    Project,
    Release,
    Source,
    SourceKind,
    SplitRecipe,
    TaskGroup,
    Token,
    VideoProvenance,
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
    """Already hand-written for ``classes``, which is what makes #230 free.

    A timestamp is what costs an entity its ``_flat_mapping`` — that dumps in
    python mode and would hand sqlite3's deprecated adapter a ``datetime``,
    writing a second timestamp format. This pair existed long before
    ``created_at`` did, because a tuple of ``LabelClass`` models is not a JSON
    column's business either, so the column arrives as two more lines.
    """
    return t.AnnotationSchemaRow(
        id=entity.id,
        project_id=entity.project_id,
        version=entity.version,
        classes=[c.model_dump(mode="json") for c in entity.classes],
        description=entity.description,
        created_at=None if entity.created_at is None else entity.created_at.isoformat(),
    )


def _schema_to_domain(_: Session, row: Any) -> AnnotationSchema:
    return AnnotationSchema(
        id=row.id,
        project_id=row.project_id,
        version=row.version,
        classes=tuple(LabelClass.model_validate(c) for c in row.classes),
        description=row.description,
        created_at=None if row.created_at is None else datetime.fromisoformat(row.created_at),
    )


def _ingest_job_to_row(entity: IngestJob) -> t.Base:
    """Spelled out rather than left to ``_flat_mapping``, which dumps in python
    mode and would hand a tuple of ``IngestFailure`` models to a ``JSON`` column.
    """
    return t.IngestJobRow(
        id=entity.id,
        source_id=entity.source_id,
        state=entity.state,
        error=entity.error,
        batch_id=entity.batch_id,
        batch_name=entity.batch_name,
        processed=entity.processed,
        total=entity.total,
        failures=[failure.model_dump(mode="json") for failure in entity.failures],
    )


def _ingest_job_to_domain(_: Session, row: Any) -> IngestJob:
    return IngestJob(
        id=row.id,
        source_id=row.source_id,
        state=IngestState(row.state),
        error=row.error,
        batch_id=row.batch_id,
        batch_name=row.batch_name,
        processed=row.processed,
        total=row.total,
        failures=tuple(IngestFailure.model_validate(f) for f in row.failures),
    )


def _annotation_to_row(entity: Annotation) -> t.Base:
    return t.AnnotationRow(
        id=entity.id,
        asset_id=entity.asset_id,
        label_class=entity.label_class,
        schema_version=entity.schema_version,
        geometry=entity.geometry.model_dump(mode="json"),
        attributes=dict(entity.attributes),
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
        attributes=row.attributes,
        provenance=row.provenance,
        model_ref=row.model_ref,
        confidence=row.confidence,
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


def _source_to_row(entity: Source) -> t.Base:
    return t.SourceRow(
        id=entity.id,
        project_id=entity.project_id,
        kind=entity.kind,
        path=entity.path,
        display_name=entity.display_name,
        # Spelled out for the reason ``_release_to_row`` is: ``_flat_mapping``
        # dumps in python mode and would hand a ``datetime`` to a ``String``
        # column, which sqlite3 accepts through a deprecated adapter and writes
        # in a second timestamp format.
        registered_at=entity.registered_at.isoformat(),
        capture_params=dict(entity.capture_params),
        video=None if entity.video is None else entity.video.model_dump(mode="json"),
    )


def _source_to_domain(_: Session, row: Any) -> Source:
    return Source(
        id=row.id,
        project_id=row.project_id,
        kind=SourceKind(row.kind),
        path=row.path,
        display_name=row.display_name,
        registered_at=datetime.fromisoformat(row.registered_at),
        capture_params=row.capture_params,
        video=None if row.video is None else VideoProvenance.model_validate(row.video),
    )


def _asset_to_row(entity: Asset) -> t.Base:
    """Spelled out since migration 13, for ``_release_to_row``'s reason.

    ``ingested_at`` made this the fifth entity that cannot use
    ``_flat_mapping``: it dumps in python mode and would hand a ``datetime`` to
    a ``String`` column, which sqlite3 accepts through a deprecated adapter and
    writes in a second format alongside every other timestamp in the schema.
    """
    return t.AssetRow(
        id=entity.id,
        project_id=entity.project_id,
        modality=entity.modality,
        content_hash=entity.content_hash,
        uri=entity.uri,
        width=entity.width,
        height=entity.height,
        format=entity.format,
        source_id=entity.source_id,
        frame_index=entity.frame_index,
        frame_timestamp=entity.frame_timestamp,
        thumbnail_hash=entity.thumbnail_hash,
        ingested_at=None if entity.ingested_at is None else entity.ingested_at.isoformat(),
    )


def _asset_to_domain(_: Session, row: Any) -> Asset:
    return Asset(
        id=row.id,
        project_id=row.project_id,
        modality=row.modality,
        content_hash=row.content_hash,
        uri=row.uri,
        width=row.width,
        height=row.height,
        format=None if row.format is None else ImageFormat(row.format),
        source_id=row.source_id,
        frame_index=row.frame_index,
        frame_timestamp=row.frame_timestamp,
        thumbnail_hash=row.thumbnail_hash,
        ingested_at=None if row.ingested_at is None else datetime.fromisoformat(row.ingested_at),
    )


def _token_to_row(entity: Token) -> t.Base:
    return t.TokenRow(
        id=entity.id,
        workspace_id=entity.workspace_id,
        name=entity.name,
        secret_hash=entity.secret_hash,
        # Spelled out for ``_source_to_row``'s reason: ``_flat_mapping`` dumps in
        # python mode and would hand a ``datetime`` to a ``String`` column.
        created_at=entity.created_at.isoformat(),
        revoked_at=None if entity.revoked_at is None else entity.revoked_at.isoformat(),
    )


def _token_to_domain(_: Session, row: Any) -> Token:
    return Token(
        id=row.id,
        workspace_id=row.workspace_id,
        name=row.name,
        secret_hash=row.secret_hash,
        created_at=datetime.fromisoformat(row.created_at),
        revoked_at=None if row.revoked_at is None else datetime.fromisoformat(row.revoked_at),
    )


def _release_to_row(entity: Release) -> t.Base:
    return t.ReleaseRow(
        id=entity.id,
        dataset_id=entity.dataset_id,
        tag=entity.tag,
        manifest_hash=entity.manifest_hash,
        schema_version=entity.schema_version,
        asset_count=entity.asset_count,
        annotation_count=entity.annotation_count,
        split=None if entity.split is None else entity.split.model_dump(mode="json"),
        # Spelled out rather than left to ``_flat_mapping``, which dumps in
        # python mode and would hand a ``datetime`` object to a ``String``
        # column. sqlite3 would take it, via a deprecated adapter, and write a
        # second timestamp format alongside ``dataset_change.occurred_at``.
        created_at=entity.created_at.isoformat(),
        visionset_version=entity.visionset_version,
    )


def _release_to_domain(_: Session, row: Any) -> Release:
    return Release(
        id=row.id,
        dataset_id=row.dataset_id,
        tag=row.tag,
        manifest_hash=row.manifest_hash,
        schema_version=row.schema_version,
        asset_count=row.asset_count,
        annotation_count=row.annotation_count,
        split=None if row.split is None else SplitRecipe.model_validate(row.split),
        created_at=datetime.fromisoformat(row.created_at),
        visionset_version=row.visionset_version,
    )


# --- Entities owning a child table -----------------------------------------


def _batch_to_row(entity: Batch) -> t.Base:
    return t.BatchRow(
        id=entity.id,
        project_id=entity.project_id,
        name=entity.name,
        state=entity.state,
        schema_version=entity.schema_version,
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
        schema_version=row.schema_version,
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
    # Ordered, and that is a contract rather than a nicety: the dict this builds
    # is what JobService.next_pending pages through, so the batch's asset order
    # has to survive the round trip.
    rows = session.execute(
        select(t.AnnotationJobAssetRow.asset_id, t.AnnotationJobAssetRow.progress)
        .where(t.AnnotationJobAssetRow.job_id == row.id)
        .order_by(t.AnnotationJobAssetRow.position)
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
        t.AnnotationJobAssetRow(
            job_id=entity.id, asset_id=asset_id, progress=progress, position=position
        )
        for position, (asset_id, progress) in enumerate(entity.progress.items())
    )


WORKSPACES = _flat_mapping(Workspace, t.WorkspaceRow, None)
PROJECTS = _flat_mapping(Project, t.ProjectRow, "workspace_id")
ASSETS = EntityMapping(
    row=t.AssetRow,
    parent_column="project_id",
    to_row=_asset_to_row,
    to_domain=_asset_to_domain,
)
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
INGEST_JOBS: EntityMapping[IngestJob] = EntityMapping(
    row=t.IngestJobRow,
    parent_column="source_id",
    to_row=_ingest_job_to_row,
    to_domain=_ingest_job_to_domain,
)
SOURCES: EntityMapping[Source] = EntityMapping(
    row=t.SourceRow,
    parent_column="project_id",
    to_row=_source_to_row,
    to_domain=_source_to_domain,
)
TOKENS: EntityMapping[Token] = EntityMapping(
    row=t.TokenRow,
    parent_column="workspace_id",
    to_row=_token_to_row,
    to_domain=_token_to_domain,
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
