# usage: from visionset.formats.ultralytics import UltralyticsImporter
"""Ultralytics in: the label layout under ``data.yaml``, or the classify class tree.

The inverse of :class:`UltralyticsExporter`, which writes one of two layouts.
With a ``data.yaml`` (or a single YAML file at the top of the source), the
pictures under ``images/`` and their label rows are read through the shared
YOLO reader: a five-number row is a box, a longer even one a polygon, and a
pose dataset's keypoints are reported and its box kept. Without one, the
``train``/``val``/``test`` class tree is read: every class directory is a tag
class, and a picture copied under several class directories, which is how the
exporter writes an image with several tags, is one image carrying each tag;
the same bytes twice under one class directory is a repeated tag, a label loss.

The exporter writes a box in a segment export as its four corners, and nothing
in the row says it was a box, so it reads back as a four-point polygon. The
split is not imported, and a class tree's class order is its directories'.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Final

from visionset.formats._layout import FOLDS, IMAGES_DIRNAME
from visionset.formats._reading import (
    IMAGE_SUFFIXES,
    REPEATED_TAG,
    Losses,
    files_under,
    relative,
    to_dataset,
)
from visionset.formats._yolo_reader import descriptor_file, read_label_layout, yaml_descriptor
from visionset.formats._yolo_writer import DATA_FILENAME
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

_LABEL: Final = "Ultralytics"
_CHUNK: Final = 1 << 20


class UltralyticsImporter:
    """Reads an Ultralytics dataset into an ``ImportedDataset``."""

    format_name = "ultralytics"

    def read(self, src: Path) -> ImportedDataset:
        descriptor = descriptor_file(src, DATA_FILENAME, _LABEL)
        if descriptor is not None:
            return read_label_layout(src, yaml_descriptor(descriptor), _LABEL)
        folds = [src / fold for fold in FOLDS if (src / fold).is_dir()]
        if folds and not (src / IMAGES_DIRNAME).exists():
            return _class_tree(src, folds)
        raise ImportSourceUnreadable(
            f"the Ultralytics source {src.name!r} holds neither a {DATA_FILENAME} nor a "
            f"{'/'.join(FOLDS)} class tree"
        )


def _class_tree(src: Path, folds: list[Path]) -> ImportedDataset:
    classes: set[str] = set()
    copies: list[tuple[PurePosixPath, str, Path]] = []
    losses: Losses = Losses()
    for fold in folds:
        if fold.is_symlink():
            raise ImportSourceUnreadable(
                f"{fold.name!r} is a symbolic link to a directory; "
                "linked directories are not followed"
            )
        for stray in fold.iterdir():
            if stray.suffix.lower() in IMAGE_SUFFIXES and stray.is_file():
                losses[
                    (ImportLossKind.IMAGE, fold.name, "a picture outside every class directory")
                ] += 1
        for directory in sorted(entry for entry in fold.iterdir() if entry.is_dir()):
            classes.add(directory.name)
            copies.extend(
                (PurePosixPath(relative(src, path)), directory.name, path)
                for path in files_under(src, directory, IMAGE_SUFFIXES)
            )

    first_path: dict[str, PurePosixPath] = {}
    tags: defaultdict[str, list[str]] = defaultdict(list)
    for name, tag, path in sorted(copies):
        digest = _digest(path, str(name))
        first_path.setdefault(digest, name)
        if tag in tags[digest]:
            losses[(ImportLossKind.LABEL, tag, REPEATED_TAG)] += 1
        else:
            tags[digest].append(tag)

    images = [
        ImportedImage(
            path=path,
            labels=tuple(
                ImportedLabel(class_name=tag, geometry=ClassificationGeometry())
                for tag in tags[digest]
            ),
        )
        for digest, path in first_path.items()
    ]
    return to_dataset(
        (
            ImportedClass(name=name, geometries=(GeometryType.CLASSIFICATION_TAG,))
            for name in sorted(classes)
        ),
        images,
        losses,
        _LABEL,
    )


def _digest(path: Path, where: str) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(_CHUNK):
                digest.update(chunk)
    except OSError as exc:
        raise ImportSourceUnreadable(f"{where} could not be read: {exc}") from None
    return digest.hexdigest()


__all__ = ["UltralyticsImporter"]
