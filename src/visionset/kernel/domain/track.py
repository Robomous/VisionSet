# usage: from visionset.kernel.domain import Track, TrackObservation, TrackDetail, TrackStatus
"""A track: one object followed through the frame occurrences of one source.

A track is a set of observations, and an observation names a frame occurrence
and an ordinary asset annotation drawn at it. The annotation carries no track
field; the observation is the only link. A track belongs to exactly one source,
observes an occurrence at most once, and an annotation is observed at most once
anywhere. Nothing about a track is stored beyond its identity, its class and an
optional imported id: where it starts, where it ends and how far its work has
got are all read off its observations.
"""

from __future__ import annotations

from collections.abc import Mapping
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

from visionset.kernel.domain.task import SETTLED_PROGRESS, AssetProgress


class Track(BaseModel):
    """One object followed through one source."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID = Field(default_factory=uuid4)
    source_id: UUID
    #: Every observed annotation carries exactly this class.
    label_class: str = Field(min_length=1)
    #: An identity a dataset brought with it, unique within the source.
    external_id: str | None = Field(default=None, min_length=1)


class TrackObservation(BaseModel):
    """One occurrence a track observes, and the annotation drawn there."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID = Field(default_factory=uuid4)
    track_id: UUID
    occurrence_id: UUID
    annotation_id: UUID


class ObservedFrame(BaseModel):
    """An observation read with the occurrence it names."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    occurrence_id: UUID
    position: int
    timestamp: float
    asset_id: UUID
    annotation_id: UUID


class TrackDetail(BaseModel):
    """A track and its observations, in source position order."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    track: Track
    observations: tuple[ObservedFrame, ...]


class TrackStatus(BaseModel):
    """How far one batch's work on a track's observed assets has got.

    Derived on every read and never stored. ``progress`` counts observations by
    the progress of the asset each sits on in the batch's job holding it;
    ``outside`` counts observations on assets the batch does not hold. An asset
    observed at two occurrences is counted twice, once per observation.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    track_id: UUID
    batch_id: UUID
    progress: Mapping[AssetProgress, int]
    outside: int = Field(ge=0)

    @property
    def settled(self) -> bool:
        """Every observation the batch holds sits on a settled asset."""
        return all(
            count == 0 for state, count in self.progress.items() if state not in SETTLED_PROGRESS
        )
