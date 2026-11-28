"""The recipe assessment answers what pre-flight and export answer, without raising.

Every case here asks the assessment and the two raising paths the same question
and compares the answers: the resolution against ``recipe_compatibility``, the
refusal against what ``check_export`` and ``require_export_consent`` raise, and
the counts against what an export writes. Nothing here restates a rule.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from tests.fixtures.calibration import calibration
from tests.formats.test_kitti_export import Released
from tests.formats.test_ultralytics import Fixture
from tests.kernel.test_export_seam import ImageWriter
from tests.kernel.test_point_cloud_ingest import Scans, _car
from tests.kernel.test_release_service import SIGN
from tests.kernel.test_release_service import Fixture as Bare

from visionset.formats.kitti import KittiExporter
from visionset.formats.registry import exporters
from visionset.formats.ultralytics import UltralyticsExporter
from visionset.kernel import ReleaseNotFound, VisionSetError, WorkspaceCorrupt
from visionset.kernel.domain import (
    GEOMETRY_TASKS,
    Annotation,
    Asset,
    AugmentStep,
    BboxGeometry,
    ClassExportStatus,
    ClassificationGeometry,
    Cuboid3DGeometry,
    ExportTarget,
    GeometryType,
    KeypointsGeometry,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    ObbGeometry,
    PolygonGeometry,
    PolylineGeometry,
    PreprocessingHints,
    RecipeRefusal,
    RecipeSpec,
    Release,
    ResizeStep,
    ResizeStrategy,
    SplitRecipe,
    TargetFamily,
    Task,
    augment_operations,
    rasterize_polygon,
)
from visionset.kernel.error_codes import error_code
from visionset.kernel.ports import Exporter, PreprocessingDriver
from visionset.kernel.services import CalibrationService, ReleaseService
from visionset.kernel.services.release_service import _assessed
from visionset.preprocessing import registry as preprocessing_registry

SPLIT = SplitRecipe(train=0.6, val=0.2, test=0.2, seed=7)

KINDS: dict[GeometryType, LabelClass] = {
    geometry: LabelClass(name=geometry.value, geometries=(geometry,))
    for geometry in (
        GeometryType.CLASSIFICATION_TAG,
        GeometryType.BBOX,
        GeometryType.OBB,
        GeometryType.POLYGON,
        GeometryType.MASK,
        GeometryType.POLYLINE,
        GeometryType.KEYPOINTS,
        GeometryType.CUBOID_3D,
    )
}

_TRIANGLE = PolygonGeometry(points=[(10.0, 10.0), (30.0, 10.0), (30.0, 30.0)])
GEOMETRIES = {
    GeometryType.CLASSIFICATION_TAG: ClassificationGeometry(),
    GeometryType.BBOX: BboxGeometry(x=2.0, y=2.0, width=60.0, height=20.0),
    GeometryType.OBB: ObbGeometry(cx=32.0, cy=24.0, width=10.0, height=6.0, angle=0.3),
    GeometryType.POLYGON: _TRIANGLE,
    GeometryType.MASK: rasterize_polygon(_TRIANGLE, height=48, width=64),
    GeometryType.POLYLINE: PolylineGeometry(points=[(1.0, 1.0), (40.0, 30.0)]),
    GeometryType.KEYPOINTS: KeypointsGeometry(points=[(10.0, 10.0), (20.0, 12.0)]),
    GeometryType.CUBOID_3D: Cuboid3DGeometry(
        center=(-40.0, 0.8, 0.5), size=(4.5, 1.9, 1.6), yaw=-2.75
    ),
}

OPS = tuple(
    RecipeSpec(
        target=None,
        steps=(AugmentStep(op=operation.op, version=operation.version),),
        variants_per_asset=2,
    )
    for operation in augment_operations()
)
RESIZES = tuple(
    RecipeSpec(target=None, steps=(ResizeStep(strategy=strategy, width=32, height=32),))
    for strategy in ResizeStrategy
)
EVERYTHING = RecipeSpec(
    target=None,
    steps=(
        ResizeStep(strategy=ResizeStrategy.FILL, width=48, height=32),
        *(
            AugmentStep(op=operation.op, version=operation.version)
            for operation in augment_operations()
        ),
    ),
    variants_per_asset=3,
)
RECIPES = (*OPS, *RESIZES, EVERYTHING)


def _label(geometry: GeometryType) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class=geometry.value,
        schema_version=1,
        geometry=GEOMETRIES[geometry],
        provenance="human",
    )


class AllKinds(Fixture):
    """Ten images, each carrying one label of every image geometry, released twice."""

    def __init__(self, tmp_path: Path) -> None:
        super().__init__(tmp_path, images=10, classes=tuple(KINDS.values()))
        asset = self.ingest.assets(self.project.id)[0]
        assert asset.source_id is not None
        CalibrationService(self.workspace).set_source_calibration(
            asset.source_id, calibration(width=64, height=48)
        )
        self.label({position: [_label(kind) for kind in KINDS] for position in range(10)})
        self.split_id = self.publish("split", split=SPLIT)
        self.whole_id = self.publish("whole")


@pytest.fixture(scope="module")
def kinds(tmp_path_factory: pytest.TempPathFactory) -> Iterator[AllKinds]:
    fixture = AllKinds(tmp_path_factory.mktemp("kinds"))
    yield fixture
    fixture.close()


def _narrow(geometry: GeometryType, tasks: frozenset[Task]) -> ExportTarget:
    return ExportTarget(
        name=f"{geometry.value.replace('_', '-')}-{'-'.join(sorted(tasks)) or 'none'}",
        label="narrow",
        family=TargetFamily.OTHER,
        tasks=tasks,
        supported_geometries=frozenset({geometry}),
        hints=PreprocessingHints(
            recommended_size=None,
            recommended_strategy=None,
            trainer_resizes=True,
            augmentation_common=False,
        ),
    )


#: Every label kind alone, judged with no task, with each task its geometry
#: feeds, and with a task none of them feeds.
NARROW_TARGETS: tuple[ExportTarget | None, ...] = (
    None,
    *(
        _narrow(geometry, tasks)
        for geometry in KINDS
        for tasks in (
            frozenset(),
            *(frozenset({task}) for task in sorted(GEOMETRY_TASKS[geometry])),
            frozenset({Task.DEPTH}),
        )
    ),
)


def _drivers() -> dict[str, PreprocessingDriver]:
    return preprocessing_registry.drivers()


def _agrees(
    releases: ReleaseService,
    release_id: UUID,
    exporter: Exporter,
    recipe: RecipeSpec,
    target: ExportTarget | None,
    drivers: dict[str, PreprocessingDriver] | None,
) -> None:
    """Assert the assessment says exactly what the raising paths say."""
    assessment = releases.assess_recipe(
        release_id, exporter, recipe, target=target, drivers=drivers
    )
    assert assessment.resolution == releases.recipe_compatibility(
        release_id, exporter, recipe, target=target, drivers=drivers
    )
    assert assessment.target == (None if target is None else target.name)
    assert assessment.format_name == exporter.format_name
    try:
        report = releases.check_export(
            release_id, exporter, target=target, recipe=recipe, drivers=drivers
        )
    except VisionSetError as checked:
        assert assessment.refusal == RecipeRefusal(
            code=error_code(checked) or "", message=str(checked)
        )
        assert assessment.counts is None
        with pytest.raises(type(checked)) as consented:
            releases.require_export_consent(
                release_id,
                exporter,
                allow_lossy=True,
                target=target,
                recipe=recipe,
                drivers=drivers,
            )
        assert str(consented.value) == str(checked)
        return
    assert assessment.refusal is None
    assert assessment.counts is not None
    releases.require_export_consent(
        release_id, exporter, allow_lossy=True, target=target, recipe=recipe, drivers=drivers
    )
    cut = {(row.label_class, row.geometry) for row in report.classes if row.cropped_by}
    assert cut <= {(one.label_class, one.geometry) for one in assessment.resolution.conditional()}
    if isinstance(exporter, ImageWriter):
        by_status = {
            status: sum(
                row.annotations
                for row in report.classes
                if row.cropped_by is not None and row.status is status
            )
            for status in (ClassExportStatus.DROPPED, ClassExportStatus.DEGRADED)
        }
        assert assessment.counts.dropped_labels == by_status[ClassExportStatus.DROPPED]
        assert assessment.counts.clipped_labels == by_status[ClassExportStatus.DEGRADED]


@pytest.mark.parametrize("split", [True, False], ids=["split", "whole"])
@pytest.mark.parametrize(
    "target", NARROW_TARGETS, ids=["format"] + [str(one.name) for one in NARROW_TARGETS[1:]]
)
def test_the_assessment_agrees_with_preflight_for_every_label_kind_and_task(
    kinds: AllKinds, target: ExportTarget | None, split: bool
) -> None:
    release_id = kinds.split_id if split else kinds.whole_id
    for recipe in RECIPES:
        _agrees(kinds.releases, release_id, ImageWriter(), recipe, target, _drivers())


SHIPPED = sorted(
    ((target, exporter) for exporter in exporters().values() for target in exporter.targets),
    key=lambda pair: pair[0].name,
)


@pytest.mark.parametrize(
    ("target", "exporter"), SHIPPED, ids=[target.name for target, _ in SHIPPED]
)
def test_the_assessment_agrees_with_preflight_for_every_shipped_target(
    kinds: AllKinds, target: ExportTarget, exporter: Exporter
) -> None:
    for recipe in (*OPS, EVERYTHING):
        _agrees(kinds.releases, kinds.split_id, exporter, recipe, target, _drivers())


@pytest.mark.parametrize(
    "drivers",
    [None, {}, {"resize": preprocessing_registry.drivers()["resize"]}],
    ids=["unjudged", "none-installed", "resize-only"],
)
def test_a_missing_driver_is_answered_as_preflight_answers_it(
    kinds: AllKinds, drivers: dict[str, PreprocessingDriver] | None
) -> None:
    for recipe in RECIPES:
        _agrees(kinds.releases, kinds.split_id, ImageWriter(), recipe, None, drivers)


def test_a_recipe_for_an_export_that_writes_scans_is_a_refusal_not_an_error(
    tmp_path: Path,
) -> None:
    released = Released(tmp_path, split=SPLIT)
    try:
        for recipe in RECIPES:
            _agrees(
                released.releases, released.release_id, KittiExporter(), recipe, None, _drivers()
            )
        assessment = released.releases.assess_recipe(
            released.release_id, KittiExporter(), RESIZES[0], drivers=_drivers()
        )
    finally:
        released.workspace.close()
    assert assessment.refusal is not None
    assert assessment.refusal.code == "EXPORT_SOURCE_UNREADABLE"


def test_a_missing_source_size_is_a_refusal_not_an_error(tmp_path: Path) -> None:
    fixture = Bare(tmp_path, assets=0)
    for index in range(4):
        content_hash = fixture.workspace.blob_store.put(BytesIO(f"unsized-{index}".encode()))
        with fixture.workspace.unit_of_work() as uow:
            fixture.asset_ids.append(
                uow.assets.add(
                    Asset(
                        project_id=fixture.project.id,
                        content_hash=content_hash,
                        uri=f"/tmp/unsized-{index}.png",
                    )
                ).id
            )
    fixture.schemas.create_version(fixture.project.id, [SIGN])
    fixture.promote()
    release = fixture.releases.publish(fixture.dataset_id, "v1", split=SPLIT)
    try:
        for recipe in RECIPES:
            _agrees(fixture.releases, release.id, ImageWriter(), recipe, None, _drivers())
        assessment = fixture.releases.assess_recipe(
            release.id, ImageWriter(), RESIZES[0], drivers=_drivers()
        )
    finally:
        fixture.close()
    assert assessment.refusal is not None
    assert assessment.refusal.code == "EXPORT_SOURCE_UNREADABLE"


# --- counts against what an export writes ------------------------------------


def _counted(
    releases: ReleaseService,
    release_id: UUID,
    exporter: Exporter,
    recipe: RecipeSpec,
    dest: Path,
    target: ExportTarget | None = None,
) -> None:
    drivers = _drivers()
    assessment = releases.assess_recipe(
        release_id, exporter, recipe, target=target, drivers=drivers
    )
    result = releases.export(
        release_id,
        exporter,
        dest,
        allow_lossy=True,
        target=target,
        recipe=recipe,
        drivers=drivers,
    )
    counts = assessment.counts
    assert counts is not None
    assert counts.source_files == result.source_file_count
    assert counts.augmented_files == result.augmented_file_count
    assert result.preprocessing is not None
    assert counts.dropped_labels == result.preprocessing.dropped_annotations
    assert counts.clipped_labels == result.preprocessing.clipped_annotations
    folds = (counts.train_images, counts.val_images, counts.test_images)
    if releases.get(release_id).split is None:
        assert folds == (None, None, None)
    else:
        assert sum(one or 0 for one in folds) == result.source_file_count + (
            result.augmented_file_count
        )
        images = {
            asset.asset_id
            for asset in releases.manifest(release_id).assets
            if asset.modality == "image"
        }
        train = len(images & set(releases.assignment(release_id).train))
        assert counts.train_images == train * (1 + recipe.variants_per_asset)


@pytest.mark.parametrize("recipe", [*RESIZES, *OPS], ids=lambda one: str(one.steps[0].name))
def test_counts_equal_what_an_export_of_a_split_release_writes(
    kinds: AllKinds, recipe: RecipeSpec, tmp_path: Path
) -> None:
    box_only = _narrow(GeometryType.BBOX, frozenset())
    _counted(kinds.releases, kinds.split_id, ImageWriter(), recipe, tmp_path / "out", box_only)


@pytest.mark.parametrize("recipe", RESIZES, ids=lambda one: str(one.steps[0].strategy))
def test_counts_equal_what_an_export_of_an_unsplit_release_writes(
    kinds: AllKinds, recipe: RecipeSpec, tmp_path: Path
) -> None:
    box_only = _narrow(GeometryType.BBOX, frozenset())
    _counted(kinds.releases, kinds.whole_id, ImageWriter(), recipe, tmp_path / "out", box_only)


def test_counts_equal_a_real_formats_export_through_a_cropping_resize(
    kinds: AllKinds, tmp_path: Path
) -> None:
    target = _narrow(GeometryType.BBOX, frozenset({Task.DETECT}))
    _counted(
        kinds.releases, kinds.split_id, UltralyticsExporter(), EVERYTHING, tmp_path / "a", target
    )
    crop = RecipeSpec(
        target=None,
        steps=(ResizeStep(strategy=ResizeStrategy.CENTER_CROP, width=32, height=32),),
    )
    _counted(kinds.releases, kinds.split_id, UltralyticsExporter(), crop, tmp_path / "b", target)
    assessment = kinds.releases.assess_recipe(
        kinds.split_id, UltralyticsExporter(), crop, target=target, drivers=_drivers()
    )
    assert assessment.counts is not None
    assert assessment.counts.dropped_labels + assessment.counts.clipped_labels > 0


def test_counts_leave_out_an_asset_the_format_does_not_open(tmp_path: Path) -> None:
    scans = Scans(tmp_path)
    try:
        scans.read()
        scans.label_both({0: [_car()]})
        release_id = scans.publish(split=SPLIT)
        manifest = scans.releases.manifest(release_id)
        images = sum(1 for asset in manifest.assets if asset.modality == "image")
        assert images < len(manifest.assets)
        recipe = OPS[0]
        _counted(scans.releases, release_id, UltralyticsExporter(), recipe, tmp_path / "out")
        assessment = scans.releases.assess_recipe(
            release_id, UltralyticsExporter(), recipe, drivers=_drivers()
        )
    finally:
        scans.close()
    assert assessment.counts is not None
    assert assessment.counts.source_files == images


# --- what still raises --------------------------------------------------------


def test_an_unknown_release_still_raises(kinds: AllKinds) -> None:
    with pytest.raises(ReleaseNotFound):
        kinds.releases.assess_recipe(uuid4(), ImageWriter(), OPS[0], drivers=_drivers())


def test_a_corrupt_manifest_still_raises(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=2, classes=(KINDS[GeometryType.BBOX],))
    try:
        fixture.label({0: [_label(GeometryType.BBOX)]})
        release_id = fixture.publish()
        release = fixture.releases.get(release_id)
        blob = (
            fixture.root
            / "blobs"
            / release.manifest_hash[:2]
            / release.manifest_hash[2:4]
            / release.manifest_hash
        )
        blob.unlink()
        with pytest.raises(WorkspaceCorrupt):
            fixture.releases.assess_recipe(release_id, ImageWriter(), OPS[0], drivers=_drivers())
    finally:
        fixture.close()


def test_assessing_changes_nothing_about_the_release(kinds: AllKinds) -> None:
    before = kinds.releases.get(kinds.split_id)

    for recipe in RECIPES:
        kinds.releases.assess_recipe(kinds.split_id, ImageWriter(), recipe, drivers=_drivers())

    assert kinds.releases.get(kinds.split_id) == before
    assert kinds.releases.verify(kinds.split_id).ok


# --- cost ---------------------------------------------------------------------

#: Tens of thousands of assets at the variants cap. Measured at about 7 s on a
#: desktop core, nearly all of it materializing the variants' labels; the bound
#: leaves room for a slower runner and still catches a tenfold regression.
_LARGE_ASSETS = 20_000
_LARGE_BOUND_SECONDS = 60.0


def _large_manifest() -> tuple[Release, Manifest]:
    sign = LabelClass(name="sign", geometries=(GeometryType.BBOX,))
    assets = tuple(
        ManifestAsset(
            asset_id=uuid4(),
            content_hash=f"{index:064x}",
            uri=f"/data/{index}.png",
            width=640,
            height=480,
            annotations=tuple(
                ManifestAnnotation(
                    id=uuid4(),
                    label_class="sign",
                    schema_version=1,
                    geometry=BboxGeometry(x=10.0 * box, y=20.0, width=40.0, height=30.0),
                    provenance="human",
                )
                for box in range(3)
            ),
        )
        for index in range(_LARGE_ASSETS)
    )
    manifest = Manifest(schema_version=1, classes=(sign,), assets=assets)
    release = Release(
        dataset_id=uuid4(),
        tag="large",
        manifest_hash="0" * 64,
        schema_version=1,
        asset_count=len(assets),
        annotation_count=3 * len(assets),
        split=SPLIT,
    )
    return release, manifest


def test_an_assessment_of_a_large_release_at_the_variants_cap_is_measured() -> None:
    release, manifest = _large_manifest()
    recipe = RecipeSpec(
        target=None,
        steps=(
            ResizeStep(strategy=ResizeStrategy.LETTERBOX, width=640, height=640),
            *(
                AugmentStep(op=operation.op, version=operation.version)
                for operation in augment_operations()
            ),
        ),
        variants_per_asset=8,
    )

    started = time.perf_counter()
    assessment = _assessed(release, manifest, ImageWriter(), recipe, None, _drivers())
    elapsed = time.perf_counter() - started

    assert assessment.counts is not None
    assert assessment.counts.source_files == _LARGE_ASSETS
    assert assessment.counts.train_images is not None
    assert assessment.counts.augmented_files == 8 * (assessment.counts.train_images // 9)
    print(f"assessed {_LARGE_ASSETS} assets at 8 variants in {elapsed:.2f}s")
    assert elapsed < _LARGE_BOUND_SECONDS
