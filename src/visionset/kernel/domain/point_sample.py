# usage: from visionset.kernel.domain import PointSample, POINT_BUFFER_MAGIC
"""A scan thinned to a point budget, and the compact buffer a viewer reads it from.

The buffer is little-endian throughout: a 16-byte header (magic ``VSPC``, then
``u32`` version, ``u32`` count and ``u32`` flags), the positions as ``f32``
``x, y, z`` per point, then ``f32`` intensity per point when flag bit 0 is set,
then ``u8`` ``r, g, b`` per point when flag bit 1 is set. Nothing else is in it:
the scan's full count and bounds are the asset's ``point_cloud`` metadata.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from typing import Final

POINT_BUFFER_MAGIC: Final = b"VSPC"
POINT_BUFFER_VERSION: Final = 1
POINT_BUFFER_HEADER: Final = struct.Struct("<4sIII")
POINT_FLAG_INTENSITY: Final = 1
POINT_FLAG_RGB: Final = 2

DEFAULT_POINT_BUDGET: Final = 500_000
MIN_POINT_BUDGET: Final = 1_000
MAX_POINT_BUDGET: Final = 2_000_000


def decimation_stride(total: int, budget: int) -> int:
    """Keep every ``stride``-th point so at most ``budget`` of ``total`` remain."""
    if budget < 1:
        raise ValueError(f"budget must be at least 1 point, got {budget}")
    return max(1, math.ceil(total / budget))


@dataclass(frozen=True, slots=True)
class PointSample:
    """Every ``stride``-th finite point of one scan, in file order.

    ``positions`` is little-endian ``f32`` ``x, y, z`` per point; ``intensity``
    little-endian ``f32`` per point; ``rgb`` one byte per channel per point.
    ``total`` is how many finite points the scan holds before thinning.
    """

    total: int
    stride: int
    positions: bytes
    intensity: bytes | None = None
    rgb: bytes | None = None

    def __post_init__(self) -> None:
        if len(self.positions) % 12:
            raise ValueError("positions must hold three float32 values a point")
        count = len(self.positions) // 12
        if self.intensity is not None and len(self.intensity) != 4 * count:
            raise ValueError("intensity must hold one float32 a point")
        if self.rgb is not None and len(self.rgb) != 3 * count:
            raise ValueError("rgb must hold three bytes a point")

    @property
    def count(self) -> int:
        return len(self.positions) // 12

    @property
    def flags(self) -> int:
        return (POINT_FLAG_INTENSITY if self.intensity is not None else 0) | (
            POINT_FLAG_RGB if self.rgb is not None else 0
        )

    def encode(self) -> bytes:
        """The sample as the versioned buffer the module docstring lays out."""
        header = POINT_BUFFER_HEADER.pack(
            POINT_BUFFER_MAGIC, POINT_BUFFER_VERSION, self.count, self.flags
        )
        return b"".join((header, self.positions, self.intensity or b"", self.rgb or b""))
