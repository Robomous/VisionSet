"""Opt-in: real KITTI frames under ``$VISIONSET_POINTCLOUD_SAMPLES/kitti``, imported and exported.

Skipped unless the variable names a directory holding a ``kitti`` split. The
frames stay outside the repository (KITTI is CC BY-NC-SA 3.0); CI runs the
synthetic split in ``test_kitti_import.py`` and ``test_kitti_export.py``.
"""

from __future__ import annotations

import hashlib
import math
import os
import struct
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

import pytest

from visionset.formats.kitti import KittiExporter, KittiImporter
from visionset.kernel.domain import Cuboid3DGeometry, ImportConsent, ImportLossKind, ImportRun
from visionset.kernel.ports import Importer
from visionset.kernel.services import (
    BatchService,
    DatasetService,
    ImportService,
    IngestService,
    JobService,
    ProjectService,
    ReleaseService,
    WorkspaceService,
)

SAMPLES = os.environ.get("VISIONSET_POINTCLOUD_SAMPLES")
KITTI = Path(SAMPLES) / "kitti" if SAMPLES else None

pytestmark = pytest.mark.skipif(
    KITTI is None or not KITTI.is_dir(),
    reason="VISIONSET_POINTCLOUD_SAMPLES/kitti is not a directory",
)

#: Enough lidar returns that a box is on its object, not merely near it.
MIN_POINTS_INSIDE = 5

#: The re-import bound docs/content/import.md states for a ``kitti`` export.
ROUND_TRIP_METRES = 2e-6
RADIANS = 1e-6

EVERYTHING = ImportConsent(kinds=frozenset(ImportLossKind))


@dataclass(frozen=True)
class Published:
    workspace: WorkspaceService
    run: ImportRun
    project_id: UUID
    releases: ReleaseService
    release_id: UUID


def publish(workspace: WorkspaceService, importer: Importer, src: Path) -> Published:
    """``src`` imported, its batch completed and promoted, and the dataset released."""
    project = ProjectService(workspace).create(importer.format_name)
    run = ImportService(workspace).commit(project.id, importer, src, consent=EVERYTHING)
    assert run.batch_id is not None
    batches, jobs = BatchService(workspace), JobService(workspace)
    (job,) = batches.jobs(run.batch_id)
    batches.start(run.batch_id)
    jobs.start(job.id)
    jobs.complete(job.id)
    batches.complete(run.batch_id)
    DatasetService(workspace).promote(run.batch_id)
    releases = ReleaseService(workspace)
    dataset_id = ProjectService(workspace).get_dataset(project.id).id
    return Published(workspace, run, project.id, releases, releases.publish(dataset_id, "v1").id)


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


def _angle_between(a: float, b: float) -> float:
    return abs(math.remainder(a - b, 2 * math.pi))


def _close(a: tuple[float, ...], b: tuple[float, ...], tolerance: float) -> bool:
    return all(abs(x - y) <= tolerance for x, y in zip(a, b, strict=True))


def _boxes_by_scan(src: Path) -> dict[str, list[tuple[str, Cuboid3DGeometry]]]:
    """Each scan's boxes, keyed by the digest of its ``.bin`` so renamed files still pair."""
    found: dict[str, list[tuple[str, Cuboid3DGeometry]]] = {}
    for scan in KittiImporter().read(src).scans:
        boxes = []
        for label in scan.labels:
            assert isinstance(label.geometry, Cuboid3DGeometry)
            boxes.append((label.class_name, label.geometry))
        digest = hashlib.sha256((src / scan.path).read_bytes()).hexdigest()
        assert digest not in found, scan.path
        found[digest] = sorted(boxes, key=lambda one: (one[0], one[1].center))
    return found


def _scan_digests(src: Path) -> Counter[str]:
    return Counter(
        hashlib.sha256(path.read_bytes()).hexdigest() for path in src.rglob("velodyne/*.bin")
    )


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
            project.id, KittiImporter(), KITTI, consent=EVERYTHING
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


def test_the_split_survives_a_kitti_export_and_reimport(tmp_path: Path) -> None:
    assert KITTI is not None
    dest = tmp_path / "out"
    with WorkspaceService.init(tmp_path / "ws") as workspace:
        published = publish(workspace, KittiImporter(), KITTI)
        published.releases.export(published.release_id, KittiExporter(), dest, allow_lossy=True)

    assert _scan_digests(dest) == _scan_digests(KITTI)
    original, again = _boxes_by_scan(KITTI), _boxes_by_scan(dest)
    assert again.keys() == original.keys()
    assert sum(len(boxes) for boxes in original.values()) > 0
    for digest, boxes in original.items():
        back = again[digest]
        assert [name for name, _ in back] == [name for name, _ in boxes], digest
        for (_, before), (_, after) in zip(boxes, back, strict=True):
            assert _close(after.center, before.center, ROUND_TRIP_METRES), (before, after)
            assert _close(after.size, before.size, ROUND_TRIP_METRES), (before, after)
            assert _angle_between(after.yaw, before.yaw) <= RADIANS, (before, after)
