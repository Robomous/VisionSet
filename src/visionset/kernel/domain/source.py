# usage: from visionset.kernel.domain import Source, SourceKind, VideoProvenance
"""Where a project's raw data came from, and what we know about it.

A :class:`Source` is the record that some bytes were *offered* to a project. It
is not annotatable and holds no pixels: it names an origin on disk, says when it
was registered, and — for a clip — carries what ``VideoProcessor.probe`` read off
it plus the rate a decomposition will run at. Assets are what an ingest
*materializes* from it; this is the receipt.

**Decomposition parameters live here, not on the ingest job.** A source can be
ingested more than once, and the promise is that the same source yields the same
assets. That promise only means something if the parameters are part of what
"the same source" *is* — put them on the job and two runs of one source could
legitimately disagree, leaving idempotency with nothing to be measured against.
The consequence is deliberate: one clip registered at 1 fps and again at 5 fps is
two sources over one file, not one source with a history.

**Paths are canonicalized once**, by :func:`canonical_path`, so ``./data`` and
``/abs/data`` are one source rather than two. See that function for what
canonicalization does and does not promise.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path, PurePath
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from visionset.kernel.domain.media import VideoMetadata
from visionset.kernel.errors import WorkspaceCorrupt


class SourceKind(StrEnum):
    """The shapes of raw input VisionSet accepts.

    An enum, where ``DatasetChange.operation`` and ``VideoMetadata.codec`` are
    plain ``str``. That doctrine turns on one question — *can something outside
    this build write the value?* A change-log entry outlives the release that
    wrote it and a codec name is whatever ffmpeg decides to call it, so both have
    to stay readable when they name something this build never heard of.

    Neither applies here. ``SourceService`` is the only door to a ``Source``, so
    no foreign writer exists; the kernel **branches** on this value, in the two
    registration methods and in the invariant tying :attr:`Source.video` to
    :attr:`SourceKind.VIDEO`, and a branch on a magic string is the shape this
    codebase replaces with a table; and the set grows by a deliberate kernel
    change with a service method behind it. That is ``ImageFormat`` /
    ``BatchState`` / ``IngestState`` territory, and it costs persistence nothing
    — a ``StrEnum`` member *is* a ``str``.
    """

    IMAGE_DIRECTORY = "image_directory"
    VIDEO = "video"


def canonical_path(path: Path) -> str:
    """The one spelling of an origin, so two names for it are one source.

    ``resolve()`` makes the path absolute and follows symlinks, which is what
    makes ``./data``, ``../project/data`` and ``/abs/data`` agree. Two things it
    deliberately does not do:

    - **It does not normalize case.** On a case-insensitive filesystem — macOS by
      default, Windows always — ``/Data`` and ``/data`` are one directory and
      would register as two sources. Lower-casing here would be wrong on Linux,
      where they are genuinely two.
    - **It does not look at the content.** Two hard links to one inode read as two
      origins. What the bytes *are* is asked at ingest, where the answer is a
      content hash.

    Raises:
        FileNotFoundError: nothing exists at that path. An origin that is not
            there is a provenance nobody can ever check.
    """
    return str(path.resolve(strict=True))


class VideoProvenance(BaseModel):
    """What a clip was, and how we chose to cut it.

    :attr:`metadata` is ``VideoProcessor.probe``'s answer, kept whole rather than
    re-spelled field by field: ``fps`` there is the *original* rate the file was
    shot at, which is provenance, and re-declaring it beside
    :attr:`extraction_fps` is how the two come to be confused. Note that
    video-derived asset identity is reproducible within one ffmpeg build and not
    across builds — see ``ports/video_processor.py`` — so these numbers describe
    the file, not a promise about what a later re-ingest will produce.

    Frozen, like every other value in the domain that is a pure function of some
    bytes and a choice.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    metadata: VideoMetadata
    extraction_fps: float = Field(gt=0)


class Source(BaseModel):
    """One registered origin of raw data for a project.

    ``validate_assignment`` is on, and this is the only model in the domain that
    turns it on. The reason is the cross-field rule below: a
    ``model_validator(mode="after")`` runs at construction and **not** on
    attribute assignment, so without it ``source.kind = IMAGE_DIRECTORY`` would
    leave a populated :attr:`video` behind and the mapper would write a video
    provenance blob onto an image-directory row. Every other mutable model here
    validates field by field, where assignment is already covered.

    :attr:`registered_at` is timezone-aware UTC, the convention for every
    timestamp in the domain, and it records the **first** registration:
    re-registering a known origin refreshes what was probed, never this.

    :attr:`capture_params` is opaque operator-supplied provenance — lens, rig,
    site, whatever the person running the ingest wants on the record. Nothing in
    the kernel branches on it and nothing validates it, which is exactly why the
    values are ``str``: a typed value would imply someone was checking.

    :attr:`display_name` is what a caller asked this source to be *called*, and
    ``None`` means nobody said. It exists because not every path has a readable
    last segment: an HTTP upload of stills is staged under a
    content-addressed directory, so its basename is a 64-character digest, while
    a CLI directory or a clip carries a name a person chose. Like
    ``capture_params`` it is **not** part of the source's identity — renaming
    must not fork one origin into two — and unlike ``registered_at`` a provided
    value *does* refresh the stored one, because a label is curation, not
    provenance.
    """

    model_config = ConfigDict(validate_assignment=True)

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    kind: SourceKind
    path: str
    display_name: str | None = None
    registered_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    capture_params: dict[str, str] = Field(default_factory=dict)
    video: VideoProvenance | None = None

    @property
    def name(self) -> str:
        """What to call this source: the stated name, else the path's last segment.

        The one spelling of the resolution. Both wire projections
        (``server.models.SourceOut`` and ``visionset.wire.source``) publish this
        rather than re-deriving from ``path`` — two derivations is how the API
        and the CLI would eventually answer differently.
        """
        return self.display_name if self.display_name is not None else PurePath(self.path).name

    @field_validator("registered_at")
    @classmethod
    def _registered_at_is_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("registered_at must be timezone-aware (UTC)")
        return value.astimezone(UTC)

    @model_validator(mode="after")
    def _video_provenance_matches_the_kind(self) -> Source:
        if (self.video is not None) != (self.kind is SourceKind.VIDEO):
            carry = "carry" if self.kind is SourceKind.VIDEO else "not carry"
            raise ValueError(f"a {self.kind.value} source must {carry} video provenance")
        return self

    def require_video(self) -> VideoProvenance:
        """The clip's provenance, or refuse because this is not a clip.

        mypy cannot see the validator above, so ``if source.kind is VIDEO`` never
        narrows ``VideoProvenance | None`` and every caller would grow its own
        ``assert``. One spelling of the rule instead — the reason
        ``ProjectService.require_dataset`` exists in the same shape.

        Raises:
            WorkspaceCorrupt: this source carries no video provenance. For a
                clip that means the invariant failed on disk; for anything else
                it means the caller asked the wrong question of the wrong row.
        """
        if self.video is None:
            raise WorkspaceCorrupt(
                f"source {self.id} is a {self.kind.value} and has no video provenance"
            )
        return self.video
