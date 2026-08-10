# usage: from visionset.kernel.domain import Asset
from __future__ import annotations

import re
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator

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

    ``thumbnail_hash`` is optional for a different reason again, and it is the
    one field here that is **not** provenance — see its own note below.
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
    #: A cached preview in the blob store, or NULL when none has been rendered.
    #:
    #: **A cache key, not an identity**, which is the whole reason this can sit
    #: beside the provenance fields without being one. It never enters a release
    #: manifest and ``ReleaseService.verify`` never recomputes it: two machines
    #: may hold different thumbnail bytes for one image, because determinism is
    #: promised within a Pillow build rather than across them. Losing every
    #: thumbnail blob loses only the CPU time to render them again.
    #:
    #: NULL therefore has one meaning with two causes — bytes that would not
    #: render, or an asset a run has not reached yet.
    #: ``IngestService.backfill_thumbnails`` is the remedy for both, and reads
    #: exactly this state.
    thumbnail_hash: str | None = None
    #: When these bytes first arrived in this project, or NULL when unknown.
    #:
    #: **First arrival, not last sighting** — the rule every provenance field
    #: beside it follows. Identity is content, so the second ingest of the same
    #: bytes writes no row and therefore does not touch this; "recent" answers
    #: *new to this project*, not *touched most recently*. That is the honest
    #: reading, because the second sighting created nothing.
    #:
    #: NULL means the row predates the column and **cannot be backfilled**: the
    #: information exists nowhere. ``Source.registered_at`` is not the proxy it
    #: looks like, since registration is idempotent on
    #: ``(kind, path, extraction_fps)`` and is never rewritten. Any invented value
    #: would be a plausible-looking wrong answer, so every consumer defines what
    #: unknown means instead: ``ProjectStats.last_ingest_at`` goes NULL and
    #: ``IngestService.assets`` sorts these last.
    #:
    #: Defaulted to ``None`` and stamped by ``IngestService`` rather than by a
    #: ``default_factory``: a factory would make every ``Asset(...)`` built
    #: anywhere claim an arrival, and this column's whole value is that NULL stays
    #: NULL. Declared last, after ``thumbnail_hash``, because it arrives by
    #: ``ALTER TABLE``.
    ingested_at: datetime | None = None

    @field_validator("content_hash", "thumbnail_hash")
    @classmethod
    def _is_sha256_hex(cls, value: str | None, info: ValidationInfo) -> str | None:
        """Both fields name a blob, so both are checked by the one rule.

        A second regex for the second field is how the two drift apart. ``None``
        passes through because ``thumbnail_hash`` is optional and
        ``content_hash`` is not — pydantic has already refused a missing one by
        the time a validator runs.
        """
        if value is not None and not _SHA256_HEX.fullmatch(value):
            raise ValueError(f"{info.field_name} must be 64 lowercase hex chars (SHA-256)")
        return value

    @field_validator("ingested_at")
    @classmethod
    def _ingested_at_is_timezone_aware(cls, value: datetime | None) -> datetime | None:
        """The convention every timestamp in the domain follows.

        A naive datetime is rejected rather than assumed to be UTC: the store
        keeps ISO-8601 text, so an unqualified value read back would be
        indistinguishable from a qualified one and quietly wrong by the writer's
        offset from UTC.
        """
        if value is not None and value.tzinfo is None:
            raise ValueError("ingested_at must be timezone-aware (UTC)")
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
