# usage: from visionset.kernel.domain import ImageFormat, ImageMetadata, VideoFrame, VideoMetadata
"""What a media file turns out to be, once something has decoded it.

These are the *result* types of the media ports. They live in the domain rather
than beside the protocols because they are values the rest of the kernel passes
around: the ingest pipeline copies an ``ImageMetadata`` onto an ``Asset``, and a
REST surface serializes one. A port's vocabulary may be domain; a domain model
may never be a port's.

Both modalities live here, which is why the file is named for the concept and not
for one of them: :class:`ImageMetadata` for a still, :class:`VideoMetadata` and
:class:`VideoFrame` for a clip and the frames taken out of it.

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

**There is deliberately no ``VideoFormat`` beside it.** The asymmetry is the
point: an image is an asset, a video is a source. Curating :class:`ImageFormat`
buys something, because those exact bytes enter the dataset and the promise above
is made about them. A video's bytes never do — they leave the decoder as frames,
which are :attr:`ImageFormat.PNG` like any other still — so a closed list of
codecs would gate nothing while going stale every time a camera vendor ships a
profile. :attr:`VideoMetadata.codec` therefore *records* what was read instead of
*deciding* what may be read, the way ``DatasetChange.operation`` is a ``str``
while ``DatasetOperation`` is the enum a writer picks from.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Final

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


MEDIA_TYPES: Final[Mapping[ImageFormat, str]] = {
    ImageFormat.JPEG: "image/jpeg",
    ImageFormat.PNG: "image/png",
}
"""The IANA name for each accepted encoding.

Total over :class:`ImageFormat` and asserted so by a test, for the reason the
enum's own docstring gives about half-done extensions: a member added here
without a media type would otherwise degrade every download of it to
``octet-stream`` quietly, which is the failure that looks like nothing.

Here rather than beside the route that serves bytes because it is a fact about
the format, and it now has two readers — the asset download and the inference
adapters, which must tell a provider what it is being handed. A second copy of a
two-line map is how a product ends up serving ``image/png`` on one surface and
``application/octet-stream`` on another for the same asset.
"""

OCTET_STREAM: Final = "application/octet-stream"
"""For an asset written before the ingest pipeline probed formats.

Nothing can invent what nobody measured, and admitting that beats guessing.
"""


def media_type_of(image_format: ImageFormat | None) -> str:
    """The IANA media type for that format, or ``octet-stream`` for an unprobed one."""
    return OCTET_STREAM if image_format is None else MEDIA_TYPES[image_format]


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


class VideoMetadata(BaseModel):
    """What one clip turns out to be: how big, how fast, how long, and in what codec.

    **Dimensions are as displayed**, on exactly the terms :class:`ImageMetadata`
    states. A video carries its rotation in a display matrix rather than in an
    EXIF tag, and a phone shooting in portrait writes a landscape stream plus a
    quarter turn; ffmpeg applies that turn when it decodes, so reporting the
    stored numbers would describe a picture nobody will ever see. There is no
    ``rotation_applied`` flag, for the reason there is no ``orientation_applied``
    one: a caller that could branch on it is a caller who was handed the
    un-normalized case after all.

    :attr:`fps` is the *source* rate, which is provenance and not a decision —
    what a decomposition ran at is a parameter the caller chose and the ingest
    records. It is a ``float`` rather than a rational because 30000/1001 is going
    to be reported as 29.97 by every surface that shows it, and carrying the
    fraction only to divide it at the edge buys nothing.

    :attr:`codec` is a plain ``str``. See the module docstring: this file has no
    ``VideoFormat`` enum on purpose.

    **There is no frame count.** For a variable-rate stream it would be a
    guess, for a constant-rate one it is ``fps * duration_seconds``, and neither
    is the number an ingest actually needs — that one is how many frames the
    extraction produced, which only the caller doing the extraction can count.

    Frozen, like every other value in the domain that is a pure function of some
    bytes.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    width: int = Field(ge=1)
    height: int = Field(ge=1)
    fps: float = Field(gt=0)
    duration_seconds: float = Field(gt=0)
    codec: str = Field(min_length=1)


class VideoFrame(BaseModel):
    """One still lifted out of a clip, with enough provenance to say where from.

    Transient, unlike its neighbours here: nothing stores a ``VideoFrame``. The
    :attr:`content` goes to the blob store and the two numbers go onto an
    ``Asset``, so this type exists to keep them together for the length of one
    loop iteration. It lives in the domain anyway because the kernel passes it
    between a port and a service, which is the whole test for belonging here.

    :attr:`index` counts **the extracted sequence**, not the source. A source
    frame number means nothing for a variable-rate stream and cannot be
    reproduced without knowing the rate the file was shot at; the extracted index
    is what orders the assets and what names them. :attr:`timestamp` is the
    locator that survives — it says where in the clip to look, whatever rate the
    next decomposition runs at.

    :attr:`content` is a complete, self-contained image in the port's
    ``FRAME_FORMAT``. Hashing it is what gives the resulting asset its identity,
    which is why the encoder producing it is pinned rather than left to a default.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    index: int = Field(ge=0)
    timestamp: float = Field(ge=0)
    content: bytes = Field(min_length=1)
