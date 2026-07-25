# usage: from visionset.kernel.domain import Release, Manifest
from __future__ import annotations

from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class Manifest(BaseModel):
    """Immutable inventory of a Release: what went in, under which schema."""

    schema_version: int = Field(ge=1)
    asset_count: int = Field(default=0, ge=0)
    annotation_count: int = Field(default=0, ge=0)
    content_hashes: list[str] = Field(default_factory=list)


class Release(BaseModel):
    """An immutable, exportable snapshot of a Dataset."""

    id: UUID = Field(default_factory=uuid4)
    dataset_id: UUID
    tag: str
    manifest: Manifest
