"""Thinning a scan for the viewer: the stride, the fields it carries, and the buffer."""

from __future__ import annotations

import io
import math
import struct
from typing import Any

import pytest
from tests.fixtures.point_clouds import SCAN, pcd_ascii, ply_binary

from visionset.kernel.adapters import StdlibPointCloudProcessor
from visionset.kernel.domain import (
    POINT_BUFFER_HEADER,
    POINT_BUFFER_MAGIC,
    POINT_BUFFER_VERSION,
    POINT_FLAG_INTENSITY,
    POINT_FLAG_ORIGIN,
    POINT_FLAG_RGB,
    POINT_ORIGIN_THRESHOLD,
    PointSample,
    decimation_stride,
    sample_origin,
)
from visionset.kernel.errors import CorruptMedia

F32_MAX = struct.unpack("<f", b"\xff\xff\x7f\x7f")[0]


def decode(buffer: bytes) -> dict[str, Any]:
    """An independent reading of the buffer the domain module lays out."""
    magic, version, count, flags = struct.unpack_from("<4sIII", buffer)
    offset = 16
    origin = (0.0, 0.0, 0.0)
    if flags & 4:
        origin = struct.unpack_from("<3d", buffer, offset)
        offset += 24
    xyz = struct.unpack_from(f"<{3 * count}f", buffer, offset)
    offset += 12 * count
    intensity = None
    if flags & 1:
        intensity = struct.unpack_from(f"<{count}f", buffer, offset)
        offset += 4 * count
    rgb = None
    if flags & 2:
        rgb = buffer[offset : offset + 3 * count]
        offset += 3 * count
    assert offset == len(buffer)
    return {
        "magic": magic,
        "version": version,
        "flags": flags,
        "origin": origin,
        "points": [tuple(xyz[i : i + 3]) for i in range(0, 3 * count, 3)],
        "intensity": intensity,
        "rgb": None if rgb is None else [tuple(rgb[i : i + 3]) for i in range(0, 3 * count, 3)],
    }


def sample(data: bytes, budget: int = 1_000) -> PointSample:
    return StdlibPointCloudProcessor().sample(io.BytesIO(data), budget=budget)


def pcd(fields: list[tuple[str, str, int]], rows: list[tuple[Any, ...]], data: str) -> bytes:
    """A PCD of ``(name, TYPE, SIZE)`` fields; binary rows are packed by those types."""
    codes = {("F", 4): "f", ("F", 8): "d", ("U", 1): "B", ("U", 4): "I", ("U", 2): "H"}
    header = (
        "VERSION 0.7\n"
        f"FIELDS {' '.join(f[0] for f in fields)}\n"
        f"SIZE {' '.join(str(f[2]) for f in fields)}\n"
        f"TYPE {' '.join(f[1] for f in fields)}\n"
        f"COUNT {' '.join('1' for _ in fields)}\n"
        f"WIDTH {len(rows)}\nHEIGHT 1\nPOINTS {len(rows)}\nDATA {data}\n"
    ).encode()
    layout = "<" + "".join(codes[(f[1], f[2])] for f in fields)
    if data == "ascii":
        return header + "".join(" ".join(map(str, row)) + "\n" for row in rows).encode()
    if data == "binary":
        return header + b"".join(struct.pack(layout, *row) for row in rows)
    columns = b"".join(
        b"".join(struct.pack("<" + codes[(f[1], f[2])], row[k]) for row in rows)
        for k, f in enumerate(fields)
    )
    literal = b"".join(
        bytes([len(c) - 1]) + c for c in (columns[i : i + 32] for i in range(0, len(columns), 32))
    )
    return header + struct.pack("<II", len(literal), len(columns)) + literal


def ply(
    properties: list[tuple[str, str]], rows: list[tuple[Any, ...]], ascii: bool = False
) -> bytes:
    codes = {"float": "f", "double": "d", "uchar": "B", "ushort": "H"}
    props = "".join(f"property {kind} {name}\n" for name, kind in properties)
    mode = "ascii" if ascii else "binary_little_endian"
    header = f"ply\nformat {mode} 1.0\nelement vertex {len(rows)}\n{props}end_header\n".encode()
    if ascii:
        return header + "".join(" ".join(map(str, row)) + "\n" for row in rows).encode()
    layout = "<" + "".join(codes[kind] for _, kind in properties)
    return header + b"".join(struct.pack(layout, *row) for row in rows)


def packed(r: int, g: int, b: int) -> int:
    return (r << 16) | (g << 8) | b


def as_float(value: int) -> float:
    unpacked: float = struct.unpack("<f", struct.pack("<I", value))[0]
    return unpacked


XYZ = [("x", "F", 4), ("y", "F", 4), ("z", "F", 4)]
LINE = [(float(i), 0.0, 0.0) for i in range(10)]


@pytest.mark.parametrize(
    ("total", "budget", "stride"),
    [(10, 3, 4), (3, 500_000, 1), (2_000_000, 1_000, 2_000), (1_000, 1_000, 1), (1_001, 1_000, 2)],
)
def test_the_stride_is_the_ceiling_of_total_over_budget(
    total: int, budget: int, stride: int
) -> None:
    assert decimation_stride(total, budget) == stride
    assert len(range(0, total, stride)) <= budget


def test_a_budget_below_one_is_refused() -> None:
    with pytest.raises(ValueError, match="budget"):
        decimation_stride(10, 0)
    with pytest.raises(ValueError, match="budget"):
        sample(pcd_ascii(), budget=0)


def test_thinning_keeps_every_stride_th_point_in_file_order() -> None:
    data = pcd(XYZ, LINE, "binary")
    thinned = sample(data, budget=3)

    assert (thinned.total, thinned.stride, thinned.count) == (10, 4, 3)
    assert [p[0] for p in decode(thinned.encode())["points"]] == [0.0, 4.0, 8.0]


def test_the_same_scan_and_budget_give_the_same_bytes() -> None:
    data = pcd(XYZ + [("intensity", "F", 4)], [(*p, p[0] / 10) for p in LINE], "binary")
    assert sample(data, budget=4).encode() == sample(data, budget=4).encode()


def test_a_scan_within_the_budget_comes_back_whole() -> None:
    decoded = decode(sample(pcd_ascii()).encode())
    assert decoded["points"] == list(SCAN)
    assert decoded["flags"] == 0
    assert (decoded["intensity"], decoded["rgb"]) == (None, None)


def test_the_header_is_magic_version_count_flags() -> None:
    buffer = sample(ply_binary()).encode()
    assert buffer[:4] == POINT_BUFFER_MAGIC == b"VSPC"
    assert POINT_BUFFER_HEADER.size == 16
    assert struct.unpack_from("<III", buffer, 4) == (POINT_BUFFER_VERSION, 3, POINT_FLAG_INTENSITY)
    assert len(buffer) == 16 + 3 * 12 + 3 * 4


def test_ply_intensity_round_trips() -> None:
    decoded = decode(sample(ply_binary()).encode())
    assert decoded["points"] == list(SCAN)
    assert decoded["intensity"] == (0.5, 0.5, 0.5)


def test_a_non_finite_point_is_dropped_with_its_fields_before_the_stride() -> None:
    rows = [(1.0, 0.0, 0.0, 10.0), (math.nan, 0.0, 0.0, 20.0), (3.0, 0.0, 0.0, 30.0)]
    thinned = sample(pcd(XYZ + [("intensity", "F", 4)], rows, "binary"))
    decoded = decode(thinned.encode())

    assert thinned.total == 2
    assert [p[0] for p in decoded["points"]] == [1.0, 3.0]
    assert decoded["intensity"] == (10.0, 30.0)


@pytest.mark.parametrize("data", ["binary", "binary_compressed", "ascii"])
def test_pcd_rgb_float_is_unpacked_from_its_bits(data: str) -> None:
    colours = [(255, 0, 0), (0, 128, 0), (1, 2, 3)]
    rows = [(*p, as_float(packed(*c)), 0.25) for p, c in zip(SCAN, colours, strict=True)]
    fields = XYZ + [("rgb", "F", 4), ("intensity", "F", 4)]
    decoded = decode(sample(pcd(fields, rows, data)).encode())

    assert decoded["flags"] == POINT_FLAG_INTENSITY | POINT_FLAG_RGB
    assert decoded["rgb"] == colours
    assert decoded["intensity"] == (0.25, 0.25, 0.25)
    assert decoded["points"] == list(SCAN)


@pytest.mark.parametrize("data", ["binary", "ascii"])
def test_pcd_rgba_as_an_unsigned_integer_drops_alpha(data: str) -> None:
    rows = [(*p, (200 << 24) | packed(9, 8, 7)) for p in SCAN]
    decoded = decode(sample(pcd(XYZ + [("rgba", "U", 4)], rows, data)).encode())
    assert decoded["flags"] == POINT_FLAG_RGB
    assert decoded["rgb"] == [(9, 8, 7)] * 3


def test_pcd_integer_intensity_reads_as_float() -> None:
    rows = [(*p, 40000) for p in SCAN]
    decoded = decode(sample(pcd(XYZ + [("intensity", "U", 2)], rows, "binary")).encode())
    assert decoded["intensity"] == (40000.0,) * 3


@pytest.mark.parametrize("ascii", [False, True])
def test_ply_uchar_colour_is_passed_through(ascii: bool) -> None:
    props = [("x", "float"), ("y", "float"), ("z", "float")]
    props += [("red", "uchar"), ("green", "uchar"), ("blue", "uchar")]
    rows = [(*p, 10 * i, 20 * i, 255) for i, p in enumerate(SCAN)]
    decoded = decode(sample(ply(props, rows, ascii=ascii)).encode())
    assert decoded["flags"] == POINT_FLAG_RGB
    assert decoded["rgb"] == [(0, 0, 255), (10, 20, 255), (20, 40, 255)]


def test_ply_float_and_ushort_colour_are_scaled_to_a_byte() -> None:
    floats = [("x", "float"), ("y", "float"), ("z", "float")]
    floats += [("red", "float"), ("green", "float"), ("blue", "float")]
    rows = [(*p, 1.0, 0.5, 2.0) for p in SCAN]
    assert decode(sample(ply(floats, rows)).encode())["rgb"] == [(255, 128, 255)] * 3

    shorts = [("x", "float"), ("y", "float"), ("z", "float")]
    shorts += [("red", "ushort"), ("green", "ushort"), ("blue", "ushort")]
    rows = [(*p, 65535, 256, 0) for p in SCAN]
    assert decode(sample(ply(shorts, rows)).encode())["rgb"] == [(255, 1, 0)] * 3


def test_a_partial_colour_is_not_colour() -> None:
    props = [("x", "float"), ("y", "float"), ("z", "float"), ("red", "uchar"), ("green", "uchar")]
    decoded = decode(sample(ply(props, [(*p, 1, 2) for p in SCAN])).encode())
    assert decoded["flags"] == 0


def test_a_non_finite_intensity_reads_as_zero() -> None:
    rows = [(*p, value) for p, value in zip(SCAN, (math.nan, math.inf, 7.0), strict=True)]
    decoded = decode(sample(pcd(XYZ + [("intensity", "F", 4)], rows, "binary")).encode())
    assert decoded["intensity"] == (0.0, 0.0, 7.0)


def test_a_double_coordinate_beyond_float32_is_held_at_its_edge() -> None:
    fields = [("x", "F", 8), ("y", "F", 8), ("z", "F", 8)]
    rows = [(1e300, -1e300, 1.0), (0.0, 0.0, 0.0), (0.0, 0.0, 0.0)]
    decoded = decode(sample(pcd(fields, rows, "binary")).encode())
    assert decoded["points"][0] == (F32_MAX, -F32_MAX, 1.0)
    assert all(math.isfinite(v) for point in decoded["points"] for v in point)


def test_a_damaged_scan_is_refused_as_probe_refuses_it() -> None:
    with pytest.raises(CorruptMedia):
        sample(pcd(XYZ, LINE, "binary")[:-5])


def test_a_sample_whose_sections_disagree_with_its_count_is_refused() -> None:
    with pytest.raises(ValueError, match="positions"):
        PointSample(total=1, stride=1, positions=b"\0" * 11)
    with pytest.raises(ValueError, match="intensity"):
        PointSample(total=1, stride=1, positions=b"\0" * 12, intensity=b"\0" * 8)
    with pytest.raises(ValueError, match="rgb"):
        PointSample(total=1, stride=1, positions=b"\0" * 12, rgb=b"\0" * 2)


def test_an_ascii_colour_outside_its_declared_type_is_clamped_not_raised() -> None:
    props = [("x", "float"), ("y", "float"), ("z", "float")]
    props += [("red", "ushort"), ("green", "uchar"), ("blue", "ushort")]
    rows = [(*p, -5, 300, 99999999) for p in SCAN]
    assert decode(sample(ply(props, rows, ascii=True)).encode())["rgb"] == [(0, 255, 255)] * 3


def ulp32(value: float) -> float:
    """float32's spacing at ``value``."""
    bits: int = struct.unpack("<I", struct.pack("<f", value))[0]
    above: float = struct.unpack("<f", struct.pack("<I", bits + 1))[0]
    return above - struct.unpack("<f", struct.pack("<f", value))[0]


DOUBLE_XYZ = [("x", "double"), ("y", "double"), ("z", "double")]
GEOREFERENCED = [
    (512_345.678 + 0.731 * i, 4_123_456.789 - 0.417 * i, 12.345 + 0.0123 * i) for i in range(50)
]


def test_a_georeferenced_scan_keeps_float32_precision_relative_to_its_origin() -> None:
    decoded = decode(sample(ply(DOUBLE_XYZ, GEOREFERENCED)).encode())

    origin = decoded["origin"]
    error = max(
        abs(o + local - true)
        for point, original in zip(decoded["points"], GEOREFERENCED, strict=True)
        for o, local, true in zip(origin, point, original, strict=True)
    )
    assert ulp32(4_123_456.789) == 0.25
    assert error < 1e-5
    assert decoded["flags"] & POINT_FLAG_ORIGIN


def test_the_origin_is_the_rounded_median_of_each_far_axis_and_zero_otherwise() -> None:
    xs = sorted(p[0] for p in GEOREFERENCED)
    ys = sorted(p[1] for p in GEOREFERENCED)
    expected = (float(round(xs[25])), float(round(ys[25])), 0.0)

    assert sample(ply(DOUBLE_XYZ, GEOREFERENCED)).origin == expected
    assert sample(ply(DOUBLE_XYZ, GEOREFERENCED), budget=7).origin == expected


def test_a_stray_return_at_zero_does_not_pull_the_origin_off_the_scan() -> None:
    fields = [("x", "F", 8), ("y", "F", 8), ("z", "F", 8)]
    scan = pcd(fields, [(500_000.25, 4_000_000.5, 10.0), (0.0, 0.0, 0.0)], "binary")
    decoded = decode(sample(scan).encode())

    assert decoded["origin"] == (500_000.0, 4_000_000.0, 0.0)
    assert decoded["points"][0] == (0.25, 0.5, 10.0)


@pytest.mark.parametrize(
    ("column", "origin"),
    [
        ([0.0, 50.0, 100.0], 0.0),
        ([-20_000.0, -10_000.0, 0.0, 10_000.0, 20_000.0], 0.0),
        ([POINT_ORIGIN_THRESHOLD - 0.5, POINT_ORIGIN_THRESHOLD - 0.25], 0.0),
        ([POINT_ORIGIN_THRESHOLD], POINT_ORIGIN_THRESHOLD),
        ([-1e6 - 10.4, -1e6 - 0.4, -1e6 + 10.0], -1e6),
        ([0.0, 0.0, 512_345.6, 512_346.1, 512_347.0], 512_346.0),
        ([], 0.0),
    ],
)
def test_sample_origin_offsets_only_an_axis_whose_median_is_far_from_zero(
    column: list[float], origin: float
) -> None:
    zeros = [0.0] * len(column)
    assert sample_origin(column, zeros, zeros) == (origin, 0.0, 0.0)


def test_the_origin_of_a_large_scan_reads_an_even_subsample_of_every_point() -> None:
    xs = [10_000.0 + i * 1e-3 for i in range(1_000_000)]
    zeros = [0.0] * len(xs)
    assert sample_origin(xs, zeros, zeros) == (10_500.0, 0.0, 0.0)


def test_a_scan_near_zero_has_no_origin_section() -> None:
    thinned = sample(ply_binary())
    assert thinned.origin == (0.0, 0.0, 0.0)
    assert not thinned.flags & POINT_FLAG_ORIGIN
    assert len(thinned.encode()) == 16 + 3 * 12 + 3 * 4


def test_the_origin_section_sits_between_the_header_and_the_positions() -> None:
    made = PointSample(
        total=1, stride=1, positions=struct.pack("<3f", 1, 2, 3), origin=(1e6, 0, -2)
    )
    buffer = made.encode()
    assert struct.unpack_from("<III", buffer, 4) == (POINT_BUFFER_VERSION, 1, POINT_FLAG_ORIGIN)
    assert struct.unpack_from("<3d", buffer, 16) == (1e6, 0.0, -2.0)
    assert struct.unpack_from("<3f", buffer, 40) == (1.0, 2.0, 3.0)
    assert len(buffer) == 52


def test_a_non_finite_origin_is_refused() -> None:
    with pytest.raises(ValueError, match="origin"):
        PointSample(total=1, stride=1, positions=b"\0" * 12, origin=(math.inf, 0.0, 0.0))
