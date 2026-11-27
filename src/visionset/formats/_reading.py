# usage: from visionset.formats._reading import files_under, number, to_dataset
"""What the importers of the YOLO, VOC and classification formats read the same way.

Private to :mod:`visionset.formats`, like ``_layout``: importable, but not part
of the ``Importer`` contract. Nothing here touches a workspace.
"""

from __future__ import annotations

import functools
import math
import re
from collections import Counter
from collections.abc import Iterable
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Final

from pydantic import ValidationError

from visionset.kernel.domain import (
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportLoss,
    ImportLossKind,
    require_relative_path,
)
from visionset.kernel.errors import ImportSourceUnreadable

Losses = Counter[tuple[ImportLossKind, str, str]]

#: The picture suffixes a YOLO-style tree holds, as ultralytics lists them.
IMAGE_SUFFIXES: Final = frozenset(
    {".bmp", ".dng", ".jpeg", ".jpg", ".mpo", ".png", ".tif", ".tiff", ".webp", ".heic", ".heif"}
)

REPEATED_TAG: Final = "a picture carries one tag of a class; the repeat cannot be represented"

#: A decimal number as a text format writes one; ``float()`` alone also takes
#: ``nan``, ``1_0`` and non-ASCII digits.
_NUMBER: Final = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", re.ASCII)
_NON_FINITE: Final = re.compile(r"[+-]?(?:nan|inf|infinity)", re.ASCII | re.IGNORECASE)
_INDEX: Final = re.compile(r"\d{1,9}", re.ASCII)

#: EXIF orientations that turn the picture a quarter, so width and height swap.
_TRANSPOSED: Final = frozenset({5, 6, 7, 8})
_ORIENTATION_TAG: Final = 0x0112


def files_under(src: Path, directory: Path, suffixes: Iterable[str]) -> list[Path]:
    """Every file under ``directory`` with one of ``suffixes``, sorted.

    A symbolic link to a directory is refused rather than followed, and a file
    that resolves outside ``src`` is refused, so nothing outside the source is
    read. Walked by hand because whether ``rglob`` follows a directory link
    differs across Python versions.
    """
    wanted = {suffix.lower() for suffix in suffixes}
    root = src.resolve()
    found: list[Path] = []
    pending = [directory]
    while pending:
        current = pending.pop()
        if current.is_symlink():
            raise ImportSourceUnreadable(
                f"{relative(src, current)!r} is a symbolic link to a directory; "
                "linked directories are not followed"
            )
        for entry in current.iterdir():
            if entry.is_dir():
                pending.append(entry)
            elif entry.suffix.lower() in wanted and entry.is_file():
                found.append(contained(src, root, entry))
    return sorted(found)


def contained(src: Path, root: Path, path: Path) -> Path:
    """``path``, refused if it resolves outside the source."""
    if not path.resolve().is_relative_to(root):
        raise ImportSourceUnreadable(f"{relative(src, path)!r} resolves outside the source")
    return path


def relative(src: Path, path: Path) -> str:
    return path.relative_to(src).as_posix()


def inside(text: str, where: str) -> PurePosixPath:
    """A path a file names, refused unless it stays inside the source."""
    try:
        return require_relative_path(text)
    except ValueError as exc:
        raise ImportSourceUnreadable(f"{where}: {exc}") from None


def read_text(path: Path, where: str) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        raise ImportSourceUnreadable(f"{where} is not readable UTF-8 text: {exc}") from None


def number(token: str, where: str) -> float | None:
    """A finite number, ``None`` for a token that is not one.

    A ``nan`` or ``inf`` spelled out refuses the file, as the JSON importers
    refuse ``NaN``; an exponent too large for a float is not a coordinate.
    """
    if _NON_FINITE.fullmatch(token):
        raise ImportSourceUnreadable(f"{where} holds the non-finite number {token}")
    if not _NUMBER.fullmatch(token):
        return None
    value = float(token)
    return value if math.isfinite(value) else None


def index(token: str) -> int | None:
    return int(token) if _INDEX.fullmatch(token) else None


def pixels(value: float) -> float:
    """A coordinate scaled out of a normalized one, without float noise or a negative zero."""
    return round(value, 6) + 0.0


def shoelace(points: list[tuple[float, float]]) -> float:
    total = 0.0
    for position, (x1, y1) in enumerate(points):
        x2, y2 = points[(position + 1) % len(points)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


@functools.cache
def _heif_registered() -> None:
    from pillow_heif import register_heif_opener

    register_heif_opener()


def measure(path: Path | BinaryIO) -> tuple[int, int] | None:
    """The picture's width and height as a viewer shows it, or ``None`` when unreadable.

    Read from the header, with an EXIF quarter turn applied, because ingest
    bakes orientation in before it records dimensions and a normalized
    coordinate is a fraction of what the trainer sees.
    """
    from PIL import Image

    _heif_registered()
    try:
        with Image.open(path) as image:
            width, height = image.size
            orientation = image.getexif().get(_ORIENTATION_TAG)
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        return None
    if orientation in _TRANSPOSED:
        width, height = height, width
    return (width, height) if width > 0 and height > 0 else None


def to_dataset(
    classes: Iterable[ImportedClass],
    images: Iterable[ImportedImage],
    losses: Losses,
    format_label: str,
) -> ImportedDataset:
    try:
        return ImportedDataset(
            classes=tuple(classes),
            images=tuple(images),
            losses=tuple(
                ImportLoss(kind=kind, subject=subject, count=count, reason=reason)
                for (kind, subject, reason), count in losses.items()
                if count > 0
            ),
        )
    except ValidationError as exc:
        raise ImportSourceUnreadable(f"the {format_label} dataset is inconsistent: {exc}") from None
