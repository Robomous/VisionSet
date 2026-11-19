# usage: from visionset.formats.classification import ClassificationImporter
"""Image classification in: ``labels.csv`` rows as tags, ``classes.txt`` as the vocabulary.

The inverse of :class:`ClassificationExporter`: each ``labels.csv`` row is one
tag on the picture its ``image`` column names, relative to the source, so a
picture with several rows carries several tags. A picture carries a class's
tag once, so a repeated row is a label loss. ``classes.txt`` declares every tag class in its
order, used or not; without it the classes are those the rows name. The
pictures under ``images/`` that no row names are imported untagged, because
the exporter writes an untagged asset's bytes and no row. The ``fold`` column
is not imported.

A row whose class ``classes.txt`` does not declare, or that is malformed, is a
label loss. A path that leaves the source refuses the whole import.
"""

from __future__ import annotations

import csv
import io
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Final

from visionset.formats._layout import IMAGES_DIRNAME
from visionset.formats._reading import (
    IMAGE_SUFFIXES,
    REPEATED_TAG,
    Losses,
    contained,
    files_under,
    inside,
    read_text,
    relative,
    to_dataset,
)
from visionset.kernel.domain import (
    ClassificationGeometry,
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLossKind,
)
from visionset.kernel.errors import ImportSourceUnreadable

LABELS_FILENAME: Final = "labels.csv"
CLASSES_FILENAME: Final = "classes.txt"

_LABEL: Final = "classification"
_IMAGE_COLUMN: Final = "image"
_CLASS_COLUMN: Final = "class"


class ClassificationImporter:
    """Reads an image-classification dataset into an ``ImportedDataset``."""

    format_name = "classification"

    def read(self, src: Path) -> ImportedDataset:
        if not src.is_dir():
            raise ImportSourceUnreadable(
                f"the classification source {src.name!r} is not a directory"
            )
        root = src.resolve()
        labels_path = src / LABELS_FILENAME
        if not labels_path.is_file():
            raise ImportSourceUnreadable(
                f"the classification source {src.name!r} holds no {LABELS_FILENAME}"
            )
        classes_path = src / CLASSES_FILENAME
        vocabulary = (
            _vocabulary(contained(src, root, classes_path)) if classes_path.is_file() else None
        )

        declared: dict[str, None] = dict.fromkeys(vocabulary or ())
        images: dict[PurePosixPath, list[ImportedLabel]] = {}
        losses: Losses = Counter()
        for row in _rows(contained(src, root, labels_path)):
            if row is None:
                losses[(ImportLossKind.LABEL, "row", "it does not have the header's columns")] += 1
                continue
            image, name = row
            if not image:
                losses[(ImportLossKind.LABEL, "row", "it names no picture")] += 1
                continue
            path = inside(image, LABELS_FILENAME)
            if not name:
                losses[(ImportLossKind.LABEL, "row", "it names no class")] += 1
                continue
            if vocabulary is not None and name not in declared:
                losses[(ImportLossKind.LABEL, name, f"{CLASSES_FILENAME} does not declare it")] += 1
                continue
            declared.setdefault(name)
            tags = images.setdefault(path, [])
            if any(tag.class_name == name for tag in tags):
                losses[(ImportLossKind.LABEL, name, REPEATED_TAG)] += 1
                continue
            tags.append(ImportedLabel(class_name=name, geometry=ClassificationGeometry()))

        if (src / IMAGES_DIRNAME).is_dir():
            for picture in files_under(src, src / IMAGES_DIRNAME, IMAGE_SUFFIXES):
                images.setdefault(PurePosixPath(relative(src, picture)), [])

        return to_dataset(
            (
                ImportedClass(name=name, geometries=(GeometryType.CLASSIFICATION_TAG,))
                for name in declared
            ),
            (ImportedImage(path=path, labels=tuple(labels)) for path, labels in images.items()),
            losses,
            _LABEL,
        )


def _vocabulary(path: Path) -> list[str]:
    return [line.strip() for line in read_text(path, CLASSES_FILENAME).split("\n") if line.strip()]


def _rows(path: Path) -> list[tuple[str, str] | None]:
    """Each row's picture and class, or ``None`` for a row of the wrong width."""
    text = read_text(path, LABELS_FILENAME)
    try:
        table = list(csv.reader(io.StringIO(text, newline="")))
    except csv.Error as exc:
        raise ImportSourceUnreadable(f"{LABELS_FILENAME} is not readable CSV: {exc}") from None
    if not table:
        raise ImportSourceUnreadable(f"{LABELS_FILENAME} has no header row")
    header = [column.strip() for column in table[0]]
    if _IMAGE_COLUMN not in header or _CLASS_COLUMN not in header:
        raise ImportSourceUnreadable(
            f"{LABELS_FILENAME}'s header names no {_IMAGE_COLUMN!r} and {_CLASS_COLUMN!r} columns"
        )
    image_at, class_at = header.index(_IMAGE_COLUMN), header.index(_CLASS_COLUMN)
    return [
        (row[image_at].strip(), row[class_at].strip()) if len(row) == len(header) else None
        for row in table[1:]
        if row
    ]


__all__ = ["ClassificationImporter"]
