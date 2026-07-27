"""Video: say what a clip is, and take frames out of it at a rate someone chose.

The video half of what the ``MediaProcessor`` placeholder was going to be. It is
declared apart from the image processor because the two have almost nothing in
common at the type level: an ffmpeg adapter has no thumbnail to serve and a
Pillow adapter has no frames to iterate. One shared protocol would have forced
each implementation to declare the other's methods and raise from them, which is
a runtime failure where a compile-time absence was available.

Both methods take a :class:`~pathlib.Path`, where ``ImageProcessor`` takes a
stream, and that divergence is deliberate rather than an oversight to be tidied
up later. A video decoder is an out-of-process program that seeks: handed a pipe
it cannot ask how long the clip is without decoding all of it, and cannot revisit
a byte it has already read. Nothing is lost by requiring a file, because there is
no caller that has video bytes and no file — a source is a path on disk and a
blob in the default blob store is a path too.
"""

from collections.abc import Iterator
from pathlib import Path
from typing import Final, Protocol, runtime_checkable

from visionset.kernel.domain import ImageFormat, VideoFrame, VideoMetadata

#: How many frames a second to take out of a clip, unless a caller says otherwise.
#:
#: One. A dataset wants pictures that differ from each other, and consecutive
#: frames of the same clip mostly do not — at a source rate of thirty, twenty-nine
#: of every thirty frames cost a decode, a hash and a row to say almost exactly
#: what their neighbour said. A caller that wants more asks for more.
DEFAULT_EXTRACTION_FPS: Final = 1.0

#: The encoding every extracted frame arrives in.
#:
#: PNG, because a frame is ground truth: an annotator draws boxes on these pixels
#: and an exporter ships them, so a lossy re-encode would put compression
#: artefacts under the labels for a saving nobody asked for. Fixed by the port
#: rather than chosen per call, for the reason ``THUMBNAIL_FORMAT`` is — the bytes
#: are content-addressed, and a per-call format would give one frame several
#: equally correct hashes.
#:
#: That this is an ``ImageFormat`` member is load-bearing and not decoration: it
#: is what lets an ingest hand an extracted frame straight to an ``ImageProcessor``
#: and stamp the result on an ``Asset``, with no branch for where the picture came
#: from.
FRAME_FORMAT: Final = ImageFormat.PNG


@runtime_checkable
class VideoProcessor(Protocol):
    """Reads video: what a clip is, and the frames a caller wants out of it.

    Two methods rather than one, for the reason ``ImageProcessor`` has two: the
    callers are different. Registering a source wants the rate and the duration
    and no pixels at all; an ingest run wants the pixels and already knows the
    rate. A combined call would make the first pay for a full decode.

    Four rules an implementation owes its callers:

    - **Dimensions are as displayed.** Whatever rotation the container carries
      has been applied by the time the numbers come back, and the frames
      :meth:`frames` yields have those same dimensions. See
      :class:`~visionset.kernel.domain.VideoMetadata`.
    - **Extraction is deterministic.** The same file and the same ``fps`` produce
      the same frames, byte for byte — which is what lets content addressing
      dedup a re-ingest instead of doubling a dataset. The promise holds *within
      one installed decoder*: a different ffmpeg build may encode the same
      picture to different bytes, so a caller asserts repeatability and never a
      literal hash.
    - **Frames arrive lazily, and the iterator owns a running program.** Nothing
      buffers a whole clip. A caller either exhausts the iterator or closes it
      (``contextlib.closing``, or letting a ``for`` loop go out of scope), and an
      implementation must not leave a decoder running when it is abandoned.
    - **Every frame is a complete image in** :data:`FRAME_FORMAT`, at the
      dimensions :meth:`probe` reported.

    ``name`` is what the caller calls this clip, and it exists only so a refusal
    can say which item failed; an implementation may fall back to the file's own
    name, but it never invents one. The convention for naming a frame further
    down the pipeline is ``clip.mp4#frame=42`` — see ``MediaError``.

    **Asking for more frames a second than the clip has duplicates them.** This
    is documented rather than clamped: clamping would mean probing inside
    :meth:`frames`, and an ingest content-addresses what it stores, so the
    duplicates collapse into one asset anyway. The honest fix is not to ask.

    Raises:
        MediaToolUnavailable: the decoder this implementation shells out to is
            not installed. Raised before any work starts, and deliberately not a
            ``MediaError`` — no file is at fault.
        UnsupportedMedia: the bytes are not a video the decoder can open.
        CorruptMedia: the decoder opened the clip and its bytes ran out.
        FileNotFoundError: there is nothing at ``source``.
        ValueError: ``fps`` is not positive. A programming error rather than a
            media one, so it is not translated into the ``MediaError`` family.
    """

    def probe(self, source: Path, *, name: str | None = None) -> VideoMetadata: ...

    def frames(
        self,
        source: Path,
        *,
        fps: float = DEFAULT_EXTRACTION_FPS,
        name: str | None = None,
    ) -> Iterator[VideoFrame]: ...
