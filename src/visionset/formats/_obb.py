# usage: from visionset.formats._obb import decimal, obb_of, read_corners
"""What the two rotated-box formats, ``yolo-obb`` and ``dota``, do the same way.

Both spell a rotated box as four corners in order round the rectangle, and both
read one back through :func:`obb_from_corners`, so a row naming any start
corner, in either direction, is the same canonical box. Four corners that are
not a rectangle within :data:`OBB_CORNER_TOLERANCE` of the longest side are
refused here and counted as a lost label by the caller; nothing is fitted.

Corners are written with enough digits that a box reads back within that
tolerance, and never clamped into the image: clamping one corner bends the
rectangle into a quadrilateral the reader would then refuse.

Private to :mod:`visionset.formats`, like ``_layout``.
"""

from __future__ import annotations

from math import hypot, isfinite
from typing import Final

from visionset.kernel.domain import (
    OBB_CORNER_TOLERANCE,
    ManifestAnnotation,
    ObbGeometry,
    obb_from_corners,
)

Corners = tuple[tuple[float, float], ...]

NOT_FINITE: Final = "its coordinates are not finite numbers"
NO_AREA: Final = "its rotated box has no area"
NOT_A_RECTANGLE: Final = "its four corners are not a rectangle"


def obb_of(annotation: ManifestAnnotation) -> ObbGeometry | None:
    """The rotated box an annotation carries, or ``None`` for every other geometry."""
    geometry = annotation.geometry
    return geometry if isinstance(geometry, ObbGeometry) else None


def decimal(value: float, digits: int) -> str:
    """``value`` with at most ``digits`` decimals, trailing zeros and a negative zero dropped."""
    text = f"{value + 0.0:.{digits}f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def read_corners(points: Corners) -> tuple[ObbGeometry | None, str]:
    """The rectangle four corners describe, or ``None`` and the loss reason."""
    if not all(isfinite(value) for point in points for value in point):
        return None, NOT_FINITE
    sides = [
        (points[(position + 1) % 4][0] - x, points[(position + 1) % 4][1] - y)
        for position, (x, y) in enumerate(points)
    ]
    scale = max(hypot(dx, dy) for dx, dy in sides)
    following = sides[1:] + sides[:1]
    turns = (abs(ax * by - ay * bx) for (ax, ay), (bx, by) in zip(sides, following, strict=True))
    if scale == 0.0 or max(turns) <= OBB_CORNER_TOLERANCE * scale * scale:
        return None, NO_AREA
    try:
        return obb_from_corners(points), ""
    except ValueError:
        return None, NOT_A_RECTANGLE
