"""Default ImageProcessor adapter: Pillow decoding, orientation and thumbnails."""

from __future__ import annotations

import io
from typing import BinaryIO, Final

from PIL import Image, ImageOps, UnidentifiedImageError

from visionset.kernel.domain import ImageFormat, ImageMetadata
from visionset.kernel.errors import CorruptMedia, UnsupportedMedia
from visionset.kernel.ports.image_processor import DEFAULT_THUMBNAIL_MAX_EDGE

#: Pillow's spelling of every format we accept. Pillow's vocabulary stops here,
#: the way SQLAlchemy's stops at ``_tables.py``: a second image adapter would
#: bring its own table rather than teach the domain a third set of names.
#:
#: Extending the accepted list is this dict plus a member on ``ImageFormat``, and
#: ``test_image_processor.py`` asserts the two cover the same set, so a half-done
#: extension fails on the first run instead of at the first file.
#:
#: ``MPO`` is not a fourth format: it is a multi-picture JPEG container — what
#: phones write in portrait and burst modes — and VisionSet reads its primary
#: frame, which is the one every viewer shows. An alias in the decoder's table.
_FORMAT_BY_PILLOW_NAME: Final[dict[str, ImageFormat]] = {
    "JPEG": ImageFormat.JPEG,
    "MPO": ImageFormat.JPEG,
    "PNG": ImageFormat.PNG,
}

#: Pillow's name for :data:`~visionset.kernel.ports.THUMBNAIL_FORMAT`. Spelled out
#: rather than derived from the enum member, because the two vocabularies agreeing
#: today is a coincidence and not a rule; a test pins them together.
_THUMBNAIL_PILLOW_NAME: Final = "JPEG"

#: Every knob the JPEG encoder has that could move between builds, pinned.
#:
#: A thumbnail is meant to be content-addressed, so its bytes are a cache key and
#: a drifting encoder moves every key at once. ``subsampling=0`` (4:4:4) removes
#: the chroma decision, whose default has moved between libjpeg builds;
#: ``optimize`` searches for Huffman tables, which is the most build-dependent
#: step in the encoder and saves a few hundred bytes at this size; a progressive
#: scan structure would be a second set of bytes for one picture.
#:
#: ``format`` is deliberately *not* a key here — ``Image.save`` declares it as a
#: named parameter, so mypy binds it out of a ``**dict[str, object]`` and rejects
#: the call. Pass it explicitly; see :meth:`PillowImageProcessor.thumbnail`.
_THUMBNAIL_ENCODER: Final[dict[str, object]] = {
    "quality": 85,
    "subsampling": 0,
    "optimize": False,
    "progressive": False,
}

#: Pinned by name rather than by its integer value, which says nothing.
_RESAMPLING: Final = Image.Resampling.LANCZOS

#: What a transparent pixel becomes. JPEG has no alpha channel, and a thumbnail
#: grid is a light surface, so a logo on transparent should read as a logo rather
#: than as a black tile.
_BACKGROUND: Final = (255, 255, 255)

#: Modes whose pixels can be transparent. ``P`` only qualifies when the palette
#: actually declares a transparent index, which lives in ``image.info``.
_ALPHA_MODES: Final = frozenset({"RGBA", "LA", "PA"})


def _stream_name(content: BinaryIO, name: str | None) -> str | None:
    """What to call this stream in an error: the caller's word, then the file's own.

    The explicit ``name`` wins because the component that knows the provenance is
    the one that should decide: an ingest run naming a source path, or a video
    decomposition naming a frame. The stream's own attribute is the convenience
    fallback, so ``probe(path.open("rb"))`` still names the file.

    The ``isinstance`` guard is load-bearing twice over. ``getattr`` returns
    ``Any``, which mypy-strict refuses to hand back from a typed function; and the
    attribute really is a non-string sometimes — an ``int`` for an fd-backed
    handle, absent on the ``BytesIO`` a decoded frame arrives in, and a *blob
    path* for a handle from the blob store, which is a true filename and a useless
    one. ``None`` stays an honest answer rather than a fabricated one.
    """
    if name is not None:
        return name
    candidate = getattr(content, "name", None)
    return candidate if isinstance(candidate, str) else None


def _read_all(content: BinaryIO) -> bytes:
    """Every byte, from the start when the stream can go there.

    The rewind is explicit rather than left to Pillow, which does its own: an
    adapter whose behaviour depends on whether the caller happened to pass a file
    handle or a ``BytesIO`` is one nobody can reason about. It is also what makes
    the ordinary ingest shape work — the same open handle goes to
    ``BlobStore.put``, which reads it to EOF, and then here — with no position
    bookkeeping at the call site.

    Read whole rather than decoded lazily off the caller's stream: that is what
    makes a non-seekable stream behave identically to a seekable one, and the
    compressed bytes are a fraction of the pixel buffer the decode allocates
    anyway. The stream is not closed; whoever opened it owns it.
    """
    if content.seekable():
        content.seek(0)
    return content.read()


def _has_alpha(image: Image.Image) -> bool:
    return image.mode in _ALPHA_MODES or "transparency" in image.info


def _fit(image: Image.Image, max_edge: int) -> Image.Image:
    """RGB pixels on a fresh opaque canvas, at most ``max_edge`` on the longest side.

    Converted *before* the resize on purpose: Pillow silently falls back to
    nearest-neighbour when asked to resample a palette image, so a palette PNG
    would quietly get the worse of two thumbnails.

    Composited rather than flattened, also on purpose. ``convert("RGB")`` on an
    image with alpha keeps whatever colour sits *under* a fully transparent
    pixel, so a transparent red pixel comes out red — arbitrary, and usually
    wrong. Pasting through the alpha mask onto a known background is the only
    version of this with a defined answer.

    The result is always a freshly allocated canvas rather than a converted
    source, which is what guarantees the encoder sees no ``info``: an ICC profile
    or a JFIF density riding along from the original would be a second input to
    bytes that are supposed to depend on nothing but the pixels.

    ``reducing_gap=None`` is load-bearing. The default lets Pillow pre-reduce
    before resampling, which is a second pixel pipeline and therefore a second
    set of output bytes for one picture. ``thumbnail`` never enlarges, so an
    image already inside the box comes back untouched.
    """
    working = image.convert("RGBA") if _has_alpha(image) else image.convert("RGB")
    working.thumbnail((max_edge, max_edge), _RESAMPLING, reducing_gap=None)

    canvas = Image.new("RGB", working.size, _BACKGROUND)
    canvas.paste(working, mask=working.getchannel("A") if working.mode == "RGBA" else None)
    return canvas


class PillowImageProcessor:
    """Decodes JPEG and PNG, reports oriented dimensions, encodes fixed thumbnails.

    Holds no state at all — no cache, no handle, no configuration — which is why
    ``WorkspaceService`` builds one per workspace from a zero-argument factory and
    never closes it. Two instances are interchangeable, and a test says so.

    **Validation is the decode.** Nothing here trusts a header: a file is accepted
    only once its pixels have actually come out, because a dataset that admits an
    asset on a convincing header is a dataset that discovers the truth during a
    training run. ``Image.verify()`` is deliberately never called — it walks
    checksums without producing pixels, and it leaves the image in a state where a
    later ``load()`` raises ``AssertionError``, which is neither a media error nor
    catchable as one.

    **Orientation is applied, not reported.** Whatever EXIF turn a file carries is
    baked in before dimensions are read and before a thumbnail is encoded, so the
    numbers, the preview and an annotator's pixel coordinates all describe the
    same picture. This is format-independent: PNG carries EXIF in an ``eXIf``
    chunk and is oriented on exactly the same terms as JPEG.

    **Pillow's process-wide globals are left alone.** ``Image.MAX_IMAGE_PIXELS``
    stays at Pillow's default, so a header claiming forty thousand pixels a side
    is refused for free, before a decoder runs; raising that limit is the
    embedding program's call, not a library's. ``ImageFile.LOAD_TRUNCATED_IMAGES``
    stays ``False`` — setting it turns "this file is corrupt" into "here is half
    an image and no error", which is the silent failure this adapter exists to
    prevent. The warning Pillow emits in the band below the hard limit is left as
    a warning: a hundred-megapixel orthomosaic is a plausible input rather than an
    attack, and escalating it would mean mutating a global warning filter.
    """

    def probe(self, content: BinaryIO, *, name: str | None = None) -> ImageMetadata:
        """What this image is, at the dimensions a viewer would show.

        Raises:
            UnsupportedMedia: not an image, not an accepted format, or too large.
            CorruptMedia: an accepted format whose pixels will not decode.
        """
        image, image_format = self._decode(content, _stream_name(content, name))
        with image:
            width, height = image.size
        return ImageMetadata(width=width, height=height, format=image_format)

    def thumbnail(
        self,
        content: BinaryIO,
        *,
        max_edge: int = DEFAULT_THUMBNAIL_MAX_EDGE,
        name: str | None = None,
    ) -> bytes:
        """A small opaque JPEG of this image, at most ``max_edge`` on its longest side.

        Never enlarges: an image already inside the box comes back at its own
        size, because inventing pixels to fill a thumbnail is a lie the gallery
        would then have to display.

        Raises:
            ValueError: ``max_edge`` is below 1. A programming error rather than a
                media one, so it is not translated into the ``MediaError`` family.
            UnsupportedMedia: not an image, not an accepted format, or too large.
            CorruptMedia: an accepted format whose pixels will not decode.
        """
        if max_edge < 1:
            raise ValueError(f"max_edge must be at least 1 pixel, got {max_edge}")

        image, _ = self._decode(content, _stream_name(content, name))
        with image:
            canvas = _fit(image, max_edge)

        buffer = io.BytesIO()
        canvas.save(buffer, format=_THUMBNAIL_PILLOW_NAME, **_THUMBNAIL_ENCODER)
        return buffer.getvalue()

    def _decode(self, content: BinaryIO, source: str | None) -> tuple[Image.Image, ImageFormat]:
        """Open, identify, refuse, decode, orient — in that order.

        The order is the whole method. Identification comes before the decode, so
        no decoder for a format we do not accept is ever pointed at untrusted
        bytes; the decode comes before the dimensions, so a truncated file is
        refused rather than measured.
        """
        buffer = io.BytesIO(_read_all(content))

        try:
            image = Image.open(buffer)
        except UnidentifiedImageError as exc:
            # Before the OSError clause, which this subclasses: the other way
            # round, every file that is not an image reads as a corrupt one.
            raise UnsupportedMedia("not a recognizable image", name=source) from exc
        except Image.DecompressionBombError as exc:
            # Derives from Exception, not OSError, so it needs its own clause.
            raise UnsupportedMedia(str(exc), name=source) from exc
        except OSError as exc:
            # A JPEG truncated before its start-of-scan marker fails here rather
            # than at load(): where the cut lands decides which call notices.
            raise CorruptMedia(
                f"the image header is damaged or truncated ({exc})", name=source
            ) from exc

        # Read off the ImageFile before anything transforms it: convert() and the
        # copying form of exif_transpose() both hand back a format of None.
        image_format = _FORMAT_BY_PILLOW_NAME.get(image.format or "")
        if image_format is None:
            found = image.format or "an unrecognized encoding"
            accepted = ", ".join(sorted(member.value for member in ImageFormat))
            image.close()
            raise UnsupportedMedia(
                f"{found} is not accepted; VisionSet reads {accepted}", name=source
            )

        try:
            image.load()
            ImageOps.exif_transpose(image, in_place=True)
        except Image.DecompressionBombError as exc:
            image.close()
            raise UnsupportedMedia(str(exc), name=source) from exc
        except (OSError, SyntaxError, ValueError) as exc:
            image.close()
            raise CorruptMedia(
                f"the image data is damaged or truncated ({exc})", name=source
            ) from exc

        return image, image_format
