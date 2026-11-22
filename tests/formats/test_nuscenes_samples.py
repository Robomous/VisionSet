"""Opt-in: a real nuScenes data root under ``$VISIONSET_POINTCLOUD_SAMPLES/nuscenes``.

Skipped unless the variable names a directory holding a ``nuscenes`` data root
(a version folder of tables beside ``samples/LIDAR_TOP``). The data stays
outside the repository (nuScenes is CC BY-NC-SA 4.0 behind a registration);
CI runs the synthetic root in ``test_nuscenes_import.py``.
"""

from __future__ import annotations

import math
import os
import struct
from pathlib import Path

import pytest

from visionset.formats.nuscenes import NuScenesImporter
from visionset.kernel.domain import Cuboid3DGeometry, ImportConsent, ImportLossKind
from visionset.kernel.services import ImportService, IngestService, ProjectService, WorkspaceService

SAMPLES = os.environ.get("VISIONSET_POINTCLOUD_SAMPLES")
NUSCENES = Path(SAMPLES) / "nuscenes" if SAMPLES else None

pytestmark = pytest.mark.skipif(
    NUSCENES is None or not NUSCENES.is_dir(),
    reason="VISIONSET_POINTCLOUD_SAMPLES/nuscenes is not a directory",
)

#: nuScenes keeps boxes a keyframe's lidar barely sees, so only most hold a return.
MIN_SHARE_WITH_POINTS = 0.7


def _inside(points: list[tuple[float, float, float]], box: Cuboid3DGeometry, yaw: float) -> int:
    length, width, height = box.size
    # lidar_rfu: heading cos(yaw)·(0, 1, 0) + sin(yaw)·(-1, 0, 0).
    hx, hy = -math.sin(yaw), math.cos(yaw)
    count = 0
    for x, y, z in points:
        dx, dy, dz = x - box.center[0], y - box.center[1], z - box.center[2]
        if (
            abs(dx * hx + dy * hy) <= length / 2
            and abs(-dx * hy + dy * hx) <= width / 2
            and abs(dz) <= height / 2
        ):
            count += 1
    return count


def test_the_boxes_enclose_their_objects_in_the_sensor_frame() -> None:
    assert NUSCENES is not None
    dataset = NuScenesImporter().read(NUSCENES)
    labelled = [scan for scan in dataset.scans if scan.labels]
    assert labelled

    boxes = with_points = turned = straight = 0
    for scan in labelled:
        raw = (NUSCENES / scan.path).read_bytes()
        points = [record[:3] for record in struct.iter_unpack("<fffff", raw)]
        for label in scan.labels:
            box = label.geometry
            assert isinstance(box, Cuboid3DGeometry)
            inside = _inside(points, box, box.yaw)
            boxes += 1
            with_points += inside > 0
            straight += inside
            turned += _inside(points, box, box.yaw + math.pi / 2)
    assert with_points / boxes >= MIN_SHARE_WITH_POINTS, (with_points, boxes)
    assert straight > turned


def test_the_keyframes_import_as_annotated_scans(tmp_path: Path) -> None:
    assert NUSCENES is not None
    dataset = NuScenesImporter().read(NUSCENES)
    present = [scan for scan in dataset.scans if (NUSCENES / scan.path).is_file()]
    with WorkspaceService.init(tmp_path / "ws") as workspace:
        project = ProjectService(workspace).create("nuscenes")
        run = ImportService(workspace).commit(
            project.id,
            NuScenesImporter(),
            NUSCENES,
            consent=ImportConsent(kinds=frozenset(ImportLossKind)),
        )
        assets = IngestService(workspace).assets(project.id)

    assert run.batch_id is not None
    assert len(run.created_asset_ids) == len(present)
    assert all(asset.modality == "point_cloud" for asset in assets)
    assert all(asset.thumbnail_hash is not None for asset in assets)
    assert all(
        asset.point_cloud is not None and "intensity" in asset.point_cloud.fields
        for asset in assets
    )
