# usage: from visionset.kernel.domain import VariantPlan, sample_plan, sample_step
"""One variant's draws, sampled once and read by both sides of the export seam.

A :class:`VariantPlan` is everything random about variant ``k`` of one image
under one recipe: a :data:`StepDraw` per augmentation step, in recipe order.
It is a value — a function of ``(recipe, content hash, k)`` and nothing else —
so the geometry transform and the pixel driver read the same plan whether it
was sampled once and handed to both or sampled on each side: there is nothing
else it could be. A preview shows one, and a per-output provenance record can
serialize one.

The legacy operations keep reading the fixed words of the variant seed they
always read — brightness word 1, contrast word 2, rot90 word 3 — so every
plan draws exactly what the seed-reading functions in
:mod:`~visionset.kernel.domain.preprocessing` drew before plans existed. An
operation registered after them reads its own :class:`StepStream` instead,
derived from the seed and the step's ``(op, version)`` under a domain tag, so
under one variant seed a step's draw never depends on which other steps the
recipe holds. (The seed itself digests the recipe hash, so changing the steps
changes every seed, as it always has.)
Nothing here keeps state, reads a clock or touches a global random source.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Annotated, Final, Literal, assert_never

from pydantic import BaseModel, ConfigDict, Field

from visionset.kernel.domain.preprocessing import (
    SHOWCASE_SEED,
    AugmentOp,
    AugmentStep,
    RecipeSpec,
    brightness_contrast_factors,
    recipe_hash,
    rot90_quarter_turns,
    variant_seed,
)

STEP_STREAM_DOMAIN: Final = b"visionset:augment:step-stream:1\x00"
"""The tag every step stream's key is digested under, apart from every other digest here."""


class HflipDraw(BaseModel):
    """``hflip`` draws nothing: every variant mirrors."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    op: Literal[AugmentOp.HFLIP] = AugmentOp.HFLIP
    version: int = Field(default=1, ge=1)


class BrightnessContrastDraw(BaseModel):
    """The two enhancement factors, brightness applied before contrast."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    op: Literal[AugmentOp.BRIGHTNESS_CONTRAST] = AugmentOp.BRIGHTNESS_CONTRAST
    version: int = Field(default=1, ge=1)
    brightness: float
    contrast: float


class Rot90Draw(BaseModel):
    """How many counter-clockwise quarter turns: never 0, which would be the base image."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    op: Literal[AugmentOp.ROT90] = AugmentOp.ROT90
    version: int = Field(default=1, ge=1)
    quarter_turns: int = Field(ge=1, le=3)


StepDraw = Annotated[HflipDraw | BrightnessContrastDraw | Rot90Draw, Field(discriminator="op")]
"""What one augmentation step drew for one variant, discriminated by ``op``."""


class VariantPlan(BaseModel):
    """Every draw of variant ``variant`` of one image under one recipe.

    ``draws`` holds one entry per augmentation step, in the recipe's order.
    ``showcase`` says the draws are each step at its declared strength — a
    preview's plan — rather than seeded ones; an export's plans never set it.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    recipe_hash: str
    content_hash: str
    variant: int = Field(ge=1)
    showcase: bool = False
    draws: tuple[StepDraw, ...]

    def seed(self) -> bytes:
        """The digest this plan was sampled from: the variant seed, or :data:`SHOWCASE_SEED`."""
        if self.showcase:
            return SHOWCASE_SEED
        return variant_seed(self.recipe_hash, self.content_hash, self.variant)

    def draw_for(self, step: AugmentStep) -> StepDraw:
        """The draw for one of the recipe's augmentation steps.

        Raises:
            ValueError: the plan holds no draw for that step's op and version.
        """
        for draw in self.draws:
            if draw.op is step.op and draw.version == step.version:
                return draw
        raise ValueError(f"this plan holds no draw for {step.op.value} version {step.version}")


@dataclass(frozen=True)
class StepStream:
    """An unbounded, index-addressed sequence of 32-bit words for one step of one variant.

    Word ``i`` is word ``i % 8`` of ``sha256(key || i // 8)``, where ``key`` is
    ``sha256(STEP_STREAM_DOMAIN || op || 0 || version || 0 || seed)``. Reading
    is by position, never by cursor, so a parameter's draw stays at the word it
    was given whatever else the operation reads.
    """

    key: bytes = field(repr=False)

    @classmethod
    def of(cls, seed: bytes, op: str, version: int) -> StepStream:
        """The stream of the step ``(op, version)`` under one variant seed."""
        material = b"\x00".join((op.encode(), str(version).encode(), seed))
        return cls(key=hashlib.sha256(STEP_STREAM_DOMAIN + material).digest())

    def word(self, index: int) -> int:
        """Word ``index`` of the stream, in ``[0, 2**32)``."""
        if index < 0:
            raise ValueError(f"a stream word index is never negative, not {index}")
        block = hashlib.sha256(self.key + (index // 8).to_bytes(8, "big")).digest()
        offset = 4 * (index % 8)
        return int.from_bytes(block[offset : offset + 4], "big")

    def fraction(self, index: int) -> float:
        """Word ``index`` as a fraction in ``[0, 1]``, the legacy draws' scaling."""
        return self.word(index) / 0xFFFFFFFF

    def uniform(self, index: int, low: float, high: float) -> float:
        """A value in ``[low, high]`` read from word ``index``."""
        return low + (high - low) * self.fraction(index)


def step_stream(seed: bytes, step: AugmentStep) -> StepStream:
    """The independent stream an operation registered after the legacy three draws from.

    A sampler for such an operation must answer :data:`SHOWCASE_SEED` with its
    declared strength before it reads the stream, as the legacy draws do.
    """
    return StepStream.of(seed, step.op.value, step.version)


def sample_step(step: AugmentStep, seed: bytes) -> StepDraw:
    """What one augmentation step draws from one variant seed."""
    match step.op:
        case AugmentOp.HFLIP:
            return HflipDraw(version=step.version)
        case AugmentOp.BRIGHTNESS_CONTRAST:
            brightness, contrast = brightness_contrast_factors(seed, step.amount)
            return BrightnessContrastDraw(
                version=step.version, brightness=brightness, contrast=contrast
            )
        case AugmentOp.ROT90:
            return Rot90Draw(version=step.version, quarter_turns=rot90_quarter_turns(seed))
        case _:
            assert_never(step.op)


def sample_plan(
    spec: RecipeSpec,
    *,
    content_hash: str,
    variant: int,
    showcase: bool = False,
    spec_hash: str | None = None,
) -> VariantPlan:
    """The plan of augmented variant ``variant`` (``1..n``) of one image.

    ``spec_hash`` is ``recipe_hash(spec)`` for a caller sampling many variants
    of one spec, which saves re-encoding it per variant; it is computed when
    omitted. Variant 0 is the base image, which draws nothing and has no plan.

    Raises:
        ValueError: ``variant`` is below 1.
    """
    if variant < 1:
        raise ValueError(f"variant 0 is the base image and has no plan, and {variant} is below it")
    plan_hash = recipe_hash(spec) if spec_hash is None else spec_hash
    seed = SHOWCASE_SEED if showcase else variant_seed(plan_hash, content_hash, variant)
    return VariantPlan(
        recipe_hash=plan_hash,
        content_hash=content_hash,
        variant=variant,
        showcase=showcase,
        draws=tuple(
            sample_step(step, seed) for step in spec.steps if isinstance(step, AugmentStep)
        ),
    )
