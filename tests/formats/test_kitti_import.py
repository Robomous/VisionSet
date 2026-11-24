"""``kitti`` import: lidar scans, their boxes moved into the lidar frame, and what is lost."""

from __future__ import annotations

import math
from collections.abc import Iterator
from pathlib import Path

import pytest
from tests.fixtures.kitti_source import (
    CALIB,
    CAR,
    SCAN,
    scan_bytes,
    write_frame,
    write_kitti_source,
)

from visionset import wire
from visionset.formats.kitti import KittiImporter
from visionset.formats.registry import importer, importers
from visionset.kernel import CalibrationInUse, ImportNotConsented, ImportSourceUnreadable
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


def _losses(src: Path) -> dict[tuple[ImportLossKind, str], int]:
    found: dict[tuple[ImportLossKind, str], int] = {}
    for loss in KittiImporter().read(src).losses:
        found[(loss.kind, loss.subject)] = found.get((loss.kind, loss.subject), 0) + loss.count
    return found


def test_the_importer_is_registered_as_kitti() -> None:
    assert isinstance(importers()["kitti"], KittiImporter)
    assert isinstance(importer("kitti"), KittiImporter)


def test_a_split_reads_as_scans_in_the_lidar_frame(tmp_path: Path) -> None:
    dataset = KittiImporter().read(write_kitti_source(tmp_path / "src"))

    assert dataset.frame is ScanFrame.LIDAR_FLU
    assert dataset.images == ()
    assert [str(scan.path) for scan in dataset.scans] == [
        "velodyne/000000.bin",
        "velodyne/000001.bin",
    ]
    assert {scan.layout for scan in dataset.scans} == {
        ScanLayout(fields=("x", "y", "z", "intensity"))
    }
    assert [(c.name, c.geometries) for c in dataset.classes] == [
        ("Car", (GeometryType.CUBOID_3D,)),
        ("Pedestrian", (GeometryType.CUBOID_3D,)),
    ]


def test_a_box_is_centred_sized_and_turned_into_the_lidar_frame(tmp_path: Path) -> None:
    # Camera location (0, 1.5, 10) is the bottom centre; the calib's offset is (0, -0.08, -0.27).
    (scan, _) = KittiImporter().read(write_kitti_source(tmp_path / "src")).scans
    (label,) = scan.labels
    geometry = label.geometry

    assert isinstance(geometry, Cuboid3DGeometry)
    assert label.class_name == "Car"
    assert geometry.center == pytest.approx((10.27, 0.0, -0.83), abs=1e-9)
    assert geometry.size == (4.0, 1.6, 1.5)
    assert geometry.yaw == pytest.approx(-math.pi / 2, abs=1e-9)
    assert label.confidence is None


def _pitched_calib(degrees: float) -> str:
    """``CALIB`` with the lidar pitched by ``degrees`` against the camera."""
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    nominal = ((0.0, -1.0, 0.0), (0.0, 0.0, -1.0), (1.0, 0.0, 0.0))
    pitch = ((1.0, 0.0, 0.0), (0.0, c, -s), (0.0, s, c))
    rotation = [
        [sum(pitch[i][k] * nominal[k][j] for k in range(3)) for j in range(3)] for i in range(3)
    ]
    translation = (0.0, -0.08, -0.27)
    tr = " ".join(f"{value:.9f}" for i in range(3) for value in (*rotation[i], translation[i]))
    return f"R0_rect: 1 0 0 0 1 0 0 0 1\nTr_velo_to_cam: {tr}\n"


def test_a_calibration_tilted_past_the_tolerance_is_a_label_loss(tmp_path: Path) -> None:
    write_frame(tmp_path / "tilted", "000000", calib=_pitched_calib(20.0))
    write_frame(tmp_path / "level", "000000", calib=_pitched_calib(2.0))

    (tilted,) = KittiImporter().read(tmp_path / "tilted").scans
    (level,) = KittiImporter().read(tmp_path / "level").scans

    assert tilted.labels == ()
    (loss,) = [
        one
        for one in KittiImporter().read(tmp_path / "tilted").losses
        if one.kind is ImportLossKind.LABEL
    ]
    assert (loss.subject, loss.count) == ("Car", 1)
    assert "leans more than 5 degrees" in loss.reason
    assert len(level.labels) == 1


def test_what_the_domain_cannot_hold_is_counted_by_kind(tmp_path: Path) -> None:
    losses = _losses(write_kitti_source(tmp_path / "src"))

    assert losses == {
        (ImportLossKind.LABEL, "DontCare"): 1,
        (ImportLossKind.GEOMETRY, "Car"): 1,
        (ImportLossKind.ATTRIBUTE, "Car"): 1,
        (ImportLossKind.GEOMETRY, "Pedestrian"): 1,
        (ImportLossKind.ATTRIBUTE, "Pedestrian"): 1,
        (ImportLossKind.ATTRIBUTE, "calib"): 2,
    }


def test_a_scan_with_no_label_file_is_imported_unlabelled(tmp_path: Path) -> None:
    write_frame(tmp_path, "000007", labels=None, calib=None)

    dataset = KittiImporter().read(tmp_path)

    assert [scan.labels for scan in dataset.scans] == [()]
    assert dataset.losses == ()
    assert dataset.classes == ()


def test_labels_with_no_calibration_cannot_be_placed_and_are_reported(tmp_path: Path) -> None:
    write_frame(tmp_path, "000000", labels=(CAR, CAR), calib=None)

    dataset = KittiImporter().read(tmp_path)

    assert dataset.scans[0].labels == ()
    (loss,) = dataset.losses
    assert (loss.kind, loss.subject, loss.count) == (ImportLossKind.LABEL, "Car", 2)
    assert "calib/000000.txt is missing" in loss.reason


def test_a_calibration_without_its_transforms_cannot_place_a_label(tmp_path: Path) -> None:
    write_frame(tmp_path, "000000", calib="P0: 1 0 0 0 0 1 0 0 0 0 1 0\n")

    assert _losses(tmp_path)[(ImportLossKind.LABEL, "Car")] == 1


def test_a_label_file_with_no_scan_is_reported(tmp_path: Path) -> None:
    write_frame(tmp_path, "000000")
    write_frame(tmp_path, "000009", points=None, labels=(CAR, CAR))

    assert _losses(tmp_path)[(ImportLossKind.LABEL, "Car")] == 2


def test_malformed_and_degenerate_lines_are_label_losses(tmp_path: Path) -> None:
    flat = CAR.replace("1.50 1.60 4.00", "0.00 1.60 4.00")
    write_frame(tmp_path, "000000", labels=("Car 0.00 0", flat, "Van x" + CAR[3:]))

    dataset = KittiImporter().read(tmp_path)

    assert dataset.scans[0].labels == ()
    assert {(loss.subject, loss.reason) for loss in dataset.losses} >= {
        ("Car", "a malformed label line"),
        ("Car", "a box dimension that is not positive"),
        ("Van", "a malformed label line"),
    }


def test_a_score_in_range_is_the_confidence_and_one_outside_is_an_attribute_loss(
    tmp_path: Path,
) -> None:
    write_frame(tmp_path, "000000", labels=(f"{CAR} 0.75", f"{CAR} 7.5"))

    dataset = KittiImporter().read(tmp_path)

    assert [label.confidence for label in dataset.scans[0].labels] == [0.75, None]
    assert any(
        loss.kind is ImportLossKind.ATTRIBUTE and loss.reason == "a score outside 0 to 1"
        for loss in dataset.losses
    )


def test_training_and_testing_splits_are_read_from_one_level_down(tmp_path: Path) -> None:
    write_frame(tmp_path / "training", "000000")
    write_frame(tmp_path / "testing", "000000", labels=None)

    dataset = KittiImporter().read(tmp_path)

    assert [str(scan.path) for scan in dataset.scans] == [
        "testing/velodyne/000000.bin",
        "training/velodyne/000000.bin",
    ]


def test_a_source_with_no_velodyne_directory_is_refused(tmp_path: Path) -> None:
    (tmp_path / "label_2").mkdir()
    with pytest.raises(ImportSourceUnreadable, match="velodyne"):
        KittiImporter().read(tmp_path)


def test_a_scan_that_is_not_whole_points_is_refused(tmp_path: Path) -> None:
    write_frame(tmp_path, "000000")
    (tmp_path / "velodyne" / "000000.bin").write_bytes(scan_bytes()[:-3])

    with pytest.raises(ImportSourceUnreadable, match="16-byte points"):
        KittiImporter().read(tmp_path)


def test_a_spelled_out_non_finite_number_refuses_the_file(tmp_path: Path) -> None:
    write_frame(tmp_path, "000000", calib=CALIB.replace("R0_rect: 1", "R0_rect: nan"))

    with pytest.raises(ImportSourceUnreadable, match="non-finite"):
        KittiImporter().read(tmp_path)


# --- committed through ImportService ---------------------------------------------


@pytest.fixture
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    with WorkspaceService.init(tmp_path / "ws") as service:
        yield service


def test_inspect_counts_scans_and_writes_nothing(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("drive")
    src = write_kitti_source(tmp_path / "src")

    plan = ImportService(workspace).inspect(project.id, KittiImporter(), src)
    shown = wire.import_plan(plan)

    assert (shown["source_scans"], shown["scans"], shown["images"]) == (2, 2, 0)
    assert (shown["frame"], shown["labels"]) == ("lidar_flu", 2)
    assert shown["loss_kinds"] == ["attribute", "geometry", "label"]
    assert (plan.new_assets, plan.new_annotations, plan.creates_schema) == (2, 2, True)
    assert plan.conflicts == ()
    assert IngestService(workspace).assets(project.id) == []
    assert SourceService(workspace).list(project.id) == []


def test_a_commit_needs_consent_for_each_kind_it_drops(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("drive")
    src = write_kitti_source(tmp_path / "src")

    with pytest.raises(ImportNotConsented):
        ImportService(workspace).commit(project.id, KittiImporter(), src)

    assert IngestService(workspace).assets(project.id) == []
    assert SourceService(workspace).list(project.id) == []


def test_a_commit_is_an_approved_batch_of_scans_under_a_lidar_source(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("drive")
    src = write_kitti_source(tmp_path / "src")
    progress: list[tuple[int, int]] = []

    run = ImportService(workspace).commit(
        project.id,
        KittiImporter(),
        src,
        consent=EVERYTHING,
        on_progress=lambda done, total: progress.append((done, total)),
    )

    assert run.batch_id is not None
    assert (len(run.created_asset_ids), run.annotations_written) == (2, 2)
    assert progress[-1] == (2, 2)
    (source,) = SourceService(workspace).list(project.id)
    assert (source.kind, source.frame) == (SourceKind.POINT_CLOUD_DIRECTORY, ScanFrame.LIDAR_FLU)
    assert source.locator == str(src.resolve())
    assets = IngestService(workspace).assets(project.id)
    assert {asset.modality for asset in assets} == {"point_cloud"}
    assert {asset.source_id for asset in assets} == {source.id}
    assert all(asset.thumbnail_hash is not None for asset in assets)
    assert {asset.point_cloud.point_count for asset in assets if asset.point_cloud} == {len(SCAN)}
    assert BatchService(workspace).get(run.batch_id).state is BatchState.APPROVED
    assert JobService(workspace).batch_progress(run.batch_id)[AssetProgress.ANNOTATED] == 2
    schema = SchemaService(workspace).get_active(project.id)
    assert [(c.name, c.geometries) for c in schema.classes] == [
        ("Car", (GeometryType.CUBOID_3D,)),
        ("Pedestrian", (GeometryType.CUBOID_3D,)),
    ]
    with workspace.unit_of_work() as uow:
        labels = [one for asset in assets for one in uow.annotations.list(asset.id)]
    assert {(one.provenance, one.geometry.type) for one in labels} == {
        ("import", GeometryType.CUBOID_3D)
    }
    sample = IngestService(workspace).points(project.id, assets[0].id, max_points=1000)
    assert sample.total == len(SCAN)
    assert sample.intensity is not None


def test_a_re_run_writes_nothing(workspace: WorkspaceService, tmp_path: Path) -> None:
    project = ProjectService(workspace).create("drive")
    src = write_kitti_source(tmp_path / "src")
    imports = ImportService(workspace)
    imports.commit(project.id, KittiImporter(), src, consent=EVERYTHING)

    again = imports.commit(project.id, KittiImporter(), src, consent=EVERYTHING)

    assert (again.batch_id, again.annotations_already_present) == (None, 2)
    assert len(SourceService(workspace).list(project.id)) == 1


def test_a_scan_whose_points_repeat_another_is_a_scan_loss(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("drive")
    write_frame(tmp_path / "src", "000000")
    write_frame(tmp_path / "src", "000001")

    plan = ImportService(workspace).inspect(project.id, KittiImporter(), tmp_path / "src")

    assert [str(scan.path) for scan in plan.scans] == ["velodyne/000000.bin"]
    assert [(loss.subject, loss.count) for loss in plan.losses if loss.kind == "scan"] == [
        ("velodyne/000001.bin", 1)
    ]


def test_a_root_registered_in_another_frame_refuses_the_import(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("drive")
    src = write_kitti_source(tmp_path / "src")
    SourceService(workspace).register_point_clouds(project.id, src, frame=ScanFrame.CAMERA_RDF)

    plan = ImportService(workspace).inspect(project.id, KittiImporter(), src)
    assert any("camera_rdf" in conflict for conflict in plan.conflicts)
    with pytest.raises(CalibrationInUse):
        ImportService(workspace).commit(project.id, KittiImporter(), src, consent=EVERYTHING)

    assert IngestService(workspace).assets(project.id) == []


def test_a_scan_already_ingested_in_another_frame_refuses_its_labels(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("drive")
    src = write_kitti_source(tmp_path / "src")
    ingested = tmp_path / "ingested"
    ingested.mkdir()
    layout = ScanLayout(fields=("x", "y", "z", "intensity"))
    (ingested / "front.pcd").write_bytes(layout.pcd_header(len(SCAN)) + scan_bytes())
    source = SourceService(workspace).register_point_clouds(
        project.id, ingested, frame=ScanFrame.CAMERA_RDF
    )
    IngestService(workspace).ingest(source.id)

    plan = ImportService(workspace).inspect(project.id, KittiImporter(), src)

    assert plan.new_assets == 1
    assert any("velodyne/000000.bin" in conflict for conflict in plan.conflicts)


def test_a_frame_declared_again_during_the_blob_writes_refuses_the_commit(
    workspace: WorkspaceService, tmp_path: Path
) -> None:
    project = ProjectService(workspace).create("drive")
    src = write_kitti_source(tmp_path / "src")
    ingested = tmp_path / "ingested"
    ingested.mkdir()
    layout = ScanLayout(fields=("x", "y", "z", "intensity"))
    (ingested / "front.pcd").write_bytes(layout.pcd_header(len(SCAN)) + scan_bytes())
    sources = SourceService(workspace)
    other = sources.register_point_clouds(project.id, ingested, frame=ScanFrame.LIDAR_FLU)
    run = IngestService(workspace).ingest(other.id)
    (scan,) = run.assets
    assert run.batch_id is not None
    BatchService(workspace).delete(run.batch_id, confirm=True)
    imports = ImportService(workspace)
    assert not imports.inspect(project.id, KittiImporter(), src).conflicts

    def redeclare(done: int, total: int) -> None:
        if done == 1:
            sources.register_point_clouds(project.id, ingested, frame=ScanFrame.CAMERA_RDF)

    with pytest.raises(CalibrationInUse, match="now declares camera_rdf"):
        imports.commit(project.id, KittiImporter(), src, consent=EVERYTHING, on_progress=redeclare)

    with workspace.unit_of_work() as uow:
        assert uow.annotations.list(scan.id) == []
