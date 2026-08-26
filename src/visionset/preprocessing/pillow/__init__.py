# usage: from visionset.preprocessing.pillow import PillowResizeDriver, PillowAugmentDriver
"""The built-in drivers: Pillow doing the pixels for every v1 recipe step.

Both drivers decode, orient, transform and re-encode; they never move a
coordinate. The orientation step mirrors ingest — ``PillowImageProcessor``
bakes the EXIF turn in before it measures, so the manifest's width and height
already describe the oriented picture, and a driver that skipped the turn
would resize a picture the kernel's geometry never saw. Where a letterbox
lands and what a variant draws are read from the kernel, never recomputed.

Re-encoding keeps the source's format: a JPEG comes back a JPEG at quality 95
with its chroma subsampling kept, a PNG comes back a lossless PNG, and any
other encoding comes back a PNG. No metadata travels — the EXIF that named
the orientation is gone because the orientation is now in the pixels, and an
ICC profile or a text chunk would be a second input to bytes that should
depend on the pixels alone. Byte stability is promised within one environment
only: the same Pillow, the same codecs.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Final

from PIL import Image, ImageEnhance, ImageOps
from PIL.JpegImagePlugin import get_sampling

from visionset.kernel.domain import (
    AugmentOp,
    AugmentStep,
    ResizeStep,
    ResizeStrategy,
    Step,
    brightness_contrast_factors,
    letterbox_fit,
    rot90_quarter_turns,
)
from visionset.kernel.errors import UnsupportedMedia

JPEG_QUALITY: Final = 95

#: The bytes a driver returns are always in one of these, keyed by Pillow's name.
#: Anything else the decoder can open — an MPO is a JPEG container — is written
#: as a PNG, the one lossless encoding every reader has.
MEDIA_TYPES: Final[dict[str, str]] = {"JPEG": "image/jpeg", "PNG": "image/png"}

#: Modes the transforms keep as they are. Everything else — palette, bilevel,
#: 16-bit, CMYK — is converted first: Pillow silently resamples a palette image
#: nearest-neighbour, and a letterbox canvas needs a mode a grey can be spelled in.
_KEPT_MODES: Final = frozenset({"L", "LA", "RGB", "RGBA"})
_ALPHA_MODES: Final = frozenset({"RGBA", "LA", "PA"})

_QUARTER_TURNS: Final = {
    1: Image.Transpose.ROTATE_90,
    2: Image.Transpose.ROTATE_180,
    3: Image.Transpose.ROTATE_270,
}


@dataclass(frozen=True)
class _Decoded:
    """An oriented, transform-ready image and what its bytes were encoded as."""

    image: Image.Image
    pillow_format: str
    jpeg_sampling: int


def _decode(data: bytes) -> _Decoded:
    with Image.open(io.BytesIO(data)) as opened:
        pillow_format = "JPEG" if opened.format == "MPO" else (opened.format or "")
        opened.load()
        sampling = get_sampling(opened) if pillow_format == "JPEG" else -1
        ImageOps.exif_transpose(opened, in_place=True)
        image = opened if opened.mode in _KEPT_MODES else _converted(opened)
        image = image.copy() if image is opened else image
    return _Decoded(image=image, pillow_format=pillow_format, jpeg_sampling=sampling)


def _converted(image: Image.Image) -> Image.Image:
    has_alpha = image.mode in _ALPHA_MODES or "transparency" in image.info
    return image.convert("RGBA" if has_alpha else "RGB")


def _encode(image: Image.Image, decoded: _Decoded) -> bytes:
    buffer = io.BytesIO()
    if decoded.pillow_format == "JPEG":
        options: dict[str, object] = {"quality": JPEG_QUALITY}
        if decoded.jpeg_sampling >= 0:
            options["subsampling"] = decoded.jpeg_sampling
        image.convert("RGB").save(buffer, format="JPEG", **options)
    else:
        image.save(buffer, format="PNG")
    return buffer.getvalue()


def media_type(data: bytes) -> str:
    """The media type of bytes a driver returned, or would return for this source."""
    with Image.open(io.BytesIO(data)) as opened:
        pillow_format = "JPEG" if opened.format == "MPO" else (opened.format or "")
    return MEDIA_TYPES.get(pillow_format, MEDIA_TYPES["PNG"])


def _pad_colour(mode: str, pad_value: int) -> tuple[int, ...]:
    bands = Image.getmodebands(mode)
    if mode in _ALPHA_MODES:
        return (pad_value,) * (bands - 1) + (255,)
    return (pad_value,) * bands


def _resample(source: tuple[int, int], target: tuple[int, int]) -> Image.Resampling:
    downscaling = target[0] * target[1] < source[0] * source[1]
    return Image.Resampling.LANCZOS if downscaling else Image.Resampling.BICUBIC


def _resized(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    if size[0] < 1 or size[1] < 1:
        raise UnsupportedMedia(
            f"letterboxing a {image.width}×{image.height} image leaves no pixels on one "
            f"side; choose a canvas closer to its aspect ratio or use the stretch strategy"
        )
    return image.resize(size, _resample(image.size, size), reducing_gap=None)


class PillowResizeDriver:
    """``resize`` steps: stretch to the size, or letterbox onto a padded canvas.

    Stretch is one ``Image.resize`` per axis, LANCZOS when the pixel count
    shrinks and BICUBIC when it grows. Letterbox reads ``letterbox_fit`` for
    the content size and offset and pastes the resized content there on a
    canvas filled with ``pad_value`` — the same numbers the kernel used to
    place the annotations, so pixels and labels cannot disagree by a rounding.
    Neither reads the seed or the variant: a resize is the same for every
    variant of an image.
    """

    step_kinds: frozenset[str] = frozenset({"resize"})

    def apply(self, step: Step, image: bytes, *, seed: bytes, variant: int) -> bytes:
        """The image at ``step.width × step.height``, re-encoded in its own format.

        Raises:
            UnsupportedMedia: a letterbox whose aspect ratio rounds one side of
                the content to zero pixels.
        """
        if not isinstance(step, ResizeStep):
            raise TypeError(f"{type(self).__name__} applies resize steps, not {step.kind!r}")
        decoded = _decode(image)
        with decoded.image as source:
            if step.strategy is ResizeStrategy.STRETCH:
                result = _resized(source, (step.width, step.height))
            else:
                result = _letterboxed(source, step)
        with result:
            return _encode(result, decoded)


def _letterboxed(source: Image.Image, step: ResizeStep) -> Image.Image:
    fit = letterbox_fit(
        source.width, source.height, target_width=step.width, target_height=step.height
    )
    canvas = Image.new(
        source.mode, (step.width, step.height), _pad_colour(source.mode, step.pad_value)
    )
    with _resized(source, (fit.content_width, fit.content_height)) as content:
        canvas.paste(content, (fit.offset_x, fit.offset_y))
    return canvas


class PillowAugmentDriver:
    """``augment`` steps: mirror, brightness then contrast, or a quarter turn.

    Every draw comes from the kernel — ``brightness_contrast_factors``,
    ``rot90_quarter_turns``; a mirror is not drawn, every hflip variant
    mirrors — over the seed the caller passes, so the pixels land where the
    geometry transform put the labels. Variant 0 is the base image and is
    returned untouched apart from orientation and re-encoding, which is what a
    step applied to it means.
    """

    step_kinds: frozenset[str] = frozenset({"augment"})

    def apply(self, step: Step, image: bytes, *, seed: bytes, variant: int) -> bytes:
        """The variant this seed draws for one augmentation, in the source's format."""
        if not isinstance(step, AugmentStep):
            raise TypeError(f"{type(self).__name__} applies augment steps, not {step.kind!r}")
        decoded = _decode(image)
        with decoded.image as source:
            result = source if variant == 0 else _augmented(source, step, seed)
            return _encode(result, decoded)


def _augmented(source: Image.Image, step: AugmentStep, seed: bytes) -> Image.Image:
    if step.op is AugmentOp.HFLIP:
        return ImageOps.mirror(source)
    if step.op is AugmentOp.BRIGHTNESS_CONTRAST:
        brightness, contrast = brightness_contrast_factors(seed, step.amount)
        brightened = ImageEnhance.Brightness(source).enhance(brightness)
        return ImageEnhance.Contrast(brightened).enhance(contrast)
    return source.transpose(_QUARTER_TURNS[rot90_quarter_turns(seed)])
