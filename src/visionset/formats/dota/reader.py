# usage: from visionset.formats.dota import DotaImporter
"""DOTA in: pictures under ``images/`` and their ``labelTxt/`` rows of pixel corners.

The inverse of :class:`DotaExporter`. Pictures are found under any directory
named ``images`` and each one's label file by swapping the last ``images``
segment of its path for ``labelTxt`` and the suffix for ``.txt``, so the
benchmark's ``<fold>/images`` layout reads. ``imagesource:`` and ``gsd:`` header
lines are skipped. A row is eight pixel coordinates, the corners of a rectangle
in order round it from any start in either direction, then a category and an
optional ``difficult`` flag; each becomes a canonical rotated box of the class
the category names, carrying a ``0`` or ``1`` flag as the boolean ``difficult``
attribute the exporter writes it from. A class with a flagged box defines that
attribute; a row with no flag carries no value. Corners only near a rectangle, as whole-pixel
hand-drawn ones usually are, become the nearest rectangle and a degraded
geometry, by the rule in :mod:`visionset.formats._obb`. The classes are the categories the kept
boxes name, in the order they first appear.

A row of any other length, four corners farther than that from a rectangle or
enclosing no area and a box wholly outside its measured picture are each a lost
label. A ``difficult`` flag other than ``0`` or ``1`` is a lost attribute and
its box is kept. A picture with no
label file is imported unlabelled, a label file with no picture loses its rows,
and the split is not imported.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Final

from visionset.formats._layout import IMAGES_DIRNAME
from visionset.formats._obb import NOT_FINITE, half_unit, read_corners
from visionset.formats._reading import (
    IMAGE_SUFFIXES,
    Losses,
    files_under,
    measure,
    number,
    read_text,
    relative,
    to_dataset,
)
from visionset.kernel.domain import (
    Attribute,
    AttributeValue,
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLossKind,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.errors import ImportSourceUnreadable

LABELS_DIRNAME: Final = "labelTxt"

#: The boolean annotation attribute ``difficult`` is read into and written from.
DIFFICULT: Final = "difficult"

_LABEL: Final = "DOTA"
_LABEL_SUFFIX: Final = ".txt"
_HEADERS: Final = frozenset({"imagesource", "gsd"})
_ROW_LENGTHS: Final = (9, 10)
_FLAGS: Final = {"0": False, "1": True}
_DIFFICULT: Final = Attribute(name=DIFFICULT, kind="boolean")


class DotaImporter:
    """Reads a DOTA dataset into an ``ImportedDataset``."""

    format_name = "dota"

    def read(self, src: Path) -> ImportedDataset:
        if not src.is_dir():
            raise ImportSourceUnreadable(f"the DOTA source {src.name!r} is not a directory")
        found = {
            PurePosixPath(relative(src, path)): path
            for path in files_under(src, src, IMAGE_SUFFIXES | {_LABEL_SUFFIX})
        }
        label_files = {
            name: path
            for name, path in found.items()
            if name.suffix.lower() == _LABEL_SUFFIX and LABELS_DIRNAME in name.parts[:-1]
        }
        pictures = [
            name
            for name in found
            if name.suffix.lower() in IMAGE_SUFFIXES and IMAGES_DIRNAME in name.parts[:-1]
        ]
        if not pictures:
            raise ImportSourceUnreadable(
                f"the DOTA source {src.name!r} holds no pictures under an {IMAGES_DIRNAME}/ "
                "directory"
            )

        classes: dict[str, None] = {}
        flagged: set[str] = set()
        losses: Losses = Losses()
        images: list[ImportedImage] = []
        claimed: set[PurePosixPath] = set()
        for picture in pictures:
            label_path = _label_path_of(picture)
            if label_path in claimed:
                raise ImportSourceUnreadable(
                    f"label file {str(label_path)!r} is claimed by more than one picture"
                )
            source = label_files.get(label_path)
            if source is None:
                images.append(ImportedImage(path=picture))
                continue
            claimed.add(label_path)
            rows = _rows(source, str(label_path))
            size = measure(src / picture) if rows else None
            labels = [
                label
                for row in rows
                if (label := _label(row, str(label_path), size, losses)) is not None
            ]
            classes.update((label.class_name, None) for label in labels)
            flagged.update(label.class_name for label in labels if label.attributes)
            width, height = size if size is not None else (None, None)
            images.append(
                ImportedImage(path=picture, width=width, height=height, labels=tuple(labels))
            )

        for label_path in sorted(set(label_files) - claimed):
            count = len(_rows(label_files[label_path], str(label_path)))
            losses[(ImportLossKind.LABEL, str(label_path), "a label file with no picture")] += count

        return to_dataset(
            (
                ImportedClass(
                    name=name,
                    geometries=(GeometryType.OBB,),
                    attributes=(_DIFFICULT,) if name in flagged else (),
                )
                for name in classes
            ),
            images,
            losses,
            _LABEL,
        )


def _label_path_of(picture: PurePosixPath) -> PurePosixPath:
    parts = list(picture.parts)
    last = len(parts) - 2 - parts[-2::-1].index(IMAGES_DIRNAME)
    parts[last] = LABELS_DIRNAME
    return PurePosixPath(*parts).with_suffix(_LABEL_SUFFIX)


def _rows(path: Path, where: str) -> list[list[str]]:
    rows = []
    for line in read_text(path, where).split("\n"):
        if not line.strip():
            continue
        key, colon, _ = line.partition(":")
        if colon and key.strip().lower() in _HEADERS:
            continue
        rows.append(line.split())
    return rows


def _label(
    tokens: list[str], where: str, size: tuple[int, int] | None, losses: Losses
) -> ImportedLabel | None:
    if len(tokens) not in _ROW_LENGTHS:
        losses[
            (
                ImportLossKind.LABEL,
                "label row",
                "its row is not four corners, a category and a difficulty",
            )
        ] += 1
        return None
    name = tokens[8]
    values = [number(token, where) for token in tokens[:8]]
    if any(value is None for value in values):
        losses[(ImportLossKind.LABEL, name, NOT_FINITE)] += 1
        return None
    coordinates = [float(value) for value in values if value is not None]
    points = tuple(zip(coordinates[::2], coordinates[1::2], strict=True))
    unit = half_unit(tokens[:8], significant=True)
    geometry, reason = read_corners(points, (unit, unit))
    if geometry is None:
        losses[(ImportLossKind.LABEL, name, reason)] += 1
        return None
    width, height = size if size is not None else (None, None)
    if not geometry_intersects_asset(geometry, width=width, height=height):
        losses[(ImportLossKind.LABEL, name, "it lies wholly outside its picture")] += 1
        return None
    if reason:
        losses[(ImportLossKind.GEOMETRY, name, reason)] += 1
    attributes: dict[str, AttributeValue] = {}
    if len(tokens) == 10:
        flag = _FLAGS.get(tokens[9])
        if flag is None:
            losses[(ImportLossKind.ATTRIBUTE, name, "its difficult flag is neither 0 nor 1")] += 1
        else:
            attributes[DIFFICULT] = flag
    return ImportedLabel(class_name=name, geometry=geometry, attributes=attributes)


__all__ = ["DIFFICULT", "LABELS_DIRNAME", "DotaImporter"]
