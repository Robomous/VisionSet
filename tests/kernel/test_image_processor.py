"""The image processor: what it accepts, what it refuses, and what it promises.

Three properties are pinned here and they are worth keeping apart.

The first is **refusal**. Every bad file this adapter can be handed comes back as a
`VisionSetError` that names the item, because an ingest run will do this over thousands of
files and a per-file failure has to be recorded against the one file it belongs to. "Bad" has
three shapes with three different decoder paths — a text file fails at `Image.open`, a
truncated image fails at `load()`, and a GIF fails neither but is declined anyway — so the
refusal tests walk all three rather than trusting one to stand for the others.

The second is **orientation**. The dimensions reported are as-displayed: what a viewer shows
and what an annotator's pixel coordinates will be in, never what the pixel array happens to be
stored as. All eight EXIF values are swept, because the four that swap the edges and the four
that do not are exactly what a hand-rolled tag reader gets wrong.

The third is **determinism**, and it is the one with a caveat. Two runs on one machine produce
byte-identical thumbnails; two machines with different Pillow or libjpeg builds need not. So
every assertion here is about *repeatability* and none is about a literal hash — the same rule
`tests/fixtures/media.py` states for ffmpeg, for the same reason. What a thumbnail cache gets
out of this is a key, not an identity.

Two practical notes for anyone adding a case. `Image.thumbnail` never enlarges, and the fixture
default is 32x24, so every scaling test has to ask for a bigger source explicitly. And the
composition tests at the bottom live here rather than in `test_workspace_service.py`, following
the event bus: the port's own file is where "can this be injected?" is asked.
"""

from __future__ import annotations

import hashlib
import io
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from PIL import Image
from pydantic import ValidationError
from tests.fixtures.media import (
    DEFAULT_IMAGE_SIZE,
    write_corrupt_image,
    write_exif_rotated_image,
    write_image,
    write_image_in_unsupported_format,
    write_multi_picture_jpeg,
    write_unsupported_file,
)

from visionset.kernel.adapters import PillowImageProcessor
from visionset.kernel.adapters.pillow_image_processor import (
    _FORMAT_BY_PILLOW_NAME,
    _THUMBNAIL_ENCODER,
    _THUMBNAIL_PILLOW_NAME,
)
from visionset.kernel.domain import DecodedStill, ImageFormat, ImageMetadata
from visionset.kernel.errors import CorruptMedia, MediaError, UnsupportedMedia, VisionSetError
from visionset.kernel.ports import DEFAULT_THUMBNAIL_MAX_EDGE, THUMBNAIL_FORMAT, ImageProcessor
from visionset.kernel.services import WorkspaceService

#: A source large enough that a 256px thumbnail is a genuine reduction.
_LARGE = (600, 400)


def _probe(path: Path, **kwargs: str) -> ImageMetadata:
    with path.open("rb") as handle:
        return PillowImageProcessor().probe(handle, **kwargs)


def _thumbnail(path: Path, **kwargs: int) -> bytes:
    with path.open("rb") as handle:
        return PillowImageProcessor().thumbnail(handle, **kwargs)


def _decoded(thumbnail: bytes) -> Image.Image:
    return Image.open(io.BytesIO(thumbnail))


class _OneShotStream(io.RawIOBase):
    """A readable, non-seekable stream — a pipe, in the shape a caller would hand over."""

    def __init__(self, payload: bytes) -> None:
        self._buffer = io.BytesIO(payload)

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def read(self, size: int | None = -1) -> bytes:
        return self._buffer.read(-1 if size is None else size)

    def readall(self) -> bytes:
        return self._buffer.read()


# --- what an image reports ----------------------------------------------------


@pytest.mark.parametrize(
    ("suffix", "expected"),
    [(".png", ImageFormat.PNG), (".jpg", ImageFormat.JPEG), (".jpeg", ImageFormat.JPEG)],
    ids=["png", "jpg", "jpeg"],
)
def test_an_accepted_image_reports_its_dimensions_and_format(
    tmp_path: Path, suffix: str, expected: ImageFormat
) -> None:
    metadata = _probe(write_image(tmp_path / f"frame{suffix}", size=(48, 12)))

    assert (metadata.width, metadata.height, metadata.format) == (48, 12, expected)


def test_the_bytes_decide_the_format_not_the_file_extension(tmp_path: Path) -> None:
    """A suffix is a hint for choosing files; what a file *is* comes from decoding it."""
    jpeg = write_image(tmp_path / "real.jpg")
    liar = tmp_path / "liar.png"
    liar.write_bytes(jpeg.read_bytes())

    assert _probe(liar).format is ImageFormat.JPEG


def test_a_multi_picture_jpeg_reports_itself_as_a_jpeg(tmp_path: Path) -> None:
    """What phones write in burst and portrait modes. Refusing it would refuse real cameras."""
    metadata = _probe(write_multi_picture_jpeg(tmp_path / "burst.jpg"))

    assert (metadata.width, metadata.height) == DEFAULT_IMAGE_SIZE
    assert metadata.format is ImageFormat.JPEG


def test_probing_the_same_stream_twice_gives_the_same_answer(tmp_path: Path) -> None:
    """The seek-to-0 rule: an ingest hashes, probes and thumbnails one open handle."""
    path = write_image(tmp_path / "frame.png", size=(48, 12))
    processor = PillowImageProcessor()

    with path.open("rb") as handle:
        handle.read()
        first = processor.probe(handle)
        second = processor.probe(handle)

    assert first == second == ImageMetadata(width=48, height=12, format=ImageFormat.PNG)


def test_one_open_handle_serves_a_probe_and_a_thumbnail(tmp_path: Path) -> None:
    path = write_image(tmp_path / "frame.png", size=_LARGE)
    processor = PillowImageProcessor()

    with path.open("rb") as handle:
        metadata = processor.probe(handle)
        thumbnail = processor.thumbnail(handle)

    assert (metadata.width, metadata.height) == _LARGE
    assert _decoded(thumbnail).size == (256, 171)


def test_the_stream_it_was_given_is_left_open(tmp_path: Path) -> None:
    path = write_image(tmp_path / "frame.png")

    with path.open("rb") as handle:
        PillowImageProcessor().probe(handle)
        assert handle.closed is False


def test_a_stream_that_cannot_seek_is_still_decoded(tmp_path: Path) -> None:
    payload = write_image(tmp_path / "frame.png", size=(48, 12)).read_bytes()

    metadata = PillowImageProcessor().probe(_OneShotStream(payload), name="pipe")

    assert (metadata.width, metadata.height) == (48, 12)


def test_a_stream_that_cannot_seek_serves_exactly_one_call(tmp_path: Path) -> None:
    """Written down rather than pretended away: rewinding a pipe is not a thing."""
    payload = write_image(tmp_path / "frame.png").read_bytes()
    stream = _OneShotStream(payload)
    processor = PillowImageProcessor()

    processor.probe(stream, name="pipe")

    with pytest.raises(MediaError):
        processor.probe(stream, name="pipe")


# --- refusals -----------------------------------------------------------------


def test_a_file_that_is_not_an_image_is_refused(tmp_path: Path) -> None:
    path = write_unsupported_file(tmp_path / "notes.txt")

    with pytest.raises(UnsupportedMedia, match="not a recognizable image"):
        _probe(path)


@pytest.mark.parametrize("image_format", ["BMP", "GIF", "TIFF"], ids=str.lower)
def test_an_image_in_a_format_we_do_not_accept_is_refused(
    tmp_path: Path, image_format: str
) -> None:
    """Decodable and still declined — the branch that is easiest to forget exists."""
    path = write_image_in_unsupported_format(tmp_path / "photo.bin", image_format=image_format)

    with pytest.raises(UnsupportedMedia, match=f"{image_format} is not accepted"):
        _probe(path)


def test_a_refusal_says_which_formats_are_accepted(tmp_path: Path) -> None:
    """So widening ``ImageFormat`` widens the message, with no second list to edit."""
    path = write_image_in_unsupported_format(tmp_path / "photo.bin")

    with pytest.raises(UnsupportedMedia) as caught:
        _probe(path)

    assert all(member.value in str(caught.value) for member in ImageFormat)


@pytest.mark.parametrize("suffix", [".png", ".jpg"], ids=["png", "jpg"])
def test_a_corrupt_image_is_refused(tmp_path: Path, suffix: str) -> None:
    """One behaviour, two decoder paths: where the cut lands decides which call notices."""
    path = write_corrupt_image(tmp_path / f"broken{suffix}", size=_LARGE)

    with pytest.raises(CorruptMedia, match="damaged or truncated"):
        _probe(path)


def test_a_refusal_names_the_file_it_was_given(tmp_path: Path) -> None:
    """The acceptance criterion: a per-file error has to say which of five thousand files."""
    path = write_corrupt_image(tmp_path / "broken.png")

    with pytest.raises(CorruptMedia, match="broken.png") as caught:
        _probe(path)

    assert caught.value.name == str(path)


def test_an_explicit_name_wins_over_the_streams_own(tmp_path: Path) -> None:
    """The component that knows the provenance decides — a frame reference, not a blob path."""
    path = write_corrupt_image(tmp_path / "blob-ab12cd.png")

    with pytest.raises(CorruptMedia) as caught:
        _probe(path, name="clip.mp4#frame=42")

    assert caught.value.name == "clip.mp4#frame=42"


def test_an_unnamed_stream_is_not_given_a_name_it_does_not_have(tmp_path: Path) -> None:
    with pytest.raises(UnsupportedMedia, match="<unnamed stream>") as caught:
        PillowImageProcessor().probe(io.BytesIO(b"not an image"))

    assert caught.value.name is None


def test_a_refusal_reason_does_not_repeat_the_name(tmp_path: Path) -> None:
    """An error report is a table: the name is a column, not a prefix on every sentence."""
    path = write_corrupt_image(tmp_path / "broken.png")

    with pytest.raises(CorruptMedia) as caught:
        _probe(path)

    assert "broken.png" not in caught.value.reason
    assert "broken.png" in str(caught.value)


def test_both_refusals_are_one_family(tmp_path: Path) -> None:
    """So an ingest catches once, records against the file, and carries on."""
    assert issubclass(UnsupportedMedia, MediaError)
    assert issubclass(CorruptMedia, MediaError)
    assert not issubclass(CorruptMedia, UnsupportedMedia)


@pytest.mark.parametrize(
    ("filename", "generator"),
    [
        ("broken.png", write_corrupt_image),
        ("notes.txt", write_unsupported_file),
        ("photo.bin", write_image_in_unsupported_format),
    ],
    ids=["corrupt", "not-an-image", "wrong-format"],
)
def test_no_decoder_exception_ever_escapes(
    tmp_path: Path, filename: str, generator: Callable[[Path], Path]
) -> None:
    """The sibling of ``test_no_sqlalchemy_exception_escapes_open``: Pillow stops at the adapter."""
    path = generator(tmp_path / filename)

    with pytest.raises(VisionSetError) as caught:
        _probe(path)

    assert not type(caught.value).__module__.startswith("PIL")


def test_a_corrupt_image_is_refused_by_the_thumbnail_too(tmp_path: Path) -> None:
    """The two methods cannot disagree about what is readable."""
    path = write_corrupt_image(tmp_path / "broken.png", size=_LARGE)

    with pytest.raises(CorruptMedia):
        _thumbnail(path)


# --- orientation --------------------------------------------------------------


def test_an_exif_rotated_image_reports_oriented_dimensions(tmp_path: Path) -> None:
    """The acceptance criterion: a 32x24 file tagged for a quarter turn is a 24x32 picture."""
    metadata = _probe(write_exif_rotated_image(tmp_path / "rotated.jpg"))

    assert (metadata.width, metadata.height) == (24, 32)


@pytest.mark.parametrize("orientation", [5, 6, 7, 8], ids=lambda value: f"orientation-{value}")
def test_a_quarter_turn_swaps_the_reported_edges(tmp_path: Path, orientation: int) -> None:
    path = write_image(tmp_path / "turned.jpg", orientation=orientation)

    metadata = _probe(path)

    assert (metadata.width, metadata.height) == (24, 32)


@pytest.mark.parametrize("orientation", [1, 2, 3, 4], ids=lambda value: f"orientation-{value}")
def test_an_upright_orientation_leaves_the_edges_alone(tmp_path: Path, orientation: int) -> None:
    """Identity, mirror and 180 degrees: the picture moves, the shape does not."""
    path = write_image(tmp_path / "upright.jpg", orientation=orientation)

    metadata = _probe(path)

    assert (metadata.width, metadata.height) == DEFAULT_IMAGE_SIZE


def test_an_image_with_no_exif_at_all_reports_its_stored_dimensions(tmp_path: Path) -> None:
    """The ordinary path, not a fallback: most images carry no orientation tag."""
    metadata = _probe(write_image(tmp_path / "plain.png", size=(48, 12)))

    assert (metadata.width, metadata.height) == (48, 12)


def test_a_png_orientation_tag_is_honoured_too(tmp_path: Path) -> None:
    """PNG carries EXIF in an eXIf chunk; the policy is about pictures, not about JPEG."""
    metadata = _probe(write_image(tmp_path / "rotated.png", orientation=6))

    assert (metadata.width, metadata.height) == (24, 32)


def test_the_reported_format_survives_the_orientation_fix(tmp_path: Path) -> None:
    """Read the format off the opened file: a transformed image reports no format at all."""
    metadata = _probe(write_exif_rotated_image(tmp_path / "rotated.jpg"))

    assert metadata.format is ImageFormat.JPEG


def test_a_thumbnail_is_taken_from_the_oriented_image(tmp_path: Path) -> None:
    """A sideways preview beside upright dimensions is a bug report waiting to be filed."""
    path = write_exif_rotated_image(tmp_path / "rotated.jpg")

    assert _decoded(_thumbnail(path)).size == (24, 32)


# --- thumbnails ---------------------------------------------------------------


@pytest.mark.parametrize("suffix", [".png", ".jpg"], ids=["png", "jpg"])
def test_a_thumbnail_is_an_opaque_jpeg_whatever_the_source_was(tmp_path: Path, suffix: str) -> None:
    thumbnail = _decoded(_thumbnail(write_image(tmp_path / f"frame{suffix}", size=_LARGE)))

    assert (thumbnail.format, thumbnail.mode) == ("JPEG", "RGB")


def test_a_thumbnail_of_the_same_bytes_is_byte_identical(tmp_path: Path) -> None:
    """The acceptance criterion. Repeatability, never a hardcoded hash — see the docstring."""
    path = write_image(tmp_path / "frame.png", size=_LARGE)

    assert _thumbnail(path) == _thumbnail(path)


def test_two_identical_files_thumbnail_to_the_same_bytes(tmp_path: Path) -> None:
    """The property a content-addressed thumbnail cache dedups on."""
    first = write_image(tmp_path / "a.png", size=_LARGE, seed=7)
    second = write_image(tmp_path / "b.png", size=_LARGE, seed=7)

    assert hashlib.sha256(_thumbnail(first)).digest() == hashlib.sha256(_thumbnail(second)).digest()


def test_two_different_files_thumbnail_to_different_bytes(tmp_path: Path) -> None:
    """Guards the bug where a pinned encoder quietly becomes a constant output."""
    first = write_image(tmp_path / "a.png", size=_LARGE, seed=1)
    second = write_image(tmp_path / "b.png", size=_LARGE, seed=2)

    assert _thumbnail(first) != _thumbnail(second)


def test_two_processors_agree_on_one_source(tmp_path: Path) -> None:
    """No instance state, so a workspace-scoped decoder is uniformity and not isolation."""
    path = write_image(tmp_path / "frame.png", size=_LARGE)

    with path.open("rb") as handle:
        first = PillowImageProcessor().thumbnail(handle)
    with path.open("rb") as handle:
        second = PillowImageProcessor().thumbnail(handle)

    assert first == second


def test_a_thumbnail_carries_none_of_the_source_metadata(tmp_path: Path) -> None:
    """A fresh canvas, so an ICC profile riding along cannot become an input to the hash."""
    thumbnail = _decoded(_thumbnail(write_exif_rotated_image(tmp_path / "rotated.jpg")))

    assert dict(thumbnail.getexif()) == {}
    assert "icc_profile" not in thumbnail.info


@pytest.mark.parametrize("max_edge", [16, 64, 256], ids=lambda value: f"max-edge-{value}")
def test_the_longest_edge_is_the_one_that_was_asked_for(tmp_path: Path, max_edge: int) -> None:
    path = write_image(tmp_path / "frame.png", size=(1000, 400))

    assert max(_decoded(_thumbnail(path, max_edge=max_edge)).size) == max_edge


@pytest.mark.parametrize("size", [(1000, 400), (400, 1000)], ids=["landscape", "portrait"])
def test_a_thumbnail_keeps_the_aspect_ratio_of_its_source(
    tmp_path: Path, size: tuple[int, int]
) -> None:
    path = write_image(tmp_path / "frame.png", size=size)

    width, height = _decoded(_thumbnail(path)).size

    assert abs(width / height - size[0] / size[1]) < 0.05


def test_an_image_smaller_than_the_limit_is_not_enlarged(tmp_path: Path) -> None:
    """Inventing pixels to fill a preview is a lie the gallery would then have to display."""
    path = write_image(tmp_path / "tiny.png")

    assert _decoded(_thumbnail(path)).size == DEFAULT_IMAGE_SIZE


def test_the_default_longest_edge_is_the_one_the_port_declares(tmp_path: Path) -> None:
    path = write_image(tmp_path / "frame.png", size=(1000, 400))

    assert DEFAULT_THUMBNAIL_MAX_EDGE == 256
    assert _thumbnail(path) == _thumbnail(path, max_edge=DEFAULT_THUMBNAIL_MAX_EDGE)


def test_a_transparent_image_is_composited_onto_an_opaque_background(tmp_path: Path) -> None:
    """Not ``convert("RGB")``, which keeps whatever colour hid under a transparent pixel."""
    path = tmp_path / "logo.png"
    source = Image.new("RGBA", _LARGE, (255, 0, 0, 0))
    source.save(path)

    thumbnail = _decoded(_thumbnail(path))

    assert thumbnail.mode == "RGB"
    assert thumbnail.getpixel((0, 0)) == (255, 255, 255)


def test_a_palette_image_thumbnails_like_any_other(tmp_path: Path) -> None:
    """Converted before the resize: Pillow silently drops to nearest-neighbour on a palette."""
    path = tmp_path / "palette.png"
    write_image(tmp_path / "source.png", size=_LARGE)
    Image.open(tmp_path / "source.png").convert("P").save(path)

    thumbnail = _decoded(_thumbnail(path))

    assert (thumbnail.format, thumbnail.size) == ("JPEG", (256, 171))


@pytest.mark.parametrize("max_edge", [0, -1], ids=["zero", "negative"])
def test_a_max_edge_below_one_is_a_programming_error(tmp_path: Path, max_edge: int) -> None:
    """A ``ValueError``, deliberately outside the ``MediaError`` family an ingest catches."""
    path = write_image(tmp_path / "frame.png")

    with pytest.raises(ValueError, match="max_edge must be at least 1"):
        _thumbnail(path, max_edge=max_edge)


# --- the limits this adapter does not move ------------------------------------


def test_an_image_with_too_many_pixels_names_itself_in_the_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Refused off the header, before a decoder runs — and no bomb file is generated to prove it."""
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 100)
    path = write_image(tmp_path / "huge.png")

    with pytest.raises(UnsupportedMedia, match="huge.png"):
        _probe(path)


def test_the_adapter_leaves_pillows_pixel_limit_alone() -> None:
    """Raising a process-wide safety limit is the embedding program's call, not a library's."""
    assert Image.MAX_IMAGE_PIXELS is not None


def test_the_adapter_never_enables_truncated_loading() -> None:
    """The flag that would turn every corruption test green while breaking the product."""
    from PIL import ImageFile

    assert ImageFile.LOAD_TRUNCATED_IMAGES is False


# --- the port -----------------------------------------------------------------
def test_every_decoder_name_maps_to_an_accepted_format() -> None:
    """The mechanism behind "extend the list deliberately": two edits, tied by this line."""
    assert set(_FORMAT_BY_PILLOW_NAME.values()) == set(ImageFormat)


def test_the_thumbnail_encoding_is_the_one_the_port_declares() -> None:
    """Ties the adapter's decoder name to the port's format, which agree only by intent."""
    assert _FORMAT_BY_PILLOW_NAME[_THUMBNAIL_PILLOW_NAME] is THUMBNAIL_FORMAT


def test_the_thumbnail_encoder_arguments_are_pinned() -> None:
    """A change detector on purpose: moving a value here moves every stored thumbnail key."""
    assert _THUMBNAIL_ENCODER == {
        "quality": 85,
        "subsampling": 0,
        "optimize": False,
        "progressive": False,
    }


# --- composition --------------------------------------------------------------


class _NullImageProcessor:
    """A stand-in that decodes nothing — enough to prove the seam, and nothing more."""

    def probe(self, content: io.IOBase, *, name: str | None = None) -> ImageMetadata:
        return ImageMetadata(width=1, height=1, format=ImageFormat.PNG)

    def thumbnail(
        self,
        content: io.IOBase,
        *,
        max_edge: int = DEFAULT_THUMBNAIL_MAX_EDGE,
        name: str | None = None,
    ) -> bytes:
        return b""

    def stills(self, content: io.IOBase, *, name: str | None = None) -> Iterator[DecodedStill]:
        return iter(())


def test_a_workspace_exposes_an_image_processor_by_default(tmp_path: Path) -> None:
    with WorkspaceService.init(tmp_path / "ws") as workspace:
        assert isinstance(workspace.image_processor, ImageProcessor)
        assert isinstance(workspace.image_processor, PillowImageProcessor)


def test_each_open_workspace_gets_its_own_processor(tmp_path: Path) -> None:
    with (
        WorkspaceService.init(tmp_path / "one") as one,
        WorkspaceService.init(tmp_path / "two") as two,
    ):
        assert one.image_processor is not two.image_processor


def test_an_image_processor_can_be_injected_at_init(tmp_path: Path) -> None:
    with WorkspaceService.init(
        tmp_path / "ws", image_processor_factory=_NullImageProcessor
    ) as workspace:
        assert isinstance(workspace.image_processor, _NullImageProcessor)


def test_an_image_processor_can_be_injected_at_open(tmp_path: Path) -> None:
    """The seam an embedder actually reaches for: a workspace it did not create."""
    WorkspaceService.init(tmp_path / "ws").close()

    with WorkspaceService.open(
        tmp_path / "ws", image_processor_factory=_NullImageProcessor
    ) as workspace:
        assert isinstance(workspace.image_processor, _NullImageProcessor)


def test_a_decoded_still_is_frozen_and_defaults_to_pass_through() -> None:
    still = DecodedStill(metadata=ImageMetadata(width=2, height=1, format=ImageFormat.JPEG))
    assert still.payload is None
    assert still.frame_index is None
    assert still.frame_timestamp is None
    with pytest.raises(ValidationError):
        still.payload = b"x"  # type: ignore[misc]


# --- stills: accept what Pillow decodes, normalized to JPEG and PNG ------------


def _stills(path: Path) -> list[DecodedStill]:
    with path.open("rb") as handle:
        return list(PillowImageProcessor().stills(handle, name=str(path)))


def test_a_native_jpeg_passes_through_with_no_payload(tmp_path: Path) -> None:
    path = tmp_path / "native.jpg"
    Image.new("RGB", (32, 24), (200, 10, 10)).save(path, format="JPEG")

    (still,) = _stills(path)

    assert still.payload is None
    assert still.frame_index is None
    assert still.metadata == ImageMetadata(width=32, height=24, format=ImageFormat.JPEG)


def test_a_native_png_passes_through_with_no_payload(tmp_path: Path) -> None:
    path = tmp_path / "native.png"
    Image.new("RGB", (32, 24), (10, 200, 10)).save(path, format="PNG")

    (still,) = _stills(path)

    assert still.payload is None
    assert still.metadata.format is ImageFormat.PNG


def test_a_webp_arrives_as_a_jpeg_payload(tmp_path: Path) -> None:
    path = tmp_path / "photo.webp"
    Image.new("RGB", (32, 24), (10, 10, 200)).save(path, format="WEBP")

    (still,) = _stills(path)

    assert still.payload is not None
    assert still.metadata.format is ImageFormat.JPEG
    decoded = _decoded(still.payload)
    assert decoded.format == "JPEG"
    assert decoded.size == (32, 24)


def test_an_heic_arrives_as_a_jpeg_payload(tmp_path: Path) -> None:
    path = tmp_path / "photo.heic"
    Image.new("RGB", (32, 24), (120, 60, 30)).save(path, format="HEIF")

    (still,) = _stills(path)

    assert still.payload is not None
    assert still.metadata.format is ImageFormat.JPEG


def test_an_oriented_webp_is_transposed_before_encoding(tmp_path: Path) -> None:
    path = tmp_path / "turned.webp"
    exif = Image.Exif()
    exif[0x0112] = 6
    Image.new("RGB", (32, 24), (1, 2, 3)).save(path, format="WEBP", exif=exif)

    (still,) = _stills(path)

    assert (still.metadata.width, still.metadata.height) == (24, 32)


def test_transparency_composites_onto_white(tmp_path: Path) -> None:
    path = tmp_path / "logo.webp"
    Image.new("RGBA", (8, 8), (255, 0, 0, 0)).save(path, format="WEBP", lossless=True)

    (still,) = _stills(path)

    assert still.payload is not None
    assert _decoded(still.payload).getpixel((4, 4)) == (255, 255, 255)


def test_a_transcode_is_repeatable_within_this_build(tmp_path: Path) -> None:
    path = tmp_path / "photo.webp"
    Image.new("RGB", (32, 24), (9, 9, 9)).save(path, format="WEBP")

    assert _stills(path)[0].payload == _stills(path)[0].payload


def test_stills_refuses_what_pillow_cannot_decode(tmp_path: Path) -> None:
    path = write_unsupported_file(tmp_path / "notes.txt")

    with pytest.raises(UnsupportedMedia, match="not a recognizable image"):
        _stills(path)
