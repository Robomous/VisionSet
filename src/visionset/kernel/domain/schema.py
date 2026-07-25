# usage: from visionset.kernel.domain import AnnotationSchema, LabelClass, GeometryType
from __future__ import annotations

from enum import StrEnum
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class GeometryType(StrEnum):
    """Every geometry the domain can address.

    3D values exist today even though unimplemented: the domain never assumes
    "image" anywhere — that is the Physical AI roadmap encoded as a type.
    """

    BBOX = "bbox"
    POLYGON = "polygon"
    MASK = "mask"
    POLYLINE = "polyline"
    KEYPOINTS = "keypoints"
    CUBOID_3D = "cuboid_3d"
    POLYLINE_3D = "polyline_3d"
    CLASSIFICATION_TAG = "classification_tag"


class Attribute(BaseModel):
    """A typed attribute attached to a LabelClass (e.g. occlusion, color)."""

    name: str
    kind: Literal["string", "number", "boolean", "select"]
    required: bool = False
    options: list[str] | None = None


class LabelClass(BaseModel):
    """One labelable class in a schema, bound to a geometry type."""

    name: str
    geometry: GeometryType
    color: str | None = None
    attributes: list[Attribute] = Field(default_factory=list)


class AnnotationSchema(BaseModel):
    """The labeling contract for a Project.

    ``version`` is monotonic (>= 1); every Annotation records the
    ``schema_version`` it was created under, so schema evolution never
    orphans existing labels.
    """

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    version: int = Field(ge=1)
    classes: list[LabelClass] = Field(default_factory=list)
