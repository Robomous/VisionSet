# usage: from visionset.kernel.domain import ImageFormat, ImageMetadata
"""What a media file turns out to be, once something has decoded it.

These are the *result* types of the media ports. They live in the domain rather
than beside the protocols because they are values the rest of the kernel passes
around: the ingest pipeline copies an ``ImageMetadata`` onto an ``Asset``, and a
REST surface serializes one. A port's vocabulary may be domain; a domain model
may never be a port's.

``VideoMetadata`` joins this module when the video processor lands, which is why
the file is named for the concept and not for one modality.

**The accepted list is** :class:`ImageFormat` **, and nothing else.** Extending it
is two adjacent edits — a member here, and the decoder's own spelling of it in
``PillowImageProcessor._FORMAT_BY_PILLOW_NAME`` — tied together by a test that
asserts the two cover the same set, so a half-done extension fails on the first
run rather than at the first file. That cost is the point. Accepting a format is
a promise that VisionSet will decode it, hash it, thumbnail it and export it for
as long as the workspaces written today are readable; a ``try: decode`` that
admits whatever the installed Pillow happens to support would make that promise
depend on a wheel.

WEBP is the obvious next member. It is not here yet because a format with no
generated fixture is a format nobody is testing.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class ImageFormat(StrEnum):
    """Every still-image encoding VisionSet accepts. See the module docstring.

    A ``StrEnum`` rather than a ``Literal``, unlike ``Asset.modality``: that one
    has a single member, where an enum would be ceremony, and this one is a
    closed set whose whole purpose is to grow deliberately. It costs the
    persistence layer nothing — a ``StrEnum`` member *is* a ``str``, and the
    tables already store every other enum as ``String``.
    """

    JPEG = "jpeg"
    PNG = "png"


class ImageMetadata(BaseModel):
    """What one still image turns out to be: how big it is, and how it is encoded.

    **Dimensions are as displayed.** If the file carries an EXIF orientation that
    turns it, the turn is applied before these numbers are reported — a 32x24
    JPEG tagged orientation 6 probes as 24x32. The alternative, reporting the
    stored dimensions and passing the tag along, pushes the rotation onto every
    consumer, and the consumers are an annotation canvas, an exporter and a
    bounding box in pixel coordinates. One of them forgetting is a dataset whose
    labels are ninety degrees off, discovered by a model that will not converge.

    There is deliberately no ``orientation_applied`` flag. A caller that could
    branch on it would be a caller who was handed the un-normalized case after
    all, and nothing persists it.

    **The bytes decide the format, not the filename.** A ``.png`` holding JPEG
    bytes reports :attr:`ImageFormat.JPEG`. A suffix is a hint for choosing which
    files to look at; what a file *is*, is decided by decoding it.

    Frozen, like every other value in the domain that is a pure function of some
    bytes: re-deriving it is cheaper than reasoning about who edited it.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    width: int = Field(ge=1)
    height: int = Field(ge=1)
    format: ImageFormat
