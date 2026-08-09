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

from typing import Annotated, Final, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, model_validator

from visionset.kernel.domain.schema import GeometryType


class BboxGeometry(BaseModel):
    """An axis-aligned rectangle: top-left corner plus size.

    ``width`` and ``height`` must be strictly positive — a zero-area box is as
    meaningless as a negative one, so neither is accepted. ``x`` and ``y`` are
    unconstrained: an annotation may legitimately start outside the asset's
    bounds when an object is clipped by the frame edge.
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
