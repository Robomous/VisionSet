"""A stored scan's PCD bytes as the points a KITTI ``.bin`` holds: ``x, y, z, intensity``.

A KITTI or nuScenes import stores each scan as its own float32 records behind a
binary PCD header, and a directory ingest stores the file it read. This reads
uncompressed PCD, ``binary`` or ``ascii``, with any numeric field types, and
refuses the rest by name: LZF-compressed PCD and PLY. A point with a
non-finite coordinate is not a point, as at ingest, and is left out; an
intensity that is missing or not finite is written as 0.

KITTI holds float32 coordinates, so a scan whose coordinates are stored wider
and lie :data:`~visionset.kernel.domain.point_sample.POINT_ORIGIN_THRESHOLD` or
more from the origin, as a georeferenced scan's do, is refused rather than
rounded to centimetres or moved.
"""

from __future__ import annotations

import math
import struct
from array import array
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Final

from visionset.kernel.domain.point_sample import POINT_ORIGIN_THRESHOLD

#: The fields a KITTI record carries, in its order.
WANTED: Final = ("x", "y", "z", "intensity")

_CODES: Final[dict[tuple[str, int], str]] = {
    ("F", 4): "f",
    ("F", 8): "d",
    ("I", 1): "b",
    ("I", 2): "h",
    ("I", 4): "i",
    ("I", 8): "q",
    ("U", 1): "B",
    ("U", 2): "H",
    ("U", 4): "I",
    ("U", 8): "Q",
}
_HEADER_LINES: Final = 64
_FLOAT32_MAX: Final = 3.4028234663852886e38


class ScanUnreadable(Exception):
    """The bytes are not a scan this exporter can write; the message says why."""


@dataclass(frozen=True, slots=True)
class _Header:
    fields: tuple[str, ...]
    sizes: tuple[int, ...]
    types: tuple[str, ...]
    counts: tuple[int, ...]
    points: int
    data: str


def kitti_points(blob: bytes) -> array[float]:
    """Every finite point as interleaved float32 ``x, y, z, intensity``, in file order.

    Raises:
        ScanUnreadable: the bytes are PLY, compressed or malformed PCD, or hold
            wide coordinates far from the origin.
    """
    if blob.startswith(b"ply"):
        raise ScanUnreadable("it is a PLY scan, and only an uncompressed PCD is read")
    header, body = _header(blob)
    picks = _picks(header)
    if header.data == "binary":
        rows: Iterable[Sequence[float]] = _binary_rows(header, picks, body)
    else:
        rows = _ascii_rows(header, picks, body)
    narrow = all(header.types[i] == "F" and header.sizes[i] == 4 for i in picks[:3])
    out: array[float] = array("f")
    for row in rows:
        x, y, z = row[0], row[1], row[2]
        if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
            continue
        if not narrow and max(abs(x), abs(y), abs(z)) >= POINT_ORIGIN_THRESHOLD:
            raise ScanUnreadable(
                f"a coordinate lies {POINT_ORIGIN_THRESHOLD:g} or more from the origin in "
                "values wider than float32, which a KITTI scan would round"
            )
        intensity = row[3] if len(row) > 3 else 0.0
        if not math.isfinite(intensity):
            intensity = 0.0
        out.extend((x, y, z, max(-_FLOAT32_MAX, min(_FLOAT32_MAX, intensity))))
    if not out:
        raise ScanUnreadable("it holds no point with finite coordinates")
    return out


def _header(blob: bytes) -> tuple[_Header, bytes]:
    entries: dict[str, list[str]] = {}
    offset = 0
    for _ in range(_HEADER_LINES):
        end = blob.find(b"\n", offset)
        if end < 0:
            break
        line = blob[offset:end].decode("ascii", "replace").strip()
        offset = end + 1
        if not line or line.startswith("#"):
            continue
        key, *values = line.split()
        entries[key.upper()] = values
        if key.upper() == "DATA":
            return _parsed(entries), blob[offset:]
    raise ScanUnreadable("it is not a PCD file: no DATA line ends its header")


def _parsed(entries: dict[str, list[str]]) -> _Header:
    fields = tuple(entries.get("FIELDS", ()))
    data = (entries.get("DATA") or [""])[0].lower()
    if data not in ("binary", "ascii"):
        raise ScanUnreadable(
            f"its PCD data is {data or 'unnamed'!r}; only binary and ascii are read"
        )
    try:
        sizes = tuple(int(one) for one in entries.get("SIZE", ()))
        counts = tuple(int(one) for one in entries.get("COUNT", ["1"] * len(fields)))
        if "POINTS" in entries:
            points = int(entries["POINTS"][0])
        else:
            points = int(entries["WIDTH"][0]) * int(entries["HEIGHT"][0])
    except (ValueError, KeyError, IndexError):
        raise ScanUnreadable(
            "its PCD header holds a size, count or point total that is not a number"
        ) from None
    types = tuple(one.upper() for one in entries.get("TYPE", ()))
    if not fields or not len(fields) == len(sizes) == len(types) == len(counts):
        raise ScanUnreadable("its PCD header names fields without one size, type and count each")
    if points < 1 or any(count < 1 for count in counts):
        raise ScanUnreadable("its PCD header declares no points, or a field of no values")
    for name, kind, size in zip(fields, types, sizes, strict=True):
        if (kind, size) not in _CODES:
            raise ScanUnreadable(
                f"its PCD field {name!r} is of type {kind}{size}, which is not read"
            )
    return _Header(fields, sizes, types, counts, points, data)


def _picks(header: _Header) -> tuple[int, ...]:
    """The field index of ``x``, ``y``, ``z`` and, when present, ``intensity``."""
    found = [header.fields.index(name) if name in header.fields else -1 for name in WANTED]
    if min(found[:3]) < 0:
        raise ScanUnreadable("its PCD fields do not include x, y and z")
    return tuple(index for index in found if index >= 0)


def _binary_rows(header: _Header, picks: tuple[int, ...], body: bytes) -> Iterable[Sequence[float]]:
    layout = ["<"]
    for index, (kind, size, count) in enumerate(
        zip(header.types, header.sizes, header.counts, strict=True)
    ):
        if index in picks:
            layout.append(_CODES[(kind, size)])
            if count > 1:
                layout.append(f"{size * (count - 1)}x")
        else:
            layout.append(f"{size * count}x")
    record = struct.Struct("".join(layout))
    needed = record.size * header.points
    if len(body) < needed:
        raise ScanUnreadable(
            f"its PCD data is {len(body)} bytes and {header.points} points need {needed}"
        )
    ranked = sorted(picks)
    positions = [ranked.index(index) for index in picks]
    for values in record.iter_unpack(body[:needed]):
        yield tuple(float(values[position]) for position in positions)


def _ascii_rows(header: _Header, picks: tuple[int, ...], body: bytes) -> Iterable[Sequence[float]]:
    starts = [sum(header.counts[:index]) for index in range(len(header.fields))]
    columns = [starts[index] for index in picks]
    width = sum(header.counts)
    seen = 0
    for line in body.splitlines():
        tokens = line.split()
        if not tokens:
            continue
        if seen == header.points:
            break
        if len(tokens) != width:
            raise ScanUnreadable(f"an ascii PCD row has {len(tokens)} values, not {width}")
        try:
            yield tuple(float(tokens[column]) for column in columns)
        except ValueError:
            raise ScanUnreadable("an ascii PCD row holds a value that is not a number") from None
        seen += 1
    if seen < header.points:
        raise ScanUnreadable(f"its ascii PCD data ends after {seen} of {header.points} rows")
