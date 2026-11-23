# usage: from visionset.kernel.domain import Project
from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator

from visionset.kernel.domain.dataset import ClassCount


class Project(BaseModel):
    """A dataset-building effort inside a Workspace, governed by one AnnotationSchema."""

    id: UUID = Field(default_factory=uuid4)
    workspace_id: UUID
    name: str
    description: str | None = None
    #: When the project was made. ``None`` only for a project written before the
    #: workspace recorded it; ``ProjectService.create`` stamps every new one.
    created_at: datetime | None = None

    @field_validator("created_at")
    @classmethod
    def _created_at_is_timezone_aware(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("created_at must be timezone-aware (UTC)")
        return value.astimezone(UTC)


class ProjectPreview(BaseModel):
    """The image that stands for a project in a listing.

    The first asset of the project's earliest-created batch that has one — a
    picture for the row, not a claim about progress, so it does not move as
    later batches arrive. ``thumbnail_hash`` is NULL when the preview was never
    cached, which a client renders as a placeholder without fetching.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    asset_id: UUID
    thumbnail_hash: str | None


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
    #: Zero for a project with no schema, which every project starts as.
    class_count: int = Field(ge=0)
    #: Only classes that appear at least once, in canonical order by name. A
    #: declared-but-unused class is absent here and still counted above — the
    #: same split ``DatasetStats.per_class`` documents.
    per_class: tuple[ClassCount, ...] = ()
    #: When data last arrived, or NULL when no asset here records an arrival.
    #:
    #: The newest ``Asset.ingested_at`` in the project. NULL has one meaning and
    #: it is not "never ingested" — it is **unknown**: no asset here records an
    #: arrival, which nothing backfills. A project with no assets at all reads
    #: NULL too, and the two are deliberately not distinguished, because the only
    #: caller is a chip that omits itself either way.
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


class ProjectStage(StrEnum):
    """Where a project is in the road from images to a released dataset.

    A **description**, derived per call by ``ProjectService.digests`` from facts
    the kernel already holds, and nothing more. It is not a state the project
    is *in*: there is no ``project.stage`` column, no transition table and no
    transition to refuse, and it must never be consulted to gate an action —
    what may be done is decided by ``capabilities.py`` and the transition tables
    in the domain, never by a label that summarises them. A client that
    disabled a button because a project reads ``annotating`` would be a second
    legality table that the first one never heard of.

    Evaluated **first match wins**, in this order, which is the whole of the
    rule and why the members are listed in it:

    1. ``empty`` - the project holds no assets.
    2. ``in_review`` - some frame in an ``in_annotation`` batch is waiting on a
       reviewer (``AssetProgress.REVIEW_PENDING``).
    3. ``annotating`` - some frame in an ``in_annotation`` batch is neither
       settled nor waiting on review: labeling an annotator still has to do.
    4. ``to_promote`` - a ``completed`` batch holds an asset ``promote`` would
       still add: one in ``PROMOTABLE_PROGRESS`` that is not in the trunk.
    5. ``unreleased`` - the trunk is non-empty and either no release exists or
       the trunk was changed after the newest release was cut.
    6. ``not_started`` - assets exist but none of the above holds: only draft or
       approved batches, or nothing promoted.
    7. ``up_to_date`` - otherwise: the newest release is the trunk as it stands.

    Review outranks labeling because a reviewer's frame is finished work waiting
    on somebody else, and naming it first tells that somebody there is a queue.
    """

    EMPTY = "empty"
    IN_REVIEW = "in_review"
    ANNOTATING = "annotating"
    TO_PROMOTE = "to_promote"
    UNRELEASED = "unreleased"
    NOT_STARTED = "not_started"
    UP_TO_DATE = "up_to_date"


class ReleaseDigest(BaseModel):
    """The newest release of a project's dataset, as much of it as a list row needs.

    ``published_at`` is ``Release.created_at``: a release is immutable and is
    published at the instant it is made, so the two are one moment under two
    names. ``asset_count`` is the release's own read cache of its manifest, the
    figure ``ReleaseService.verify`` cross-checks, so it is the size of what was
    frozen and not of what the trunk holds now.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    tag: str
    asset_count: int = Field(ge=0)
    published_at: datetime


class ProjectDigest(BaseModel):
    """One project's numbers for a listing row, all derived in one walk.

    The sibling of :class:`ProjectStats` and ``ProjectSummary`` for the question
    a dense project table asks: *how big is each project, how far along, and what
    is it waiting on?* Every field reuses an existing definition rather than
    coining one - the cross-references are on the fields - so a number here
    cannot disagree with the screen that owns it.

    A snapshot, never cached, never stored: the ``ProjectStats`` rule for the
    ``ProjectStats`` reason. ``stage`` is a description and not a capability;
    read :class:`ProjectStage`.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    #: Every asset in the project, trunk or not - ``ProjectStats.asset_count``.
    asset_count: int = Field(ge=0)
    #: Assets with at least one annotation - ``ProjectStats.annotated_asset_count``.
    annotated_asset_count: int = Field(ge=0)
    #: Classes in the **active** schema version, zero for a project with none -
    #: ``ProjectStats.class_count``.
    class_count: int = Field(ge=0)
    #: Every batch in the project, whatever its state.
    batch_count: int = Field(ge=0)
    #: Frames in ``in_annotation`` batches that an annotator still has to do:
    #: not in ``SETTLED_PROGRESS`` and not ``review_pending``. A frame a model
    #: labeled and nobody read (``pre_labeled``) is counted, because nobody has
    #: judged it. Batches in any other state contribute nothing - a draft has no
    #: jobs, and a completed batch has no work left by definition.
    frames_left: int = Field(ge=0)
    #: Frames in ``in_annotation`` batches in ``AssetProgress.REVIEW_PENDING`` -
    #: what ``SummaryService`` counts for ``AttentionKind.REVIEW_PENDING``.
    frames_in_review: int = Field(ge=0)
    #: Assets in the project's dataset trunk right now.
    dataset_asset_count: int = Field(ge=0)
    #: The newest release of the project's dataset, or ``None`` when none exists.
    latest_release: ReleaseDigest | None = None
    #: The newest of the four moments the workspace activity feed dates - an
    #: asset's arrival, a schema version, a release, a promotion - or ``None``
    #: when none of them is recorded. ``None`` means *unknown*, not *never*, and
    #: is not replaced by a stand-in date: the ``last_ingest_at`` rule.
    last_activity_at: datetime | None = None
    stage: ProjectStage

    @property
    def annotated_fraction(self) -> float:
        """Labeled share of the project, in ``0.0..1.0``; ``0.0`` over no assets.

        Derived for the reason ``ProjectStats.annotated_fraction`` is, and with
        the same identity element for an empty project.
        """
        if self.asset_count == 0:
            return 0.0
        return self.annotated_asset_count / self.asset_count
