"""Every shipped export target resolves a recipe exactly as its format alone does.

The resolver added a task dimension, and the shipped targets' task and geometry
sets were chosen so that it refuses nothing new for them: this pins that, so a
target or a registry edit that starts refusing a shipped export is a decision
somebody makes on purpose rather than a side effect.
"""

from __future__ import annotations

import pytest

from visionset.formats.matrix import is_built_in
from visionset.formats.registry import exporters
from visionset.kernel.domain import (
    AugmentStep,
    CarriedExport,
    CarriedLabels,
    CarriedModality,
    ExportTarget,
    RecipeSpec,
    augment_operations,
    resolve_augmentation,
)
from visionset.kernel.ports import supported_modalities_of

SHIPPED: tuple[tuple[str, ExportTarget, frozenset[str]], ...] = tuple(
    sorted(
        (
            (target.name, target, frozenset(supported_modalities_of(exporter)))
            for exporter in exporters().values()
            if is_built_in(exporter)
            for target in exporter.targets
        ),
        key=lambda row: row[0],
    )
)


def test_the_catalog_includes_targets_that_train_tasks() -> None:
    assert any(target.tasks for _, target, _ in SHIPPED)


@pytest.mark.parametrize(("name", "target", "modalities"), SHIPPED, ids=[row[0] for row in SHIPPED])
def test_a_shipped_target_adds_no_refusal_to_any_registered_op(
    name: str, target: ExportTarget, modalities: frozenset[str]
) -> None:
    carried = CarriedExport(
        split=True,
        modalities=tuple(
            CarriedModality(modality=modality, assets=1, augmented=1)  # type: ignore[arg-type]
            for modality in sorted(modalities)
        ),
        labels=tuple(
            CarriedLabels(
                label_class=geometry.value,
                geometry=geometry,
                modality=modality,  # type: ignore[arg-type]
                annotations=1,
                augmented=1,
            )
            for geometry in sorted(target.supported_geometries)
            for modality in sorted(modalities)
        ),
    )
    for operation in augment_operations():
        recipe = RecipeSpec(
            target=None,
            steps=(AugmentStep(op=operation.op, version=operation.version),),
            variants_per_asset=1,
        )
        format_alone = resolve_augmentation(recipe, carried)
        addressed = resolve_augmentation(recipe, carried, target_tasks=target.tasks)
        assert addressed == format_alone, (name, operation.op)
