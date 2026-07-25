# usage: from visionset.kernel.domain import Workspace
from __future__ import annotations

from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class Workspace(BaseModel):
    """Top-level container: one workspace holds projects and owns local storage."""

    id: UUID = Field(default_factory=uuid4)
    name: str
    root_dir: str | None = None
