"""Both sides of the export seam read one plan: the geometry transform and the pixel driver."""

from __future__ import annotations

import io
from uuid import uuid4

import pytest
from PIL import Image

from visionset.kernel.domain import (
    AugmentOp,
    AugmentStep,
    BboxGeometry,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    RecipeSpec,
    Rot90Draw,
    SplitAssignment,
    Step,
    StepDraw,
    VariantPlan,
    augment_operations,
    preprocessing_transform,
    sample_plan,
    transform_manifest,
)
from visionset.kernel.ports import accepts_draw
from visionset.kernel.services.release_service import transformed_bytes
from visionset.preprocessing.pillow import PillowAugmentDriver, PillowResizeDriver

AUGMENT = PillowAugmentDriver()
SPEC = RecipeSpec(
    target=None,
    steps=(
        AugmentStep(op=AugmentOp.ROT90),
        AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.4),
        AugmentStep(op=AugmentOp.HFLIP),
    ),
    variants_per_asset=4,
)
CONTENT = "5a" * 32


def _png(width: int, height: int) -> bytes:
    image = Image.new("RGB", (width, height))
    image.putdata(
        [((x * 9) % 256, (y * 13) % 256, 90) for y in range(height) for x in range(width)]
    )
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class _Recording:
    """An augment driver that records the draw it was handed, then defers to Pillow."""

    step_kinds = frozenset({"augment"})

    def __init__(self) -> None:
        self.draws: list[StepDraw | None] = []

    def apply(
        self, step: Step, image: bytes, *, seed: bytes, variant: int, draw: StepDraw | None = None
    ) -> bytes:
        self.draws.append(draw)
        return AUGMENT.apply(step, image, seed=seed, variant=variant, draw=draw)


class _Legacy:
    """A driver written against the port before plans: no ``draw`` keyword."""

    step_kinds = frozenset({"augment"})

    def __init__(self) -> None:
        self.calls = 0

    def apply(self, step: Step, image: bytes, *, seed: bytes, variant: int) -> bytes:
        self.calls += 1
        return AUGMENT.apply(step, image, seed=seed, variant=variant)


def test_the_geometry_and_the_pixels_read_the_same_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    sampled: list[VariantPlan] = []

    def recording_sample_plan(*args: object, **kwargs: object) -> VariantPlan:
        plan = sample_plan(*args, **kwargs)  # type: ignore[arg-type]
        sampled.append(plan)
        return plan

    monkeypatch.setattr(preprocessing_transform, "sample_plan", recording_sample_plan)
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash=CONTENT,
        uri="/a.png",
        width=40,
        height=30,
        annotations=(
            ManifestAnnotation(
                id=uuid4(),
                label_class="thing",
                schema_version=1,
                geometry=BboxGeometry(x=1.0, y=2.0, width=5.0, height=6.0),
                provenance="human",
            ),
        ),
    )
    view = transform_manifest(
        Manifest(schema_version=1, assets=(asset,)),
        SPEC,
        SplitAssignment(train=(asset.asset_id,)),
    )
    source = _png(40, 30)
    recording = _Recording()
    for plan, file in zip(sampled, view.files[1:], strict=True):
        assert plan.variant == file.variant
        recording.draws.clear()
        image = transformed_bytes(
            SPEC, {"augment": recording}, source, content_hash=CONTENT, variant=plan.variant
        )
        assert tuple(recording.draws) == plan.draws
        (turns,) = [draw.quarter_turns for draw in plan.draws if isinstance(draw, Rot90Draw)]
        expected = (40, 30) if turns % 2 == 0 else (30, 40)
        assert (file.width, file.height) == expected
        with Image.open(io.BytesIO(image)) as written:
            assert written.size == expected


def test_the_driver_applies_the_draw_it_is_handed_not_one_of_its_own() -> None:
    step = AugmentStep(op=AugmentOp.ROT90)
    source = _png(40, 30)
    unrelated_seed = b"\x00" * 32
    for turns in (1, 2, 3):
        handed = AUGMENT.apply(
            step, source, seed=unrelated_seed, variant=1, draw=Rot90Draw(quarter_turns=turns)
        )
        with Image.open(io.BytesIO(handed)) as written:
            assert written.size == ((30, 40) if turns % 2 else (40, 30))
    sampled_turns = AUGMENT.apply(step, source, seed=unrelated_seed, variant=1)
    from_plan = AUGMENT.apply(
        step,
        source,
        seed=unrelated_seed,
        variant=1,
        draw=Rot90Draw(quarter_turns=1 + int.from_bytes(unrelated_seed[12:16], "big") % 3),
    )
    assert sampled_turns == from_plan


def test_a_draw_for_another_op_is_refused() -> None:
    with pytest.raises(ValueError, match="rot90 v1 draw cannot apply a hflip v1 step"):
        AUGMENT.apply(
            AugmentStep(op=AugmentOp.HFLIP),
            _png(8, 8),
            seed=b"\x00" * 32,
            variant=1,
            draw=Rot90Draw(quarter_turns=1),
        )


def test_a_driver_without_the_draw_keyword_is_still_called_and_agrees() -> None:
    legacy = _Legacy()
    assert not accepts_draw(legacy)
    assert accepts_draw(AUGMENT) and accepts_draw(PillowResizeDriver())
    source = _png(40, 30)
    for k in range(SPEC.variants_per_asset + 1):
        expected = transformed_bytes(
            SPEC, {"augment": AUGMENT}, source, content_hash=CONTENT, variant=k
        )
        assert (
            transformed_bytes(SPEC, {"augment": legacy}, source, content_hash=CONTENT, variant=k)
            == expected
        )
    assert legacy.calls == 3 * SPEC.variants_per_asset


def test_the_builtin_driver_applies_exactly_what_the_registry_says_it_does() -> None:
    declared = {
        (operation.op, operation.version)
        for operation in augment_operations()
        if "pillow" in operation.drivers
    }
    assert declared == PillowAugmentDriver.operations
