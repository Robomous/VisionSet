"""The Pillow drivers agree with the kernel, pixel for pixel.

Every image is built in memory: the point of each test is a dimension, a
pixel position or a byte identity, none of which needs a fixture file.
"""

from __future__ import annotations

import io
from uuid import uuid4

import pytest
from PIL import Image

from visionset.kernel.domain import (
    SHOWCASE_SEED,
    AugmentOp,
    AugmentStep,
    BboxGeometry,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    brightness_contrast_factors,
    canvas_fit,
    letterbox_fit,
    rot90_quarter_turns,
    transform_manifest,
    variant_seed,
)
from visionset.kernel.errors import UnsupportedMedia
from visionset.kernel.ports import PreprocessingDriver
from visionset.preprocessing.pillow import PillowAugmentDriver, PillowResizeDriver, media_type

RESIZE = PillowResizeDriver()
AUGMENT = PillowAugmentDriver()

NO_SEED = b"\0" * 32

#: Odd and even on both axes, wider and taller than every target, and targets
#: that are odd themselves — the roundings a letterbox can get wrong.
SOURCE_SIZES = [(33, 47), (64, 64), (101, 37), (40, 90), (65, 32)]
TARGET_SIZES = [(64, 64), (96, 32), (33, 65)]


def _png(size: tuple[int, int], colour: int | tuple[int, ...] = 200, mode: str = "RGB") -> bytes:
    image = Image.new(mode, size, colour)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _jpeg(size: tuple[int, int], **options: object) -> bytes:
    image = Image.new("RGB", size, (200, 120, 60))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", **options)  # type: ignore[arg-type]
    return buffer.getvalue()


def _marked(size: tuple[int, int], marker: tuple[int, int]) -> bytes:
    """A black image with one white pixel, so a transform's effect can be read back."""
    image = Image.new("L", size, 0)
    image.putpixel(marker, 255)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _open(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image.load()
    return image


def _white_pixels(image: Image.Image) -> set[tuple[int, int]]:
    return {
        (x, y)
        for y in range(image.height)
        for x in range(image.width)
        if image.getpixel((x, y)) == 255
    }


def _seed_where(predicate: object, *, start: int = 1) -> bytes:
    """The first variant seed for which ``predicate(seed)`` holds."""
    for k in range(start, start + 64):
        seed = variant_seed("recipe", "content", k)
        if predicate(seed):  # type: ignore[operator]
            return seed
    raise AssertionError("no seed in 64 draws satisfied the predicate")


# --- the port ----------------------------------------------------------------


def test_both_drivers_satisfy_the_port_and_split_the_step_kinds() -> None:
    assert isinstance(RESIZE, PreprocessingDriver)
    assert isinstance(AUGMENT, PreprocessingDriver)
    assert RESIZE.step_kinds == {"resize"}
    assert AUGMENT.step_kinds == {"augment"}


def test_a_driver_refuses_a_step_of_the_other_kind() -> None:
    with pytest.raises(TypeError):
        RESIZE.apply(AugmentStep(op=AugmentOp.HFLIP), _png((40, 40)), seed=NO_SEED, variant=1)
    with pytest.raises(TypeError):
        AUGMENT.apply(
            ResizeStep(strategy=ResizeStrategy.STRETCH, width=32, height=32),
            _png((40, 40)),
            seed=NO_SEED,
            variant=0,
        )


# --- resize: dimensions equal the kernel's ------------------------------------


@pytest.mark.parametrize("source", SOURCE_SIZES)
@pytest.mark.parametrize("target", TARGET_SIZES)
def test_stretch_lands_on_the_step_size(source: tuple[int, int], target: tuple[int, int]) -> None:
    step = ResizeStep(strategy=ResizeStrategy.STRETCH, width=target[0], height=target[1])
    out = _open(RESIZE.apply(step, _png(source), seed=NO_SEED, variant=0))

    assert out.size == target


@pytest.mark.parametrize("source", SOURCE_SIZES)
@pytest.mark.parametrize("target", TARGET_SIZES)
def test_letterbox_places_the_content_where_letterbox_fit_says(
    source: tuple[int, int], target: tuple[int, int]
) -> None:
    """White content on a black canvas: the white rectangle is the fit, exactly."""
    step = ResizeStep(
        strategy=ResizeStrategy.LETTERBOX, width=target[0], height=target[1], pad_value=0
    )
    fit = letterbox_fit(*source, target_width=target[0], target_height=target[1])
    out = _open(RESIZE.apply(step, _png(source, 255, "L"), seed=NO_SEED, variant=0))

    assert out.size == target
    expected = {
        (x, y)
        for y in range(fit.offset_y, fit.offset_y + fit.content_height)
        for x in range(fit.offset_x, fit.offset_x + fit.content_width)
    }
    assert _white_pixels(out) == expected


def test_letterbox_pads_with_the_pad_value_in_every_band() -> None:
    step = ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=64, height=32, pad_value=114)
    out = _open(RESIZE.apply(step, _png((32, 32), (0, 0, 0, 255), "RGBA"), seed=NO_SEED, variant=0))

    assert out.mode == "RGBA"
    assert out.getpixel((0, 0)) == (114, 114, 114, 255)
    assert out.getpixel((32, 16)) == (0, 0, 0, 255)


def _rectangle(size: tuple[int, int], box: tuple[int, int, int, int]) -> bytes:
    """A black image with a white rectangle ``[x0, x1) × [y0, y1)`` drawn on it."""
    image = Image.new("L", size, 0)
    image.paste(255, box)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _transformed_box(
    source: tuple[int, int], box: tuple[int, int, int, int], step: ResizeStep
) -> BboxGeometry | None:
    """Where the geometry transform puts a bbox drawn over ``box``, or None if it drops it."""
    x0, y0, x1, y1 = box
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="aa",
        uri="/img/aa.png",
        width=source[0],
        height=source[1],
        annotations=(
            ManifestAnnotation(
                id=uuid4(),
                label_class="thing",
                schema_version=1,
                geometry=BboxGeometry(x=x0, y=y0, width=x1 - x0, height=y1 - y0),
                provenance="human",
            ),
        ),
    )
    spec = RecipeSpec(target=None, steps=(step,))
    (file,) = transform_manifest(Manifest(schema_version=1, assets=(asset,)), spec, None).files
    if not file.annotations:
        return None
    geometry = file.annotations[0].geometry
    assert isinstance(geometry, BboxGeometry)
    return geometry


@pytest.mark.parametrize(
    ("source", "box", "target"),
    [
        # Cut on every side, odd margins floored: x by -5, y by -20.
        ((41, 88), (3, 10, 30, 60), (32, 48)),
        # Wholly inside the window.
        ((64, 64), (20, 20, 40, 40), (33, 33)),
        # A source narrower than the canvas: padded on x, cut on y.
        ((20, 100), (0, 30, 20, 90), (40, 64)),
    ],
)
def test_center_crop_cuts_the_pixels_where_the_geometry_says(
    source: tuple[int, int], box: tuple[int, int, int, int], target: tuple[int, int]
) -> None:
    """No scaling, so the white pixels are the transformed box's pixels exactly."""
    step = ResizeStep(
        strategy=ResizeStrategy.CENTER_CROP, width=target[0], height=target[1], pad_value=0
    )
    out = _open(RESIZE.apply(step, _rectangle(source, box), seed=NO_SEED, variant=0))
    placed = _transformed_box(source, box, step)

    assert out.size == target
    assert placed is not None
    left, top = int(placed.x), int(placed.y)
    assert _white_pixels(out) == {
        (x, y)
        for y in range(top, top + int(placed.height))
        for x in range(left, left + int(placed.width))
    }


def test_center_crop_pads_with_the_pad_value() -> None:
    step = ResizeStep(strategy=ResizeStrategy.CENTER_CROP, width=64, height=32, pad_value=114)
    out = _open(RESIZE.apply(step, _png((32, 32), (0, 0, 0)), seed=NO_SEED, variant=0))

    assert out.getpixel((0, 16)) == (114, 114, 114)
    assert out.getpixel((32, 16)) == (0, 0, 0)


@pytest.mark.parametrize(
    ("source", "box", "target"),
    [
        # Scale 4: 64×160 content, 48 cut off the top and the bottom.
        ((16, 40), (2, 14, 10, 20), (64, 64)),
        # Scale 2 on a wide source: 128×64 content, 32 cut off each side.
        ((64, 32), (10, 4, 40, 28), (64, 64)),
    ],
)
def test_fill_scales_and_crops_the_pixels_where_the_geometry_says(
    source: tuple[int, int], box: tuple[int, int, int, int], target: tuple[int, int]
) -> None:
    """Resampling softens the rectangle's rim, so its edges are read at half grey."""
    step = ResizeStep(strategy=ResizeStrategy.FILL, width=target[0], height=target[1])
    out = _open(RESIZE.apply(step, _rectangle(source, box), seed=NO_SEED, variant=0))
    placed = _transformed_box(source, box, step)

    assert out.size == target
    assert placed is not None
    bright = [
        (x, y) for y in range(out.height) for x in range(out.width) if out.getpixel((x, y)) > 127
    ]
    xs, ys = [x for x, _ in bright], [y for _, y in bright]
    assert (min(xs), min(ys), max(xs) + 1, max(ys) + 1) == pytest.approx(
        (placed.x, placed.y, placed.x + placed.width, placed.y + placed.height), abs=1
    )


def _noise(size: tuple[int, int]) -> bytes:
    """Every pixel different from its neighbours, so a misplaced resample shows."""
    image = Image.new("L", size)
    image.frombytes(bytes((x * 37 + y * 101) % 256 for y in range(size[1]) for x in range(size[0])))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.mark.parametrize(
    ("source", "target"), [((16, 40), (64, 64)), ((101, 50), (64, 64)), ((90, 41), (33, 65))]
)
def test_fill_writes_the_pixels_a_whole_resize_cropped_to_the_canvas_would(
    source: tuple[int, int], target: tuple[int, int]
) -> None:
    step = ResizeStep(strategy=ResizeStrategy.FILL, width=target[0], height=target[1])
    fit = canvas_fit(
        *source, strategy=ResizeStrategy.FILL, target_width=target[0], target_height=target[1]
    )
    whole = _open(_noise(source)).resize(
        (fit.content_width, fit.content_height),
        Image.Resampling.LANCZOS
        if fit.content_width * fit.content_height < source[0] * source[1]
        else Image.Resampling.BICUBIC,
        reducing_gap=None,
    )
    expected = whole.crop(
        (-fit.offset_x, -fit.offset_y, -fit.offset_x + target[0], -fit.offset_y + target[1])
    )

    out = _open(RESIZE.apply(step, _noise(source), seed=NO_SEED, variant=0))

    assert out.tobytes() == expected.tobytes()


def test_fill_never_resamples_more_than_the_canvas_keeps(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 4×1000 strip onto 1000×1000 would otherwise resample to 1000×250000 first."""
    requested: list[tuple[int, int]] = []
    original = Image.Image.resize

    def recording(
        self: Image.Image, size: tuple[int, int], *args: object, **kwargs: object
    ) -> Image.Image:
        requested.append(tuple(size))
        assert size[0] <= 1000 and size[1] <= 1000
        return original(self, size, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(Image.Image, "resize", recording)
    step = ResizeStep(strategy=ResizeStrategy.FILL, width=1000, height=1000)

    out = _open(RESIZE.apply(step, _png((4, 1000), 255, "L"), seed=NO_SEED, variant=0))

    assert out.size == (1000, 1000)
    assert requested == [(1000, 1000)]


def test_a_letterbox_that_leaves_no_pixels_on_one_side_is_refused() -> None:
    step = ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=32, height=32)
    assert letterbox_fit(1, 200, target_width=32, target_height=32).content_width == 0

    with pytest.raises(UnsupportedMedia):
        RESIZE.apply(step, _png((1, 200)), seed=NO_SEED, variant=0)


def test_a_palette_image_is_resized_as_true_colour() -> None:
    palette = Image.new("RGB", (40, 40), (200, 120, 60)).quantize(colors=4)
    buffer = io.BytesIO()
    palette.save(buffer, format="PNG")
    step = ResizeStep(strategy=ResizeStrategy.STRETCH, width=32, height=48)

    out = _open(RESIZE.apply(step, buffer.getvalue(), seed=NO_SEED, variant=0))

    assert out.size == (32, 48)
    assert out.mode == "RGB"


# --- orientation and re-encoding ---------------------------------------------


def test_the_exif_turn_is_applied_and_the_exif_dropped() -> None:
    """A 40×20 JPEG tagged 'rotate 90' is a 20×40 picture, which is what ingest measured."""
    exif = Image.Exif()
    exif[0x0112] = 6
    source = _jpeg((40, 20), exif=exif.tobytes())
    assert _open(source).size == (40, 20)
    step = ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=64, height=64, pad_value=0)

    out = _open(RESIZE.apply(step, source, seed=NO_SEED, variant=0))

    # Oriented, the picture is 20×40 and the letterbox pads the sides, not the
    # top; sampled away from the content edge, where JPEG ringing bleeds.
    fit = letterbox_fit(20, 40, target_width=64, target_height=64)
    assert (fit.offset_x, fit.offset_y) == (16, 0)
    assert max(out.getpixel((32, 32))) > 100
    assert max(out.getpixel((4, 32))) < 40
    assert out.getexif() == {}


def test_a_jpeg_comes_back_a_jpeg_with_its_subsampling_kept() -> None:
    from PIL.JpegImagePlugin import get_sampling

    step = ResizeStep(strategy=ResizeStrategy.STRETCH, width=32, height=32)
    for sampling in (0, 2):
        out = _open(
            RESIZE.apply(step, _jpeg((40, 40), subsampling=sampling), seed=NO_SEED, variant=0)
        )
        assert out.format == "JPEG"
        assert get_sampling(out) == sampling


def test_a_png_comes_back_a_lossless_png() -> None:
    step = ResizeStep(strategy=ResizeStrategy.STRETCH, width=32, height=32)
    out = _open(RESIZE.apply(step, _png((32, 32), (10, 20, 30)), seed=NO_SEED, variant=0))

    assert out.format == "PNG"
    assert out.getpixel((5, 5)) == (10, 20, 30)


def test_any_other_encoding_comes_back_a_png() -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (40, 40), (1, 2, 3)).save(buffer, format="BMP")
    step = ResizeStep(strategy=ResizeStrategy.STRETCH, width=32, height=32)

    data = RESIZE.apply(step, buffer.getvalue(), seed=NO_SEED, variant=0)

    assert _open(data).format == "PNG"
    assert media_type(data) == "image/png"
    assert media_type(_jpeg((8, 8))) == "image/jpeg"


# --- augmentation: draws come from the kernel ---------------------------------


def test_variant_zero_is_the_base_image_re_encoded() -> None:
    source = _marked((40, 30), (3, 7))
    step = AugmentStep(op=AugmentOp.ROT90)

    out = _open(AUGMENT.apply(step, source, seed=NO_SEED, variant=0))

    assert out.size == (40, 30)
    assert _white_pixels(out) == {(3, 7)}


@pytest.mark.parametrize("k", [1, 2, 3])
def test_hflip_mirrors_every_variant_whatever_the_seed(k: int) -> None:
    step = AugmentStep(op=AugmentOp.HFLIP)
    source = _marked((40, 30), (3, 7))

    seed = variant_seed("recipe", "content", k)

    data = AUGMENT.apply(step, source, seed=seed, variant=k)

    assert data != source
    assert _white_pixels(_open(data)) == {(40 - 1 - 3, 7)}


@pytest.mark.parametrize("turns", [1, 2, 3])
def test_rot90_turns_counter_clockwise_the_number_of_times_the_kernel_drew(turns: int) -> None:
    """``(x, y)`` lands at ``(y, W - 1 - x)`` per turn, the kernel's ``_rotated_once`` on pixels."""
    step = AugmentStep(op=AugmentOp.ROT90)
    seed = _seed_where(lambda seed: rot90_quarter_turns(seed) == turns)
    width, height, marker = 40, 30, (3, 7)

    out = _open(AUGMENT.apply(step, _marked((width, height), marker), seed=seed, variant=1))

    expected = marker
    size = (width, height)
    for _ in range(turns):
        expected = (expected[1], size[0] - 1 - expected[0])
        size = (size[1], size[0])
    assert out.size == size
    assert _white_pixels(out) == {expected}


def test_brightness_contrast_scales_a_flat_image_by_the_kernels_brightness_factor() -> None:
    """A flat image has no contrast to change, so the pixel reads the brightness factor alone."""
    step = AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.3)
    seed = variant_seed("recipe", "content", 1)
    brightness, _ = brightness_contrast_factors(seed, 0.3)

    out = _open(AUGMENT.apply(step, _png((16, 16), 100, "L"), seed=seed, variant=1))

    assert out.getpixel((8, 8)) == pytest.approx(100 * brightness, abs=1)


# --- determinism, within one environment --------------------------------------


@pytest.mark.parametrize("op", list(AugmentOp))
def test_the_same_seed_gives_identical_bytes(op: AugmentOp) -> None:
    step = AugmentStep(op=op)
    seed = variant_seed("recipe", "content", 2)
    source = _jpeg((48, 36))

    first = AUGMENT.apply(step, source, seed=seed, variant=2)
    second = AUGMENT.apply(step, source, seed=seed, variant=2)

    assert first == second


def test_resize_is_the_same_bytes_whatever_the_seed_or_variant() -> None:
    step = ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=64, height=48)
    source = _jpeg((48, 36))

    base = RESIZE.apply(step, source, seed=NO_SEED, variant=0)
    variant = RESIZE.apply(step, source, seed=variant_seed("r", "c", 3), variant=3)

    assert base == variant


def test_different_seeds_draw_different_brightness() -> None:
    step = AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST)
    source = _png((16, 16), 100, "L")
    outputs = {
        AUGMENT.apply(step, source, seed=variant_seed("recipe", "content", k), variant=k)
        for k in range(1, 5)
    }

    assert len(outputs) > 1


@pytest.mark.parametrize("op", list(AugmentOp))
def test_the_showcase_seed_changes_the_source_and_is_deterministic(op: AugmentOp) -> None:
    step = AugmentStep(op=op, amount=0.3)
    source = (
        _marked((40, 30), (3, 7))
        if op is not AugmentOp.BRIGHTNESS_CONTRAST
        else _png((16, 16), 100, "L")
    )

    first = AUGMENT.apply(step, source, seed=SHOWCASE_SEED, variant=1)
    second = AUGMENT.apply(step, source, seed=SHOWCASE_SEED, variant=1)

    assert first != source
    assert first == second


def test_a_showcase_rot90_turns_once_and_brightness_uses_the_full_amount() -> None:
    turned = _open(
        AUGMENT.apply(
            AugmentStep(op=AugmentOp.ROT90),
            _marked((40, 30), (3, 7)),
            seed=SHOWCASE_SEED,
            variant=1,
        )
    )
    assert turned.size == (30, 40)
    assert _white_pixels(turned) == {(7, 40 - 1 - 3)}

    bright = _open(
        AUGMENT.apply(
            AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.3),
            _png((16, 16), 100, "L"),
            seed=SHOWCASE_SEED,
            variant=1,
        )
    )
    assert bright.getpixel((8, 8)) == pytest.approx(130, abs=1)
