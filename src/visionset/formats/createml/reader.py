# usage: from visionset.formats.createml import CreatemlImporter
"""Create ML object-detection JSON in: centre-based boxes in pixels, one array per folder.

Only the object-detection annotation schema is read: a JSON array of
``{"image": <file name>, "annotations": [{"label": <name>, "coordinates":
{"x", "y", "width", "height"}}]}``, where ``x`` and ``y`` are the box's centre,
in pixels of the picture as a viewer shows it, ``y`` growing downward. Every
``.json`` under the source that is an array holding an object with an
``image`` key is one such document; other JSON files (an export report, a
COCO file) are not read. Other Create ML tasks are not read.

The file names no picture size, so each picture is measured. ``image`` is
resolved against the document's own directory, with ``\\`` read as ``/``; a
name that is absolute, climbs out of the source, or resolves outside it
through a link refuses the import, and so does a named picture that is absent
or unreadable. Nothing here touches a workspace.

A box's top-left corner is its centre less half its extent, rounded to
:data:`PRECISION` decimals to shed float noise, so a box exported with up to
that many decimals reads back exactly. A malformed entry or coordinate, a
non-finite number, and a width or height that is not positive refuse the
source by file. A box with no label, or no pixel inside its picture, is a
``label`` loss; any other non-null key of an entry or annotation is an
``attribute`` loss, and any other key of ``coordinates`` (a rotation, say) a
``geometry`` loss that keeps the box. A picture no
document names is imported unlabelled.
"""

from __future__ import annotations

import json
import math
import posixpath
from collections import Counter
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
    to_dataset,
)
from visionset.kernel.domain import (
    BboxGeometry,
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLossKind,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.errors import ImportSourceUnreadable

#: Above this a document is refused before it is read.
MAX_DOCUMENT_BYTES: Final = 256 * 1024 * 1024

COORDINATES: Final = ("x", "y", "width", "height")
#: Decimal places a box's centre and corner keep: a ten-billionth of a pixel,
#: enough that a box stored with at most this many reads back exactly.
PRECISION: Final = 10

_LABEL: Final = "Create ML"
_ENTRY_KEYS: Final = frozenset({"image", "annotations"})
_ANNOTATION_KEYS: Final = frozenset({"label", "coordinates"})


class CreatemlImporter:
    """Reads a directory holding Create ML object-detection JSON into an ``ImportedDataset``."""

    format_name = "createml"

    def read(self, src: Path) -> ImportedDataset:
        if not src.is_dir():
            raise ImportSourceUnreadable(f"the Create ML source {src.name!r} is not a directory")
        root = src.resolve()
        classes: set[str] = set()
        images: dict[PurePosixPath, ImportedImage] = {}
        losses: Losses = Counter()
        documents = 0
        for document_path in files_under(src, src, {".json"}):
            where = relative(src, document_path)
            entries = _load(document_path, where)
            if entries is None:
                continue
            documents += 1
            directory = document_path.parent.relative_to(src)
            for entry in entries:
                path = _image_path(entry, directory, where)
                if path in images:
                    raise ImportSourceUnreadable(
                        f"{where}: picture {str(path)!r} is named more than once"
                    )
                width, height = _measured(src, root, path, where)
                for key in sorted(set(entry) - _ENTRY_KEYS):
                    if entry[key] is not None:
                        losses[(ImportLossKind.ATTRIBUTE, key[:40], "it is not imported")] += 1
                labels = tuple(
                    label
                    for annotation in _annotations(entry, where)
                    if (label := _label(annotation, where, width, height, losses)) is not None
                )
                classes.update(label.class_name for label in labels)
                images[path] = ImportedImage(path=path, width=width, height=height, labels=labels)
        if documents == 0:
            raise ImportSourceUnreadable(
                f"the Create ML source {src.name!r} holds no Create ML object-detection JSON"
            )

        for picture in files_under(src, src, IMAGE_SUFFIXES):
            path = PurePosixPath(relative(src, picture))
            images.setdefault(path, ImportedImage(path=path))

        return to_dataset(
            (ImportedClass(name=name, geometries=(GeometryType.BBOX,)) for name in sorted(classes)),
            images.values(),
            losses,
            _LABEL,
        )


def _refuse_constant(token: str) -> None:
    raise ValueError(f"the non-finite number {token} is not a coordinate")


def _load(path: Path, where: str) -> list[dict[str, Any]] | None:
    """The document's entries, or ``None`` for JSON that is not a Create ML document."""
    try:
        size = path.stat().st_size
        if size > MAX_DOCUMENT_BYTES:
            raise ImportSourceUnreadable(
                f"{where} is {size} bytes, over the {MAX_DOCUMENT_BYTES} a document may hold"
            )
        document = json.loads(path.read_bytes(), parse_constant=_refuse_constant)
    except (OSError, ValueError, RecursionError) as exc:
        raise ImportSourceUnreadable(f"{where} is not readable JSON: {exc}") from None
    if not isinstance(document, list) or not any(
        isinstance(entry, dict) and "image" in entry for entry in document
    ):
        return None
    if not all(isinstance(entry, dict) for entry in document):
        raise ImportSourceUnreadable(f"{where}: an entry is not an object")
    return document


def _image_path(entry: dict[str, Any], directory: Path, where: str) -> PurePosixPath:
    named = entry.get("image")
    if not isinstance(named, str) or not named.strip():
        raise ImportSourceUnreadable(f"{where}: an entry's image is not a non-empty string")
    text = named.replace("\\", "/")
    if "\x00" in text or PurePosixPath(text).is_absolute() or PureWindowsPath(text).drive:
        raise ImportSourceUnreadable(f"{where}: image {named!r} is absolute")
    joined = posixpath.normpath(posixpath.join(directory.as_posix(), text))
    if joined == ".." or joined.startswith("../"):
        raise ImportSourceUnreadable(f"{where}: image {named!r} leaves the source directory")
    return inside(joined, where)


def _measured(src: Path, root: Path, path: PurePosixPath, where: str) -> tuple[int, int]:
    linked = src / path
    if not (linked.exists() or linked.is_symlink()):
        raise ImportSourceUnreadable(
            f"{where}: picture {str(path)!r} is not in the source, and Create ML JSON "
            "records no size to read its boxes against"
        )
    contained(src, root, linked)
    size = measure(linked) if linked.is_file() else None
    if size is None:
        raise ImportSourceUnreadable(f"{where}: picture {str(path)!r} is not a readable picture")
    return size


def _annotations(entry: dict[str, Any], where: str) -> list[dict[str, Any]]:
    annotations = entry.get("annotations")
    if annotations is None:
        return []
    if not isinstance(annotations, list) or not all(
        isinstance(annotation, dict) for annotation in annotations
    ):
        raise ImportSourceUnreadable(f"{where}: annotations is not a list of objects")
    return annotations


def _label(
    annotation: dict[str, Any],
    where: str,
    width: int,
    height: int,
    losses: Losses,
) -> ImportedLabel | None:
    name = annotation.get("label")
    if name is not None and not isinstance(name, str):
        raise ImportSourceUnreadable(f"{where}: an annotation's label is not a string")
    geometry = _box(annotation.get("coordinates"), where)
    if not name or not name.strip():
        losses[(ImportLossKind.LABEL, "annotation", "it has no label")] += 1
        return None
    name = name.strip()
    for key in sorted(set(annotation) - _ANNOTATION_KEYS):
        if annotation[key] is not None:
            losses[(ImportLossKind.ATTRIBUTE, name, f"{key[:40]} is not imported")] += 1
    for key in sorted(set(annotation["coordinates"]) - set(COORDINATES)):
        reason = f"coordinates.{key[:40]} is not imported; the box is kept"
        losses[(ImportLossKind.GEOMETRY, name, reason)] += 1
    if not geometry_intersects_asset(geometry, width=width, height=height):
        losses[(ImportLossKind.LABEL, name, "it lies wholly outside its picture")] += 1
        return None
    return ImportedLabel(class_name=name, geometry=geometry)


def _box(coordinates: object, where: str) -> BboxGeometry:
    if not isinstance(coordinates, dict):
        raise ImportSourceUnreadable(f"{where}: an annotation's coordinates is not an object")
    values: dict[str, float] = {}
    for key in COORDINATES:
        value = coordinates.get(key)
        if not isinstance(value, int | float) or isinstance(value, bool):
            raise ImportSourceUnreadable(f"{where}: coordinate {key!r} is not a number")
        if not math.isfinite(value):
            raise ImportSourceUnreadable(f"{where} holds a non-finite coordinate")
        values[key] = float(value)
    if values["width"] <= 0 or values["height"] <= 0:
        raise ImportSourceUnreadable(
            f"{where}: a box is {values['width']:g} by {values['height']:g}; "
            "its width and height must be positive"
        )
    return BboxGeometry(
        x=_corner(values["x"], values["width"]),
        y=_corner(values["y"], values["height"]),
        width=values["width"],
        height=values["height"],
    )


def _corner(centre: float, extent: float) -> float:
    return round(centre - extent / 2, PRECISION) + 0.0


__all__ = ["COORDINATES", "PRECISION", "CreatemlImporter"]
