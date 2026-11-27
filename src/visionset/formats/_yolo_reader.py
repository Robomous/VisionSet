# usage: from visionset.formats._yolo_reader import read_label_layout, yaml_descriptor
"""What the YOLO dialects read the same way: the label layout and the YAML descriptor.

The inverse of :mod:`visionset.formats._yolo_writer`. Images are found under
any directory named ``images`` and each one's label file by YOLO's own rule,
the last ``images`` segment of its path swapped for ``labels`` and the suffix
for ``.txt``, so the layout the exporters write and the common
``<fold>/images`` variant both read. A row is ``class cx cy w h`` (a box) or
``class x1 y1 ... xn yn`` (a polygon), normalized to the oriented picture.

Private to :mod:`visionset.formats`, like ``_yolo_writer``: importable, but not
part of the ``Importer`` contract.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Final

from visionset.formats._layout import IMAGES_DIRNAME
from visionset.formats._reading import (
    IMAGE_SUFFIXES,
    Losses,
    contained,
    files_under,
    index,
    measure,
    number,
    pixels,
    read_text,
    relative,
    shoelace,
    to_dataset,
)
from visionset.formats._yolo_writer import LABELS_DIRNAME
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
from visionset.kernel.errors import ImportSourceUnreadable

_DEGENERATE_AREA: Final = 1e-9
_LABEL_SUFFIX: Final = ".txt"
_YAML_SUFFIXES: Final = (".yaml", ".yml")
_DESCRIPTOR_LIMIT: Final = 1 << 20
#: A key YAML reads as this integer; ``010`` is octal to a YAML 1.1 reader.
_CANONICAL_INDEX: Final = re.compile(r"0|[1-9]\d{0,8}", re.ASCII)
#: Plain scalars a YAML 1.1 reader turns into a boolean or null rather than a name.
_YAML_11_SPECIAL: Final = frozenset(
    {"~", "null", "true", "false", "yes", "no", "on", "off", "y", "n"}
)


@dataclass(frozen=True)
class Descriptor:
    """The classes by index, and a pose dataset's ``kpt_shape``."""

    names: Mapping[int, str]
    keypoints: tuple[int, int] | None = None


Row = tuple[str, list[str]]
"""Where a label row was read, and its tokens."""

LabelParser = Callable[
    [Row, Descriptor, tuple[int, int] | None, dict[str, set[GeometryType]], Losses],
    ImportedLabel | None,
]
"""How one label row becomes a label, recording any loss and the geometry it carries."""


def read_label_layout(
    src: Path,
    descriptor: Descriptor,
    format_label: str,
    *,
    parse: LabelParser | None = None,
    default_geometry: GeometryType = GeometryType.BBOX,
) -> ImportedDataset:
    """Every picture under ``images/`` with the label rows YOLO's rule pairs it with.

    ``parse`` reads one row, the box-or-polygon reader unless a dialect brings
    its own; a class no row uses is declared with ``default_geometry``.
    """
    parse = parse or _label
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
            f"the {format_label} source {src.name!r} holds no pictures under an "
            f"{IMAGES_DIRNAME}/ directory"
        )

    geometries: dict[str, set[GeometryType]] = {name: set() for name in descriptor.names.values()}
    losses: Losses = Losses()
    images: list[ImportedImage] = []
    claimed: set[PurePosixPath] = set()
    for picture in pictures:
        label_path = label_path_of(picture)
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
            if (label := parse(row, descriptor, size, geometries, losses)) is not None
        ]
        width, height = size if size is not None else (None, None)
        images.append(ImportedImage(path=picture, width=width, height=height, labels=tuple(labels)))

    for label_path in sorted(set(label_files) - claimed):
        count = len(_rows(label_files[label_path], str(label_path)))
        losses[(ImportLossKind.LABEL, str(label_path), "a label file with no picture")] += count

    classes = [
        ImportedClass(name=name, geometries=tuple(seen) or (default_geometry,))
        for name, seen in geometries.items()
    ]
    return to_dataset(classes, images, losses, format_label)


def label_path_of(picture: PurePosixPath) -> PurePosixPath:
    """YOLO's rule: the last ``images`` segment becomes ``labels``, the suffix ``.txt``."""
    parts = list(picture.parts)
    last = len(parts) - 2 - parts[-2::-1].index(IMAGES_DIRNAME)
    parts[last] = LABELS_DIRNAME
    return PurePosixPath(*parts).with_suffix(_LABEL_SUFFIX)


def _rows(path: Path, where: str) -> list[tuple[str, list[str]]]:
    return [(where, line.split()) for line in read_text(path, where).split("\n") if line.strip()]


def _label(
    row: tuple[str, list[str]],
    descriptor: Descriptor,
    size: tuple[int, int] | None,
    geometries: dict[str, set[GeometryType]],
    losses: Losses,
) -> ImportedLabel | None:
    where, tokens = row
    position = index(tokens[0])
    if position is None:
        losses[(ImportLossKind.LABEL, "label row", "its class is not a whole number")] += 1
        return None
    name = descriptor.names.get(position)
    if name is None:
        losses[
            (ImportLossKind.LABEL, f"class {position}", "the descriptor names no such class")
        ] += 1
        return None
    values = [number(token, where) for token in tokens[1:]]
    if any(value is None for value in values):
        losses[(ImportLossKind.LABEL, name, "its coordinates are not finite numbers")] += 1
        return None
    coordinates = [float(value) for value in values if value is not None]

    if descriptor.keypoints is not None:
        count, dims = descriptor.keypoints
        if len(coordinates) != 4 + count * dims:
            losses[(ImportLossKind.LABEL, name, f"its row is not a box and {count} keypoints")] += 1
            return None
        if any(coordinates[4:]):
            losses[
                (ImportLossKind.GEOMETRY, name, "keypoints are not imported; the box is kept")
            ] += 1
        coordinates = coordinates[:4]
    elif len(coordinates) != 4 and (len(coordinates) < 6 or len(coordinates) % 2):
        losses[(ImportLossKind.LABEL, name, "its row is neither a box nor a polygon")] += 1
        return None

    if size is None:
        losses[
            (
                ImportLossKind.LABEL,
                name,
                "its picture cannot be measured, so normalized coordinates cannot be scaled",
            )
        ] += 1
        return None
    geometry, refusal = _geometry(coordinates, *size)
    if geometry is None:
        losses[(ImportLossKind.LABEL, name, refusal)] += 1
        return None
    if not geometry_intersects_asset(geometry, width=size[0], height=size[1]):
        losses[(ImportLossKind.LABEL, name, "it lies wholly outside its picture")] += 1
        return None
    geometries[name].add(geometry.type)
    return ImportedLabel(class_name=name, geometry=geometry)


def _geometry(coordinates: list[float], width: int, height: int) -> tuple[Geometry | None, str]:
    if len(coordinates) == 4:
        cx, cy, w, h = coordinates
        if w <= 0 or h <= 0:
            return None, "its box has no area"
        return (
            BboxGeometry(
                x=pixels((cx - w / 2) * width),
                y=pixels((cy - h / 2) * height),
                width=pixels(w * width),
                height=pixels(h * height),
            ),
            "",
        )
    points = [
        (pixels(x * width), pixels(y * height))
        for x, y in zip(coordinates[::2], coordinates[1::2], strict=True)
    ]
    if shoelace(points) <= _DEGENERATE_AREA:
        return None, "its polygon encloses no area"
    return PolygonGeometry(points=points), ""


# --- the YAML descriptor ------------------------------------------------------


def descriptor_file(src: Path, preferred: str, format_label: str) -> Path | None:
    """``preferred`` at the top of the source, else its one YAML file, else ``None``."""
    if not src.is_dir():
        raise ImportSourceUnreadable(f"the {format_label} source {src.name!r} is not a directory")
    if (src / preferred).is_file():
        return contained(src, src.resolve(), src / preferred)
    found = sorted(
        path for path in src.iterdir() if path.suffix in _YAML_SUFFIXES and path.is_file()
    )
    return contained(src, src.resolve(), found[0]) if len(found) == 1 else None


def yaml_descriptor(path: Path) -> Descriptor:
    """``names``, ``nc`` and ``kpt_shape`` out of a ``data.yaml``.

    Not a YAML parser: the subset descriptors are written in — top-level
    ``key: value``, a block or flow list or mapping of scalars, plain, single-
    or double-quoted — and a ``names`` outside it is refused rather than
    guessed. Other keys are not read. No YAML library is a dependency here,
    which is also why the exporters write theirs by hand.
    """
    where = path.name
    if path.stat().st_size > _DESCRIPTOR_LIMIT:
        raise ImportSourceUnreadable(f"{where} is larger than a descriptor can be")
    entries = _top_level(read_text(path, where), where)
    if "names" not in entries:
        raise ImportSourceUnreadable(f"{where} has no names")
    names = _names(entries["names"], where)
    if "nc" in entries:
        count = _scalar(entries["nc"], where)
        if index(count) != len(names):
            raise ImportSourceUnreadable(
                f"{where}: nc is {count!r} but names lists {len(names)} classes"
            )
    keypoints = None
    if "kpt_shape" in entries:
        shape = _sequence(entries["kpt_shape"], where)
        dims = [index(value) for value in shape]
        if len(dims) != 2 or dims[0] is None or dims[1] not in (2, 3):
            raise ImportSourceUnreadable(f"{where}: kpt_shape is not [count, 2 or 3]")
        keypoints = (dims[0], dims[1])
    return Descriptor(names=names, keypoints=keypoints)


_Entry = tuple[str, list[str]]
"""A top-level key's inline text and the lines of its block."""


def _top_level(text: str, where: str) -> dict[str, _Entry]:
    entries: dict[str, _Entry] = {}
    current: list[str] | None = None
    lines = iter(text.split("\n"))
    for raw in lines:
        line = _uncommented(raw, where).rstrip()
        if not line.strip() or line in ("---", "..."):
            continue
        if line[0] in " \t-":
            if current is None:
                raise ImportSourceUnreadable(f"{where}: an indented line belongs to no key")
            current.append(line.strip())
            continue
        key, colon, rest = line.partition(":")
        if not colon:
            raise ImportSourceUnreadable(f"{where}: {line[:40]!r} is not a key: value line")
        key = _unquoted(key.strip(), where)
        if key in entries:
            raise ImportSourceUnreadable(f"{where}: {key!r} is given twice")
        rest = rest.strip()
        depth = _depth(rest) if rest.startswith(("[", "{")) else 0
        pieces = [rest]
        while depth > 0:
            follow = next(lines, None)
            if follow is None:
                raise ImportSourceUnreadable(f"{where}: {key!r} opens a bracket it never closes")
            piece = _uncommented(follow, where).strip()
            depth += _depth(piece)
            pieces.append(piece)
        rest = " ".join(pieces)
        current = []
        entries[key] = (rest, current)
    return entries


def _names(entry: _Entry, where: str) -> dict[int, str]:
    inline, block = entry
    pairs: list[tuple[str, str]]
    if inline.startswith("[") or (not inline and block and block[0].startswith("-")):
        pairs = [(str(position), name) for position, name in enumerate(_sequence(entry, where))]
    elif inline.startswith("{"):
        pairs = [_pair(item, where) for item in _flow(inline, "{", "}", where)]
    elif not inline and block:
        pairs = [_pair(line, where) for line in block]
    else:
        raise ImportSourceUnreadable(f"{where}: names is neither a list nor a mapping")
    names: dict[int, str] = {}
    taken: set[str] = set()
    for key, value in pairs:
        position = index(key) if _CANONICAL_INDEX.fullmatch(key) else None
        if position is None:
            raise ImportSourceUnreadable(f"{where}: names key {key!r} is not a class index")
        if position in names:
            raise ImportSourceUnreadable(f"{where}: class index {position} is named twice")
        name = value.strip()
        if not name:
            raise ImportSourceUnreadable(f"{where}: class {position} has a blank name")
        if name in taken:
            raise ImportSourceUnreadable(f"{where}: class name {name!r} is given to two indices")
        names[position] = name
        taken.add(name)
    if not names:
        raise ImportSourceUnreadable(f"{where}: names is empty")
    return dict(sorted(names.items()))


def _sequence(entry: _Entry, where: str) -> list[str]:
    inline, block = entry
    if inline.startswith("["):
        return [_scalar((item, []), where) for item in _flow(inline, "[", "]", where)]
    if not inline and all(line.startswith("-") for line in block):
        return [_scalar((line[1:].strip(), []), where) for line in block]
    raise ImportSourceUnreadable(f"{where}: expected a list")


def _pair(item: str, where: str) -> tuple[str, str]:
    key, colon, value = _split_unquoted(item, ":")
    if not colon:
        raise ImportSourceUnreadable(f"{where}: {item[:40]!r} is not a key: value pair")
    return _unquoted(key.strip(), where), _scalar((value.strip(), []), where)


def _scalar(entry: _Entry, where: str) -> str:
    inline, block = entry
    if block or inline.startswith(("[", "{")):
        raise ImportSourceUnreadable(f"{where}: expected a single value")
    return _unquoted(inline, where)


def _unquoted(token: str, where: str) -> str:
    if len(token) >= 2 and token[0] == token[-1] == '"':
        try:
            value = json.loads(token)
        except (ValueError, RecursionError):
            value = None
        if not isinstance(value, str):
            raise ImportSourceUnreadable(f"{where}: {token[:40]!r} is not a quoted string")
        return value
    if len(token) >= 2 and token[0] == token[-1] == "'":
        return token[1:-1].replace("''", "'")
    if token[:1] in ("'", '"', "&", "*", "!", "|", ">") or token.lower() in _YAML_11_SPECIAL:
        raise ImportSourceUnreadable(f"{where}: {token[:40]!r} is YAML this reader does not take")
    return token


def _flow(text: str, opening: str, closing: str, where: str) -> list[str]:
    if not (text.startswith(opening) and text.endswith(closing)):
        raise ImportSourceUnreadable(f"{where}: {text[:40]!r} is not a flow collection")
    body = text[1:-1]
    outside, _ = _outside_quotes(body)
    if any(char in "[]{}" for _, char in outside):
        raise ImportSourceUnreadable(f"{where}: nested collections are not read")
    cuts = [position for position, char in outside if char == ","]
    items = [
        body[start + 1 : end].strip()
        for start, end in zip([-1, *cuts], [*cuts, len(body)], strict=True)
    ]
    if items and not items[-1]:
        items.pop()
    if any(not item for item in items):
        raise ImportSourceUnreadable(f"{where}: an empty item in {text[:40]!r}")
    return items


def _split_unquoted(text: str, separator: str) -> tuple[str, str, str]:
    outside, _ = _outside_quotes(text)
    for position, char in outside:
        if char == separator:
            return text[:position], separator, text[position + 1 :]
    return text, "", ""


def _outside_quotes(text: str) -> tuple[list[tuple[int, str]], bool]:
    """Every character outside a quoted string, by position, and whether a quote is left open.

    A quote opens a string only where YAML lets one start, so the apostrophe in
    a plain ``don't`` is a character, not a delimiter.
    """
    outside: list[tuple[int, str]] = []
    quote = ""
    position = 0
    while position < len(text):
        char = text[position]
        if quote == '"':
            if char == "\\":
                position += 1
            elif char == '"':
                quote = ""
        elif quote == "'":
            if char == "'" and text[position + 1 : position + 2] == "'":
                position += 1
            elif char == "'":
                quote = ""
        elif char in "'\"" and text[:position].rstrip(" \t")[-1:] in ("", "[", "{", ",", ":"):
            quote = char
        else:
            outside.append((position, char))
        position += 1
    return outside, bool(quote)


def _depth(text: str) -> int:
    outside = "".join(char for _, char in _outside_quotes(text)[0])
    return outside.count("[") + outside.count("{") - outside.count("]") - outside.count("}")


def _uncommented(line: str, where: str) -> str:
    """The line before a ``#`` that starts a comment, which is never one inside quotes."""
    outside, unclosed = _outside_quotes(line)
    for position, char in outside:
        if char == "#" and (position == 0 or line[position - 1] in " \t"):
            return line[:position]
    if unclosed:
        raise ImportSourceUnreadable(f"{where}: a quoted string is not closed")
    return line
