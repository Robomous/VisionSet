"""The generators are load-bearing for every M2 test, so they get tested themselves.

What is pinned here is the part later tasks will *rely on*: that equal arguments give equal
bytes (#20's dedup and idempotency), that the EXIF fixture really is rotated (#16), that a
corrupt file really fails to decode (#16), and that a clip carries the frame count it claims
(#17).
"""

import hashlib
import subprocess
from pathlib import Path

import pytest
from PIL import Image, ImageOps, UnidentifiedImageError
from tests.fixtures import media
from tests.fixtures.media import (
    DEFAULT_IMAGE_SIZE,
    FFMPEG_REQUIRED_ENV,
    GeneratedVideo,
    require_ffmpeg,
    write_corrupt_image,
    write_exif_rotated_image,
    write_image,
    write_images,
    write_unsupported_file,
    write_video,
)

# --- images ---------------------------------------------------------------------------------


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
    """#16 must report dimensions *after* orientation; this is the fixture that catches it."""
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


# --- video ----------------------------------------------------------------------------------


def _probe(video: Path, entries: str) -> list[str]:
    result = subprocess.run(
        ["ffprobe", "-loglevel", "error", "-show_entries", entries, "-of", "csv=p=0", str(video)],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.split()


def test_a_generated_clip_matches_the_dimensions_it_reports(tmp_path: Path) -> None:
    require_ffmpeg()
    video = write_video(tmp_path / "clip.mp4")
    assert _probe(video.path, "stream=width,height") == [f"{video.width},{video.height}"]


def test_a_generated_clip_holds_the_frame_count_it_claims(tmp_path: Path) -> None:
    """#17 extracts at 1/5/10 fps against this clip, so its frame count cannot be approximate."""
    require_ffmpeg()
    video = write_video(tmp_path / "clip.mp4", fps=10, duration_seconds=2.0)
    assert video.frame_count == 20
    assert _probe(video.path, "stream=nb_frames") == ["20"]


def test_clip_length_and_rate_follow_the_arguments(tmp_path: Path) -> None:
    require_ffmpeg()
    video = write_video(tmp_path / "short.mp4", size=(32, 32), fps=5, duration_seconds=1.0)
    assert (video.width, video.height, video.frame_count) == (32, 32, 5)
    assert _probe(video.path, "stream=r_frame_rate") == ["5/1"]


def test_two_runs_of_the_same_clip_are_byte_identical(tmp_path: Path) -> None:
    """Determinism within one ffmpeg build — enough for #17's repeatability criterion. Across
    ffmpeg versions the bytes differ, so nothing may assert a hardcoded hash."""
    require_ffmpeg()
    first = write_video(tmp_path / "one.mp4")
    second = write_video(tmp_path / "two.mp4")
    assert _digest(first.path) == _digest(second.path)


def test_the_generated_video_record_is_immutable() -> None:
    """No ffmpeg needed: this is about the record, not the file it describes."""
    video = GeneratedVideo(path=Path("clip.mp4"), width=64, height=48, fps=10, duration_seconds=1.5)
    assert video.frame_count == 15
    with pytest.raises(AttributeError):
        video.fps = 30  # type: ignore[misc]


# --- the missing-ffmpeg tripwire --------------------------------------------------------------


def test_a_missing_binary_skips_when_nobody_demanded_it(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(media.shutil, "which", lambda _name: None)
    monkeypatch.delenv(FFMPEG_REQUIRED_ENV, raising=False)
    with pytest.raises(pytest.skip.Exception, match="ffmpeg is not on PATH"):
        require_ffmpeg()


def test_a_missing_binary_is_an_error_once_ci_demands_it(monkeypatch: pytest.MonkeyPatch) -> None:
    """CI installs ffmpeg and sets the flag, so a broken install goes red instead of quiet."""
    monkeypatch.setattr(media.shutil, "which", lambda _name: None)
    monkeypatch.setenv(FFMPEG_REQUIRED_ENV, "1")
    with pytest.raises(RuntimeError, match="brew install ffmpeg"):
        require_ffmpeg()
