# usage: from visionset.kernel.domain import Source
from __future__ import annotations

from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class Source(BaseModel):
    """Where assets come from. Only local folders today; typed to extend."""

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    kind: Literal["local_folder"] = "local_folder"
    uri: str
