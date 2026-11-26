"""A recipe at export: what the plugin is handed, what the reader answers, what the report says.

Drivers are doubles here — the kernel takes instances and does geometry, and a
driver that appends a marker to the bytes is enough to prove which step ran
over which variant. Real pixels are ``tests/formats``' business.
"""

from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID, uuid5

import pytest
from tests.kernel.test_release_service import SIGN, Fixture, _box

from visionset.kernel.domain import (
    VARIANT_ID_NAMESPACE,
    Annotation,
    AugmentOp,
    AugmentStep,
    BboxGeometry,
    ClassExportStatus,
    ExportTarget,
    GeometryType,
    LabelClass,
    Manifest,
    PolylineGeometry,
    PreprocessingHints,
    RecipeSpec,
    Release,
    ResizeStep,
    ResizeStrategy,
    SplitRecipe,
    Step,
    TargetFamily,
    Task,
    recipe_hash,
)
from visionset.kernel.errors import (
    AugmentationRequiresSplit,
    LossyExportNotConsented,
    PreprocessingDriverNotFound,
    PreprocessingStepUnsupportedGeometry,
)
from visionset.kernel.ports import ContentReader
from visionset.kernel.services import EXPORT_REPORT_FILENAME

SPLIT = SplitRecipe(train=0.6, val=0.2, test=0.2, seed=7)
RESIZE = ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=640, height=640)
LETTERBOX = RecipeSpec(target="yolo11", steps=(RESIZE,))
AUGMENTED = RecipeSpec(
    target=None,
    steps=(RESIZE, AugmentStep(op=AugmentOp.HFLIP), AugmentStep(op=AugmentOp.ROT90)),
    variants_per_asset=2,
)


class MarkingDriver:
    """Appends ``|<kind>:<variant>`` to the bytes, so the export shows what ran."""

    step_kinds = frozenset({"resize", "augment"})

    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []

    def apply(self, step: Step, image: bytes, *, seed: bytes, variant: int) -> bytes:
        self.calls.append((step.kind, variant))
        return image + f"|{step.kind}:{variant}".encode()


def drivers_of(driver: MarkingDriver) -> dict[str, MarkingDriver]:
    return {"resize": driver, "augment": driver}


class ImageWriter:
    """Writes every manifest asset's bytes under its content key, and a label per asset."""

    format_name = "image-writer"
    lossy = False
    supported_geometries = frozenset(GeometryType)
    degraded_geometries: frozenset[GeometryType] = frozenset()
    supported_modalities = frozenset({"image"})
    targets = frozenset(
        {
            ExportTarget(
                name="image-writer",
                label="image-writer",
                family=TargetFamily.OTHER,
                tasks=frozenset(),
                supported_geometries=frozenset(GeometryType),
                hints=PreprocessingHints(
                    recommended_size=None,
                    recommended_strategy=None,
                    trainer_resizes=True,
                    augmentation_common=False,
                ),
            )
        }
    )

    def __init__(self) -> None:
        self.handed: Manifest | None = None

    def export(
        self, release: Release, manifest: Manifest, dest: Path, *, content: ContentReader
    ) -> None:
        self.handed = manifest
        (dest / "images").mkdir()
        (dest / "labels").mkdir()
        for asset in manifest.assets:
            with content(asset.content_hash) as stream:
                (dest / "images" / f"{asset.content_hash}.bin").write_bytes(stream.read())
            (dest / "labels" / f"{asset.content_hash}.txt").write_text(
                "\n".join(str(annotation.id) for annotation in asset.annotations)
            )


class RenamingWriter(ImageWriter):
    """Names its images by position, so the report has to find them by digest."""

    format_name = "renaming-writer"

    def export(
        self, release: Release, manifest: Manifest, dest: Path, *, content: ContentReader
    ) -> None:
        self.handed = manifest
        (dest / "images").mkdir()
        for index, asset in enumerate(manifest.assets):
            with content(asset.content_hash) as stream:
                (dest / "images" / f"{index:04d}.bin").write_bytes(stream.read())


def _report(dest: Path) -> dict:
    return json.loads((dest / EXPORT_REPORT_FILENAME).read_text(encoding="utf-8"))


def _published(fixture: Fixture, *, split: SplitRecipe | None):
    return fixture.releases.publish(fixture.ready(), "v1", split=split)


def test_without_a_recipe_nothing_about_the_export_moves(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = _published(fixture, split=None)
    dest = tmp_path / "out"
    plugin = ImageWriter()

    result = fixture.releases.export(release.id, plugin, dest)

    manifest = fixture.releases.manifest(release.id)
    assert plugin.handed == manifest
    assert result.preprocessing is None
    assert (result.source_file_count, result.augmented_file_count) == (5, 0)
    assert (result.source_annotation_count, result.augmented_annotation_count) == (5, 0)
    assert _report(dest)["preprocessing"] is None
    fixture.close()


def test_a_resize_recipe_transforms_every_base_image_under_its_own_name(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release = _published(fixture, split=None)
    dest = tmp_path / "out"
    plugin, driver = ImageWriter(), MarkingDriver()

    result = fixture.releases.export(
        release.id, plugin, dest, recipe=LETTERBOX, recipe_name="lb", drivers=drivers_of(driver)
    )

    manifest = fixture.releases.manifest(release.id)
    assert plugin.handed is not None
    assert [a.content_hash for a in plugin.handed.assets] == [
        a.content_hash for a in manifest.assets
    ]
    assert {(a.width, a.height) for a in plugin.handed.assets} == {(640, 640)}
    for asset in manifest.assets:
        written = (dest / "images" / f"{asset.content_hash}.bin").read_bytes()
        assert written == fixture.blob_path(asset.content_hash).read_bytes() + b"|resize:0"
    assert driver.calls == [("resize", 0)] * 5
    assert result.preprocessing is not None
    assert result.preprocessing.recipe_name == "lb"
    assert result.preprocessing.spec == LETTERBOX
    assert result.preprocessing.recipe_hash == recipe_hash(LETTERBOX)
    assert result.preprocessing.pillow_version
    assert [(row.file, row.variant) for row in result.preprocessing.mapping] == sorted(
        (f"images/{asset.content_hash}.bin", 0) for asset in manifest.assets
    )
    assert (result.source_file_count, result.augmented_file_count) == (5, 0)
    assert result.file_count == 10
    fixture.close()


def test_augmentation_writes_variants_for_the_train_fold_under_aug_keys(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release = _published(fixture, split=SPLIT)
    dest = tmp_path / "out"
    plugin, driver = ImageWriter(), MarkingDriver()

    result = fixture.releases.export(
        release.id, plugin, dest, recipe=AUGMENTED, drivers=drivers_of(driver)
    )

    manifest = fixture.releases.manifest(release.id)
    folds = fixture.releases.assignment(release.id)
    assert plugin.handed is not None
    train = {asset.content_hash for asset in manifest.assets if asset.asset_id in folds.train}
    expected_keys = sorted(
        [asset.content_hash for asset in manifest.assets]
        + [f"{content_hash}-aug{k}" for content_hash in train for k in (1, 2)]
    )
    assert sorted(a.content_hash for a in plugin.handed.assets) == expected_keys
    # A variant keeps its source's asset id and gets derived annotation ids.
    by_key = {a.content_hash: a for a in plugin.handed.assets}
    source = next(a for a in manifest.assets if a.content_hash in train)
    variant = by_key[f"{source.content_hash}-aug1"]
    assert variant.asset_id == source.asset_id
    assert [a.id for a in variant.annotations] == [
        uuid5(VARIANT_ID_NAMESPACE, f"{a.id}-aug1") for a in source.annotations
    ]
    # The variant's bytes went through the resize and both augmentations.
    written = (dest / "images" / f"{source.content_hash}-aug1.bin").read_bytes()
    assert written == (
        fixture.blob_path(source.content_hash).read_bytes() + b"|resize:1|augment:1|augment:1"
    )
    assert (result.source_file_count, result.augmented_file_count) == (5, 2 * len(train))
    assert result.source_annotation_count == 5
    assert result.augmented_annotation_count == 2 * len(train)
    assert result.file_count == result.source_file_count + result.augmented_file_count + len(
        expected_keys
    )
    assert result.preprocessing is not None
    assert {row.variant for row in result.preprocessing.mapping} == {0, 1, 2}
    report = _report(dest)
    assert report["preprocessing"]["recipe_hash"] == recipe_hash(AUGMENTED)
    assert len(report["preprocessing"]["mapping"]) == len(expected_keys)
    fixture.close()


def test_augmentation_against_a_release_without_a_split_is_refused_at_every_stage(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release = _published(fixture, split=None)
    dest = tmp_path / "out"
    plugin, driver = ImageWriter(), MarkingDriver()

    with pytest.raises(AugmentationRequiresSplit):
        fixture.releases.check_export(release.id, plugin, recipe=AUGMENTED)
    with pytest.raises(AugmentationRequiresSplit):
        fixture.releases.require_export_consent(
            release.id, plugin, allow_lossy=False, recipe=AUGMENTED
        )
    with pytest.raises(AugmentationRequiresSplit):
        fixture.releases.export(
            release.id, plugin, dest, recipe=AUGMENTED, drivers=drivers_of(driver)
        )
    assert not dest.exists()
    assert driver.calls == []
    fixture.close()


def test_consent_is_asked_before_any_step_runs(tmp_path: Path) -> None:
    class Lossy(ImageWriter):
        format_name = "lossy-writer"
        lossy = True

    fixture = Fixture(tmp_path)
    release = _published(fixture, split=None)
    driver = MarkingDriver()

    with pytest.raises(LossyExportNotConsented):
        fixture.releases.export(
            release.id, Lossy(), tmp_path / "out", recipe=LETTERBOX, drivers=drivers_of(driver)
        )
    assert driver.calls == []
    fixture.close()


def test_a_missing_driver_is_refused_by_kind(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = _published(fixture, split=None)

    with pytest.raises(PreprocessingDriverNotFound) as caught:
        fixture.releases.export(
            release.id, ImageWriter(), tmp_path / "out", recipe=LETTERBOX, drivers={}
        )
    assert "'resize'" in str(caught.value)
    fixture.close()


def _polyline(asset_id: UUID) -> Annotation:
    return Annotation(
        asset_id=asset_id,
        label_class="lane",
        schema_version=1,
        geometry=PolylineGeometry(points=[(0.0, 0.0), (10.0, 20.0)]),
        provenance="human",
    )


BOXES_ONLY_TARGET = ExportTarget(
    name="boxes-only",
    label="Boxes only",
    family=TargetFamily.OTHER,
    tasks=frozenset({Task.DETECT}),
    supported_geometries=frozenset({GeometryType.BBOX}),
    hints=PreprocessingHints(
        recommended_size=None,
        recommended_strategy=None,
        trainer_resizes=True,
        augmentation_common=False,
    ),
)


def test_a_geometry_the_target_drops_never_reaches_a_step_that_refuses_it(
    tmp_path: Path,
) -> None:
    """Narrowing runs before the transform: a dropped polyline cannot make rot90 refuse."""
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(
        fixture.project.id, [SIGN, LabelClass(name="lane", geometries=(GeometryType.POLYLINE,))]
    )
    batch = fixture.batches.create(fixture.project.id, "mixed", fixture.asset_ids)
    fixture.batches.approve(batch.id)
    (job,) = fixture.batches.jobs(batch.id)
    fixture.batches.start(batch.id)
    fixture.jobs.start(job.id)
    for asset_id in fixture.asset_ids:
        fixture.annotations.add(job.id, [_box(asset_id), _polyline(asset_id)])
    fixture.jobs.complete(job.id)
    fixture.batches.complete(batch.id)
    fixture.datasets.promote(batch.id)
    release = fixture.releases.publish(fixture.dataset_id, "v1", split=SPLIT)
    rot90 = RecipeSpec(target=None, steps=(AugmentStep(op=AugmentOp.ROT90),), variants_per_asset=1)
    plugin = ImageWriter()

    with pytest.raises(PreprocessingStepUnsupportedGeometry) as caught:
        fixture.releases.check_export(release.id, plugin, recipe=rot90)
    assert (caught.value.step, caught.value.geometry) == ("rot90", "polyline")

    fixture.releases.check_export(release.id, plugin, target=BOXES_ONLY_TARGET, recipe=rot90)
    result = fixture.releases.export(
        release.id,
        plugin,
        tmp_path / "out",
        allow_lossy=True,
        target=BOXES_ONLY_TARGET,
        recipe=rot90,
        drivers=drivers_of(MarkingDriver()),
    )
    assert plugin.handed is not None
    assert {a.geometry.type for asset in plugin.handed.assets for a in asset.annotations} == {
        "bbox"
    }
    assert result.augmented_file_count == len(fixture.releases.assignment(release.id).train)
    fixture.close()


def test_the_check_report_is_the_same_document_with_or_without_a_recipe(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release = _published(fixture, split=SPLIT)
    plugin = ImageWriter()
    assert fixture.releases.check_export(release.id, plugin) == fixture.releases.check_export(
        release.id, plugin, recipe=AUGMENTED
    )
    fixture.close()


def test_a_plugin_naming_files_its_own_way_is_traced_by_digest(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = _published(fixture, split=SPLIT)
    dest = tmp_path / "out"

    result = fixture.releases.export(
        release.id, RenamingWriter(), dest, recipe=AUGMENTED, drivers=drivers_of(MarkingDriver())
    )

    assert result.preprocessing is not None
    mapping = result.preprocessing.mapping
    assert len(mapping) == result.source_file_count + result.augmented_file_count
    for row in mapping:
        assert row.file.startswith("images/")
        assert (dest / row.file).is_file()
    assert len({row.file for row in mapping}) == len(mapping)
    fixture.close()


# --- a cropping resize: drops behind consent, counted in both reports ---------

#: 640×480 assets onto 480×480 at scale 1: 80 pixels off each side, so every
#: fixture box (x 1..31) lands wholly off the canvas.
FILL_AWAY = RecipeSpec(
    target=None, steps=(ResizeStep(strategy=ResizeStrategy.FILL, width=480, height=480),)
)
#: 10 pixels off each side: every box keeps 21 of its 30 pixels of width.
CROP_DOWN = RecipeSpec(
    target=None,
    steps=(ResizeStep(strategy=ResizeStrategy.CENTER_CROP, width=620, height=480),),
)


def _row(report: dict) -> dict:
    (row,) = [one for one in report["classes"] if one["label_class"] == "sign"]
    return row


def test_a_crop_that_drops_labels_is_refused_before_anything_is_written(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path)
    release = _published(fixture, split=None)
    dest = tmp_path / "out"
    plugin, driver = ImageWriter(), MarkingDriver()

    with pytest.raises(LossyExportNotConsented) as caught:
        fixture.releases.require_export_consent(
            release.id, plugin, allow_lossy=False, recipe=FILL_AWAY
        )
    assert caught.value.compatibility.excluded_annotations == 5
    assert "after a fill resize" in str(caught.value)
    with pytest.raises(LossyExportNotConsented):
        fixture.releases.export(
            release.id, plugin, dest, recipe=FILL_AWAY, drivers=drivers_of(driver)
        )
    assert not dest.exists()
    assert driver.calls == []
    assert plugin.handed is None
    fixture.close()


def test_a_crop_that_drops_every_label_of_a_class_reports_it_dropped(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = _published(fixture, split=None)
    dest = tmp_path / "out"
    plugin = ImageWriter()

    checked = fixture.releases.check_export(release.id, plugin, recipe=FILL_AWAY)
    result = fixture.releases.export(
        release.id,
        plugin,
        dest,
        allow_lossy=True,
        recipe=FILL_AWAY,
        drivers=drivers_of(MarkingDriver()),
    )

    assert not checked.compatible
    assert (checked.excluded_annotations, checked.excluded_assets) == (5, 5)
    assert checked.degraded_annotations == 0
    assert result.compatibility == checked
    report = _report(dest)
    assert report["excluded_annotations"] == 5
    assert _row(report)["status"] == "dropped"
    assert "fill resize cuts 5 off the canvas" in _row(report)["reason"]
    assert (
        report["preprocessing"]["dropped_annotations"],
        report["preprocessing"]["clipped_annotations"],
    ) == (5, 0)
    assert plugin.handed is not None
    assert all(asset.annotations == () for asset in plugin.handed.assets)
    assert result.source_annotation_count == 0
    fixture.close()


def test_a_crop_that_cuts_labels_down_reports_them_degraded(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    release = _published(fixture, split=None)
    dest = tmp_path / "out"

    with pytest.raises(LossyExportNotConsented) as caught:
        fixture.releases.require_export_consent(
            release.id, ImageWriter(), allow_lossy=False, recipe=CROP_DOWN
        )
    assert caught.value.compatibility.degraded_annotations == 5
    result = fixture.releases.export(
        release.id,
        ImageWriter(),
        dest,
        allow_lossy=True,
        recipe=CROP_DOWN,
        drivers=drivers_of(MarkingDriver()),
    )

    assert (result.compatibility.degraded_annotations, result.compatibility.degraded_assets) == (
        5,
        5,
    )
    assert result.compatibility.excluded_annotations == 0
    report = _report(dest)
    assert _row(report)["status"] == "degraded"
    assert "center_crop resize cuts 5 down" in _row(report)["reason"]
    assert (
        report["preprocessing"]["dropped_annotations"],
        report["preprocessing"]["clipped_annotations"],
    ) == (0, 5)
    assert result.source_annotation_count == 5
    fixture.close()


def test_a_class_the_crop_only_partly_drops_is_degraded_not_dropped(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(fixture.project.id, [SIGN])
    batch = fixture.batches.create(fixture.project.id, "two-boxes", fixture.asset_ids)
    fixture.batches.approve(batch.id)
    (job,) = fixture.batches.jobs(batch.id)
    fixture.batches.start(batch.id)
    fixture.jobs.start(job.id)
    centred = BboxGeometry(x=300.0, y=200.0, width=40.0, height=40.0)
    for asset_id in fixture.asset_ids:
        fixture.annotations.add(
            job.id,
            [
                _box(asset_id),
                Annotation(
                    asset_id=asset_id,
                    label_class="sign",
                    schema_version=1,
                    geometry=centred,
                    provenance="human",
                ),
            ],
        )
    fixture.jobs.complete(job.id)
    fixture.batches.complete(batch.id)
    fixture.datasets.promote(batch.id)
    release = fixture.releases.publish(fixture.dataset_id, "v1")

    report = fixture.releases.check_export(release.id, ImageWriter(), recipe=FILL_AWAY)

    (row,) = report.classes
    assert (row.status, row.annotations) == (ClassExportStatus.DEGRADED, 10)
    assert (report.excluded_annotations, report.degraded_annotations) == (5, 0)
    fixture.close()


def test_a_polyline_is_refused_by_a_crop_and_carried_by_a_letterbox(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path)
    fixture.schemas.create_version(
        fixture.project.id, [SIGN, LabelClass(name="lane", geometries=(GeometryType.POLYLINE,))]
    )
    batch = fixture.batches.create(fixture.project.id, "lanes", fixture.asset_ids)
    fixture.batches.approve(batch.id)
    (job,) = fixture.batches.jobs(batch.id)
    fixture.batches.start(batch.id)
    fixture.jobs.start(job.id)
    for asset_id in fixture.asset_ids:
        fixture.annotations.add(job.id, [_polyline(asset_id)])
    fixture.jobs.complete(job.id)
    fixture.batches.complete(batch.id)
    fixture.datasets.promote(batch.id)
    release = fixture.releases.publish(fixture.dataset_id, "v1")

    with pytest.raises(PreprocessingStepUnsupportedGeometry) as caught:
        fixture.releases.check_export(release.id, ImageWriter(), recipe=CROP_DOWN)
    assert (caught.value.step, caught.value.geometry) == ("resize", "polyline")
    assert fixture.releases.check_export(release.id, ImageWriter(), recipe=LETTERBOX).compatible
    fixture.close()
