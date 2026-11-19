# usage: from visionset.formats.voc import VocImporter
"""Pascal VOC in: one ``Annotations/*.xml`` per picture, boxes as 1-based inclusive pixels.

The inverse of :class:`VocExporter`: each document names its picture in
``<filename>``, under ``JPEGImages/``, and each ``<object>`` is a box whose
``xmin``/``xmax`` count pixels from 1 inclusively, so ``<xmin>9</xmin>
<xmax>24</xmax>`` reads back as ``x=8, width=16``. Nothing here touches a
workspace; it returns an ``ImportedDataset``.

What the kernel cannot hold is counted into ``losses`` by kind: a ``pose``,
``truncated``, ``difficult`` or ``occluded`` other than the "not recorded"
values the exporter writes, and any other ``<object>`` child, lose an
attribute; ``<part>`` boxes and a ``segmented`` picture's masks lose geometry
while the box is kept. VOC has no class list, so the classes are those the
objects name, in the order they first appear. A picture under ``JPEGImages/``
that no document names is imported unlabelled. The ``ImageSets`` split is not
imported. A document with a ``DOCTYPE`` or an entity declaration is refused
before it is parsed.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ElementTree
import xml.parsers.expat as expat
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Final

from visionset.formats._reading import (
    IMAGE_SUFFIXES,
    Losses,
    files_under,
    inside,
    number,
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

IMAGES_DIRNAME: Final = "JPEGImages"
ANNOTATIONS_DIRNAME: Final = "Annotations"

_LABEL: Final = "VOC"
_DIMENSION: Final = re.compile(r"[1-9]\d{0,8}", re.ASCII)
_UNRECORDED: Final = {"pose": "Unspecified", "truncated": "0", "difficult": "0", "occluded": "0"}
_READ: Final = frozenset({"name", "bndbox", "part", *_UNRECORDED})
_CORNERS: Final = ("xmin", "ymin", "xmax", "ymax")


class VocImporter:
    """Reads a Pascal VOC dataset into an ``ImportedDataset``."""

    format_name = "voc"

    def read(self, src: Path) -> ImportedDataset:
        if not src.is_dir():
            raise ImportSourceUnreadable(f"the VOC source {src.name!r} is not a directory")
        annotations = src / ANNOTATIONS_DIRNAME
        if not annotations.is_dir():
            raise ImportSourceUnreadable(
                f"the VOC source {src.name!r} has no {ANNOTATIONS_DIRNAME}/ directory"
            )
        documents = files_under(src, annotations, {".xml"})
        if not documents:
            raise ImportSourceUnreadable(
                f"the VOC source {src.name!r} holds no XML under {ANNOTATIONS_DIRNAME}/"
            )
        image_dir = (
            PurePosixPath(IMAGES_DIRNAME) if (src / IMAGES_DIRNAME).is_dir() else PurePosixPath()
        )

        classes: dict[str, None] = {}
        images: dict[PurePosixPath, ImportedImage] = {}
        losses: Losses = Counter()
        for document_path in documents:
            where = relative(src, document_path)
            root = _parse(document_path, where)
            filename = (root.findtext("filename") or "").strip()
            if not filename:
                raise ImportSourceUnreadable(f"{where}: the document has no filename")
            path = image_dir / inside(filename, where)
            if path in images:
                raise ImportSourceUnreadable(
                    f"{where}: picture {str(path)!r} is named by more than one document"
                )
            width, height = _dimension(root, "width"), _dimension(root, "height")
            if (root.findtext("segmented") or "").strip() == "1":
                losses[
                    (
                        ImportLossKind.GEOMETRY,
                        "segmentation",
                        "segmentation masks are not imported; the boxes are kept",
                    )
                ] += 1
            labels = []
            for element in root.findall("object"):
                label = _label(element, where, width, height, losses)
                if label is not None:
                    classes.setdefault(label.class_name)
                    labels.append(label)
            images[path] = ImportedImage(
                path=path, width=width, height=height, labels=tuple(labels)
            )

        if (src / IMAGES_DIRNAME).is_dir():
            for picture in files_under(src, src / IMAGES_DIRNAME, IMAGE_SUFFIXES):
                path = PurePosixPath(relative(src, picture))
                images.setdefault(path, ImportedImage(path=path))

        return to_dataset(
            (ImportedClass(name=name, geometries=(GeometryType.BBOX,)) for name in classes),
            images.values(),
            losses,
            _LABEL,
        )


def _parse(path: Path, where: str) -> ElementTree.Element:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ImportSourceUnreadable(f"{where} could not be read: {exc}") from None
    _refuse_declarations(raw, where)
    try:
        root = ElementTree.fromstring(raw)
    except (ElementTree.ParseError, ValueError, RecursionError) as exc:
        raise ImportSourceUnreadable(f"{where} is not readable XML: {exc}") from None
    if root.tag != "annotation":
        raise ImportSourceUnreadable(f"{where} is not a VOC annotation document")
    return root


class _Declared(Exception):
    pass


def _refuse(*_: object) -> None:
    raise _Declared


def _refuse_declarations(raw: bytes, where: str) -> None:
    """Refuse a ``DOCTYPE`` or an entity declaration, in whatever encoding the document is in.

    A first pass through expat with handlers that raise on either, so the check
    sees what the parser decodes rather than the raw bytes.
    """
    checker = expat.ParserCreate()
    checker.StartDoctypeDeclHandler = _refuse
    checker.EntityDeclHandler = _refuse
    try:
        checker.Parse(raw, True)
    except _Declared:
        raise ImportSourceUnreadable(
            f"{where} declares a DOCTYPE or an entity, which a VOC document never needs"
        ) from None
    except (expat.ExpatError, ValueError, RecursionError) as exc:
        raise ImportSourceUnreadable(f"{where} is not readable XML: {exc}") from None


def _dimension(root: ElementTree.Element, key: str) -> int | None:
    value = (root.findtext(f"size/{key}") or "").strip()
    return int(value) if _DIMENSION.fullmatch(value) else None


def _label(
    element: ElementTree.Element,
    where: str,
    width: int | None,
    height: int | None,
    losses: Losses,
) -> ImportedLabel | None:
    name = (element.findtext("name") or "").strip()
    if not name:
        losses[(ImportLossKind.LABEL, "object", "it has no class name")] += 1
        return None
    bounds = element.find("bndbox")
    corners = [
        number((bounds.findtext(corner) or "").strip(), where) if bounds is not None else None
        for corner in _CORNERS
    ]
    if bounds is None or any(value is None for value in corners):
        losses[(ImportLossKind.LABEL, name, "it has no well-formed bndbox")] += 1
        return None
    xmin, ymin, xmax, ymax = (float(value) for value in corners if value is not None)
    extent_x, extent_y = xmax - xmin + 1, ymax - ymin + 1
    if extent_x <= 0 or extent_y <= 0:
        losses[(ImportLossKind.LABEL, name, "its box has no area")] += 1
        return None
    box = BboxGeometry(x=xmin - 1, y=ymin - 1, width=extent_x, height=extent_y)
    if not geometry_intersects_asset(box, width=width, height=height):
        losses[(ImportLossKind.LABEL, name, "it lies wholly outside its picture")] += 1
        return None

    for tag, unrecorded in _UNRECORDED.items():
        value = (element.findtext(tag) or "").strip()
        if value not in ("", unrecorded):
            losses[(ImportLossKind.ATTRIBUTE, name, f"{tag} is not imported")] += 1
    if element.find("part") is not None:
        losses[(ImportLossKind.GEOMETRY, name, "parts are not imported; the box is kept")] += 1
    for tag in sorted({child.tag for child in element if child.tag not in _READ}):
        losses[(ImportLossKind.ATTRIBUTE, name, f"<{tag[:40]}> is not imported")] += 1
    return ImportedLabel(class_name=name, geometry=box)


__all__ = ["VocImporter"]
