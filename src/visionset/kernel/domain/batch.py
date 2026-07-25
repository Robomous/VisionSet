# usage: from visionset.kernel.domain import Batch, BatchState
from __future__ import annotations

from enum import StrEnum
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class BatchState(StrEnum):
    """Lifecycle: draft -> approved -> in_annotation -> completed.

    Transition logic is a later session's concern; the states are the wire format.
    """

    DRAFT = "draft"
    APPROVED = "approved"
    IN_ANNOTATION = "in_annotation"
    COMPLETED = "completed"


class Batch(BaseModel):
    """A curated slice of a Project's assets that moves through annotation together."""

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    name: str
    state: BatchState = BatchState.DRAFT
    asset_ids: list[UUID] = Field(default_factory=list)
