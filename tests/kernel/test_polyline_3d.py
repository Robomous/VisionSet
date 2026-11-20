"""`polyline_3d`: a calibrated 3D label on an image, from the domain to an export.

See ``docs/content/architecture/decisions/three-dimensional-labels-are-calibrated-image-labels.md``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError
from tests.fixtures.calibration import calibration
from tests.formats.test_ultralytics import Fixture, _box
from tests.kernel.test_import_service import FakeImporter, World, _image

from visionset.formats.lanes._core import lanes_of
from visionset.formats.registry import exporters
from visionset.kernel import (
    CalibrationMissing,
    CalibrationResolutionMismatch,
    LossyExportNotConsented,
    PreprocessingStepUnsupportedGeometry,
)
from visionset.kernel.domain import (
    Annotation,
    AugmentOp,
    AugmentStep,
    ClassExportStatus,
    Geometry,
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedLabel,
    LabelClass,
    Manifest,
    ManifestAnnotation,
    ManifestAsset,
    Polyline3DGeometry,
    PolylineGeometry,
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    SplitAssignment,
    VertexVisibility,
    canonical_bytes,
    geometry_needs_calibration,
    plugin_manifest,
    require_calibration,
    transform_manifest,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.services import CalibrationService, PreprocessingRecipeService
from visionset.preprocessing.registry import drivers

geometry_adapter: TypeAdapter[Geometry] = TypeAdapter(Geometry)

# Out of frame and partly behind the camera: neither is a reason to refuse a 3D label.
PATH = Polyline3DGeometry(points=[(-40.0, 1.5, 6.0), (-39.0, 1.5, -3.0)])
IMAGE = (64, 48)
CLASSES = (
    LabelClass(name="sign", geometries=(GeometryType.BBOX,)),
    LabelClass(name="lane_3d", geometries=(GeometryType.POLYLINE_3D,)),
)


def _lane(geometry: Polyline3DGeometry = PATH) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="lane_3d",
        schema_version=1,
        geometry=geometry,
        provenance="human",
    )


# --- the domain variant -----------------------------------------------------


def test_it_is_a_sibling_of_the_2d_polyline_never_a_subclass() -> None:
    assert not issubclass(Polyline3DGeometry, PolylineGeometry)
    assert not isinstance(PATH, PolylineGeometry)


def test_it_parses_from_its_tag_and_round_trips() -> None:
    raw = {"type": "polyline_3d", "points": [[0, 1, 2], [3, 4, 5]], "visibility": [2, 0]}
    parsed = geometry_adapter.validate_python(raw)
    assert isinstance(parsed, Polyline3DGeometry)
    assert parsed.visibility == (VertexVisibility.VISIBLE, VertexVisibility.UNLABELED)
    assert json.loads(geometry_adapter.dump_json(parsed)) == raw


def test_an_unknown_visibility_is_omitted_not_null() -> None:
    assert "visibility" not in json.loads(geometry_adapter.dump_json(PATH))


@pytest.mark.parametrize(
    ("points", "visibility", "match"),
    [
        ([[1, 2, 3], [1, 2, 3]], None, "no length"),
        ([[1, 2, 3]], None, "at least 2"),
        ([[1, 2], [3, 4]], None, "Field required|tuple"),
        ([[1, 2, 3], [4, 5, float("nan")]], None, "finite"),
        ([[1, 2, 3], [4, 5, 6]], [2], "names 1 vertices and the geometry has 2"),
        ([[1, 2, 3], [4, 5, 6]], [True, 2], "not bool"),
        ([[1, 2, 3], [4, 5, 6]], [3, 2], "0, 1 or 2|Input should be"),
    ],
    ids=["degenerate", "one-point", "2d-points", "nan", "short-visibility", "bool", "state"],
)
def test_the_polyline_rules_hold_in_three_dimensions(
    points: list[list[float]], visibility: list[Any] | None, match: str
) -> None:
    raw: dict[str, Any] = {"type": "polyline_3d", "points": points}
    if visibility is not None:
        raw["visibility"] = visibility
    with pytest.raises(ValidationError, match=match):
        geometry_adapter.validate_python(raw)


def test_an_explicit_null_visibility_is_refused() -> None:
    with pytest.raises(ValidationError, match="never null"):
        geometry_adapter.validate_python(
            {"type": "polyline_3d", "points": [[1, 2, 3], [4, 5, 6]], "visibility": None}
        )


def test_no_image_frame_bounds_apply() -> None:
    assert geometry_intersects_asset(PATH, width=64, height=48)


def test_it_needs_a_calibration_and_no_2d_geometry_does() -> None:
    assert geometry_needs_calibration(PATH)
    assert not geometry_needs_calibration(PolylineGeometry(points=[(0, 0), (1, 1)]))


def test_a_lane_format_never_reads_it_as_a_lane() -> None:
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="a" * 64,
        uri="/a.png",
        width=64,
        height=48,
        annotations=(_manifest_annotation(PATH),),
        calibration=calibration(width=64, height=48),
    )
    assert lanes_of(asset) == []


# --- which calibration applies ----------------------------------------------


def test_the_override_wins_then_the_source_then_nothing(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, classes=CLASSES)
    try:
        asset = fixture.ingest.assets(fixture.project.id)[0]
        with fixture.workspace.unit_of_work() as uow:
            source = uow.sources.get(asset.source_id) if asset.source_id else None
        assert source is not None
        with pytest.raises(CalibrationMissing, match=str(source.id)):
            require_calibration(asset, source)
        with pytest.raises(CalibrationMissing, match="no source"):
            require_calibration(asset, None)

        own, inherited = calibration(width=64, height=48, fx=9.0), calibration(width=64, height=48)
        calibrated = source.model_copy(update={"calibration": inherited})
        assert require_calibration(asset, calibrated) == inherited
        overridden = asset.model_copy(update={"calibration": own})
        assert require_calibration(overridden, calibrated) == own
        assert require_calibration(overridden, None) == own
    finally:
        fixture.close()


def test_a_calibration_measured_at_another_size_is_refused_where_it_is_used(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, classes=CLASSES)
    try:
        asset = fixture.ingest.assets(fixture.project.id)[0]
        stray = asset.model_copy(update={"calibration": calibration(width=32, height=24)})
        with pytest.raises(CalibrationResolutionMismatch, match="64x48.*32x24"):
            require_calibration(stray, None)
    finally:
        fixture.close()


# --- the write funnel -------------------------------------------------------


def _opened(fixture: Fixture) -> tuple[Any, list[Any]]:
    fixture.batches.approve(fixture.batch_id)
    (job,) = fixture.batches.jobs(fixture.batch_id)
    fixture.batches.start(fixture.batch_id)
    fixture.jobs.start(job.id)
    return job, fixture.batches.assets(fixture.batch_id)


def test_a_3d_write_without_a_calibration_is_refused_and_stores_nothing(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, classes=CLASSES)
    try:
        job, assets = _opened(fixture)
        box = _box(x=1, y=1, width=4, height=4).model_copy(update={"asset_id": assets[0].id})
        lane = _lane().model_copy(update={"asset_id": assets[0].id})

        with pytest.raises(CalibrationMissing) as refused:
            fixture.annotations.add(job.id, [box, lane])

        assert refused.value.index == 1
        assert fixture.annotations.for_asset(job.id, assets[0].id) == []
    finally:
        fixture.close()


def test_a_3d_write_succeeds_against_the_source_or_an_override_and_is_checked_on_update(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, classes=CLASSES)
    try:
        job, assets = _opened(fixture)
        calibrations = CalibrationService(fixture.workspace)
        calibrations.set_asset_calibration(
            fixture.project.id, assets[1].id, calibration(width=64, height=48)
        )
        own = fixture.annotations.add(
            job.id, [_lane().model_copy(update={"asset_id": assets[1].id})]
        )
        assert own[0].geometry == PATH

        source_id = assets[0].source_id
        assert source_id is not None
        calibrations.set_source_calibration(source_id, calibration(width=64, height=48))
        (stored,) = fixture.annotations.add(
            job.id, [_lane().model_copy(update={"asset_id": assets[0].id})]
        )
        moved = Polyline3DGeometry(points=[(0.0, 1.0, 2.0), (0.0, 1.0, 9.0)])
        fixture.annotations.update(job.id, [stored.model_copy(update={"geometry": moved})])

        with fixture.workspace.unit_of_work() as uow:
            uow.sources.update(uow.sources.get(source_id).model_copy(update={"calibration": None}))
        with pytest.raises(CalibrationMissing):
            fixture.annotations.update(job.id, [stored])
    finally:
        fixture.close()


def test_an_asset_that_joined_a_calibrated_source_at_another_size_is_refused(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, classes=CLASSES)
    try:
        job, assets = _opened(fixture)
        source_id = assets[0].source_id
        assert source_id is not None
        CalibrationService(fixture.workspace).set_source_calibration(
            source_id, calibration(width=64, height=48)
        )
        with fixture.workspace.unit_of_work() as uow:
            uow.assets.update(assets[0].model_copy(update={"width": 128, "height": 96}))

        with pytest.raises(CalibrationResolutionMismatch, match="128x96"):
            fixture.annotations.add(job.id, [_lane().model_copy(update={"asset_id": assets[0].id})])
    finally:
        fixture.close()


# --- import -----------------------------------------------------------------


def test_an_import_carrying_a_3d_label_refuses_before_writing_anything(tmp_path: Path) -> None:
    world = World(tmp_path)
    try:
        importer = FakeImporter(
            ImportedDataset(
                classes=(ImportedClass(name="lane_3d", geometries=(GeometryType.POLYLINE_3D,)),),
                images=(_image("a.png", ImportedLabel(class_name="lane_3d", geometry=PATH)),),
            )
        )

        plan = world.imports.inspect(world.project.id, importer, world.src)
        assert any("3D labels" in conflict for conflict in plan.conflicts)
        with pytest.raises(CalibrationMissing, match="a.png"):
            world.imports.commit(world.project.id, importer, world.src)
        assert world.nothing_written()
    finally:
        world.workspace.close()


def _importer_of_a_3d_lane() -> FakeImporter:
    return FakeImporter(
        ImportedDataset(
            classes=(ImportedClass(name="lane_3d", geometries=(GeometryType.POLYLINE_3D,)),),
            images=(_image("a.png", ImportedLabel(class_name="lane_3d", geometry=PATH)),),
        )
    )


def _unheld_asset(world: World) -> Any:
    """``a.png`` stored in the project and held by no batch, so an import may label it."""
    source = world.sources.register_images(world.project.id, world.src / "images")
    run = world.ingest.ingest(source.id)
    assert run.batch_id is not None
    by_name = {Path(a.uri).name: a for a in world.ingest.assets(world.project.id)}
    world.batches.remove_assets(run.batch_id, [by_name["a.png"].id])
    return by_name["a.png"]


def test_an_import_onto_an_existing_asset_resolves_its_calibration(tmp_path: Path) -> None:
    world = World(tmp_path)
    try:
        asset = _unheld_asset(world)
        importer = _importer_of_a_3d_lane()

        with pytest.raises(CalibrationMissing, match=str(asset.source_id)):
            world.imports.commit(world.project.id, importer, world.src)

        CalibrationService(world.workspace).set_source_calibration(
            asset.source_id, calibration(width=32, height=24)
        )
        with world.workspace.unit_of_work() as uow:
            uow.assets.update(uow.assets.get(asset.id).model_copy(update={"width": 64}))
        with pytest.raises(CalibrationResolutionMismatch, match="64x24"):
            world.imports.commit(world.project.id, importer, world.src)

        with world.workspace.unit_of_work() as uow:
            uow.assets.update(uow.assets.get(asset.id).model_copy(update={"width": 32}))
        run = world.imports.commit(world.project.id, importer, world.src)
        assert run.annotations_written == 1
        assert [a.geometry for a in world.workspace_annotations(asset.id)] == [PATH]
    finally:
        world.workspace.close()


# --- publish and the manifest -----------------------------------------------


def _labelled(tmp_path: Path, *, calibrate: bool = True) -> Fixture:
    """Asset 0 holds a 3D lane, asset 1 a box, asset 2 nothing; all from one source."""
    fixture = Fixture(tmp_path, classes=CLASSES)
    asset = fixture.ingest.assets(fixture.project.id)[0]
    assert asset.source_id is not None
    CalibrationService(fixture.workspace).set_source_calibration(
        asset.source_id, calibration(width=64, height=48)
    )
    fixture.label({0: [_lane()], 1: [_box(x=1, y=1, width=4, height=4)]})
    if not calibrate:
        with fixture.workspace.unit_of_work() as uow:
            source = uow.sources.get(asset.source_id)
            uow.sources.update(source.model_copy(update={"calibration": None}))
    return fixture


def test_publish_refuses_a_3d_label_with_no_calibration(tmp_path: Path) -> None:
    fixture = _labelled(tmp_path, calibrate=False)
    try:
        with pytest.raises(CalibrationMissing):
            fixture.publish()
        assert fixture.releases.list(fixture.projects.get_dataset(fixture.project.id).id) == []
    finally:
        fixture.close()


def test_publish_embeds_the_calibration_only_beside_3d_labels_at_version_4(
    tmp_path: Path,
) -> None:
    fixture = _labelled(tmp_path)
    try:
        manifest = fixture.releases.manifest(fixture.publish())

        assert manifest.manifest_version == 4
        with_lane = [a for a in manifest.assets if a.annotations and a.calibration]
        assert len(with_lane) == 1
        assert isinstance(with_lane[0].annotations[0].geometry, Polyline3DGeometry)
        assert with_lane[0].calibration == calibration(width=64, height=48)
        document = json.loads(canonical_bytes(manifest))
        assert sum("calibration" in asset for asset in document["assets"]) == 1
        assert fixture.releases.verify(
            fixture.releases.list(fixture.projects.get_dataset(fixture.project.id).id)[0].id
        ).ok
    finally:
        fixture.close()


def test_a_2d_release_from_a_calibrated_source_hashes_as_if_calibration_did_not_exist(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, classes=CLASSES)
    try:
        fixture.label({0: [_box(x=1, y=1, width=4, height=4)]})
        before = fixture.releases.get(fixture.publish("before")).manifest_hash
        asset = fixture.ingest.assets(fixture.project.id)[0]
        assert asset.source_id is not None
        CalibrationService(fixture.workspace).set_source_calibration(
            asset.source_id, calibration(width=64, height=48)
        )
        after = fixture.releases.get(fixture.publish("after"))

        assert after.manifest_hash == before
        manifest = fixture.releases.manifest(after.id)
        assert manifest.manifest_version == 3
        assert "calibration" not in canonical_bytes(manifest).decode()
    finally:
        fixture.close()


def test_a_manifest_refuses_a_3d_label_without_its_calibration() -> None:
    with pytest.raises(ValidationError, match="no calibration to read it against"):
        ManifestAsset(
            asset_id=uuid4(),
            content_hash="a" * 64,
            uri="/a.png",
            annotations=(_manifest_annotation(PATH),),
        )


def test_a_version_3_manifest_cannot_carry_a_calibration() -> None:
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="a" * 64,
        uri="/a.png",
        calibration=calibration(),
    )
    with pytest.raises(ValidationError, match="version-3 manifest cannot carry"):
        Manifest(manifest_version=3, schema_version=1, assets=(asset,))


# --- pre-processing ---------------------------------------------------------


def _manifest_annotation(geometry: Geometry) -> ManifestAnnotation:
    return ManifestAnnotation(
        id=uuid4(), label_class="lane_3d", schema_version=1, geometry=geometry, provenance="human"
    )


def _three_d_manifest() -> Manifest:
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="a" * 64,
        uri="/a.png",
        width=64,
        height=48,
        annotations=(_manifest_annotation(PATH),),
        calibration=calibration(width=64, height=48),
    )
    return Manifest(schema_version=1, classes=CLASSES, assets=(asset,))


@pytest.mark.parametrize(
    "spec",
    [
        RecipeSpec(
            target=None,
            steps=(ResizeStep(strategy=ResizeStrategy.STRETCH, width=640, height=640),),
        ),
        RecipeSpec(target=None, steps=(AugmentStep(op=AugmentOp.HFLIP),), variants_per_asset=1),
        RecipeSpec(target=None, steps=(AugmentStep(op=AugmentOp.ROT90),), variants_per_asset=1),
    ],
    ids=["resize", "hflip", "rot90"],
)
def test_a_pixel_moving_step_refuses_a_3d_label(spec: RecipeSpec) -> None:
    manifest = _three_d_manifest()
    folds = SplitAssignment(train=(manifest.assets[0].asset_id,))
    with pytest.raises(PreprocessingStepUnsupportedGeometry) as refused:
        transform_manifest(manifest, spec, folds)
    assert refused.value.geometry == "polyline_3d"


def test_brightness_keeps_the_label_and_its_calibration_on_every_variant() -> None:
    manifest = _three_d_manifest()
    spec = RecipeSpec(
        target=None,
        steps=(AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.2),),
        variants_per_asset=2,
    )
    view = transform_manifest(manifest, spec, SplitAssignment(train=(manifest.assets[0].asset_id,)))
    handed = plugin_manifest(manifest, view)

    assert len(handed.assets) == 3
    for asset in handed.assets:
        assert [a.geometry for a in asset.annotations] == [PATH]
        assert asset.calibration == calibration(width=64, height=48)


def test_the_preview_cap_leaves_a_3d_label_in_metres(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, classes=CLASSES)
    try:
        job, assets = _opened(fixture)
        CalibrationService(fixture.workspace).set_asset_calibration(
            fixture.project.id, assets[0].id, calibration(width=64, height=48)
        )
        fixture.annotations.add(job.id, [_lane().model_copy(update={"asset_id": assets[0].id})])
        spec = RecipeSpec(
            target=None,
            steps=(AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.2),),
            variants_per_asset=1,
        )

        preview = PreprocessingRecipeService(fixture.workspace).preview(
            fixture.project.id, spec, assets[0].id, variant=1, drivers=drivers(), max_edge=48
        )

        assert (preview.width, preview.height) == (48, 36)
        assert [a.geometry for a in preview.annotations] == [PATH]
    finally:
        fixture.close()


# --- export -----------------------------------------------------------------


# The test plugin claims every geometry, so it is the one format a 3D label reaches.
@pytest.mark.parametrize(
    "format_name",
    sorted(
        name
        for name, one in exporters().items()
        if GeometryType.POLYLINE_3D not in one.supported_geometries
    ),
)
def test_every_format_drops_a_3d_class_by_count_and_needs_lossy_consent(
    tmp_path: Path, format_name: str
) -> None:
    fixture = _labelled(tmp_path)
    try:
        release_id = fixture.publish()
        exporter = exporters()[format_name]

        report = fixture.releases.check_export(release_id, exporter)
        (row,) = [one for one in report.classes if one.geometry is GeometryType.POLYLINE_3D]
        assert (row.status, row.annotations, row.assets) == (ClassExportStatus.DROPPED, 1, 1)
        assert report.excluded_annotations >= 1
        with pytest.raises(LossyExportNotConsented):
            fixture.releases.export(release_id, exporter, tmp_path / "refused")
    finally:
        fixture.close()


def test_an_export_with_consent_writes_everything_but_the_3d_class(tmp_path: Path) -> None:
    fixture = _labelled(tmp_path)
    try:
        release_id = fixture.publish()
        coco = exporters()["coco"]
        fixture.releases.export(release_id, coco, tmp_path / "out", allow_lossy=True)
        written = "".join(
            path.read_text(encoding="utf-8") for path in (tmp_path / "out").rglob("*.json")
        )
        assert "lane_3d" in written  # the class stays in the vocabulary
        assert "-39.0" not in written and "-3.0" not in written
    finally:
        fixture.close()


def test_a_format_only_export_drops_the_3d_label_before_a_resize_can_refuse(
    tmp_path: Path,
) -> None:
    fixture = _labelled(tmp_path)
    try:
        release_id = fixture.publish()
        coco = exporters()["coco"]
        resize = RecipeSpec(
            target=None,
            steps=(ResizeStep(strategy=ResizeStrategy.STRETCH, width=128, height=96),),
        )

        with pytest.raises(LossyExportNotConsented):
            fixture.releases.export(release_id, coco, tmp_path / "refused", recipe=resize)
        result = fixture.releases.export(
            release_id, coco, tmp_path / "out", allow_lossy=True, recipe=resize, drivers=drivers()
        )
        assert result.compatibility.excluded_annotations >= 1
        written = "".join(p.read_text(encoding="utf-8") for p in (tmp_path / "out").rglob("*.json"))
        assert "-39.0" not in written
    finally:
        fixture.close()
