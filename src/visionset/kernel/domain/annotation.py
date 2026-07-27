# usage: from visionset.kernel.domain import Annotation
from __future__ import annotations

from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, model_validator

from visionset.kernel.domain.geometry import Geometry
from visionset.kernel.domain.schema import AttributeValue

Provenance = Literal["human", "model", "import"]


class Annotation(BaseModel):
    """A single annotation on an Asset.

    Identity is the mandatory ``id`` UUID, generated at creation — annotations
    are NEVER addressed by array index.

    Coordinates are ALWAYS stored in the asset's native reference frame
    (pixels for images). Normalization is the exporter's concern, never the
    domain's.

    Per-value rules are enforced here and are therefore unskippable: a
    ``provenance='model'`` annotation with no ``model_ref``, or a ``confidence``
    outside [0, 1], cannot be constructed at all — which is why no service
    re-checks either one. Rules that need the *schema* — is this class in it, is
    this the geometry it declared, are these the attributes it asks for — belong
    to ``AnnotationService``, because a model does not know which schema version
    it belongs to.
    """

    id: UUID = Field(default_factory=uuid4)
    asset_id: UUID
    label_class: str
    schema_version: int = Field(ge=1)
    geometry: Geometry
    #: Attribute values, keyed by ``Attribute.name`` **exactly** — which is why
    #: that field is stored stripped (see ``domain/schema.py``): a trailing space
    #: would be a second attribute nobody can see. Empty is the ordinary state;
    #: whether a missing key is allowed is the schema's answer, given at write
    #: time by ``AnnotationService`` against the version the batch pinned.
    attributes: dict[str, AttributeValue] = Field(default_factory=dict)
    provenance: Provenance
    model_ref: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _model_provenance_requires_ref(self) -> Annotation:
        if self.provenance == "model" and self.model_ref is None:
            raise ValueError("provenance='model' requires model_ref")
        return self
