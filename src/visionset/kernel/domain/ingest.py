# usage: from visionset.kernel.domain import IngestJob
from __future__ import annotations

from enum import StrEnum
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class IngestState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class IngestJob(BaseModel):
    """Tracks one ingestion run of a Source into a Project's asset pool."""

    id: UUID = Field(default_factory=uuid4)
    source_id: UUID
    state: IngestState = IngestState.PENDING
    error: str | None = None
