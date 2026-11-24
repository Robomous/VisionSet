# usage: from visionset.kernel.domain import PointSample, POINT_BUFFER_MAGIC
"""A scan thinned to a point budget, and the compact buffer a viewer reads it from.

The buffer is little-endian throughout: a 16-byte header (magic ``VSPC``, then
``u32`` version, ``u32`` count and ``u32`` flags), then the origin as ``f64``
``x, y, z`` when flag bit 2 is set, the positions as ``f32`` ``x, y, z`` per
point relative to that origin, then ``f32`` intensity per point when flag bit 0
is set, then ``u8`` ``r, g, b`` per point when flag bit 1 is set. Nothing else
is in it: the scan's full count and bounds are the asset's ``point_cloud``
metadata.

The origin exists because float32 cannot hold a georeferenced coordinate: at a
million metres its spacing is six centimetres. An axis whose median point lies
:data:`POINT_ORIGIN_THRESHOLD` metres or more from zero is offset by that
median, rounded to a whole metre; any other axis by zero. The median, not the
midpoint of the bounds, so a stray return at zero cannot pull the origin away
from the scan. A scan near its own origin therefore has no origin section, and
its buffer is what it always was.
"""

from __future__ import annotations

import math
import struct
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

POINT_BUFFER_MAGIC: Final = b"VSPC"
POINT_BUFFER_VERSION: Final = 1
POINT_BUFFER_HEADER: Final = struct.Struct("<4sIII")
POINT_FLAG_INTENSITY: Final = 1
POINT_FLAG_RGB: Final = 2
POINT_FLAG_ORIGIN: Final = 4
POINT_BUFFER_ORIGIN: Final = struct.Struct("<3d")

#: Below this distance from zero, float32 spacing is at most half a millimetre.
POINT_ORIGIN_THRESHOLD: Final = 8192.0

#: The most values per axis the origin's median is read from: an even stride
#: over every finite point, so it does not depend on the budget.
POINT_ORIGIN_SUBSAMPLE: Final = 4096

DEFAULT_POINT_BUDGET: Final = 500_000
MIN_POINT_BUDGET: Final = 1_000
MAX_POINT_BUDGET: Final = 2_000_000


def decimation_stride(total: int, budget: int) -> int:
    """Keep every ``stride``-th point so at most ``budget`` of ``total`` remain."""
    if budget < 1:
        raise ValueError(f"budget must be at least 1 point, got {budget}")
    return max(1, math.ceil(total / budget))


def sample_origin(
    xs: Sequence[float], ys: Sequence[float], zs: Sequence[float]
) -> tuple[float, float, float]:
    """The origin a scan of finite points, one column an axis, is sent relative to."""
    origin = []
    for column in (xs, ys, zs):
        if not column:
            origin.append(0.0)
            continue
        stride = max(1, len(column) // POINT_ORIGIN_SUBSAMPLE)
        values = sorted(column[::stride])
        median = values[len(values) // 2]
        far = math.isfinite(median) and abs(median) >= POINT_ORIGIN_THRESHOLD
        origin.append(float(round(median)) if far else 0.0)
    return (origin[0], origin[1], origin[2])


@dataclass(frozen=True, slots=True)
class PointSample:
    """Every ``stride``-th finite point of one scan, in file order.

    ``positions`` is little-endian ``f32`` ``x, y, z`` per point; ``intensity``
    little-endian ``f32`` per point; ``rgb`` one byte per channel per point.
    ``total`` is how many finite points the scan holds before thinning.
    ``positions`` are relative to ``origin``: a point is ``origin + position``.
    """

    total: int
    stride: int
    positions: bytes
    intensity: bytes | None = None
    rgb: bytes | None = None
    origin: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def __post_init__(self) -> None:
        if len(self.positions) % 12:
            raise ValueError("positions must hold three float32 values a point")
        count = len(self.positions) // 12
        if self.intensity is not None and len(self.intensity) != 4 * count:
            raise ValueError("intensity must hold one float32 a point")
        if self.rgb is not None and len(self.rgb) != 3 * count:
            raise ValueError("rgb must hold three bytes a point")
        if len(self.origin) != 3 or not all(math.isfinite(v) for v in self.origin):
            raise ValueError("origin must be three finite coordinates")

    @property
    def count(self) -> int:
        return len(self.positions) // 12

    @property
    def nbytes(self) -> int:
        """What the sample holds in memory, near enough to bound a cache by."""
        return len(self.positions) + len(self.intensity or b"") + len(self.rgb or b"")

    @property
    def flags(self) -> int:
        return (
            (POINT_FLAG_INTENSITY if self.intensity is not None else 0)
            | (POINT_FLAG_RGB if self.rgb is not None else 0)
            | (POINT_FLAG_ORIGIN if any(self.origin) else 0)
        )

    def encode(self) -> bytes:
        """The sample as the versioned buffer the module docstring lays out."""
        header = POINT_BUFFER_HEADER.pack(
            POINT_BUFFER_MAGIC, POINT_BUFFER_VERSION, self.count, self.flags
        )
        origin = POINT_BUFFER_ORIGIN.pack(*self.origin) if any(self.origin) else b""
        return b"".join((header, origin, self.positions, self.intensity or b"", self.rgb or b""))
