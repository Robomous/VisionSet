# usage: from visionset.formats.coco_panoptic import CocoPanopticImporter
"""COCO panoptic in: each segment of each picture becomes one mask of its category.

The source holds ``panoptic_<name>.json`` files under ``annotations/`` or at its
top. Each names its pictures in ``images``, its categories in ``categories``,
and per picture one RGB PNG and its ``segments_info``. The PNGs live in the
directory named after the JSON file, beside it (``annotations/panoptic_val2017/``)
or at the top of the source. Pictures are looked for under ``images/<name>/``,
``images/``, ``<name>/`` and then the top of the source.

A PNG pixel's segment id is ``R + 256 * G + 65536 * B``; ``0`` is void. Each id
the PNG holds becomes one mask, exactly the pixels holding it, of the category
its ``segments_info`` entry names. A panoptic PNG is never read as a class-index
mask.

Refused, by file and id: a PNG that is missing, unreadable or not RGB; an id in
``segments_info`` the PNG does not hold, or one in the PNG that ``segments_info``
does not list; a segment id given twice in one picture, or ``0``; an image or
category id given twice; an annotation naming an image the file does not list,
or a picture annotated twice.

Reported as losses, never dropped silently: void pixels (``label``), a PNG not
the size of its picture (``label``, the picture is imported unlabelled), a
segment naming no declared category (``label``, its pixels are imported
unlabelled), ``iscrowd`` ``1`` (``attribute``, the segment is kept as an
ordinary mask), ``isthing`` ``0`` (``attribute``, a stuff category is a class
like any other), a ``supercategory`` other than the name, a ``color`` and any
other field with no place in the schema (``attribute``). ``bbox`` and ``area``
are read off the pixels, segment and image ids are not kept, and the split is
not imported.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Final, TypeGuard

from visionset.formats._layout import IMAGES_DIRNAME
from visionset.formats._reading import Losses, contained, relative, to_dataset
from visionset.kernel.domain import (
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLossKind,
    MaskEncodingError,
    require_relative_path,
    split_class_map,
)
from visionset.kernel.domain.rle import check_mask_size
from visionset.kernel.errors import ImportSourceUnreadable

FORMAT_NAME: Final = "coco-panoptic"
ANNOTATIONS_DIRNAME: Final = "annotations"
PANOPTIC_PREFIX: Final = "panoptic_"
VOID: Final = 0

#: The largest id three 8-bit channels hold.
MAX_SEGMENT_ID: Final = 256**3 - 1

_LABEL: Final = "COCO panoptic"

_SEGMENT_FIELDS: Final = frozenset({"id", "category_id", "area", "bbox", "iscrowd"})
_CATEGORY_FIELDS: Final = frozenset({"id", "name", "supercategory", "isthing", "color"})

_VOID_PIXELS: Final = (
    "void pixels (id 0) mark an area left unlabelled or ambiguous, which no geometry holds"
)
_CROWD: Final = "iscrowd is not imported; the segment is kept as an ordinary mask"
_STUFF: Final = "isthing 0 (stuff) is not imported; its segments are kept as ordinary masks"
_SUPERCATEGORY: Final = "its supercategory is not imported; a class has no parent"
_COLOUR: Final = "its colour is not imported"
_UNKNOWN_CATEGORY: Final = "it names no declared category; its pixels are imported unlabelled"


@dataclass
class _Picture:
    path: PurePosixPath
    width: int | None
    height: int | None
    labels: list[ImportedLabel] = field(default_factory=list)
    annotated: bool = False


class CocoPanopticImporter:
    """Reads COCO panoptic JSON and its segment PNGs into an ``ImportedDataset``."""

    format_name = FORMAT_NAME

    def read(self, src: Path) -> ImportedDataset:
        if not src.is_dir():
            raise ImportSourceUnreadable(f"the {_LABEL} source {src.name!r} is not a directory")
        root = src.resolve()
        losses: Losses = Losses()
        classes: dict[str, None] = {}
        reported: set[tuple[str, str]] = set()
        pictures: dict[PurePosixPath, _Picture] = {}
        for document_path in _panoptic_files(src):
            where = relative(src, document_path)
            document = _load(document_path, where)
            categories = _categories(document, where, losses, reported)
            classes.update(dict.fromkeys(categories.values()))
            image_dir = _image_dir(src, document_path)
            by_id = _images(document, where, image_dir, pictures)
            png_dir = _png_dir(src, document_path)
            for row in _rows(document, "annotations", where):
                self._annotation(src, root, row, where, png_dir, categories, by_id, losses)
        return to_dataset(
            (ImportedClass(name=name, geometries=(GeometryType.MASK,)) for name in classes),
            (
                ImportedImage(
                    path=one.path, width=one.width, height=one.height, labels=tuple(one.labels)
                )
                for one in pictures.values()
            ),
            losses,
            _LABEL,
        )

    def _annotation(
        self,
        src: Path,
        root: Path,
        row: Mapping[str, Any],
        where: str,
        png_dir: Path,
        categories: Mapping[int, str],
        by_id: Mapping[int, _Picture],
        losses: Losses,
    ) -> None:
        image_id = row.get("image_id")
        picture = by_id.get(image_id) if _is_id(image_id) else None
        if picture is None:
            raise ImportSourceUnreadable(
                f"{where}: an annotation names image id {image_id!r}, which its images do not list"
            )
        if picture.annotated:
            raise ImportSourceUnreadable(
                f"{where}: image {str(picture.path)!r} has two annotations; a picture has one "
                "segment map"
            )
        picture.annotated = True
        segments = _segments(row, where, str(picture.path))
        file_name = row.get("file_name")
        if not isinstance(file_name, str):
            raise ImportSourceUnreadable(
                f"{where}: the annotation of image {str(picture.path)!r} names no PNG file_name"
            )
        png = _png_path(src, root, png_dir, file_name, where)
        shown = relative(src, png)
        width, height, values = read_segment_map(png, shown)
        if picture.width is None or picture.height is None:
            picture.width, picture.height = width, height
        if (width, height) != (picture.width, picture.height):
            losses[
                (
                    ImportLossKind.LABEL,
                    shown,
                    f"it is {width} by {height} and its picture {picture.width} by "
                    f"{picture.height}; its segments are not imported",
                )
            ] += 1
            return
        try:
            check_mask_size(height, width)
        except MaskEncodingError as exc:
            losses[(ImportLossKind.LABEL, shown, f"{exc}; its segments are not imported")] += 1
            return
        masks = split_class_map(values, height=height, width=width, ignore={VOID})
        listed = {segment_id for segment_id, _ in segments}
        unlisted = sorted(set(masks) - listed)
        if unlisted:
            raise ImportSourceUnreadable(
                f"PNG {shown!r} holds segment ids {unlisted[:10]} that segments_info of image "
                f"{str(picture.path)!r} in {where} does not list"
            )
        absent = sorted(listed - set(masks))
        if absent:
            raise ImportSourceUnreadable(
                f"segments_info of image {str(picture.path)!r} in {where} lists segment ids "
                f"{absent[:10]} that PNG {shown!r} does not hold"
            )
        if VOID in values:
            losses[(ImportLossKind.LABEL, "void", _VOID_PIXELS)] += 1
        for segment_id, segment in segments:
            category_id = segment.get("category_id")
            name = categories.get(category_id) if _is_id(category_id) else None
            if name is None:
                losses[(ImportLossKind.LABEL, "segment", _UNKNOWN_CATEGORY)] += 1
                continue
            if segment.get("iscrowd") == 1:
                losses[(ImportLossKind.ATTRIBUTE, name, _CROWD)] += 1
            for key in sorted(set(segment) - _SEGMENT_FIELDS):
                reason = f"segment field {key[:40]!r} is not imported"
                losses[(ImportLossKind.ATTRIBUTE, name, reason)] += 1
            picture.labels.append(ImportedLabel(class_name=name, geometry=masks[segment_id]))


def read_segment_map(path: Path, shown: str) -> tuple[int, int, Sequence[int]]:
    """The PNG's width, height and row-major segment ids, ``R + 256 * G + 65536 * B``.

    Raises:
        ImportSourceUnreadable: the file is not a readable RGB PNG.
    """
    from PIL import Image

    try:
        with Image.open(path) as image:
            image_format, mode, (width, height) = image.format, image.mode, image.size
            if image_format == "PNG" and mode == "RGB":
                image.load()
                data = image.tobytes()
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        raise ImportSourceUnreadable(f"PNG {shown!r} is not readable: {exc}") from None
    if image_format != "PNG":
        raise ImportSourceUnreadable(f"segment map {shown!r} is a {image_format} file, not a PNG")
    if mode != "RGB":
        raise ImportSourceUnreadable(
            f"PNG {shown!r} is a {mode} PNG; a panoptic segment map is RGB, each pixel's id "
            "R + 256 * G + 65536 * B"
        )
    values = [
        red | green << 8 | blue << 16
        for red, green, blue in zip(data[0::3], data[1::3], data[2::3], strict=True)
    ]
    return width, height, values


def _panoptic_files(src: Path) -> list[Path]:
    for directory in (src / ANNOTATIONS_DIRNAME, src):
        if not directory.is_dir():
            continue
        found = sorted(
            path for path in directory.glob(f"{PANOPTIC_PREFIX}*.json") if path.is_file()
        )
        if found:
            root = src.resolve()
            return [contained(src, root, path) for path in found]
    raise ImportSourceUnreadable(
        f"the {_LABEL} source {src.name!r} holds no {PANOPTIC_PREFIX}*.json under "
        f"{ANNOTATIONS_DIRNAME}/ or at its top, such as "
        f"{ANNOTATIONS_DIRNAME}/{PANOPTIC_PREFIX}val2017.json beside the PNG directory "
        f"{ANNOTATIONS_DIRNAME}/{PANOPTIC_PREFIX}val2017/"
    )


def _refuse_constant(name: str) -> float:
    raise ImportSourceUnreadable(f"the {_LABEL} file holds the non-finite number {name}")


def _load(path: Path, where: str) -> Mapping[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"), parse_constant=_refuse_constant)
    except (OSError, ValueError, RecursionError) as exc:
        raise ImportSourceUnreadable(f"{where} is not readable JSON: {exc}") from None
    if not isinstance(document, dict):
        raise ImportSourceUnreadable(f"{where} is not a {_LABEL} document")
    return document


def _rows(document: Mapping[str, Any], key: str, where: str) -> Iterable[Mapping[str, Any]]:
    rows = document.get(key, [])
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ImportSourceUnreadable(f"{where}: {key!r} is not a list of objects")
    return rows


def _is_id(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def _categories(
    document: Mapping[str, Any], where: str, losses: Losses, reported: set[tuple[str, str]]
) -> dict[int, str]:
    categories: dict[int, str] = {}
    for row in _rows(document, "categories", where):
        category_id, name = row.get("id"), row.get("name")
        if not _is_id(category_id):
            raise ImportSourceUnreadable(f"{where}: category id {category_id!r} is not an integer")
        if not isinstance(name, str) or not name.strip():
            raise ImportSourceUnreadable(f"{where}: category {category_id} has no name")
        if category_id in categories:
            raise ImportSourceUnreadable(f"{where}: category id {category_id} repeats")
        name = name.strip()
        categories[category_id] = name
        isthing = row.get("isthing", 1)
        if not _is_id(isthing) or isthing not in (0, 1):
            raise ImportSourceUnreadable(
                f"{where}: category {name!r} has isthing {isthing!r}, which is not 0 or 1"
            )
        found: list[str] = []
        if isthing == 0:
            found.append(_STUFF)
        supercategory = row.get("supercategory")
        if supercategory is not None and supercategory != name:
            found.append(_SUPERCATEGORY)
        if row.get("color") is not None:
            found.append(_COLOUR)
        found.extend(
            f"category field {key[:40]!r} is not imported"
            for key in sorted(set(row) - _CATEGORY_FIELDS)
        )
        for reason in found:
            if (name, reason) not in reported:
                reported.add((name, reason))
                losses[(ImportLossKind.ATTRIBUTE, name, reason)] += 1
    return categories


def _images(
    document: Mapping[str, Any],
    where: str,
    image_dir: PurePosixPath,
    pictures: dict[PurePosixPath, _Picture],
) -> dict[int, _Picture]:
    by_id: dict[int, _Picture] = {}
    for row in _rows(document, "images", where):
        image_id, file_name = row.get("id"), row.get("file_name")
        if not _is_id(image_id):
            raise ImportSourceUnreadable(f"{where}: image id {image_id!r} is not an integer")
        if image_id in by_id:
            raise ImportSourceUnreadable(f"{where}: image id {image_id} repeats")
        if not isinstance(file_name, str):
            raise ImportSourceUnreadable(f"{where}: image {image_id} has no file_name")
        try:
            path = require_relative_path(image_dir / require_relative_path(file_name))
        except ValueError as exc:
            raise ImportSourceUnreadable(f"{where}: {exc}") from None
        if path in pictures:
            raise ImportSourceUnreadable(f"{where}: image {str(path)!r} is listed twice")
        picture = _Picture(
            path=path, width=_dimension(row, "width"), height=_dimension(row, "height")
        )
        pictures[path] = by_id[image_id] = picture
    return by_id


def _segments(
    row: Mapping[str, Any], where: str, picture: str
) -> list[tuple[int, Mapping[str, Any]]]:
    segments: list[tuple[int, Mapping[str, Any]]] = []
    seen: set[int] = set()
    for segment in _rows(row, "segments_info", f"{where}, image {picture!r}"):
        segment_id = segment.get("id")
        if not _is_id(segment_id) or not 1 <= segment_id <= MAX_SEGMENT_ID:
            raise ImportSourceUnreadable(
                f"{where}: image {picture!r} has segment id {segment_id!r}; a segment id is an "
                f"integer from 1 to {MAX_SEGMENT_ID}, 0 being void"
            )
        if segment_id in seen:
            raise ImportSourceUnreadable(
                f"{where}: image {picture!r} lists segment id {segment_id} twice"
            )
        seen.add(segment_id)
        segments.append((segment_id, segment))
    return segments


def _png_path(src: Path, root: Path, png_dir: Path, file_name: str, where: str) -> Path:
    try:
        path = png_dir / require_relative_path(file_name)
    except ValueError as exc:
        raise ImportSourceUnreadable(f"{where}: {exc}") from None
    if not path.is_file():
        shown = relative(src, path) if path.is_relative_to(src) else file_name
        raise ImportSourceUnreadable(
            f"{where} names the segment PNG {shown!r}, which the source does not hold; the PNGs "
            f"live in the directory named after the JSON file, beside it or at the source's top"
        )
    return contained(src, root, path)


def _image_dir(src: Path, document_path: Path) -> PurePosixPath:
    name = document_path.stem.removeprefix(PANOPTIC_PREFIX)
    candidates = [PurePosixPath(IMAGES_DIRNAME)]
    if name:
        candidates = [PurePosixPath(IMAGES_DIRNAME, name), *candidates, PurePosixPath(name)]
    return next(
        (directory for directory in candidates if (src / directory).is_dir()), PurePosixPath()
    )


def _png_dir(src: Path, document_path: Path) -> Path:
    beside = document_path.parent / document_path.stem
    return beside if beside.is_dir() else src / document_path.stem


def _dimension(row: Mapping[str, Any], key: str) -> int | None:
    value = row.get(key)
    return value if _is_id(value) and value > 0 else None


__all__ = [
    "ANNOTATIONS_DIRNAME",
    "FORMAT_NAME",
    "MAX_SEGMENT_ID",
    "PANOPTIC_PREFIX",
    "VOID",
    "CocoPanopticImporter",
    "read_segment_map",
]
