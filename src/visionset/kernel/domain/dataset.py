# usage: from visionset.kernel.domain import Dataset, DatasetMember, DatasetChange
from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator


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


class DatasetChange(BaseModel):
    """One append-only entry in a Dataset's mutation log.

    Every mutation of the curated trunk is recorded — this is the base of
    reproducibility, and later of enterprise auditing. Entries are NEVER updated
    or deleted; the append-only discipline is DatasetService's to enforce.

    ``occurred_at`` is timezone-aware UTC, and that is the convention for every
    timestamp in the domain: a naive datetime is rejected outright rather than
    read as local time and silently misfiled once it crosses a machine boundary.
    ``actor`` is a placeholder until identities exist.
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
