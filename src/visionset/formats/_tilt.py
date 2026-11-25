# usage: from visionset.formats._tilt import TILT_TOLERANCE, tilt_from
"""How far a box may lean before a cuboid, which has no pitch or roll, refuses it.

Shared by the importers that move 3D boxes into a scan's frame, so they flatten
the same lean and refuse the same lean.
"""

from __future__ import annotations

import math
from typing import Final

from visionset.kernel.domain import ScanFrame

Vector = tuple[float, float, float]

#: Five degrees: a sensor's mounting tilt and a road's grade lean a box by one
#: or two, and flattening five moves the ends of a 5 m box by under 0.22 m.
TILT_TOLERANCE: Final = math.radians(5.0)


def tilt_from(up: Vector, frame: ScanFrame) -> float:
    """The angle, in radians, between the direction ``up`` and ``frame``'s up axis."""
    norm = math.sqrt(up[0] * up[0] + up[1] * up[1] + up[2] * up[2])
    if norm == 0.0:
        return math.pi
    index, sign = frame.up
    return math.acos(max(-1.0, min(1.0, sign * up[index] / norm)))
