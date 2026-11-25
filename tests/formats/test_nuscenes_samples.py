"""Opt-in: a real nuScenes data root under ``$VISIONSET_POINTCLOUD_SAMPLES/nuscenes``.

Skipped unless the variable names a directory holding a ``nuscenes`` data root
(a version folder of tables beside ``samples/LIDAR_TOP``). The data stays
outside the repository (nuScenes is CC BY-NC-SA 4.0 behind a registration);
CI runs the synthetic root in ``test_nuscenes_import.py``.

The expected values come from the sample itself: each ``sample_annotation``
carries ``num_lidar_pts``, the LIDAR_TOP returns nuScenes counted inside the box.
"""

from __future__ import annotations

import json
import math
import os
import struct
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from tests.formats.test_kitti_samples import Published, publish

from visionset.formats.kitti import KittiExporter, KittiImporter
from visionset.formats.nuscenes import NuScenesImporter
from visionset.formats.nuscenes.poses import (
    FRAME,
    GlobalToSensor,
    Pose,
    Vector,
    rotation_matrix,
)
from visionset.kernel.domain import (
    Cuboid3DGeometry,
    ImportedDataset,
    ImportLossKind,
    SplitGrouping,
    SplitRecipe,
)
from visionset.kernel.services import IngestService, ProjectService, WorkspaceService

SAMPLES = os.environ.get("VISIONSET_POINTCLOUD_SAMPLES")
NUSCENES = Path(SAMPLES) / "nuscenes" if SAMPLES else None

pytestmark = pytest.mark.skipif(
    NUSCENES is None or not NUSCENES.is_dir(),
    reason="VISIONSET_POINTCLOUD_SAMPLES/nuscenes is not a directory",
)

#: The mean point-count gap a yaw-only cuboid may leave against nuScenes' full box.
MAX_MEAN_GAP_YAW_ONLY = 2.0

#: The split whose every box is known to stand within the tilt tolerance.
UPRIGHT_SPLIT = "v1.0-mini"

#: Side of a grid cell, in metres, that narrows a box's candidate points.
CELL = 2.0

Axes = tuple[Vector, Vector, Vector]


@dataclass
class Survey:
    """Every annotation on a present LIDAR_TOP keyframe, counted once against its scan."""

    versions: tuple[str, ...]
    dataset: ImportedDataset
    annotations: int = 0
    full_mismatches: list[tuple[str, int, int]] = field(default_factory=list)
    yaw_only: list[tuple[int, int]] = field(default_factory=list)


def _versions(root: Path) -> list[Path]:
    return sorted(child for child in root.iterdir() if (child / "sample_data.json").is_file())


def _table(versions: list[Path], name: str) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for version in versions:
        for row in json.loads((version / f"{name}.json").read_text(encoding="utf-8")):
            rows[row["token"]] = row
    return rows


def _pose(row: dict[str, Any]) -> Pose:
    rotation = row["rotation"]
    return Pose.of(
        (rotation[0], rotation[1], rotation[2], rotation[3]), _vector(row["translation"])
    )


def _vector(values: list[float]) -> Vector:
    return (values[0], values[1], values[2])


Grid = dict[tuple[int, int], list[Vector]]


def _grid(path: Path) -> Grid:
    grid: Grid = defaultdict(list)
    for x, y, z, _, _ in struct.iter_unpack("<5f", path.read_bytes()):
        grid[(math.floor(x / CELL), math.floor(y / CELL))].append((x, y, z))
    return grid


def _cells(low: float, high: float) -> range:
    return range(math.floor(low / CELL), math.floor(high / CELL) + 1)


def _count(grid: Grid, center: Vector, axes: Axes, half: Vector) -> int:
    """Points inside the box, with candidates narrowed to the cells its bounds overlap."""
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = axes
    hl, hw, hh = half
    ox, oy, oz = center
    rx = abs(ax) * hl + abs(bx) * hw + abs(cx) * hh
    ry = abs(ay) * hl + abs(by) * hw + abs(cy) * hh
    count = 0
    for ix in _cells(ox - rx, ox + rx):
        for iy in _cells(oy - ry, oy + ry):
            for x, y, z in grid.get((ix, iy), ()):
                dx, dy, dz = x - ox, y - oy, z - oz
                if (
                    abs(dx * ax + dy * ay + dz * az) <= hl
                    and abs(dx * bx + dy * by + dz * bz) <= hw
                    and abs(dx * cx + dy * cy + dz * cz) <= hh
                ):
                    count += 1
    return count


def _axis(index_sign: tuple[int, int]) -> Vector:
    index, sign = index_sign
    return (
        float(sign) if index == 0 else 0.0,
        float(sign) if index == 1 else 0.0,
        float(sign) if index == 2 else 0.0,
    )


def _yaw_only_axes(yaw: float) -> Axes:
    forward, left = _axis(FRAME.forward), _axis(FRAME.left)
    cos, sin = math.cos(yaw), math.sin(yaw)
    heading = [cos * ahead + sin * aside for ahead, aside in zip(forward, left, strict=True)]
    side = [-sin * ahead + cos * aside for ahead, aside in zip(forward, left, strict=True)]
    return (_vector(heading), _vector(side), _axis(FRAME.up))


def _rounded(center: Vector) -> Vector:
    return (round(center[0], 6) + 0.0, round(center[1], 6) + 0.0, round(center[2], 6) + 0.0)


@pytest.fixture(scope="module")
def survey() -> Survey:
    assert NUSCENES is not None
    versions = _versions(NUSCENES)
    dataset = NuScenesImporter().read(NUSCENES)
    result = Survey(versions=tuple(version.name for version in versions), dataset=dataset)
    scans = {str(scan.path): scan for scan in dataset.scans}

    sensors = _table(versions, "sensor")
    lidar = {
        token: row
        for token, row in _table(versions, "calibrated_sensor").items()
        if sensors[row["sensor_token"]]["channel"] == "LIDAR_TOP"
    }
    egos = _table(versions, "ego_pose")
    keyframes = {
        row["sample_token"]: row
        for row in _table(versions, "sample_data").values()
        if row["is_key_frame"] and row["calibrated_sensor_token"] in lidar
    }
    by_sample: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in _table(versions, "sample_annotation").values():
        if row["sample_token"] in keyframes:
            by_sample[row["sample_token"]].append(row)

    for sample, rows in by_sample.items():
        keyframe = keyframes[sample]
        file = NUSCENES / keyframe["filename"]
        if not file.is_file():
            continue
        transform = GlobalToSensor(
            ego=_pose(egos[keyframe["ego_pose_token"]]),
            sensor=_pose(lidar[keyframe["calibrated_sensor_token"]]),
        )
        stored: dict[Vector, Cuboid3DGeometry] = {}
        for label in scans[keyframe["filename"]].labels:
            assert isinstance(label.geometry, Cuboid3DGeometry)
            assert label.geometry.center not in stored
            stored[label.geometry.center] = label.geometry
        grid = _grid(file)
        for annotation in rows:
            expected = annotation["num_lidar_pts"]
            r = annotation["rotation"]
            orientation = rotation_matrix((r[0], r[1], r[2], r[3]))
            axes = (
                transform.direction(_vector([row[0] for row in orientation])),
                transform.direction(_vector([row[1] for row in orientation])),
                transform.direction(_vector([row[2] for row in orientation])),
            )
            center = transform.point(_vector(annotation["translation"]))
            width, length, height = annotation["size"]
            full = _count(grid, center, axes, (length / 2, width / 2, height / 2))
            result.annotations += 1
            if full != expected:
                result.full_mismatches.append((annotation["token"], full, expected))
            box = stored.pop(_rounded(center), None)
            if box is not None:
                length, width, height = box.size
                inside = _count(
                    grid, box.center, _yaw_only_axes(box.yaw), (length / 2, width / 2, height / 2)
                )
                result.yaw_only.append((inside, expected))
        assert not stored, f"{keyframe['filename']}: stored boxes with no annotation"
    return result


def test_the_full_box_through_the_pose_chain_holds_nuscenes_own_point_count(
    survey: Survey,
) -> None:
    assert survey.annotations > 0
    assert not survey.full_mismatches, (
        f"{len(survey.full_mismatches)} of {survey.annotations}: {survey.full_mismatches[:10]}"
    )


def test_the_stored_yaw_only_cuboid_stays_close_to_nuscenes_own_point_count(
    survey: Survey,
) -> None:
    assert survey.yaw_only
    gap = sum(abs(inside - expected) for inside, expected in survey.yaw_only)
    assert gap / len(survey.yaw_only) <= MAX_MEAN_GAP_YAW_ONLY, (gap, len(survey.yaw_only))


def test_no_box_of_the_mini_split_is_refused_for_tilt(
    survey: Survey, capsys: pytest.CaptureFixture[str]
) -> None:
    refused = sum(
        loss.count
        for loss in survey.dataset.losses
        if loss.kind is ImportLossKind.LABEL and "leaning" in loss.reason
    )
    if survey.versions != (UPRIGHT_SPLIT,):
        with capsys.disabled():
            print(f"\nnuScenes {', '.join(survey.versions)}: {refused} boxes refused for tilt")
        return
    assert refused == 0
    assert len(survey.yaw_only) == survey.annotations


@pytest.fixture(scope="module")
def published(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[Published, Path]]:
    assert NUSCENES is not None
    root = tmp_path_factory.mktemp("nuscenes")
    with WorkspaceService.init(root / "ws") as workspace:
        yield publish(workspace, NuScenesImporter(), NUSCENES), root


def test_the_keyframes_import_as_annotated_scans(
    survey: Survey, published: tuple[Published, Path]
) -> None:
    assert NUSCENES is not None
    release, _ = published
    present = [scan for scan in survey.dataset.scans if (NUSCENES / scan.path).is_file()]
    assets = IngestService(release.workspace).assets(release.project_id)

    assert release.run.batch_id is not None
    assert len(release.run.created_asset_ids) == len(present)
    assert all(asset.modality == "point_cloud" for asset in assets)
    assert all(asset.thumbnail_hash is not None for asset in assets)
    assert all(
        asset.point_cloud is not None and "intensity" in asset.point_cloud.fields
        for asset in assets
    )


def test_the_keyframes_survive_a_kitti_export_with_their_boxes(
    survey: Survey, published: tuple[Published, Path]
) -> None:
    assert NUSCENES is not None
    release, root = published
    dest = root / "kitti"
    release.releases.export(release.release_id, KittiExporter(), dest, allow_lossy=True)
    again = KittiImporter().read(dest)

    present = [scan for scan in survey.dataset.scans if (NUSCENES / scan.path).is_file()]
    assert len(again.scans) == len(present)
    assert sum(len(scan.labels) for scan in again.scans) == sum(
        len(scan.labels) for scan in present
    )


def test_a_grouped_split_keeps_each_scene_in_one_fold_where_a_plain_one_scatters_it(
    survey: Survey, published: tuple[Published, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    """The leak #1147 names, measured: keyframes 0.5 s apart in train, val and test at once."""
    release, _ = published
    assets = IngestService(release.workspace).assets(release.project_id)
    scene_of = {asset.id: asset.group_label for asset in assets}
    scenes = set(scene_of.values())
    assert None not in scenes
    if survey.versions == (UPRIGHT_SPLIT,):
        assert len(scenes) == 10
    dataset_id = ProjectService(release.workspace).get_dataset(release.project_id).id

    straddling: dict[str, int] = {}
    for name, group_by in (("plain", None), ("grouped", SplitGrouping.GROUP_LABEL)):
        recipe = SplitRecipe(train=0.8, val=0.1, test=0.1, seed=0, group_by=group_by)
        published_split = release.releases.publish(dataset_id, f"split-{name}", split=recipe)
        assignment = release.releases.assignment(published_split.id)
        folds_of: dict[str | None, set[str]] = defaultdict(set)
        for fold in ("train", "val", "test"):
            for asset_id in getattr(assignment, fold):
                folds_of[scene_of[asset_id]].add(fold)
        straddling[name] = sum(1 for found in folds_of.values() if len(found) > 1)
        assert release.releases.verify(published_split.id).ok
        assert release.releases.manifest(published_split.id).manifest_version == 6
    with capsys.disabled():
        print(
            f"\nnuScenes {', '.join(survey.versions)}: {len(scenes)} scenes; "
            f"split across folds — per asset {straddling['plain']}, grouped "
            f"{straddling['grouped']}"
        )
    assert straddling["grouped"] == 0
    assert straddling["plain"] > 0
