"""KITTI's camera-frame boxes moved into the lidar frame, proven by projecting back.

The projection here is written independently of the importer, from KITTI's own
conventions: ``x_rect = R0_rect · (R · x_velo + t)``, ``location`` the bottom
centre (camera y points down), ``rotation_y`` the heading ``(cos ry, 0, -sin ry)``,
and the devkit's ``compute_box_3d`` corner layout.
"""

from __future__ import annotations

import itertools
import math

import pytest

from visionset.formats.kitti.frames import CameraToLidar, Matrix, Vector, camera_box_to_lidar

NOMINAL: Matrix = ((0.0, -1.0, 0.0), (0.0, 0.0, -1.0), (1.0, 0.0, 0.0))
IDENTITY: Matrix = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
OFFSET: Vector = (-0.027, -0.061, -0.332)


def _mul(a: Matrix, b: Matrix) -> Matrix:
    columns = list(zip(*b, strict=True))
    row0, row1, row2 = (
        (
            sum(x * y for x, y in zip(row, columns[0], strict=True)),
            sum(x * y for x, y in zip(row, columns[1], strict=True)),
            sum(x * y for x, y in zip(row, columns[2], strict=True)),
        )
        for row in a
    )
    return (row0, row1, row2)


def _apply(m: Matrix, v: Vector) -> Vector:
    return (
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    )


def _rotation(rx: float, ry: float, rz: float) -> Matrix:
    cx, sx, cy, sy, cz, sz = (
        math.cos(rx),
        math.sin(rx),
        math.cos(ry),
        math.sin(ry),
        math.cos(rz),
        math.sin(rz),
    )
    x: Matrix = ((1, 0, 0), (0, cx, -sx), (0, sx, cx))
    y: Matrix = ((cy, 0, sy), (0, 1, 0), (-sy, 0, cy))
    z: Matrix = ((cz, -sz, 0), (sz, cz, 0), (0, 0, 1))
    return _mul(z, _mul(y, x))


#: A real rig is a few hundredths of a radian off the nominal axes.
TILTED: Matrix = _mul(_rotation(0.012, -0.021, 0.017), NOMINAL)
RECT: Matrix = _rotation(0.004, -0.0085, 0.0101)


def _to_rect(r0: Matrix, rotation: Matrix, point: Vector) -> Vector:
    velo = _apply(rotation, point)
    return _apply(r0, (velo[0] + OFFSET[0], velo[1] + OFFSET[1], velo[2] + OFFSET[2]))


def _to_label(
    center: Vector, size_lwh: Vector, yaw: float, r0: Matrix, rotation: Matrix
) -> tuple[Vector, Vector, float]:
    """A lidar box written as KITTI writes it: bottom-centre location, h w l, rotation_y."""
    length, width, height = size_lwh
    middle = _to_rect(r0, rotation, center)
    location = (middle[0], middle[1] + height / 2, middle[2])
    heading = _apply(_mul(r0, rotation), (math.cos(yaw), math.sin(yaw), 0.0))
    return location, (height, width, length), math.atan2(-heading[2], heading[0])


def _wrap(angle: float) -> float:
    return math.atan2(math.sin(angle), math.cos(angle))


def _angle_between(a: float, b: float) -> float:
    return abs(_wrap(a - b))


YAWS = [-math.pi, -2.5, -math.pi / 2, -0.3, 0.0, 0.7, math.pi / 2, 2.9, math.pi]
CENTERS: list[Vector] = [(8.7, -1.9, -0.6), (35.0, 4.2, -1.1), (12.0, 0.0, 0.4)]


@pytest.mark.parametrize("yaw", YAWS)
@pytest.mark.parametrize("center", CENTERS)
def test_a_box_survives_the_round_trip_through_nominal_axes_exactly(
    center: Vector, yaw: float
) -> None:
    size = (4.2, 1.8, 1.5)
    location, dims, rotation_y = _to_label(center, size, yaw, IDENTITY, NOMINAL)

    box = camera_box_to_lidar(
        location, dims, rotation_y, CameraToLidar.of(IDENTITY, NOMINAL, OFFSET)
    )

    assert box.center == pytest.approx(center, abs=1e-6)
    assert box.size == pytest.approx(size, abs=1e-6)
    assert _angle_between(box.yaw, yaw) < 1e-8
    assert -math.pi <= box.yaw <= math.pi


@pytest.mark.parametrize("rotation_y", [-math.pi, -1.57, -0.2, 0.0, 0.01, 1.85, math.pi])
def test_on_nominal_axes_the_yaw_is_minus_rotation_y_minus_a_quarter_turn(
    rotation_y: float,
) -> None:
    box = camera_box_to_lidar(
        (1.84, 1.47, 8.41),
        (1.89, 0.48, 1.2),
        rotation_y,
        CameraToLidar.of(IDENTITY, NOMINAL, OFFSET),
    )

    assert _angle_between(box.yaw, -rotation_y - math.pi / 2) < 1e-8


@pytest.mark.parametrize("yaw", YAWS)
@pytest.mark.parametrize("center", CENTERS)
def test_a_box_survives_the_round_trip_through_a_tilted_calibration(
    center: Vector, yaw: float
) -> None:
    size = (3.7, 1.9, 1.7)
    location, dims, rotation_y = _to_label(center, size, yaw, RECT, TILTED)

    box = camera_box_to_lidar(location, dims, rotation_y, CameraToLidar.of(RECT, TILTED, OFFSET))

    assert box.center == pytest.approx(center, abs=1e-6)
    assert box.size == pytest.approx(size, abs=1e-6)
    # The tilt between camera y and lidar z is a pitch the cuboid has no slot for.
    assert _angle_between(box.yaw, yaw) < 1e-3


def _devkit_corners(location: Vector, dims: Vector, rotation_y: float) -> list[Vector]:
    """KITTI devkit ``compute_box_3d``: corners in the rectified camera frame."""
    height, width, length = dims
    xs = [length / 2, length / 2, -length / 2, -length / 2] * 2
    ys = [0.0] * 4 + [-height] * 4
    zs = [width / 2, -width / 2, -width / 2, width / 2] * 2
    c, s = math.cos(rotation_y), math.sin(rotation_y)
    return [
        (c * x + s * z + location[0], y + location[1], -s * x + c * z + location[2])
        for x, y, z in zip(xs, ys, zs, strict=True)
    ]


def _cuboid_corners(center: Vector, size: Vector, yaw: float) -> list[Vector]:
    length, width, height = size
    c, s = math.cos(yaw), math.sin(yaw)
    return [
        (
            center[0] + a * length / 2 * c - b * width / 2 * s,
            center[1] + a * length / 2 * s + b * width / 2 * c,
            center[2] + h * height / 2,
        )
        for a, b, h in itertools.product((1, -1), repeat=3)
    ]


@pytest.mark.parametrize("rotation_y", [-2.7, -1.57, 0.0, 0.4, 1.85, 3.1])
def test_the_lidar_cuboid_has_the_corners_the_devkit_draws(rotation_y: float) -> None:
    location, dims = (3.18, 2.27, 34.38), (1.41, 1.58, 4.36)
    transform = CameraToLidar.of(IDENTITY, NOMINAL, OFFSET)

    box = camera_box_to_lidar(location, dims, rotation_y, transform)
    expected = [transform.point(corner) for corner in _devkit_corners(location, dims, rotation_y)]
    actual = _cuboid_corners(box.center, box.size, box.yaw)

    for corner in expected:
        assert any(math.dist(corner, other) < 1e-5 for other in actual), corner
    assert len(actual) == len(expected) == 8


def test_a_singular_calibration_is_refused() -> None:
    flat: Matrix = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 0.0))
    with pytest.raises(ValueError, match="singular"):
        CameraToLidar.of(flat, NOMINAL, OFFSET)
