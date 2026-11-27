# usage: from visionset.formats.labelme import LabelmeImporter
"""LabelMe JSON in: one document per picture, rectangles and polygons in pixels.

Every ``.json`` under the source that is an object holding ``shapes`` is one
LabelMe document; other JSON files (an export report, a COCO file) are not
read. ``imagePath`` is resolved against the document's own directory, as
LabelMe writes it, with ``\\`` read as ``/``; a path that is absolute or climbs
out of the source refuses the import, and a link resolving outside it is
refused here or by the import. Nothing here touches a workspace.

A ``rectangle`` is two points, any two opposite corners, and a ``polygon`` at
least three; coordinates are read as written, never rounded or normalized. A
shape with no ``shape_type`` is a polygon, LabelMe's own default. Every other
shape type (``circle``, ``line``, ``linestrip``, ``point``, ``points``,
``mask``, anything else) is a ``label`` loss, as are a shape with an empty
label, a wrong number of points, no area, or no pixel inside its picture.

A shape's ``flags`` become boolean attributes of the same name and a non-empty
``description`` a string attribute ``description``; a non-null ``group_id``, a
flag that is not a boolean or is named ``description``, the picture's own
``flags`` set true and any other non-null key are ``attribute`` losses.

An embedded ``imageData`` is decoded strictly, bounded in size, and must be a
picture of ``imageWidth`` by ``imageHeight`` or the import is refused. The
pixels are read from the linked file; a picture held only as ``imageData`` is an
``image`` loss. A linked file that is absent is reported by the import. A
picture no document names is imported unlabelled.
"""

from __future__ import annotations

import base64
import binascii
import json
import math
import posixpath
from collections import Counter
from io import BytesIO
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Final

from visionset.formats._reading import (
    IMAGE_SUFFIXES,
    Losses,
    contained,
    files_under,
    inside,
    measure,
    relative,
    shoelace,
    to_dataset,
)
from visionset.kernel.domain import (
    BboxGeometry,
    Geometry,
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLossKind,
    PolygonGeometry,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.domain.schema import Attribute, AttributeValue
from visionset.kernel.errors import ImportSourceUnreadable

#: Above this a document is refused before it is read.
MAX_DOCUMENT_BYTES: Final = 128 * 1024 * 1024
#: Above this many base64 characters an ``imageData`` is refused undecoded.
MAX_IMAGE_DATA_CHARS: Final = 64 * 1024 * 1024

DESCRIPTION: Final = "description"
SHAPE_TYPES: Final[dict[str, GeometryType]] = {
    "rectangle": GeometryType.BBOX,
    "polygon": GeometryType.POLYGON,
}

_LABEL: Final = "LabelMe"
_DOCUMENT_KEYS: Final = frozenset(
    {"version", "flags", "shapes", "imagePath", "imageData", "imageHeight", "imageWidth"}
)
_SHAPE_KEYS: Final = frozenset(
    {"label", "points", "shape_type", "flags", "group_id", DESCRIPTION, "mask"}
)
_DEGENERATE_AREA: Final = 1e-9
_EMBEDDED_ONLY: Final = (
    "the picture is held only as embedded imageData, which is not imported; "
    "its {count} label(s) would be lost"
)


class LabelmeImporter:
    """Reads a directory of LabelMe JSON documents into an ``ImportedDataset``."""

    format_name = "labelme"

    def read(self, src: Path) -> ImportedDataset:
        if not src.is_dir():
            raise ImportSourceUnreadable(f"the LabelMe source {src.name!r} is not a directory")
        root = src.resolve()
        classes: dict[str, set[GeometryType]] = {}
        definitions: dict[str, dict[str, Attribute]] = {}
        images: dict[PurePosixPath, ImportedImage] = {}
        losses: Losses = Counter()
        documents = 0
        for document_path in files_under(src, src, {".json"}):
            where = relative(src, document_path)
            document = _load(document_path, where)
            if document is None:
                continue
            documents += 1
            path = _image_path(document, document_path.parent.relative_to(src), where)
            if path in images:
                raise ImportSourceUnreadable(
                    f"{where}: picture {str(path)!r} is named by more than one document"
                )
            width = _dimension(document, "imageWidth", where)
            height = _dimension(document, "imageHeight", where)
            embedded = _embedded(document.get("imageData"), where, width, height)
            if embedded is not None:
                width, height = embedded
            _document_losses(document, losses)
            labels = [
                label
                for shape in _shapes(document, where)
                if (label := _label(shape, where, width, height, losses)) is not None
            ]
            linked = src / path
            if linked.exists() or linked.is_symlink():
                contained(src, root, linked)
            elif embedded is not None:
                reason = _EMBEDDED_ONLY.format(count=len(labels))
                losses[(ImportLossKind.IMAGE, str(path), reason)] += 1
                continue
            for label in labels:
                classes.setdefault(label.class_name, set()).add(GeometryType(label.geometry.type))
                owned = definitions.setdefault(label.class_name, {})
                for name, value in label.attributes.items():
                    owned.setdefault(
                        name,
                        Attribute(
                            name=name, kind="boolean" if isinstance(value, bool) else "string"
                        ),
                    )
            images[path] = ImportedImage(
                path=path, width=width, height=height, labels=tuple(labels)
            )
        if documents == 0:
            raise ImportSourceUnreadable(f"the LabelMe source {src.name!r} holds no LabelMe JSON")

        for picture in files_under(src, src, IMAGE_SUFFIXES):
            path = PurePosixPath(relative(src, picture))
            images.setdefault(path, ImportedImage(path=path))

        return to_dataset(
            (
                ImportedClass(
                    name=name,
                    geometries=tuple(geometries),
                    attributes=tuple(definitions.get(name, {}).values()),
                )
                for name, geometries in classes.items()
            ),
            images.values(),
            losses,
            _LABEL,
        )


def _refuse_constant(token: str) -> None:
    raise ValueError(f"the non-finite number {token} is not a coordinate")


def _load(path: Path, where: str) -> dict[str, Any] | None:
    """The document, or ``None`` for JSON that is not a LabelMe document."""
    try:
        size = path.stat().st_size
        if size > MAX_DOCUMENT_BYTES:
            raise ImportSourceUnreadable(
                f"{where} is {size} bytes, over the {MAX_DOCUMENT_BYTES} a document may hold"
            )
        document = json.loads(path.read_bytes(), parse_constant=_refuse_constant)
    except (OSError, ValueError, RecursionError) as exc:
        raise ImportSourceUnreadable(f"{where} is not readable JSON: {exc}") from None
    if not isinstance(document, dict) or "shapes" not in document:
        return None
    return document


def _image_path(document: dict[str, Any], directory: Path, where: str) -> PurePosixPath:
    named = document.get("imagePath")
    if not isinstance(named, str) or not named.strip():
        raise ImportSourceUnreadable(f"{where}: imagePath is not a non-empty string")
    text = named.replace("\\", "/")
    if "\x00" in text or PurePosixPath(text).is_absolute() or PureWindowsPath(text).drive:
        raise ImportSourceUnreadable(f"{where}: imagePath {named!r} is absolute")
    joined = posixpath.normpath(posixpath.join(directory.as_posix(), text))
    if joined == ".." or joined.startswith("../"):
        raise ImportSourceUnreadable(f"{where}: imagePath {named!r} leaves the source directory")
    return inside(joined, where)


def _dimension(document: dict[str, Any], key: str, where: str) -> int | None:
    value = document.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ImportSourceUnreadable(f"{where}: {key} is not a positive integer")
    return value


def _embedded(
    data: object, where: str, width: int | None, height: int | None
) -> tuple[int, int] | None:
    """The size of the picture ``imageData`` holds, or ``None`` when there is none."""
    if data is None or data == "":
        return None
    if not isinstance(data, str):
        raise ImportSourceUnreadable(f"{where}: imageData is not a base64 string")
    if len(data) > MAX_IMAGE_DATA_CHARS:
        raise ImportSourceUnreadable(
            f"{where}: imageData is {len(data)} characters, over the "
            f"{MAX_IMAGE_DATA_CHARS} an embedded picture may hold"
        )
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise ImportSourceUnreadable(f"{where}: imageData is not valid base64") from None
    size = measure(BytesIO(raw))
    if size is None or not _verified(raw):
        raise ImportSourceUnreadable(f"{where}: imageData is not a picture that can be read")
    if (width is not None and width != size[0]) or (height is not None and height != size[1]):
        raise ImportSourceUnreadable(
            f"{where}: imageData is {size[0]}x{size[1]}, but imageWidth and imageHeight "
            f"say {width}x{height}"
        )
    return size


def _verified(raw: bytes) -> bool:
    from PIL import Image

    try:
        with Image.open(BytesIO(raw)) as image:
            image.verify()
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        return False
    return True


def _document_losses(document: dict[str, Any], losses: Losses) -> None:
    flags = document.get("flags")
    if (isinstance(flags, dict) and any(value is not False for value in flags.values())) or (
        flags is not None and not isinstance(flags, dict)
    ):
        losses[(ImportLossKind.ATTRIBUTE, "flags", "picture flags are not imported")] += 1
    for key in sorted(set(document) - _DOCUMENT_KEYS):
        if document[key] is not None:
            losses[(ImportLossKind.ATTRIBUTE, key[:40], "it is not imported")] += 1


def _shapes(document: dict[str, Any], where: str) -> list[dict[str, Any]]:
    shapes = document["shapes"]
    if not isinstance(shapes, list) or not all(isinstance(shape, dict) for shape in shapes):
        raise ImportSourceUnreadable(f"{where}: shapes is not a list of objects")
    return shapes


def _label(
    shape: dict[str, Any],
    where: str,
    width: int | None,
    height: int | None,
    losses: Losses,
) -> ImportedLabel | None:
    name = shape.get("label")
    if name is not None and not isinstance(name, str):
        raise ImportSourceUnreadable(f"{where}: a shape's label is not a string")
    if not name or not name.strip():
        losses[(ImportLossKind.LABEL, "shape", "it has no label")] += 1
        return None
    name = name.strip()
    shape_type = shape.get("shape_type")
    if shape_type is None:
        shape_type = "polygon"
    if not isinstance(shape_type, str):
        raise ImportSourceUnreadable(f"{where}: a shape's shape_type is not a string")
    if shape_type not in SHAPE_TYPES:
        reason = f"{shape_type[:40]!r} shapes are not imported"
        losses[(ImportLossKind.LABEL, name, reason)] += 1
        return None
    points = _points(shape.get("points"), where)
    geometry = _geometry(shape_type, points, name, losses)
    if geometry is None:
        return None
    if not geometry_intersects_asset(geometry, width=width, height=height):
        losses[(ImportLossKind.LABEL, name, "it lies wholly outside its picture")] += 1
        return None
    return ImportedLabel(
        class_name=name, geometry=geometry, attributes=_attributes(shape, name, losses)
    )


def _points(value: object, where: str) -> list[tuple[float, float]]:
    if not isinstance(value, list):
        raise ImportSourceUnreadable(f"{where}: a shape's points is not a list")
    points: list[tuple[float, float]] = []
    for point in value:
        if (
            not isinstance(point, list)
            or len(point) != 2
            or not all(isinstance(one, int | float) and not isinstance(one, bool) for one in point)
        ):
            raise ImportSourceUnreadable(f"{where}: a point is not a pair of numbers")
        x, y = float(point[0]), float(point[1])
        if not (math.isfinite(x) and math.isfinite(y)):
            raise ImportSourceUnreadable(f"{where} holds a non-finite coordinate")
        points.append((x, y))
    return points


def _geometry(
    shape_type: str, points: list[tuple[float, float]], name: str, losses: Losses
) -> Geometry | None:
    if shape_type == "rectangle":
        if len(points) != 2:
            losses[(ImportLossKind.LABEL, name, "a rectangle is not two points")] += 1
            return None
        (x1, y1), (x2, y2) = points
        if x1 == x2 or y1 == y2:
            losses[(ImportLossKind.LABEL, name, "its rectangle has no area")] += 1
            return None
        return BboxGeometry(x=min(x1, x2), y=min(y1, y2), width=abs(x2 - x1), height=abs(y2 - y1))
    if len(points) < 3:
        losses[(ImportLossKind.LABEL, name, "a polygon has fewer than three points")] += 1
        return None
    if shoelace(points) < _DEGENERATE_AREA:
        losses[(ImportLossKind.LABEL, name, "its polygon has no area")] += 1
        return None
    return PolygonGeometry(points=points)


def _attributes(shape: dict[str, Any], name: str, losses: Losses) -> dict[str, AttributeValue]:
    values: dict[str, AttributeValue] = {}
    flags = shape.get("flags")
    if isinstance(flags, dict):
        for key, value in flags.items():
            stripped = key.strip()
            if not isinstance(value, bool) or not stripped or stripped == DESCRIPTION:
                losses[(ImportLossKind.ATTRIBUTE, name, "a flag that is not imported")] += 1
                continue
            values[stripped] = value
    elif flags is not None:
        losses[(ImportLossKind.ATTRIBUTE, name, "flags is not an object")] += 1
    description = shape.get(DESCRIPTION)
    if isinstance(description, str):
        if description:
            values[DESCRIPTION] = description
    elif description is not None:
        losses[(ImportLossKind.ATTRIBUTE, name, "description is not a string")] += 1
    if shape.get("group_id") is not None:
        losses[(ImportLossKind.ATTRIBUTE, name, "group_id is not imported")] += 1
    for key in sorted(set(shape) - _SHAPE_KEYS):
        if shape[key] is not None:
            losses[(ImportLossKind.ATTRIBUTE, name, f"{key[:40]} is not imported")] += 1
    if shape.get("mask") is not None:
        losses[(ImportLossKind.ATTRIBUTE, name, "mask is not imported")] += 1
    return values


__all__ = ["LabelmeImporter"]
