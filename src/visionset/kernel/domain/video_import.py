# usage: from visionset.kernel.domain import VideoImport, VideoImportState
"""A browser-driven video import: the durable session, and the frames staged in it.

The server does not decode video. A client materializes frames from a file that
never leaves the machine it is on, and posts them here as ordinary PNG bytes —
so what used to be one synchronous ingest becomes a **session** with a middle:
open it, stream frames into it, and commit the lot or throw it away.

That middle is the whole reason these two models exist. A staged frame is not an
``Asset``: it is stored, hashed and counted, and it is invisible to every read
that answers "what is in this project". Nothing a caller abandons — a closed tab,
a refused frame, a cancelled dialog — leaves a trace in the dataset. The
commit is the single moment staged bytes become assets, and until it happens the
project is exactly what it was before ``start``.

**The grid is not moved here.** ``canonical_ranges``, ``grid_bounds``,
``expected_frames`` and ``scaled_dimension`` stay in ``domain/source.py``, where
they were written for the old server-side extraction and are already mirrored in
TypeScript. A session's ``expected_frame_count`` is that same arithmetic over the
same selection — one formula, three surfaces — and the client is trusted to place
frames on the grid but never to say how many of them there should be.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Final
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator

from visionset.kernel.domain.media import ImageFormat

VIDEO_FRAME_FORMAT: Final = ImageFormat.PNG
"""What every frame of a video import is, and the only encoding accepted.

Lossless, and fixed rather than negotiated: a frame is the ground truth a
dataset is built on, and a client choosing JPEG would quietly bake its quantizer
into somebody's training set. ``VideoImportService`` decodes what it is handed
and refuses anything else, so this is a rule the server checks rather than a
convention the client is asked to honour.
"""

DEFAULT_EXTRACTION_FPS: Final = 1.0
"""The rate a clip is decomposed at unless a caller says otherwise.

One frame a second, which for most footage is already more images than anybody
wants to label. It lives in the domain because it is part of what a source *is*
— see ``domain/source.py`` — and every surface that offers the choice has to
name the same default.
"""

SAMPLING_POLICY_VERSION: Final = 1
"""Which spelling of the sampling rules produced a source's frames.

Recorded on :class:`~visionset.kernel.domain.source.VideoProvenance` because
frame bytes are **not** reproducible across materializers: two browsers may
disagree over the same container, and a damaged one is where they disagree
first. Rather than promise a reproducibility nobody can keep, the record
says which policy was in force — so a future change to the grid, the rotation
rule or the resampling is legible in the data instead of being an unexplained
difference between two batches.
"""


class VideoImportState(StrEnum):
    """Lifecycle: ``open`` -> (``committed`` | ``aborted``). Both ends are final.

    No transition table beside it, unlike ``BatchState`` or ``IngestState``.
    Those have enough edges — and enough callers asking "may I?" before moving —
    that the legality is a fact worth declaring once and testing as a whole. This
    has two edges out of one state and exactly one service that moves it, so a
    table would be a lookup restating the guard next to it.

    There is no edge back to ``open``, and that is the invariant the session
    exists to protect. A committed session has already turned its staged frames
    into assets somebody may be annotating; an aborted one has thrown its frames
    away. Re-opening either would mean appending frames to a count that has
    already been spent.
    """

    OPEN = "open"
    COMMITTED = "committed"
    ABORTED = "aborted"


class VideoImport(BaseModel):
    """One browser-driven import of one clip: how much is expected, how much arrived.

    ``validate_assignment`` for ``Source``'s reason — the service moves
    :attr:`state` and fills :attr:`batch_id` by assignment, and a field validator
    that only ran at construction would let a naive timestamp in through the back
    door.

    :attr:`expected_frame_count` is computed **by the server** from the metadata
    and selection the caller declared, through the same ``expected_frames`` the
    ingest screen shows. It is what makes "complete" a fact rather than a client
    assertion: a session commits only when that many distinct ordinals have
    arrived, so a materialization that died halfway cannot quietly produce a
    batch missing a third of its frames.

    :attr:`received_frame_count` counts **distinct ordinals**, not appends. Re-posting
    a frame that is already staged is an ordinary retry — a dropped connection
    on a chunked upload is the common case — so it must not advance progress.

    :attr:`target_batch_id` and :attr:`batch_name` are the two ways of saying
    where the frames should land, and at most one of them is ever set. The first
    names a draft batch that already exists — the way a second source joins the
    first one's batch — and the second names a batch commit will create;
    ``None`` for both means nobody said, and commit falls back to the source's
    name. The target is recorded at ``start`` rather than passed at commit
    because it is checked at ``start``: a batch that cannot take these frames is
    worth hearing about before minutes of decoding, not after.

    :attr:`batch_id` is a different field from :attr:`target_batch_id` and not a
    duplicate of it. It is the batch this session **reached**, NULL until commit
    for the reason ``IngestJobRow.batch_id`` is: a session that never commits
    never reaches one, whether or not it was aimed at a batch that exists.
    """

    model_config = ConfigDict(validate_assignment=True)

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    source_id: UUID
    state: VideoImportState = VideoImportState.OPEN
    expected_frame_count: int = Field(ge=0)
    received_frame_count: int = Field(default=0, ge=0)
    batch_name: str | None = None
    target_batch_id: UUID | None = None
    batch_id: UUID | None = None
    started_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @property
    def is_complete(self) -> bool:
        """Whether every grid point the selection holds has arrived."""
        return self.received_frame_count >= self.expected_frame_count

    @field_validator("started_at", "updated_at")
    @classmethod
    def _timestamps_are_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("video import timestamps must be timezone-aware (UTC)")
        return value.astimezone(UTC)


class IncomingFrame(BaseModel):
    """One frame a client offers, before the server has looked at it.

    Deliberately **not** a :class:`StagedFrame`: it carries bytes and no content
    hash, because the hash is the server's answer to "what did I actually
    receive" and is the only hash that can adjudicate an idempotency conflict. A
    client-supplied digest would let a caller claim two different frames are the
    same one, which is precisely the claim the conflict rule exists to refuse.

    :attr:`width` and :attr:`height` are a **declaration**, checked against the
    decode rather than trusted. They are worth carrying for that reason alone:
    a descriptor that disagrees with its bytes means the client's grid and the
    server's record have drifted apart, and finding that out now is much cheaper
    than finding it out in a training run.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    ordinal: int = Field(ge=0)
    requested_timestamp: float = Field(ge=0)
    source_timestamp: float | None = Field(default=None, ge=0)
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    content: bytes


class StagedFrame(BaseModel):
    """One frame held for a session, stored but not yet part of the project.

    Frozen, like every other value in this domain that is a pure function of
    some bytes and a choice. A staged frame is never edited: a second append at
    the same ordinal either presents the identical bytes, in which case there is
    nothing to write, or presents different ones, in which case it is refused.

    :attr:`requested_timestamp` and :attr:`source_timestamp` are two different
    numbers and conflating them is the mistake this pair exists to prevent. The
    first is the grid point ``ordinal / extraction_fps`` — exact, derived, the
    same on every machine. The second is the presentation time of the sample the
    decoder actually drew for it, which lands on whatever the encoder chose and
    is equal to the request only by coincidence. ``None`` means the client did
    not report one; nothing infers it from the other.

    :attr:`content_hash` is what the **server** hashed out of the bytes it
    received — see :class:`IncomingFrame`. :attr:`thumbnail_hash` is a cache
    rendered at append rather than at commit, so the commit is metadata only and
    a long write transaction never waits on an encoder; NULL means the preview
    would not render, which ``IngestService.backfill_thumbnails`` already treats
    as its own remedy.

    :attr:`id` exists so this row is an ordinary entity in the store, addressed
    the way every other one is. It is not the identity that matters: ``(import_id,
    ordinal)`` is, and the table's unique constraint is what says so.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID = Field(default_factory=uuid4)
    import_id: UUID
    ordinal: int = Field(ge=0)
    requested_timestamp: float = Field(ge=0)
    source_timestamp: float | None = Field(default=None, ge=0)
    content_hash: str
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    image_format: ImageFormat = VIDEO_FRAME_FORMAT
    thumbnail_hash: str | None = None

    @property
    def timestamp(self) -> float:
        """When in the clip this frame is: what was drawn, else what was asked for.

        The number an ``Asset`` records. The sample actually drawn is the honest
        answer, and the grid point is the fallback for a client that reported
        nothing rather than a value invented to fill a column.
        """
        return self.requested_timestamp if self.source_timestamp is None else self.source_timestamp
