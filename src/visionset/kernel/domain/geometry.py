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
needs no migration. ``GeometryType`` names eight geometries; six are implemented
here — the rest are roadmap, and a payload naming one is rejected until its model
exists.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import IntEnum
from math import isfinite, pi
from typing import TYPE_CHECKING, Annotated, Any, Final, Literal, assert_never, get_args

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationError,
    model_validator,
)
from pydantic.json_schema import JsonDict
from pydantic_core import PydanticCustomError

from visionset.kernel.domain.schema import GeometryType


class VertexVisibility(IntEnum):
    """What is known about one vertex of a path: COCO keypoint visibility's three states.

    The integers are COCO's own ``v`` values, so a keypoint exporter writes them
    unchanged. ``UNLABELED`` is a vertex nobody judged, which is not the same
    claim as ``OCCLUDED`` (judged, and hidden) — a format with a binary flag has
    to decide what an unjudged vertex becomes, and each one says so where it
    writes it.

    Closed and integer on the wire: it is accepted in requests, so it can never
    be an open vocabulary, and a client switching on three numbers needs no
    string table.
    """

    UNLABELED = 0
    OCCLUDED = 1
    VISIBLE = 2


def _omitted_when_unknown(value: object) -> bool:
    return value is None


def _integer_state(value: object) -> object:
    # bool is an int subclass, so `true` would otherwise store 1 — OCCLUDED —
    # for a client that meant "visible". Only an integer names a state.
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(
            f"a vertex visibility is the integer 0, 1 or 2, not {type(value).__name__} {value!r}"
        )
    return value


def _never_null(value: object) -> object:
    if value is None:
        raise ValueError(
            "visibility is omitted when unknown, never null; leave the key out instead"
        )
    return value


def _absent_not_null(schema: JsonDict) -> None:
    # Unknown is an absent key, so the schema advertises neither null nor a default.
    schema.pop("default", None)


StrictVertexVisibility = Annotated[VertexVisibility, BeforeValidator(_integer_state)]
"""A :class:`VertexVisibility` accepted only from an integer: no bool, string or float."""

if TYPE_CHECKING:
    VertexVisibilities = tuple[StrictVertexVisibility, ...] | None
else:
    # No `| None` branch at runtime: a union reports each branch's failure and puts the
    # tuple's repr in `loc`. The default is never validated, so unset still works.
    VertexVisibilities = Annotated[
        tuple[StrictVertexVisibility, ...],
        BeforeValidator(_never_null),
    ]
"""One strict state per vertex. ``None`` is the unset default only: an explicit null is refused."""


def optional_visibility_field() -> Any:
    """The ``visibility`` field: absent when unknown, never ``null`` on input or output."""
    return Field(default=None, exclude_if=_omitted_when_unknown, json_schema_extra=_absent_not_null)


def check_vertex_visibility(
    visibility: Sequence[VertexVisibility] | None, points: Sequence[tuple[float, ...]]
) -> None:
    """Refuse a per-vertex visibility that does not name exactly one state per point.

    Shared rather than inlined, so the next geometry with ordered vertices
    (keypoints, a 3D polyline) holds the same rule instead of a second spelling of it.
    """
    if visibility is not None and len(visibility) != len(points):
        message = (
            f"visibility names {len(visibility)} vertices and the geometry has "
            f"{len(points)} points; send one state per point, or omit visibility"
        )
        # Pydantic replaces this title with the validating model's name.
        raise ValidationError.from_exception_data(
            "vertex visibility",
            [
                {
                    "type": PydanticCustomError(
                        "value_error", "Value error, {error}", {"error": message}
                    ),
                    "loc": ("visibility",),
                    "input": visibility,
                }
            ],
        )


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

    ``visibility`` is optional per-vertex data, one :class:`VertexVisibility` per
    point and in the same order. ``None`` means *nobody said*, which is a
    different claim from every vertex visible, and it is **omitted** from every
    serialization rather than written as ``null`` — so a polyline without it
    dumps to exactly the bytes it did before the field existed, and every
    manifest hash over such content is unchanged. The omission depends on the
    value, never on how the model was constructed, which is what keeps
    :func:`~visionset.kernel.domain.release.canonical_bytes` stable across a
    round trip. A transform that moves points keeps the list aligned; one that
    reversed the path would have to reverse it too.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    type: Literal[GeometryType.POLYLINE] = GeometryType.POLYLINE
    points: list[tuple[float, float]] = Field(min_length=2)
    visibility: VertexVisibilities = optional_visibility_field()

    @model_validator(mode="after")
    def _has_length(self) -> PolylineGeometry:
        if len(set(self.points)) == 1:
            raise ValueError("a polyline whose points are all the same point has no length")
        check_vertex_visibility(self.visibility, self.points)
        return self

    def through(self, points: list[tuple[float, float]]) -> PolylineGeometry:
        """The same path moved onto ``points``, its visibility carried in order."""
        if self.visibility is None:
            return PolylineGeometry(points=points)
        return PolylineGeometry(points=points, visibility=self.visibility)


class Polyline3DGeometry(BaseModel):
    """An open path of at least two ``(x, y, z)`` vertices in its asset's 3D frame.

    A sibling of :class:`PolylineGeometry`, never a subclass: every
    ``case PolylineGeometry()`` and ``isinstance`` check reads 2D pixel points,
    and a 3D path must not reach one by inheritance.

    On an image, points are metres in the camera's OpenCV frame (x right, y down,
    z forward; see :mod:`~visionset.kernel.domain.calibration`), read against the
    asset's effective calibration. On a point-cloud scan they are in the frame
    its source declares, in that scan's units, and need no calibration. Either
    way no image-frame bounds check applies: a point behind the camera, or
    outside the frame, is a legal 3D label. The path rules are the 2D
    polyline's — ordered, degenerate only when every point is the same point —
    and ``visibility`` is the same :class:`VertexVisibility` field under the
    same validator.
    """

    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    type: Literal[GeometryType.POLYLINE_3D] = GeometryType.POLYLINE_3D
    points: list[tuple[float, float, float]] = Field(min_length=2)
    visibility: VertexVisibilities = optional_visibility_field()

    @model_validator(mode="after")
    def _has_length(self) -> Polyline3DGeometry:
        if len(set(self.points)) == 1:
            raise ValueError("a polyline whose points are all the same point has no length")
        check_vertex_visibility(self.visibility, self.points)
        return self


class Cuboid3DGeometry(BaseModel):
    """A box in its asset's sensor frame: a center, a size and a yaw, in metres.

    The frame is the camera's OpenCV frame (x right, y down, z forward), and the
    box is interpretable only against the asset's effective calibration, so no
    image-frame bounds check applies.

    ``center`` is the box's geometric centre. ``size`` is ``(length, width,
    height)``: ``length`` runs along the heading, ``width`` across it, and
    ``height`` along the sensor's y axis, every one strictly positive. ``yaw`` is
    a right-handed rotation in radians about the sensor's +y (down) axis, within
    ``[-pi, pi]`` and not normalised: a value outside is refused rather than
    wrapped, so what is stored is what was sent. At ``yaw = 0`` the heading is
    sensor +x; in general it is ``(cos yaw, 0, -sin yaw)``, KITTI's
    ``rotation_y`` convention. Roll and pitch are not modelled; a full rotation
    would extend this shape, not replace it.

    A sibling of every other variant, never a subclass, and it has no
    ``visibility``: per-vertex visibility describes an ordered path, which a box
    is not.
    """

    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    type: Literal[GeometryType.CUBOID_3D] = GeometryType.CUBOID_3D
    center: tuple[float, float, float]
    size: tuple[
        Annotated[float, Field(gt=0.0)],
        Annotated[float, Field(gt=0.0)],
        Annotated[float, Field(gt=0.0)],
    ]
    yaw: float = Field(ge=-pi, le=pi)


class ClassificationGeometry(BaseModel):
    """A whole-asset tag: the annotation carries a class but no coordinates.

    It exists as a variant rather than as ``geometry: None`` so that every
    annotation has a geometry with a discriminator, and so the union stays the
    single place that answers "what shape is this label?".
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    type: Literal[GeometryType.CLASSIFICATION_TAG] = GeometryType.CLASSIFICATION_TAG


Geometry = Annotated[
    BboxGeometry
    | PolygonGeometry
    | PolylineGeometry
    | Polyline3DGeometry
    | Cuboid3DGeometry
    | ClassificationGeometry,
    Field(discriminator="type"),
]
"""Every geometry an Annotation can carry.

Coordinates are ALWAYS floats in the asset's native reference frame — pixels for
a 2D variant; metres for a 3D variant, in the camera's sensor frame on an image and
in the source's declared frame on a point-cloud scan — and are NEVER normalized.
Normalization to a [0, 1] range, or to any other convention a format demands, is the
exporter's concern and happens at the boundary, never in the domain.
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
    match geometry:
        case ClassificationGeometry() | Polyline3DGeometry() | Cuboid3DGeometry():
            return True
        case BboxGeometry():
            return _bbox_intersects_frame(geometry, frame)
        case PolylineGeometry():
            return _path_intersects_frame(geometry.points, frame, closed=False)
        case PolygonGeometry():
            return _path_intersects_frame(geometry.points, frame, closed=True)
        case _:
            assert_never(geometry)


def _coordinates_are_finite(geometry: Geometry) -> bool:
    match geometry:
        case ClassificationGeometry():
            return True
        case BboxGeometry():
            return all(
                isfinite(value)
                for value in (geometry.x, geometry.y, geometry.width, geometry.height)
            )
        case PolygonGeometry() | PolylineGeometry() | Polyline3DGeometry():
            return all(isfinite(value) for point in geometry.points for value in point)
        case Cuboid3DGeometry():
            return all(
                isfinite(value) for value in (*geometry.center, *geometry.size, geometry.yaw)
            )
        case _:
            assert_never(geometry)


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
