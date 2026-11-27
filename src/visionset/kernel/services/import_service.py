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

An image whose path names no file in the source is asked of the importer when
it implements ``OpensPictures``, as a TFRecord importer does for the pictures
its records hold; otherwise, or when the importer holds none, it is an
``image`` loss. Either way nothing is written into the source.

A dataset of scans takes the same path with three differences. Each headerless
scan is stored as a binary PCD of its own bytes, so the point-cloud processor
that decodes an ingested scan decodes it too. The commit's transaction also
writes the point-cloud source at the import root that declares the dataset's
frame, unless one already declares it there. And a label has no image to fall
outside of, so none is dropped for its position.

A dataset of images may order some of them into sequences. Each sequence
holding an asset the run creates or labels becomes a new image-sequence source
with one occurrence per position it holds, and the labels naming a ``track``
become that source's tracks, written in the same transaction through
``TrackService``. A frame whose bytes repeat an earlier image is an occurrence
of that image's asset, and its labels land there: each tracked one as an
annotation of its own, an untracked one only if the asset does not already
carry it. See
``docs/content/architecture/decisions/a-track-observes-frame-occurrences.md``.
"""

from __future__ import annotations

import functools
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import BinaryIO, TypeVar
from uuid import UUID

from visionset.kernel.domain import (
    Annotation,
    AnnotationSchema,
    Asset,
    Attribute,
    AttributeValue,
    Batch,
    DecodedStill,
    ImageFormat,
    ImportConsent,
    ImportedDataset,
    ImportedFrame,
    ImportedImage,
    ImportedLabel,
    ImportedScan,
    ImportedSequence,
    ImportLoss,
    ImportLossKind,
    ImportPlan,
    ImportRun,
    LabelClass,
    PointCloudMetadata,
    Project,
    ScanFrame,
    Source,
    Track,
    TrackObservation,
    geometry_needs_calibration,
    geometry_needs_scan_frame,
    require_calibration,
    sha256_hex,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.domain.names import derived_name
from visionset.kernel.domain.schema_validation import validate_schema_annotation
from visionset.kernel.errors import (
    AssetNotWritable,
    CalibrationInUse,
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
from visionset.kernel.ports import Importer, OpensPictures, UnitOfWork
from visionset.kernel.ports.point_cloud_processor import MAX_POINT_CLOUD_BYTES
from visionset.kernel.services.annotation_service import AnnotationService
from visionset.kernel.services.batch_service import BatchService
from visionset.kernel.services.dataset_service import member_asset_ids_of
from visionset.kernel.services.ingest_service import store_assets
from visionset.kernel.services.project_service import ProjectService
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.source_service import SourceService
from visionset.kernel.services.track_service import TrackService
from visionset.kernel.services.workspace_service import WorkspaceService

_Item = TypeVar("_Item", ImportedImage, ImportedScan)

_OUTSIDE = "it lies wholly outside its image"
_STALE = "it is already on its asset with other attribute values; the values are not updated"
_OTHER_CLASS = "its track id names a track of another class; the label is kept untracked"
_REPEATED = "its track id repeats within one frame; the label is kept untracked"


@dataclass(frozen=True)
class _Probe:
    content_hash: str
    width: int
    height: int
    format: ImageFormat | None


@dataclass(frozen=True)
class _ScanProbe:
    content_hash: str
    metadata: PointCloudMetadata


@dataclass
class _Planned:
    plan: ImportPlan
    refusals: list[VisionSetError]
    probes: dict[PurePosixPath, _Probe]
    members: bool
    active: AnnotationSchema | None
    root: Path
    scan_probes: dict[PurePosixPath, _ScanProbe] | None = None
    duplicates: dict[PurePosixPath, PurePosixPath] | None = None
    writes: frozenset[PurePosixPath] = frozenset()
    repeats: dict[PurePosixPath, list[ImportedImage]] | None = None
    opener: Callable[[PurePosixPath], BinaryIO] | None = None
    opened: frozenset[PurePosixPath] = frozenset()


class ImportService:
    """Inspect and commit imports of external datasets into one workspace."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._schemas = SchemaService(workspace)
        self._batches = BatchService(workspace)
        self._annotations = AnnotationService(workspace)
        self._sources = SourceService(workspace)
        self._tracks = TrackService(workspace)

    def inspect(self, project_id: UUID, importer: Importer, src: Path) -> ImportPlan:
        """What committing this source would do, drop and refuse. Writes nothing.

        Raises:
            ProjectNotFound: no such project in this workspace.
            ImportSourceUnreadable: the source is not a directory, is malformed,
                names an image path that resolves outside it, or lists an image
                whose decoded size disagrees with the annotation file.
            MediaError: a listed image is not a supported, decodable still, or a
                listed scan does not decode as a point cloud.
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

        ``on_progress`` hears ``(stored, total)`` after each image's or scan's
        bytes are stored, which is the long part of a commit; the rows follow
        in one transaction it does not report on.

        Raises:
            ProjectNotFound: no such project in this workspace.
            ImportSourceUnreadable: the source is malformed or unsafe, an image
                disagrees with the annotation file, or it changed during the run.
            MediaError: a listed image is not a supported, decodable still, or a
                listed scan does not decode as a point cloud.
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
            CalibrationInUse: a scan's labels would be read in a frame other
                than the dataset's, because the scan is already an asset of a
                source declaring another one, or the point-cloud source already
                registered at the import root declares another one.
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

        frame = plan.dataset.frame
        items: list[ImportedImage | ImportedScan]
        candidates: list[Asset] = []
        if frame is None:
            items = list(plan.images)
            for image in plan.images:
                candidates.append(self._store(project_id, planned, image))
                if on_progress is not None:
                    on_progress(len(candidates), len(plan.images))
        else:
            items = list(plan.scans)
            scan_probes = planned.scan_probes or {}
            for scan in plan.scans:
                candidates.append(
                    self._store_scan(project_id, planned.root, scan, scan_probes[scan.path], frame)
                )
                if on_progress is not None:
                    on_progress(len(candidates), len(plan.scans))

        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            sequences: list[tuple[ImportedSequence, Source]] = []
            if frame is not None:
                source = self._sources.register_point_clouds_in(
                    uow, project_id, planned.root, frame=frame
                )
                candidates = [
                    candidate.model_copy(update={"source_id": source.id})
                    for candidate in candidates
                ]
            else:
                sequences = [
                    (sequence, self._sources.add_image_sequence_in(uow, project_id, sequence.name))
                    for sequence in plan.dataset.sequences
                    if any(one.path in planned.writes for one in sequence.frames)
                ]
                source_of = {
                    one.path: source.id for sequence, source in sequences for one in sequence.frames
                }
                candidates = [
                    candidate.model_copy(update={"source_id": source_of[item.path]})
                    if item.path in source_of
                    else candidate
                    for item, candidate in zip(items, candidates, strict=True)
                ]
            stored, created = store_assets(
                uow, project_id, candidates, stamped_at=datetime.now(UTC)
            )
            by_hash = {asset.content_hash: asset for asset in stored}
            schema = self._schema_for(uow, project_id, plan.dataset)

            proposed: list[Annotation] = []
            tracked: dict[PurePosixPath, list[tuple[str, Annotation]]] = {}
            already = 0
            labeled: list[UUID] = []
            for item, candidate in zip(items, candidates, strict=True):
                asset = by_hash[candidate.content_hash]
                writing, repeated, _ = _labels_to_write(
                    _present(uow.annotations.list(asset.id)),
                    _occurrences(item, planned.repeats or {}),
                )
                already += repeated
                if frame is not None:
                    _require_frame_still_declared(
                        uow, asset, [one for _, new in writing for one in new], frame, item
                    )
                for path, new in writing:
                    for label in new:
                        annotation = Annotation(
                            asset_id=asset.id,
                            label_class=label.class_name,
                            schema_version=schema.version,
                            geometry=label.geometry,
                            provenance="import",
                            confidence=label.confidence,
                            attributes=dict(label.attributes),
                        )
                        proposed.append(annotation)
                        labeled.append(asset.id)
                        if label.track is not None:
                            tracked.setdefault(path, []).append((label.track, annotation))

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
            tracks = self._tracks.add_imported_in(
                uow,
                batch.id,
                [
                    track
                    for sequence, source in sequences
                    for track in self._sequence_tracks(
                        uow, planned, sequence, source, by_hash, tracked
                    )
                ],
            )
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
            source_ids=tuple(source.id for _, source in sequences),
            tracks_written=len(tracks),
        )

    def _sequence_tracks(
        self,
        uow: UnitOfWork,
        planned: _Planned,
        sequence: ImportedSequence,
        source: Source,
        by_hash: dict[str, Asset],
        tracked: dict[PurePosixPath, list[tuple[str, Annotation]]],
    ) -> list[tuple[Track, list[TrackObservation]]]:
        """Write the sequence's occurrences; answer its tracks over the labels this run wrote."""
        duplicates = planned.duplicates or {}
        held: list[tuple[int, ImportedFrame, Asset]] = []
        for position, one in enumerate(sequence.frames):
            probe = planned.probes.get(duplicates.get(one.path, one.path))
            if probe is not None:
                held.append((position, one, by_hash[probe.content_hash]))
        occurrences = self._sources.add_occurrences_in(
            uow, source, [(position, one.timestamp, asset.id) for position, one, asset in held]
        )
        tracks: dict[str, tuple[Track, list[TrackObservation]]] = {}
        for (_, one, _), occurrence in zip(held, occurrences, strict=True):
            for external_id, annotation in tracked.get(one.path, []):
                track, observations = tracks.setdefault(
                    external_id,
                    (
                        Track(
                            source_id=source.id,
                            label_class=annotation.label_class,
                            external_id=external_id,
                        ),
                        [],
                    ),
                )
                observations.append(
                    TrackObservation(
                        track_id=track.id, occurrence_id=occurrence.id, annotation_id=annotation.id
                    )
                )
        return list(tracks.values())

    # --- planning ------------------------------------------------------------

    def _planned(self, project_id: UUID, importer: Importer, src: Path) -> _Planned:
        root = _require_directory(src)
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
        dataset = importer.read(root)
        if dataset.frame is not None:
            return self._planned_scans(project_id, importer, root, dataset, dataset.frame)
        losses: list[ImportLoss] = list(dataset.losses)
        label_losses: Counter[tuple[str, str]] = Counter()

        missing: list[PurePosixPath] = []
        probes: dict[PurePosixPath, _Probe] = {}
        opener = _opener(importer, root)
        opened: set[PurePosixPath] = set()
        for image in dataset.images:
            path = _contained(root, image.path)
            if path.is_file():
                probes[image.path] = self._probe(_open(path, str(image.path)), image)
                continue
            served = _served(opener, image.path)
            if served is None:
                missing.append(image.path)
                losses.append(_image_loss(image, "the source holds no such file"))
                continue
            opened.add(image.path)
            probes[image.path] = self._probe(served, image)

        kept: list[ImportedImage] = []
        duplicates: dict[PurePosixPath, PurePosixPath] = {}
        repeats: dict[PurePosixPath, list[ImportedImage]] = {}
        first_with: dict[str, PurePosixPath] = {}
        order = _listing_order(dataset)
        for image in sorted(
            (image for image in dataset.images if image.path in probes),
            key=lambda i: order.get(i.path, (str(i.path), 0)),
        ):
            probe = probes[image.path]
            original = first_with.setdefault(probe.content_hash, image.path)
            if original != image.path:
                del probes[image.path]
                duplicates[image.path] = original
                if image.path not in order:
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
            one = image.model_copy(update={"labels": tuple(inside)})
            if original == image.path:
                kept.append(one)
            else:
                repeats.setdefault(original, []).append(one)
        losses.extend(
            ImportLoss(kind=ImportLossKind.LABEL, subject=name, count=count, reason=reason)
            for (name, reason), count in label_losses.items()
        )
        with self._workspace.unit_of_work() as uow:
            active = self._schemas.active(uow, project_id)
        folded = [one for group in repeats.values() for one in group]
        judged, attribute_losses = _judged_attributes(
            [*kept, *folded], _target_classes(dataset, active)
        )
        losses.extend(attribute_losses)
        consistent, track_losses = _consistent_tracks(dataset, judged)
        kept = consistent[: len(kept)]
        fixed = {one.path: one for one in consistent[len(kept) :]}
        repeats = {path: [fixed[one.path] for one in group] for path, group in repeats.items()}
        folded = [one for group in repeats.values() for one in group]
        losses.extend(track_losses)

        writes: set[PurePosixPath] = set()
        tracked: dict[PurePosixPath, set[str]] = {}
        with self._workspace.unit_of_work() as uow:
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
            stale: Counter[str] = Counter()
            blocked: list[VisionSetError] = []
            for image in kept:
                asset = known.get(probes[image.path].content_hash)
                writing, repeated, differing = _labels_to_write(
                    {} if asset is None else _present(uow.annotations.list(asset.id)),
                    _occurrences(image, repeats),
                )
                already += repeated
                stale.update(differing)
                new = [label for _, labels in writing for label in labels]
                new_annotations += len(new)
                for at, labels in writing:
                    if labels or (asset is None and at == image.path):
                        writes.add(at)
                        tracked[at] = {one.track for one in labels if one.track}
                if asset is None:
                    new_assets += 1
                    if any(
                        geometry_needs_calibration(one.geometry, modality="image") for one in new
                    ):
                        blocked.append(
                            CalibrationMissing(
                                f"image {str(image.path)!r} is new to the project, so it has no "
                                f"calibration, and the source gives it 3D labels; an import "
                                f"cannot calibrate an asset it creates"
                            )
                        )
                    continue
                if any(
                    geometry_needs_calibration(one.geometry, modality=asset.modality) for one in new
                ):
                    source = None if asset.source_id is None else uow.sources.get(asset.source_id)
                    try:
                        require_calibration(asset, source)
                    except (CalibrationMissing, CalibrationResolutionMismatch) as refusal:
                        blocked.append(refusal)
                if new and (asset.id in trunk or asset.id in held):
                    blocked.append(
                        AssetNotWritable(
                            f"image {str(next(at for at, one in writing if one))!r} is asset "
                            f"{asset.id}, which "
                            f"{'is in the dataset' if asset.id in trunk else 'a batch holds'}, "
                            f"and the source has {len(new)} label(s) it does not carry; an "
                            f"import is one-shot and never writes into reviewed or held work"
                        )
                    )

        touched = [
            sequence
            for sequence in dataset.sequences
            if any(one.path in writes for one in sequence.frames)
        ]
        tracks = sum(
            len(set().union(*(tracked.get(one.path, set()) for one in sequence.frames)))
            for sequence in touched
        )
        losses.extend(_stale_losses(stale))
        members = bool(new_assets or new_annotations)
        refusals: list[VisionSetError] = []
        if active is not None:
            losses.extend(_undeclared_unused(dataset, active))
            refusals.extend(_schema_refusals([*kept, *folded], active))
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
            repeats=tuple(one for group in repeats.values() for one in group),
            losses=tuple(losses),
            missing_images=tuple(missing),
            conflicts=tuple(str(refusal) for refusal in refusals),
            creates_schema=active is None and members,
            new_assets=new_assets,
            new_annotations=new_annotations,
            annotations_already_present=already,
            sequences=len(touched),
            tracks=tracks,
        )
        return _Planned(
            plan=plan,
            refusals=refusals,
            probes=probes,
            members=members,
            active=active,
            root=root,
            duplicates=duplicates,
            writes=frozenset(writes),
            repeats=repeats,
            opener=opener,
            opened=frozenset(opened),
        )

    def _planned_scans(
        self,
        project_id: UUID,
        importer: Importer,
        root: Path,
        dataset: ImportedDataset,
        frame: ScanFrame,
    ) -> _Planned:
        losses: list[ImportLoss] = list(dataset.losses)
        missing: list[PurePosixPath] = []
        probes: dict[PurePosixPath, _ScanProbe] = {}
        for scan in dataset.scans:
            path = _contained(root, scan.path)
            if not path.is_file():
                missing.append(scan.path)
                losses.append(_scan_loss(scan, "the source holds no such file"))
                continue
            probes[scan.path] = self._probe_scan(path, scan)

        kept: list[ImportedScan] = []
        first_with: dict[str, PurePosixPath] = {}
        for scan in sorted(
            (scan for scan in dataset.scans if scan.path in probes), key=lambda s: str(s.path)
        ):
            original = first_with.setdefault(probes[scan.path].content_hash, scan.path)
            if original != scan.path:
                del probes[scan.path]
                losses.append(_scan_loss(scan, f"its points are those of {str(original)!r}"))
                continue
            kept.append(scan)

        with self._workspace.unit_of_work() as uow:
            active = self._schemas.active(uow, project_id)
            kept, attribute_losses = _judged_attributes(kept, _target_classes(dataset, active))
            losses.extend(attribute_losses)
            known = {asset.content_hash: asset for asset in uow.assets.list(project_id)}
            trunk = member_asset_ids_of(
                uow, ProjectService(self._workspace).require_dataset(uow, project_id)
            )
            held = {
                asset_id for batch in uow.batches.list(project_id) for asset_id in batch.asset_ids
            }
            registered = self._sources.point_cloud_source_of(uow, project_id, root)
            new_assets = 0
            new_annotations = 0
            already = 0
            stale: Counter[str] = Counter()
            blocked: list[VisionSetError] = []
            for scan in kept:
                asset = known.get(probes[scan.path].content_hash)
                if asset is None:
                    new_assets += 1
                    new_annotations += len(scan.labels)
                    continue
                new, repeated, differing = _new_labels(
                    _present(uow.annotations.list(asset.id)), scan.labels
                )
                already += repeated
                stale.update(differing)
                new_annotations += len(new)
                if any(
                    geometry_needs_scan_frame(one.geometry, modality=asset.modality) for one in new
                ):
                    source = None if asset.source_id is None else uow.sources.get(asset.source_id)
                    declared = None if source is None else source.frame
                    if declared != frame:
                        blocked.append(
                            CalibrationInUse(
                                f"scan {str(scan.path)!r} is asset {asset.id}, whose source "
                                f"declares {declared or 'no frame'}, and the source labels it "
                                f"in {frame}; an import never re-reads a label in other axes"
                            )
                        )
                if new and (asset.id in trunk or asset.id in held):
                    blocked.append(
                        AssetNotWritable(
                            f"scan {str(scan.path)!r} is asset {asset.id}, which "
                            f"{'is in the dataset' if asset.id in trunk else 'a batch holds'}, "
                            f"and the source has {len(new)} label(s) it does not carry; an "
                            f"import is one-shot and never writes into reviewed or held work"
                        )
                    )

        losses.extend(_stale_losses(stale))
        members = bool(new_assets or new_annotations)
        refusals: list[VisionSetError] = []
        if members and registered is not None and registered.frame != frame:
            refusals.append(
                CalibrationInUse(
                    f"source {registered.id} at the import root declares the "
                    f"{registered.frame} frame and the scans are labelled in {frame}; an "
                    f"import never re-declares a frame, even while no scan there holds a "
                    f"label, so register the directory with {frame} first if nothing "
                    f"depends on {registered.frame}"
                )
            )
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
            images=(),
            losses=tuple(losses),
            missing_images=(),
            conflicts=tuple(str(refusal) for refusal in refusals),
            creates_schema=active is None and members,
            new_assets=new_assets,
            new_annotations=new_annotations,
            annotations_already_present=already,
            scans=tuple(kept),
            missing_scans=tuple(missing),
        )
        return _Planned(
            plan=plan,
            refusals=refusals,
            probes={},
            members=members,
            active=active,
            root=root,
            scan_probes=probes,
        )

    def _probe_scan(self, path: Path, scan: ImportedScan) -> _ScanProbe:
        content = _scan_as_pcd(path, scan)
        metadata = self._workspace.point_cloud_processor.probe(
            BytesIO(content), name=str(scan.path)
        )
        return _ScanProbe(content_hash=sha256_hex(content), metadata=metadata)

    def _probe(self, source: BinaryIO, image: ImportedImage) -> _Probe:
        name = str(image.path)
        with source as handle:
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

    def _store(self, project_id: UUID, planned: _Planned, image: ImportedImage) -> Asset:
        probe = planned.probes[image.path]
        path = _contained(planned.root, image.path)
        name = str(image.path)
        if image.path in planned.opened:
            source = _served(planned.opener, image.path)
            if source is None:
                raise ImportSourceUnreadable(f"image {name!r} changed while it was being imported")
        else:
            source = _open(path, name)
        with source as handle:
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

    def _store_scan(
        self, project_id: UUID, root: Path, scan: ImportedScan, probe: _ScanProbe, frame: ScanFrame
    ) -> Asset:
        path = _contained(root, scan.path)
        name = str(scan.path)
        content = _scan_as_pcd(path, scan)
        if sha256_hex(content) != probe.content_hash:
            raise ImportSourceUnreadable(f"scan {name!r} changed while it was being imported")
        reading = self._workspace.point_cloud_processor.read(
            BytesIO(content), frame=frame, name=name
        )
        content_hash = self._workspace.blob_store.put(BytesIO(content))
        thumbnail_hash = (
            None
            if reading.thumbnail is None
            else self._workspace.blob_store.put(BytesIO(reading.thumbnail))
        )
        return Asset(
            project_id=project_id,
            modality="point_cloud",
            content_hash=content_hash,
            uri=str(path),
            point_cloud=reading.metadata,
            thumbnail_hash=thumbnail_hash,
            group_label=scan.group_label,
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


def _opener(importer: Importer, root: Path) -> Callable[[PurePosixPath], BinaryIO] | None:
    if not isinstance(importer, OpensPictures):
        return None
    return functools.partial(importer.open, root)


def _served(
    opener: Callable[[PurePosixPath], BinaryIO] | None, relative: PurePosixPath
) -> BinaryIO | None:
    """The picture the importer reads out of its source, ``None`` when it holds none."""
    if opener is None:
        return None
    try:
        return opener(relative)
    except OSError:
        return None


def _open(path: Path, name: str) -> BinaryIO:
    try:
        return path.open("rb")
    except OSError as exc:
        raise ImportSourceUnreadable(
            f"image {name!r} could not be opened: {exc.strerror or exc.__class__.__name__}"
        ) from None


def _scan_as_pcd(path: Path, scan: ImportedScan) -> bytes:
    """The scan's own bytes behind a binary PCD header, refused unless they are whole records."""
    name = str(scan.path)
    record = scan.layout.record_size
    try:
        size = path.stat().st_size
        if size > MAX_POINT_CLOUD_BYTES:
            raise ImportSourceUnreadable(
                f"scan {name!r} is {size} bytes, over the {MAX_POINT_CLOUD_BYTES} a scan may hold"
            )
        data = path.read_bytes()
    except OSError as exc:
        raise ImportSourceUnreadable(
            f"scan {name!r} could not be read: {exc.strerror or exc.__class__.__name__}"
        ) from None
    if not data or len(data) % record:
        raise ImportSourceUnreadable(
            f"scan {name!r} is {len(data)} bytes, which is not a whole number of "
            f"{record}-byte points"
        )
    return scan.layout.pcd_header(len(data) // record) + data


def _scan_loss(scan: ImportedScan, why: str) -> ImportLoss:
    return ImportLoss(
        kind=ImportLossKind.SCAN,
        subject=str(scan.path),
        count=1,
        reason=f"{why}; its {len(scan.labels)} label(s) would be lost",
    )


def _image_loss(image: ImportedImage, why: str) -> ImportLoss:
    return ImportLoss(
        kind=ImportLossKind.IMAGE,
        subject=str(image.path),
        count=1,
        reason=f"{why}; its {len(image.labels)} label(s) would be lost",
    )


def _listing_order(dataset: ImportedDataset) -> dict[PurePosixPath, tuple[str, int]]:
    """Where a sequenced image sorts: at its sequence's first path, then by position.

    The first of two images with equal bytes wins, so a sequence's frames are
    ranked in its own order rather than by how their paths happen to sort.
    """
    return {
        one.path: (str(sequence.frames[0].path), position)
        for sequence in dataset.sequences
        for position, one in enumerate(sequence.frames)
    }


def _consistent_tracks(
    dataset: ImportedDataset, kept: list[ImportedImage]
) -> tuple[list[ImportedImage], list[ImportLoss]]:
    """The kept images with every track id a track cannot hold taken off its label.

    A track takes the class of its first label in sequence order. A later label
    of another class, or a second label of the same track in one frame, stays a
    label and loses its track id, counted as an ``attribute`` loss. Answers the
    images and those losses.
    """
    by_path = {image.path: image for image in kept}
    dropped: Counter[tuple[str, str]] = Counter()
    for sequence in dataset.sequences:
        classes: dict[str, str] = {}
        for one in sequence.frames:
            image = by_path.get(one.path)
            if image is None:
                continue
            here: set[str] = set()
            labels: list[ImportedLabel] = []
            for label in image.labels:
                if label.track is not None:
                    owner = classes.setdefault(label.track, label.class_name)
                    reason = (
                        _OTHER_CLASS
                        if owner != label.class_name
                        else _REPEATED
                        if label.track in here
                        else None
                    )
                    if reason is None:
                        here.add(label.track)
                    else:
                        dropped[(label.class_name, reason)] += 1
                        label = label.model_copy(update={"track": None})
                labels.append(label)
            by_path[one.path] = image.model_copy(update={"labels": tuple(labels)})
    losses = [
        ImportLoss(kind=ImportLossKind.ATTRIBUTE, subject=name, count=count, reason=reason)
        for (name, reason), count in dropped.items()
    ]
    return [by_path[image.path] for image in kept], losses


def _derived_classes(dataset: ImportedDataset) -> list[LabelClass]:
    return [
        LabelClass(
            name=imported.name, geometries=imported.geometries, attributes=imported.attributes
        )
        for imported in dataset.classes
    ]


def _target_classes(
    dataset: ImportedDataset, active: AnnotationSchema | None
) -> Sequence[LabelClass]:
    """The classes the labels land under: the active schema's, else the ones a commit derives."""
    return _derived_classes(dataset) if active is None else active.classes


def _judged_attributes(
    items: Sequence[_Item], classes: Sequence[LabelClass]
) -> tuple[list[_Item], list[ImportLoss]]:
    """The items with every attribute value ``classes`` would refuse taken off its label.

    A value its class does not declare, or one its definition rejects, is an
    ``attribute`` loss and the label is kept. A label then lacking a required
    attribute is a ``label`` loss alone and is dropped. Each loss is counted per class
    and attribute name. A label whose class or geometry ``classes`` do not hold
    is left as it is, for the schema refusal to name.
    """
    declared = {label_class.name: label_class for label_class in classes}
    definitions_of = {
        label_class.name: {attribute.name: attribute for attribute in label_class.attributes}
        for label_class in classes
    }
    dropped: Counter[tuple[ImportLossKind, str, str]] = Counter()
    judged: list[_Item] = []
    for item in items:
        labels: list[ImportedLabel] = []
        for label in item.labels:
            owner = declared.get(label.class_name)
            if owner is None or label.geometry.type not in owner.geometries:
                labels.append(label)
                continue
            definitions = definitions_of[owner.name]
            values: dict[str, AttributeValue] = {}
            reasons: list[str] = []
            for name, value in label.attributes.items():
                definition = definitions.get(name)
                if definition is None:
                    reasons.append(_undeclared(name))
                elif definition.rejects(value) is not None:
                    reasons.append(_rejected(definition))
                else:
                    values[name] = value
            missing = [
                one.name for one in owner.attributes if one.required and one.name not in values
            ]
            if missing:
                dropped[(ImportLossKind.LABEL, owner.name, _lacking(missing))] += 1
                continue
            dropped.update((ImportLossKind.ATTRIBUTE, owner.name, reason) for reason in reasons)
            labels.append(
                label
                if values == label.attributes
                else label.model_copy(update={"attributes": values})
            )
        judged.append(item.model_copy(update={"labels": tuple(labels)}))
    losses = [
        ImportLoss(kind=kind, subject=subject, count=count, reason=reason)
        for (kind, subject, reason), count in dropped.items()
    ]
    return judged, losses


def _undeclared(name: str) -> str:
    return f"attribute {name[:40]!r} is not one its class declares; the value is not imported"


def _rejected(definition: Attribute) -> str:
    return (
        f"attribute {definition.name!r} holds a value its {definition.kind} definition "
        "rejects; the value is not imported"
    )


def _lacking(names: Sequence[str]) -> str:
    listed = ", ".join(repr(name) for name in names)
    return (
        f"it has no value its class accepts for the required attribute {listed}; "
        "the label is not imported"
    )


def _undeclared_unused(dataset: ImportedDataset, active: AnnotationSchema) -> list[ImportLoss]:
    declared = {label_class.name for label_class in active.classes}
    items: tuple[ImportedImage | ImportedScan, ...] = (*dataset.images, *dataset.scans)
    used = {label.class_name for item in items for label in item.labels}
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
    images: Iterable[ImportedImage | ImportedScan], active: AnnotationSchema
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
                    attributes=label.attributes,
                    schema=active,
                )
            except InvalidAnnotation as refusal:
                refusals.append(refusal)
    return refusals


_Present = dict[tuple[str, str], list[dict[str, AttributeValue]]]


def _present(annotations: Iterable[Annotation]) -> _Present:
    """The asset's labels by class and geometry, each with its attribute values."""
    present: _Present = {}
    for annotation in annotations:
        key = (annotation.label_class, annotation.geometry.model_dump_json())
        present.setdefault(key, []).append(dict(annotation.attributes))
    return present


def _stale_losses(stale: Counter[str]) -> list[ImportLoss]:
    return [
        ImportLoss(kind=ImportLossKind.ATTRIBUTE, subject=name, count=count, reason=_STALE)
        for name, count in stale.items()
    ]


def _occurrences(
    item: ImportedImage | ImportedScan, repeats: dict[PurePosixPath, list[ImportedImage]]
) -> list[tuple[PurePosixPath, Sequence[ImportedLabel]]]:
    return [
        (item.path, item.labels),
        *((one.path, one.labels) for one in repeats.get(item.path, ())),
    ]


def _labels_to_write(
    present: _Present,
    occurrences: Sequence[tuple[PurePosixPath, Sequence[ImportedLabel]]],
) -> tuple[list[tuple[PurePosixPath, list[ImportedLabel]]], int, Counter[str]]:
    """Each occurrence's labels the asset does not already carry, how many it did,
    and per class how many of those it carries with other attribute values.

    The first occurrence is judged as a multiset against the asset. A later one
    repeats its bytes: a tracked label there matches only an annotation no
    earlier label claimed, since a track observes each occurrence through an
    annotation of its own, and an untracked label matches anything the asset
    carries, this run's writes included, so it never stacks. A match is by class
    and geometry; one whose values no matching label carries is not updated.
    """
    unclaimed = Counter({key: len(values) for key, values in present.items()})
    carried = unclaimed.copy()
    values = {key: list(held) for key, held in present.items()}
    answer: list[tuple[PurePosixPath, list[ImportedLabel]]] = []
    already = 0
    stale: Counter[str] = Counter()
    for index, (path, labels) in enumerate(occurrences):
        here = carried.copy()
        new: list[ImportedLabel] = []
        for label in labels:
            key = _key(label)
            pool = unclaimed if index == 0 or label.track is not None else here
            if pool[key] > 0:
                pool[key] -= 1
                already += 1
                if label.attributes not in values.get(key, []):
                    stale[label.class_name] += 1
            else:
                new.append(label)
        carried.update(_key(label) for label in new)
        for label in new:
            values.setdefault(_key(label), []).append(label.attributes)
        answer.append((path, new))
    return answer, already, stale


def _key(label: ImportedLabel) -> tuple[str, str]:
    return (label.class_name, label.geometry.model_dump_json())


def _new_labels(
    present: _Present, labels: Sequence[ImportedLabel]
) -> tuple[list[ImportedLabel], int, Counter[str]]:
    """The labels not already on the asset, as a multiset, how many were, and per
    class how many of those it carries with other attribute values."""
    remaining = Counter({key: len(values) for key, values in present.items()})
    new: list[ImportedLabel] = []
    stale: Counter[str] = Counter()
    for label in labels:
        key = _key(label)
        if remaining[key] > 0:
            remaining[key] -= 1
            if label.attributes not in present[key]:
                stale[label.class_name] += 1
        else:
            new.append(label)
    return new, len(labels) - len(new), stale


def _require_frame_still_declared(
    uow: UnitOfWork,
    asset: Asset,
    labels: Sequence[ImportedLabel],
    frame: ScanFrame,
    scan: ImportedImage | ImportedScan,
) -> None:
    """Refuse a commit whose 3D labels land on a scan whose source declares another frame now.

    The plan checked this, but a deduplicated scan can belong to another source,
    whose frame may be declared again while the blobs are written. The caller
    holds the write lock, the one a frame change takes, so this answer stands
    until the labels commit.
    """
    if not any(geometry_needs_scan_frame(one.geometry, modality=asset.modality) for one in labels):
        return
    source = None if asset.source_id is None else uow.sources.get(asset.source_id)
    declared = None if source is None else source.frame
    if declared != frame:
        raise CalibrationInUse(
            f"scan {str(scan.path)!r} is asset {asset.id}, whose source now declares "
            f"{declared or 'no frame'}, and the source labels it in {frame}; an import never "
            f"re-reads a label in other axes"
        )
