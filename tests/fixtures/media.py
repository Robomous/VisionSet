"""Image fixtures, generated at runtime — VisionSet never commits a binary.

v1 of this product shipped 929 MB of fixture images into git history. Every image a test needs
is made here instead, into a tmpdir; the guard in
`tests/architecture/test_tracked_file_sizes.py` is what stops the old habit coming back.

**There is nothing here that makes a video, and that is not an omission.** Nothing in this
distribution decodes one: a clip is materialized into frames by a browser, and the Python side
sees PNGs. A fixture that shelled out to an external decoder would put that binary back on the
list of things a contributor has to install, to feed a suite with nothing left to point it at.

Every generator is deterministic on purpose. The same arguments produce byte-identical output,
so a dedup test can rely on two calls colliding, and a content-addressing test can re-run
without churn.
"""

from pathlib import Path

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
