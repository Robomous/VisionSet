"""Default PointCloudProcessor adapter: PCD and PLY scans read with the standard library.

Pillow draws the bird's-eye thumbnail; nothing else is a dependency. Only ``x``,
``y`` and ``z`` are ever decoded to values — every other field is checked for
presence and for the bytes being there, which is all ``probe`` reports.
"""

from __future__ import annotations

import io
import math
import struct
import sys
from array import array
from collections.abc import Sequence
from dataclasses import dataclass
from typing import BinaryIO, Final

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


@dataclass(frozen=True)
class _Cloud:
    """The finite points of one scan, and which optional fields it carries."""

    format: PointCloudFormat
    xs: array[float]
    ys: array[float]
    zs: array[float]
    fields: tuple[str, ...]

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
) -> _Cloud:
    kx: array[float] = array("d")
    ky: array[float] = array("d")
    kz: array[float] = array("d")
    isfinite = math.isfinite
    for x, y, z in zip(xs, ys, zs, strict=True):
        if isfinite(x) and isfinite(y) and isfinite(z):
            kx.append(x)
            ky.append(y)
            kz.append(z)
    if not kx:
        raise _corrupt("every point has a non-finite coordinate", name)
    return _Cloud(fmt, kx, ky, kz, fields)


def _canonical(present: set[str]) -> tuple[str, ...]:
    return tuple(field for field in POINT_CLOUD_FIELDS if field in present)


def _unpack_rows(
    buffer: bytes | memoryview,
    rows: int,
    row_size: int,
    layout: Sequence[tuple[int, str]],
    endian: str,
) -> tuple[array[float], array[float], array[float]]:
    """Pull the ``(offset, code)`` x, y, z values out of ``rows`` fixed-size records."""
    order = sorted(range(3), key=lambda k: layout[k][0])
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
    columns: list[array[float]] = [array("d"), array("d"), array("d")]
    ordered = [columns[k] for k in order]
    for record in parsed.iter_unpack(buffer[: rows * row_size]):
        for column, value in zip(ordered, record, strict=True):
            column.append(value)
    return columns[0], columns[1], columns[2]


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


def _decode_pcd(content: BinaryIO, lines: list[str], name: str | None) -> _Cloud:
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

    if mode == "ascii":
        columns = _decode_pcd_ascii(content, points, counts, xyz_index, name)
        return _finalize(PointCloudFormat.PCD, *columns, out_fields, name)

    needed = points * row_size
    if needed > _port.MAX_POINT_CLOUD_BYTES:
        raise _unsupported(f"{needed} bytes of point data is over the limit", name)
    if mode == "binary":
        buffer = content.read(needed)
        if len(buffer) < needed:
            raise _corrupt("the binary point data is truncated", name)
        layout = [(offsets[k], codes[k]) for k in xyz_index]
        columns = _unpack_rows(buffer, points, row_size, layout, "<")
        return _finalize(PointCloudFormat.PCD, *columns, out_fields, name)

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
    arrays: list[array[float]] = []
    for k in xyz_index:
        start = points * offsets[k]
        block = array(codes[k])
        block.frombytes(raw[start : start + points * sizes[k]])
        if sys.byteorder == "big":
            block.byteswap()
        arrays.append(array("d", block))
    return _finalize(PointCloudFormat.PCD, arrays[0], arrays[1], arrays[2], out_fields, name)


def _ascii_rows(
    content: BinaryIO,
    rows: int,
    columns: int,
    picks: Sequence[int],
    what: str,
    name: str | None,
) -> tuple[array[float], array[float], array[float]]:
    out: tuple[array[float], array[float], array[float]] = (array("d"), array("d"), array("d"))
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
    xyz_index: list[int],
    name: str | None,
) -> tuple[array[float], array[float], array[float]]:
    starts = [sum(counts[:k]) for k in range(len(counts))]
    return _ascii_rows(content, points, sum(counts), [starts[k] for k in xyz_index], "point", name)


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


def _decode_ply(content: BinaryIO, lines: list[str], name: str | None) -> _Cloud:
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
    return _finalize(PointCloudFormat.PLY, *columns, out_fields, name)


def _decode(content: BinaryIO, name: str | None) -> _Cloud:
    """Every finite point of the scan, or a ``MediaError`` naming why not.

    Whatever a hostile header provokes in ``struct``, ``array`` or arithmetic is
    a fault in this one file, so it is refused as ``CorruptMedia`` rather than
    escaping as an error an ingest run would take for a broken machine.
    """
    try:
        fmt, lines = _read_header(content, name)
        if fmt is PointCloudFormat.PCD:
            return _decode_pcd(content, lines, name)
        return _decode_ply(content, lines, name)
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
