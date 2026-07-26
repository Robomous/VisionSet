# usage: from visionset.kernel.domain import Geometry, BboxGeometry, PolygonGeometry
"""Annotation geometry as a discriminated union.

The discriminator is the ``type`` field, and its values ARE ``GeometryType``
members — not parallel string literals. That is deliberate: a schema declares
which geometries a class allows in terms of ``GeometryType``, so validating an
annotation against it is a plain membership test on ``geometry.type``, with no
translation layer in between.

Adding a geometry (polyline, keypoints, mask, the 3D variants) means defining a
model whose ``type`` is the matching ``GeometryType`` member and appending it to
the ``Geometry`` union. Nothing about the discriminator changes shape, and no
existing payload stops parsing. ``GeometryType`` names eight geometries; three
are implemented here — the rest are roadmap, and a payload naming one is
rejected until its model exists.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

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


class ClassificationGeometry(BaseModel):
    """A whole-asset tag: the annotation carries a class but no coordinates.

    It exists as a variant rather than as ``geometry: None`` so that every
    annotation has a geometry with a discriminator, and so the union stays the
    single place that answers "what shape is this label?".
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    type: Literal[GeometryType.CLASSIFICATION_TAG] = GeometryType.CLASSIFICATION_TAG


Geometry = Annotated[
    BboxGeometry | PolygonGeometry | ClassificationGeometry,
    Field(discriminator="type"),
]
"""Every geometry an Annotation can carry.

Coordinates are ALWAYS floats in the asset's native reference frame — pixels for
images — and are NEVER normalized. Normalization to a [0, 1] range, or to any
other convention a format demands, is the exporter's concern and happens at the
boundary, never in the domain.
"""
