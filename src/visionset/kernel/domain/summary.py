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

**No timestamp here dates a person's work, and that is a fact about the storage
format rather than an omission.** There is no timestamp column on ``batch``, on
``annotation``, or on ``annotation_job_asset`` — nothing records when a batch was
created, when it changed state, when a label was drawn, or when an asset's
progress last moved. Every consequence that follows in this module, chiefly
:class:`ResumeTarget`'s ranking, comes from that one absence.
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
    """The batch to carry on with, and where inside it to land.

    **Ranked by progress, not by recency, and the reason is structural.** No
    timestamp exists anywhere on a batch, an annotation, or an asset's progress
    row, so "the batch I touched last" has no source in the schema and deriving
    one would mean a migration. What the data *can* answer is which batch is
    furthest along and not yet finished — the batch you are part-way through —
    and that is what this is.

    The substitution is acceptable because of two properties. It degrades
    correctly: a workspace with one open batch is offered that batch whatever its
    progress. And it claims only what is true by construction, where a recency
    ordering would have claimed something the rows cannot support.

    The accepted limit, stated so nobody reports it as a defect: two batches
    part-way through resolve to the further-along one rather than to the one
    somebody touched most recently.

    ``next_asset_id`` is NULL when nothing in the batch is ``unannotated`` any
    more — every frame is settled or waiting on review. That is not an error and
    not an empty resume: the batch is still the one to open, so the caller sends
    somebody to its gallery instead of into the editor. A surface rendering this
    changes its own label accordingly.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    project_id: UUID
    project_name: str
    batch_id: UUID
    batch_name: str
    #: The annotation job holding ``next_asset_id``. The editor is keyed on a
    #: job, not on a batch, so a caller with only a batch cannot open it.
    #:
    #: NULL for a batch that has no jobs at all, which is possible while a batch
    #: is open but unpartitioned. Such a batch is still worth offering — it may
    #: be the only thing open — but it can only be opened as a gallery, so a
    #: caller treats a NULL here the way it treats a NULL ``next_asset_id``.
    job_id: UUID | None = None
    #: The first ``unannotated`` asset in batch order, or NULL — see above.
    next_asset_id: UUID | None = None
    #: Settled assets, i.e. those not blocking the job from completing. Counted
    #: against ``SETTLED_PROGRESS`` rather than against ``annotated`` alone, so a
    #: skipped frame reads as dealt with rather than as outstanding.
    annotated: int = Field(ge=0)
    total: int = Field(ge=0)
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
