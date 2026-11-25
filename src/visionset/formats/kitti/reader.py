"""KITTI 3D object detection in: lidar scans with their boxes, moved into the lidar frame.

A split directory holds ``velodyne/<id>.bin`` (headerless float32 ``x, y, z,
reflectance``), ``label_2/<id>.txt`` and ``calib/<id>.txt``. The source is one
split directory, or a directory whose immediate subdirectories (``training``,
``testing``) are. Nothing here touches a workspace; it returns an
``ImportedDataset`` of scans in the ``lidar_flu`` frame.

A label is in the rectified camera frame, so each box is converted into the
scan's frame with its frame's calibration (see :mod:`.frames`), an explicit
conversion the loss report names. What the domain cannot hold is counted into
``losses``: ``DontCare`` regions, the 2D image box, truncation, occlusion and
alpha, the camera calibration itself, and any label that cannot be placed.
A scan with no label file is imported unlabelled, as KITTI's testing split is.
"""

from __future__ import annotations

import math
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Final

from pydantic import ValidationError

from visionset.formats._reading import files_under, number, read_text, relative
from visionset.formats._tilt import TILT_TOLERANCE
from visionset.formats.kitti.frames import CameraToLidar, Matrix, Vector, camera_box_to_lidar
from visionset.kernel.domain import (
    Cuboid3DGeometry,
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedLabel,
    ImportedScan,
    ImportLoss,
    ImportLossKind,
    ScanFrame,
    ScanLayout,
)
from visionset.kernel.errors import ImportSourceUnreadable

VELODYNE_DIRNAME: Final = "velodyne"
LABELS_DIRNAME: Final = "label_2"
CALIB_DIRNAME: Final = "calib"

LAYOUT: Final = ScanLayout(fields=("x", "y", "z", "intensity"))

#: KITTI's object classes, in the devkit's order; any other name follows them.
CLASS_ORDER: Final = (
    "Car",
    "Van",
    "Truck",
    "Pedestrian",
    "Person_sitting",
    "Cyclist",
    "Tram",
    "Misc",
)

DONT_CARE: Final = "DontCare"

_RECT_KEYS: Final = ("R0_rect", "R_rect")
_VELO_KEYS: Final = ("Tr_velo_to_cam", "Tr_velo_cam")
_FIELDS: Final = 15

_Losses = Counter[tuple[ImportLossKind, str, str]]


class KittiImporter:
    """Reads a KITTI 3D object detection split into an ``ImportedDataset`` of scans."""

    format_name = "kitti"

    def read(self, src: Path) -> ImportedDataset:
        losses: _Losses = Counter()
        scans: list[ImportedScan] = []
        used: set[str] = set()
        for split in _splits(src):
            scans.extend(_read_split(src, split, used, losses))
        classes = tuple(
            ImportedClass(name=name, geometries=(GeometryType.CUBOID_3D,))
            for name in _ordered(used)
        )
        try:
            return ImportedDataset(
                classes=classes,
                scans=tuple(scans),
                frame=ScanFrame.LIDAR_FLU,
                losses=tuple(
                    ImportLoss(kind=kind, subject=subject, count=count, reason=reason)
                    for (kind, subject, reason), count in losses.items()
                ),
            )
        except ValidationError as exc:
            raise ImportSourceUnreadable(f"the KITTI dataset is inconsistent: {exc}") from None


def _splits(src: Path) -> list[Path]:
    if (src / VELODYNE_DIRNAME).is_dir():
        return [src]
    found = sorted(
        child
        for child in src.iterdir()
        if child.is_dir() and not child.is_symlink() and (child / VELODYNE_DIRNAME).is_dir()
    )
    if not found:
        raise ImportSourceUnreadable(
            f"no {VELODYNE_DIRNAME}/ directory at the top of the source or one level down; "
            "a KITTI split holds velodyne/, label_2/ and calib/"
        )
    return found


def _read_split(src: Path, split: Path, used: set[str], losses: _Losses) -> list[ImportedScan]:
    velodyne = split / VELODYNE_DIRNAME
    labels_dir = split / LABELS_DIRNAME
    scans: list[ImportedScan] = []
    frames: set[str] = set()
    for path in files_under(src, velodyne, [".bin"]):
        frame_id = path.relative_to(velodyne).with_suffix("").as_posix()
        frames.add(frame_id)
        _require_whole_points(src, path)
        label_path = labels_dir / f"{frame_id}.txt"
        calib_path = split / CALIB_DIRNAME / f"{frame_id}.txt"
        transform: CameraToLidar | str | None = None
        if calib_path.is_file():
            transform = _calibration(src, calib_path)
            losses[
                (
                    ImportLossKind.ATTRIBUTE,
                    "calib",
                    "the camera projections and the lidar-to-camera transform are not "
                    "stored; each label is moved into the lidar frame with R0_rect and "
                    "Tr_velo_to_cam",
                )
            ] += 1
        labels: list[ImportedLabel] = []
        if label_path.is_file():
            if transform is None:
                transform = f"{relative(src, calib_path)} is missing"
            for line in _lines(src, label_path):
                label = _label(line, transform, losses)
                if label is not None:
                    labels.append(label)
                    used.add(label.class_name)
        scans.append(
            ImportedScan(
                path=PurePosixPath(relative(src, path)), layout=LAYOUT, labels=tuple(labels)
            )
        )
    if labels_dir.is_dir():
        for label_path in files_under(src, labels_dir, [".txt"]):
            frame_id = label_path.relative_to(labels_dir).with_suffix("").as_posix()
            if frame_id in frames:
                continue
            for line in _lines(src, label_path):
                losses[
                    (
                        ImportLossKind.LABEL,
                        line.split()[0],
                        f"its label file has no {VELODYNE_DIRNAME} scan",
                    )
                ] += 1
    return scans


def _require_whole_points(src: Path, path: Path) -> None:
    size = path.stat().st_size
    if size == 0 or size % LAYOUT.record_size:
        raise ImportSourceUnreadable(
            f"{relative(src, path)} is {size} bytes, which is not a whole number of "
            f"{LAYOUT.record_size}-byte points"
        )


def _lines(src: Path, path: Path) -> list[str]:
    return [line for line in read_text(path, relative(src, path)).splitlines() if line.strip()]


def _label(line: str, transform: CameraToLidar | str, losses: _Losses) -> ImportedLabel | None:
    tokens = line.split()
    name = tokens[0]
    if name == DONT_CARE:
        losses[
            (
                ImportLossKind.LABEL,
                name,
                "a DontCare region marks an area left unlabelled, which no geometry holds",
            )
        ] += 1
        return None
    values = [number(token, name) for token in tokens[1:]]
    if len(tokens) not in (_FIELDS, _FIELDS + 1) or any(value is None for value in values):
        losses[(ImportLossKind.LABEL, name, "a malformed label line")] += 1
        return None
    numbers = [value for value in values if value is not None]
    height, width, length = numbers[7:10]
    if min(height, width, length) <= 0:
        losses[(ImportLossKind.LABEL, name, "a box dimension that is not positive")] += 1
        return None
    if isinstance(transform, str):
        losses[(ImportLossKind.LABEL, name, f"{transform}, so the box cannot be placed")] += 1
        return None
    if transform.tilt > TILT_TOLERANCE:
        losses[
            (
                ImportLossKind.LABEL,
                name,
                f"a calibration whose camera up leans more than "
                f"{math.degrees(TILT_TOLERANCE):g} degrees from the lidar's up axis; a "
                "cuboid has no pitch or roll, so the box is not flattened",
            )
        ] += 1
        return None
    box = camera_box_to_lidar(
        (numbers[10], numbers[11], numbers[12]), (height, width, length), numbers[13], transform
    )
    if min(box.size) <= 0:
        losses[(ImportLossKind.LABEL, name, "a box under a micrometre across")] += 1
        return None
    confidence = None
    if len(numbers) > _FIELDS - 1:
        score = numbers[_FIELDS - 1]
        if 0.0 <= score <= 1.0:
            confidence = score
        else:
            losses[(ImportLossKind.ATTRIBUTE, name, "a score outside 0 to 1")] += 1
    losses[
        (
            ImportLossKind.GEOMETRY,
            name,
            "its 2D box in the camera image (bbox) is not kept; a scan has no pixels",
        )
    ] += 1
    losses[
        (
            ImportLossKind.ATTRIBUTE,
            name,
            "KITTI truncated, occluded and alpha are not carried",
        )
    ] += 1
    return ImportedLabel(
        class_name=name,
        geometry=Cuboid3DGeometry(center=box.center, size=box.size, yaw=box.yaw),
        confidence=confidence,
    )


def _calibration(src: Path, path: Path) -> CameraToLidar | str:
    where = relative(src, path)
    entries: dict[str, list[float]] = {}
    for line in _lines(src, path):
        key, separator, rest = line.partition(":")
        if not separator:
            raise ImportSourceUnreadable(f"{where}: a line is not 'KEY: values'")
        parsed = [number(token, where) for token in rest.split()]
        if any(value is None for value in parsed):
            raise ImportSourceUnreadable(
                f"{where}: {key.strip()} holds a value that is not a number"
            )
        entries[key.strip()] = [value for value in parsed if value is not None]
    rect = next((entries[key] for key in _RECT_KEYS if key in entries), None)
    velo = next((entries[key] for key in _VELO_KEYS if key in entries), None)
    if rect is None or velo is None or len(rect) != 9 or len(velo) != 12:
        return f"{where} has no 3x3 R0_rect and 3x4 Tr_velo_to_cam"
    rotation: Matrix = (
        (velo[0], velo[1], velo[2]),
        (velo[4], velo[5], velo[6]),
        (velo[8], velo[9], velo[10]),
    )
    translation: Vector = (velo[3], velo[7], velo[11])
    r0: Matrix = (
        (rect[0], rect[1], rect[2]),
        (rect[3], rect[4], rect[5]),
        (rect[6], rect[7], rect[8]),
    )
    try:
        return CameraToLidar.of(r0, rotation, translation)
    except ValueError:
        return f"{where} holds a transform that cannot be inverted"


def _ordered(names: set[str]) -> list[str]:
    known = [name for name in CLASS_ORDER if name in names]
    return known + sorted(names - set(CLASS_ORDER))
