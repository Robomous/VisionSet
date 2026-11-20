# usage: from visionset.kernel.services import ImportService
"""Import: an external dataset entering a project as a labeled, approved batch.

The binding rule is ``docs/content/architecture/decisions/an-import-is-a-labeled-batch.md``.
An import creates assets, a schema version (only when the project has none),
annotations with ``provenance='import'`` and a batch, then approves the batch so
each labeled asset is seeded ``annotated``. It stops there: a person reviews and
promotes through the normal flow.

The importer is handed in rather than named, as ``ReleaseService.export`` takes
an exporter: the kernel may not import ``visionset.formats``.

``inspect`` and ``commit`` share one planning pass, so a commit applies exactly
what an inspect of the same state reported and refuses exactly what it
predicted. Planning decodes every listed image without storing anything; the
commit then stores the blobs outside any transaction, as ingest does, and
writes every row — assets, schema version, batch, labels, approval — in one
transaction, so a refusal anywhere leaves none of them.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
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
    DecodedStill,
    ImageFormat,
    ImportConsent,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLoss,
    ImportLossKind,
    ImportPlan,
    ImportRun,
    LabelClass,
    Project,
    geometry_needs_calibration,
    require_calibration,
    sha256_hex,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.domain.names import derived_name
from visionset.kernel.domain.schema_validation import validate_schema_annotation
from visionset.kernel.errors import (
    AssetNotWritable,
    CalibrationMissing,
    CalibrationResolutionMismatch,
    ImportNotConsented,
    ImportSourceUnreadable,
    InvalidAnnotation,
    InvalidSchema,
    MediaError,
    ProjectNotFound,
    VisionSetError,
)
from visionset.kernel.ports import Importer, UnitOfWork
from visionset.kernel.services.annotation_service import AnnotationService
from visionset.kernel.services.batch_service import BatchService
from visionset.kernel.services.dataset_service import member_asset_ids_of
from visionset.kernel.services.ingest_service import store_assets
from visionset.kernel.services.project_service import ProjectService
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.workspace_service import WorkspaceService

_OUTSIDE = "it lies wholly outside its image"


@dataclass(frozen=True)
class _Probe:
    content_hash: str
    width: int
    height: int
    format: ImageFormat | None


@dataclass
class _Planned:
    plan: ImportPlan
    refusals: list[VisionSetError]
    probes: dict[PurePosixPath, _Probe]
    members: bool
    active: AnnotationSchema | None
    root: Path


class ImportService:
    """Inspect and commit imports of external datasets into one workspace."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._schemas = SchemaService(workspace)
        self._batches = BatchService(workspace)
        self._annotations = AnnotationService(workspace)

    def inspect(self, project_id: UUID, importer: Importer, src: Path) -> ImportPlan:
        """What committing this source would do, drop and refuse. Writes nothing.

        Raises:
            ProjectNotFound: no such project in this workspace.
            ImportSourceUnreadable: the source is not a directory, is malformed,
                names an image path that resolves outside it, or lists an image
                whose decoded size disagrees with the annotation file.
            MediaError: a listed image is not a supported, decodable still.
        """
        return self._planned(project_id, importer, src).plan

    def commit(
        self,
        project_id: UUID,
        importer: Importer,
        src: Path,
        *,
        consent: ImportConsent | None = None,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> ImportRun:
        """Import the source as a new approved batch, or refuse having written nothing.

        Ingest deduplicates assets by content hash and a label already on its
        asset (same class, same geometry) is not written twice, so re-running
        the same source while its first batch is untouched, or after that batch
        was deleted, writes nothing and returns no batch. A run that would
        write no asset and no label writes nothing at all, schema included.

        ``on_progress`` hears ``(stored, total)`` after each image's bytes are
        stored, which is the long part of a commit; the rows follow in one
        transaction it does not report on.

        Raises:
            ProjectNotFound: no such project in this workspace.
            ImportSourceUnreadable: the source is malformed or unsafe, an image
                disagrees with the annotation file, or it changed during the run.
            MediaError: a listed image is not a supported, decodable still.
            ImportNotConsented: the import would drop a kind of thing that
                ``consent`` does not name.
            InvalidAnnotation: a label does not fit the project's active schema;
                an existing schema is never changed by an import.
            InvalidSchema: the classes cannot form a schema, such as two names
                that differ only in case.
            AssetNotWritable: a label would land on an asset already in the
                trunk or in a batch — including this source's earlier batch
                after a reviewer changed a label in it. A re-run is not a re-sync.
            AnnotationGeometryOutOfBounds: a stored asset's recorded size
                disagrees with its bytes, so a label planned inside it is not.
            CalibrationMissing: a 3D label would land on an asset with no
                calibration — always so for an asset the import creates.
            CalibrationResolutionMismatch: a 3D label would land on an asset
                whose calibration was measured at another size.
            ConstraintViolated: a concurrent writer stored the same content or
                schema version first; nothing of this run was kept.
        """
        planned = self._planned(project_id, importer, src)
        plan = planned.plan
        uncovered = (consent or ImportConsent()).uncovered(plan.losses)
        if uncovered:
            kinds = ", ".join(sorted(kind.value for kind in uncovered))
            raise ImportNotConsented(
                f"this import would drop {kinds} information "
                f"({sum(loss.count for loss in plan.losses if loss.kind in uncovered)} item(s)); "
                f"inspect it to see exactly what, and consent to those kinds to proceed",
                losses=plan.losses,
            )
        if planned.refusals:
            raise planned.refusals[0]
        if not planned.members:
            return ImportRun(
                project_id=project_id,
                format_name=importer.format_name,
                batch_id=None,
                schema_version=None if planned.active is None else planned.active.version,
                created_asset_ids=(),
                asset_ids=(),
                annotations_written=0,
                annotations_already_present=plan.annotations_already_present,
                losses=plan.losses,
            )

        candidates: list[Asset] = []
        for image in plan.images:
            candidates.append(
                self._store(project_id, planned.root, image, planned.probes[image.path])
            )
            if on_progress is not None:
                on_progress(len(candidates), len(plan.images))

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
            for image, candidate in zip(plan.images, candidates, strict=True):
                asset = by_hash[candidate.content_hash]
                present = _present(uow.annotations.list(asset.id))
                new, repeated = _new_labels(present, image.labels)
                already += repeated
                for label in new:
                    proposed.append(
                        Annotation(
                            asset_id=asset.id,
                            label_class=label.class_name,
                            schema_version=schema.version,
                            geometry=label.geometry,
                            provenance="import",
                            confidence=label.confidence,
                        )
                    )
                    labeled.append(asset.id)

            members = list(dict.fromkeys([*created, *labeled]))
            batch = uow.batches.add(
                Batch(
                    project_id=project_id,
                    name=derived_name(
                        f"{importer.format_name} import {planned.root.name}", what="batch"
                    ),
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

    # --- planning ------------------------------------------------------------

    def _planned(self, project_id: UUID, importer: Importer, src: Path) -> _Planned:
        root = _require_directory(src)
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
        dataset = importer.read(root)
        losses: list[ImportLoss] = list(dataset.losses)
        label_losses: Counter[tuple[str, str]] = Counter()

        missing: list[PurePosixPath] = []
        probes: dict[PurePosixPath, _Probe] = {}
        for image in dataset.images:
            path = _contained(root, image.path)
            if not path.is_file():
                missing.append(image.path)
                losses.append(_image_loss(image, "the source holds no such file"))
                continue
            probes[image.path] = self._probe(path, image)

        kept: list[ImportedImage] = []
        first_with: dict[str, PurePosixPath] = {}
        for image in sorted(
            (image for image in dataset.images if image.path in probes), key=lambda i: str(i.path)
        ):
            probe = probes[image.path]
            original = first_with.setdefault(probe.content_hash, image.path)
            if original != image.path:
                del probes[image.path]
                losses.append(_image_loss(image, f"its bytes are those of {str(original)!r}"))
                continue
            inside = []
            for label in image.labels:
                if geometry_intersects_asset(
                    label.geometry, width=probe.width, height=probe.height
                ):
                    inside.append(label)
                else:
                    label_losses[(label.class_name, _OUTSIDE)] += 1
            kept.append(image.model_copy(update={"labels": tuple(inside)}))
        losses.extend(
            ImportLoss(kind=ImportLossKind.LABEL, subject=name, count=count, reason=reason)
            for (name, reason), count in label_losses.items()
        )

        with self._workspace.unit_of_work() as uow:
            active = self._schemas.active(uow, project_id)
            known = {asset.content_hash: asset for asset in uow.assets.list(project_id)}
            trunk = member_asset_ids_of(
                uow, ProjectService(self._workspace).require_dataset(uow, project_id)
            )
            held = {
                asset_id for batch in uow.batches.list(project_id) for asset_id in batch.asset_ids
            }
            new_assets = 0
            new_annotations = 0
            already = 0
            blocked: list[VisionSetError] = []
            for image in kept:
                asset = known.get(probes[image.path].content_hash)
                if asset is None:
                    new_assets += 1
                    new_annotations += len(image.labels)
                    if any(geometry_needs_calibration(one.geometry) for one in image.labels):
                        blocked.append(
                            CalibrationMissing(
                                f"image {str(image.path)!r} is new to the project, so it has no "
                                f"calibration, and the source gives it 3D labels; an import "
                                f"cannot calibrate an asset it creates"
                            )
                        )
                    continue
                new, repeated = _new_labels(_present(uow.annotations.list(asset.id)), image.labels)
                already += repeated
                new_annotations += len(new)
                if any(geometry_needs_calibration(one.geometry) for one in new):
                    source = None if asset.source_id is None else uow.sources.get(asset.source_id)
                    try:
                        require_calibration(asset, source)
                    except (CalibrationMissing, CalibrationResolutionMismatch) as refusal:
                        blocked.append(refusal)
                if new and (asset.id in trunk or asset.id in held):
                    blocked.append(
                        AssetNotWritable(
                            f"image {str(image.path)!r} is asset {asset.id}, which "
                            f"{'is in the dataset' if asset.id in trunk else 'a batch holds'}, "
                            f"and the source has {len(new)} label(s) it does not carry; an "
                            f"import is one-shot and never writes into reviewed or held work"
                        )
                    )

        members = bool(new_assets or new_annotations)
        refusals: list[VisionSetError] = []
        if active is not None:
            losses.extend(_undeclared_unused(dataset, active))
            refusals.extend(_schema_refusals(kept, active))
        elif members:
            try:
                SchemaService.require_coherent(_derived_classes(dataset))
            except InvalidSchema as refusal:
                refusals.append(refusal)
        refusals.extend(blocked)

        plan = ImportPlan(
            project_id=project_id,
            format_name=importer.format_name,
            dataset=dataset,
            images=tuple(kept),
            losses=tuple(losses),
            missing_images=tuple(missing),
            conflicts=tuple(str(refusal) for refusal in refusals),
            creates_schema=active is None and members,
            new_assets=new_assets,
            new_annotations=new_annotations,
            annotations_already_present=already,
        )
        return _Planned(
            plan=plan,
            refusals=refusals,
            probes=probes,
            members=members,
            active=active,
            root=root,
        )

    def _probe(self, path: Path, image: ImportedImage) -> _Probe:
        name = str(image.path)
        with _open(path, name) as handle:
            still = self._single_still(handle, name)
            if still.payload is None:
                handle.seek(0)
                content_hash = sha256_hex(handle.read())
            else:
                content_hash = sha256_hex(still.payload)
        width, height = still.metadata.width, still.metadata.height
        if (image.width is not None and image.width != width) or (
            image.height is not None and image.height != height
        ):
            raise ImportSourceUnreadable(
                f"image {name!r} is {width}x{height} pixels but the annotation file says "
                f"{image.width}x{image.height}; its labels would be placed in the wrong frame"
            )
        return _Probe(
            content_hash=content_hash, width=width, height=height, format=still.metadata.format
        )

    # --- writing -------------------------------------------------------------

    def _schema_for(
        self, uow: UnitOfWork, project_id: UUID, dataset: ImportedDataset
    ) -> AnnotationSchema:
        active = self._schemas.active(uow, project_id)
        if active is not None:
            return active
        return self._schemas.publish_in(
            uow, project_id, _derived_classes(dataset), description="imported dataset"
        ).published

    def _store(self, project_id: UUID, root: Path, image: ImportedImage, probe: _Probe) -> Asset:
        path = _contained(root, image.path)
        name = str(image.path)
        with _open(path, name) as handle:
            still = self._single_still(handle, name)
            if still.payload is None:
                handle.seek(0)
                content: BinaryIO = handle
            else:
                content = BytesIO(still.payload)
            content_hash = self._workspace.blob_store.put(content)
            thumbnail_hash = self._thumbnail(content, name=name)
        if content_hash != probe.content_hash:
            raise ImportSourceUnreadable(f"image {name!r} changed while it was being imported")
        return Asset(
            project_id=project_id,
            content_hash=content_hash,
            uri=str(path),
            width=probe.width,
            height=probe.height,
            format=probe.format,
            thumbnail_hash=thumbnail_hash,
        )

    def _single_still(self, handle: BinaryIO, name: str) -> DecodedStill:
        stills = list(self._workspace.image_processor.stills(handle, name=name))
        if len(stills) != 1 or stills[0].frame_index is not None:
            raise ImportSourceUnreadable(
                f"image {name!r} holds {len(stills)} frames; an import reads single stills"
            )
        return stills[0]

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


def _open(path: Path, name: str) -> BinaryIO:
    try:
        return path.open("rb")
    except OSError as exc:
        raise ImportSourceUnreadable(
            f"image {name!r} could not be opened: {exc.strerror or exc.__class__.__name__}"
        ) from None


def _image_loss(image: ImportedImage, why: str) -> ImportLoss:
    return ImportLoss(
        kind=ImportLossKind.IMAGE,
        subject=str(image.path),
        count=1,
        reason=f"{why}; its {len(image.labels)} label(s) would be lost",
    )


def _derived_classes(dataset: ImportedDataset) -> list[LabelClass]:
    return [
        LabelClass(name=imported.name, geometries=imported.geometries)
        for imported in dataset.classes
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


def _schema_refusals(
    images: Iterable[ImportedImage], active: AnnotationSchema
) -> list[InvalidAnnotation]:
    """One refusal per distinct (class, geometry) a label uses that ``active`` cannot accept."""
    refusals: list[InvalidAnnotation] = []
    judged: set[tuple[str, str]] = set()
    for image in images:
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


def _present(annotations: Iterable[Annotation]) -> Counter[tuple[str, str]]:
    return Counter((a.label_class, a.geometry.model_dump_json()) for a in annotations)


def _new_labels(
    present: Counter[tuple[str, str]], labels: Sequence[ImportedLabel]
) -> tuple[list[ImportedLabel], int]:
    """The labels not already on the asset, as a multiset, and how many were."""
    remaining = present.copy()
    new: list[ImportedLabel] = []
    for label in labels:
        key = (label.class_name, label.geometry.model_dump_json())
        if remaining[key] > 0:
            remaining[key] -= 1
        else:
            new.append(label)
    return new, len(labels) - len(new)
