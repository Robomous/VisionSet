# usage: from visionset.kernel.domain import Asset
from __future__ import annotations

import re
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator, model_validator

from visionset.kernel.domain.media import ImageFormat

_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")


class Asset(BaseModel):
    """A single ingested media item.

    Identity is the SHA-256 hash of the content (``content_hash``): the same
    bytes ingested twice are the same asset. Spatial metadata (width/height)
    is expressed in the asset's native reference frame — pixels for images.
    Only the "image" modality exists today; the field is typed to extend
    (video, pointcloud, ...) without changing the wire format.

    **Origin is provenance, not identity.** ``source_id`` and the frame fields
    record where these bytes were *first* seen, and are never rewritten when the
    same content arrives again — the rule ``Source.registered_at`` already
    follows. One image appearing in two registered directories is one asset with
    one origin, because the alternative is an asset whose recorded origin
    depends on which ingest happened to run last.

    Every origin field is optional, and each for its own reason.
    ``frame_index``/``frame_timestamp`` exist only for an asset cut out of a
    clip. ``format`` and ``source_id`` are absent on a row written before the
    ingest pipeline existed, and no default could be honest: the store cannot
    invent a format nobody probed.
    """

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    modality: Literal["image"] = "image"
    content_hash: str
    uri: str
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    #: What the bytes turned out to be, as the ``ImageProcessor`` read them.
    format: ImageFormat | None = None
    #: The registered origin these bytes were first seen in.
    source_id: UUID | None = None
    #: Position in the *extracted* sequence, for an asset cut out of a clip.
    frame_index: int | None = Field(default=None, ge=0)
    #: Seconds into the clip — the locator that survives a re-decomposition.
    frame_timestamp: float | None = Field(default=None, ge=0)

    @field_validator("content_hash")
    @classmethod
    def _content_hash_is_sha256_hex(cls, value: str) -> str:
        if not _SHA256_HEX.fullmatch(value):
            raise ValueError("content_hash must be 64 lowercase hex chars (SHA-256)")
        return value

    @model_validator(mode="after")
    def _frame_origin_is_whole(self) -> Asset:
        """A frame is located by an index *and* a timestamp, inside a source.

        Half a locator is worse than none. An index with no timestamp cannot be
        matched against a re-decomposition at another rate; a timestamp with no
        index cannot be ordered; and either without a ``source_id`` names a
        position in a clip nobody can point at.
        """
        missing_index = self.frame_index is None
        if missing_index != (self.frame_timestamp is None):
            raise ValueError("frame_index and frame_timestamp are given together or not at all")
        if not missing_index and self.source_id is None:
            raise ValueError("a frame origin needs the source it was extracted from")
        return self
