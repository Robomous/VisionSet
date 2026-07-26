# usage: from visionset.kernel.domain import Annotation
from __future__ import annotations

from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, model_validator

from visionset.kernel.domain.geometry import Geometry

Provenance = Literal["human", "model", "import"]


class Annotation(BaseModel):
    """A single annotation on an Asset.

    Identity is the mandatory ``id`` UUID, generated at creation — annotations
    are NEVER addressed by array index.

    Coordinates are ALWAYS stored in the asset's native reference frame
    (pixels for images). Normalization is the exporter's concern, never the
    domain's.
    """

    id: UUID = Field(default_factory=uuid4)
    asset_id: UUID
    label_class: str
    schema_version: int = Field(ge=1)
    geometry: Geometry
    provenance: Provenance
    model_ref: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _model_provenance_requires_ref(self) -> Annotation:
        if self.provenance == "model" and self.model_ref is None:
            raise ValueError("provenance='model' requires model_ref")
        return self
