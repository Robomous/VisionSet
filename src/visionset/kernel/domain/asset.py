# usage: from visionset.kernel.domain import Asset
from __future__ import annotations

import re
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator

_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")


class Asset(BaseModel):
    """A single ingested media item.

    Identity is the SHA-256 hash of the content (``content_hash``): the same
    bytes ingested twice are the same asset. Spatial metadata (width/height)
    is expressed in the asset's native reference frame — pixels for images.
    Only the "image" modality exists today; the field is typed to extend
    (video, pointcloud, ...) without changing the wire format.
    """

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    modality: Literal["image"] = "image"
    content_hash: str
    uri: str
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)

    @field_validator("content_hash")
    @classmethod
    def _content_hash_is_sha256_hex(cls, value: str) -> str:
        if not _SHA256_HEX.fullmatch(value):
            raise ValueError("content_hash must be 64 lowercase hex chars (SHA-256)")
        return value
