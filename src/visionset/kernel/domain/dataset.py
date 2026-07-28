# usage: from visionset.kernel.domain import Dataset, DatasetMember, DatasetChange
from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Dataset(BaseModel):
    """A named, curated selection of annotated assets, versioned via Releases."""

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    name: str
    description: str | None = None


class DatasetMember(BaseModel):
    """One asset's membership in a Dataset.

    Membership is a row rather than a list on ``Dataset`` because it is the thing
    promotion adds to and curation removes from, one asset at a time. It carries
    its own ``id`` so it addresses like every other entity, and
    ``(dataset_id, asset_id)`` is unique. The rules that govern promotion and
    removal belong to DatasetService, not here.
    """

    id: UUID = Field(default_factory=uuid4)
    dataset_id: UUID
    asset_id: UUID


class DatasetOperation(StrEnum):
    """What DatasetService writes into ``DatasetChange.operation``.

    One name per mutation the trunk can undergo. It is an enum so that the
    service cannot misspell one and so that a reader has somewhere to look up
    what the log can say — but it is deliberately NOT the type of the field it
    is written into; see ``DatasetChange.operation``.
    """

    PROMOTE = "promote"
    REMOVE_ASSET = "remove_asset"


class DatasetChange(BaseModel):
    """One append-only entry in a Dataset's mutation log.

    Every mutation of the curated trunk is recorded — this is the base of
    reproducibility, and later of enterprise auditing. Entries are NEVER updated
    or deleted; the append-only discipline is DatasetService's to enforce.

    ``operation`` is a plain ``str``, not :class:`DatasetOperation`, and that is
    the point of having both. A log outlives the build that wrote it: narrowing
    the field to today's enum would make an entry written by a later VisionSet —
    naming an operation this build has never heard of — fail to load, turning a
    forward-compatible record into an unreadable one. The enum is what a *writer*
    picks from; the field accepts whatever a *reader* finds on disk.

    ``subject_ids`` is the ids the operation was about, and its shape is per
    operation:

    ===================== ===============================================
    ``operation``         ``subject_ids``
    ===================== ===============================================
    ``promote``           the batch, then the assets it contributed
    ``remove_asset``      the one asset
    ===================== ===============================================

    Keeping the batch in the promote entry is what makes the log answer *where
    this came from* and not only *what changed* — without a column that only one
    of the two operations could ever fill.

    ``occurred_at`` is timezone-aware UTC, and that is the convention for every
    timestamp in the domain: a naive datetime is rejected outright rather than
    read as local time and silently misfiled once it crosses a machine boundary.
    ``actor`` is a placeholder until identities exist — ``AuthProvider`` verifies
    tokens and does not yet resolve anyone, so the kernel records what a surface
    hands it rather than inventing a name.
    """

    id: UUID = Field(default_factory=uuid4)
    dataset_id: UUID
    operation: str
    subject_ids: list[UUID] = Field(default_factory=list)
    actor: str | None = None
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("occurred_at")
    @classmethod
    def _occurred_at_is_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("occurred_at must be timezone-aware (UTC)")
        return value.astimezone(UTC)


class ClassCount(BaseModel):
    """How much of one label class a Dataset holds.

    Two numbers rather than one, because they answer different questions. A
    thousand ``sign`` annotations spread over a thousand images and the same
    thousand crammed into ten are the same ``annotations`` and a very different
    dataset, and it is ``assets`` that tells them apart.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    label_class: str
    annotations: int = Field(ge=0)
    #: Distinct member assets carrying at least one annotation of this class.
    assets: int = Field(ge=0)


class DatasetStats(BaseModel):
    """What the curated trunk currently holds, counted.

    A snapshot rather than a stored aggregate: the trunk is the live set, and a
    cached count is a second source of truth for a number that is cheap enough
    to derive. ``Release.asset_count`` is the frozen counterpart, and it belongs
    to the release rather than to the dataset for exactly that reason.

    ``per_class`` is ordered by class name here rather than wherever the walk
    happened to visit the annotations — the ``Manifest`` rule, that canonical
    ordering belongs to the artifact and not to the caller that built it. It
    lists only classes that appear at least once; a schema class nobody has used
    is a fact about the *schema*, and reading it off the stats would be reading
    it off the wrong document.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    dataset_id: UUID
    asset_count: int = Field(ge=0)
    #: Members carrying at least one annotation. The rest are unlabeled, which
    #: is legitimate — ``EmptyRelease`` refuses zero assets, never zero labels.
    annotated_asset_count: int = Field(ge=0)
    annotation_count: int = Field(ge=0)
    per_class: tuple[ClassCount, ...] = ()

    @field_validator("per_class")
    @classmethod
    def _in_canonical_order(cls, value: tuple[ClassCount, ...]) -> tuple[ClassCount, ...]:
        return tuple(sorted(value, key=lambda count: count.label_class))
