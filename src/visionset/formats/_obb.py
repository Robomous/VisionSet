# usage: from visionset.formats._obb import decimal, half_unit, obb_of, read_corners
"""What the two rotated-box formats, ``yolo-obb`` and ``dota``, do the same way.

Both spell a rotated box as four corners in order round the rectangle, and both
read one back through :func:`obb_from_corners`, so a row naming any start
corner, in either direction, is the same canonical box.

Four corners that are not a rectangle to :data:`OBB_CORNER_TOLERANCE` are
fitted to the nearest rectangle. Rounding to a file's decimals moves a corner
off its rectangle, and DOTA's corners are drawn by hand on whole pixels of the
source picture, so a real box is seldom a rectangle. The fit is kept when every
corner lies within :data:`FIT_TOLERANCE`, a sixth of the fit's shorter side, of
its fitted corner, or within two units of the row's last significant digit on
each axis, for a box too small to tell rounding from shape. The caller counts a
kept fit as a degraded geometry. Farther than that, the corners are refused and
the caller counts a lost label.

Both bounds are chosen from data. On the 133 rows of Ultralytics' DOTA8, the
farthest corner lies at most 0.131 of the shorter side from the fit (median
0.035, 99th percentile 0.107), while a clear trapezoid lies at 0.30, a
parallelogram skewed 30 degrees at 0.20 to 0.32, a kite at 0.35 or more, a
dart at 0.85 and a bow-tie has no fit at all. On the 280,196 whole-pixel rows
of DOTA v1.5 train and val, a hand-drawn corner lies about 1.5 pixels from the
fit whatever the box's size, so the ratio grows as the box shrinks (99th
percentile 0.29 below 8 pixels, 0.11 from 40); two units refuse 0.44% of rows,
where one refused 2.53%.

Corners are written with enough digits that a box reads back within that
tolerance, and never clamped into the image: clamping one corner bends the
rectangle into a quadrilateral the reader would then refuse.

Private to :mod:`visionset.formats`, like ``_layout``.
"""

from __future__ import annotations

from decimal import Decimal
from math import atan2, hypot, isfinite
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
FITTED: Final = "its four corners are only near a rectangle; the nearest rectangle is kept"

FIT_TOLERANCE: Final = 1 / 6
"""How far a corner may lie from the nearest rectangle, relative to its shorter side."""


def obb_of(annotation: ManifestAnnotation) -> ObbGeometry | None:
    """The rotated box an annotation carries, or ``None`` for every other geometry."""
    geometry = annotation.geometry
    return geometry if isinstance(geometry, ObbGeometry) else None


def decimal(value: float, digits: int) -> str:
    """``value`` with at most ``digits`` decimals, trailing zeros and a negative zero dropped."""
    text = f"{value + 0.0:.{digits}f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def half_unit(tokens: list[str], *, significant: bool = False) -> float:
    """Half a unit of the last decimal any of ``tokens`` spells: how far rounding moved them.

    ``significant`` ignores trailing zeros, for a file that pads whole numbers
    such as ``76.0`` and so claims a tenth it never measured.
    """
    exponents = (
        (Decimal(token).normalize() if significant else Decimal(token)).as_tuple().exponent
        for token in tokens
    )
    decimals = max((-exponent for exponent in exponents if isinstance(exponent, int)), default=0)
    return 0.5 * 10.0 ** -max(decimals, 0)


def read_corners(
    points: Corners, quantum: tuple[float, float] = (0.0, 0.0)
) -> tuple[ObbGeometry | None, str]:
    """The rectangle four corners describe and why it is not exact, or ``None`` and the loss.

    ``quantum`` is how far rounding may have moved a corner on each axis, in
    pixels. An exact rectangle comes back with an empty reason; corners near
    the nearest rectangle, as the module says, bring it back with :data:`FITTED`.
    """
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
        pass
    floor = OBB_CORNER_TOLERANCE * scale
    allowance = (max(4 * quantum[0], floor), max(4 * quantum[1], floor))
    fitted = nearest_rectangle(points)
    if fitted is None:
        return None, NOT_A_RECTANGLE
    cx, cy, width, height, angle = _shape(fitted)
    reach = FIT_TOLERANCE * min(width, height)
    pairs = zip(points, fitted, strict=True)
    near = all(hypot(x - fx, y - fy) <= reach for (x, y), (fx, fy) in pairs)
    if not near and not _within(points, fitted, allowance):
        return None, NOT_A_RECTANGLE
    return ObbGeometry(cx=cx, cy=cy, width=width, height=height, angle=angle), FITTED


def nearest_rectangle(points: Corners) -> Corners | None:
    """The rectangle nearest four ordered corners, as its corners in the same order.

    Its centre is the corners' mean, its width axis the sum of the two width
    sides and the two height sides turned back a right angle, so a longer side
    steers it more, and each side the mean length of the two opposite sides
    along that axis.
    ``None`` when the corners do not turn one way, so no rectangle is near.
    """
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = points
    width_x, width_y = (x1 - x0) + (x2 - x3), (y1 - y0) + (y2 - y3)
    height_x, height_y = (x2 - x1) + (x3 - x0), (y2 - y1) + (y3 - y0)
    turn = width_x * height_y - width_y * height_x
    if turn == 0.0:
        return None
    sense = 1.0 if turn > 0 else -1.0
    ux = width_x + sense * height_y
    uy = width_y - sense * height_x
    norm = hypot(ux, uy)
    if norm == 0.0:
        return None
    ux, uy = ux / norm, uy / norm
    vx, vy = -sense * uy, sense * ux
    half_width = (width_x * ux + width_y * uy) / 4
    half_height = (height_x * vx + height_y * vy) / 4
    if half_width <= 0.0 or half_height <= 0.0:
        return None
    cx, cy = (x0 + x1 + x2 + x3) / 4, (y0 + y1 + y2 + y3) / 4
    wx, wy, hx, hy = ux * half_width, uy * half_width, vx * half_height, vy * half_height
    return (
        (cx - wx - hx, cy - wy - hy),
        (cx + wx - hx, cy + wy - hy),
        (cx + wx + hx, cy + wy + hy),
        (cx - wx + hx, cy - wy + hy),
    )


def _within(points: Corners, fitted: Corners, allowance: tuple[float, float]) -> bool:
    return all(
        abs(x - fx) <= allowance[0] and abs(y - fy) <= allowance[1]
        for (x, y), (fx, fy) in zip(points, fitted, strict=True)
    )


def _shape(corners: Corners) -> tuple[float, float, float, float, float]:
    (x0, y0), (x1, y1), (x2, y2), _ = corners
    cx, cy = (x0 + x2) / 2, (y0 + y2) / 2
    return cx, cy, hypot(x1 - x0, y1 - y0), hypot(x2 - x1, y2 - y1), atan2(y1 - y0, x1 - x0)
