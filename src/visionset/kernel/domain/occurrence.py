# usage: from visionset.kernel.domain import FrameOccurrence
"""Where in a source an asset's bytes occurred.

An asset is bytes, and identical bytes at two positions of one clip are one
asset. A :class:`FrameOccurrence` keeps the position the asset cannot: it names a
source, the source-local ordinal of its extraction grid, and the asset that
position decoded to. ``(source_id, position)`` is the identity, and the table's
unique constraint is what says so. Gaps and unselected ranges are absent
positions, never rows.
"""

from __future__ import annotations

from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field


class FrameOccurrence(BaseModel):
    """One position of one source, and the asset that position decoded to."""

    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    id: UUID = Field(default_factory=uuid4)
    source_id: UUID
    #: The extraction-grid ordinal, the same one an asset URI carries as ``#frame=``.
    position: int = Field(ge=0)
    #: Seconds into the clip, as recorded for the frame drawn at this position.
    timestamp: float = Field(ge=0)
    asset_id: UUID
