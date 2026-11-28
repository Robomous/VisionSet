# usage: from visionset.formats._keypoints import labeled_extent, states
"""What the COCO and YOLO pose writers derive from a keypoints label the same way.

The domain keeps a keypoints label as its points alone, so both formats'
required box is derived here, once: the tight extent of the labeled points,
clamped to the picture. Private to :mod:`visionset.formats`.
"""

from __future__ import annotations

from visionset.kernel.domain import KeypointsGeometry, VertexVisibility


def states(geometry: KeypointsGeometry) -> tuple[VertexVisibility, ...]:
    """One visibility per point; a label recording none has every point ``VISIBLE``."""
    if geometry.visibility is None:
        return (VertexVisibility.VISIBLE,) * len(geometry.points)
    return tuple(geometry.visibility)


def labeled_extent(
    geometry: KeypointsGeometry, width: int, height: int
) -> tuple[float, float, float, float]:
    """``(x, y, width, height)`` around the labeled points, clamped to the picture.

    Labeled is visibility ``1`` or ``2``. With no labeled point the box is empty
    at the origin.
    """
    labeled = [
        point
        for point, state in zip(geometry.points, states(geometry), strict=True)
        if state is not VertexVisibility.UNLABELED
    ]
    if not labeled:
        return (0.0, 0.0, 0.0, 0.0)
    xs = [min(max(x, 0.0), float(width)) for x, _ in labeled]
    ys = [min(max(y, 0.0), float(height)) for _, y in labeled]
    return (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))
