"""A scan cuboid into KITTI's camera frame, as the exact inverse of the importer's conversion."""

from __future__ import annotations

import itertools
import math
from collections.abc import Sequence

import pytest

from visionset.formats.kitti.frames import (
    CANONICAL,
    CameraToLidar,
    LidarBox,
    LidarToCamera,
    Matrix,
    camera_box_to_lidar,
    lidar_box_to_camera,
    to_lidar_flu,
)
from visionset.kernel.domain import ScanFrame

METRES = 1e-6
RADIANS = 1e-6
TILTED: Matrix = (
    (0.017, -0.9997, 0.0122),
    (0.0109, -0.0120, -0.9998),
    (0.9998, 0.0172, 0.0107),
)


def _angle_between(a: float, b: float) -> float:
    return abs(math.remainder(a - b, 2 * math.pi))


def _close(a: Sequence[float], b: Sequence[float], tolerance: float = METRES) -> bool:
    return all(abs(x - y) <= tolerance for x, y in zip(a, b, strict=True))


YAWS = (-math.pi, -3.0, -math.pi / 2, -0.4, 0.0, 0.25, math.pi / 2, 2.9, math.pi)
CENTRES = ((10.0, 2.0, -0.5), (-4.25, -7.5, 1.1), (0.0, 0.0, 0.0))


@pytest.mark.parametrize(("center", "yaw"), list(itertools.product(CENTRES, YAWS)))
def test_the_forward_conversion_is_the_importers_exact_inverse(
    center: tuple[float, float, float], yaw: float
) -> None:
    box = LidarBox(center=center, size=(4.2, 1.8, 1.5), yaw=yaw)

    camera = lidar_box_to_camera(box, CANONICAL)
    back = camera_box_to_lidar(
        camera.location, camera.dimensions_hwl, camera.rotation_y, CANONICAL.inverse()
    )

    assert _close(back.center, box.center)
    assert back.size == box.size
    assert _angle_between(back.yaw, box.yaw) <= RADIANS
    assert -math.pi <= camera.rotation_y <= math.pi


def test_the_canonical_axes_put_lidar_forward_on_camera_z_and_up_on_camera_minus_y() -> None:
    assert CANONICAL.point((1.0, 0.0, 0.0)) == (0.0, 0.0, 1.0)
    assert CANONICAL.point((0.0, 1.0, 0.0)) == (-1.0, 0.0, 0.0)
    assert CANONICAL.point((0.0, 0.0, 1.0)) == (0.0, -1.0, 0.0)


def test_a_box_ahead_heading_forward_is_kittis_rotation_minus_half_pi() -> None:
    box = LidarBox(center=(10.0, 0.0, 0.75), size=(4.0, 1.6, 1.5), yaw=0.0)

    camera = lidar_box_to_camera(box, CANONICAL)

    assert _close(camera.location, (0.0, 0.0, 10.0))
    assert camera.dimensions_hwl == (1.5, 1.6, 4.0)
    assert camera.rotation_y == pytest.approx(-math.pi / 2)


@pytest.mark.parametrize("yaw", YAWS)
def test_rotation_y_is_minus_yaw_minus_half_pi_wrapped(yaw: float) -> None:
    camera = lidar_box_to_camera(LidarBox((5.0, 1.0, 0.0), (1.0, 1.0, 1.0), yaw), CANONICAL)

    assert _angle_between(camera.rotation_y, -yaw - math.pi / 2) <= 1e-12
    assert -math.pi <= camera.rotation_y <= math.pi


@pytest.mark.parametrize("yaw", (-2.5, 0.0, 1.0))
def test_the_inverse_holds_for_a_calibration_with_an_offset(yaw: float) -> None:
    transform = LidarToCamera(
        rect=((0.9999, 0.0098, -0.0074), (-0.0099, 0.9999, -0.0043), (0.0074, 0.0044, 1.0)),
        rotation=CANONICAL.rotation,
        translation=(-0.004, -0.076, -0.272),
    )
    box = LidarBox((12.0, -3.0, -0.6), (3.9, 1.7, 1.4), yaw)

    camera = lidar_box_to_camera(box, transform)
    back = camera_box_to_lidar(
        camera.location, camera.dimensions_hwl, camera.rotation_y, transform.inverse()
    )

    assert _close(back.center, box.center, 1e-5)
    assert _angle_between(back.yaw, box.yaw) <= 1e-3


def test_the_inverse_is_built_from_the_same_matrices() -> None:
    transform = LidarToCamera(rect=CANONICAL.rect, rotation=TILTED, translation=(0.1, -0.2, 0.3))
    point = (7.0, -2.0, 1.5)

    assert isinstance(transform.inverse(), CameraToLidar)
    assert _close(transform.inverse().point(transform.point(point)), point, 1e-9)


@pytest.mark.parametrize(
    ("frame", "vector", "flu"),
    [
        (ScanFrame.LIDAR_FLU, (1.0, 2.0, 3.0), (1.0, 2.0, 3.0)),
        # x right, y forward, z up: forward = y, left = -x.
        (ScanFrame.LIDAR_RFU, (1.0, 2.0, 3.0), (2.0, -1.0, 3.0)),
        # x right, y down, z forward: forward = z, left = -x, up = -y.
        (ScanFrame.CAMERA_RDF, (1.0, 2.0, 3.0), (3.0, -1.0, -2.0)),
    ],
)
def test_every_scan_frame_is_turned_into_lidar_flu(
    frame: ScanFrame, vector: tuple[float, float, float], flu: tuple[float, float, float]
) -> None:
    assert to_lidar_flu(vector, frame) == flu


@pytest.mark.parametrize("frame", list(ScanFrame))
def test_a_frames_heading_at_yaw_turns_into_the_same_yaw_in_lidar_flu(frame: ScanFrame) -> None:
    # In any frame the heading is cos(yaw) forward + sin(yaw) left.
    yaw = 0.7
    heading = [0.0, 0.0, 0.0]
    for (axis, sign), weight in ((frame.forward, math.cos(yaw)), (frame.left, math.sin(yaw))):
        heading[axis] += sign * weight

    x, y, _ = to_lidar_flu((heading[0], heading[1], heading[2]), frame)

    assert math.atan2(y, x) == pytest.approx(yaw)
