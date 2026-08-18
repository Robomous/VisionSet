# usage: from visionset.kernel.domain import Geometry, BboxGeometry, PolygonGeometry
"""Annotation geometry as a discriminated union.

The discriminator is the ``type`` field, and its values ARE ``GeometryType``
members — not parallel string literals. That is deliberate: a schema declares
which geometries a class allows in terms of ``GeometryType``, so validating an
annotation against it is a plain membership test on ``geometry.type``, with no
translation layer in between.

Adding a geometry (keypoints, mask, the 3D variants) means defining a model whose
``type`` is the matching ``GeometryType`` member and appending it to the
``Geometry`` union. Nothing about the discriminator changes shape and no existing
payload stops parsing, because geometry rides in the annotation's JSON column and
needs no migration. ``GeometryType`` names eight geometries; four are implemented
here — the rest are roadmap, and a payload naming one is rejected until its model
exists.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Annotated, Final, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, model_validator

from visionset.kernel.domain.schema import GeometryType


class BboxGeometry(BaseModel):
    """An axis-aligned rectangle: top-left corner plus size.

    ``width`` and ``height`` must be strictly positive — a zero-area box is as
    meaningless as a negative one, so neither is accepted. A box may extend
    beyond an asset's frame, but cannot be wholly disjoint when that asset
    records its dimensions.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    type: Literal[GeometryType.BBOX] = GeometryType.BBOX
    x: float
    y: float
    width: float = Field(gt=0.0)
    height: float = Field(gt=0.0)


class PolygonGeometry(BaseModel):
    """A closed polygon, as at least three ``(x, y)`` vertices.

    The closing edge is implicit: the last point joins the first, and repeating
    the first point at the end is NOT expected. Self-intersection is not
    validated — M1 accepts any ring of three or more points, and rejecting
    degenerate shapes is left to a later milestone.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    type: Literal[GeometryType.POLYGON] = GeometryType.POLYGON
    points: list[tuple[float, float]] = Field(min_length=3)


class PolylineGeometry(BaseModel):
    """An open path, as at least two ``(x, y)`` vertices in order.

    The contrast with :class:`PolygonGeometry` is the whole definition: a polygon
    is a *ring* whose closing edge is implicit, and a polyline is a *path* whose
    ends stay apart. Nothing joins the last point to the first, and a caller that
    repeats the first point at the end has drawn a closed path — which is a legal
    polyline, and not the same value as the polygon with those vertices.

    **The order of the points is the geometry**, not an incidental detail of how
    they were collected. A lane runs from one end to the other, and reversing the
    list is a different annotation of the same pixels. There is nothing to
    validate in that — an ordered sequence is ordered — which is worth saying
    because the ordering rule a lane *format* wants is a different rule: TuSimple
    requires points sorted by ascending Y, and :mod:`visionset.formats.lanes`
    enforces that at the boundary where it applies. Putting it here would make one
    format's invariant a condition of storing a lane at all, and would refuse
    every horizontal path in a domain that has no idea what a road is.

    Degeneracy is refused in exactly one case, the analogue of the zero-area box
    :class:`BboxGeometry` already declines: a path whose points are all the same
    point has no length and describes nothing. Consecutive duplicates within a
    longer path are left alone — they arrive from real digitizers and from honest
    resampling, and they cost a renderer nothing — and self-intersection is not
    validated here for the same reason it is not validated for a polygon.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    type: Literal[GeometryType.POLYLINE] = GeometryType.POLYLINE
    points: list[tuple[float, float]] = Field(min_length=2)

    @model_validator(mode="after")
    def _has_length(self) -> PolylineGeometry:
        if len(set(self.points)) == 1:
            raise ValueError("a polyline whose points are all the same point has no length")
        return self


class ClassificationGeometry(BaseModel):
    """A whole-asset tag: the annotation carries a class but no coordinates.

    It exists as a variant rather than as ``geometry: None`` so that every
    annotation has a geometry with a discriminator, and so the union stays the
    single place that answers "what shape is this label?".
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    type: Literal[GeometryType.CLASSIFICATION_TAG] = GeometryType.CLASSIFICATION_TAG


Geometry = Annotated[
    BboxGeometry | PolygonGeometry | PolylineGeometry | ClassificationGeometry,
    Field(discriminator="type"),
]
"""Every geometry an Annotation can carry.

Coordinates are ALWAYS floats in the asset's native reference frame — pixels for
images — and are NEVER normalized. Normalization to a [0, 1] range, or to any
other convention a format demands, is the exporter's concern and happens at the
boundary, never in the domain.
"""


IMPLEMENTED_GEOMETRIES: Final[frozenset[GeometryType]] = frozenset(
    variant.model_fields["type"].default for variant in get_args(get_args(Geometry)[0])
)
"""The subset of ``GeometryType`` that an Annotation can actually carry.

Read off the union rather than listed beside it, so appending a variant widens
this set with no second edit and no chance of the two disagreeing. It is what
``SchemaService`` checks a proposed ``LabelClass`` against: declaring a class
whose geometry has no model would create a class nobody could ever annotate.
"""


@dataclass(frozen=True)
class _Frame:
    width: float
    height: float


def geometry_intersects_asset(geometry: Geometry, *, width: int | None, height: int | None) -> bool:
    if width is None or height is None or not _coordinates_are_finite(geometry):
        return True
    frame = _Frame(width=float(width), height=float(height))
    if isinstance(geometry, ClassificationGeometry):
        return True
    if isinstance(geometry, BboxGeometry):
        return _bbox_intersects_frame(geometry, frame)
    if isinstance(geometry, PolylineGeometry):
        return _path_intersects_frame(geometry.points, frame, closed=False)
    return _path_intersects_frame(geometry.points, frame, closed=True)


def _coordinates_are_finite(geometry: Geometry) -> bool:
    if isinstance(geometry, ClassificationGeometry):
        return True
    if isinstance(geometry, BboxGeometry):
        return all(
            isfinite(value) for value in (geometry.x, geometry.y, geometry.width, geometry.height)
        )
    return all(isfinite(value) for point in geometry.points for value in point)


def _bbox_intersects_frame(geometry: BboxGeometry, frame: _Frame) -> bool:
    return (
        geometry.x <= frame.width
        and geometry.x + geometry.width >= 0.0
        and geometry.y <= frame.height
        and geometry.y + geometry.height >= 0.0
    )


def _path_intersects_frame(
    points: list[tuple[float, float]], frame: _Frame, *, closed: bool
) -> bool:
    if any(_point_is_in_frame(point, frame) for point in points):
        return True

    frame_edges = _frame_edges(frame)
    segments = list(zip(points, points[1:], strict=False))
    if closed:
        segments.append((points[-1], points[0]))
    if any(
        _segments_intersect(start, end, edge_start, edge_end)
        for start, end in segments
        for edge_start, edge_end in frame_edges
    ):
        return True

    return closed and any(_point_is_in_polygon(corner, points) for corner in _frame_corners(frame))


def _point_is_in_frame(point: tuple[float, float], frame: _Frame) -> bool:
    x, y = point
    return 0.0 <= x <= frame.width and 0.0 <= y <= frame.height


def _frame_edges(
    frame: _Frame,
) -> tuple[
    tuple[tuple[float, float], tuple[float, float]],
    tuple[tuple[float, float], tuple[float, float]],
    tuple[tuple[float, float], tuple[float, float]],
    tuple[tuple[float, float], tuple[float, float]],
]:
    top_left = (0.0, 0.0)
    top_right = (frame.width, 0.0)
    bottom_right = (frame.width, frame.height)
    bottom_left = (0.0, frame.height)
    return (
        (top_left, top_right),
        (top_right, bottom_right),
        (bottom_right, bottom_left),
        (bottom_left, top_left),
    )


def _frame_corners(frame: _Frame) -> tuple[tuple[float, float], ...]:
    return ((0.0, 0.0), (frame.width, 0.0), (frame.width, frame.height), (0.0, frame.height))


def _segments_intersect(
    first_start: tuple[float, float],
    first_end: tuple[float, float],
    second_start: tuple[float, float],
    second_end: tuple[float, float],
) -> bool:
    first_second_start = _cross_product(first_start, first_end, second_start)
    first_second_end = _cross_product(first_start, first_end, second_end)
    second_first_start = _cross_product(second_start, second_end, first_start)
    second_first_end = _cross_product(second_start, second_end, first_end)

    if first_second_start == 0.0 and _point_is_on_segment(second_start, first_start, first_end):
        return True
    if first_second_end == 0.0 and _point_is_on_segment(second_end, first_start, first_end):
        return True
    if second_first_start == 0.0 and _point_is_on_segment(first_start, second_start, second_end):
        return True
    if second_first_end == 0.0 and _point_is_on_segment(first_end, second_start, second_end):
        return True
    return (first_second_start > 0.0) != (first_second_end > 0.0) and (
        second_first_start > 0.0
    ) != (second_first_end > 0.0)


def _point_is_in_polygon(point: tuple[float, float], points: list[tuple[float, float]]) -> bool:
    winding_number = 0
    for start, end in zip(points, [*points[1:], points[0]], strict=True):
        if _cross_product(start, end, point) == 0.0 and _point_is_on_segment(point, start, end):
            return True
        if start[1] <= point[1] < end[1] and _cross_product(start, end, point) > 0.0:
            winding_number += 1
        elif end[1] <= point[1] < start[1] and _cross_product(start, end, point) < 0.0:
            winding_number -= 1
    return winding_number != 0


def _point_is_on_segment(
    point: tuple[float, float], start: tuple[float, float], end: tuple[float, float]
) -> bool:
    return min(start[0], end[0]) <= point[0] <= max(start[0], end[0]) and min(
        start[1], end[1]
    ) <= point[1] <= max(start[1], end[1])


def _cross_product(
    start: tuple[float, float], end: tuple[float, float], point: tuple[float, float]
) -> float:
    return (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (point[0] - start[0])
