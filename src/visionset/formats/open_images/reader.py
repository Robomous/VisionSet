# usage: from visionset.formats.open_images import OpenImagesImporter
"""Open Images box annotations in: normalized corners per row, MIDs mapped through a class file.

The source holds, at its top, one class descriptions file
(``class-descriptions-boxable.csv``, or ``class-descriptions.csv``, either
optionally prefixed ``oidv<N>-``) of ``LabelName,DisplayName`` rows, with or
without that header, and one ``<split>-annotations-bbox.csv`` per split
(``oidv<N>-`` prefix allowed), whose pictures are ``<split>/**/<ImageID>.<ext>``.
Other Open Images files - image-level labels, segmentation masks, visual
relationships, localized narratives, image metadata - are not read.

The box file's header names its columns, in any order. ``ImageID``,
``LabelName``, ``XMin``, ``XMax``, ``YMin`` and ``YMax`` are required; the
coordinates are fractions of the picture's width and height, which the file
does not record, so each named picture is measured. A corner is the fraction
times the size, rounded to :data:`PRECISION` decimals, so a box exported with
up to that many decimals of a pixel reads back exactly. Coordinates are never
clamped; a box with no pixel inside its picture is a ``label`` loss.

The class is the row's ``DisplayName``; a ``LabelName`` other than its
``DisplayName`` (an Open Images MID) is an ``attribute`` loss. ``Confidence``
of ``1`` or blank is ground truth and carries none; any other value in
``[0, 1]`` is the label's confidence. ``IsOccluded``, ``IsTruncated``,
``IsGroupOf``, ``IsDepiction`` and ``IsInside`` become boolean attributes of
those names for ``1`` and ``0``; ``-1`` or blank is unknown and sets nothing.
A non-blank ``Source``, extreme-click ``XClick*``/``YClick*`` points (a
``geometry`` loss that keeps the box) and any other column are reported lost.

An ``ImageID`` with no picture is an ``image`` loss and its boxes ``label``
losses. A malformed row, a non-finite or non-numeric coordinate, a box whose
maximum does not exceed its minimum, a ``LabelName`` the class file does not
describe, two used ``LabelName`` sharing one ``DisplayName``, a ``LabelName``
described twice, an ``ImageID`` in two splits or matching two pictures, and an
unreadable picture refuse the source.
"""

from __future__ import annotations

import csv
import re
from collections import Counter
from collections.abc import Iterator
from pathlib import Path, PurePosixPath
from typing import Final

from visionset.formats._reading import (
    IMAGE_SUFFIXES,
    Losses,
    contained,
    files_under,
    measure,
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
from visionset.kernel.domain.schema import Attribute, AttributeValue
from visionset.kernel.errors import ImportSourceUnreadable

#: Decimal places a corner keeps: a ten-billionth of a pixel.
PRECISION: Final = 10

COLUMNS: Final = (
    "ImageID",
    "Source",
    "LabelName",
    "Confidence",
    "XMin",
    "XMax",
    "YMin",
    "YMax",
    "IsOccluded",
    "IsTruncated",
    "IsGroupOf",
    "IsDepiction",
    "IsInside",
)
FLAGS: Final = ("IsOccluded", "IsTruncated", "IsGroupOf", "IsDepiction", "IsInside")
DESCRIPTION_COLUMNS: Final = ("LabelName", "DisplayName")
BOXES_SUFFIX: Final = "-annotations-bbox.csv"

_LABEL: Final = "Open Images"
_REQUIRED: Final = ("ImageID", "LabelName", "XMin", "XMax", "YMin", "YMax")
_CLICKS: Final = frozenset(f"{axis}Click{n}{c}" for axis in "XY" for n in "1234" for c in "XY")
_KNOWN: Final = frozenset(COLUMNS) | _CLICKS
_DESCRIPTIONS: Final = re.compile(r"(?:oidv\d+-)?class-descriptions(?:-boxable)?\.csv")
_BOXES: Final = re.compile(r"(?:oidv\d+-)?[A-Za-z0-9_]+-annotations-bbox\.csv")
_IMAGE_ID: Final = re.compile(r"[A-Za-z0-9_-]+", re.ASCII)
_UNKNOWN: Final = frozenset({"", "-1"})


class OpenImagesImporter:
    """Reads an Open Images box-annotation source into an ``ImportedDataset``."""

    format_name = "open-images"

    def read(self, src: Path) -> ImportedDataset:
        if not src.is_dir():
            raise ImportSourceUnreadable(f"the Open Images source {src.name!r} is not a directory")
        root = src.resolve()
        names = _descriptions(src, root)
        splits = _box_files(src, root)

        used: dict[str, str] = {}
        definitions: dict[str, dict[str, Attribute]] = {}
        images: dict[PurePosixPath, ImportedImage] = {}
        split_of: dict[str, str] = {}
        losses: Losses = Counter()
        for split, boxes_path in splits.items():
            where = boxes_path.name
            pictures = _pictures(src, split)
            labelled: dict[str, list[ImportedLabel]] = {}
            sizes: dict[str, tuple[int, int] | None] = {}
            for line, row in _rows(boxes_path, where):
                at = f"{where} line {line}"
                image_id = row["ImageID"]
                if not _IMAGE_ID.fullmatch(image_id):
                    raise ImportSourceUnreadable(f"{at}: ImageID {image_id[:80]!r} is not an id")
                earlier = split_of.setdefault(image_id, split)
                if earlier != split:
                    raise ImportSourceUnreadable(
                        f"{at}: ImageID {image_id!r} is in both {earlier!r} and {split!r}"
                    )
                class_name = _class_name(row["LabelName"], names, used, at)
                corners = _corners(row, at)
                confidence = _confidence(row.get("Confidence", ""), at)
                attributes = _flags(row, at)
                if image_id not in sizes:
                    sizes[image_id] = _size(src, root, pictures, image_id, split, at)
                size = sizes[image_id]
                if size is None:
                    losses[
                        (ImportLossKind.LABEL, where, "a box on an ImageID with no picture")
                    ] += 1
                    continue
                _row_losses(row, class_name, losses)
                box = _scaled(corners, size, at)
                if not geometry_intersects_asset(box, width=size[0], height=size[1]):
                    reason = "it lies wholly outside its picture"
                    losses[(ImportLossKind.LABEL, class_name, reason)] += 1
                    continue
                owned = definitions.setdefault(class_name, {})
                for flag in attributes:
                    owned.setdefault(flag, Attribute(name=flag, kind="boolean"))
                labelled.setdefault(image_id, []).append(
                    ImportedLabel(
                        class_name=class_name,
                        geometry=box,
                        confidence=confidence,
                        attributes=attributes,
                    )
                )
            missing = sum(1 for size in sizes.values() if size is None)
            if missing:
                reason = f"an ImageID with no picture under {split}/; its boxes are not imported"
                losses[(ImportLossKind.IMAGE, where, reason)] += missing
            for image_id, size in sizes.items():
                if size is None:
                    continue
                path = PurePosixPath(relative(src, pictures[image_id][0]))
                images[path] = ImportedImage(
                    path=path,
                    width=size[0],
                    height=size[1],
                    labels=tuple(labelled.get(image_id, ())),
                )

        for picture in files_under(src, src, IMAGE_SUFFIXES):
            path = PurePosixPath(relative(src, picture))
            images.setdefault(path, ImportedImage(path=path))

        return to_dataset(
            (
                ImportedClass(
                    name=name,
                    geometries=(GeometryType.BBOX,),
                    attributes=tuple(
                        definitions[name][flag] for flag in FLAGS if flag in definitions[name]
                    ),
                )
                for name in sorted(definitions)
            ),
            images.values(),
            losses,
            _LABEL,
        )


def _top_level(src: Path, root: Path, pattern: re.Pattern[str]) -> list[Path]:
    return sorted(
        contained(src, root, entry)
        for entry in src.iterdir()
        if pattern.fullmatch(entry.name) and entry.is_file()
    )


def _descriptions(src: Path, root: Path) -> dict[str, str]:
    found = _top_level(src, root, _DESCRIPTIONS)
    if not found:
        raise ImportSourceUnreadable(
            f"the Open Images source {src.name!r} holds no class-descriptions-boxable.csv "
            "to name its LabelName ids"
        )
    if len(found) > 1:
        listed = ", ".join(path.name for path in found)
        raise ImportSourceUnreadable(f"the Open Images source holds {listed}; keep one class file")
    path = found[0]
    names: dict[str, str] = {}
    for line, fields in _csv(path, path.name):
        at = f"{path.name} line {line}"
        if not fields:
            continue
        if len(fields) != len(DESCRIPTION_COLUMNS):
            raise ImportSourceUnreadable(f"{at}: a row is not LabelName,DisplayName")
        if line == 1 and tuple(fields) == DESCRIPTION_COLUMNS:
            continue
        label_name, display_name = fields[0].strip(), fields[1]
        if not label_name:
            raise ImportSourceUnreadable(f"{at}: a LabelName is blank")
        if label_name in names:
            raise ImportSourceUnreadable(f"{at}: LabelName {label_name!r} is described twice")
        names[label_name] = display_name
    return names


def _box_files(src: Path, root: Path) -> dict[str, Path]:
    splits: dict[str, Path] = {}
    for path in _top_level(src, root, _BOXES):
        split = path.name.removesuffix(BOXES_SUFFIX).split("-")[-1]
        if split in splits:
            raise ImportSourceUnreadable(
                f"{splits[split].name} and {path.name} both annotate the {split!r} split"
            )
        splits[split] = path
    if not splits:
        raise ImportSourceUnreadable(
            f"the Open Images source {src.name!r} holds no <split>{BOXES_SUFFIX}"
        )
    return splits


def _pictures(src: Path, split: str) -> dict[str, list[Path]]:
    directory = src / split
    if not (directory.is_dir() or directory.is_symlink()):
        return {}
    by_stem: dict[str, list[Path]] = {}
    for picture in files_under(src, directory, IMAGE_SUFFIXES):
        by_stem.setdefault(picture.stem, []).append(picture)
    return by_stem


def _csv(path: Path, where: str) -> Iterator[tuple[int, list[str]]]:
    try:
        with path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle, strict=True)
            for fields in reader:
                yield reader.line_num, fields
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        raise ImportSourceUnreadable(f"{where} is not readable CSV: {exc}") from None


def _rows(path: Path, where: str) -> Iterator[tuple[int, dict[str, str]]]:
    header: list[str] | None = None
    for line, fields in _csv(path, where):
        if not fields:
            continue
        if header is None:
            header = [field.strip() for field in fields]
            if len(set(header)) != len(header):
                raise ImportSourceUnreadable(f"{where}: the header names a column twice")
            absent = [column for column in _REQUIRED if column not in header]
            if absent:
                raise ImportSourceUnreadable(f"{where}: the header lacks {', '.join(absent)}")
            continue
        if len(fields) != len(header):
            raise ImportSourceUnreadable(
                f"{where} line {line}: {len(fields)} fields where the header names {len(header)}"
            )
        yield line, {column: value.strip() for column, value in zip(header, fields, strict=True)}
    if header is None:
        raise ImportSourceUnreadable(f"{where} is empty; it has no header")


def _class_name(label_name: str, names: dict[str, str], used: dict[str, str], at: str) -> str:
    if not label_name:
        raise ImportSourceUnreadable(f"{at}: a LabelName is blank")
    if label_name not in names:
        raise ImportSourceUnreadable(
            f"{at}: LabelName {label_name[:80]!r} is not in the class descriptions"
        )
    display_name = names[label_name].strip()
    if not display_name:
        raise ImportSourceUnreadable(f"{at}: LabelName {label_name!r} has a blank DisplayName")
    other = used.setdefault(display_name, label_name)
    if other != label_name:
        raise ImportSourceUnreadable(
            f"{at}: LabelName {other!r} and {label_name!r} are both named {display_name!r}"
        )
    return display_name


def _corners(row: dict[str, str], at: str) -> tuple[float, float, float, float]:
    """``XMin``, ``XMax``, ``YMin`` and ``YMax``, fractions of the picture."""
    values: list[float] = []
    for column in ("XMin", "XMax", "YMin", "YMax"):
        value = number(row[column], at)
        if value is None:
            raise ImportSourceUnreadable(f"{at}: {column} {row[column][:40]!r} is not a number")
        values.append(value)
    x_min, x_max, y_min, y_max = values
    if x_max <= x_min or y_max <= y_min:
        raise ImportSourceUnreadable(f"{at}: a box's maximum must exceed its minimum")
    return x_min, x_max, y_min, y_max


def _scaled(
    corners: tuple[float, float, float, float], size: tuple[int, int], at: str
) -> BboxGeometry:
    x_min, x_max, y_min, y_max = corners
    left, right = _pixel(x_min, size[0]), _pixel(x_max, size[0])
    top, bottom = _pixel(y_min, size[1]), _pixel(y_max, size[1])
    width, height = round(right - left, PRECISION) + 0.0, round(bottom - top, PRECISION) + 0.0
    if width <= 0 or height <= 0:
        raise ImportSourceUnreadable(f"{at}: a box is narrower than its picture can measure")
    return BboxGeometry(x=left, y=top, width=width, height=height)


def _pixel(fraction: float, extent: int) -> float:
    return round(fraction * extent, PRECISION) + 0.0


def _confidence(text: str, at: str) -> float | None:
    if text in {"", "1"}:
        return None
    value = number(text, at)
    if value is None or not 0.0 <= value <= 1.0:
        raise ImportSourceUnreadable(f"{at}: Confidence {text[:40]!r} is not a number in [0, 1]")
    return None if value == 1.0 else value + 0.0


def _flags(row: dict[str, str], at: str) -> dict[str, AttributeValue]:
    values: dict[str, AttributeValue] = {}
    for flag in FLAGS:
        text = row.get(flag, "")
        if text in _UNKNOWN:
            continue
        if text not in {"0", "1"}:
            raise ImportSourceUnreadable(f"{at}: {flag} {text[:40]!r} is not 1, 0 or -1")
        values[flag] = text == "1"
    return values


def _row_losses(row: dict[str, str], class_name: str, losses: Losses) -> None:
    if row["LabelName"] != class_name:
        reason = f"LabelName {row['LabelName'][:80]} is not kept; the class is its DisplayName"
        losses[(ImportLossKind.ATTRIBUTE, class_name, reason)] += 1
    if row.get("Source", ""):
        losses[(ImportLossKind.ATTRIBUTE, class_name, "Source is not imported")] += 1
    if any(row.get(column, "") not in _UNKNOWN for column in _CLICKS):
        reason = "extreme-click points are not imported; the box is kept"
        losses[(ImportLossKind.GEOMETRY, class_name, reason)] += 1
    for column in sorted(set(row) - _KNOWN):
        if row[column]:
            losses[(ImportLossKind.ATTRIBUTE, class_name, f"{column[:40]} is not imported")] += 1


def _size(
    src: Path,
    root: Path,
    pictures: dict[str, list[Path]],
    image_id: str,
    split: str,
    at: str,
) -> tuple[int, int] | None:
    """The picture's measured size, or ``None`` when the source does not hold it."""
    matches = pictures.get(image_id, [])
    if not matches:
        return None
    if len(matches) > 1:
        listed = ", ".join(relative(src, path) for path in matches)
        raise ImportSourceUnreadable(f"{at}: ImageID {image_id!r} matches {listed}")
    picture = contained(src, root, matches[0])
    size = measure(picture)
    if size is None:
        raise ImportSourceUnreadable(
            f"{at}: picture {relative(src, picture)!r} under {split}/ is not a readable picture"
        )
    return size


__all__ = ["COLUMNS", "FLAGS", "PRECISION", "OpenImagesImporter"]
