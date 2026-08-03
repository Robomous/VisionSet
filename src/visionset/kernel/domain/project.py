# usage: from visionset.kernel.domain import Project
from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator

from visionset.kernel.domain.dataset import ClassCount


class Project(BaseModel):
    """A dataset-building effort inside a Workspace, governed by one AnnotationSchema."""

    id: UUID = Field(default_factory=uuid4)
    workspace_id: UUID
    name: str
    description: str | None = None


class ProjectStats(BaseModel):
    """What a project holds, counted — everything ingested, not only the trunk.

    The sibling of :class:`~visionset.kernel.domain.dataset.DatasetStats`, and the
    difference between them is the whole reason this exists. A ``Dataset`` is the
    curated **trunk**, and an asset reaches it only when somebody promotes a
    completed batch — so a project that has ingested a thousand images and
    promoted none reads *zero* through the dataset's counts. That is the right
    answer to "what would I train on" and the wrong one to "what does this
    project have", which is the question a project page asks.

    So this counts every asset in the project whatever its batch state, and every
    annotation drawn on one. Both models are honest; they are answering different
    questions, and neither is derivable from the other.

    ``ClassCount`` is reused rather than re-spelled: the shape and both its
    numbers mean exactly what they mean for the trunk, and a second class with
    the same three fields is how two counts of the same thing start to disagree.

    A snapshot, derived per call, never cached — the ``DatasetStats`` rule for
    the ``DatasetStats`` reason.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    project_id: UUID
    #: Every asset ingested into the project, whatever batch it landed in and
    #: whether or not anybody has promoted it.
    asset_count: int = Field(ge=0)
    #: Assets carrying at least one annotation. Unlabeled assets are the ordinary
    #: state of a fresh ingest, not a defect.
    annotated_asset_count: int = Field(ge=0)
    annotation_count: int = Field(ge=0)
    #: Classes the **active schema version** declares — which is a fact about the
    #: schema, so it is read from the schema. Counting the distinct classes that
    #: appear in ``per_class`` instead would report a project whose ontology
    #: nobody has used yet as having no classes, which is the reverse of true.
    #: Zero for a project with no schema, which every project starts as (#6).
    class_count: int = Field(ge=0)
    #: Only classes that appear at least once, in canonical order by name. A
    #: declared-but-unused class is absent here and still counted above — the
    #: same split ``DatasetStats.per_class`` documents.
    per_class: tuple[ClassCount, ...] = ()
    #: When data last arrived, or NULL when no asset here records an arrival.
    #:
    #: The newest ``Asset.ingested_at`` in the project. NULL has one meaning and
    #: it is not "never ingested" — it is **unknown**: no asset here records an
    #: arrival, which nothing backfills (#216). A project with no assets at all
    #: reads NULL too, and the two are deliberately not distinguished,
    #: because the only caller is a chip that omits itself either way.
    #:
    #: Unlike ``annotated_fraction``, this is *not* derived to a zero when there
    #: is nothing to derive it from. A count has an honest identity element and a
    #: date does not: any stand-in would name a moment nobody chose.
    last_ingest_at: datetime | None = None

    @property
    def annotated_fraction(self) -> float:
        """Labeled share of the project, in ``0.0..1.0``.

        Derived rather than stored, because it is a function of two fields
        sitting beside it and a stored copy is a second source of truth that can
        disagree with them.

        **Zero assets gives ``0.0``**, not a division by zero and not ``None``.
        An empty project is genuinely 0% annotated, and it is the state every
        project passes through, so the one caller that would have to special-case
        it is every caller.
        """
        if self.asset_count == 0:
            return 0.0
        return self.annotated_asset_count / self.asset_count

    @field_validator("per_class")
    @classmethod
    def _in_canonical_order(cls, value: tuple[ClassCount, ...]) -> tuple[ClassCount, ...]:
        return tuple(sorted(value, key=lambda count: count.label_class))
