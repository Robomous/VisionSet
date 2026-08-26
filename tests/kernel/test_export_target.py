"""The export-target domain: what a target may declare, and how a name resolves.

The port-side contract — an exporter without ``targets`` is not an ``Exporter``
at all — is asserted in ``tests/formats/test_registry.py`` beside its siblings;
this file owns the model's invariants and the pure kernel resolution.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from visionset.kernel.domain import (
    ExportTarget,
    GeometryType,
    Manifest,
    PreprocessingHints,
    Release,
    ResizeStrategy,
    TargetFamily,
    Task,
)
from visionset.kernel.errors import (
    ExportTargetConflict,
    ExportTargetNotFound,
    InvalidExportTarget,
)
from visionset.kernel.ports import ContentReader, resolve_target, validate_targets

NO_HINTS = PreprocessingHints(
    recommended_size=None,
    recommended_strategy=None,
    trainer_resizes=True,
    augmentation_common=False,
)


def _target(
    name: str = "a-target",
    geometries: frozenset[GeometryType] = frozenset({GeometryType.BBOX}),
) -> ExportTarget:
    return ExportTarget(
        name=name,
        label=name,
        family=TargetFamily.OTHER,
        tasks=frozenset(),
        supported_geometries=geometries,
        hints=NO_HINTS,
    )


class _Format:
    lossy = False
    degraded_geometries: frozenset[GeometryType] = frozenset()
    supported_modalities = frozenset({"image"})

    def __init__(
        self,
        format_name: str,
        supported: frozenset[GeometryType],
        targets: frozenset[ExportTarget],
    ) -> None:
        self.format_name = format_name
        self.supported_geometries = supported
        self.targets = targets

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        return None


def test_a_target_carries_its_whole_declaration() -> None:
    target = ExportTarget(
        name="yolo11",
        label="YOLO11",
        family=TargetFamily.ULTRALYTICS_YOLO,
        tasks=frozenset({Task.DETECT, Task.SEGMENT}),
        supported_geometries=frozenset({GeometryType.BBOX, GeometryType.POLYGON}),
        hints=PreprocessingHints(
            recommended_size=(640, 640),
            recommended_strategy=ResizeStrategy.LETTERBOX,
            trainer_resizes=True,
            augmentation_common=True,
        ),
    )

    assert target.name == "yolo11"
    assert target.hints.recommended_size == (640, 640)


@pytest.mark.parametrize("name", ["YOLO11", "-lead", "a_b", "", "yolo 11", "über"])
def test_a_target_name_must_be_a_slug(name: str) -> None:
    with pytest.raises(ValidationError):
        _target(name=name)


@pytest.mark.parametrize("name", ["yolo11", "bdd100k-lane", "26", "a"])
def test_slug_names_are_accepted(name: str) -> None:
    assert _target(name=name).name == name


def test_a_target_must_carry_at_least_one_geometry() -> None:
    with pytest.raises(ValidationError):
        _target(geometries=frozenset())


def test_a_recommended_strategy_requires_a_recommended_size() -> None:
    with pytest.raises(ValidationError):
        PreprocessingHints(
            recommended_size=None,
            recommended_strategy=ResizeStrategy.LETTERBOX,
            trainer_resizes=True,
            augmentation_common=True,
        )


def test_a_recommended_size_needs_no_strategy() -> None:
    hints = PreprocessingHints(
        recommended_size=(640, 640),
        recommended_strategy=None,
        trainer_resizes=True,
        augmentation_common=False,
    )

    assert hints.recommended_strategy is None


def test_targets_live_in_a_frozenset() -> None:
    """The port field's type: a declaration that is not hashable cannot be one."""
    declared = frozenset({_target("one"), _target("two")})

    assert len(declared) == 2


def test_resolving_returns_the_declaring_exporter_and_the_declaration() -> None:
    target = _target("wanted")
    plugin = _Format("a-format", frozenset({GeometryType.BBOX}), frozenset({target}))
    other = _Format("b-format", frozenset({GeometryType.BBOX}), frozenset({_target("unwanted")}))

    found_exporter, found_target = resolve_target(
        {plugin.format_name: plugin, other.format_name: other}, "wanted"
    )

    assert found_exporter is plugin
    assert found_target is target


def test_an_unknown_target_is_refused_listing_what_is_installed() -> None:
    plugin = _Format("a-format", frozenset({GeometryType.BBOX}), frozenset({_target("real")}))

    with pytest.raises(ExportTargetNotFound) as refusal:
        resolve_target({plugin.format_name: plugin}, "reall")

    assert "reall" in str(refusal.value)
    assert "real" in str(refusal.value)
    assert refusal.value.installed == ("real",)


def test_the_refusal_says_none_when_nothing_declares_a_target() -> None:
    with pytest.raises(ExportTargetNotFound) as refusal:
        resolve_target({}, "anything")

    assert "none" in str(refusal.value)


def test_a_target_declared_twice_is_a_conflict_naming_both_formats() -> None:
    first = _Format("a-format", frozenset({GeometryType.BBOX}), frozenset({_target("taken")}))
    second = _Format("b-format", frozenset({GeometryType.BBOX}), frozenset({_target("taken")}))

    with pytest.raises(ExportTargetConflict) as refusal:
        resolve_target({first.format_name: first, second.format_name: second}, "taken")

    assert "a-format" in str(refusal.value)
    assert "b-format" in str(refusal.value)


def test_a_target_within_its_exporter_validates() -> None:
    plugin = _Format(
        "a-format",
        frozenset({GeometryType.BBOX, GeometryType.POLYGON}),
        frozenset({_target(geometries=frozenset({GeometryType.BBOX}))}),
    )

    validate_targets(plugin)


def test_a_target_wider_than_its_exporter_is_refused_by_name() -> None:
    plugin = _Format(
        "a-format",
        frozenset({GeometryType.BBOX}),
        frozenset({_target("wide", frozenset({GeometryType.BBOX, GeometryType.POLYGON}))}),
    )

    with pytest.raises(InvalidExportTarget) as refusal:
        validate_targets(plugin)

    assert "wide" in str(refusal.value)
    assert str(refusal.value).endswith("polygon")
