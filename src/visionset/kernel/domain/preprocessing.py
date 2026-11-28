# usage: from visionset.kernel.domain import RecipeSpec, recipe_hash, variant_seed
"""Pre-processing recipes: resize and augmentation, declared and hashed.

A recipe is a value, not a process: :class:`RecipeSpec` says what an export
does to every image, and :func:`recipe_hash` names that value the way
``canonical_bytes`` names a manifest — so two exports carrying the same spec
carry the same hash whatever order the fields were written in.

Everything random about a variant is derived, never drawn: :func:`variant_seed`
turns ``(recipe, image, k)`` into a digest, and the two draw functions read
fixed positions of that digest — ``hflip`` draws nothing, because a variant
that drew no mirror would be the base image under a variant's name. The
geometry transform and the pixel driver read the same positions, which is what
keeps a variant's annotations on its pixels. Byte stability is promised within
one environment only; the geometry arithmetic here is exact everywhere.

What each augmentation *is* lives in one registry, :data:`AUGMENT_OPERATIONS`:
an :class:`AugmentOperation` per ``(op, version)`` declaring its typed
parameters, the modalities, geometries and trainer tasks it can serve, what it
does to a label's meaning, whether it can lose a label, which built-in driver
applies it and whether a preview can show it. Nothing about an operation is
inferred from the code that happens to run it; a capability the registry does
not declare is one the operation does not have.

A preview that wants to *show* a step rather than one draw of it passes
:data:`SHOWCASE_SEED` where a variant seed goes: both draw functions answer it
with the step at its declared strength — one quarter turn, brightness and
contrast at ``1 + amount`` — through the same code path an export takes, so
nothing about the pixel or geometry side is special-cased for a screen.

Every step declares the geometries it can transform, the way an exporter
declares ``supported_geometries``: :data:`AUGMENT_GEOMETRIES` is the table per
augmentation and :data:`RESIZE_GEOMETRIES` the one per resize strategy, and
each step reads its row back as ``supported_geometries``. The
geometry transform refuses a manifest geometry outside that set, so a step's
reach is declared here once and never inferred from which branch of the
arithmetic happens to handle it.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Iterable, Mapping
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Final, Literal, TypeVar
from uuid import UUID, uuid4

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    ValidationInfo,
    field_validator,
    model_validator,
)

from visionset.kernel.domain.calibration import Modality
from visionset.kernel.domain.export_target import ResizeStrategy, Task
from visionset.kernel.domain.release import canonical_bytes, sha256_hex
from visionset.kernel.domain.schema import GeometryType

EVERY_GEOMETRY: Final[frozenset[GeometryType]] = frozenset(GeometryType)
"""What a step that leaves every coordinate where it is can carry."""

THREE_D: Final[frozenset[GeometryType]] = frozenset(
    {GeometryType.CUBOID_3D, GeometryType.POLYLINE_3D}
)
"""Geometries in the sensor frame, which no pixel-moving step can follow.

A resize changes the intrinsics a 3D label is read through and a mirror or a
quarter turn changes the frame's handedness or axes, so each would need a new
calibration per variant. Only a step that leaves the pixels' positions alone
keeps them.
"""

PIXEL_GEOMETRIES: Final[frozenset[GeometryType]] = EVERY_GEOMETRY - THREE_D
"""What a step that moves every pixel coordinate the same way can transform."""

SHOWCASE_SEED: Final = b"showcase"
"""The seed a preview passes to see a step at its declared strength.

Eight bytes where :func:`variant_seed` always digests thirty-two, so no
export can produce it by accident. Never written by an export.
"""


RESIZABLE_GEOMETRIES: Final[frozenset[GeometryType]] = PIXEL_GEOMETRIES - {GeometryType.MASK}
"""What a resize can transform at all: a mask would have to be resampled, which loses pixels."""

_UNCROPPABLE: Final = frozenset({GeometryType.POLYLINE, GeometryType.OBB, GeometryType.KEYPOINTS})

RESIZE_GEOMETRIES: Final[Mapping[ResizeStrategy, frozenset[GeometryType]]] = {
    # Scaling the axes apart turns a rotated rectangle into a parallelogram.
    ResizeStrategy.STRETCH: RESIZABLE_GEOMETRIES - {GeometryType.OBB},
    ResizeStrategy.LETTERBOX: RESIZABLE_GEOMETRIES,
    # A crop can cut a path into pieces, and which piece is the lane is not a
    # question the arithmetic can answer; a rotated rectangle cut by the canvas
    # edge is no longer a rectangle; a keypoint cut away keeps its slot, and
    # nothing in the crop can say whether it became occluded or unlabeled.
    ResizeStrategy.FILL: RESIZABLE_GEOMETRIES - _UNCROPPABLE,
    ResizeStrategy.CENTER_CROP: RESIZABLE_GEOMETRIES - _UNCROPPABLE,
}
"""Which geometries each resize strategy can transform, per :class:`ResizeStrategy`."""

CROPPING_STRATEGIES: Final[frozenset[ResizeStrategy]] = frozenset(
    {ResizeStrategy.FILL, ResizeStrategy.CENTER_CROP}
)
"""The strategies that cut pixels away, and so can clip or drop a label."""


class ResizeStep(BaseModel):
    """Bring every exported image to one size, by one strategy.

    ``pad_value`` is the grey a letterbox pads with — 114 is the value YOLO
    trainers letterbox with themselves — and the grey ``center_crop`` pads an
    axis the source is too small to fill; ``stretch`` and ``fill`` cover the
    whole canvas and ignore it.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["resize"] = "resize"
    strategy: ResizeStrategy
    width: int = Field(ge=32, le=8192)
    height: int = Field(ge=32, le=8192)
    pad_value: int = Field(default=114, ge=0, le=255)

    @property
    def name(self) -> str:
        """What a refusal calls this step: its kind."""
        return self.kind

    @property
    def supported_geometries(self) -> frozenset[GeometryType]:
        """What this strategy can transform, read from :data:`RESIZE_GEOMETRIES`."""
        return RESIZE_GEOMETRIES[self.strategy]


class AugmentOp(StrEnum):
    """An augmentation a recipe can apply when generating variants."""

    HFLIP = "hflip"
    BRIGHTNESS_CONTRAST = "brightness_contrast"
    ROT90 = "rot90"


AUGMENT_GEOMETRIES: Final[Mapping[AugmentOp, frozenset[GeometryType]]] = {
    # A mask mirrors and turns exactly, pixel for pixel.
    AugmentOp.HFLIP: PIXEL_GEOMETRIES,
    AugmentOp.BRIGHTNESS_CONTRAST: EVERY_GEOMETRY,
    # A polyline's point order carries meaning relative to the frame's axes,
    # and a quarter turn re-axes the frame under it.
    AugmentOp.ROT90: PIXEL_GEOMETRIES - {GeometryType.POLYLINE},
}
"""Which geometries each augmentation can transform, per :class:`AugmentOp`."""


ParameterValue = float | int | bool
"""What one augmentation parameter can hold: a JSON number or a boolean."""


class ParameterKind(StrEnum):
    """The JSON type an augmentation parameter takes."""

    FLOAT = "float"
    INT = "int"
    BOOL = "bool"


class AugmentParameter(BaseModel):
    """One typed parameter an augmentation declares, with its range and default.

    ``minimum`` and ``maximum`` bound a number inclusively unless
    ``exclusive_minimum`` says the lower bound is open. ``inert`` marks a
    parameter the step carries and validates but the operation never reads:
    ``amount`` is a field of every :class:`AugmentStep`, so ``hflip`` and
    ``rot90`` must say what it means to them, and what it means is nothing.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    kind: ParameterKind
    default: ParameterValue
    minimum: float | int | None = None
    maximum: float | int | None = None
    exclusive_minimum: bool = False
    inert: bool = False
    description: str

    def checked(self, value: object, operation: str) -> ParameterValue:
        """``value`` as this parameter holds it, or the reason it cannot.

        A float parameter given an integer holds it as a float, so ``1`` and
        ``1.0`` cannot hash a recipe two ways.

        Raises:
            ValueError: the value has the wrong type or lies outside the range.
        """
        where = f"{operation} parameter {self.name!r}"
        if self.kind is ParameterKind.BOOL:
            if not isinstance(value, bool):
                raise ValueError(f"{where} is a boolean, not {value!r}")
            return value
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise ValueError(f"{where} is a number, not {value!r}")
        if self.kind is ParameterKind.INT:
            if not isinstance(value, int):
                raise ValueError(f"{where} is a whole number, not {value!r}")
            number: float | int = value
        else:
            number = float(value)
            if not math.isfinite(number):
                raise ValueError(f"{where} must be finite, not {value!r}")
        below = self.minimum is not None and (
            number <= self.minimum if self.exclusive_minimum else number < self.minimum
        )
        if below or (self.maximum is not None and number > self.maximum):
            raise ValueError(f"{where} must lie in {self.range_text()}, not {value!r}")
        return number

    def range_text(self) -> str:
        """The range in interval notation, the way a refusal states it."""
        opening = "(" if self.exclusive_minimum else "["
        low = "-inf" if self.minimum is None else repr(self.minimum)
        high = "inf" if self.maximum is None else repr(self.maximum)
        return f"{opening}{low}, {high}]"


class AugmentFamily(StrEnum):
    """Whether an augmentation moves pixels or only changes their values."""

    SPATIAL = "spatial"
    PHOTOMETRIC = "photometric"


class SemanticEffect(StrEnum):
    """What an augmentation does to what a label *means*, beyond where it is.

    ``preserves`` changes no meaning. ``mirrors`` swaps the frame's handedness,
    so a class or keypoint named for a side — ``left_turn``, ``right_eye`` —
    now names the other one. ``reorients`` turns the frame's axes, so a class
    whose meaning is tied to up, down or reading direction may not survive it.
    A compatibility check reads this; the operation never renames anything.
    """

    PRESERVES = "preserves"
    MIRRORS = "mirrors"
    REORIENTS = "reorients"


class LossPolicy(StrEnum):
    """Whether an augmentation can cut a label it supports down or away.

    ``lossless`` never does, over every geometry it declares. ``lossy`` may,
    and a recipe holding it asks for the same explicit consent a cropping
    resize does.
    """

    LOSSLESS = "lossless"
    LOSSY = "lossy"


_Ordered = TypeVar("_Ordered", GeometryType, Task)


def _in_declaration_order(
    members: Iterable[_Ordered], vocabulary: type[_Ordered]
) -> tuple[_Ordered, ...]:
    chosen = set(members)
    return tuple(member for member in vocabulary if member in chosen)


class AugmentOperation(BaseModel):
    """What one version of one augmentation is, declared rather than inferred.

    ``geometries`` is read from :data:`AUGMENT_GEOMETRIES`, the table every
    step's ``supported_geometries`` and the geometry transform's refusal
    already read, so the registry restates nothing. ``modalities`` and
    ``tasks`` are what the operation can serve; a modality or task not listed
    is unsupported, never assumed. ``drivers`` names the built-in drivers that
    apply it, and ``preview`` says whether a preview's ``showcase`` can show it
    at its declared strength. Every collection is a tuple in its vocabulary's
    declaration order, so the serialized registry is byte-stable.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    op: AugmentOp
    version: int = Field(ge=1)
    family: AugmentFamily
    parameters: tuple[AugmentParameter, ...]
    modalities: tuple[Modality, ...]
    geometries: tuple[GeometryType, ...]
    tasks: tuple[Task, ...]
    semantics: SemanticEffect
    loss: LossPolicy
    drivers: tuple[str, ...]
    preview: bool

    def parameter(self, name: str) -> AugmentParameter | None:
        """The declared parameter of that name, if the operation has one."""
        return next((one for one in self.parameters if one.name == name), None)

    def checked_params(self, params: Mapping[str, object]) -> dict[str, ParameterValue]:
        """``params`` as a step holds them, in name order, or the reason they are refused.

        ``amount`` is a field of the step itself, never a member of ``params``.

        Raises:
            ValueError: a name the operation does not declare, ``amount``, or a
                value its parameter refuses.
        """
        checked: dict[str, ParameterValue] = {}
        for name in sorted(params):
            declared = self.parameter(name)
            if name == AMOUNT.name or declared is None:
                accepted = sorted(one.name for one in self.parameters if one.name != AMOUNT.name)
                raise ValueError(
                    f"{self.op.value} has no parameter {name!r} in params; "
                    f"it accepts {', '.join(map(repr, accepted)) or 'none'}"
                    + (" (amount is the step's own field)" if name == AMOUNT.name else "")
                )
            checked[name] = declared.checked(params[name], self.op.value)
        return checked


AMOUNT: Final = AugmentParameter(
    name="amount",
    kind=ParameterKind.FLOAT,
    default=0.2,
    minimum=0.0,
    maximum=0.5,
    exclusive_minimum=True,
    description="Brightness and contrast factors are each drawn from [1 - amount, 1 + amount].",
)
"""The one parameter every legacy step carries, as a field of :class:`AugmentStep`."""

_INERT_AMOUNT: Final = AMOUNT.model_copy(
    update={
        "inert": True,
        "description": "Carried and validated; this operation reads nothing from it.",
    }
)

#: Every trainer task a step that moves no label coordinate can serve. ``depth``
#: is absent: no label the system carries is a depth map, so whether an
#: augmentation keeps one is unknown, and unknown is unsupported.
_COORDINATE_FREE_TASKS: Final = frozenset(Task) - {Task.DEPTH}

#: A step that moves pixels cannot serve ``pose`` until keypoints declare which
#: point becomes which under a mirror or a turn, and no geometry does.
_SPATIAL_TASKS: Final = _COORDINATE_FREE_TASKS - {Task.POSE}


def _operation(
    op: AugmentOp,
    *,
    family: AugmentFamily,
    amount: AugmentParameter,
    tasks: frozenset[Task],
    semantics: SemanticEffect,
) -> AugmentOperation:
    return AugmentOperation(
        op=op,
        version=1,
        family=family,
        parameters=(amount,),
        modalities=("image",),
        geometries=_in_declaration_order(AUGMENT_GEOMETRIES[op], GeometryType),
        tasks=_in_declaration_order(tasks, Task),
        semantics=semantics,
        loss=LossPolicy.LOSSLESS,
        drivers=("pillow",),
        preview=True,
    )


AUGMENT_OPERATIONS: Final[Mapping[tuple[AugmentOp, int], AugmentOperation]] = {
    (operation.op, operation.version): operation
    for operation in (
        _operation(
            AugmentOp.HFLIP,
            family=AugmentFamily.SPATIAL,
            amount=_INERT_AMOUNT,
            tasks=_SPATIAL_TASKS,
            semantics=SemanticEffect.MIRRORS,
        ),
        _operation(
            AugmentOp.BRIGHTNESS_CONTRAST,
            family=AugmentFamily.PHOTOMETRIC,
            amount=AMOUNT,
            tasks=_COORDINATE_FREE_TASKS,
            semantics=SemanticEffect.PRESERVES,
        ),
        _operation(
            AugmentOp.ROT90,
            family=AugmentFamily.SPATIAL,
            amount=_INERT_AMOUNT,
            tasks=_SPATIAL_TASKS,
            semantics=SemanticEffect.REORIENTS,
        ),
    )
}
"""Every registered version of every augmentation, keyed ``(op, version)``.

Ordered by :class:`AugmentOp` and then version, and exhaustive: every op has
at least one version, which a test holds. A version, once registered, is never
removed or changed — a stored recipe names it, and the recipe's hash and every
variant it drew depend on it staying what it was. A behaviour change is a new
version beside it.
"""


def augment_operations() -> tuple[AugmentOperation, ...]:
    """The registry in its stable order: by op as :class:`AugmentOp` declares them, then version."""
    return tuple(AUGMENT_OPERATIONS.values())


def augment_operation(op: AugmentOp, version: int = 1) -> AugmentOperation:
    """The registered operation for ``(op, version)``.

    Raises:
        ValueError: no such version of the op is registered.
    """
    operation = AUGMENT_OPERATIONS.get((op, version))
    if operation is None:
        known = sorted(v for o, v in AUGMENT_OPERATIONS if o is op)
        raise ValueError(
            f"{op.value} has no version {version}; registered versions: "
            f"{', '.join(map(str, known)) or 'none'}"
        )
    return operation


class AugmentStep(BaseModel):
    """One augmentation in a recipe.

    ``amount`` bounds the brightness and contrast factors — each is drawn
    uniformly from ``[1 - amount, 1 + amount]`` — and means nothing to
    ``hflip``, which always mirrors, or ``rot90``, whose draw has no magnitude.

    ``version`` names which registered :class:`AugmentOperation` the step
    runs and ``params`` holds the parameters that operation declares beyond
    ``amount``; an unknown version, an undeclared parameter or a value out of
    range is refused. Both are left out of the serialized step while they hold
    their legacy values — version 1, no params — which is what keeps every
    recipe written before they existed at the same canonical bytes and hash.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["augment"] = "augment"
    op: AugmentOp
    amount: float = Field(default=AMOUNT.default, gt=AMOUNT.minimum, le=AMOUNT.maximum)
    version: int = Field(default=1, ge=1, exclude_if=lambda value: value == 1)
    params: dict[str, StrictBool | StrictInt | StrictFloat] = Field(
        default_factory=dict, exclude_if=lambda value: not value
    )

    @field_validator("version")
    @classmethod
    def _version_is_registered(cls, value: int, info: ValidationInfo) -> int:
        op = info.data.get("op")
        if isinstance(op, AugmentOp):
            augment_operation(op, value)
        return value

    @field_validator("params")
    @classmethod
    def _params_are_declared(
        cls, value: dict[str, ParameterValue], info: ValidationInfo
    ) -> dict[str, ParameterValue]:
        op, version = info.data.get("op"), info.data.get("version")
        if not isinstance(op, AugmentOp) or not isinstance(version, int):
            return value
        return augment_operation(op, version).checked_params(value)

    def __hash__(self) -> int:
        return hash(
            (self.kind, self.op, self.amount, self.version, tuple(sorted(self.params.items())))
        )

    @property
    def name(self) -> str:
        """What a refusal calls this step: its augmentation op."""
        return self.op.value

    @property
    def operation(self) -> AugmentOperation:
        """The registered operation this step runs."""
        return augment_operation(self.op, self.version)

    @property
    def supported_geometries(self) -> frozenset[GeometryType]:
        """What this augmentation can transform, read from :data:`AUGMENT_GEOMETRIES`."""
        return AUGMENT_GEOMETRIES[self.op]


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


def brightness_contrast_factors(seed: bytes, amount: float) -> tuple[float, float]:
    """This variant's brightness and contrast factors, in ``[1 - amount, 1 + amount]``.

    Brightness reads word 1 of the seed and contrast word 2 — fixed positions,
    whatever other steps the recipe holds, so adding a step never re-rolls the
    others. Word 0 is read by nothing; the positions here are load-bearing,
    because moving one would re-roll every variant an export already wrote.
    :data:`SHOWCASE_SEED` answers ``(1 + amount, 1 + amount)``.
    """
    if seed == SHOWCASE_SEED:
        return (1.0 + amount, 1.0 + amount)
    return (
        1.0 - amount + 2.0 * amount * _fraction(seed, 1),
        1.0 - amount + 2.0 * amount * _fraction(seed, 2),
    )


def rot90_quarter_turns(seed: bytes) -> int:
    """How many counter-clockwise quarter turns this variant rotates: 1, 2 or 3.

    Never 0 — a rot90 step that drew no rotation would emit the base image
    under a variant's name. Reads word 3 of the seed; :data:`SHOWCASE_SEED`
    answers one turn.
    """
    if seed == SHOWCASE_SEED:
        return 1
    return 1 + _word(seed, 3) % 3


def _word(seed: bytes, index: int) -> int:
    return int.from_bytes(seed[4 * index : 4 * index + 4], "big")


def _fraction(seed: bytes, index: int) -> float:
    return _word(seed, index) / 0xFFFFFFFF
