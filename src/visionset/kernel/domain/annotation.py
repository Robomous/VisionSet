# usage: from visionset.kernel.domain import Annotation
from __future__ import annotations

from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from visionset.kernel.domain.geometry import Geometry
from visionset.kernel.domain.schema import AttributeValue

Provenance = Literal["human", "model", "import"]


class AnnotationTotals(BaseModel):
    """Two counts over a project's labels, taken together because they share a scan.

    They are one model rather than two port methods because they are one
    aggregate: both fall out of the same join between annotations and the assets
    that carry them, and asking separately would walk it twice to learn two
    numbers a single ``SELECT`` already has.

    The pairing is also what keeps a definition from forking. ``annotated_assets``
    is the numerator of ``ProjectStats.annotated_fraction``, so any surface
    reporting how far along a project is derives it from here rather than from a
    convenient nearby number. The tempting substitute — assets a job has marked
    settled — is a **different** quantity: a skipped frame is settled and carries
    no labels, so the two disagree exactly where somebody would notice and have
    no way to tell which screen was right.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    #: Every annotation drawn on any asset in the project.
    annotations: int = Field(ge=0)
    #: Assets carrying at least one, which is never more than the project's
    #: asset count and is what a completion share divides by.
    annotated_assets: int = Field(ge=0)


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
    #: The job this label was written in — which round of work produced it.
    #:
    #: Not to be confused with ``provenance``, which says *what kind of thing*
    #: made the annotation (a person, a model). This says *when in the project's
    #: history*, and the two are independent: a model's output and a human's
    #: correction of it can come from the same round or from two.
    #:
    #: An annotation hangs off its ``asset_id`` and nothing else, so this had no
    #: answer anywhere before — the batch id travelled only on a transient event.
    #: A correction batch produces a second set of labels over the same asset,
    #: and telling the rounds apart afterwards is the whole question.
    #:
    #: ``None`` means genuinely **unknown**, and there are two ways to get one: a
    #: label written before this field existed whose asset belonged to more than
    #: one job, so the migration could not attribute it; or a caller that did not
    #: supply it. It is optional rather than required because making it required
    #: would mean every existing row is invalid, which is a statement about this
    #: schema rather than about the data.
    job_id: UUID | None = None

    @model_validator(mode="after")
    def _model_provenance_requires_ref(self) -> Annotation:
        if self.provenance == "model" and self.model_ref is None:
            raise ValueError("provenance='model' requires model_ref")
        return self
