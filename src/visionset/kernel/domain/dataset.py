# usage: from visionset.kernel.domain import Dataset
from __future__ import annotations

from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class Dataset(BaseModel):
    """A named, curated selection of annotated assets, versioned via Releases."""

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    name: str
    description: str | None = None
