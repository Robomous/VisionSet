"""KITTI's rectified camera frame and its lidar frame, for one box, both ways.

A ``label_2`` box is in the rectified reference camera's frame (x right, y
down, z forward): ``location`` is the centre of its bottom face, its
dimensions are ``h, w, l`` and ``rotation_y`` turns it about the camera's y
axis, heading ``(cos ry, 0, -sin ry)``. A ``calib`` file relates the two frames:
``x_rect = R0_rect · (R · x_velo + t)``, where ``Tr_velo_to_cam = [R | t]``.

A ``cuboid_3d`` on a ``lidar_flu`` scan is a centre, ``(l, w, h)`` and a yaw
about lidar +z, heading ``(cos yaw, sin yaw, 0)``. So the centre is lifted by
``h / 2`` along camera up (``-y``) and mapped through the inverse transform,
and the heading direction is mapped through the inverse rotation and read back
as ``atan2``. With KITTI's nominal axes (``x_velo = z_cam``, ``y_velo = -x_cam``,
``z_velo = -y_cam``) that heading is ``(-sin ry, -cos ry, 0)``, so
``yaw = -ry - pi/2``, wrapped into ``[-pi, pi]``. The small tilt a real
calibration has between camera y and lidar z is a pitch and roll the cuboid
does not model; within :data:`~visionset.formats._tilt.TILT_TOLERANCE` it is
projected out of the heading, and beyond it the reader refuses the frame's
boxes rather than flattening them, as the nuScenes reader does a leaning box.

The writer goes the other way with :data:`CANONICAL`: the nominal axes with no
offset and an identity ``R0_rect``, so ``rotation_y = -yaw - pi/2`` and the
centre drops by ``h / 2`` to the bottom face. A scan in another declared frame
is first turned into ``lidar_flu`` by :func:`to_lidar_flu`, an axis permutation
that keeps a cuboid's yaw, because every frame measures yaw from its own forward
axis toward its own left.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from visionset.formats._tilt import tilt_from
from visionset.kernel.domain import ScanFrame

Vector = tuple[float, float, float]
Matrix = tuple[Vector, Vector, Vector]

#: Micrometres, so the stored numbers are the same on every platform's libm.
_DECIMALS = 6
_YAW_DECIMALS = 9
_SINGULAR = 1e-9


@dataclass(frozen=True, slots=True)
class CameraToLidar:
    """The inverse of one frame's ``R0_rect`` and ``Tr_velo_to_cam``."""

    rect_inverse: Matrix
    rotation_inverse: Matrix
    translation: Vector

    @classmethod
    def of(cls, r0_rect: Matrix, rotation: Matrix, translation: Vector) -> CameraToLidar:
        """Raises ``ValueError`` when either matrix cannot be inverted."""
        return cls(
            rect_inverse=_inverse(r0_rect),
            rotation_inverse=_inverse(rotation),
            translation=translation,
        )

    def point(self, rect: Vector) -> Vector:
        reference = _apply(self.rect_inverse, rect)
        shifted = (
            reference[0] - self.translation[0],
            reference[1] - self.translation[1],
            reference[2] - self.translation[2],
        )
        return _apply(self.rotation_inverse, shifted)

    def direction(self, rect: Vector) -> Vector:
        return _apply(self.rotation_inverse, _apply(self.rect_inverse, rect))

    @property
    def tilt(self) -> float:
        """How far camera up (``-y``) leans from the lidar's up axis, in radians."""
        return tilt_from(self.direction((0.0, -1.0, 0.0)), ScanFrame.LIDAR_FLU)


@dataclass(frozen=True, slots=True)
class LidarToCamera:
    """One frame's ``R0_rect`` and ``Tr_velo_to_cam``, applied forwards."""

    rect: Matrix
    rotation: Matrix
    translation: Vector

    def point(self, lidar: Vector) -> Vector:
        rotated = _apply(self.rotation, lidar)
        return _apply(
            self.rect,
            (
                rotated[0] + self.translation[0],
                rotated[1] + self.translation[1],
                rotated[2] + self.translation[2],
            ),
        )

    def direction(self, lidar: Vector) -> Vector:
        return _apply(self.rect, _apply(self.rotation, lidar))

    def inverse(self) -> CameraToLidar:
        return CameraToLidar.of(self.rect, self.rotation, self.translation)


IDENTITY: Matrix = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))

#: ``x_cam = -y_velo``, ``y_cam = -z_velo``, ``z_cam = x_velo``, no offset, no rectification.
CANONICAL = LidarToCamera(
    rect=IDENTITY,
    rotation=((0.0, -1.0, 0.0), (0.0, 0.0, -1.0), (1.0, 0.0, 0.0)),
    translation=(0.0, 0.0, 0.0),
)


@dataclass(frozen=True, slots=True)
class LidarBox:
    center: Vector
    size: Vector
    yaw: float


@dataclass(frozen=True, slots=True)
class CameraBox:
    """A ``label_2`` box: bottom-face centre, ``(h, w, l)`` and ``rotation_y``."""

    location: Vector
    dimensions_hwl: Vector
    rotation_y: float


def to_lidar_flu(vector: Vector, frame: ScanFrame) -> Vector:
    """A point or direction in ``frame``'s axes, written in ``lidar_flu``'s."""
    forward, left, up = frame.forward, frame.left, frame.up
    return (
        forward[1] * vector[forward[0]] + 0.0,
        left[1] * vector[left[0]] + 0.0,
        up[1] * vector[up[0]] + 0.0,
    )


def lidar_box_to_camera(box: LidarBox, transform: LidarToCamera) -> CameraBox:
    """The inverse of :func:`camera_box_to_lidar` for the same calibration, unrounded."""
    length, width, height = box.size
    x, y, z = transform.point(box.center)
    heading = transform.direction((math.cos(box.yaw), math.sin(box.yaw), 0.0))
    return CameraBox(
        location=(x, y + height / 2, z),
        dimensions_hwl=(height, width, length),
        rotation_y=math.atan2(-heading[2], heading[0]) + 0.0,
    )


def camera_box_to_lidar(
    location: Vector,
    dimensions_hwl: Vector,
    rotation_y: float,
    transform: CameraToLidar,
) -> LidarBox:
    """One ``label_2`` box as a centre, ``(l, w, h)`` and yaw in the lidar frame."""
    x, y, z = location
    height, width, length = dimensions_hwl
    center = transform.point((x, y - height / 2, z))
    heading = transform.direction((math.cos(rotation_y), 0.0, -math.sin(rotation_y)))
    yaw = round(math.atan2(heading[1], heading[0]), _YAW_DECIMALS)
    return LidarBox(
        center=(_rounded(center[0]), _rounded(center[1]), _rounded(center[2])),
        size=(_rounded(length), _rounded(width), _rounded(height)),
        yaw=min(math.pi, max(-math.pi, yaw)) + 0.0,
    )


def _rounded(value: float) -> float:
    return round(value, _DECIMALS) + 0.0


def _apply(matrix: Matrix, vector: Vector) -> Vector:
    a, b, c = matrix
    return (
        a[0] * vector[0] + a[1] * vector[1] + a[2] * vector[2],
        b[0] * vector[0] + b[1] * vector[1] + b[2] * vector[2],
        c[0] * vector[0] + c[1] * vector[1] + c[2] * vector[2],
    )


def _inverse(matrix: Matrix) -> Matrix:
    (a, b, c), (d, e, f), (g, h, i) = matrix
    cofactors = (
        (e * i - f * h, c * h - b * i, b * f - c * e),
        (f * g - d * i, a * i - c * g, c * d - a * f),
        (d * h - e * g, b * g - a * h, a * e - b * d),
    )
    determinant = a * cofactors[0][0] + b * cofactors[1][0] + c * cofactors[2][0]
    if abs(determinant) < _SINGULAR:
        raise ValueError("the matrix is singular")
    row0, row1, row2 = (
        (r[0] / determinant, r[1] / determinant, r[2] / determinant) for r in cofactors
    )
    return (row0, row1, row2)
