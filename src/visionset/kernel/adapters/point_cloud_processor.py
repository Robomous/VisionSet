"""Default PointCloudProcessor adapter: PCD and PLY scans read with the standard library.

Pillow draws the bird's-eye thumbnail; nothing else is a dependency. ``probe``,
``thumbnail`` and ``read`` decode only ``x``, ``y`` and ``z`` to values — every
other field is checked for presence and for the bytes being there. ``sample``
alone also decodes intensity and colour, which a viewer draws.
"""

from __future__ import annotations

import dataclasses
import io
import math
import struct
import sys
from array import array
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, BinaryIO, Final

from PIL import Image

from visionset.kernel.adapters.pillow_image_processor import (
    _THUMBNAIL_ENCODER,
    _THUMBNAIL_PILLOW_NAME,
    _stream_name,
)
from visionset.kernel.domain.calibration import ScanFrame
from visionset.kernel.domain.media import (
    POINT_CLOUD_FIELDS,
    PointCloudBounds,
    PointCloudFormat,
    PointCloudMetadata,
)
from visionset.kernel.domain.point_sample import PointSample, decimation_stride, sample_origin
from visionset.kernel.errors import CorruptMedia, MediaError, UnsupportedMedia
from visionset.kernel.ports import point_cloud_processor as _port
from visionset.kernel.ports.image_processor import DEFAULT_THUMBNAIL_MAX_EDGE
from visionset.kernel.ports.point_cloud_processor import PointCloudReading

#: How much of a file is searched for the end of its header. A binary blob with no
#: newline in it cannot make the sniff read the whole file.
_HEADER_LIMIT: Final = 64 * 1024

_PCD_CODES: Final[dict[str, dict[int, str]]] = {
    "F": {4: "f", 8: "d"},
    "U": {1: "B", 2: "H", 4: "I", 8: "Q"},
    "I": {1: "b", 2: "h", 4: "i", 8: "q"},
}

_PLY_CODES: Final[dict[str, str]] = {
    "char": "b",
    "int8": "b",
    "uchar": "B",
    "uint8": "B",
    "short": "h",
    "int16": "h",
    "ushort": "H",
    "uint16": "H",
    "int": "i",
    "int32": "i",
    "uint": "I",
    "uint32": "I",
    "float": "f",
    "float32": "f",
    "double": "d",
    "float64": "d",
}

#: The longest ascii row read, and the most rows an element skipped on the way
#: to the vertices may declare relative to the point limit: a mesh has a few
#: faces per vertex, never billions.
_LINE_LIMIT: Final = 64 * 1024
_SKIPPED_ROWS_PER_POINT: Final = 8

_FLOAT_CODES: Final = frozenset("fd")
_PCD_DATA_MODES: Final = ("ascii", "binary", "binary_compressed")
_PLY_ENDIANS: Final = {"binary_little_endian": "<", "binary_big_endian": ">"}


def _corrupt(reason: str, name: str | None) -> CorruptMedia:
    return CorruptMedia(reason, name=name)


def _unsupported(reason: str, name: str | None) -> UnsupportedMedia:
    return UnsupportedMedia(reason, name=name)


#: An optional column decoded beside the coordinates for ``sample``: how it was
#: declared (a struct code, or ``_PACKED``/``_PACKED_FLOAT`` for PCD colour) and its values.
_Extra = tuple[str, "array[Any]"]
_PACKED: Final = "packed"
_PACKED_FLOAT: Final = "packed_float"
_F32_MAX: Final = 3.4028234663852886e38


@dataclass(frozen=True)
class _Cloud:
    """The finite points of one scan, and which optional fields it carries."""

    format: PointCloudFormat
    xs: array[float]
    ys: array[float]
    zs: array[float]
    fields: tuple[str, ...]
    extras: dict[str, _Extra] = dataclasses.field(default_factory=dict)

    def axis(self, index: int) -> array[float]:
        return (self.xs, self.ys, self.zs)[index]


def _lzf_decompress(data: bytes, expected: int, name: str | None) -> bytes:
    """Decode an LZF stream whose output must be exactly ``expected`` bytes."""
    out = bytearray()
    i = 0
    n = len(data)
    while i < n:
        control = data[i]
        i += 1
        if control < 32:
            length = control + 1
            if i + length > n or len(out) + length > expected:
                raise _corrupt("LZF literal run overruns its data", name)
            out += data[i : i + length]
            i += length
            continue
        length = control >> 5
        if length == 7:
            if i >= n:
                raise _corrupt("LZF stream ends inside a back-reference", name)
            length += data[i]
            i += 1
        if i >= n:
            raise _corrupt("LZF stream ends inside a back-reference", name)
        distance = ((control & 0x1F) << 8) + data[i] + 1
        i += 1
        length += 2
        start = len(out) - distance
        if start < 0:
            raise _corrupt("LZF back-reference points before the output start", name)
        if len(out) + length > expected:
            raise _corrupt("LZF output exceeds its declared size", name)
        pattern = out[start:]
        out += (pattern * (length // distance + 1))[:length]
    if len(out) != expected:
        raise _corrupt("LZF output does not match its declared size", name)
    return bytes(out)


def _read_header(content: BinaryIO, name: str | None) -> tuple[PointCloudFormat, list[str]]:
    """Sniff the format from the first bytes, then return the header lines up to its end."""
    content.seek(0)
    fmt: PointCloudFormat | None = None
    lines: list[str] = []
    used = 0
    while True:
        raw = content.readline(_HEADER_LIMIT - used + 1)
        used += len(raw)
        if not raw or used > _HEADER_LIMIT:
            if fmt is None:
                raise _unsupported("not a PCD or PLY point cloud", name)
            raise _corrupt("the header never ends", name)
        line = raw.decode("latin-1").strip()
        if fmt is None:
            if not lines and line == "ply":
                fmt = PointCloudFormat.PLY
            elif line.startswith("#"):
                continue
            elif line.startswith(("VERSION", "FIELDS")):
                fmt = PointCloudFormat.PCD
            else:
                raise _unsupported("not a PCD or PLY point cloud", name)
            if fmt is PointCloudFormat.PLY:
                lines.append(line)
                continue
        lines.append(line)
        key = line.split(None, 1)[0] if line else ""
        if fmt is PointCloudFormat.PCD and key == "DATA":
            return fmt, lines
        if fmt is PointCloudFormat.PLY and line == "end_header":
            return fmt, lines


def _finalize(
    fmt: PointCloudFormat,
    xs: Sequence[float],
    ys: Sequence[float],
    zs: Sequence[float],
    fields: tuple[str, ...],
    name: str | None,
    extras: dict[str, _Extra] | None = None,
) -> _Cloud:
    kx: array[float] = array("d")
    ky: array[float] = array("d")
    kz: array[float] = array("d")
    isfinite = math.isfinite
    if not extras:
        for x, y, z in zip(xs, ys, zs, strict=True):
            if isfinite(x) and isfinite(y) and isfinite(z):
                kx.append(x)
                ky.append(y)
                kz.append(z)
        kept: dict[str, _Extra] = {}
    else:
        keys = list(extras)
        outs = [array(extras[key][1].typecode) for key in keys]
        for x, y, z, *rest in zip(xs, ys, zs, *(extras[key][1] for key in keys), strict=True):
            if isfinite(x) and isfinite(y) and isfinite(z):
                kx.append(x)
                ky.append(y)
                kz.append(z)
                for out, value in zip(outs, rest, strict=True):
                    out.append(value)
        kept = {key: (extras[key][0], out) for key, out in zip(keys, outs, strict=True)}
    if not kx:
        raise _corrupt("every point has a non-finite coordinate", name)
    return _Cloud(fmt, kx, ky, kz, fields, kept)


def _canonical(present: set[str]) -> tuple[str, ...]:
    return tuple(field for field in POINT_CLOUD_FIELDS if field in present)


def _unpack_rows(
    buffer: bytes | memoryview,
    rows: int,
    row_size: int,
    layout: Sequence[tuple[int, str]],
    endian: str,
) -> list[array[Any]]:
    """Pull the ``(offset, code)`` columns out of ``rows`` fixed-size records.

    The first three are x, y and z, held as doubles; any further column keeps its
    own code, so an optional field costs what the file spent on it.
    """
    order = sorted(range(len(layout)), key=lambda k: layout[k][0])
    parts = [endian]
    cursor = 0
    for k in order:
        offset, code = layout[k]
        if offset > cursor:
            parts.append(f"{offset - cursor}x")
        parts.append(code)
        cursor = offset + struct.calcsize(code)
    if row_size > cursor:
        parts.append(f"{row_size - cursor}x")
    parsed = struct.Struct("".join(parts))
    columns: list[array[Any]] = [
        array("d" if k < 3 else code) for k, (_, code) in enumerate(layout)
    ]
    ordered = [columns[k] for k in order]
    for record in parsed.iter_unpack(buffer[: rows * row_size]):
        for column, value in zip(ordered, record, strict=True):
            column.append(value)
    return columns


def _ints(header: dict[str, list[str]], key: str, name: str | None) -> list[int]:
    try:
        return [int(token) for token in header[key]]
    except ValueError:
        raise _corrupt(f"the PCD header's {key} is not numeric", name) from None


def _first(header: dict[str, list[str]], key: str, name: str | None) -> int:
    values = _ints(header, key, name)
    if len(values) != 1:
        raise _corrupt(f"the PCD header's {key} is not one number", name)
    return values[0]


def _decode_pcd(
    content: BinaryIO, lines: list[str], name: str | None, want_extras: bool = False
) -> _Cloud:
    header: dict[str, list[str]] = {}
    for line in lines:
        if not line or line.startswith("#"):
            continue
        key, *values = line.split()
        header[key.upper()] = values
    for key in ("FIELDS", "SIZE", "TYPE", "DATA"):
        if key not in header:
            raise _corrupt(f"the PCD header has no {key}", name)
    fields = header["FIELDS"]
    sizes = _ints(header, "SIZE", name)
    types = header["TYPE"]
    counts = _ints(header, "COUNT", name) if "COUNT" in header else [1] * len(fields)
    if not len(fields) == len(sizes) == len(types) == len(counts):
        raise _corrupt("the PCD header's FIELDS, SIZE, TYPE and COUNT disagree in length", name)
    if any(size < 1 for size in sizes) or any(count < 0 for count in counts):
        raise _corrupt("the PCD header declares a SIZE below 1 or a negative COUNT", name)
    organized = None
    if "WIDTH" in header and "HEIGHT" in header:
        width, height = _first(header, "WIDTH", name), _first(header, "HEIGHT", name)
        if width < 1 or height < 1:
            raise _corrupt("the PCD header declares a WIDTH or HEIGHT below 1", name)
        organized = width * height
    if "POINTS" in header:
        points = _first(header, "POINTS", name)
        if organized is not None and points != organized:
            raise _corrupt("the PCD header's POINTS is not WIDTH times HEIGHT", name)
    elif organized is not None:
        points = organized
    else:
        raise _corrupt("the PCD header declares neither POINTS nor WIDTH and HEIGHT", name)
    if points > _port.MAX_POINT_CLOUD_POINTS:
        raise _unsupported(
            f"{points} points is over the {_port.MAX_POINT_CLOUD_POINTS} a scan may hold", name
        )
    if points < 1:
        raise _corrupt("the PCD header declares no points", name)
    mode = header["DATA"][0] if header["DATA"] else ""
    if mode not in _PCD_DATA_MODES:
        raise _unsupported(f"PCD DATA {mode!r} is not read", name)

    codes: list[str] = []
    for field, size, kind in zip(fields, sizes, types, strict=True):
        code = _PCD_CODES.get(kind, {}).get(size)
        if code is None and field != "_":
            raise _unsupported(
                f"PCD field {field} has an unsupported TYPE {kind} SIZE {size}", name
            )
        codes.append(code or "")
    widths = [size * count for size, count in zip(sizes, counts, strict=True)]
    offsets = [sum(widths[:k]) for k in range(len(fields))]
    row_size = sum(widths)

    def find(field: str) -> int | None:
        for k, candidate in enumerate(fields):
            if candidate == field and counts[k] == 1:
                return k
        return None

    xyz = [find(axis) for axis in "xyz"]
    if any(k is None for k in xyz) or any(types[k] != "F" for k in xyz if k is not None):
        raise _unsupported("a PCD needs float x, y and z fields", name)
    xyz_index = [k for k in xyz if k is not None]
    present = {"x", "y", "z"}
    if find("intensity") is not None:
        present.add("intensity")
    if find("rgb") is not None or find("rgba") is not None:
        present.add("rgb")
    out_fields = _canonical(present)

    # Each optional column: its field index, the code it is read with, and the kind recorded.
    wanted: dict[str, tuple[int, str, str]] = {}
    if want_extras:
        intensity = find("intensity")
        if intensity is not None:
            wanted["intensity"] = (intensity, codes[intensity], codes[intensity])
        colour = find("rgb")
        if colour is None:
            colour = find("rgba")
        if colour is not None and sizes[colour] == 4:
            kind = _PACKED_FLOAT if types[colour] == "F" and mode == "ascii" else _PACKED
            wanted["rgb"] = (colour, "I", kind)
    picks = xyz_index + [index for index, _, _ in wanted.values()]

    def finish(columns: Sequence[array[Any]]) -> _Cloud:
        extras = {
            key: (kind, column)
            for (key, (_, _, kind)), column in zip(wanted.items(), columns[3:], strict=True)
        }
        return _finalize(
            PointCloudFormat.PCD, columns[0], columns[1], columns[2], out_fields, name, extras
        )

    if mode == "ascii":
        return finish(_decode_pcd_ascii(content, points, counts, picks, name))

    needed = points * row_size
    if needed > _port.MAX_POINT_CLOUD_BYTES:
        raise _unsupported(f"{needed} bytes of point data is over the limit", name)
    read_codes = [codes[k] for k in xyz_index] + [code for _, code, _ in wanted.values()]
    if mode == "binary":
        buffer = content.read(needed)
        if len(buffer) < needed:
            raise _corrupt("the binary point data is truncated", name)
        layout = [(offsets[k], code) for k, code in zip(picks, read_codes, strict=True)]
        columns = _unpack_rows(buffer, points, row_size, layout, "<")
        # Up to MAX_POINT_CLOUD_BYTES of raw rows; released before the finite-point copy.
        del buffer
        return finish(columns)

    sizes_raw = content.read(8)
    if len(sizes_raw) < 8:
        raise _corrupt("the compressed point data is truncated", name)
    compressed, uncompressed = struct.unpack("<II", sizes_raw)
    if uncompressed != needed:
        raise _corrupt("the compressed point data does not match the declared points", name)
    # LZF's worst case expands its input by one control byte per 32 literal bytes.
    if compressed > needed + needed // 32 + 1:
        raise _corrupt("the compressed point data is larger than LZF can make it", name)
    blob = content.read(compressed)
    if len(blob) < compressed:
        raise _corrupt("the compressed point data is truncated", name)
    raw = memoryview(_lzf_decompress(blob, uncompressed, name))
    del blob
    arrays: list[array[Any]] = []
    for position, (k, code) in enumerate(zip(picks, read_codes, strict=True)):
        start = points * offsets[k]
        block = array(code)
        block.frombytes(raw[start : start + points * sizes[k]])
        if sys.byteorder == "big":
            block.byteswap()
        arrays.append(array("d", block) if position < 3 else block)
    del raw
    return finish(arrays)


def _ascii_rows(
    content: BinaryIO,
    rows: int,
    columns: int,
    picks: Sequence[int],
    what: str,
    name: str | None,
) -> list[array[Any]]:
    out: list[array[Any]] = [array("d") for _ in picks]
    consumed = 0
    seen = 0
    while raw := content.readline(_LINE_LIMIT + 1):
        consumed += len(raw)
        if len(raw) > _LINE_LIMIT:
            raise _corrupt(f"an ascii {what} row is longer than {_LINE_LIMIT} bytes", name)
        if consumed > _port.MAX_POINT_CLOUD_BYTES:
            raise _unsupported("the ascii point data is over the size limit", name)
        tokens = raw.split()
        if not tokens:
            continue
        if len(tokens) != columns:
            raise _corrupt(f"an ascii {what} row has {len(tokens)} values, not {columns}", name)
        try:
            values = [float(token) for token in tokens]
        except ValueError:
            raise _corrupt(f"an ascii {what} row holds a non-numeric value", name) from None
        for column, pick in zip(out, picks, strict=True):
            column.append(values[pick])
        seen += 1
        if seen == rows:
            return out
    raise _corrupt(f"the ascii {what} data ends after {seen} of {rows} rows", name)


def _decode_pcd_ascii(
    content: BinaryIO,
    points: int,
    counts: list[int],
    picks: list[int],
    name: str | None,
) -> list[array[Any]]:
    starts = [sum(counts[:k]) for k in range(len(counts))]
    return _ascii_rows(content, points, sum(counts), [starts[k] for k in picks], "point", name)


@dataclass(frozen=True)
class _PlyProperty:
    name: str
    code: str
    count_code: str | None


@dataclass(frozen=True)
class _PlyElement:
    name: str
    count: int
    properties: list[_PlyProperty]

    @property
    def has_list(self) -> bool:
        return any(p.count_code is not None for p in self.properties)

    @property
    def row_size(self) -> int:
        return sum(struct.calcsize(p.code) for p in self.properties)


def _parse_ply_header(lines: list[str], name: str | None) -> tuple[str, list[_PlyElement]]:
    mode: str | None = None
    elements: list[_PlyElement] = []
    for line in lines[1:]:
        tokens = line.split()
        if not tokens or tokens[0] in ("comment", "obj_info", "end_header"):
            continue
        if tokens[0] == "format" and len(tokens) >= 2:
            mode = tokens[1]
        elif tokens[0] == "element" and len(tokens) == 3:
            try:
                count = int(tokens[2])
            except ValueError:
                raise _corrupt("a PLY element count is not numeric", name) from None
            if count < 0:
                raise _corrupt("a PLY element count is negative", name)
            elements.append(_PlyElement(tokens[1], count, []))
        elif tokens[0] == "property" and elements:
            if len(tokens) == 5 and tokens[1] == "list":
                count_code = _PLY_CODES.get(tokens[2])
                item_code = _PLY_CODES.get(tokens[3])
                if count_code is None or item_code is None:
                    raise _unsupported("a PLY list property has an unknown type", name)
                elements[-1].properties.append(_PlyProperty(tokens[4], item_code, count_code))
            elif len(tokens) == 3:
                code = _PLY_CODES.get(tokens[1])
                if code is None:
                    raise _unsupported(f"PLY property type {tokens[1]!r} is not read", name)
                elements[-1].properties.append(_PlyProperty(tokens[2], code, None))
            else:
                raise _corrupt("a PLY property line is malformed", name)
        else:
            raise _corrupt(f"unrecognised PLY header line {tokens[0]!r}", name)
    if mode is None:
        raise _corrupt("the PLY header has no format line", name)
    for element in elements:
        names = [prop.name for prop in element.properties]
        if len(set(names)) != len(names):
            raise _corrupt(f"the PLY element {element.name!r} names a property twice", name)
    return mode, elements


def _skip_binary_element(
    content: BinaryIO, element: _PlyElement, endian: str, name: str | None
) -> None:
    if not element.has_list:
        content.seek(element.count * element.row_size, io.SEEK_CUR)
        return
    for _ in range(element.count):
        for prop in element.properties:
            if prop.count_code is None:
                skip = struct.calcsize(prop.code)
            else:
                width = struct.calcsize(prop.count_code)
                raw = content.read(width)
                if len(raw) < width:
                    raise _corrupt("the PLY data is truncated", name)
                skip = struct.unpack(endian + prop.count_code, raw)[0] * struct.calcsize(prop.code)
            if skip < 0:
                raise _corrupt("a PLY list declares a negative length", name)
            content.seek(skip, io.SEEK_CUR)


def _decode_ply(
    content: BinaryIO, lines: list[str], name: str | None, want_extras: bool = False
) -> _Cloud:
    mode, elements = _parse_ply_header(lines, name)
    if mode != "ascii" and mode not in _PLY_ENDIANS:
        raise _unsupported(f"PLY format {mode!r} is not read", name)
    vertex = next((e for e in elements if e.name == "vertex"), None)
    if vertex is None:
        raise _unsupported("a PLY with no vertex element is not a point cloud", name)
    if vertex.count > _port.MAX_POINT_CLOUD_POINTS:
        raise _unsupported(
            f"{vertex.count} points is over the {_port.MAX_POINT_CLOUD_POINTS} a scan may hold",
            name,
        )
    if vertex.count < 1:
        raise _corrupt("the PLY declares no vertices", name)
    if vertex.has_list:
        raise _unsupported("a PLY vertex with a list property is not read", name)

    names = [p.name for p in vertex.properties]
    picks = [names.index(axis) if axis in names else -1 for axis in "xyz"]
    if -1 in picks or any(vertex.properties[k].code not in _FLOAT_CODES for k in picks):
        raise _unsupported("a PLY needs float x, y and z vertex properties", name)
    present = {"x", "y", "z"}
    if "intensity" in names:
        present.add("intensity")
    if {"red", "green", "blue"} <= set(names):
        present.add("rgb")
    out_fields = _canonical(present)
    wanted: list[str] = [
        key
        for key in ("intensity", "red", "green", "blue")
        if want_extras and (key == "intensity" or "rgb" in present) and key in names
    ]
    picks = picks + [names.index(key) for key in wanted]

    endian = "<" if mode == "ascii" else _PLY_ENDIANS[mode]
    skipped = elements[: elements.index(vertex)]
    if any(e.count > _SKIPPED_ROWS_PER_POINT * _port.MAX_POINT_CLOUD_POINTS for e in skipped):
        raise _corrupt("a PLY element before the vertices declares an implausible count", name)
    for element in skipped:
        if mode == "ascii":
            for _ in range(element.count):
                if not content.readline():
                    raise _corrupt("the PLY data is truncated", name)
        else:
            _skip_binary_element(content, element, endian, name)

    if mode == "ascii":
        columns = _ascii_rows(content, vertex.count, len(names), picks, "vertex", name)
    else:
        needed = vertex.count * vertex.row_size
        if needed > _port.MAX_POINT_CLOUD_BYTES:
            raise _unsupported(f"{needed} bytes of point data is over the limit", name)
        buffer = content.read(needed)
        if len(buffer) < needed:
            raise _corrupt("the PLY vertex data is truncated", name)
        offsets = [0]
        for prop in vertex.properties:
            offsets.append(offsets[-1] + struct.calcsize(prop.code))
        layout = [(offsets[k], vertex.properties[k].code) for k in picks]
        columns = _unpack_rows(buffer, vertex.count, vertex.row_size, layout, endian)
        del buffer
    extras = {
        key: (vertex.properties[k].code, column)
        for key, k, column in zip(wanted, picks[3:], columns[3:], strict=True)
    }
    return _finalize(
        PointCloudFormat.PLY, columns[0], columns[1], columns[2], out_fields, name, extras
    )


def _decode(content: BinaryIO, name: str | None, want_extras: bool = False) -> _Cloud:
    """Every finite point of the scan, or a ``MediaError`` naming why not.

    Whatever a hostile header provokes in ``struct``, ``array`` or arithmetic is
    a fault in this one file, so it is refused as ``CorruptMedia`` rather than
    escaping as an error an ingest run would take for a broken machine.
    """
    try:
        fmt, lines = _read_header(content, name)
        if fmt is PointCloudFormat.PCD:
            return _decode_pcd(content, lines, name, want_extras)
        return _decode_ply(content, lines, name, want_extras)
    except (struct.error, ValueError, OverflowError, IndexError) as exc:
        raise _corrupt(f"the scan will not decode ({exc.__class__.__name__})", name) from None


def _metadata(cloud: _Cloud) -> PointCloudMetadata:
    return PointCloudMetadata(
        format=cloud.format,
        point_count=len(cloud.xs),
        bounds=PointCloudBounds(
            minimum=(min(cloud.xs), min(cloud.ys), min(cloud.zs)),
            maximum=(max(cloud.xs), max(cloud.ys), max(cloud.zs)),
        ),
        fields=_canonical(set(cloud.fields)),  # type: ignore[arg-type]
    )


def _signed_range(values: array[float], sign: int) -> tuple[float, float]:
    low, high = min(values), max(values)
    return (low, high) if sign > 0 else (-high, -low)


def _draw(cloud: _Cloud, frame: ScanFrame, max_edge: int, name: str | None) -> bytes:
    """The bird's-eye raster, read straight off the decoded columns."""
    (fi, fs), (li, ls), (ui, us) = frame.forward, frame.left, frame.up
    rs = -ls
    f_min, f_max = _signed_range(cloud.axis(fi), fs)
    r_min, r_max = _signed_range(cloud.axis(li), rs)
    h_min, h_max = _signed_range(cloud.axis(ui), us)
    f_span, r_span, h_span = f_max - f_min, r_max - r_min, h_max - h_min
    longer = max(f_span, r_span)
    if not (math.isfinite(longer) and math.isfinite(h_span)):
        raise _unsupported("the points span more than a float can hold", name)
    scale = (max_edge - 1) / longer if longer > 0 else 0.0
    if not math.isfinite(scale) or not math.isfinite(longer * scale):
        # A spread too small to divide by is a single spot, drawn as one.
        scale = 0.0
    width = int(r_span * scale) + 1
    rows = int(f_span * scale) + 1

    top = array("d", [-math.inf]) * (width * rows)
    for f, r, h in zip(cloud.axis(fi), cloud.axis(li), cloud.axis(ui), strict=True):
        column = min(width - 1, int((rs * r - r_min) * scale))
        row = rows - 1 - min(rows - 1, int((fs * f - f_min) * scale))
        pixel = row * width + column
        height = us * h
        if height > top[pixel]:
            top[pixel] = height
    grey = bytearray(width * rows)
    for pixel, height in enumerate(top):
        if height != -math.inf:
            grey[pixel] = 255 if h_span <= 0 else 64 + round(191 * (height - h_min) / h_span)

    buffer = io.BytesIO()
    Image.frombytes("L", (width, rows), bytes(grey)).save(
        buffer, format=_THUMBNAIL_PILLOW_NAME, **_THUMBNAIL_ENCODER
    )
    return buffer.getvalue()


def _clamped_f32(values: array[Any]) -> array[float]:
    """``values`` as float32, with anything beyond float32's range held at its edge."""
    if min(values) >= -_F32_MAX and max(values) <= _F32_MAX:
        return array("f", values)
    return array("f", (min(_F32_MAX, max(-_F32_MAX, v)) for v in values))


def _le_bytes(values: array[Any]) -> bytes:
    if sys.byteorder == "big":
        values.byteswap()
    return values.tobytes()


def _positions(cloud: _Cloud, stride: int, origin: tuple[float, float, float]) -> bytes:
    count = len(range(0, len(cloud.xs), stride))
    positions = array("f", bytes(12 * count))
    for axis in range(3):
        values = cloud.axis(axis)[::stride]
        if offset := origin[axis]:
            values = array("d", (v - offset for v in values))
        positions[axis::3] = _clamped_f32(values)
    return _le_bytes(positions)


def _intensity(cloud: _Cloud, stride: int) -> bytes | None:
    """Intensity as float32; a value that is not finite reads as 0."""
    if "intensity" not in cloud.extras:
        return None
    isfinite = math.isfinite
    values = cloud.extras["intensity"][1][::stride]
    return _le_bytes(
        array("f", (min(_F32_MAX, max(-_F32_MAX, v)) if isfinite(v) else 0.0 for v in values))
    )


def _packed(value: float, as_float: bool) -> int:
    """PCD's ``0x00RRGGBB``, from the integer stored or a float32 holding its bits."""
    if not math.isfinite(value):
        return 0
    if as_float:
        try:
            unpacked: int = struct.unpack("<I", struct.pack("<f", value))[0]
        except (OverflowError, struct.error):
            return 0
        return unpacked
    return int(value)


def _channel_byte(value: float, code: str) -> int:
    """One PLY colour channel as 0-255: bytes as stored, 16 bits scaled down, floats as 0-1."""
    if not math.isfinite(value):
        return 0
    if code in _FLOAT_CODES:
        return round(min(1.0, max(0.0, value)) * 255)
    if code == "H":
        return min(255, max(0, int(value) >> 8))
    return min(255, max(0, int(value)))


def _rgb(cloud: _Cloud, stride: int) -> bytes | None:
    count = len(range(0, len(cloud.xs), stride))
    out = bytearray(3 * count)
    if "rgb" in cloud.extras:
        kind, column = cloud.extras["rgb"]
        packed = [_packed(v, kind == _PACKED_FLOAT) for v in column[::stride]]
        for channel, shift in enumerate((16, 8, 0)):
            out[channel::3] = bytes((p >> shift) & 0xFF for p in packed)
        return bytes(out)
    if not {"red", "green", "blue"} <= cloud.extras.keys():
        return None
    for channel, key in enumerate(("red", "green", "blue")):
        code, column = cloud.extras[key]
        sub = column[::stride]
        if code == "B" and sub.typecode == "B":
            out[channel::3] = sub.tobytes()
        else:
            out[channel::3] = bytes(_channel_byte(v, code) for v in sub)
    return bytes(out)


class StdlibPointCloudProcessor:
    """Reads PCD and PLY scans (ascii, binary, and LZF-compressed PCD) without NumPy."""

    def probe(self, content: BinaryIO, *, name: str | None = None) -> PointCloudMetadata:
        """What this scan is. See :class:`~visionset.kernel.ports.PointCloudProcessor`."""
        return _metadata(_decode(content, _stream_name(content, name)))

    def thumbnail(
        self,
        content: BinaryIO,
        *,
        frame: ScanFrame,
        max_edge: int = DEFAULT_THUMBNAIL_MAX_EDGE,
        name: str | None = None,
    ) -> bytes:
        """A grey JPEG seen from above: forward up the picture, brighter where higher.

        The longer ground extent spans ``max_edge`` pixels; each pixel takes the
        tallest point in it, scaled over the cloud's height range to 64..255, on black.
        """
        if max_edge < 1:
            raise ValueError(f"max_edge must be at least 1 pixel, got {max_edge}")
        named = _stream_name(content, name)
        return _draw(_decode(content, named), frame, max_edge, named)

    def read(
        self,
        content: BinaryIO,
        *,
        frame: ScanFrame,
        max_edge: int = DEFAULT_THUMBNAIL_MAX_EDGE,
        name: str | None = None,
    ) -> PointCloudReading:
        """Both answers from one decode; the preview is ``None`` if it alone fails."""
        if max_edge < 1:
            raise ValueError(f"max_edge must be at least 1 pixel, got {max_edge}")
        named = _stream_name(content, name)
        cloud = _decode(content, named)
        try:
            preview: bytes | None = _draw(cloud, frame, max_edge, named)
        except MediaError:
            preview = None
        return PointCloudReading(metadata=_metadata(cloud), thumbnail=preview)

    def sample(self, content: BinaryIO, *, budget: int, name: str | None = None) -> PointSample:
        """Every ``ceil(n / budget)``-th finite point, in file order, with what it carries.

        Intensity comes back as float32, a non-finite value as 0. Colour comes
        back as 8 bits a channel: PCD ``rgb``/``rgba`` unpacked from its
        ``0x00RRGGBB``, PLY ``uchar`` channels as stored, ``ushort`` ones scaled
        down and float ones read as 0 to 1. Positions are relative to the
        origin ``sample_origin`` picks from every finite point, and one still
        beyond float32's range is held at its edge.
        """
        if budget < 1:
            raise ValueError(f"budget must be at least 1 point, got {budget}")
        named = _stream_name(content, name)
        cloud = _decode(content, named, want_extras=True)
        stride = decimation_stride(len(cloud.xs), budget)
        origin = sample_origin(cloud.xs, cloud.ys, cloud.zs)
        return PointSample(
            total=len(cloud.xs),
            stride=stride,
            origin=origin,
            positions=_positions(cloud, stride, origin),
            intensity=_intensity(cloud, stride),
            rgb=_rgb(cloud, stride),
        )
