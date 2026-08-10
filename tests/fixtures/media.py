"""Media fixtures, generated at runtime — VisionSet never commits a binary.

v1 of this product shipped 929 MB of fixture images into git history. Every image and video a
test needs is made here instead, into a tmpdir; the guard in
`tests/architecture/test_tracked_file_sizes.py` is what stops the old habit coming back.

Every generator is deterministic on purpose. The same arguments produce byte-identical output,
so a dedup test can rely on two calls colliding, and a content-addressing test can re-run
without churn. For video that determinism holds *within* one ffmpeg build, not across
versions — assert on repeatability, never on a hardcoded hash.
"""

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest
from PIL import ExifTags, Image

# --- images ---------------------------------------------------------------------------------

DEFAULT_IMAGE_SIZE = (32, 24)
"""Non-square on purpose: an EXIF orientation swap is invisible on a square image."""

JPEG_ENCODER_ARGS: dict[str, object] = {"quality": 90, "subsampling": 0, "optimize": False}
"""Pinned: thumbnails are content-addressed, so a drifting encoder moves the hash."""

_FORMAT_BY_SUFFIX = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG"}


def image_format_for(path: Path) -> str:
    """The suffix picks the encoder, so a caller names the file it wants and gets it."""
    try:
        return _FORMAT_BY_SUFFIX[path.suffix.lower()]
    except KeyError:
        expected = ", ".join(sorted(_FORMAT_BY_SUFFIX))
        raise ValueError(
            f"no image format for suffix {path.suffix!r}; expected {expected}"
        ) from None


def _pattern(size: tuple[int, int], seed: int) -> bytes:
    """Textured rather than flat: a solid colour compresses to nearly nothing and hides bugs."""
    width, height = size
    return bytes(
        channel
        for y in range(height)
        for x in range(width)
        for channel in (
            (x * 8 + seed * 13) % 256,
            (y * 8 + seed * 29) % 256,
            (x + y + seed * 47) % 256,
        )
    )


def write_image(
    path: Path,
    *,
    size: tuple[int, int] = DEFAULT_IMAGE_SIZE,
    seed: int = 0,
    orientation: int | None = None,
) -> Path:
    """A tiny image. Equal arguments give equal bytes — that is what makes a dedup test possible."""
    image_format = image_format_for(path)
    save_args: dict[str, object] = dict(JPEG_ENCODER_ARGS) if image_format == "JPEG" else {}
    if orientation is not None:
        exif = Image.Exif()
        exif[ExifTags.Base.Orientation.value] = orientation
        save_args["exif"] = exif
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.frombytes("RGB", size, _pattern(size, seed)).save(path, format=image_format, **save_args)
    return path


def write_images(
    directory: Path,
    *,
    count: int,
    size: tuple[int, int] = DEFAULT_IMAGE_SIZE,
    suffix: str = ".png",
    prefix: str = "frame",
    first_seed: int = 0,
) -> list[Path]:
    """`count` images whose contents all differ — one seed each, so no pair dedups by accident."""
    directory.mkdir(parents=True, exist_ok=True)
    return [
        write_image(directory / f"{prefix}_{index:03d}{suffix}", size=size, seed=first_seed + index)
        for index in range(count)
    ]


def write_exif_rotated_image(
    path: Path,
    *,
    size: tuple[int, int] = DEFAULT_IMAGE_SIZE,
    seed: int = 0,
    orientation: int = 6,
) -> Path:
    """Orientation 6 is a 90° turn, so a 32x24 file must be *reported* as 24x32."""
    return write_image(path, size=size, seed=seed, orientation=orientation)


def write_corrupt_image(
    path: Path,
    *,
    size: tuple[int, int] = DEFAULT_IMAGE_SIZE,
    seed: int = 0,
) -> Path:
    """A real header over a truncated body: sniffing succeeds and decoding is what fails."""
    write_image(path, size=size, seed=seed)
    intact = path.read_bytes()
    path.write_bytes(intact[: len(intact) // 2])
    return path


def write_unsupported_file(path: Path) -> Path:
    """Not an image at all — the other half of the per-file error path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"this is not an image\n")
    return path


def write_image_in_unsupported_format(
    path: Path,
    *,
    size: tuple[int, int] = DEFAULT_IMAGE_SIZE,
    seed: int = 0,
    image_format: str = "BMP",
) -> Path:
    """A valid, decodable image in a format VisionSet deliberately does not accept.

    The third refusal, and the one that is easiest to forget exists. Pillow reads
    BMP, GIF, TIFF and WEBP perfectly well, so "we decline this format" is a real
    branch and a different one from `write_unsupported_file`'s "these bytes are not
    an image". Bypasses `image_format_for` on purpose — the suffix table is the list
    of formats the *product* accepts, and this writes something outside it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.frombytes("RGB", size, _pattern(size, seed)).save(path, format=image_format)
    return path


def write_multi_picture_jpeg(
    path: Path,
    *,
    size: tuple[int, int] = DEFAULT_IMAGE_SIZE,
    seed: int = 0,
) -> Path:
    """A two-frame MPO — what a phone writes in portrait and burst modes.

    Pillow reports the container as `MPO`, not `JPEG`, so a decoder that matched on
    the format name alone would refuse a very large share of real camera output. The
    frames differ so that nothing can quietly read the second one and call it the first.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    primary = Image.frombytes("RGB", size, _pattern(size, seed))
    secondary = Image.frombytes("RGB", size, _pattern(size, seed + 1))
    primary.save(path, format="MPO", append_images=[secondary], **JPEG_ENCODER_ARGS)
    return path


# --- video ----------------------------------------------------------------------------------

FFMPEG_REQUIRED_ENV = "VISIONSET_REQUIRE_FFMPEG"

FFMPEG_MISSING_HINT = (
    "ffmpeg is not on PATH. Install it to run VisionSet's video tests: "
    "`brew install ffmpeg` (macOS) or `sudo apt-get install ffmpeg` (Debian/Ubuntu)."
)

DEFAULT_VIDEO_SIZE = (64, 48)


def ffmpeg_is_available() -> bool:
    return shutil.which("ffmpeg") is not None


def require_ffmpeg() -> None:
    """Skip locally, fail in CI — a silently skipped video test looks exactly like a passing one.

    CI installs ffmpeg and sets `VISIONSET_REQUIRE_FFMPEG=1`, so if that install ever breaks the
    suite goes red instead of quietly shrinking.
    """
    if ffmpeg_is_available():
        return
    if os.environ.get(FFMPEG_REQUIRED_ENV) == "1":
        raise RuntimeError(
            f"{FFMPEG_MISSING_HINT} "
            f"({FFMPEG_REQUIRED_ENV}=1 is set, so a missing binary is an error, not a skip.)"
        )
    pytest.skip(FFMPEG_MISSING_HINT, allow_module_level=True)


@dataclass(frozen=True)
class GeneratedVideo:
    """What was asked for, carried alongside the file, so a probe test asserts against the
    generator instead of a literal nobody can trace back."""

    path: Path
    width: int
    height: int
    fps: int
    duration_seconds: float

    @property
    def frame_count(self) -> int:
        return round(self.fps * self.duration_seconds)


def _run_ffmpeg(command: list[str], path: Path) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed generating {path.name}:\n{result.stderr}")


def write_video(
    path: Path,
    *,
    size: tuple[int, int] = DEFAULT_VIDEO_SIZE,
    fps: int = 10,
    duration_seconds: float = 2.0,
) -> GeneratedVideo:
    """A tiny `testsrc` clip. The defaults give 20 frames, so extraction at 1/5/10 fps lands on
    exactly 2/10/20 — no rounding to argue about at the boundary.

    `-fflags/-flags:v +bitexact` strip the encoder version and timestamps that would otherwise
    make two runs of the same command differ.

    `-movflags +faststart` puts the index at the front of the file. Nothing in an intact clip
    cares, but it is what makes `write_corrupt_video` able to produce a *partially* readable
    file rather than an unopenable one — see there.
    """
    require_ffmpeg()
    width, height = size
    path.parent.mkdir(parents=True, exist_ok=True)
    _run_ffmpeg(
        [
            "ffmpeg",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=size={width}x{height}:rate={fps}:duration={duration_seconds}",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            str(fps),
            "-movflags",
            "+faststart",
            "-fflags",
            "+bitexact",
            "-flags:v",
            "+bitexact",
            "-y",
            str(path),
        ],  # fmt: skip
        path,
    )
    return GeneratedVideo(
        path=path,
        width=width,
        height=height,
        fps=fps,
        duration_seconds=duration_seconds,
    )


def write_corrupt_video(
    path: Path,
    *,
    size: tuple[int, int] = DEFAULT_VIDEO_SIZE,
    fps: int = 10,
    duration_seconds: float = 2.0,
) -> GeneratedVideo:
    """A clip that opens, decodes for a while, and then runs out — the `CorruptMedia` case.

    The trick is the faststart index `write_video` already asks for. With the index at the
    front, truncating the tail leaves a file ffprobe describes perfectly well and ffmpeg fails
    *partway through*, which is what separates "this file is broken" from "this is not a file we
    can read". Truncate a clip whose index sits at the end instead and you get the latter: an
    unopenable container, which is `write_unsupported_file`'s job and not this one's.

    The returned `GeneratedVideo` describes what was asked for, not what survived — the whole
    point is that the survivor is shorter.
    """
    clip = write_video(path, size=size, fps=fps, duration_seconds=duration_seconds)
    intact = path.read_bytes()
    path.write_bytes(intact[: len(intact) // 2])
    return clip


def write_rotated_video(
    path: Path,
    *,
    size: tuple[int, int] = DEFAULT_VIDEO_SIZE,
    fps: int = 10,
    duration_seconds: float = 2.0,
    rotation: int = 90,
) -> GeneratedVideo:
    """A clip carrying a display matrix — what a phone writes when it is held upright.

    `-display_rotation` on the *input* plus a stream copy, because the older spelling
    (`-metadata:s:v:0 rotate=`) is deprecated and recent ffmpeg drops it silently, which would
    give a fixture that generates without error and tests nothing.

    The returned `GeneratedVideo` carries the **stored** size, deliberately: it is what the file
    holds, and the test's whole subject is that a probe reports something else.
    """
    source = path.with_name(f"upright-{path.name}")
    clip = write_video(source, size=size, fps=fps, duration_seconds=duration_seconds)
    _run_ffmpeg(
        [
            "ffmpeg",
            "-nostdin",
            "-loglevel",
            "error",
            "-display_rotation",
            str(rotation),
            "-i",
            str(source),
            "-c",
            "copy",
            "-y",
            str(path),
        ],  # fmt: skip
        path,
    )
    return GeneratedVideo(
        path=path,
        width=clip.width,
        height=clip.height,
        fps=fps,
        duration_seconds=duration_seconds,
    )
