# usage: from visionset.kernel.domain import RecipeSpec, recipe_hash, variant_seed
"""Pre-processing recipes: resize and augmentation, declared and hashed.

A recipe is a value, not a process: :class:`RecipeSpec` says what an export
does to every image, and :func:`recipe_hash` names that value the way
``canonical_bytes`` names a manifest — so two exports carrying the same spec
carry the same hash whatever order the fields were written in.

Everything random about a variant is derived, never drawn: :func:`variant_seed`
turns ``(recipe, image, k)`` into a digest, and the three draw functions read
fixed positions of that digest. The geometry transform and the pixel driver
read the same positions, which is what keeps a variant's annotations on its
pixels. Byte stability is promised within one environment only; the geometry
arithmetic here is exact everywhere.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from visionset.kernel.domain.export_target import ResizeStrategy
from visionset.kernel.domain.release import canonical_bytes, sha256_hex


class ResizeStep(BaseModel):
    """Bring every exported image to one size, by one strategy.

    ``pad_value`` is the grey a letterbox pads with — 114 is the value YOLO
    trainers letterbox with themselves — and is ignored by ``stretch``, which
    has nothing to pad.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["resize"] = "resize"
    strategy: ResizeStrategy
    width: int = Field(ge=32, le=8192)
    height: int = Field(ge=32, le=8192)
    pad_value: int = Field(default=114, ge=0, le=255)


class AugmentOp(StrEnum):
    """An augmentation a recipe can apply when generating variants."""

    HFLIP = "hflip"
    BRIGHTNESS_CONTRAST = "brightness_contrast"
    ROT90 = "rot90"


class AugmentStep(BaseModel):
    """One augmentation in a recipe.

    ``amount`` bounds the brightness and contrast factors — each is drawn
    uniformly from ``[1 - amount, 1 + amount]`` — and means nothing to
    ``hflip`` or ``rot90``, whose draws have no magnitude.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["augment"] = "augment"
    op: AugmentOp
    amount: float = Field(default=0.2, gt=0, le=0.5)


Step = Annotated[ResizeStep | AugmentStep, Field(discriminator="kind")]
"""Every step a recipe can hold, discriminated the way ``Geometry`` is."""


class RecipeSpec(BaseModel):
    """The value an export snapshots: the steps, and how many variants they make.

    ``target`` records which export target's hints the recipe was written from
    and is informational — nothing resolves it, and a recipe applies to any
    export. ``variants_per_asset`` counts *augmented* outputs: variant 0 is the
    base image and always exists, variants 1..n exist only when augmentation
    does, which is what the cross-field rules below hold in both directions.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    target: str | None
    steps: tuple[Step, ...]
    variants_per_asset: int = Field(default=0, ge=0, le=8)

    @model_validator(mode="after")
    def _steps_and_variants_agree(self) -> RecipeSpec:
        resize_positions = [
            index for index, step in enumerate(self.steps) if isinstance(step, ResizeStep)
        ]
        if len(resize_positions) > 1:
            raise ValueError("a recipe holds at most one resize step")
        if resize_positions and resize_positions[0] != 0:
            raise ValueError("a resize step comes before every augmentation step")
        ops = [step.op for step in self.steps if isinstance(step, AugmentStep)]
        if len(set(ops)) != len(ops):
            raise ValueError("a recipe applies each augmentation at most once")
        if ops and self.variants_per_asset < 1:
            raise ValueError(
                "augmentation steps with variants_per_asset 0 would never run; "
                "ask for at least one variant or drop the steps"
            )
        if self.variants_per_asset >= 1 and not ops:
            raise ValueError(
                "variants_per_asset asks for augmented outputs and no augmentation "
                "step says what they are; add one or set it to 0"
            )
        return self


class PreprocessingRecipe(BaseModel):
    """A stored, named recipe: project resource around a :class:`RecipeSpec`.

    The spec is what an export snapshots by value; the wrapper is what a
    project lists and edits. Editing or deleting one never alters a past
    export, because the export kept the spec, not the name.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    name: str
    spec: RecipeSpec
    created_at: datetime
    updated_at: datetime


def recipe_hash(spec: RecipeSpec) -> str:
    """The one name of a spec's content, over its canonical bytes.

    The same encoder and digest the manifest uses, so key order, construction
    path and whitespace cannot make two equal specs hash apart.
    """
    return sha256_hex(canonical_bytes(spec))


def variant_seed(recipe_hash: str, content_hash: str, k: int) -> bytes:
    """The digest every draw for variant ``k`` of one image reads from.

    ``sha256(f"{recipe_hash}:{content_hash}:{k}")`` — the recipe, the image and
    the variant index, nothing else, so the same recipe over the same bytes
    draws the same variant on any machine. Variant 0 is the base image and
    never draws; variants are ``1..n``.
    """
    return hashlib.sha256(f"{recipe_hash}:{content_hash}:{k}".encode()).digest()


def hflip_applied(seed: bytes) -> bool:
    """Whether this variant mirrors, read off bit 0 of the seed."""
    return bool(seed[0] & 1)


def brightness_contrast_factors(seed: bytes, amount: float) -> tuple[float, float]:
    """This variant's brightness and contrast factors, in ``[1 - amount, 1 + amount]``.

    Brightness reads word 1 of the seed and contrast word 2 — fixed positions,
    whatever other steps the recipe holds, so adding a step never re-rolls the
    others.
    """
    return (
        1.0 - amount + 2.0 * amount * _fraction(seed, 1),
        1.0 - amount + 2.0 * amount * _fraction(seed, 2),
    )


def rot90_quarter_turns(seed: bytes) -> int:
    """How many counter-clockwise quarter turns this variant rotates: 1, 2 or 3.

    Never 0 — a rot90 step that drew no rotation would emit the base image
    under a variant's name. Reads word 3 of the seed.
    """
    return 1 + _word(seed, 3) % 3


def _word(seed: bytes, index: int) -> int:
    return int.from_bytes(seed[4 * index : 4 * index + 4], "big")


def _fraction(seed: bytes, index: int) -> float:
    return _word(seed, index) / 0xFFFFFFFF
