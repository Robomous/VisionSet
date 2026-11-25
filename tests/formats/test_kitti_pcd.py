"""A stored scan's PCD bytes decoded to the float32 records a KITTI ``.bin`` holds."""

from __future__ import annotations

import struct

import pytest
from tests.fixtures.kitti_source import SCAN, scan_bytes
from tests.fixtures.point_clouds import pcd_ascii, ply_binary

from visionset.formats.kitti.pcd import ScanUnreadable, kitti_points
from visionset.kernel.domain import ScanLayout


def _pcd(
    fields: str,
    sizes: str,
    types: str,
    rows: bytes,
    points: int,
    data: str = "binary",
    counts: str | None = None,
) -> bytes:
    count = counts or " ".join("1" for _ in fields.split())
    return (
        f"VERSION 0.7\nFIELDS {fields}\nSIZE {sizes}\nTYPE {types}\nCOUNT {count}\n"
        f"WIDTH {points}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS {points}\nDATA {data}\n"
    ).encode() + rows


def test_an_imported_kitti_scan_decodes_to_its_own_bytes() -> None:
    blob = ScanLayout(fields=("x", "y", "z", "intensity")).pcd_header(len(SCAN)) + scan_bytes()

    assert kitti_points(blob).tobytes() == scan_bytes()


def test_a_nuscenes_record_drops_its_ring_field() -> None:
    rows = [(1.0, 2.0, 3.0, 40.0, 7.0), (-1.5, 0.5, -0.25, 3.0, 12.0)]
    body = b"".join(struct.pack("<fffff", *row) for row in rows)
    blob = ScanLayout(fields=("x", "y", "z", "intensity", "_")).pcd_header(2) + body

    assert list(kitti_points(blob)) == [1.0, 2.0, 3.0, 40.0, -1.5, 0.5, -0.25, 3.0]


def test_fields_in_another_order_and_type_are_read_by_name() -> None:
    body = struct.pack("<Hddd", 200, 1.5, -2.0, 0.25) + struct.pack("<Hddd", 7, 3.0, 4.0, 5.0)
    blob = _pcd("intensity z y x", "2 8 8 8", "U F F F", body, 2)

    assert list(kitti_points(blob)) == [0.25, -2.0, 1.5, 200.0, 5.0, 4.0, 3.0, 7.0]


def test_an_ascii_scan_without_intensity_is_written_with_zero_intensity() -> None:
    points = kitti_points(pcd_ascii(((10.0, 0.0, 0.0), (0.0, 4.0, 0.5))))

    assert list(points) == [10.0, 0.0, 0.0, 0.0, 0.0, 4.0, 0.5, 0.0]


def test_a_point_with_a_non_finite_coordinate_is_left_out_and_a_bad_intensity_is_zero() -> None:
    nan, inf = float("nan"), float("inf")
    body = b"".join(
        struct.pack("<ffff", *row)
        for row in (
            (nan, 0.0, 0.0, 1.0),
            (1.0, 2.0, 3.0, inf),
            (0.0, inf, 1.0, 1.0),
            (0.0, 1.0, nan, 1.0),
        )
    )

    assert list(kitti_points(_pcd("x y z intensity", "4 4 4 4", "F F F F", body, 4))) == [
        1.0,
        2.0,
        3.0,
        0.0,
    ]


def test_wide_coordinates_near_the_origin_are_narrowed() -> None:
    body = struct.pack("<ddd", 8191.5, -12.125, 0.5)

    assert list(kitti_points(_pcd("x y z", "8 8 8", "F F F", body, 1))) == [
        8191.5,
        -12.125,
        0.5,
        0.0,
    ]


def test_a_field_of_several_values_is_skipped_whole_and_a_coordinate_read_from_its_first() -> None:
    rows = [
        ((0.1, 0.2, 0.3), (1.0, 9.0), 2.0, 3.0, 0.5),
        ((0.4, 0.5, 0.6), (4.0, 9.0), 5.0, 6.0, 0.25),
    ]
    body = b"".join(
        struct.pack("<fffffff f", *normal, *x, y, z, intensity)
        for normal, x, y, z, intensity in rows
    )
    blob = _pcd("normal x y z intensity", "4 4 4 4 4", "F F F F F", body, 2, counts="3 2 1 1 1")

    assert list(kitti_points(blob)) == [1.0, 2.0, 3.0, 0.5, 4.0, 5.0, 6.0, 0.25]


def test_an_ascii_field_of_several_values_moves_the_columns_after_it() -> None:
    rows = b"0.1 0.2 0.3 1 2 3 0.5\n4.5 4.5 4.5 7 8 9 0.75\n"
    blob = _pcd("normal x y z intensity", "4 4 4 4 4", "F F F F F", rows, 2, "ascii", "3 1 1 1 1")

    assert list(kitti_points(blob)) == [1.0, 2.0, 3.0, 0.5, 7.0, 8.0, 9.0, 0.75]


def test_the_origin_threshold_itself_is_refused() -> None:
    body = struct.pack("<ddd", 0.0, -8192.0, 0.0)

    with pytest.raises(ScanUnreadable, match="8192 or more from the origin"):
        kitti_points(_pcd("x y z", "8 8 8", "F F F", body, 1))


def test_a_georeferenced_scan_is_refused_rather_than_rounded() -> None:
    body = struct.pack("<ddd", 512_345.678, 5_412_345.125, 31.5)

    with pytest.raises(ScanUnreadable, match="8192 or more from the origin"):
        kitti_points(_pcd("x y z", "8 8 8", "F F F", body, 1))


def test_float32_coordinates_far_out_are_kept_as_they_are() -> None:
    body = struct.pack("<fff", 20000.0, 1.0, 2.0)

    assert list(kitti_points(_pcd("x y z", "4 4 4", "F F F", body, 1)))[:3] == [20000.0, 1.0, 2.0]


@pytest.mark.parametrize(
    ("blob", "reason"),
    [
        (ply_binary(), "PLY"),
        (_pcd("x y z", "4 4 4", "F F F", b"\x00" * 8, 1, "binary_compressed"), "binary_compressed"),
        (_pcd("x y z", "4 4 4", "F F F", b"\x00" * 8, 1), "8 bytes and 1 points need 12"),
        (_pcd("x y intensity", "4 4 4", "F F F", b"\x00" * 12, 1), "x, y and z"),
        (_pcd("x y z", "4 4 2", "F F F", b"\x00" * 10, 1), "F2"),
        (b"not a point cloud\n", "no DATA line"),
        (_pcd("x y z", "4 4 4", "F F F", b"1 2 3\n", 2, "ascii"), "after 1 of 2 rows"),
        (struct.pack("<fff", float("nan"), 0.0, 0.0), "no DATA line"),
    ],
)
def test_what_cannot_be_written_is_refused_by_reason(blob: bytes, reason: str) -> None:
    with pytest.raises(ScanUnreadable, match=reason):
        kitti_points(blob)


def test_a_scan_of_no_finite_point_is_refused() -> None:
    body = struct.pack("<fff", float("nan"), 0.0, 0.0)

    with pytest.raises(ScanUnreadable, match="no point with finite coordinates"):
        kitti_points(_pcd("x y z", "4 4 4", "F F F", body, 1))
