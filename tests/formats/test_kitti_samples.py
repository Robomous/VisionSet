"""Opt-in: real KITTI frames under ``$VISIONSET_POINTCLOUD_SAMPLES/kitti``, read and imported.

Skipped unless the variable names a directory holding a ``kitti`` split. The
frames stay outside the repository (KITTI is CC BY-NC-SA 3.0); CI runs the
synthetic split in ``test_kitti_import.py``.
"""

from __future__ import annotations

import math
import os
import struct
from pathlib import Path

import pytest

from visionset.formats.kitti import KittiImporter
from visionset.kernel.domain import Cuboid3DGeometry, ImportConsent, ImportLossKind
from visionset.kernel.services import ImportService, IngestService, ProjectService, WorkspaceService

SAMPLES = os.environ.get("VISIONSET_POINTCLOUD_SAMPLES")
KITTI = Path(SAMPLES) / "kitti" if SAMPLES else None

pytestmark = pytest.mark.skipif(
    KITTI is None or not KITTI.is_dir(),
    reason="VISIONSET_POINTCLOUD_SAMPLES/kitti is not a directory",
)

#: Enough lidar returns that a box is on its object, not merely near it.
MIN_POINTS_INSIDE = 5


def _inside(points: list[tuple[float, float, float]], box: Cuboid3DGeometry, yaw: float) -> int:
    length, width, height = box.size
    cos, sin = math.cos(yaw), math.sin(yaw)
    count = 0
    for x, y, z in points:
        dx, dy, dz = x - box.center[0], y - box.center[1], z - box.center[2]
        if (
            abs(dx * cos + dy * sin) <= length / 2
            and abs(-dx * sin + dy * cos) <= width / 2
            and abs(dz) <= height / 2
        ):
            count += 1
    return count


def test_every_box_encloses_its_object_in_the_lidar_scan() -> None:
    assert KITTI is not None
    dataset = KittiImporter().read(KITTI)
    labelled = [scan for scan in dataset.scans if scan.labels]
    assert labelled

    turned = straight = 0
    for scan in labelled:
        raw = (KITTI / scan.path).read_bytes()
        points = [record[:3] for record in struct.iter_unpack("<ffff", raw)]
        for label in scan.labels:
            box = label.geometry
            assert isinstance(box, Cuboid3DGeometry)
            inside = _inside(points, box, box.yaw)
            assert inside >= MIN_POINTS_INSIDE, (str(scan.path), label.class_name, inside)
            straight += inside
            turned += _inside(points, box, box.yaw + math.pi / 2)
    assert straight > turned


def test_the_frames_import_as_annotated_scans(tmp_path: Path) -> None:
    assert KITTI is not None
    with WorkspaceService.init(tmp_path / "ws") as workspace:
        project = ProjectService(workspace).create("kitti")
        run = ImportService(workspace).commit(
            project.id,
            KittiImporter(),
            KITTI,
            consent=ImportConsent(kinds=frozenset(ImportLossKind)),
        )
        assets = IngestService(workspace).assets(project.id)

    scans = list(KITTI.rglob("velodyne/*.bin"))
    assert run.batch_id is not None
    assert len(run.created_asset_ids) == len(scans)
    assert all(asset.modality == "point_cloud" for asset in assets)
    assert all(asset.thumbnail_hash is not None for asset in assets)
    assert all(
        asset.point_cloud is not None and "intensity" in asset.point_cloud.fields
        for asset in assets
    )
