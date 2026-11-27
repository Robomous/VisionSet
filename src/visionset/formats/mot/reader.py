# usage: from visionset.formats.mot import MotImporter
"""MOTChallenge in: each sequence an ordered image sequence, its ground-truth ids as tracks.

A sequence is any directory under the source holding a ``seqinfo.ini``, whose
``[Sequence]`` section names it (``name``), its frame directory (``imDir``),
``frameRate``, ``seqLength``, ``imWidth``, ``imHeight`` and ``imExt``. Frame
``n`` is ``<imDir>/<n:06d><imExt>`` for every ``n`` from 1 to ``seqLength``,
and sits at position ``n - 1``, ``(n - 1) / frameRate`` seconds in. A frame the
sequence names but does not hold is listed anyway, so the import reports it and
its position stays a gap rather than shifting the rest.

``gt/gt.txt`` holds the MOT16/17/20 rows
``frame,id,bb_left,bb_top,bb_width,bb_height,conf,class,visibility``; a
sequence without one imports its frames unlabelled. Every row is a box. Its
``id`` becomes the label's track, a string scoped to its sequence, so equal ids
in two sequences are two tracks. Nothing else yields an identity:

- an ``id`` that is not positive is no identity, and the box is kept untracked;
- ``conf`` ``0`` marks an entry evaluation ignores, and it is not imported;
  ``1`` is ground truth, and anything between is a tracker's score, kept as the
  label's confidence;
- ``class`` is a 1-based index into ``gt/labels.txt``, one class name per line,
  the table CVAT and Datumaro write beside ``gt.txt``; without that file a
  class is named by its number;
- ``visibility`` has no slot and is reported, the box kept.

What does not read as this layout is refused by name rather than guessed: a row
of another width (MOT15's ten columns included), a number that is not one, a
frame outside the sequence, a box of no area, a confidence or visibility
outside its range, and a class the table does not hold. ``det/det.txt`` holds
public detections, not annotations, and is not read.
"""

from __future__ import annotations

import configparser
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Final

from pydantic import ValidationError

from visionset.formats._reading import contained, files_under, number, read_text, relative
from visionset.kernel.domain import (
    BboxGeometry,
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedFrame,
    ImportedImage,
    ImportedLabel,
    ImportedSequence,
    ImportLoss,
    ImportLossKind,
    require_relative_path,
)
from visionset.kernel.errors import ImportSourceUnreadable

SEQINFO_FILENAME: Final = "seqinfo.ini"
SEQINFO_SECTION: Final = "Sequence"
GT_DIRNAME: Final = "gt"
GT_FILENAME: Final = "gt.txt"
LABELS_FILENAME: Final = "labels.txt"
FRAME_DIGITS: Final = 6

#: ``frame,id,bb_left,bb_top,bb_width,bb_height,conf,class,visibility``.
ROW_FIELDS: Final = 9

_NO_VISIBILITY: Final = -1.0
_IGNORED: Final = (
    "its conf is 0, MOT's mark for an entry evaluation ignores; the box is not imported"
)
_VISIBILITY: Final = "the visibility ratio has no slot; the box is kept"
_NO_IDENTITY: Final = (
    "its id is not positive, MOT's mark for no identity; the box is kept untracked"
)

_Losses = Counter[tuple[ImportLossKind, str, str]]


@dataclass(frozen=True)
class _Info:
    name: str
    image_dir: PurePosixPath
    frame_rate: float
    length: int
    width: int
    height: int
    extension: str


class MotImporter:
    """Reads MOTChallenge sequences into an ``ImportedDataset``."""

    format_name = "mot"

    def read(self, src: Path) -> ImportedDataset:
        if not src.is_dir():
            raise ImportSourceUnreadable(f"the MOT source {src.name!r} is not a directory")
        root = src.resolve()
        found = [path for path in files_under(src, src, {".ini"}) if path.name == SEQINFO_FILENAME]
        if not found:
            raise ImportSourceUnreadable(f"the MOT source {src.name!r} holds no {SEQINFO_FILENAME}")
        images: list[ImportedImage] = []
        sequences: list[ImportedSequence] = []
        classes: dict[str, int] = {}
        losses: _Losses = Counter()
        named: dict[str, str] = {}
        for seqinfo in found:
            directory = seqinfo.parent
            where = relative(src, seqinfo)
            info = _info(seqinfo, where)
            earlier = named.setdefault(info.name, where)
            if earlier != where:
                raise ImportSourceUnreadable(
                    f"{where} and {earlier} both name the sequence {info.name!r}"
                )
            prefix = PurePosixPath(relative(src, directory)) if directory != src else None
            labels = _labels(src, root, directory, info, classes, losses)
            frames = []
            for frame in range(1, info.length + 1):
                inner = info.image_dir / f"{frame:0{FRAME_DIGITS}d}{info.extension}"
                path = inner if prefix is None else prefix / inner
                images.append(
                    ImportedImage(
                        path=path,
                        width=info.width,
                        height=info.height,
                        labels=tuple(labels.get(frame, ())),
                    )
                )
                frames.append(ImportedFrame(path=path, timestamp=(frame - 1) / info.frame_rate))
            try:
                sequences.append(ImportedSequence(name=info.name, frames=tuple(frames)))
            except ValidationError as exc:
                raise ImportSourceUnreadable(f"{where}: {_first_error(exc)}") from None
        try:
            return ImportedDataset(
                classes=tuple(
                    ImportedClass(name=name, geometries=(GeometryType.BBOX,))
                    for name, _ in sorted(classes.items(), key=lambda item: (item[1], item[0]))
                ),
                images=tuple(images),
                losses=tuple(
                    ImportLoss(kind=kind, subject=subject, count=count, reason=reason)
                    for (kind, subject, reason), count in losses.items()
                ),
                sequences=tuple(sequences),
            )
        except ValidationError as exc:
            raise ImportSourceUnreadable(f"the MOT dataset is inconsistent: {exc}") from None


def _first_error(exc: ValidationError) -> str:
    return str(exc.errors()[0]["msg"]).removeprefix("Value error, ")


def _info(path: Path, where: str) -> _Info:
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str  # type: ignore[assignment,method-assign]
    try:
        parser.read_string(read_text(path, where), source=where)
    except configparser.Error as exc:
        raise ImportSourceUnreadable(f"{where} is not an INI file: {exc}") from None
    if not parser.has_section(SEQINFO_SECTION):
        raise ImportSourceUnreadable(f"{where} has no [{SEQINFO_SECTION}] section")
    section = parser[SEQINFO_SECTION]

    def field(key: str) -> str:
        value = section.get(key, "").strip()
        if not value:
            raise ImportSourceUnreadable(f"{where} does not give {key}")
        return value

    def positive_integer(key: str) -> int:
        value = number(field(key), where)
        if value is None or not value.is_integer() or value < 1:
            raise ImportSourceUnreadable(
                f"{where}: {key} is {field(key)!r}, not a positive integer"
            )
        return int(value)

    rate = number(field("frameRate"), where)
    if rate is None or rate <= 0:
        raise ImportSourceUnreadable(
            f"{where}: frameRate is {field('frameRate')!r}, not a positive number"
        )
    extension = field("imExt")
    if not extension.startswith(".") or "/" in extension or "\\" in extension:
        raise ImportSourceUnreadable(f"{where}: imExt {extension!r} is not a file suffix")
    try:
        image_dir = require_relative_path(field("imDir"))
    except ValueError as exc:
        raise ImportSourceUnreadable(f"{where}: imDir: {exc}") from None
    return _Info(
        name=field("name"),
        image_dir=image_dir,
        frame_rate=rate,
        length=positive_integer("seqLength"),
        width=positive_integer("imWidth"),
        height=positive_integer("imHeight"),
        extension=extension,
    )


def _class_table(src: Path, root: Path, directory: Path) -> Mapping[int, str] | None:
    path = directory / GT_DIRNAME / LABELS_FILENAME
    if not path.is_file():
        return None
    where = relative(src, contained(src, root, path))
    lines = [line.removesuffix("\r") for line in read_text(path, where).split("\n")]
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        raise ImportSourceUnreadable(f"{where} names no classes")
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            raise ImportSourceUnreadable(f"{where}: line {line_number} names no class")
    names = [line.strip() for line in lines]
    repeated = next((name for name in names if names.count(name) > 1), None)
    if repeated is not None:
        raise ImportSourceUnreadable(f"{where}: class name {repeated!r} is given twice")
    return dict(enumerate(names, 1))


def _labels(
    src: Path,
    root: Path,
    directory: Path,
    info: _Info,
    classes: dict[str, int],
    losses: _Losses,
) -> dict[int, list[ImportedLabel]]:
    path = directory / GT_DIRNAME / GT_FILENAME
    if not path.is_file():
        return {}
    where = relative(src, contained(src, root, path))
    table = _class_table(src, root, directory)
    labels: dict[int, list[ImportedLabel]] = {}
    for line_number, line in enumerate(read_text(path, where).split("\n"), 1):
        if not line.strip():
            continue
        at = f"{where} line {line_number}"
        fields = [token.strip() for token in line.split(",")]
        if len(fields) != ROW_FIELDS:
            raise ImportSourceUnreadable(
                f"{at} has {len(fields)} fields; a MOT16/17/20 row has {ROW_FIELDS}: "
                "frame,id,bb_left,bb_top,bb_width,bb_height,conf,class,visibility"
            )
        values = []
        for name, token in zip(
            ("frame", "id", "bb_left", "bb_top", "bb_width", "bb_height", "conf", "class", "vis"),
            fields,
            strict=True,
        ):
            value = number(token, at)
            if value is None:
                raise ImportSourceUnreadable(f"{at}: {name} {token!r} is not a number")
            values.append(value)
        frame, identity, left, top, width, height, conf, class_id, visibility = values
        if not frame.is_integer() or not 1 <= frame <= info.length:
            raise ImportSourceUnreadable(
                f"{at}: frame {fields[0]} is not a frame of the sequence's {info.length}"
            )
        if not identity.is_integer():
            raise ImportSourceUnreadable(f"{at}: id {fields[1]} is not an integer")
        if width <= 0 or height <= 0:
            raise ImportSourceUnreadable(f"{at}: the box has no area ({fields[4]}x{fields[5]})")
        if not 0 <= conf <= 1:
            raise ImportSourceUnreadable(f"{at}: conf {fields[6]} is outside 0 to 1")
        if visibility != _NO_VISIBILITY and not 0 <= visibility <= 1:
            raise ImportSourceUnreadable(
                f"{at}: visibility {fields[8]} is neither -1 nor within 0 to 1"
            )
        class_name = _class_name(class_id, table, at, fields[7])
        if conf == 0:
            losses[(ImportLossKind.LABEL, class_name, _IGNORED)] += 1
            continue
        if visibility != _NO_VISIBILITY:
            losses[(ImportLossKind.ATTRIBUTE, class_name, _VISIBILITY)] += 1
        track = str(int(identity)) if identity > 0 else None
        if track is None:
            losses[(ImportLossKind.ATTRIBUTE, class_name, _NO_IDENTITY)] += 1
        classes.setdefault(class_name, int(class_id))
        labels.setdefault(int(frame), []).append(
            ImportedLabel(
                class_name=class_name,
                geometry=BboxGeometry(x=left, y=top, width=width, height=height),
                confidence=None if conf == 1 else conf,
                track=track,
            )
        )
    return labels


def _class_name(class_id: float, table: Mapping[int, str] | None, at: str, token: str) -> str:
    if not class_id.is_integer() or class_id < 1:
        raise ImportSourceUnreadable(f"{at}: class {token} is not a positive integer")
    index = int(class_id)
    if table is None:
        return str(index)
    if index not in table:
        raise ImportSourceUnreadable(
            f"{at}: class {token} is not one of the {len(table)} in {LABELS_FILENAME}"
        )
    return table[index]


__all__ = [
    "GT_DIRNAME",
    "GT_FILENAME",
    "LABELS_FILENAME",
    "SEQINFO_FILENAME",
    "MotImporter",
]
