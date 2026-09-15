# usage: from visionset.kernel.domain import ImageFormat, ImageMetadata, VideoMetadata
"""What a media file turns out to be, once something has decoded it.

These are what something that decoded media has to say about it. They live in
the domain because they are values the rest of the kernel passes around: the
ingest pipeline copies an ``ImageMetadata`` onto an ``Asset``, and a REST surface
serializes one. A port's vocabulary may be domain; a domain model may never be a
port's.

Both modalities live here, which is why the file is named for the concept and not
for one of them: :class:`ImageMetadata` for a still, :class:`VideoMetadata` for a
clip. Only the first is a port's result type — ``ImageProcessor`` is the one
decoder this process has. The second is a **declaration**: a client materializes
frames from a clip that never leaves its machine and states what it read off the
container, which ``VideoImportService`` stores as provenance.

**The dataset vocabulary is** :class:`ImageFormat` **, frozen at two members.**
Acceptance is wider than the dataset: ``ImageProcessor.stills`` reads anything
Pillow decodes, but everything outside these two is normalized *into* them at
ingest — a converted still becomes JPEG, a decomposed animation frame becomes
PNG — so the promise the enum makes (VisionSet will decode, hash, thumbnail and
export these for as long as today's workspaces are readable) is made about two
encodings only, and a dataset consumer never needs a third decoder. What can be
*read* may drift with the installed Pillow; what a dataset *holds* may not.

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
    """Every still-image encoding a dataset may contain. See the module docstring.

    A ``StrEnum`` rather than a ``Literal``, unlike ``Asset.modality``: that one
    has a single member, where an enum would be ceremony. This set is **frozen
    at JPEG and PNG**: acceptance is wider — anything Pillow decodes is read —
    but everything else is normalized into these two at ingest. It costs the
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


class DecodedStill(BaseModel):
    """One dataset-ready still that came out of reading a file.

    ``payload`` is ``None`` when the original stream's bytes are already the
    asset (a native JPEG or PNG passes through untouched), and the transcoded
    bytes otherwise. ``metadata.format`` is always what the asset will record —
    JPEG or PNG — never the source encoding.

    ``frame_index`` and ``frame_timestamp`` are set only when a multi-frame
    file decomposed; the timestamp is the elapsed animation time before this
    frame, in seconds, with a missing per-frame duration counted as zero.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    metadata: ImageMetadata
    payload: bytes | None = None
    frame_index: int | None = Field(default=None, ge=0)
    frame_timestamp: float | None = Field(default=None, ge=0)


class VideoMetadata(BaseModel):
    """What one clip turns out to be: how big, how fast, how long, and in what codec.

    **Dimensions are as displayed**, on exactly the terms :class:`ImageMetadata`
    states. A video carries its rotation in a display matrix rather than in an
    EXIF tag, and a phone shooting in portrait writes a landscape stream plus a
    quarter turn; a decoder applies that turn, so reporting the stored numbers
    would describe a picture nobody will ever see. There is no
    ``rotation_applied`` flag, for the reason there is no ``orientation_applied``
    one: a caller that could branch on it is a caller who was handed the
    un-normalized case after all.

    :attr:`fps` is the *source* rate, which is provenance and not a decision —
    what a decomposition ran at is a parameter the caller chose and the ingest
    records. It is a ``float`` rather than a rational because 30000/1001 is going
    to be reported as 29.97 by every surface that shows it, and carrying the
    fraction only to divide it at the edge buys nothing.

    It is **nullable**, and ``None`` is the honest answer rather than a gap. A
    variable-frame-rate clip — a screen recording, a phone that throttles its
    sensor — has no single rate it was shot at, and there is no number that
    describes it. Filling the field with the rate a decomposition *ran* at would
    be the one mistake this whole model is arranged to prevent: the cut is
    ``VideoProvenance.extraction_fps``, and writing it here would record a
    property of the clip that the clip does not have.

    :attr:`codec` is a plain ``str``. See the module docstring: this file has no
    ``VideoFormat`` enum on purpose.

    **There is no frame count.** For a variable-rate stream it would be a
    guess, for a constant-rate one it is ``fps * duration_seconds``, and neither
    is the number an import actually needs — that one is how many grid points the
    selection holds, which ``expected_frames`` computes from the cut.

    **No infinity and no NaN.** ``json.loads("1e400")`` is ``inf``, and ``inf``
    satisfies ``gt=0`` — so without this a declared duration could be infinite,
    and the first thing that multiplied it would raise ``OverflowError`` from
    inside whatever call happened to reach it rather than be refused at the
    door. NaN fails ``gt=0`` already; refusing both in one place is what makes
    that an intention rather than an accident of comparison.

    Frozen, like every other value in the domain that is a pure function of some
    bytes.
    """

    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    width: int = Field(ge=1)
    height: int = Field(ge=1)
    fps: float | None = Field(default=None, gt=0)
    duration_seconds: float = Field(gt=0)
    codec: str = Field(min_length=1)
