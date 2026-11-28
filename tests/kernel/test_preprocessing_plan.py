"""A variant's plan: sampled from its key alone, legacy draws kept, step streams independent."""

from __future__ import annotations

import pytest

from visionset.kernel.domain import (
    SHOWCASE_SEED,
    AugmentOp,
    AugmentStep,
    BrightnessContrastDraw,
    HflipDraw,
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    Rot90Draw,
    StepStream,
    VariantPlan,
    brightness_contrast_factors,
    recipe_hash,
    rot90_quarter_turns,
    sample_plan,
    sample_step,
    step_stream,
    variant_seed,
)

HFLIP = AugmentStep(op=AugmentOp.HFLIP)
BC = AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.3)
ROT90 = AugmentStep(op=AugmentOp.ROT90)
SPEC = RecipeSpec(
    target=None,
    steps=(ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=64, height=64), HFLIP, BC, ROT90),
    variants_per_asset=8,
)
CONTENT = "ab" * 32


def test_the_same_key_samples_the_same_plan() -> None:
    first = sample_plan(SPEC, content_hash=CONTENT, variant=3)
    again = sample_plan(SPEC, content_hash=CONTENT, variant=3, spec_hash=recipe_hash(SPEC))
    assert first == again
    assert first.recipe_hash == recipe_hash(SPEC)


def test_a_plan_holds_one_draw_per_augmentation_in_recipe_order() -> None:
    plan = sample_plan(SPEC, content_hash=CONTENT, variant=1)
    assert [type(draw) for draw in plan.draws] == [HflipDraw, BrightnessContrastDraw, Rot90Draw]


def test_the_variants_of_one_image_draw_apart() -> None:
    plans = [sample_plan(SPEC, content_hash=CONTENT, variant=k) for k in range(1, 9)]
    assert len({plan.model_dump_json(exclude={"variant"}) for plan in plans}) == 8


def test_two_images_draw_apart() -> None:
    one = sample_plan(SPEC, content_hash=CONTENT, variant=1)
    other = sample_plan(SPEC, content_hash="cd" * 32, variant=1)
    assert one.draws != other.draws


@pytest.mark.parametrize("variant", range(1, 9))
def test_a_plan_draws_exactly_what_the_seed_words_drew(variant: int) -> None:
    seed = variant_seed(recipe_hash(SPEC), CONTENT, variant)
    plan = sample_plan(SPEC, content_hash=CONTENT, variant=variant)
    assert plan.seed() == seed
    brightness, contrast = brightness_contrast_factors(seed, BC.amount)
    assert plan.draw_for(BC) == BrightnessContrastDraw(brightness=brightness, contrast=contrast)
    assert plan.draw_for(ROT90) == Rot90Draw(quarter_turns=rot90_quarter_turns(seed))
    assert plan.draw_for(HFLIP) == HflipDraw()


def test_a_showcase_plan_is_every_step_at_its_declared_strength() -> None:
    plan = sample_plan(SPEC, content_hash=CONTENT, variant=2, showcase=True)
    assert plan.showcase
    assert plan.seed() == SHOWCASE_SEED
    assert plan.draw_for(BC) == BrightnessContrastDraw(brightness=1.3, contrast=1.3)
    assert plan.draw_for(ROT90) == Rot90Draw(quarter_turns=1)


def test_the_base_image_has_no_plan() -> None:
    with pytest.raises(ValueError, match="variant 0 is the base image"):
        sample_plan(SPEC, content_hash=CONTENT, variant=0)


def test_a_plan_without_a_steps_draw_says_so() -> None:
    only_flip = RecipeSpec(target=None, steps=(HFLIP,), variants_per_asset=1)
    plan = sample_plan(only_flip, content_hash=CONTENT, variant=1)
    with pytest.raises(ValueError, match="no draw for rot90 version 1"):
        plan.draw_for(ROT90)


def test_a_plan_round_trips_through_its_serialization() -> None:
    for showcase in (False, True):
        plan = sample_plan(SPEC, content_hash=CONTENT, variant=5, showcase=showcase)
        assert VariantPlan.model_validate_json(plan.model_dump_json()) == plan


@pytest.mark.parametrize(
    "steps",
    [(BC,), (HFLIP, BC), (BC, ROT90, HFLIP), (ROT90, HFLIP)],
    ids=["alone", "after", "first", "without"],
)
def test_a_steps_draw_depends_on_the_step_and_the_seed_alone(
    steps: tuple[AugmentStep, ...],
) -> None:
    spec = RecipeSpec(target=None, steps=steps, variants_per_asset=2)
    plan = sample_plan(spec, content_hash=CONTENT, variant=2)
    for step in steps:
        assert plan.draw_for(step) == sample_step(step, plan.seed())


# --- step streams ---------------------------------------------------------------


SEED = variant_seed("recipe", CONTENT, 1)


def test_a_stream_is_a_pure_function_of_seed_op_and_version() -> None:
    first = StepStream.of(SEED, "blur", 1)
    assert [first.word(i) for i in range(20)] == [
        StepStream.of(SEED, "blur", 1).word(i) for i in range(20)
    ]
    assert step_stream(SEED, BC) == StepStream.of(SEED, "brightness_contrast", 1)


@pytest.mark.parametrize(
    "other",
    [
        StepStream.of(SEED, "noise", 1),
        StepStream.of(SEED, "blur", 2),
        StepStream.of(variant_seed("recipe", CONTENT, 2), "blur", 1),
    ],
    ids=["op", "version", "seed"],
)
def test_streams_of_different_steps_or_variants_are_independent(other: StepStream) -> None:
    blur = StepStream.of(SEED, "blur", 1)
    assert [blur.word(i) for i in range(16)] != [other.word(i) for i in range(16)]


def test_a_stream_never_reads_the_legacy_seed_words() -> None:
    stream = step_stream(SEED, BC)
    legacy = {int.from_bytes(SEED[4 * i : 4 * i + 4], "big") for i in range(8)}
    assert legacy.isdisjoint(stream.word(i) for i in range(64))


def test_stream_words_are_addressed_by_position_across_block_boundaries() -> None:
    stream = StepStream.of(SEED, "blur", 1)
    words = [stream.word(i) for i in range(24)]
    assert len(set(words)) == 24
    assert all(0 <= word < 2**32 for word in words)
    assert [stream.word(i) for i in reversed(range(24))] == list(reversed(words))
    assert 0.0 <= stream.fraction(9) <= 1.0
    assert 2.0 <= stream.uniform(9, 2.0, 5.0) <= 5.0
    with pytest.raises(ValueError, match="never negative"):
        stream.word(-1)
