# usage: from visionset.kernel.domain import Project
from __future__ import annotations

from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class Project(BaseModel):
    """A dataset-building effort inside a Workspace, governed by one AnnotationSchema."""

    id: UUID = Field(default_factory=uuid4)
    workspace_id: UUID
    name: str
    description: str | None = None
