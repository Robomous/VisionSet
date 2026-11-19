# usage: from visionset.formats.lanes import OpenLane2dImporter
"""OpenLane 2D in: lanes as polylines, per-vertex visibility included.

The inverse of :class:`OpenLane2dExporter`: it reads ``labels/**/*.json``, one
document per image, each naming its picture in ``file_path`` relative to the
source and listing ``lane_lines`` whose ``uv`` is a list of ``[u, v]`` points.
Nothing here touches a workspace; it returns an ``ImportedDataset``.

A lane's ``category`` becomes its class, under OpenLane's own category names,
because it is the one label the format has and the domain holds it whole. The
exporter's road edges, ``13`` and ``14``, both read back as ``road_edge``, which
is the class name the exporter resolves to those numbers, so a re-export writes
them again. ``visibility`` maps ``1`` to visible and ``0`` to occluded; the
format has no "unknown", so an import never produces unlabeled.

What the domain cannot hold is counted into ``losses`` by kind: 3D points, a
camera calibration, track ids and a position ``attribute`` that say more than
the exporter's own echo of the lane's order and category, and a visibility array
that is not one ``0`` or ``1`` per point. Upstream OpenLane's column-major
``uv`` (``[[u...], [v...]]``) is a different layout and is refused, not guessed.
"""

from __future__ import annotations

import json
import math
from collections import Counter
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import Any, Final

from pydantic import ValidationError

from visionset.kernel.domain import (
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLoss,
    ImportLossKind,
    PolylineGeometry,
    VertexVisibility,
    require_relative_path,
)
from visionset.kernel.errors import ImportSourceUnreadable

LABELS_DIRNAME: Final = "labels"

#: OpenLane's category integers and their names, plus the exporter's road edges.
#:
#: ``0`` is spelled ``unkown`` upstream; the class is ``unknown``. ``13`` and ``14``
#: are not upstream categories: the exporter writes them for ``road_edge`` (v1's
#: rule), and they read back as that class.
CATEGORY_NAMES: Final[Mapping[int, str]] = {
    0: "unknown",
    1: "white-dash",
    2: "white-solid",
    3: "double-white-dash",
    4: "double-white-solid",
    5: "white-ldash-rsolid",
    6: "white-lsolid-rdash",
    7: "yellow-dash",
    8: "yellow-solid",
    9: "double-yellow-dash",
    10: "double-yellow-solid",
    11: "yellow-ldash-rsolid",
    12: "yellow-lsolid-rdash",
    13: "road_edge",
    14: "road_edge",
    20: "left-curbside",
    21: "right-curbside",
}

_VISIBILITY: Final[Mapping[int, VertexVisibility]] = {
    0: VertexVisibility.OCCLUDED,
    1: VertexVisibility.VISIBLE,
}

_Losses = Counter[tuple[ImportLossKind, str, str]]


class OpenLane2dImporter:
    """Reads an OpenLane 2D dataset into an ``ImportedDataset``."""

    format_name = "openlane-2d"

    def read(self, src: Path) -> ImportedDataset:
        root = src.resolve()
        images: dict[PurePosixPath, list[ImportedLabel]] = {}
        categories: dict[str, int] = {}
        losses: _Losses = Counter()

        for document_path in _label_files(src, root):
            document = _load(document_path)
            name = document_path.relative_to(src).as_posix()
            path = _image_path(document, name)
            if path in images:
                raise ImportSourceUnreadable(
                    f"{name}: image {str(path)!r} is named by more than one label file"
                )
            labels = images[path] = []
            _camera(document, losses)
            for position, lane in enumerate(_lanes(document, name)):
                label = _label(lane, position, name, categories, losses)
                if label is not None:
                    labels.append(label)

        classes = tuple(
            ImportedClass(name=name, geometries=(GeometryType.POLYLINE,))
            for name, _ in sorted(categories.items(), key=lambda item: item[1])
        )
        try:
            return ImportedDataset(
                classes=classes,
                images=tuple(
                    ImportedImage(path=path, labels=tuple(labels))
                    for path, labels in images.items()
                ),
                losses=tuple(
                    ImportLoss(kind=kind, subject=subject, count=count, reason=reason)
                    for (kind, subject, reason), count in losses.items()
                ),
            )
        except ValidationError as exc:
            raise ImportSourceUnreadable(f"the OpenLane dataset is inconsistent: {exc}") from None


def _label_files(src: Path, root: Path) -> list[Path]:
    if not src.is_dir():
        raise ImportSourceUnreadable(f"the OpenLane source {src.name!r} is not a directory")
    labels = src / LABELS_DIRNAME
    if not labels.is_dir():
        raise ImportSourceUnreadable(
            f"the OpenLane source {src.name!r} has no {LABELS_DIRNAME}/ directory"
        )
    found = sorted(path for path in labels.rglob("*.json") if path.is_file())
    if not found:
        raise ImportSourceUnreadable(
            f"the OpenLane source {src.name!r} holds no JSON under {LABELS_DIRNAME}/"
        )
    for path in found:
        if not path.resolve().is_relative_to(root):
            raise ImportSourceUnreadable(
                f"label file {path.relative_to(src).as_posix()!r} resolves outside the source"
            )
    return found


def _refuse_constant(name: str) -> float:
    raise ImportSourceUnreadable(f"the OpenLane file holds the non-finite number {name}")


def _load(path: Path) -> Mapping[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"), parse_constant=_refuse_constant)
    except (OSError, ValueError) as exc:
        raise ImportSourceUnreadable(f"{path.name} is not readable JSON: {exc}") from None
    if not isinstance(document, dict):
        raise ImportSourceUnreadable(f"{path.name} is not an OpenLane document")
    return document


def _image_path(document: Mapping[str, Any], name: str) -> PurePosixPath:
    file_path = document.get("file_path")
    if not isinstance(file_path, str):
        raise ImportSourceUnreadable(f"{name}: the document has no file_path")
    try:
        return require_relative_path(file_path)
    except ValueError as exc:
        raise ImportSourceUnreadable(f"{name}: {exc}") from None


def _lanes(document: Mapping[str, Any], name: str) -> list[Mapping[str, Any]]:
    lanes = document.get("lane_lines", [])
    if not isinstance(lanes, list) or not all(isinstance(lane, dict) for lane in lanes):
        raise ImportSourceUnreadable(f"{name}: 'lane_lines' is not a list of objects")
    for lane in lanes:
        if _column_major(lane.get("uv")):
            raise ImportSourceUnreadable(
                f"{name}: a lane's uv is column-major ([[u...], [v...]]), upstream OpenLane's "
                "layout; this importer reads the [[u, v], ...] points the openlane-2d "
                "exporter writes"
            )
    return lanes


def _column_major(uv: object) -> bool:
    return (
        isinstance(uv, list)
        and len(uv) == 2
        and all(isinstance(row, list) for row in uv)
        and len(uv[0]) == len(uv[1]) != 2
    )


def _camera(document: Mapping[str, Any], losses: _Losses) -> None:
    for key in ("intrinsic", "extrinsic"):
        if document.get(key) not in (None, [], {}):
            losses[(ImportLossKind.ATTRIBUTE, key, "camera calibration is not imported")] += 1


def _label(
    lane: Mapping[str, Any],
    position: int,
    name: str,
    categories: dict[str, int],
    losses: _Losses,
) -> ImportedLabel | None:
    category = lane.get("category", 0)
    if not _is_integer(category):
        losses[(ImportLossKind.LABEL, name, "its category is not an integer")] += 1
        return None
    class_name = CATEGORY_NAMES.get(category, f"category-{category}")

    points = _points(lane.get("uv"))
    if points is None:
        losses[
            (ImportLossKind.LABEL, class_name, "its uv is not a list of two or more [u, v] points")
        ] += 1
        return None
    if len(set(points)) == 1:
        losses[(ImportLossKind.LABEL, class_name, "its points are all the same point")] += 1
        return None

    visibility, usable = _visibility(lane.get("visibility"), len(points))
    if not usable:
        losses[
            (
                ImportLossKind.GEOMETRY,
                class_name,
                "a visibility that is not one 0 or 1 per point is not imported; the lane is kept",
            )
        ] += 1
    if lane.get("xyz") not in (None, []):
        losses[
            (ImportLossKind.GEOMETRY, class_name, "3D points are not imported; the lane is kept")
        ] += 1
    track_id = lane.get("track_id")
    if track_id is not None and track_id != f"lane_{position}":
        losses[(ImportLossKind.ATTRIBUTE, class_name, "track ids are not imported")] += 1
    attribute = lane.get("attribute")
    if attribute is not None and attribute not in (0, category):
        losses[(ImportLossKind.ATTRIBUTE, class_name, "the lane attribute is not imported")] += 1

    categories.setdefault(class_name, category)
    geometry = (
        PolylineGeometry(points=points)
        if visibility is None
        else PolylineGeometry(points=points, visibility=visibility)
    )
    return ImportedLabel(class_name=class_name, geometry=geometry)


def _points(uv: object) -> list[tuple[float, float]] | None:
    if not isinstance(uv, list) or len(uv) < 2:
        return None
    points = []
    for point in uv:
        if not isinstance(point, list) or len(point) != 2 or not all(map(_is_number, point)):
            return None
        points.append((float(point[0]), float(point[1])))
    return points


def _visibility(value: object, count: int) -> tuple[tuple[VertexVisibility, ...] | None, bool]:
    """The vertices' visibility, ``None`` when absent or unusable, and whether it was usable."""
    if value is None:
        return None, True
    if not isinstance(value, list) or len(value) != count:
        return None, False
    states = []
    for flag in value:
        if not _is_number(flag) or flag not in _VISIBILITY:
            return None, False
        states.append(_VISIBILITY[int(flag)])
    return tuple(states), True


def _is_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: object) -> bool:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        raise ImportSourceUnreadable(
            f"the OpenLane file holds a number too large to be a coordinate ({str(value)[:20]}...)"
        ) from None


__all__ = ["CATEGORY_NAMES", "LABELS_DIRNAME", "OpenLane2dImporter"]
