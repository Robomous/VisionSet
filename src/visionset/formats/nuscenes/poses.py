"""nuScenes' global frame to its LIDAR_TOP frame, for one box.

A ``sample_annotation`` is in the global frame: ``translation`` is the box's
centre, ``size`` is ``(w, l, h)`` and ``rotation`` is a unit quaternion
``(w, x, y, z)`` turning the box's own axes (x along its length, z up) into
global ones. A pose ``(R, t)`` maps a child frame into its parent,
``p_parent = R · p_child + t``: the ``ego_pose`` of a ``sample_data`` maps the
ego frame into the global one, and its ``calibrated_sensor`` maps the sensor
frame into the ego one. So a global point reaches the sensor through the
inverse of each, outermost first: ``p_sensor = Rc^T · (Re^T · (p - te) - tc)``,
and a direction through ``Rc^T · Re^T``.

A ``cuboid_3d`` on a ``lidar_rfu`` scan is a centre, ``(l, w, h)`` and a yaw
about the frame's up axis with heading ``cos(yaw)·forward + sin(yaw)·left``.
On LIDAR_TOP (forward ``+y``, left ``-x``) a sensor-frame heading ``(hx, hy, hz)``
is ``yaw = atan2(-hx, hy)``. A cuboid has no pitch or roll, so a box whose up
axis leans from the sensor's by more than :data:`TILT_TOLERANCE` is refused
rather than flattened; within it, the lean is projected out of the heading.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final

from visionset.formats._tilt import TILT_TOLERANCE, tilt_from
from visionset.kernel.domain import ScanFrame

Vector = tuple[float, float, float]
Matrix = tuple[Vector, Vector, Vector]
Quaternion = tuple[float, float, float, float]

#: How far a quaternion's norm may stray from 1, as printed rotations do.
UNIT_TOLERANCE: Final = 1e-3

FRAME: Final = ScanFrame.LIDAR_RFU

_DECIMALS = 6
_YAW_DECIMALS = 9


class TiltedBox(ValueError):
    """The box leans further from the sensor's up axis than a cuboid may."""

    def __init__(self, tilt: float) -> None:
        super().__init__(f"{math.degrees(tilt):.1f}")
        self.tilt = tilt


def rotation_matrix(quaternion: Quaternion) -> Matrix:
    """The rotation a ``(w, x, y, z)`` quaternion names.

    Raises:
        ValueError: the quaternion is not unit length within :data:`UNIT_TOLERANCE`.
    """
    norm = math.sqrt(sum(value * value for value in quaternion))
    if not math.isfinite(norm) or abs(norm - 1.0) > UNIT_TOLERANCE:
        raise ValueError("not a unit quaternion")
    w, x, y, z = (value / norm for value in quaternion)
    return (
        (1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)),
        (2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)),
        (2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)),
    )


@dataclass(frozen=True, slots=True)
class Pose:
    """A child frame in its parent: ``p_parent = rotation · p_child + translation``."""

    rotation: Matrix
    translation: Vector

    @classmethod
    def of(cls, quaternion: Quaternion, translation: Vector) -> Pose:
        """Raises ``ValueError`` when the quaternion is not a unit one."""
        return cls(rotation=rotation_matrix(quaternion), translation=translation)

    def into_child(self, point: Vector) -> Vector:
        return _transposed(self.rotation, _minus(point, self.translation))

    def direction_into_child(self, direction: Vector) -> Vector:
        return _transposed(self.rotation, direction)


@dataclass(frozen=True, slots=True)
class GlobalToSensor:
    """The inverse of one ``sample_data``'s ego pose, then of its calibrated sensor."""

    ego: Pose
    sensor: Pose

    def point(self, point: Vector) -> Vector:
        return self.sensor.into_child(self.ego.into_child(point))

    def direction(self, direction: Vector) -> Vector:
        return self.sensor.direction_into_child(self.ego.direction_into_child(direction))


@dataclass(frozen=True, slots=True)
class SensorBox:
    center: Vector
    size: Vector
    yaw: float


def global_box_to_sensor(
    translation: Vector,
    size_wlh: Vector,
    rotation: Quaternion,
    transform: GlobalToSensor,
) -> SensorBox:
    """One ``sample_annotation`` as a centre, ``(l, w, h)`` and yaw on a LIDAR_TOP scan.

    Raises:
        ValueError: the rotation is not a unit quaternion.
        TiltedBox: the box leans beyond :data:`TILT_TOLERANCE`.
    """
    orientation = rotation_matrix(rotation)
    heading = transform.direction(_column(orientation, 0))
    box_up = transform.direction(_column(orientation, 2))
    tilt = tilt_from(box_up, FRAME)
    if tilt > TILT_TOLERANCE:
        raise TiltedBox(tilt)
    (forward_index, forward_sign), (left_index, left_sign) = FRAME.forward, FRAME.left
    yaw = round(
        math.atan2(left_sign * heading[left_index], forward_sign * heading[forward_index]),
        _YAW_DECIMALS,
    )
    center = transform.point(translation)
    width, length, height = size_wlh
    return SensorBox(
        center=(_rounded(center[0]), _rounded(center[1]), _rounded(center[2])),
        size=(_rounded(length), _rounded(width), _rounded(height)),
        yaw=min(math.pi, max(-math.pi, yaw)) + 0.0,
    )


def _rounded(value: float) -> float:
    return round(value, _DECIMALS) + 0.0


def _minus(a: Vector, b: Vector) -> Vector:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _column(matrix: Matrix, index: int) -> Vector:
    return (matrix[0][index], matrix[1][index], matrix[2][index])


def _transposed(matrix: Matrix, vector: Vector) -> Vector:
    a, b, c = matrix
    return (
        a[0] * vector[0] + b[0] * vector[1] + c[0] * vector[2],
        a[1] * vector[0] + b[1] * vector[1] + c[1] * vector[2],
        a[2] * vector[0] + b[2] * vector[1] + c[2] * vector[2],
    )
