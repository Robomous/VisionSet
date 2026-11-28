# usage: from visionset.kernel.domain import carried_by, resolve_augmentation
"""Whether a recipe can run over what one export carries, judged once for every caller.

:func:`resolve_augmentation` answers, for every step of a recipe and every
``(class, geometry, modality)`` the export would hand the step, one of three
verdicts with structured reasons: ``supported``, ``conditional`` (it runs, and
loses labels a consent must cover) or ``refused``. It reads the registry -
:data:`AUGMENT_OPERATIONS` for an augmentation and :data:`RESIZE_GEOMETRIES`
for a resize - and never a second list. Anything the registry does not declare
supported is refused, ``unknown_combination`` when nothing else names why.

What an export carries is :func:`carried_by` over the manifest the export hands
its plugin, after the format and the target have narrowed it, so a label the
export drops can never make a step refuse. An augmentation step meets only the
labels of the train fold, because no other fold is augmented; a resize meets
every label. Without a split there is no train fold yet, so an augmentation is
judged against every label and the recipe is refused ``requires_split``.

The target's tasks are a constraint only when the export names a target that
declares some: without a target, or for a target whose family has no trainer,
the format alone is judged, as it always was. A label serves the tasks of its
geometry the target accepts (:data:`GEOMETRY_TASKS`); one serving none of them
is judged against all of the target's tasks, because which task it feeds is
not something the export can say.

:func:`augmentation_matrix` is the same judgement over a representative label
of every :class:`LabelKind`, the published compatibility table. Text and
panoptic labels are kinds no geometry carries yet; they are rows of the
table, refused for every operation, so a reader sees them gated rather than
absent.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from enum import StrEnum
from typing import Final

from pydantic import BaseModel, ConfigDict, Field

from visionset.kernel.domain.calibration import Modality
from visionset.kernel.domain.export_target import Task
from visionset.kernel.domain.preprocessing import (
    CROPPING_STRATEGIES,
    RESIZE_GEOMETRIES,
    AugmentOperation,
    AugmentStep,
    LossPolicy,
    RecipeSpec,
    ResizeStep,
    SemanticEffect,
    Step,
    augment_operations,
)
from visionset.kernel.domain.release import Manifest, SplitAssignment
from visionset.kernel.domain.schema import GeometryType
from visionset.kernel.errors import AugmentationIncompatible


class Verdict(StrEnum):
    """What one step does with one kind of label."""

    SUPPORTED = "supported"
    CONDITIONAL = "conditional"
    REFUSED = "refused"


class ReasonCode(StrEnum):
    """Why a step is conditional or refused for a label. Closed: a new reason is a new member."""

    MODALITY_UNSUPPORTED = "modality_unsupported"
    GEOMETRY_UNSUPPORTED = "geometry_unsupported"
    TASK_UNSUPPORTED = "task_unsupported"
    SEMANTICS_UNREPRESENTABLE = "semantics_unrepresentable"
    DRIVER_UNAVAILABLE = "driver_unavailable"
    LOSS_REQUIRES_CONSENT = "loss_requires_consent"
    REQUIRES_SPLIT = "requires_split"
    UNKNOWN_COMBINATION = "unknown_combination"


class LabelKind(StrEnum):
    """A row of the published compatibility table: one kind of label a dataset can hold."""

    CLASSIFICATION = "classification"
    BBOX = "bbox"
    OBB = "obb"
    POLYGON = "polygon"
    MASK = "mask"
    LANE = "lane"
    KEYPOINTS = "keypoints"
    IMAGE_3D = "image_3d"
    SCAN = "scan"
    TEXT = "text"
    PANOPTIC = "panoptic"


KIND_LABELS: Final[Mapping[LabelKind, tuple[GeometryType, Modality] | None]] = {
    LabelKind.CLASSIFICATION: (GeometryType.CLASSIFICATION_TAG, "image"),
    LabelKind.BBOX: (GeometryType.BBOX, "image"),
    LabelKind.OBB: (GeometryType.OBB, "image"),
    LabelKind.POLYGON: (GeometryType.POLYGON, "image"),
    LabelKind.MASK: (GeometryType.MASK, "image"),
    LabelKind.LANE: (GeometryType.POLYLINE, "image"),
    LabelKind.KEYPOINTS: (GeometryType.KEYPOINTS, "image"),
    LabelKind.IMAGE_3D: (GeometryType.CUBOID_3D, "image"),
    LabelKind.SCAN: (GeometryType.CUBOID_3D, "point_cloud"),
    LabelKind.TEXT: None,
    LabelKind.PANOPTIC: None,
}
"""The label each kind is judged as; ``None`` for a kind no geometry carries yet.

``image_3d`` stands for both 3D geometries on a calibrated image, and ``scan``
for every label on a point cloud: no step treats the two 3D geometries apart.
"""

GATED_KINDS: Final[frozenset[LabelKind]] = frozenset(
    kind for kind, label in KIND_LABELS.items() if label is None
)
"""Kinds refused for every operation until a geometry, a task and a design carry them."""

_GATED_SEMANTICS: Final[Mapping[LabelKind, frozenset[SemanticEffect]]] = {
    # A mirrored or turned word no longer reads; a panoptic segment means what
    # its pixels are, wherever they move.
    LabelKind.TEXT: frozenset({SemanticEffect.MIRRORS, SemanticEffect.REORIENTS}),
    LabelKind.PANOPTIC: frozenset(),
}

GEOMETRY_TASKS: Final[Mapping[GeometryType, frozenset[Task]]] = {
    GeometryType.BBOX: frozenset({Task.DETECT}),
    GeometryType.OBB: frozenset({Task.OBB}),
    GeometryType.POLYGON: frozenset({Task.SEGMENT, Task.DETECT}),
    GeometryType.MASK: frozenset({Task.SEGMENT, Task.SEMANTIC}),
    GeometryType.POLYLINE: frozenset(),
    GeometryType.KEYPOINTS: frozenset({Task.POSE}),
    GeometryType.CUBOID_3D: frozenset(),
    GeometryType.POLYLINE_3D: frozenset(),
    GeometryType.CLASSIFICATION_TAG: frozenset({Task.CLASSIFY}),
}
"""Which trainer tasks a label of each geometry can feed. Total over :class:`GeometryType`."""

_RESIZE_MODALITIES: Final[tuple[Modality, ...]] = ("image",)


class CarriedLabels(BaseModel):
    """One ``(class, geometry, modality)`` an export hands its plugin, and how many of it.

    ``augmented`` counts the labels an augmentation step meets: those on
    train-fold assets, or every one when the release has no split.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    label_class: str
    geometry: GeometryType
    modality: Modality
    annotations: int = Field(ge=1)
    augmented: int = Field(ge=0)


class CarriedModality(BaseModel):
    """How many assets of one modality an export hands its plugin, labelled or not."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    modality: Modality
    assets: int = Field(ge=1)
    augmented: int = Field(ge=0)


class CarriedExport(BaseModel):
    """Everything a recipe would meet in one export, built by :func:`carried_by`."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    split: bool
    modalities: tuple[CarriedModality, ...] = ()
    labels: tuple[CarriedLabels, ...] = ()


def carried_by(manifest: Manifest, folds: SplitAssignment | None) -> CarriedExport:
    """What ``manifest`` carries, per class, geometry and modality, sorted for a stable order.

    ``manifest`` is the one an export hands its plugin - already narrowed to
    what the format and the target carry - and ``folds`` the release's split
    over its whole frozen manifest, or ``None`` when it was published without one.
    """
    train = None if folds is None else frozenset(folds.train)
    labels: dict[tuple[str, GeometryType, Modality], tuple[int, int]] = {}
    modalities: dict[Modality, tuple[int, int]] = {}
    for asset in manifest.assets:
        augmented = train is None or asset.asset_id in train
        assets, augmented_assets = modalities.get(asset.modality, (0, 0))
        modalities[asset.modality] = (assets + 1, augmented_assets + augmented)
        for annotation in asset.annotations:
            key = (annotation.label_class, annotation.geometry.type, asset.modality)
            count, augmented_count = labels.get(key, (0, 0))
            labels[key] = (count + 1, augmented_count + augmented)
    return CarriedExport(
        split=folds is not None,
        modalities=tuple(
            CarriedModality(modality=modality, assets=assets, augmented=augmented)
            for modality, (assets, augmented) in sorted(modalities.items())
        ),
        labels=tuple(
            CarriedLabels(
                label_class=label_class,
                geometry=geometry,
                modality=modality,
                annotations=count,
                augmented=augmented,
            )
            for (label_class, geometry, modality), (count, augmented) in sorted(labels.items())
        ),
    )


class StepCompatibility(BaseModel):
    """One step's verdict over one carried label, or over the step itself.

    ``label_class`` and ``geometry`` name the label; both are ``None`` on an
    entry about the step as a whole - no driver, no split, an unregistered
    version, or assets of a modality the step cannot read. ``reasons`` is empty
    exactly when ``verdict`` is ``supported``; ``message`` is one sentence.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    step: str
    version: int | None
    label_class: str | None
    geometry: GeometryType | None
    modality: Modality | None
    verdict: Verdict
    reasons: tuple[ReasonCode, ...]
    message: str
    annotations: int = Field(ge=0)


class AugmentationResolution(BaseModel):
    """Every verdict one recipe receives over one export, in recipe order."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    entries: tuple[StepCompatibility, ...]

    def refusals(self) -> tuple[StepCompatibility, ...]:
        """The entries that refuse the recipe, every one of them."""
        return tuple(one for one in self.entries if one.verdict is Verdict.REFUSED)

    def conditional(self) -> tuple[StepCompatibility, ...]:
        """The entries that run and lose labels a consent must cover."""
        return tuple(one for one in self.entries if one.verdict is Verdict.CONDITIONAL)

    def reasons(self) -> frozenset[ReasonCode]:
        """Every reason any refused entry gives."""
        return frozenset(reason for one in self.refusals() for reason in one.reasons)


#: How many offenders a refusal's message names before it counts the rest.
MESSAGE_OFFENDERS: Final = 5


def incompatible(offenders: tuple[StepCompatibility, ...]) -> AugmentationIncompatible:
    """The refusal for ``offenders``: every one in ``offenders``, the first few in the message."""
    named = " ".join(one.message for one in offenders[:MESSAGE_OFFENDERS])
    rest = len(offenders) - MESSAGE_OFFENDERS
    more = f" ... and {rest} more." if rest > 0 else ""
    return AugmentationIncompatible(
        f"the recipe cannot run over what this export carries: {named}{more} "
        "Remove the step, or export to a target that does not train that task",
        offenders=offenders,
    )


class _Judged:
    """The clauses one judgement collected, in the order they were found."""

    def __init__(self) -> None:
        self.refusing: list[tuple[ReasonCode, str]] = []
        self.conditional: list[tuple[ReasonCode, str]] = []

    def refuse(self, reason: ReasonCode, clause: str) -> None:
        self.refusing.append((reason, clause))

    def condition(self, reason: ReasonCode, clause: str) -> None:
        self.conditional.append((reason, clause))

    def verdict(self) -> Verdict:
        if self.refusing:
            return Verdict.REFUSED
        if self.conditional:
            return Verdict.CONDITIONAL
        return Verdict.SUPPORTED

    def reasons(self) -> tuple[ReasonCode, ...]:
        return tuple(reason for reason, _ in [*self.refusing, *self.conditional])

    def message(self, subject: str) -> str:
        clauses = [clause for _, clause in [*self.refusing, *self.conditional]]
        if not clauses:
            return f"{subject}: supported."
        return f"{subject}: {'; '.join(clauses)}."


def _served(geometry: GeometryType, target_tasks: frozenset[Task]) -> frozenset[Task]:
    return (GEOMETRY_TASKS[geometry] & target_tasks) or target_tasks


def _task_names(tasks: Iterable[Task]) -> str:
    return ", ".join(task.value for task in Task if task in set(tasks))


def _judge_augment(
    operation: AugmentOperation,
    geometry: GeometryType,
    modality: Modality,
    target_tasks: frozenset[Task] | None,
) -> _Judged:
    judged = _Judged()
    name = operation.op.value
    if modality not in operation.modalities:
        judged.refuse(
            ReasonCode.MODALITY_UNSUPPORTED,
            f"{name} runs on {', '.join(operation.modalities)} assets only, not on a {modality}",
        )
    if geometry not in operation.geometries:
        judged.refuse(
            ReasonCode.GEOMETRY_UNSUPPORTED, f"{name} cannot transform a {geometry.value}"
        )
    if target_tasks:
        missing = _served(geometry, target_tasks) - frozenset(operation.tasks)
        if missing:
            judged.refuse(
                ReasonCode.TASK_UNSUPPORTED,
                f"{name} cannot serve the {_task_names(missing)} task the target trains "
                f"{geometry.value} labels for",
            )
    if operation.loss is LossPolicy.LOSSY:
        judged.refuse(
            ReasonCode.LOSS_REQUIRES_CONSENT,
            f"{name} can cut a label away, and no export report accounts for an "
            "augmentation's loss yet",
        )
    return judged


def _judge_resize(step: ResizeStep, geometry: GeometryType, modality: Modality) -> _Judged:
    judged = _Judged()
    if modality not in _RESIZE_MODALITIES:
        judged.refuse(
            ReasonCode.MODALITY_UNSUPPORTED,
            f"a resize runs on image assets only, not on a {modality}",
        )
    if geometry not in RESIZE_GEOMETRIES[step.strategy]:
        judged.refuse(
            ReasonCode.GEOMETRY_UNSUPPORTED,
            f"a {step.strategy.value} resize cannot transform a {geometry.value}",
        )
    elif step.strategy in CROPPING_STRATEGIES and geometry is not GeometryType.CLASSIFICATION_TAG:
        judged.condition(
            ReasonCode.LOSS_REQUIRES_CONSENT,
            f"a {step.strategy.value} resize can cut a {geometry.value} down or away, which "
            "the export report counts and consent must cover",
        )
    return judged


def _operation_of(step: AugmentStep) -> AugmentOperation | None:
    try:
        return step.operation
    except ValueError:
        return None


def _step_entry(
    step: Step,
    version: int | None,
    reason: ReasonCode,
    clause: str,
    *,
    modality: Modality | None = None,
    annotations: int = 0,
) -> StepCompatibility:
    return StepCompatibility(
        step=step.name,
        version=version,
        label_class=None,
        geometry=None,
        modality=modality,
        verdict=Verdict.REFUSED,
        reasons=(reason,),
        message=f"{step.name}: {clause}.",
        annotations=annotations,
    )


def resolve_augmentation(
    recipe: RecipeSpec,
    carried: CarriedExport,
    *,
    target_tasks: frozenset[Task] | None = None,
    installed_step_kinds: frozenset[str] | None = None,
) -> AugmentationResolution:
    """Every step of ``recipe`` judged against everything ``carried`` holds.

    ``target_tasks`` is the export target's task set - the target passed to the
    export, never the recipe's ``target``, which only records where its hints
    came from. ``None`` or empty means no trainer constrains the export.
    ``installed_step_kinds`` is the step kinds an installed driver applies;
    ``None`` leaves driver availability unjudged, for a caller that holds no
    drivers. Every problem is collected; nothing stops at the first.
    """
    entries: list[StepCompatibility] = []
    for step in recipe.steps:
        if isinstance(step, ResizeStep):
            entries.extend(_resolve_resize(step, carried, installed_step_kinds))
        else:
            entries.extend(
                _resolve_augment(step, recipe, carried, target_tasks, installed_step_kinds)
            )
    return AugmentationResolution(entries=tuple(entries))


def _driver_entry(
    step: Step, version: int | None, installed_step_kinds: frozenset[str] | None
) -> list[StepCompatibility]:
    if installed_step_kinds is None or step.kind in installed_step_kinds:
        return []
    return [
        _step_entry(
            step,
            version,
            ReasonCode.DRIVER_UNAVAILABLE,
            f"no installed pre-processing driver applies {step.kind} steps",
        )
    ]


def _unreadable_modalities(
    step: Step, version: int | None, readable: tuple[Modality, ...], carried: CarriedExport
) -> list[StepCompatibility]:
    return [
        _step_entry(
            step,
            version,
            ReasonCode.MODALITY_UNSUPPORTED,
            f"{one.assets} {one.modality} asset(s) are not images and the step reads images only",
            modality=one.modality,
        )
        for one in carried.modalities
        if one.modality not in readable
    ]


def _resolve_resize(
    step: ResizeStep, carried: CarriedExport, installed_step_kinds: frozenset[str] | None
) -> list[StepCompatibility]:
    entries = _driver_entry(step, None, installed_step_kinds)
    entries.extend(_unreadable_modalities(step, None, _RESIZE_MODALITIES, carried))
    for label in carried.labels:
        judged = _judge_resize(step, label.geometry, label.modality)
        entries.append(_label_entry(step, None, label, label.annotations, judged))
    return entries


def _resolve_augment(
    step: AugmentStep,
    recipe: RecipeSpec,
    carried: CarriedExport,
    target_tasks: frozenset[Task] | None,
    installed_step_kinds: frozenset[str] | None,
) -> list[StepCompatibility]:
    operation = _operation_of(step)
    if operation is None:
        return [
            _step_entry(
                step,
                step.version,
                ReasonCode.UNKNOWN_COMBINATION,
                f"version {step.version} of {step.name} is not registered",
            )
        ]
    entries = _driver_entry(step, operation.version, installed_step_kinds)
    if not operation.drivers:
        entries.append(
            _step_entry(
                step,
                operation.version,
                ReasonCode.DRIVER_UNAVAILABLE,
                f"no driver is declared to apply {step.name} version {operation.version}",
            )
        )
    if recipe.variants_per_asset >= 1 and not carried.split:
        entries.append(
            _step_entry(
                step,
                operation.version,
                ReasonCode.REQUIRES_SPLIT,
                "variants are drawn for the train fold only, and the release has no split",
            )
        )
    entries.extend(
        _unreadable_modalities(
            step,
            operation.version,
            operation.modalities,
            carried.model_copy(
                update={"modalities": tuple(one for one in carried.modalities if one.augmented)}
            ),
        )
    )
    for label in carried.labels:
        if not label.augmented:
            continue
        judged = _judge_augment(operation, label.geometry, label.modality, target_tasks)
        entries.append(_label_entry(step, operation.version, label, label.augmented, judged))
    return entries


def _label_entry(
    step: Step, version: int | None, label: CarriedLabels, annotations: int, judged: _Judged
) -> StepCompatibility:
    return StepCompatibility(
        step=step.name,
        version=version,
        label_class=label.label_class,
        geometry=label.geometry,
        modality=label.modality,
        verdict=judged.verdict(),
        reasons=judged.reasons(),
        message=judged.message(
            f"{step.name} over class {label.label_class!r} ({label.geometry.value})"
        ),
        annotations=annotations,
    )


class MatrixCell(BaseModel):
    """One registered operation's verdict over one kind of label, under one task set."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    op: str
    version: int
    kind: LabelKind
    verdict: Verdict
    reasons: tuple[ReasonCode, ...]


def augmentation_matrix(
    target_tasks: frozenset[Task] | None = None,
    operations: Iterable[AugmentOperation] | None = None,
) -> tuple[MatrixCell, ...]:
    """Every operation judged over every :class:`LabelKind`, by the resolver's own rules.

    ``operations`` defaults to the registry. A gated kind is refused
    ``unknown_combination`` for every operation, and ``semantics_unrepresentable``
    besides where the operation's semantic effect would change what it means.
    """
    cells: list[MatrixCell] = []
    reasons: tuple[ReasonCode, ...]
    for operation in augment_operations() if operations is None else operations:
        for kind in LabelKind:
            label = KIND_LABELS[kind]
            if label is None:
                verdict = Verdict.REFUSED
                reasons = (ReasonCode.UNKNOWN_COMBINATION,)
                if operation.semantics in _GATED_SEMANTICS[kind]:
                    reasons = (*reasons, ReasonCode.SEMANTICS_UNREPRESENTABLE)
            else:
                judged = _judge_augment(operation, label[0], label[1], target_tasks)
                verdict, reasons = judged.verdict(), judged.reasons()
            cells.append(
                MatrixCell(
                    op=operation.op.value,
                    version=operation.version,
                    kind=kind,
                    verdict=verdict,
                    reasons=reasons,
                )
            )
    return tuple(cells)
