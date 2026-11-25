"""``nuscenes`` import: LIDAR_TOP keyframes, their global boxes moved into the sensor frame."""

from __future__ import annotations

import json
import math
import shutil
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from tests.fixtures.nuscenes_source import (
    CAR,
    PEDESTRIAN,
    SCAN,
    VERSION,
    Keyframe,
    SensorBox,
    axis_angle,
    build,
    scan_bytes,
    write_nuscenes_source,
)

from visionset import wire
from visionset.formats.nuscenes import NuScenesImporter
from visionset.formats.nuscenes.poses import (
    GlobalToSensor,
    Pose,
    TiltedBox,
    global_box_to_sensor,
    rotation_matrix,
)
from visionset.formats.registry import importer, importers
from visionset.kernel import CalibrationInUse, ImportSourceUnreadable
from visionset.kernel.domain import (
    AssetProgress,
    BatchState,
    Cuboid3DGeometry,
    GeometryType,
    ImportConsent,
    ImportLossKind,
    ScanFrame,
    ScanLayout,
    SourceKind,
)
from visionset.kernel.services import (
    BatchService,
    ImportService,
    IngestService,
    JobService,
    ProjectService,
    SchemaService,
    SourceService,
    WorkspaceService,
)

EVERYTHING = ImportConsent(kinds=frozenset(ImportLossKind))
UP = (0.0, 0.0, 1.0)


def _boxes(src: Path) -> list[tuple[str, Cuboid3DGeometry]]:
    found = []
    for scan in NuScenesImporter().read(src).scans:
        for label in scan.labels:
            assert isinstance(label.geometry, Cuboid3DGeometry)
            found.append((label.class_name, label.geometry))
    return found


def _assert_box(geometry: Cuboid3DGeometry, box: SensorBox) -> None:
    assert geometry.center == pytest.approx(box.center, abs=1e-6)
    assert geometry.size == pytest.approx(box.size_lwh, abs=1e-6)
    turn = (geometry.yaw - box.yaw + math.pi) % (2 * math.pi) - math.pi
    assert turn == pytest.approx(0.0, abs=1e-6)


def _losses(src: Path) -> dict[tuple[ImportLossKind, str], int]:
    found: dict[tuple[ImportLossKind, str], int] = {}
    for loss in NuScenesImporter().read(src).losses:
        found[(loss.kind, loss.subject)] = found.get((loss.kind, loss.subject), 0) + loss.count
    return found


def _edit(src: Path, table: str, change: Callable[[dict[str, Any]], object]) -> None:
    path = src / VERSION / f"{table}.json"
    rows = json.loads(path.read_text())
    for row in rows:
        change(row)
    path.write_text(json.dumps(rows))


def test_the_importer_is_registered_as_nuscenes() -> None:
    assert isinstance(importers()["nuscenes"], NuScenesImporter)
    assert isinstance(importer("nuscenes"), NuScenesImporter)


def test_keyframes_read_as_scans_in_the_lidar_rfu_frame(tmp_path: Path) -> None:
    dataset = NuScenesImporter().read(write_nuscenes_source(tmp_path / "src"))

    assert dataset.frame is ScanFrame.LIDAR_RFU
    assert dataset.images == ()
    assert [str(scan.path) for scan in dataset.scans] == [
        "samples/LIDAR_TOP/n015-0001.pcd.bin",
        "samples/LIDAR_TOP/n015-0002.pcd.bin",
    ]
    assert {scan.layout for scan in dataset.scans} == {
        ScanLayout(fields=("x", "y", "z", "intensity", "_"))
    }
    assert [(c.name, c.geometries) for c in dataset.classes] == [
        ("human.pedestrian.adult", (GeometryType.CUBOID_3D,)),
        ("vehicle.car", (GeometryType.CUBOID_3D,)),
    ]
    assert dataset.scans[1].labels == ()


@pytest.mark.parametrize("ego_yaw", [0.0, 2.31, -math.pi / 2, math.pi - 0.01, -2.7])
def test_a_sensor_frame_box_survives_the_trip_through_global(
    tmp_path: Path, ego_yaw: float
) -> None:
    ego = axis_angle((0.3, -0.2, 1.0), ego_yaw)
    edge = SensorBox("vehicle.truck", (-14.0, -2.5, 0.4), (9.1, 2.6, 3.4), math.pi - 1e-4)
    boxes = (CAR, PEDESTRIAN, edge)
    src = build(
        tmp_path / "src",
        [Keyframe("k", boxes, ego_rotation=ego, ego_translation=(-602.5, 1611.0, 3.2))],
    ).write(tmp_path / "src")

    found = dict(_boxes(src))

    for box in boxes:
        _assert_box(found[box.category], box)


def test_a_box_straight_ahead_has_yaw_zero_and_its_length_along_y() -> None:
    identity = Pose.of((1.0, 0.0, 0.0, 0.0), (0.0, 0.0, 0.0))
    ahead = axis_angle(UP, math.pi / 2)

    box = global_box_to_sensor(
        (0.0, 10.0, 0.0), (2.0, 5.0, 1.5), ahead, GlobalToSensor(identity, identity)
    )

    assert (box.center, box.size, box.yaw) == ((0.0, 10.0, 0.0), (5.0, 2.0, 1.5), 0.0)


def test_a_quarter_turn_counter_clockwise_heads_left_along_minus_x() -> None:
    identity = Pose.of((1.0, 0.0, 0.0, 0.0), (0.0, 0.0, 0.0))
    left = axis_angle(UP, math.pi)

    box = global_box_to_sensor(
        (0.0, 0.0, 0.0), (2.0, 5.0, 1.5), left, GlobalToSensor(identity, identity)
    )

    assert box.yaw == pytest.approx(math.pi / 2, abs=1e-9)


def test_the_pose_chain_undoes_the_ego_pose_before_the_sensor_calibration() -> None:
    ego = Pose.of(axis_angle(UP, math.pi / 2), (100.0, 0.0, 0.0))
    sensor = Pose.of(axis_angle(UP, -math.pi / 2), (1.0, 0.0, 2.0))

    # Global (100, 5, 2) is ego (5, 0, 2), five metres ahead; the sensor sits 1 m ahead.
    point = GlobalToSensor(ego, sensor).point((100.0, 5.0, 2.0))

    assert point == pytest.approx((0.0, 4.0, 0.0), abs=1e-9)


def test_rotation_matrix_matches_the_quaternion_and_refuses_a_non_unit_one() -> None:
    matrix = rotation_matrix(axis_angle(UP, math.pi / 2))
    assert [v for row in matrix for v in row] == pytest.approx(
        [0, -1, 0, 1, 0, 0, 0, 0, 1], abs=1e-12
    )
    with pytest.raises(ValueError, match="unit"):
        rotation_matrix((2.0, 0.0, 0.0, 0.0))


def test_a_lean_within_the_tolerance_is_projected_out(tmp_path: Path) -> None:
    heading = (-math.sin(CAR.yaw), math.cos(CAR.yaw), 0.0)
    rolled = SensorBox(CAR.category, CAR.center, CAR.size_lwh, CAR.yaw, axis_angle(heading, 0.05))
    src = build(tmp_path / "src", [Keyframe("k", (rolled,))]).write(tmp_path / "src")

    ((_, geometry),) = _boxes(src)

    _assert_box(geometry, CAR)


def test_a_box_tilted_beyond_the_tolerance_is_a_label_loss_not_flattened(
    tmp_path: Path,
) -> None:
    tipped = SensorBox(
        CAR.category, CAR.center, CAR.size_lwh, CAR.yaw, axis_angle((1.0, 0.0, 0.0), 0.15)
    )
    src = build(tmp_path / "src", [Keyframe("k", (tipped, PEDESTRIAN))]).write(tmp_path / "src")

    dataset = NuScenesImporter().read(src)

    assert [label.class_name for label in dataset.scans[0].labels] == [PEDESTRIAN.category]
    (loss,) = [loss for loss in dataset.losses if loss.kind is ImportLossKind.LABEL]
    assert (loss.subject, loss.count) == (CAR.category, 1)
    assert "6 degrees" in loss.reason


def test_the_tilt_is_measured_against_the_sensor_up_axis() -> None:
    identity = Pose.of((1.0, 0.0, 0.0, 0.0), (0.0, 0.0, 0.0))
    upright = GlobalToSensor(identity, identity)
    leaning = GlobalToSensor(identity, Pose.of(axis_angle((0.0, 1.0, 0.0), 0.2), (0, 0, 0)))
    box = ((0.0, 0.0, 0.0), (2.0, 5.0, 1.5), (1.0, 0.0, 0.0, 0.0))

    global_box_to_sensor(*box, upright)
    with pytest.raises(TiltedBox):
        global_box_to_sensor(*box, leaning)


def test_the_tolerance_keeps_the_five_point_eight_degree_frames_real_data_has() -> None:
    identity = Pose.of((1.0, 0.0, 0.0, 0.0), (0.0, 0.0, 0.0))
    box = ((0.0, 0.0, 0.0), (2.0, 5.0, 1.5), (1.0, 0.0, 0.0, 0.0))

    def pitched(degrees: float) -> GlobalToSensor:
        sensor = Pose.of(axis_angle((0.0, 1.0, 0.0), math.radians(degrees)), (0, 0, 0))
        return GlobalToSensor(identity, sensor)

    global_box_to_sensor(*box, pitched(5.8))
    with pytest.raises(TiltedBox):
        global_box_to_sensor(*box, pitched(6.2))


def test_what_the_domain_cannot_hold_is_counted_by_kind(tmp_path: Path) -> None:
    losses = _losses(write_nuscenes_source(tmp_path / "src"))

    assert losses == {
        (ImportLossKind.IMAGE, "CAM_FRONT"): 2,
        (ImportLossKind.SCAN, "LIDAR_TOP"): 2,
        (ImportLossKind.ATTRIBUTE, "ego_pose"): 2,
        (ImportLossKind.ATTRIBUTE, "vehicle.car"): 3,
        (ImportLossKind.ATTRIBUTE, "human.pedestrian.adult"): 3,
    }


def test_malformed_and_degenerate_boxes_are_label_losses(tmp_path: Path) -> None:
    root = build(tmp_path / "src", [Keyframe("k", (CAR, PEDESTRIAN, CAR))])
    first, second, third = root.tables["sample_annotation"]
    first["size"] = [1.9, 0.0, 1.7]
    second["rotation"] = [1.0, 2.0]
    third["rotation"] = [3.0, 0.0, 0.0, 0.0]
    src = root.write(tmp_path / "src")

    dataset = NuScenesImporter().read(src)

    assert dataset.scans[0].labels == ()
    assert {(loss.subject, loss.reason) for loss in dataset.losses} >= {
        (CAR.category, "a box dimension that is not positive"),
        (PEDESTRIAN.category, "a malformed box"),
        (CAR.category, "a rotation that is not a unit quaternion, so the box cannot be placed"),
    }


def test_an_annotation_whose_sample_has_no_lidar_keyframe_is_reported(tmp_path: Path) -> None:
    root = build(tmp_path / "src", [Keyframe("a"), Keyframe("b", (CAR,))])
    root.tables["sample_data"] = [
        row for row in root.tables["sample_data"] if row["token"] != "sd-b"
    ]
    src = root.write(tmp_path / "src")

    dataset = NuScenesImporter().read(src)

    assert len(dataset.scans) == 1
    assert any(
        loss.kind is ImportLossKind.LABEL and loss.reason == "its sample has no LIDAR_TOP keyframe"
        for loss in dataset.losses
    )


def test_version_folders_are_merged_by_token(tmp_path: Path) -> None:
    src = write_nuscenes_source(tmp_path / "src")
    shutil.copytree(src / VERSION, src / "v1.0-trainval")

    dataset = NuScenesImporter().read(src)

    assert len(dataset.scans) == 2
    assert sum(len(scan.labels) for scan in dataset.scans) == 2


# --- refusals ----------------------------------------------------------------------


def test_a_source_with_no_version_folder_is_refused(tmp_path: Path) -> None:
    (tmp_path / "samples").mkdir()
    with pytest.raises(ImportSourceUnreadable, match="version folder"):
        NuScenesImporter().read(tmp_path)


def test_the_version_folder_itself_is_refused_with_the_root_named(tmp_path: Path) -> None:
    src = write_nuscenes_source(tmp_path / "src")
    with pytest.raises(ImportSourceUnreadable, match="import its parent"):
        NuScenesImporter().read(src / VERSION)


def test_a_root_with_no_lidar_top_keyframe_is_refused(tmp_path: Path) -> None:
    src = write_nuscenes_source(tmp_path / "src")
    _edit(src, "sample_data", lambda row: row.update(is_key_frame=row["token"].startswith("cam")))

    with pytest.raises(ImportSourceUnreadable, match="no LIDAR_TOP keyframe"):
        NuScenesImporter().read(src)


def test_a_root_with_no_lidar_top_sensor_is_refused(tmp_path: Path) -> None:
    src = write_nuscenes_source(tmp_path / "src")
    _edit(src, "sensor", lambda row: row.update(channel=row["channel"].replace("TOP", "LEFT")))

    with pytest.raises(ImportSourceUnreadable, match="no LIDAR_TOP keyframe"):
        NuScenesImporter().read(src)


@pytest.mark.parametrize(
    ("table", "content", "match"),
    [
        ("ego_pose", None, "ego_pose.json is missing"),
        ("sample_annotation", "[{", "not readable JSON"),
        ("category", '{"token": "x"}', "a JSON list of objects"),
        ("ego_pose", '[{"token": "e", "translation": [NaN, 0, 0]}]', "non-finite"),
        ("instance", '[{"category_token": "x"}]', "has no token"),
    ],
)
def test_a_missing_or_corrupt_table_is_refused(
    tmp_path: Path, table: str, content: str | None, match: str
) -> None:
    src = write_nuscenes_source(tmp_path / "src")
    path = src / VERSION / f"{table}.json"
    if content is None:
        path.unlink()
    else:
        path.write_text(content)

    with pytest.raises(ImportSourceUnreadable, match=match):
        NuScenesImporter().read(src)


@pytest.mark.parametrize(
    ("table", "change", "match"),
    [
        ("sample_data", lambda row: row.update(ego_pose_token="gone"), "ego_pose gone"),
        ("sample_data", lambda row: row.update(calibrated_sensor_token="gone"), "calibrated"),
        ("calibrated_sensor", lambda row: row.update(sensor_token="gone"), "sensor gone"),
        ("calibrated_sensor", lambda row: row.update(rotation=[2, 0, 0, 0]), "unit quaternion"),
        ("ego_pose", lambda row: row.update(translation=[0, 0]), "translation of three"),
        ("instance", lambda row: row.update(category_token="gone"), "category is named"),
    ],
)
def test_a_dangling_or_malformed_reference_is_refused(
    tmp_path: Path, table: str, change: Callable[[dict[str, Any]], object], match: str
) -> None:
    src = write_nuscenes_source(tmp_path / "src")
    _edit(src, table, change)

    with pytest.raises(ImportSourceUnreadable, match=match):
        NuScenesImporter().read(src)


def test_a_scan_that_is_not_whole_points_is_refused(tmp_path: Path) -> None:
    src = write_nuscenes_source(tmp_path / "src")
    (src / "samples/LIDAR_TOP/n015-0001.pcd.bin").write_bytes(scan_bytes()[:-4])

    with pytest.raises(ImportSourceUnreadable, match="20-byte points"):
        NuScenesImporter().read(src)


def test_a_filename_that_leaves_the_root_is_refused(tmp_path: Path) -> None:
    src = write_nuscenes_source(tmp_path / "src")
    _edit(src, "sample_data", lambda row: row.update(filename="../outside.pcd.bin"))

    with pytest.raises(ImportSourceUnreadable, match="leaves the source"):
        NuScenesImporter().read(src)


# --- committed through ImportService -----------------------------------------------


@pytest.fixture
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    with WorkspaceService.init(tmp_path / "ws") as service:
        yield service


def test_inspect_counts_scans_and_writes_nothing(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("drive")
    src = write_nuscenes_source(tmp_path / "src")

    plan = ImportService(workspace).inspect(project.id, NuScenesImporter(), src)
    shown = wire.import_plan(plan)

    assert (shown["source_scans"], shown["scans"], shown["images"]) == (2, 2, 0)
    assert (shown["frame"], shown["labels"]) == ("lidar_rfu", 2)
    assert shown["loss_kinds"] == ["attribute", "image", "scan"]
    assert (plan.new_assets, plan.new_annotations, plan.creates_schema) == (2, 2, True)
    assert plan.conflicts == ()
    assert IngestService(workspace).assets(project.id) == []


def test_a_missing_keyframe_file_is_a_scan_loss(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("drive")
    src = write_nuscenes_source(tmp_path / "src")
    (src / "samples/LIDAR_TOP/n015-0002.pcd.bin").unlink()

    plan = ImportService(workspace).inspect(project.id, NuScenesImporter(), src)

    assert [str(path) for path in plan.missing_scans] == ["samples/LIDAR_TOP/n015-0002.pcd.bin"]


def test_a_commit_is_an_approved_batch_of_scans_under_a_lidar_rfu_source(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("drive")
    src = write_nuscenes_source(tmp_path / "src")

    run = ImportService(workspace).commit(project.id, NuScenesImporter(), src, consent=EVERYTHING)

    assert run.batch_id is not None
    assert (len(run.created_asset_ids), run.annotations_written) == (2, 2)
    (source,) = SourceService(workspace).list(project.id)
    assert (source.kind, source.frame) == (SourceKind.POINT_CLOUD_DIRECTORY, ScanFrame.LIDAR_RFU)
    assets = IngestService(workspace).assets(project.id)
    assert {asset.modality for asset in assets} == {"point_cloud"}
    assert all(asset.thumbnail_hash is not None for asset in assets)
    assert {asset.point_cloud.point_count for asset in assets if asset.point_cloud} == {len(SCAN)}
    assert BatchService(workspace).get(run.batch_id).state is BatchState.APPROVED
    assert JobService(workspace).batch_progress(run.batch_id)[AssetProgress.ANNOTATED] == 1
    schema = SchemaService(workspace).get_active(project.id)
    assert [c.name for c in schema.classes] == ["human.pedestrian.adult", "vehicle.car"]
    sample = IngestService(workspace).points(project.id, assets[0].id, max_points=1000)
    assert sample.total == len(SCAN)
    assert sample.intensity is not None

    again = ImportService(workspace).commit(project.id, NuScenesImporter(), src, consent=EVERYTHING)
    assert (again.batch_id, again.annotations_already_present) == (None, 2)


def test_a_root_registered_in_another_frame_refuses_the_import(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("drive")
    src = write_nuscenes_source(tmp_path / "src")
    SourceService(workspace).register_point_clouds(project.id, src, frame=ScanFrame.LIDAR_FLU)

    with pytest.raises(CalibrationInUse):
        ImportService(workspace).commit(project.id, NuScenesImporter(), src, consent=EVERYTHING)
