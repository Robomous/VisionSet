"""Still images: validate the bytes, report what they are, shrink them.

The image half of what the ``MediaProcessor`` placeholder was going to be. It is
declared apart from the video processor because the two have almost nothing in
common at the type level: an ffmpeg adapter has no thumbnail to serve and a
Pillow adapter has no frames to iterate. One shared protocol would have forced
each implementation to declare the other's methods and raise from them, which is
a runtime failure where a compile-time absence was available.
"""

from collections.abc import Iterator
from typing import BinaryIO, Final, Protocol, runtime_checkable

from visionset.kernel.domain import DecodedStill, ImageFormat, ImageMetadata

#: Longest edge of a generated thumbnail, in pixels, unless a caller says otherwise.
#:
#: Part of the port rather than of one adapter, for the reason ``UNINITIALIZED``
#: is: a caller choosing a size and an implementation honouring one have to agree
#: without either importing the other's module.
DEFAULT_THUMBNAIL_MAX_EDGE: Final = 256

#: The encoding every :meth:`ImageProcessor.thumbnail` returns.
#:
#: Fixed by the port rather than chosen per call, because thumbnails are meant to
#: be content-addressed: the bytes *are* the cache key, so a per-call format would
#: give one image several equally correct hashes. Changing this value invalidates
#: every thumbnail ever stored — which is safe, they are a cache — but it is a
#: decision, not an edit.
THUMBNAIL_FORMAT: Final = ImageFormat.JPEG

#: What a convertible single-frame image becomes. Frozen with ``ImageFormat``:
#: a dataset consumer decodes JPEG and PNG and nothing else.
CONVERTED_STILL_FORMAT: Final = ImageFormat.JPEG

#: What one frame of a decomposed animation becomes — the same answer the video
#: pipeline gives, so decomposed motion is PNG wherever it came from.
DECOMPOSED_FRAME_FORMAT: Final = ImageFormat.PNG


@runtime_checkable
class ImageProcessor(Protocol):
    """Reads still images: what they are, and a small copy of them.

    Two methods rather than one call returning a pair, because the callers are
    different. An ingest pass wants dimensions and a format for every file; a
    thumbnail backfill wants a preview for an asset whose metadata it already
    has. One combined call would make the first pay for an encode it discards,
    and would leave the second no way to ask for the half it needs.

    Three rules an implementation owes its callers:

    - **Both methods read from the beginning.** An implementation seeks to 0
      before decoding, so a caller may hash, probe and thumbnail one open handle
      in any order without tracking positions. Without this rule, hashing a file
      and then probing the same handle reports a perfectly good JPEG as
      ``CorruptMedia`` — a bug that looks exactly like the feature working.
    - **Neither method closes the stream.** Whoever opened it owns it.
    - **Dimensions are as displayed.** Whatever orientation the file carries has
      been applied by the time the numbers come back. See :class:`ImageMetadata`.

    ``name`` is what the caller calls this stream, and it exists only so a
    refusal can say which item failed. An implementation may fall back to the
    stream's own filename when the caller passes nothing, but it never invents
    one. See ``MediaError``.

    ``stills`` is the wide door, and it obeys the three rules above. Where
    ``probe`` answers "is this already dataset-ready", ``stills`` reads anything
    the decoder can and normalizes it: a native JPEG or PNG yields exactly one
    pass-through item whose bytes are the caller's own; any other decodable
    image yields transcoded items — one ``CONVERTED_STILL_FORMAT`` still for a
    single frame, one ``DECOMPOSED_FRAME_FORMAT`` still per frame of an
    animation. The decode is complete before the first item is yielded, so a
    damaged file raises before a caller has stored anything.

    Raises:
        UnsupportedMedia: the bytes are not an image the decoder reads (for
            ``probe``, not one of the formats in ``ImageFormat``), or declare
            more pixels than the decoder will take.
        CorruptMedia: the bytes are an image we read, and they will not decode.
    """

    def probe(self, content: BinaryIO, *, name: str | None = None) -> ImageMetadata: ...

    def thumbnail(
        self,
        content: BinaryIO,
        *,
        max_edge: int = DEFAULT_THUMBNAIL_MAX_EDGE,
        name: str | None = None,
    ) -> bytes: ...

    def stills(self, content: BinaryIO, *, name: str | None = None) -> Iterator[DecodedStill]: ...
