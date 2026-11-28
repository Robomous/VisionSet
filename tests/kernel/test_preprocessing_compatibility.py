"""The augmentation compatibility resolver: one verdict per step and label, the same everywhere.

The expected matrix here is written by hand rather than read off the registry,
so a registry edit that changes what an operation serves fails this file
instead of silently moving the published table with it.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

import pytest
from tests.kernel.test_export_seam import SPLIT, ImageWriter, MarkingDriver, drivers_of
from tests.kernel.test_release_service import SIGN, Fixture, _box

from visionset.kernel.domain import (
    Annotation,
    AugmentOp,
    AugmentStep,
    CarriedExport,
    CarriedLabels,
    CarriedModality,
    ExportTarget,
    GeometryType,
    KeypointsGeometry,
    LabelClass,
    LabelKind,
    LossPolicy,
    PolylineGeometry,
    PreprocessingHints,
    ReasonCode,
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    StepCompatibility,
    TargetFamily,
    Task,
    Verdict,
    augment_operation,
    augmentation_matrix,
    carried_by,
    resolve_augmentation,
)
from visionset.kernel.error_codes import error_detail
from visionset.kernel.errors import (
    AugmentationIncompatible,
    PreprocessingDriverNotFound,
    PreprocessingStepUnsupportedGeometry,
)

M = ReasonCode.MODALITY_UNSUPPORTED
G = ReasonCode.GEOMETRY_UNSUPPORTED
T = ReasonCode.TASK_UNSUPPORTED
S = ReasonCode.SEMANTICS_UNREPRESENTABLE
U = ReasonCode.UNKNOWN_COMBINATION

#: Without a target: kind -> (hflip, brightness_contrast, rot90) refusal reasons.
WITHOUT_A_TARGET: dict[LabelKind, tuple[tuple[ReasonCode, ...], ...]] = {
    LabelKind.CLASSIFICATION: ((), (), ()),
    LabelKind.BBOX: ((), (), ()),
    LabelKind.OBB: ((), (), ()),
    LabelKind.POLYGON: ((), (), ()),
    LabelKind.MASK: ((), (), ()),
    LabelKind.LANE: ((), (), (G,)),
    LabelKind.KEYPOINTS: ((), (), ()),
    LabelKind.IMAGE_3D: ((G,), (), (G,)),
    LabelKind.SCAN: ((M, G), (M,), (M, G)),
    LabelKind.TEXT: ((U, S), (U,), (U, S)),
    LabelKind.PANOPTIC: ((U,), (U,), (U,)),
}

OPS = (AugmentOp.HFLIP, AugmentOp.BRIGHTNESS_CONTRAST, AugmentOp.ROT90)

#: The tasks each op refuses to serve, by hand.
REFUSED_TASKS: dict[AugmentOp, frozenset[Task]] = {
    AugmentOp.HFLIP: frozenset({Task.POSE, Task.DEPTH}),
    AugmentOp.BRIGHTNESS_CONTRAST: frozenset({Task.DEPTH}),
    AugmentOp.ROT90: frozenset({Task.POSE, Task.DEPTH}),
}

TARGETS: tuple[Task | None, ...] = (
    None,
    Task.DETECT,
    Task.SEGMENT,
    Task.CLASSIFY,
    Task.OBB,
    Task.SEMANTIC,
    Task.POSE,
    Task.DEPTH,
)

GATED = {LabelKind.TEXT, LabelKind.PANOPTIC}


def _expected(kind: LabelKind, op: AugmentOp, task: Task | None) -> tuple[ReasonCode, ...]:
    reasons = WITHOUT_A_TARGET[kind][OPS.index(op)]
    if task is not None and kind not in GATED and task in REFUSED_TASKS[op]:
        reasons = (*reasons, T)
    return reasons


@pytest.mark.parametrize("task", TARGETS, ids=lambda task: "none" if task is None else task.value)
@pytest.mark.parametrize("op", OPS, ids=lambda op: op.value)
@pytest.mark.parametrize("kind", list(LabelKind), ids=lambda kind: kind.value)
def test_the_matrix_answers_every_kind_op_and_target(
    kind: LabelKind, op: AugmentOp, task: Task | None
) -> None:
    tasks = None if task is None else frozenset({task})
    (cell,) = [one for one in augmentation_matrix(tasks) if one.kind is kind and one.op == op.value]

    expected = _expected(kind, op, task)
    assert cell.reasons == expected
    assert cell.verdict is (Verdict.REFUSED if expected else Verdict.SUPPORTED)


def test_a_label_is_judged_by_the_task_its_geometry_feeds_not_every_task_of_the_target() -> None:
    every_task = frozenset(Task)
    cells = {(one.kind, one.op): one for one in augmentation_matrix(every_task)}

    assert cells[(LabelKind.BBOX, "hflip")].verdict is Verdict.SUPPORTED
    assert cells[(LabelKind.MASK, "rot90")].verdict is Verdict.SUPPORTED
    assert cells[(LabelKind.KEYPOINTS, "hflip")].reasons == (T,)
    assert cells[(LabelKind.KEYPOINTS, "brightness_contrast")].verdict is Verdict.SUPPORTED
    # A lane feeds no task, so it is judged against all of them and fails closed.
    assert cells[(LabelKind.LANE, "hflip")].reasons == (T,)


def test_an_empty_task_set_is_no_trainer_and_constrains_nothing() -> None:
    assert augmentation_matrix(frozenset()) == augmentation_matrix(None)


def test_a_lossy_operation_is_refused_until_its_loss_is_accounted() -> None:
    lossy = augment_operation(AugmentOp.HFLIP).model_copy(update={"loss": LossPolicy.LOSSY})

    cells = {one.kind: one for one in augmentation_matrix(operations=[lossy])}

    assert cells[LabelKind.BBOX].verdict is Verdict.REFUSED
    assert cells[LabelKind.BBOX].reasons == (ReasonCode.LOSS_REQUIRES_CONSENT,)


def _carried(*labels: CarriedLabels, split: bool = True) -> CarriedExport:
    return CarriedExport(
        split=split,
        modalities=(CarriedModality(modality="image", assets=4, augmented=2),),
        labels=labels,
    )


def _label(name: str, geometry: GeometryType, *, augmented: int = 2) -> CarriedLabels:
    return CarriedLabels(
        label_class=name, geometry=geometry, modality="image", annotations=4, augmented=augmented
    )


def _recipe(*ops: AugmentOp, resize: ResizeStep | None = None) -> RecipeSpec:
    steps = (*((resize,) if resize else ()), *(AugmentStep(op=op) for op in ops))
    return RecipeSpec(target=None, steps=steps, variants_per_asset=1 if ops else 0)


def _offenders(entries: tuple[StepCompatibility, ...]) -> set[tuple[str, str | None, str | None]]:
    return {
        (one.step, one.label_class, None if one.geometry is None else one.geometry.value)
        for one in entries
    }


def test_every_offender_of_a_mixed_release_is_collected() -> None:
    carried = _carried(
        _label("sign", GeometryType.BBOX),
        _label("lane", GeometryType.POLYLINE),
        _label("face", GeometryType.KEYPOINTS),
    )

    resolution = resolve_augmentation(
        _recipe(AugmentOp.HFLIP, AugmentOp.ROT90),
        carried,
        target_tasks=frozenset({Task.DETECT, Task.POSE}),
    )

    assert _offenders(resolution.refusals()) == {
        ("hflip", "lane", "polyline"),
        ("hflip", "face", "keypoints"),
        ("rot90", "lane", "polyline"),
        ("rot90", "face", "keypoints"),
    }
    by_key = {(one.step, one.label_class): one for one in resolution.entries}
    assert by_key[("rot90", "lane")].reasons == (G, T)
    assert by_key[("hflip", "sign")].verdict is Verdict.SUPPORTED
    assert "face" in by_key[("hflip", "face")].message


def test_an_augmentation_meets_only_the_labels_on_the_train_fold() -> None:
    carried = _carried(_label("lane", GeometryType.POLYLINE, augmented=0))

    resolution = resolve_augmentation(_recipe(AugmentOp.ROT90), carried)

    assert resolution.entries == ()


def test_without_a_split_the_step_refuses_and_every_label_is_still_judged() -> None:
    carried = _carried(_label("lane", GeometryType.POLYLINE), split=False)

    resolution = resolve_augmentation(_recipe(AugmentOp.ROT90), carried)

    assert {one.reasons for one in resolution.refusals()} == {
        (ReasonCode.REQUIRES_SPLIT,),
        (G,),
    }


def test_an_unregistered_version_fails_closed() -> None:
    unknown = AugmentStep.model_construct(op=AugmentOp.HFLIP, amount=0.2, version=9, params={})
    recipe = RecipeSpec.model_construct(target=None, steps=(unknown,), variants_per_asset=1)

    (entry,) = resolve_augmentation(recipe, _carried(_label("sign", GeometryType.BBOX))).entries

    assert entry.verdict is Verdict.REFUSED
    assert entry.reasons == (U,)


def test_a_missing_driver_is_judged_only_when_drivers_are_known() -> None:
    carried = _carried(_label("sign", GeometryType.BBOX))
    recipe = _recipe(AugmentOp.HFLIP)

    unjudged = resolve_augmentation(recipe, carried)
    judged = resolve_augmentation(recipe, carried, installed_step_kinds=frozenset({"resize"}))

    assert unjudged.refusals() == ()
    ((reason,),) = {one.reasons for one in judged.refusals()}
    assert reason is ReasonCode.DRIVER_UNAVAILABLE


@pytest.mark.parametrize(
    ("strategy", "geometry", "verdict"),
    [
        (ResizeStrategy.FILL, GeometryType.BBOX, Verdict.CONDITIONAL),
        (ResizeStrategy.CENTER_CROP, GeometryType.POLYGON, Verdict.CONDITIONAL),
        (ResizeStrategy.FILL, GeometryType.CLASSIFICATION_TAG, Verdict.SUPPORTED),
        (ResizeStrategy.LETTERBOX, GeometryType.BBOX, Verdict.SUPPORTED),
        (ResizeStrategy.LETTERBOX, GeometryType.MASK, Verdict.REFUSED),
        (ResizeStrategy.FILL, GeometryType.POLYLINE, Verdict.REFUSED),
        (ResizeStrategy.STRETCH, GeometryType.OBB, Verdict.REFUSED),
    ],
)
def test_a_resize_is_conditional_exactly_where_it_can_crop(
    strategy: ResizeStrategy, geometry: GeometryType, verdict: Verdict
) -> None:
    resize = ResizeStep(strategy=strategy, width=320, height=320)

    (entry,) = resolve_augmentation(_recipe(resize=resize), _carried(_label("x", geometry))).entries

    assert entry.verdict is verdict
    if verdict is Verdict.CONDITIONAL:
        assert entry.reasons == (ReasonCode.LOSS_REQUIRES_CONSENT,)


# --- through the service, over a real release --------------------------------


def _target(*tasks: Task) -> ExportTarget:
    return ExportTarget(
        name="trainer",
        label="Trainer",
        family=TargetFamily.OTHER,
        tasks=frozenset(tasks),
        supported_geometries=frozenset(GeometryType),
        hints=PreprocessingHints(
            recommended_size=None,
            recommended_strategy=None,
            trainer_resizes=True,
            augmentation_common=False,
        ),
    )


FACE = LabelClass(name="face", geometries=(GeometryType.KEYPOINTS,))
LANE = LabelClass(name="lane", geometries=(GeometryType.POLYLINE,))


def _keypoints(asset_id: UUID) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class="face",
        schema_version=1,
        geometry=KeypointsGeometry(points=[(10.0, 10.0), (20.0, 10.0)]),
        provenance="human",
    )


def _lane(asset_id: UUID) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class="lane",
        schema_version=1,
        geometry=PolylineGeometry(points=[(0.0, 0.0), (10.0, 20.0)]),
        provenance="human",
    )


def _mixed_release(fixture: Fixture, *, lanes: bool = False) -> UUID:
    fixture.schemas.create_version(fixture.project.id, [SIGN, FACE, LANE])
    batch = fixture.batches.create(fixture.project.id, "mixed", fixture.asset_ids)
    fixture.batches.approve(batch.id)
    (job,) = fixture.batches.jobs(batch.id)
    fixture.batches.start(batch.id)
    fixture.jobs.start(job.id)
    for asset_id in fixture.asset_ids:
        labels = [_box(asset_id), _keypoints(asset_id)]
        fixture.annotations.add(job.id, [*labels, _lane(asset_id)] if lanes else labels)
    fixture.jobs.complete(job.id)
    fixture.batches.complete(batch.id)
    fixture.datasets.promote(batch.id)
    return fixture.releases.publish(fixture.dataset_id, "v1", split=SPLIT).id


HFLIP = RecipeSpec(target="yolo11", steps=(AugmentStep(op=AugmentOp.HFLIP),), variants_per_asset=1)


def test_preflight_and_export_refuse_a_pose_target_with_the_same_offenders(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release_id = _mixed_release(fixture)
    plugin, drivers = ImageWriter(), drivers_of(MarkingDriver())
    pose = _target(Task.DETECT, Task.POSE)
    dest = tmp_path / "out"

    resolution = fixture.releases.recipe_compatibility(
        release_id, plugin, HFLIP, target=pose, drivers=drivers
    )
    with pytest.raises(AugmentationIncompatible) as checked:
        fixture.releases.check_export(
            release_id, plugin, target=pose, recipe=HFLIP, drivers=drivers
        )
    with pytest.raises(AugmentationIncompatible) as consented:
        fixture.releases.require_export_consent(
            release_id, plugin, allow_lossy=True, target=pose, recipe=HFLIP, drivers=drivers
        )
    with pytest.raises(AugmentationIncompatible) as exported:
        fixture.releases.export(
            release_id, plugin, dest, allow_lossy=True, target=pose, recipe=HFLIP, drivers=drivers
        )

    assert _offenders(resolution.refusals()) == {("hflip", "face", "keypoints")}
    for caught in (checked, consented, exported):
        assert caught.value.offenders == resolution.refusals()
        assert str(caught.value) == str(checked.value)
    assert not dest.exists()
    detail = error_detail(checked.value)
    assert detail is not None
    assert [one["reasons"] for one in detail["offenders"]] == [["task_unsupported"]]
    fixture.close()


def test_without_a_target_the_format_alone_is_judged_and_the_recipe_runs(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release_id = _mixed_release(fixture)
    plugin, drivers = ImageWriter(), drivers_of(MarkingDriver())

    fixture.releases.check_export(release_id, plugin, recipe=HFLIP, drivers=drivers)
    result = fixture.releases.export(
        release_id, plugin, tmp_path / "out", recipe=HFLIP, drivers=drivers
    )

    assert result.augmented_file_count > 0
    fixture.close()


def test_a_geometry_refusal_keeps_its_class_when_a_task_refusal_rides_beside_it(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release_id = _mixed_release(fixture, lanes=True)
    plugin = ImageWriter()
    rot90 = RecipeSpec(target=None, steps=(AugmentStep(op=AugmentOp.ROT90),), variants_per_asset=1)
    pose = _target(Task.DETECT, Task.POSE)

    resolution = fixture.releases.recipe_compatibility(release_id, plugin, rot90, target=pose)
    with pytest.raises(PreprocessingStepUnsupportedGeometry) as checked:
        fixture.releases.check_export(release_id, plugin, target=pose, recipe=rot90)
    with pytest.raises(PreprocessingStepUnsupportedGeometry) as exported:
        fixture.releases.export(
            release_id,
            plugin,
            tmp_path / "out",
            allow_lossy=True,
            target=pose,
            recipe=rot90,
            drivers=drivers_of(MarkingDriver()),
        )

    assert ReasonCode.TASK_UNSUPPORTED in resolution.reasons()
    assert (checked.value.step, checked.value.geometry) == ("rot90", "polyline")
    assert str(exported.value) == str(checked.value)
    fixture.close()


def test_a_missing_driver_is_refused_at_preflight_and_before_export_writes(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release_id = _mixed_release(fixture)
    plugin = ImageWriter()
    resize_only = {"resize": MarkingDriver()}
    dest = tmp_path / "out"

    fixture.releases.check_export(release_id, plugin, recipe=HFLIP)
    with pytest.raises(PreprocessingDriverNotFound) as checked:
        fixture.releases.check_export(release_id, plugin, recipe=HFLIP, drivers=resize_only)
    with pytest.raises(PreprocessingDriverNotFound) as exported:
        fixture.releases.export(release_id, plugin, dest, recipe=HFLIP, drivers=resize_only)

    assert str(exported.value) == str(checked.value)
    assert not dest.exists()
    fixture.close()


def test_every_label_a_crop_cuts_sits_under_a_conditional_entry(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(fixture.project.id, [SIGN])
    fixture.promote()
    release = fixture.releases.publish(fixture.dataset_id, "v1", split=None)
    plugin = ImageWriter()
    crop = RecipeSpec(
        target=None,
        steps=(ResizeStep(strategy=ResizeStrategy.CENTER_CROP, width=32, height=32),),
    )

    report = fixture.releases.check_export(release.id, plugin, recipe=crop)
    resolution = fixture.releases.recipe_compatibility(release.id, plugin, crop)

    cut = {(row.label_class, row.geometry) for row in report.classes if row.cropped_by}
    conditional = {(one.label_class, one.geometry) for one in resolution.conditional()}
    assert cut == {("sign", GeometryType.BBOX)}
    assert cut <= conditional
    assert resolution.refusals() == ()
    fixture.close()


def test_carried_counts_the_train_fold_as_what_an_augmentation_meets(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release_id = _mixed_release(fixture)
    manifest = fixture.releases.manifest(release_id)
    folds = fixture.releases.assignment(release_id)

    split = carried_by(manifest, folds)
    unsplit = carried_by(manifest, None)

    assert 0 < len(folds.train) < len(manifest.assets)
    assert {(one.label_class, one.annotations, one.augmented) for one in split.labels} == {
        ("face", 5, len(folds.train)),
        ("sign", 5, len(folds.train)),
    }
    assert split.modalities == (
        CarriedModality(modality="image", assets=5, augmented=len(folds.train)),
    )
    assert split.split and not unsplit.split
    assert {one.augmented for one in unsplit.labels} == {5}
    fixture.close()
