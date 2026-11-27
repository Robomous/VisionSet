"""``nuscenes`` import: each scene is a point-cloud sequence and each instance a track (#1189).

See ``docs/content/architecture/decisions/a-track-observes-frame-occurrences.md``.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from tests.fixtures.nuscenes_source import (
    CAR,
    PEDESTRIAN,
    SCAN,
    Keyframe,
    SensorBox,
    build,
)
from tests.formats.test_kitti_samples import EVERYTHING, publish

from visionset.formats.cvat import CvatVideoExporter
from visionset.formats.mot import MotExporter
from visionset.formats.nuscenes import NuScenesImporter
from visionset.kernel.domain import (
    SCAN_SEQUENCE_MANIFEST_VERSION,
    GeometryType,
    ImportLossKind,
    SourceKind,
    TrackDetail,
)
from visionset.kernel.services import (
    ImportService,
    ProjectService,
    SourceService,
    TrackService,
    WorkspaceService,
)

#: One car followed through a scene, and a pedestrian seen in two of its samples.
FOLLOWED = SensorBox("vehicle.car", CAR.center, CAR.size_lwh, CAR.yaw, instance="inst-car")
WALKER = SensorBox(
    "human.pedestrian.adult",
    PEDESTRIAN.center,
    PEDESTRIAN.size_lwh,
    PEDESTRIAN.yaw,
    instance="inst-walker",
)


def _points(shift: float) -> tuple[tuple[float, float, float, float, float], ...]:
    return tuple((x + shift, y, z, i, r) for x, y, z, i, r in SCAN)


def _scene(*names: str, scene: str = "scene-0061", shift: float = 0.0) -> list[Keyframe]:
    """Keyframes in sample order; the names deliberately sort otherwise."""
    return [
        Keyframe(
            name,
            (FOLLOWED, WALKER) if index in (0, 2) else (FOLLOWED,),
            points=_points(shift + index),
            scene=scene,
        )
        for index, name in enumerate(names)
    ]


@pytest.fixture
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    with WorkspaceService.init(tmp_path / "ws") as service:
        yield service


def _tracks(workspace: WorkspaceService, source_id: Any) -> dict[str, list[tuple[int, float]]]:
    found: list[TrackDetail] = TrackService(workspace).list(source_id)
    return {
        str(detail.track.external_id): [(f.position, f.timestamp) for f in detail.observations]
        for detail in found
    }


def _sequences(workspace: WorkspaceService, project_id: Any) -> list[Any]:
    return [
        source
        for source in SourceService(workspace).list(project_id)
        if source.kind is SourceKind.POINT_CLOUD_SEQUENCE
    ]


def test_each_instance_is_a_track_over_its_scene_in_sample_order(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    src = build(tmp_path / "src", _scene("zulu", "alpha", "mike")).write(tmp_path / "src")
    project = ProjectService(workspace).create("drive")

    plan = ImportService(workspace).inspect(project.id, NuScenesImporter(), src)
    run = ImportService(workspace).commit(project.id, NuScenesImporter(), src, consent=EVERYTHING)

    assert (plan.sequences, plan.tracks) == (1, 2)
    assert not [loss for loss in plan.losses if "instance" in loss.reason]
    (sequence,) = _sequences(workspace, project.id)
    assert (sequence.name, run.source_ids, run.tracks_written) == ("scene-0061", (sequence.id,), 2)
    occurrences = SourceService(workspace).occurrences(sequence.id)
    assert [(one.position, one.timestamp) for one in occurrences] == [(0, 0.0), (1, 1.0), (2, 2.0)]
    assert _tracks(workspace, sequence.id) == {
        "inst-car": [(0, 0.0), (1, 1.0), (2, 2.0)],
        "inst-walker": [(0, 0.0), (2, 2.0)],
    }
    (car,) = [
        d for d in TrackService(workspace).list(sequence.id) if d.track.external_id == "inst-car"
    ]
    assert car.track.label_class == "vehicle.car"


def test_a_scan_the_source_does_not_hold_is_an_absent_position(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    src = build(tmp_path / "src", _scene("k0", "k1", "k2")).write(tmp_path / "src")
    (src / "samples/LIDAR_TOP/k1.pcd.bin").unlink()
    project = ProjectService(workspace).create("drive")

    run = ImportService(workspace).commit(project.id, NuScenesImporter(), src, consent=EVERYTHING)

    (sequence,) = _sequences(workspace, project.id)
    occurrences = SourceService(workspace).occurrences(sequence.id)
    assert [one.position for one in occurrences] == [0, 2]
    assert _tracks(workspace, sequence.id)["inst-car"] == [(0, 0.0), (2, 2.0)]
    (missing,) = [
        loss for loss in run.losses if loss.kind is ImportLossKind.SCAN and "k1" in loss.subject
    ]
    assert "label(s) would be lost" in missing.reason


def test_a_sample_with_no_lidar_keyframe_is_an_absent_position(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    root = build(tmp_path / "src", _scene("k0", "k1", "k2"))
    root.tables["sample_data"] = [
        row for row in root.tables["sample_data"] if row["token"] != "sd-k1"
    ]
    src = root.write(tmp_path / "src")
    project = ProjectService(workspace).create("drive")

    ImportService(workspace).commit(project.id, NuScenesImporter(), src, consent=EVERYTHING)

    (sequence,) = _sequences(workspace, project.id)
    assert [one.position for one in SourceService(workspace).occurrences(sequence.id)] == [0, 2]
    assert _tracks(workspace, sequence.id)["inst-car"] == [(0, 0.0), (2, 2.0)]


def test_a_broken_chain_is_reported_and_the_scene_ordered_by_time(tmp_path: Path) -> None:
    root = build(tmp_path / "src", _scene("k0", "k1", "k2"))
    root.tables["sample"][1]["next"] = "sample-nowhere"
    src = root.write(tmp_path / "src")

    dataset = NuScenesImporter().read(src)

    ((sequence),) = dataset.sequences
    assert [(str(f.path), f.position) for f in sequence.frames] == [
        ("samples/LIDAR_TOP/k0.pcd.bin", 0),
        ("samples/LIDAR_TOP/k1.pcd.bin", 1),
        ("samples/LIDAR_TOP/k2.pcd.bin", 2),
    ]
    (broken,) = [loss for loss in dataset.losses if loss.subject == "scene-0061"]
    assert "ordered by timestamp instead" in broken.reason


def test_a_scene_that_cannot_be_ordered_keeps_its_boxes_untracked(tmp_path: Path) -> None:
    root = build(tmp_path / "src", _scene("k0", "k1", "k2"))
    root.tables["scene"][0]["first_sample_token"] = ""
    root.tables["sample"][2].pop("timestamp")
    src = root.write(tmp_path / "src")

    dataset = NuScenesImporter().read(src)

    assert dataset.sequences == ()
    assert all(label.track is None for scan in dataset.scans for label in scan.labels)
    reasons = {(loss.subject, loss.count): loss.reason for loss in dataset.losses}
    assert "neither chained nor timed" in reasons[("scene-0061", 1)]
    assert "not carried as a track" in reasons[("vehicle.car", 3)]


def test_untimed_samples_leave_the_order_and_drop_the_timing(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    root = build(tmp_path / "src", _scene("k0", "k1"))
    root.tables["sample"][1]["timestamp"] = "later"
    src = root.write(tmp_path / "src")
    project = ProjectService(workspace).create("drive")

    ImportService(workspace).commit(project.id, NuScenesImporter(), src, consent=EVERYTHING)

    (sequence,) = _sequences(workspace, project.id)
    assert _tracks(workspace, sequence.id)["inst-car"] == [(0, None), (1, None)]


def test_one_instance_token_in_two_scenes_or_two_imports_is_two_tracks(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("drive")
    both = _scene("a0", "a1", scene="scene-0061") + _scene("b0", "b1", scene="scene-0103", shift=10)
    first = build(tmp_path / "one", both).write(tmp_path / "one")
    copy = build(tmp_path / "two", _scene("c0", "c1", scene="scene-0061", shift=20))
    second = copy.write(tmp_path / "two")

    one = ImportService(workspace).commit(project.id, NuScenesImporter(), first, consent=EVERYTHING)
    again = ImportService(workspace).commit(
        project.id, NuScenesImporter(), first, consent=EVERYTHING
    )
    two = ImportService(workspace).commit(
        project.id, NuScenesImporter(), second, consent=EVERYTHING
    )

    assert (len(one.source_ids), again.source_ids, again.batch_id) == (2, (), None)
    assert len(two.source_ids) == 1
    sequences = _sequences(workspace, project.id)
    assert sorted(source.name for source in sequences) == ["scene-0061", "scene-0061", "scene-0103"]
    cars = [
        detail
        for source in sequences
        for detail in TrackService(workspace).list(source.id)
        if detail.track.external_id == "inst-car"
    ]
    assert len(cars) == 3
    assert len({detail.track.source_id for detail in cars}) == 3


def test_a_release_lists_each_scene_and_its_tracks_and_publishes_stably(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    src = build(tmp_path / "src", _scene("zulu", "alpha", "mike")).write(tmp_path / "src")
    published = publish(workspace, NuScenesImporter(), src)
    releases = published.releases
    dataset_id = ProjectService(workspace).get_dataset(published.project_id).id

    manifest = releases.manifest(published.release_id)
    again = releases.publish(dataset_id, "v2")

    assert manifest.manifest_version == SCAN_SEQUENCE_MANIFEST_VERSION
    (source,) = manifest.sources
    assert (source.kind, [one.position for one in source.occurrences]) == (
        "point_cloud_sequence",
        [0, 1, 2],
    )
    assert sorted((track.external_id, len(track.observations)) for track in manifest.tracks) == [
        ("inst-car", 3),
        ("inst-walker", 2),
    ]
    geometries = {
        annotation.geometry.type for asset in manifest.assets for annotation in asset.annotations
    }
    assert geometries == {GeometryType.CUBOID_3D}
    assert again.manifest_hash == releases.get(published.release_id).manifest_hash
    assert releases.verify(published.release_id).ok


@pytest.mark.parametrize("exporter", [MotExporter(), CvatVideoExporter()])
def test_an_image_track_format_drops_the_scans_and_says_so(
    workspace: WorkspaceService, tmp_path: Path, exporter: Any
) -> None:
    src = build(tmp_path / "src", _scene("k0", "k1")).write(tmp_path / "src")
    published = publish(workspace, NuScenesImporter(), src)

    report = published.releases.check_export(published.release_id, exporter)
    result = published.releases.export(
        published.release_id, exporter, tmp_path / "out", allow_lossy=True
    )

    (dropped,) = report.dropped_modalities
    assert (dropped.modality, dropped.assets, dropped.annotations) == ("point_cloud", 2, 3)
    assert result.file_count == 0
