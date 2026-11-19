# usage: from visionset.kernel.services import ImportService
"""Import: an external dataset entering a project as a labeled, approved batch.

The binding rule is ``docs/content/architecture/decisions/an-import-is-a-labeled-batch.md``.
An import creates assets, a schema version (only when the project has none),
annotations with ``provenance='import'`` and a batch, then approves the batch so
each labeled asset is seeded ``annotated``. It stops there: a person reviews and
promotes through the normal flow.

The importer is handed in rather than named, as ``ReleaseService.export`` takes
an exporter: the kernel may not import ``visionset.formats``.

Decoding happens outside any transaction, as ingest's does; blobs written
before a refusal are harmless because they are content-addressed and nothing
points at them. Every row — assets, schema version, batch, labels, approval —
is written in one transaction, so a refusal anywhere leaves none of them.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import BinaryIO
from uuid import UUID

from visionset.kernel.domain import (
    Annotation,
    AnnotationSchema,
    Asset,
    Batch,
    ImportConsent,
    ImportedDataset,
    ImportedImage,
    ImportLoss,
    ImportLossKind,
    ImportPlan,
    ImportRun,
    LabelClass,
    Project,
    normalize_name,
)
from visionset.kernel.domain.schema_validation import validate_schema_annotation
from visionset.kernel.errors import (
    ImportNotConsented,
    ImportSourceUnreadable,
    InvalidAnnotation,
    MediaError,
    ProjectNotFound,
)
from visionset.kernel.ports import Importer, UnitOfWork
from visionset.kernel.services.annotation_service import AnnotationService
from visionset.kernel.services.batch_service import BatchService
from visionset.kernel.services.ingest_service import store_assets
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.workspace_service import WorkspaceService


class ImportService:
    """Inspect and commit imports of external datasets into one workspace."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._schemas = SchemaService(workspace)
        self._batches = BatchService(workspace)
        self._annotations = AnnotationService(workspace)

    def inspect(self, project_id: UUID, importer: Importer, src: Path) -> ImportPlan:
        """What committing this source would do and drop. Writes nothing.

        Raises:
            ProjectNotFound: no such project in this workspace.
            ImportSourceUnreadable: the source is not a directory, is malformed,
                or names an image path that resolves outside it.
        """
        root = _require_directory(src)
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            active = self._schemas.active(uow, project_id)
        dataset = importer.read(root)
        missing = tuple(image.path for image in dataset.images if not _located(root, image.path))
        losses = [*dataset.losses, *_missing_losses(dataset, missing)]
        conflicts: tuple[str, ...] = ()
        if active is not None:
            losses.extend(_undeclared_unused(dataset, active))
            conflicts = tuple(str(refusal) for refusal in _schema_refusals(dataset, active))
        return ImportPlan(
            project_id=project_id,
            format_name=importer.format_name,
            dataset=dataset,
            losses=tuple(losses),
            missing_images=missing,
            conflicts=conflicts,
            creates_schema=active is None,
        )

    def commit(
        self,
        project_id: UUID,
        importer: Importer,
        src: Path,
        *,
        consent: ImportConsent | None = None,
    ) -> ImportRun:
        """Import the source as a new approved batch, or refuse having written nothing.

        Re-running the same source adds nothing: ingest deduplicates assets by
        content hash, and a label already on an asset (same class, same
        geometry) is not written twice. A run with nothing new creates no batch.

        Raises:
            ProjectNotFound: no such project in this workspace.
            ImportSourceUnreadable: the source is malformed or unsafe, or an
                image's bytes disagree with what the annotation file says.
            ImportNotConsented: the import would drop a kind of thing that
                ``consent`` does not name.
            MediaError: an image is not a supported, decodable still.
            InvalidAnnotation: a label does not fit the project's active schema;
                an existing schema is never changed by an import.
            InvalidSchema: the classes cannot form a schema.
            AssetNotWritable: a label would land on an asset already in the
                trunk or in another batch.
            ConstraintViolated: a concurrent writer stored the same content or
                schema version first; nothing of this run was kept.
        """
        plan = self.inspect(project_id, importer, src)
        uncovered = (consent or ImportConsent()).uncovered(plan.losses)
        if uncovered:
            kinds = ", ".join(sorted(kind.value for kind in uncovered))
            raise ImportNotConsented(
                f"this import would drop {kinds} information "
                f"({sum(loss.count for loss in plan.losses if loss.kind in uncovered)} item(s)); "
                f"inspect it to see exactly what, and consent to those kinds to proceed",
                losses=plan.losses,
            )
        with self._workspace.unit_of_work() as uow:
            active = self._schemas.active(uow, project_id)
        if active is not None:
            refusals = _schema_refusals(plan.dataset, active)
            if refusals:
                raise refusals[0]

        root = src.resolve()
        images = plan.importable_images
        candidates = [self._decode(project_id, root, image) for image in images]

        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            stored, created = store_assets(
                uow, project_id, candidates, stamped_at=datetime.now(UTC)
            )
            by_hash = {asset.content_hash: asset for asset in stored}
            schema = self._schema_for(uow, project_id, plan.dataset)

            proposed: list[Annotation] = []
            already = 0
            labeled: list[UUID] = []
            pending = {
                asset.id: Counter(_key_of(a) for a in uow.annotations.list(asset.id))
                for asset in stored
            }
            for image, candidate in zip(images, candidates, strict=True):
                asset = by_hash[candidate.content_hash]
                present = pending[asset.id]
                for label in image.labels:
                    annotation = Annotation(
                        asset_id=asset.id,
                        label_class=label.class_name,
                        schema_version=schema.version,
                        geometry=label.geometry,
                        provenance="import",
                        confidence=label.confidence,
                    )
                    key = _key_of(annotation)
                    if present[key] > 0:
                        present[key] -= 1
                        already += 1
                        continue
                    proposed.append(annotation)
                    labeled.append(asset.id)

            members = list(dict.fromkeys([*created, *labeled]))
            if not members:
                return ImportRun(
                    project_id=project_id,
                    format_name=importer.format_name,
                    batch_id=None,
                    schema_version=schema.version,
                    created_asset_ids=(),
                    asset_ids=tuple(asset.id for asset in stored),
                    annotations_written=0,
                    annotations_already_present=already,
                    losses=plan.losses,
                )
            batch = uow.batches.add(
                Batch(
                    project_id=project_id,
                    name=normalize_name(f"{importer.format_name} import {root.name}", what="batch"),
                    asset_ids=members,
                )
            )
            written = self._annotations.add_imported_in(uow, batch.id, proposed)
            approved, announcement = self._batches.approve_in(uow, batch.id)

        self._workspace.event_bus.publish(announcement)
        return ImportRun(
            project_id=project_id,
            format_name=importer.format_name,
            batch_id=approved.id,
            schema_version=schema.version,
            created_asset_ids=tuple(created),
            asset_ids=tuple(asset.id for asset in stored),
            annotations_written=len(written),
            annotations_already_present=already,
            losses=plan.losses,
        )

    def _schema_for(
        self, uow: UnitOfWork, project_id: UUID, dataset: ImportedDataset
    ) -> AnnotationSchema:
        active = self._schemas.active(uow, project_id)
        if active is not None:
            return active
        classes = [
            LabelClass(name=imported.name, geometries=imported.geometries)
            for imported in dataset.classes
        ]
        return self._schemas.publish_in(
            uow, project_id, classes, description="imported dataset"
        ).published

    def _decode(self, project_id: UUID, root: Path, image: ImportedImage) -> Asset:
        path = _contained(root, image.path)
        name = str(image.path)
        try:
            handle = path.open("rb")
        except OSError as exc:
            raise ImportSourceUnreadable(
                f"image {name!r} could not be opened: {exc.strerror or exc.__class__.__name__}"
            ) from None
        with handle:
            stills = list(self._workspace.image_processor.stills(handle, name=name))
            if len(stills) != 1 or stills[0].frame_index is not None:
                raise ImportSourceUnreadable(
                    f"image {name!r} holds {len(stills)} frames; an import reads single stills"
                )
            (still,) = stills
            if still.payload is None:
                handle.seek(0)
                content: BinaryIO = handle
            else:
                content = BytesIO(still.payload)
            content_hash = self._workspace.blob_store.put(content)
            thumbnail_hash = self._thumbnail(content, name=name)
        width, height = still.metadata.width, still.metadata.height
        if (image.width is not None and image.width != width) or (
            image.height is not None and image.height != height
        ):
            raise ImportSourceUnreadable(
                f"image {name!r} is {width}x{height} pixels but the annotation file says "
                f"{image.width}x{image.height}; its labels would be placed in the wrong frame"
            )
        return Asset(
            project_id=project_id,
            content_hash=content_hash,
            uri=str(path),
            width=width,
            height=height,
            format=still.metadata.format,
            thumbnail_hash=thumbnail_hash,
        )

    def _thumbnail(self, content: BinaryIO, *, name: str) -> str | None:
        # A preview is a cache: one that will not render leaves NULL for
        # ``IngestService.backfill_thumbnails``, as ingest does.
        try:
            rendered = self._workspace.image_processor.thumbnail(content, name=name)
        except MediaError:
            return None
        return self._workspace.blob_store.put(BytesIO(rendered))

    def _require_project(self, uow: UnitOfWork, project_id: UUID) -> Project:
        project = uow.projects.get(project_id)
        if project is None or project.workspace_id != self._workspace.workspace_id:
            raise ProjectNotFound(
                f"no project {project_id} in workspace {self._workspace.workspace.name!r}"
            )
        return project


def _require_directory(src: Path) -> Path:
    if not src.is_dir():
        raise ImportSourceUnreadable(f"the import source {src.name!r} is not a directory")
    return src.resolve()


def _contained(root: Path, relative: PurePosixPath) -> Path:
    """The file ``relative`` names, refused if it resolves outside ``root``.

    The domain already refuses ``..`` and absolute paths; this catches a
    symbolic link inside the source pointing out of it.
    """
    resolved = (root / relative).resolve()
    if not resolved.is_relative_to(root):
        raise ImportSourceUnreadable(f"image {str(relative)!r} resolves outside the source")
    return resolved


def _located(root: Path, relative: PurePosixPath) -> bool:
    return _contained(root, relative).is_file()


def _missing_losses(dataset: ImportedDataset, missing: Sequence[PurePosixPath]) -> list[ImportLoss]:
    absent = set(missing)
    return [
        ImportLoss(
            kind=ImportLossKind.IMAGE,
            subject=str(image.path),
            count=1,
            reason=(
                f"the annotation file names it but the source holds no such file; "
                f"its {len(image.labels)} label(s) would be lost"
            ),
        )
        for image in dataset.images
        if image.path in absent
    ]


def _undeclared_unused(dataset: ImportedDataset, active: AnnotationSchema) -> list[ImportLoss]:
    declared = {label_class.name for label_class in active.classes}
    used = {label.class_name for image in dataset.images for label in image.labels}
    return [
        ImportLoss(
            kind=ImportLossKind.CLASS,
            subject=imported.name,
            count=1,
            reason="the project's schema does not declare it and no label uses it",
        )
        for imported in dataset.classes
        if imported.name not in declared and imported.name not in used
    ]


def _schema_refusals(dataset: ImportedDataset, active: AnnotationSchema) -> list[InvalidAnnotation]:
    """One refusal per distinct (class, geometry) a label uses that ``active`` cannot accept."""
    refusals: list[InvalidAnnotation] = []
    judged: set[tuple[str, str]] = set()
    for image in dataset.images:
        for label in image.labels:
            pair = (label.class_name, label.geometry.type.value)
            if pair in judged:
                continue
            judged.add(pair)
            try:
                validate_schema_annotation(
                    label_class=label.class_name,
                    geometry=label.geometry,
                    attributes={},
                    schema=active,
                )
            except InvalidAnnotation as refusal:
                refusals.append(refusal)
    return refusals


def _key_of(annotation: Annotation) -> tuple[str, str]:
    return annotation.label_class, annotation.geometry.model_dump_json()
