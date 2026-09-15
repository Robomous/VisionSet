"""The generators are load-bearing for every media test, so they get tested themselves.

What is pinned here is the part everything else *relies on*: that equal arguments give equal
bytes (dedup and idempotency), that the EXIF fixture really is rotated, and that a
corrupt file really fails to decode.
"""

import hashlib
from pathlib import Path

import pytest
from PIL import Image, ImageOps, UnidentifiedImageError
from tests.fixtures.media import (
    DEFAULT_IMAGE_SIZE,
    write_corrupt_image,
    write_exif_rotated_image,
    write_image,
    write_image_in_unsupported_format,
    write_images,
    write_multi_picture_jpeg,
    write_unsupported_file,
)


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_a_written_image_decodes_at_the_requested_size(tmp_path: Path) -> None:
    path = write_image(tmp_path / "frame.png", size=(48, 12))
    with Image.open(path) as image:
        assert image.size == (48, 12)
        assert image.format == "PNG"


def test_the_suffix_chooses_the_encoder(tmp_path: Path) -> None:
    with Image.open(write_image(tmp_path / "frame.jpg")) as image:
        assert image.format == "JPEG"


def test_an_unknown_suffix_is_refused_rather_than_guessed(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match=r"no image format for suffix '\.tiff'"):
        write_image(tmp_path / "frame.tiff")


def test_equal_arguments_produce_identical_bytes(tmp_path: Path) -> None:
    """Two identical files is the fixture a dedup test needs; it must not be luck."""
    first = write_image(tmp_path / "a.png", seed=7)
    second = write_image(tmp_path / "b.png", seed=7)
    assert _digest(first) == _digest(second)


def test_different_seeds_produce_different_bytes(tmp_path: Path) -> None:
    assert _digest(write_image(tmp_path / "a.png", seed=1)) != _digest(
        write_image(tmp_path / "b.png", seed=2)
    )


def test_a_generated_directory_holds_distinct_images(tmp_path: Path) -> None:
    paths = write_images(tmp_path / "shoot", count=4)
    assert [path.name for path in paths] == [
        "frame_000.png",
        "frame_001.png",
        "frame_002.png",
        "frame_003.png",
    ]
    assert len({_digest(path) for path in paths}) == 4


def test_the_exif_fixture_stores_one_size_and_means_another(tmp_path: Path) -> None:
    """Dimensions are reported *after* orientation; this is the fixture that catches it."""
    path = write_exif_rotated_image(tmp_path / "rotated.jpg")
    with Image.open(path) as image:
        assert image.size == DEFAULT_IMAGE_SIZE == (32, 24)
        assert image.getexif()[274] == 6
        assert ImageOps.exif_transpose(image).size == (24, 32)


def test_a_corrupt_image_is_sniffable_but_undecodable(tmp_path: Path) -> None:
    path = write_corrupt_image(tmp_path / "broken.jpg")
    with pytest.raises(OSError, match="Truncated"), Image.open(path) as image:
        image.load()


def test_an_unsupported_file_is_not_an_image_at_all(tmp_path: Path) -> None:
    path = write_unsupported_file(tmp_path / "notes.txt")
    with pytest.raises(UnidentifiedImageError):
        Image.open(path)


@pytest.mark.parametrize("image_format", ["BMP", "GIF", "TIFF"], ids=str.lower)
def test_an_unaccepted_format_is_a_perfectly_good_image(tmp_path: Path, image_format: str) -> None:
    """The third refusal: decodable, and still declined. Not to be confused with garbage."""
    path = write_image_in_unsupported_format(tmp_path / "photo.bin", image_format=image_format)
    with Image.open(path) as image:
        assert image.format == image_format
        assert image.size == DEFAULT_IMAGE_SIZE


def test_a_multi_picture_jpeg_announces_itself_as_mpo(tmp_path: Path) -> None:
    """What a phone writes. Accepted as a JPEG, which is only possible by knowing the name."""
    path = write_multi_picture_jpeg(tmp_path / "burst.jpg")
    with Image.open(path) as image:
        assert image.format == "MPO"
        assert image.n_frames == 2
        assert image.size == DEFAULT_IMAGE_SIZE


def test_the_generators_added_for_the_image_processor_are_deterministic(tmp_path: Path) -> None:
    assert _digest(write_image_in_unsupported_format(tmp_path / "a.bmp")) == _digest(
        write_image_in_unsupported_format(tmp_path / "b.bmp")
    )
    assert _digest(write_multi_picture_jpeg(tmp_path / "a.jpg")) == _digest(
        write_multi_picture_jpeg(tmp_path / "b.jpg")
    )
