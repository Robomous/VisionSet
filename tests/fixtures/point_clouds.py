"""Tiny point-cloud scans written by the test that needs them, never committed."""

from __future__ import annotations

import struct
from collections.abc import Sequence
from pathlib import Path

Point = tuple[float, float, float]

#: A few metres of road: one point ahead, one to the left, one high up.
SCAN: tuple[Point, ...] = ((10.0, 0.0, 0.0), (0.0, 4.0, 0.5), (2.0, -1.0, 3.0))


def pcd_ascii(points: Sequence[Point] = SCAN) -> bytes:
    """An unorganized ascii PCD holding x, y and z."""
    header = (
        "# .PCD v0.7 - Point Cloud Data file format\n"
        "VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n"
        f"WIDTH {len(points)}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\n"
        f"POINTS {len(points)}\nDATA ascii\n"
    )
    rows = "".join(f"{x} {y} {z}\n" for x, y, z in points)
    return (header + rows).encode("ascii")


def ply_binary(points: Sequence[Point] = SCAN, *, intensity: bool = True) -> bytes:
    """A little-endian binary PLY of float vertices, with an intensity per point."""
    properties = "property float x\nproperty float y\nproperty float z\n"
    if intensity:
        properties += "property float intensity\n"
    header = (
        f"ply\nformat binary_little_endian 1.0\nelement vertex {len(points)}\n"
        f"{properties}end_header\n"
    ).encode("ascii")
    layout = "<ffff" if intensity else "<fff"
    body = b"".join(
        struct.pack(layout, *point, 0.5) if intensity else struct.pack(layout, *point)
        for point in points
    )
    return header + body


def write_scans(directory: Path) -> Path:
    """A directory of one PCD and one PLY, under names whose suffixes lie."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.bin").write_bytes(pcd_ascii())
    (directory / "rear.dat").write_bytes(ply_binary(tuple((x, y + 1, z) for x, y, z in SCAN)))
    return directory
