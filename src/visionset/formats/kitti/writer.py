"""KITTI 3D object detection out: scans and their boxes, with a canonical calibration.

Each scan of the release is one frame of a split directory per fold,
``<fold>/velodyne/<content-hash>.bin``, ``<fold>/label_2/<content-hash>.txt``
and ``<fold>/calib/<content-hash>.txt``, the layout the importer reads back.

A box is stored in its scan's declared frame and KITTI writes it in a camera
frame, so the writer converts it with one fixed calibration,
:data:`~visionset.formats.kitti.frames.CANONICAL`, and writes that same
calibration beside every frame. The boxes agree with the calibration shipped
beside them, and the importer returns them; they are not in the original
sensor's camera frame, which a release does not hold. A scan in ``lidar_rfu``
or ``camera_rdf`` is turned into ``lidar_flu`` first, points and boxes alike,
because a KITTI ``.bin`` is in the lidar's forward-left-up axes.

There is no image, so ``P0`` to ``P3`` are ``[I | 0]`` and ``Tr_imu_to_velo``
the identity: placeholders a reader indexing the calibration by line finds
where it expects them. In ``label_2``, the 2D box is zeros, truncation is 0,
occlusion 3 (unknown) and alpha is derived from the location and
``rotation_y``. A confidence is written as the 16th column, a score.

``lossy`` because a ``polyline_3d``, a classification tag, attributes,
provenance and ids have nowhere to go; only ``cuboid_3d`` is written, and only
from scans. A class name is KITTI's first token, so whitespace inside one is
written as ``_``.
"""

from __future__ import annotations

import math
import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Final

from visionset.formats._layout import folds_of
from visionset.formats._targets import self_target
from visionset.formats.kitti.frames import (
    CANONICAL,
    IDENTITY,
    CameraBox,
    LidarBox,
    LidarToCamera,
    lidar_box_to_camera,
    to_lidar_flu,
)
from visionset.formats.kitti.pcd import ScanUnreadable, kitti_points
from visionset.formats.kitti.reader import CALIB_DIRNAME, LABELS_DIRNAME, VELODYNE_DIRNAME
from visionset.kernel.domain import (
    Cuboid3DGeometry,
    GeometryType,
    Manifest,
    ManifestAsset,
    Release,
    ScanFrame,
    SplitAssignment,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

#: ``P0`` to ``P3``: no camera image ships, so each projection is ``[I | 0]``.
PLACEHOLDER_PROJECTION: Final = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0)

#: KITTI's "unknown" occlusion level.
OCCLUSION_UNKNOWN: Final = 3

_WHITESPACE: Final = re.compile(r"\s+")
_ANGLE_DECIMALS: Final = 6
_METRE_DECIMALS: Final = 6


class KittiExporter:
    """Writes a release's scans and their cuboids as a KITTI 3D object detection split."""

    format_name = "kitti"

    lossy = True

    supported_geometries = frozenset({GeometryType.CUBOID_3D})

    degraded_geometries: frozenset[GeometryType] = frozenset()

    supported_modalities = frozenset({"point_cloud"})

    targets = self_target(format_name, supported_geometries)

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
        assignment: SplitAssignment | None,
    ) -> None:
        names = class_tokens(one.name for one in manifest.classes)
        folds = folds_of(manifest, assignment)
        calib = calibration_text(CANONICAL)
        for asset in manifest.assets:
            if asset.modality != "point_cloud" or asset.frame is None:
                continue
            split = dest / folds[asset.asset_id]
            for name in (VELODYNE_DIRNAME, LABELS_DIRNAME, CALIB_DIRNAME):
                (split / name).mkdir(parents=True, exist_ok=True)
            stem = asset.content_hash
            (split / VELODYNE_DIRNAME / f"{stem}.bin").write_bytes(
                _scan_bytes(asset, asset.frame, content)
            )
            lines = []
            for one in asset.annotations:
                if not isinstance(one.geometry, Cuboid3DGeometry):
                    continue
                if one.label_class not in names:
                    raise ExportSourceUnreadable(
                        f"asset {asset.asset_id} carries a {one.label_class!r} label the "
                        "release's classes do not declare"
                    )
                box = camera_box(one.geometry, asset.frame)
                lines.append(f"{label_line(names[one.label_class], box, one.confidence)}\n")
            (split / LABELS_DIRNAME / f"{stem}.txt").write_text("".join(lines), encoding="utf-8")
            (split / CALIB_DIRNAME / f"{stem}.txt").write_text(calib, encoding="utf-8")


def class_tokens(names: Iterable[str]) -> dict[str, str]:
    """Each class name as KITTI's single-token ``type``, refusing two that would merge.

    Raises:
        ExportSourceUnreadable: two class names differ only in their whitespace.
    """
    tokens: dict[str, str] = {}
    taken: dict[str, str] = {}
    for name in names:
        token = _WHITESPACE.sub("_", name)
        other = taken.setdefault(token, name)
        if other != name:
            raise ExportSourceUnreadable(
                f"classes {other!r} and {name!r} would both be written as KITTI type {token!r}"
            )
        tokens[name] = token
    return tokens


def camera_box(geometry: Cuboid3DGeometry, frame: ScanFrame) -> CameraBox:
    """One scan cuboid in the canonical calibration's camera frame."""
    box = LidarBox(
        center=to_lidar_flu(geometry.center, frame), size=geometry.size, yaw=geometry.yaw
    )
    return lidar_box_to_camera(box, CANONICAL)


def label_line(token: str, box: CameraBox, confidence: float | None) -> str:
    """One ``label_2`` line: 15 columns, and the score as a 16th when there is one."""
    x, y, z = box.location
    height, width, length = box.dimensions_hwl
    alpha = _wrapped(box.rotation_y - math.atan2(x, z))
    columns = [
        token,
        "0.00",
        str(OCCLUSION_UNKNOWN),
        _angle(alpha),
        "0.00",
        "0.00",
        "0.00",
        "0.00",
        *(_metres(value) for value in (height, width, length, x, y, z)),
        _angle(_wrapped(box.rotation_y)),
    ]
    if confidence is not None:
        columns.append(f"{confidence:.6f}")
    return " ".join(columns)


def calibration_text(transform: LidarToCamera) -> str:
    """A ``calib`` file in KITTI's line order, carrying ``transform``."""
    (r0, r1, r2), t = transform.rotation, transform.translation
    velo = (*r0, t[0], *r1, t[1], *r2, t[2])
    rect = tuple(value for row in transform.rect for value in row)
    imu = (*IDENTITY[0], 0.0, *IDENTITY[1], 0.0, *IDENTITY[2], 0.0)
    rows = [
        *((f"P{index}", PLACEHOLDER_PROJECTION) for index in range(4)),
        ("R0_rect", rect),
        ("Tr_velo_to_cam", velo),
        ("Tr_imu_to_velo", imu),
    ]
    return "".join(
        f"{key}: {' '.join(f'{value + 0.0:.12e}' for value in values)}\n" for key, values in rows
    )


def _scan_bytes(asset: ManifestAsset, frame: ScanFrame, content: ContentReader) -> bytes:
    with content(asset.content_hash) as stream:
        blob = stream.read()
    try:
        points = kitti_points(blob)
    except ScanUnreadable as exc:
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} ({asset.content_hash}) cannot be written as a KITTI scan: "
            f"{exc}"
        ) from None
    if frame is not ScanFrame.LIDAR_FLU:
        for start in range(0, len(points), 4):
            x, y, z = to_lidar_flu((points[start], points[start + 1], points[start + 2]), frame)
            points[start], points[start + 1], points[start + 2] = x, y, z
    if sys.byteorder == "big":
        points.byteswap()
    return points.tobytes()


def _wrapped(angle: float) -> float:
    while angle > math.pi:
        angle -= 2 * math.pi
    while angle < -math.pi:
        angle += 2 * math.pi
    return angle


def _angle(value: float) -> str:
    return f"{round(value, _ANGLE_DECIMALS) + 0.0:.{_ANGLE_DECIMALS}f}"


def _metres(value: float) -> str:
    return f"{round(value, _METRE_DECIMALS) + 0.0:.{_METRE_DECIMALS}f}"
