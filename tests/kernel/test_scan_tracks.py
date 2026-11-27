"""Tracks over point-cloud sequences: cuboids on scans an import ordered (#1189).

See ``docs/content/architecture/decisions/a-track-observes-frame-occurrences.md``.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from pathlib import Path
from uuid import UUID

import pytest
from pydantic import ValidationError
from tests.fixtures.calibration import calibration
from tests.fixtures.nuscenes_source import SCAN, scan_bytes

from visionset.kernel import (
    CalibrationNotApplicable,
    InvalidAnnotation,
    SourceNotSequence,
)
from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    Cuboid3DGeometry,
    FrameOccurrence,
    GeometryType,
    ImportConsent,
    ImportedClass,
    ImportedDataset,
    ImportedFrame,
    ImportedLabel,
    ImportedScan,
    ImportedSequence,
    ImportLossKind,
    ImportRun,
    Polyline3DGeometry,
    ScanFrame,
    ScanLayout,
    Source,
    SourceKind,
)
from visionset.kernel.services import (
    AnnotationService,
    BatchService,
    CalibrationService,
    ImportService,
    JobService,
    ProjectService,
    SourceService,
    TrackService,
    WorkspaceService,
)

LAYOUT = ScanLayout(fields=("x", "y", "z", "intensity", "_"))
EVERYTHING = ImportConsent(kinds=frozenset(ImportLossKind))
CLASSES = (
    ImportedClass(name="car", geometries=(GeometryType.CUBOID_3D, GeometryType.POLYLINE_3D)),
    ImportedClass(name="truck", geometries=(GeometryType.CUBOID_3D,)),
)


def _cuboid(x: float = 0.0, label_class: str = "car", track: str | None = "c") -> ImportedLabel:
    return ImportedLabel(
        class_name=label_class,
        geometry=Cuboid3DGeometry(center=(x, 5.0, -1.0), size=(4.0, 2.0, 1.5), yaw=0.1),
        track=track,
    )


class FakeImporter:
    format_name = "fake"

    def __init__(self, dataset: ImportedDataset) -> None:
        self.dataset = dataset

    def read(self, src: Path) -> ImportedDataset:
        return self.dataset


class World:
    def __init__(self, root: Path) -> None:
        self.src = root / "src"
        self.src.mkdir()
        self.workspace = WorkspaceService.init(root / "ws")
        self.project = ProjectService(self.workspace).create("scans")
        self.imports = ImportService(self.workspace)
        self.sources = SourceService(self.workspace)
        self.tracks = TrackService(self.workspace)

    def scans(self, frames: Sequence[tuple[str, int | None, Sequence[ImportedLabel]]]) -> ImportRun:
        """Write each named scan (``None`` writes no file) and import them as one sequence."""
        scans = []
        for name, shift, labels in frames:
            if shift is not None:
                points = tuple((x + shift, y, z, i, r) for x, y, z, i, r in SCAN)
                (self.src / f"{name}.bin").write_bytes(scan_bytes(points))
            scans.append(ImportedScan(path=f"{name}.bin", layout=LAYOUT, labels=tuple(labels)))
        dataset = ImportedDataset(
            classes=CLASSES,
            scans=tuple(scans),
            frame=ScanFrame.LIDAR_RFU,
            sequences=(
                ImportedSequence(
                    name="scene",
                    frames=tuple(
                        ImportedFrame(path=f"{name}.bin", timestamp=0.5 * index)
                        for index, (name, _, _) in enumerate(frames)
                    ),
                ),
            ),
        )
        return self.imports.commit(
            self.project.id, FakeImporter(dataset), self.src, consent=EVERYTHING
        )

    def sequence(self) -> Source:
        (found,) = [
            one
            for one in self.sources.list(self.project.id)
            if one.kind is SourceKind.POINT_CLOUD_SEQUENCE
        ]
        return found

    def working(self, batch_id: UUID) -> AnnotationJob:
        batches, jobs = BatchService(self.workspace), JobService(self.workspace)
        batches.start(batch_id)
        (job,) = batches.jobs(batch_id)
        jobs.start(job.id)
        return jobs.get(job.id)


@pytest.fixture
def world(tmp_path: Path) -> Iterator[World]:
    built = World(tmp_path)
    yield built
    built.workspace.close()


def _positions(world: World, source_id: UUID) -> dict[str | None, list[int]]:
    return {
        detail.track.external_id: [one.position for one in detail.observations]
        for detail in world.tracks.list(source_id)
    }


def test_an_imported_scan_sequence_writes_its_occurrences_and_tracks(world: World) -> None:
    run = world.scans(
        [("s0", 0, [_cuboid(0.0)]), ("s1", None, [_cuboid(1.0)]), ("s2", 2, [_cuboid(2.0)])]
    )

    sequence = world.sequence()
    assert (run.source_ids, run.tracks_written, sequence.frame) == ((sequence.id,), 1, None)
    occurrences = world.sources.occurrences(sequence.id)
    assert [(one.position, one.timestamp) for one in occurrences] == [(0, 0.0), (2, 1.0)]
    assert _positions(world, sequence.id) == {"c": [0, 2]}
    (scan_loss,) = [loss for loss in run.losses if loss.kind is ImportLossKind.SCAN]
    assert scan_loss.subject == "s1.bin"


def test_a_repeated_scan_is_an_occurrence_of_the_first_and_its_labels_are_lost(
    world: World,
) -> None:
    run = world.scans([("s0", 0, [_cuboid(0.0)]), ("s1", 0, [_cuboid(1.0)]), ("s2", 2, [])])

    occurrences = world.sources.occurrences(world.sequence().id)
    assert [one.position for one in occurrences] == [0, 1, 2]
    assert occurrences[0].asset_id == occurrences[1].asset_id
    assert _positions(world, world.sequence().id) == {"c": [0]}
    assert any("its points are those of 's0.bin'" in loss.reason for loss in run.losses)


def test_a_track_id_on_another_class_is_kept_untracked(world: World) -> None:
    run = world.scans([("s0", 0, [_cuboid(0.0)]), ("s1", 1, [_cuboid(1.0, label_class="truck")])])

    assert _positions(world, world.sequence().id) == {"c": [0]}
    (lost,) = [loss for loss in run.losses if loss.subject == "truck"]
    assert (lost.kind, lost.reason) == (
        ImportLossKind.ATTRIBUTE,
        "its track id names a track of another class; the label is kept untracked",
    )


def test_a_track_id_is_refused_on_a_scan_polyline() -> None:
    line = ImportedLabel(
        class_name="car",
        geometry=Polyline3DGeometry(points=[(0.0, 0.0, 0.0), (1.0, 1.0, 0.0)]),
        track="c",
    )
    with pytest.raises(ValidationError, match="a track follows a scan's cuboids only"):
        ImportedDataset(
            classes=CLASSES,
            scans=(ImportedScan(path="s0.bin", layout=LAYOUT, labels=(line,)),),
            frame=ScanFrame.LIDAR_RFU,
            sequences=(
                ImportedSequence(
                    name="scene", frames=(ImportedFrame(path="s0.bin", timestamp=None),)
                ),
            ),
        )


def test_stated_positions_must_be_complete_and_increasing() -> None:
    with pytest.raises(ValidationError, match="positions some frames and not others"):
        ImportedSequence(
            name="scene",
            frames=(
                ImportedFrame(path="a.bin", timestamp=None, position=0),
                ImportedFrame(path="b.bin", timestamp=None),
            ),
        )
    with pytest.raises(ValidationError, match="does not list its positions in order"):
        ImportedSequence(
            name="scene",
            frames=(
                ImportedFrame(path="a.bin", timestamp=None, position=2),
                ImportedFrame(path="b.bin", timestamp=None, position=2),
            ),
        )


def _stored(world: World, asset_id: UUID, geometry: object) -> Annotation:
    annotation = Annotation(
        asset_id=asset_id,
        label_class="car",
        schema_version=1,
        geometry=geometry,  # type: ignore[arg-type]
        provenance="human",
    )
    with world.workspace.unit_of_work() as uow:
        uow.annotations.add(annotation)
    return annotation


def _occurrence(world: World, position: int) -> FrameOccurrence:
    (found,) = [
        one for one in world.sources.occurrences(world.sequence().id) if one.position == position
    ]
    return found


def test_a_job_observes_a_cuboid_on_a_scan_and_refuses_a_scan_polyline(world: World) -> None:
    run = world.scans([("s0", 0, [_cuboid(0.0)]), ("s1", 1, []), ("s2", 2, [])])
    assert run.batch_id is not None
    job = world.working(run.batch_id)
    (track,) = world.tracks.list(world.sequence().id)
    at_one = _occurrence(world, 1)
    cuboid = AnnotationService(world.workspace).add(
        job.id,
        [
            Annotation(
                asset_id=at_one.asset_id,
                label_class="car",
                schema_version=1,
                geometry=Cuboid3DGeometry(center=(1.0, 5.0, -1.0), size=(4.0, 2.0, 1.5), yaw=0.1),
                provenance="human",
            )
        ],
    )[0]

    observed = world.tracks.observe(job.id, track.track.id, at_one.id, cuboid.id)

    assert [one.position for one in observed.observations] == [0, 1]
    at_two = _occurrence(world, 2)
    line = _stored(world, at_two.asset_id, Polyline3DGeometry(points=[(0, 0, 0), (1, 1, 0)]))
    with pytest.raises(InvalidAnnotation, match="cuboid_3d labels only"):
        world.tracks.observe(job.id, track.track.id, at_two.id, line.id)
    with pytest.raises(InvalidAnnotation, match="cuboid_3d labels only"):
        world.tracks.start(job.id, at_two.id, line.id)
    with pytest.raises(InvalidAnnotation, match="cuboid_3d labels only"):
        AnnotationService(world.workspace).update(
            job.id,
            [
                cuboid.model_copy(
                    update={"geometry": Polyline3DGeometry(points=[(0, 0, 0), (1, 1, 0)])}
                )
            ],
        )


def test_a_scan_directory_holds_no_track_and_a_scan_sequence_no_calibration(
    world: World,
) -> None:
    world.scans([("s0", 0, [_cuboid(0.0)])])
    (directory,) = [
        one
        for one in world.sources.list(world.project.id)
        if one.kind is SourceKind.POINT_CLOUD_DIRECTORY
    ]

    with pytest.raises(SourceNotSequence):
        world.tracks.create(directory.id, "car")
    with pytest.raises(CalibrationNotApplicable):
        CalibrationService(world.workspace).set_source_calibration(
            world.sequence().id, calibration()
        )
    with pytest.raises(ValidationError, match="carries no camera calibration"):
        Source.model_validate({**world.sequence().model_dump(), "calibration": calibration()})
