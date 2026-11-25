"""``kitti`` export: scans and cuboids written with the canonical calibration, and read back."""

from __future__ import annotations

import io
import math
import random
import struct
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from tests.fixtures.kitti_source import write_kitti_source
from tests.fixtures.point_clouds import ply_binary, write_scans
from tests.formats.test_ultralytics import Fixture
from tests.kernel.test_point_cloud_ingest import CLASSES as SCAN_CLASSES
from tests.kernel.test_point_cloud_ingest import Scans, _car

from visionset.formats.kitti import KittiExporter, KittiImporter
from visionset.formats.kitti.frames import CANONICAL, CameraBox, to_lidar_flu
from visionset.formats.kitti.writer import calibration_text, camera_box, class_tokens, label_line
from visionset.formats.registry import exporter, exporters
from visionset.kernel import ExportSourceUnreadable, LossyExportNotConsented
from visionset.kernel.domain import (
    Annotation,
    ClassExportStatus,
    Cuboid3DGeometry,
    GeometryType,
    ImportConsent,
    ImportLossKind,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    PointCloudBounds,
    PointCloudFormat,
    PointCloudMetadata,
    Polyline3DGeometry,
    RecipeSpec,
    ScanFrame,
    ScanLayout,
    SplitRecipe,
)
from visionset.kernel.services import (
    BatchService,
    DatasetService,
    ImportService,
    JobService,
    ProjectService,
    ReleaseService,
    WorkspaceService,
)

METRES = 1e-6
RADIANS = 1e-6


def _angle_between(a: float, b: float) -> float:
    return abs(math.remainder(a - b, 2 * math.pi))


def _close(a: Sequence[float], b: Sequence[float], tolerance: float = METRES) -> bool:
    return all(abs(x - y) <= tolerance for x, y in zip(a, b, strict=True))


# --- what one frame's files hold ---------------------------------------------------


def test_a_label_line_has_kittis_fifteen_columns_and_a_score_when_there_is_one() -> None:
    box = camera_box(
        Cuboid3DGeometry(center=(10.0, -2.0, 0.75), size=(4.0, 1.6, 1.5), yaw=0.0),
        ScanFrame.LIDAR_FLU,
    )

    plain = label_line("Car", box, None)
    scored = label_line("Car", box, 0.875)

    assert plain == (
        "Car 0.00 3 -1.768192 0.00 0.00 0.00 0.00 "
        "1.500000 1.600000 4.000000 2.000000 0.000000 10.000000 -1.570796"
    )
    assert len(plain.split()) == 15
    assert scored == f"{plain} 0.875000"


def test_alpha_is_rotation_y_less_the_rays_angle() -> None:
    box = camera_box(
        Cuboid3DGeometry(center=(10.0, 0.0, 0.0), size=(1.0, 1.0, 1.0), yaw=0.3),
        ScanFrame.LIDAR_FLU,
    )

    columns = label_line("Car", box, None).split()

    assert float(columns[3]) == pytest.approx(float(columns[14]), abs=RADIANS)


def test_the_calibration_file_is_kittis_seven_lines_with_the_canonical_transform() -> None:
    lines = calibration_text(CANONICAL).splitlines()

    assert [line.split(":")[0] for line in lines] == [
        "P0",
        "P1",
        "P2",
        "P3",
        "R0_rect",
        "Tr_velo_to_cam",
        "Tr_imu_to_velo",
    ]
    values = {line.split(":")[0]: [float(v) for v in line.split(":")[1].split()] for line in lines}
    assert values["Tr_velo_to_cam"] == [0, -1, 0, 0, 0, 0, -1, 0, 1, 0, 0, 0]
    assert values["R0_rect"] == [1, 0, 0, 0, 1, 0, 0, 0, 1]
    assert values["P2"] == [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
    assert "-0.000000000000e+00" not in calibration_text(CANONICAL)


def test_a_class_name_with_whitespace_becomes_one_token() -> None:
    assert class_tokens(["Car", "traffic cone", "road\tsign"]) == {
        "Car": "Car",
        "traffic cone": "traffic_cone",
        "road\tsign": "road_sign",
    }


def test_two_class_names_that_would_merge_are_refused() -> None:
    with pytest.raises(ExportSourceUnreadable, match="'traffic cone' and 'traffic_cone'"):
        class_tokens(["traffic cone", "traffic_cone"])


# --- the exporter over a manifest ----------------------------------------------------


def _scan_asset(
    blob: bytes, frame: ScanFrame, annotations: Sequence[ManifestAnnotation] = (), *, at: int = 1
) -> ManifestAsset:
    return ManifestAsset(
        asset_id=UUID(int=at),
        content_hash=f"{at:064x}",
        uri=f"/scans/{at}.pcd",
        annotations=tuple(annotations),
        modality="point_cloud",
        point_cloud=PointCloudMetadata(
            format=PointCloudFormat.PCD,
            point_count=1,
            bounds=PointCloudBounds(minimum=(0.0, 0.0, 0.0), maximum=(1.0, 1.0, 1.0)),
            fields=("x", "y", "z", "intensity"),
        ),
        frame=frame,
    )


def _cuboid(
    name: str, geometry: Cuboid3DGeometry, confidence: float | None = None
) -> ManifestAnnotation:
    return ManifestAnnotation(
        id=uuid4(),
        label_class=name,
        schema_version=1,
        geometry=geometry,
        provenance="human",
        confidence=confidence,
    )


def _export(
    assets: Sequence[ManifestAsset],
    dest: Path,
    blobs: dict[str, bytes],
    classes: Sequence[str] = ("Car",),
) -> Path:
    manifest = Manifest(
        schema_version=1,
        classes=tuple(
            LabelClass(name=name, geometries=(GeometryType.CUBOID_3D,)) for name in classes
        ),
        assets=tuple(assets),
    )
    dest.mkdir(parents=True, exist_ok=True)
    KittiExporter().export(
        cast(Any, None),
        manifest,
        dest,
        content=lambda key: io.BytesIO(blobs[key]),
        assignment=None,
    )
    return dest


ROWS = ((1.0, 2.0, 3.0, 0.5), (10.0, -4.0, 0.25, 0.75))


def _binary(rows: Sequence[tuple[float, float, float, float]] = ROWS) -> bytes:
    return ScanLayout(fields=("x", "y", "z", "intensity")).pcd_header(len(rows)) + b"".join(
        struct.pack("<ffff", *row) for row in rows
    )


@pytest.mark.parametrize("frame", list(ScanFrame))
def test_a_scan_in_any_frame_reads_back_in_lidar_flu_with_its_boxes(
    tmp_path: Path, frame: ScanFrame
) -> None:
    box = Cuboid3DGeometry(center=(6.0, -1.5, 0.4), size=(4.0, 1.7, 1.5), yaw=0.6)
    asset = _scan_asset(_binary(), frame, [_cuboid("Car", box, 0.5)])

    dest = _export([asset], tmp_path / "out", {asset.content_hash: _binary()})
    dataset = KittiImporter().read(dest)

    assert dataset.frame is ScanFrame.LIDAR_FLU
    (scan,) = dataset.scans
    raw = (dest / scan.path).read_bytes()
    points = list(struct.iter_unpack("<ffff", raw))
    expected = [(*to_lidar_flu(row[:3], frame), row[3]) for row in ROWS]
    assert [pytest.approx(point) for point in points] == expected
    (label,) = scan.labels
    back = label.geometry
    assert isinstance(back, Cuboid3DGeometry)
    assert _close(back.center, to_lidar_flu(box.center, frame))
    assert back.size == box.size
    assert _angle_between(back.yaw, box.yaw) <= RADIANS
    assert label.confidence == 0.5


def test_the_layout_is_one_split_per_fold_named_by_content(tmp_path: Path) -> None:
    asset = _scan_asset(_binary(), ScanFrame.LIDAR_FLU)

    dest = _export([asset], tmp_path / "out", {asset.content_hash: _binary()})

    stem = asset.content_hash
    assert sorted(str(p.relative_to(dest)) for p in dest.rglob("*") if p.is_file()) == [
        f"train/calib/{stem}.txt",
        f"train/label_2/{stem}.txt",
        f"train/velodyne/{stem}.bin",
    ]
    assert (dest / "train/label_2" / f"{stem}.txt").read_text() == ""
    assert (dest / "train/calib" / f"{stem}.txt").read_text() == calibration_text(CANONICAL)


def test_only_cuboids_are_written(tmp_path: Path) -> None:
    line = Polyline3DGeometry(points=[(0.0, 0.0, 0.0), (1.0, 0.0, 0.0)])
    box = Cuboid3DGeometry(center=(6.0, 0.0, 0.0), size=(1.0, 1.0, 1.0), yaw=0.0)
    asset = _scan_asset(
        _binary(), ScanFrame.LIDAR_FLU, [_cuboid("Car", box), _cuboid("Car", cast(Any, line))]
    )

    dest = _export([asset], tmp_path / "out", {asset.content_hash: _binary()})

    (labels,) = list(dest.rglob("label_2/*.txt"))
    assert len(labels.read_text().splitlines()) == 1


def test_a_label_of_an_undeclared_class_refuses_the_export_by_asset(tmp_path: Path) -> None:
    box = Cuboid3DGeometry(center=(6.0, 0.0, 0.0), size=(1.0, 1.0, 1.0), yaw=0.0)
    asset = _scan_asset(_binary(), ScanFrame.LIDAR_FLU, [_cuboid("Tram", box)])

    with pytest.raises(ExportSourceUnreadable, match="'Tram' label the release's classes"):
        _export([asset], tmp_path / "out", {asset.content_hash: _binary()})


def test_a_scan_that_cannot_be_decoded_refuses_the_export_by_asset(tmp_path: Path) -> None:
    asset = _scan_asset(ply_binary(), ScanFrame.LIDAR_FLU)

    with pytest.raises(ExportSourceUnreadable, match=f"asset {asset.asset_id} .* PLY"):
        _export([asset], tmp_path / "out", {asset.content_hash: ply_binary()})


# --- through the kernel --------------------------------------------------------------

EVERYTHING = ImportConsent(kinds=frozenset(ImportLossKind))


class Released:
    """A KITTI split imported, promoted and published, ready to export."""

    def __init__(self, tmp_path: Path, split: SplitRecipe | None = None) -> None:
        self.src = write_kitti_source(tmp_path / "src")
        self.workspace = WorkspaceService.init(tmp_path / "ws")
        self.releases = ReleaseService(self.workspace)
        project = ProjectService(self.workspace).create("drive")
        run = ImportService(self.workspace).commit(
            project.id, KittiImporter(), self.src, consent=EVERYTHING
        )
        assert run.batch_id is not None
        batches, jobs = BatchService(self.workspace), JobService(self.workspace)
        (job,) = batches.jobs(run.batch_id)
        batches.start(run.batch_id)
        jobs.start(job.id)
        jobs.complete(job.id)
        batches.complete(run.batch_id)
        DatasetService(self.workspace).promote(run.batch_id)
        dataset_id = ProjectService(self.workspace).get_dataset(project.id).id
        self.release_id = self.releases.publish(dataset_id, "v1", split=split).id


@pytest.fixture
def released(tmp_path: Path) -> Iterator[Released]:
    fixture = Released(tmp_path)
    yield fixture
    fixture.workspace.close()


def test_kitti_is_registered_as_an_exporter_beside_its_importer() -> None:
    assert isinstance(exporters()["kitti"], KittiExporter)
    assert isinstance(exporter("kitti"), KittiExporter)


def test_a_release_round_trips_through_export_and_import(
    released: Released, tmp_path: Path
) -> None:
    dest = tmp_path / "out"

    released.releases.export(released.release_id, KittiExporter(), dest, allow_lossy=True)

    def boxes(src: Path) -> list[tuple[str, Cuboid3DGeometry]]:
        found = []
        for scan in KittiImporter().read(src).scans:
            for label in scan.labels:
                assert isinstance(label.geometry, Cuboid3DGeometry)
                found.append((label.class_name, label.geometry))
        return sorted(found, key=lambda one: one[0])

    original, again = boxes(released.src), boxes(dest)
    assert [name for name, _ in again] == [name for name, _ in original] == ["Car", "Pedestrian"]
    for (_, before), (_, after) in zip(original, again, strict=True):
        assert _close(after.center, before.center)
        assert after.size == before.size
        assert _angle_between(after.yaw, before.yaw) <= RADIANS
    written = sorted(path.read_bytes() for path in dest.rglob("velodyne/*.bin"))
    assert written == sorted(path.read_bytes() for path in released.src.rglob("velodyne/*.bin"))


def test_each_fold_is_its_own_split_and_the_importer_reads_them_all(tmp_path: Path) -> None:
    fixture = Released(tmp_path, split=SplitRecipe(train=0.5, val=0.5, test=0.0, seed=3))
    try:
        dest = tmp_path / "out"
        fixture.releases.export(fixture.release_id, KittiExporter(), dest, allow_lossy=True)
        folds = sorted(path.parent.parent.name for path in dest.rglob("velodyne/*.bin"))
        dataset = KittiImporter().read(dest)
    finally:
        fixture.workspace.close()

    assert folds == ["train", "val"]
    assert sum(len(scan.labels) for scan in dataset.scans) == 2


def test_the_report_calls_cuboids_supported_for_kitti_and_dropped_elsewhere(
    released: Released,
) -> None:
    kitti = released.releases.check_export(released.release_id, KittiExporter())

    assert kitti.dropped_modalities == ()
    assert {(row.label_class, row.status) for row in kitti.classes} == {
        ("Car", ClassExportStatus.SUPPORTED),
        ("Pedestrian", ClassExportStatus.SUPPORTED),
    }
    assert kitti.excluded_annotations == 0
    for name, other in exporters().items():
        if name in ("kitti", "dummy"):
            continue
        report = released.releases.check_export(released.release_id, other)
        assert report.excluded_annotations == 2, name
        assert not report.compatible, name


def test_kitti_is_lossy_so_an_export_still_asks_for_consent(
    released: Released, tmp_path: Path
) -> None:
    with pytest.raises(LossyExportNotConsented):
        released.releases.export(released.release_id, KittiExporter(), tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_a_recipe_is_refused_for_an_export_that_writes_scans(
    released: Released, tmp_path: Path
) -> None:
    recipe = RecipeSpec(target=None, steps=())

    with pytest.raises(ExportSourceUnreadable, match="point_cloud, and a pre-processing recipe"):
        released.releases.check_export(released.release_id, KittiExporter(), recipe=recipe)
    with pytest.raises(ExportSourceUnreadable, match="without a recipe"):
        released.releases.export(
            released.release_id, KittiExporter(), tmp_path / "out", allow_lossy=True, recipe=recipe
        )
    assert not (tmp_path / "out").exists()


class _MixedScans(Scans):
    """Images and directory-ingested scans, with a cuboid class and a 3D polyline class."""

    def __init__(self, tmp_path: Path) -> None:
        Fixture.__init__(
            self,
            tmp_path,
            images=2,
            classes=(
                *SCAN_CLASSES,
                LabelClass(name="lane_3d", geometries=(GeometryType.POLYLINE_3D,)),
            ),
        )
        self.image_batch_id = self.batch_id
        self.directory = write_scans(tmp_path / "scans")


def _lane_3d() -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="lane_3d",
        schema_version=1,
        geometry=Polyline3DGeometry(points=[(2.0, 0.0, 0.0), (8.0, 0.5, 0.0)]),
        provenance="human",
    )


def test_a_scans_polyline_3d_and_the_images_are_reported_dropped_for_kitti(
    tmp_path: Path,
) -> None:
    mixed = _MixedScans(tmp_path)
    try:
        mixed.read()
        mixed.label_both({0: [_car(), _lane_3d()]})
        release_id = mixed.publish()
        report = mixed.releases.check_export(release_id, KittiExporter())
        with pytest.raises(LossyExportNotConsented):
            mixed.releases.export(release_id, KittiExporter(), tmp_path / "refused")
        with pytest.raises(ExportSourceUnreadable, match="PLY scan"):
            mixed.releases.export(release_id, KittiExporter(), tmp_path / "out", allow_lossy=True)
    finally:
        mixed.close()

    rows = {(one.label_class, one.geometry): one for one in report.classes}
    assert rows[("car_3d", GeometryType.CUBOID_3D)].status is ClassExportStatus.SUPPORTED
    assert rows[("car_3d", GeometryType.CUBOID_3D)].annotations == 1
    lane = rows[("lane_3d", GeometryType.POLYLINE_3D)]
    assert (lane.status, lane.annotations, lane.assets) == (ClassExportStatus.DROPPED, 1, 1)
    assert lane.reason == "kitti cannot place a polyline_3d and drops it"
    (images,) = report.dropped_modalities
    assert (images.modality, images.assets, images.annotations) == ("image", 2, 1)
    assert not report.compatible


def test_a_class_written_as_dont_care_refuses_the_export() -> None:
    with pytest.raises(ExportSourceUnreadable, match="'DontCare'"):
        class_tokens(["Car", "DontCare"])


@pytest.mark.parametrize("rotation_y", (-math.pi, math.pi))
def test_an_angle_at_pi_is_written_within_pi(rotation_y: float) -> None:
    box = CameraBox(
        location=(0.0, 1.0, 10.0), dimensions_hwl=(1.5, 1.6, 4.0), rotation_y=rotation_y
    )

    columns = label_line("Car", box, None).split()

    for written in (float(columns[3]), float(columns[14])):
        assert abs(written) <= math.pi
        assert abs(written) == pytest.approx(math.pi, abs=1e-6)


#: What a re-import can move a box by: ``y`` and ``h`` are each written to the
#: micrometre and the importer recomputes the centre from both, then rounds again.
ROUND_TRIP_METRES = 2e-6


def test_non_round_boxes_come_back_within_the_stated_bound(tmp_path: Path) -> None:
    draw = random.Random(1122)
    boxes = [
        Cuboid3DGeometry(
            center=(draw.uniform(-60, 60), draw.uniform(-60, 60), draw.uniform(-3, 3)),
            size=(draw.uniform(0.3, 12), draw.uniform(0.3, 4), draw.uniform(0.3, 4)),
            yaw=draw.uniform(-math.pi, math.pi),
        )
        for _ in range(300)
    ]
    asset = _scan_asset(_binary(), ScanFrame.LIDAR_FLU, [_cuboid("Car", box) for box in boxes])

    dest = _export([asset], tmp_path / "out", {asset.content_hash: _binary()})
    (scan,) = KittiImporter().read(dest).scans

    back = sorted(
        (label.geometry for label in scan.labels if isinstance(label.geometry, Cuboid3DGeometry)),
        key=lambda one: one.center,
    )
    for before, after in zip(sorted(boxes, key=lambda one: one.center), back, strict=True):
        assert _close(after.center, before.center, ROUND_TRIP_METRES)
        assert _close(after.size, before.size, ROUND_TRIP_METRES)
        assert _angle_between(after.yaw, before.yaw) <= RADIANS
