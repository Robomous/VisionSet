# usage: from visionset.kernel.domain import TaskGroup, AnnotationJob, AssetProgress
from __future__ import annotations

from enum import StrEnum
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class AnnotationJobState(StrEnum):
    """Lifecycle: pending -> in_progress -> completed. Transitions land later."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


class AssetProgress(StrEnum):
    """Per-asset annotation progress inside a job."""

    UNANNOTATED = "unannotated"
    ANNOTATED = "annotated"
    SKIPPED = "skipped"
    REVIEW_PENDING = "review_pending"
    ACCEPTED = "accepted"


class TaskGroup(BaseModel):
    """Partition of a Batch into assignable units of annotation work."""

    id: UUID = Field(default_factory=uuid4)
    batch_id: UUID
    name: str


class AnnotationJob(BaseModel):
    """One annotator's unit of work over a set of assets."""

    id: UUID = Field(default_factory=uuid4)
    task_group_id: UUID
    state: AnnotationJobState = AnnotationJobState.PENDING
    progress: dict[UUID, AssetProgress] = Field(default_factory=dict)
