"""The workspace, summarized — what needs attention and where to continue.

Every model here is a **projection**. Nothing in this module is stored, nothing
is an entity, and none of it has an id of its own: a summary is recomputed on
every call out of rows that other services own, the way ``ProjectStats`` and
``DatasetStats`` already are. That is what keeps it from becoming a second source
of truth for numbers a walk can answer.

The scope is the whole workspace, which is what makes it new. ``ProjectStats``
answers "what does this project hold" and ``DatasetStats`` answers "what would I
train on"; neither can answer "which of my projects is waiting on me", because
neither is allowed to look at more than one.

**One timestamp here dates a person's work, and it is the only one.**
``annotation_job_asset.touched_at`` records when somebody last moved a frame's
progress, and :class:`ResumeTarget` is ranked on it. Nothing else in the storage
format does: a ``batch`` records neither when it was created nor when it changed
state, and an ``annotation`` records nothing at all. So a batch nobody has worked
still has no age, which is what the ranking's second population is about, and the
activity feed is still derived from timestamps that were put there for other
reasons.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class AttentionKind(StrEnum):
    """What sort of thing a row of the attention list is.

    A ``StrEnum`` rather than a plain ``str`` on the ``SourceKind`` test: no
    writer outside this build produces one, the value decides how a row renders,
    and the set grows deliberately. Contrast ``DatasetChange.operation``, which
    is a plain ``str`` precisely because a log outlives the build that wrote it.
    """

    #: A batch holding frames whose review has not happened.
    REVIEW_PENDING = "review_pending"
    #: A queued unit of machine work that stopped and said why.
    JOB_FAILED = "job_failed"
    #: A queued unit of machine work still going.
    JOB_RUNNING = "job_running"


# This docstring ships verbatim into `openapi.json`, so it says what a client
# needs and no more. The reasoning it used to carry belongs here instead.
#
# **The order is a decision this module owns, not a fact the response restates.**
# Labeling first, then review, then a batch that needs neither, is a judgment
# about what somebody should do next — and a judgment spelled once in Python and
# again in whatever renders it is one that drifts. That is what distinguishes it
# from the summary's first-run state, which is deliberately *not* a field:
# "this workspace has no projects" is a count the response already carries, so a
# flag beside it would be a second spelling of the same number.
class ResumeKind(StrEnum):
    """What an open batch is being offered for, and so what `next_asset_id` is.

    `annotate` - a frame nobody has judged, whether nobody has labeled it or
    only a model has, which is that frame. `review` - every frame is judged
    and some await a reviewer, which is the first of those. `open` - neither,
    and `next_asset_id` is null.
    """

    ANNOTATE = "annotate"
    REVIEW = "review"
    OPEN = "open"


class ActivityKind(StrEnum):
    """What sort of thing a row of the activity feed is.

    Four kinds, and two of them are approximations the interface must not
    overstate. See :class:`ActivityEntry` for which and why.
    """

    RELEASE_PUBLISHED = "release_published"
    BATCH_PROMOTED = "batch_promoted"
    INGEST = "ingest"
    SCHEMA_VERSION = "schema_version"


class WorkspaceTotals(BaseModel):
    """Four counts over the whole workspace.

    ``annotations`` is the one that costs anything: it is the only number here
    that cannot be had from a row count the caller was already reading, which is
    why ``UnitOfWork.count_annotations`` exists.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    projects: int = Field(ge=0)
    #: Every asset ingested into any project, whatever batch it landed in.
    assets: int = Field(ge=0)
    annotations: int = Field(ge=0)
    releases: int = Field(ge=0)


class ResumeTarget(BaseModel):
    """The batch to carry on with, where inside it to land, and what for.

    **Ranked by recency, and by progress only where recency has nothing to say.**
    ``annotation_job_asset.touched_at`` is stamped whenever somebody moves a
    frame, so a batch that has been worked outranks every batch that has not, and
    the latest touch wins among those that have. Batches nobody has touched are
    ranked among themselves the way the whole card used to be ranked: furthest
    through first, ties to the later-created batch, which is the closest thing to
    recency insertion order can offer.

    That second population is not a leftover. ``touched_at`` was added rather
    than backfilled, because the moments it holds were never recorded anywhere —
    so every row in a workspace that predates it is NULL, and the fallback is
    what makes such a workspace behave exactly as it did before while converging
    to real recency as soon as anybody uses it.

    ``kind`` decides the rest, and it is the field to read first. It says whether
    ``next_asset_id`` is a frame to label, a frame to review, or absent — see
    :class:`ResumeKind`. A batch is offered as ``open`` when it is settled
    throughout: not an error and not an empty resume, just a batch worth opening
    with no frame to open it at.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    #: What this batch is being offered for, and therefore what a surface should
    #: promise on its control. Resolved here rather than by whoever renders it,
    #: because the order between the three is a decision rather than a fact.
    kind: ResumeKind
    project_id: UUID
    project_name: str
    batch_id: UUID
    batch_name: str
    #: The annotation job holding ``next_asset_id``. The editor is keyed on a
    #: job, not on a batch, so a caller with only a batch cannot open it.
    #:
    #: Never NULL, and that is a guarantee the kernel already enforces upstream:
    #: approving an empty batch raises ``EmptyBatch``, so a batch that reached
    #: ``in_annotation`` has at least one job. A batch with none is not offered
    #: at all rather than offered with nothing to open.
    job_id: UUID
    #: Where to land, in batch order: the first ``unannotated`` or
    #: ``pre_labeled`` frame under ``annotate``, the first ``review_pending``
    #: one under ``review``, NULL under ``open``. Which of those it is comes
    #: off ``kind``.
    next_asset_id: UUID | None = None
    #: Settled assets, i.e. those not blocking the job from completing. Counted
    #: against ``SETTLED_PROGRESS`` rather than against ``annotated`` alone, so a
    #: skipped frame reads as dealt with rather than as outstanding.
    annotated: int = Field(ge=0)
    total: int = Field(ge=0)
    #: Frames in this batch waiting on a reviewer. Always populated, not only
    #: under ``review``: a batch can hold frames for review and unlabeled frames
    #: at once, and a surface showing the count only in the state where it is the
    #: headline would hide the more interesting case.
    review_pending: int = Field(ge=0)
    #: A frame to show beside the card, or NULL when the batch holds none that
    #: records a cached preview. The caller reaches the bytes by asset id, the
    #: way every other thumbnail in the product is addressed.
    thumbnail_asset_id: UUID | None = None


class AttentionItem(BaseModel):
    """One row of "needs your attention".

    **A flat row carrying a ``kind``, deliberately not a discriminated union.**
    The three kinds differ in which optional fields they fill, not in shape, and
    three variants would triple the wire models, the generated runtime checks and
    every fixture for no behaviour anybody can observe. The union shape is right
    where variants carry genuinely different *data* — ``Geometry`` is the
    precedent — and wrong here.

    ``project_id`` is NULL where the row cannot be resolved to one. A background
    job's payload names an ingest job or a release, never a project, so the
    project is recovered by walking the edge where one exists and left absent
    where it does not. A row with no project is rendered without a link rather
    than with a dead one.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: AttentionKind
    #: The batch, for a review row; the background job, for the other two.
    subject_id: UUID
    project_id: UUID | None = None
    project_name: str | None = None
    #: A human-facing name for the subject: the batch's, or the job's type.
    label: str
    #: Frames awaiting review, for ``review_pending``. NULL for a job row.
    count: int | None = Field(default=None, ge=0)
    #: Items dealt with so far, for ``job_running``. NULL otherwise.
    processed: int | None = Field(default=None, ge=0)
    #: Items the run expects, or NULL when that is not knowable up front — the
    #: rule ``BackgroundJob.total`` states, kept because a progress bar that
    #: tolerates the absence is the only thing that reads it.
    total: int | None = Field(default=None, ge=0)
    #: The fatal cause, for ``job_failed``. NULL otherwise.
    detail: str | None = None


class ProjectSummary(BaseModel):
    """One row of "recent projects" — a pointer, not a copy of the list.

    Two numbers, because a shortcut that reproduced the project list would be a
    second surface to keep in step with it. ``annotated_fraction`` is ``0.0``
    over an empty project rather than NULL: a share has an honest identity
    element where a date does not, which is the split ``ProjectStats`` draws
    between its own fraction and ``last_ingest_at``.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    project_id: UUID
    name: str
    asset_count: int = Field(ge=0)
    annotated_fraction: float = Field(ge=0.0, le=1.0)


class ActivityEntry(BaseModel):
    """One row of the activity feed.

    **A projection over timestamps that already exist, never an event log.** The
    four kinds are not equally direct, and the two that are approximations are
    marked here rather than left for a reader to discover:

    ``release_published`` is exact — publishing is the only way a release comes
    to exist, so its creation time is its publication time. ``batch_promoted`` is
    exact — ``DatasetChange`` is the one append-only, timestamped, actor-attributed
    log the schema has, and a promotion entry's subject ids begin with the batch.

    ``ingest`` is the newest ``Asset.ingested_at`` in the project, because
    ``IngestJob`` records no times at all. It reads as *the last data that
    arrived here*, not as one run finishing, and a surface must not say
    otherwise. ``schema_version`` is a version's **creation**: which version is
    active is derived — it is the highest — so there is no activation to date.

    Flat with a ``kind``, for the reason :class:`AttentionItem` gives.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: ActivityKind
    occurred_at: datetime
    project_id: UUID
    project_name: str
    #: The release, batch, project or schema this row is about. For ``ingest``
    #: there is no run to name, so it is the project itself.
    subject_id: UUID
    #: The release tag, the batch name, the schema version. NULL where the kind
    #: has nothing to name.
    label: str | None = None
    #: Assets promoted, or assets that arrived. NULL for the kinds without a
    #: count.
    count: int | None = Field(default=None, ge=0)


class WorkspaceSummary(BaseModel):
    """Everything the workspace's front page asks for, in one answer.

    Composed rather than assembled by the caller, so that a front page is one
    request rather than six. It is a **read-only projection**: it declares no
    actions of its own and no mutation takes it as input. Every row here points
    at a resource whose own wire shape declares what may be done to it, which is
    what keeps the capabilities contract with one owner per capability.

    ``resume`` is NULL when no batch is open for annotation — a workspace that is
    ingesting, or reviewing, or finished. An empty workspace reads NULL here and
    zero everywhere else, which is the first-run state and needs no flag of its
    own: *no projects* is already the question a caller would ask a flag.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    totals: WorkspaceTotals
    resume: ResumeTarget | None = None
    attention: tuple[AttentionItem, ...] = ()
    #: Newest first, capped by the service. A shortcut, not the project list.
    projects: tuple[ProjectSummary, ...] = ()
    #: Newest first, capped by the service, so the wire never carries a feed
    #: longer than anything renders.
    activity: tuple[ActivityEntry, ...] = ()
