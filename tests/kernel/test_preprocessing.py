"""The recipe domain: what a spec may say, how it is named, and how variants draw."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import (
    AugmentOp,
    AugmentStep,
    PreprocessingRecipe,
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    brightness_contrast_factors,
    hflip_applied,
    recipe_hash,
    rot90_quarter_turns,
    variant_seed,
)

RESIZE = ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=640, height=640)
HFLIP = AugmentStep(op=AugmentOp.HFLIP)
ROT90 = AugmentStep(op=AugmentOp.ROT90)


def test_a_spec_with_a_resize_then_augmentations_is_accepted() -> None:
    spec = RecipeSpec(target="yolo11", steps=(RESIZE, HFLIP, ROT90), variants_per_asset=2)
    assert [step.kind for step in spec.steps] == ["resize", "augment", "augment"]


def test_a_spec_may_hold_no_steps_at_all() -> None:
    assert RecipeSpec(target=None, steps=()).variants_per_asset == 0


def test_a_resize_step_must_come_first() -> None:
    with pytest.raises(ValidationError, match="comes before"):
        RecipeSpec(target=None, steps=(HFLIP, RESIZE), variants_per_asset=1)


def test_at_most_one_resize_step() -> None:
    with pytest.raises(ValidationError, match="at most one resize"):
        RecipeSpec(target=None, steps=(RESIZE, RESIZE))


def test_augmentation_steps_require_at_least_one_variant() -> None:
    with pytest.raises(ValidationError, match="variants_per_asset 0"):
        RecipeSpec(target=None, steps=(HFLIP,), variants_per_asset=0)


def test_variants_require_at_least_one_augmentation_step() -> None:
    with pytest.raises(ValidationError, match="no augmentation step"):
        RecipeSpec(target=None, steps=(RESIZE,), variants_per_asset=1)


def test_an_augmentation_is_applied_at_most_once() -> None:
    with pytest.raises(ValidationError, match="at most once"):
        RecipeSpec(target=None, steps=(HFLIP, HFLIP), variants_per_asset=1)


@pytest.mark.parametrize("field", ["width", "height"])
@pytest.mark.parametrize("value", [31, 8193])
def test_a_resize_size_stays_within_bounds(field: str, value: int) -> None:
    with pytest.raises(ValidationError):
        ResizeStep.model_validate({"strategy": "stretch", "width": 64, "height": 64, field: value})


@pytest.mark.parametrize("value", [-1, 256])
def test_a_pad_value_is_one_byte(value: int) -> None:
    with pytest.raises(ValidationError):
        ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=64, height=64, pad_value=value)


@pytest.mark.parametrize("value", [0.0, 0.51])
def test_an_amount_is_strictly_positive_and_at_most_a_half(value: float) -> None:
    with pytest.raises(ValidationError):
        AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=value)


def test_a_step_refuses_a_field_it_does_not_declare() -> None:
    with pytest.raises(ValidationError):
        AugmentStep.model_validate({"op": "hflip", "probability": 0.5})


def test_a_spec_discriminates_steps_on_kind() -> None:
    spec = RecipeSpec.model_validate(
        {
            "target": None,
            "steps": [
                {"kind": "resize", "strategy": "stretch", "width": 320, "height": 240},
                {"kind": "augment", "op": "rot90"},
            ],
            "variants_per_asset": 1,
        }
    )
    assert isinstance(spec.steps[0], ResizeStep)
    assert isinstance(spec.steps[1], AugmentStep)


def test_a_recipe_wraps_a_spec_with_its_identity() -> None:
    now = datetime.now(UTC)
    recipe = PreprocessingRecipe(
        id="r1",
        project_id="p1",
        name="yolo-640",
        spec=RecipeSpec(target="yolo11", steps=(RESIZE,)),
        created_at=now,
        updated_at=now,
    )
    assert recipe.spec.steps == (RESIZE,)


# --- the hash ---------------------------------------------------------------


def test_the_hash_does_not_depend_on_key_order() -> None:
    forward = RecipeSpec.model_validate(
        {
            "target": "yolo11",
            "steps": [
                {"kind": "resize", "strategy": "letterbox", "width": 640, "height": 640},
                {"kind": "augment", "op": "hflip"},
            ],
            "variants_per_asset": 2,
        }
    )
    backward = RecipeSpec.model_validate(
        {
            "variants_per_asset": 2,
            "steps": [
                {"height": 640, "width": 640, "strategy": "letterbox", "kind": "resize"},
                {"op": "hflip", "kind": "augment"},
            ],
            "target": "yolo11",
        }
    )
    assert recipe_hash(forward) == recipe_hash(backward)


def test_the_hash_does_not_depend_on_whether_a_default_was_spelled_out() -> None:
    spelled = RecipeSpec(
        target=None, steps=(AugmentStep(op=AugmentOp.HFLIP, amount=0.2),), variants_per_asset=1
    )
    implied = RecipeSpec(target=None, steps=(HFLIP,), variants_per_asset=1)
    assert recipe_hash(spelled) == recipe_hash(implied)


def test_the_hash_is_a_sha256_hex_digest_that_moves_with_the_content() -> None:
    one = recipe_hash(RecipeSpec(target=None, steps=(RESIZE,)))
    other = recipe_hash(
        RecipeSpec(target=None, steps=(RESIZE.model_copy(update={"pad_value": 0}),))
    )
    assert len(one) == 64 and int(one, 16) >= 0
    assert one != other


# --- the draws --------------------------------------------------------------


def test_a_variant_seed_is_deterministic_and_distinct_per_variant_and_image() -> None:
    seed = variant_seed("recipe", "image", 1)
    assert seed == variant_seed("recipe", "image", 1)
    assert len(seed) == 32
    assert seed != variant_seed("recipe", "image", 2)
    assert seed != variant_seed("recipe", "other", 1)
    assert seed != variant_seed("other", "image", 1)


def test_hflip_reads_bit_zero_of_the_seed() -> None:
    assert hflip_applied(bytes([0x01]) + bytes(31)) is True
    assert hflip_applied(bytes([0xFE]) + bytes(31)) is False


def test_brightness_and_contrast_read_words_one_and_two() -> None:
    lowest = bytes(4) + bytes(4) + bytes(4) + bytes(20)
    highest = bytes(4) + bytes([0xFF] * 4) + bytes([0xFF] * 4) + bytes(20)
    assert brightness_contrast_factors(lowest, 0.2) == pytest.approx((0.8, 0.8))
    assert brightness_contrast_factors(highest, 0.2) == pytest.approx((1.2, 1.2))
    mixed = bytes(4) + bytes(4) + bytes([0xFF] * 4) + bytes(20)
    assert brightness_contrast_factors(mixed, 0.5) == pytest.approx((0.5, 1.5))


def test_brightness_and_contrast_stay_within_the_amount() -> None:
    for k in range(1, 50):
        brightness, contrast = brightness_contrast_factors(variant_seed("r", "c", k), 0.3)
        assert 0.7 <= brightness <= 1.3
        assert 0.7 <= contrast <= 1.3


def test_rot90_reads_word_three_and_never_draws_zero_turns() -> None:
    for remainder in range(3):
        seed = bytes(12) + remainder.to_bytes(4, "big") + bytes(16)
        assert rot90_quarter_turns(seed) == 1 + remainder
    assert {rot90_quarter_turns(variant_seed("r", "c", k)) for k in range(1, 60)} <= {1, 2, 3}
