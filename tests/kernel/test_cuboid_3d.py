"""`cuboid_3d`: a calibrated 3D box on an image, from the domain to an export.

See ``docs/content/architecture/decisions/three-dimensional-labels-are-calibrated-image-labels.md``.
"""

from __future__ import annotations

import json
from math import inf, nan, pi
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError
from tests.fixtures.calibration import calibration
from tests.formats.test_ultralytics import Fixture, _box
from tests.kernel.test_import_service import FakeImporter, World, _image

from visionset.formats.registry import exporters
from visionset.kernel import (
    CalibrationMissing,
    LossyExportNotConsented,
    PreprocessingStepUnsupportedGeometry,
)
from visionset.kernel.domain import (
    IMPLEMENTED_GEOMETRIES,
    Annotation,
    AugmentOp,
    AugmentStep,
    ClassExportStatus,
    Cuboid3DGeometry,
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
    RecipeSpec,
    ResizeStep,
    ResizeStrategy,
    SplitAssignment,
    canonical_bytes,
    geometry_needs_calibration,
    plugin_manifest,
    transform_manifest,
)
from visionset.kernel.domain.geometry import geometry_intersects_asset
from visionset.kernel.services import CalibrationService

geometry_adapter: TypeAdapter[Geometry] = TypeAdapter(Geometry)

# Off to the side and straddling the camera: neither is a reason to refuse a 3D label.
BOX = Cuboid3DGeometry(center=(-40.0, 0.8, 0.5), size=(4.5, 1.9, 1.6), yaw=-2.75)
CLASSES = (
    LabelClass(name="sign", geometries=(GeometryType.BBOX,)),
    LabelClass(name="car_3d", geometries=(GeometryType.CUBOID_3D,)),
)


def _car(geometry: Cuboid3DGeometry = BOX) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="car_3d",
        schema_version=1,
        geometry=geometry,
        provenance="human",
    )


# --- the domain variant -----------------------------------------------------


def test_it_is_implemented_and_a_sibling_of_every_other_variant() -> None:
    assert GeometryType.CUBOID_3D in IMPLEMENTED_GEOMETRIES
    assert not issubclass(Cuboid3DGeometry, Polyline3DGeometry)


def test_it_parses_from_its_tag_and_round_trips() -> None:
    raw = {"type": "cuboid_3d", "center": [1.0, 1.5, 12.0], "size": [4.0, 2.0, 1.5], "yaw": 0.5}
    parsed = geometry_adapter.validate_python(raw)
    assert isinstance(parsed, Cuboid3DGeometry)
    assert parsed.model_dump(mode="json") == raw
    assert geometry_adapter.validate_json(json.dumps(raw)) == parsed


@pytest.mark.parametrize("yaw", [-pi, 0.0, pi])
def test_yaw_is_accepted_on_the_closed_range(yaw: float) -> None:
    assert Cuboid3DGeometry(center=(0.0, 0.0, 5.0), size=(1.0, 1.0, 1.0), yaw=yaw).yaw == yaw


@pytest.mark.parametrize(
    ("change", "field"),
    [
        ({"yaw": pi + 1e-9}, "yaw"),
        ({"yaw": -pi - 1e-9}, "yaw"),
        ({"yaw": 2 * pi}, "yaw"),
        ({"yaw": nan}, "yaw"),
        ({"yaw": inf}, "yaw"),
        ({"size": (0.0, 1.0, 1.0)}, "size"),
        ({"size": (1.0, -1.0, 1.0)}, "size"),
        ({"size": (1.0, 1.0, 0.0)}, "size"),
        ({"size": (1.0, 1.0, inf)}, "size"),
        ({"size": (1.0, 1.0)}, "size"),
        ({"center": (0.0, nan, 5.0)}, "center"),
        ({"center": (0.0, 5.0)}, "center"),
        ({"visibility": (2,)}, "visibility"),
    ],
)
def test_a_box_breaking_its_rules_is_refused(change: dict[str, Any], field: str) -> None:
    raw = {"center": (0.0, 0.0, 5.0), "size": (1.0, 1.0, 1.0), "yaw": 0.0} | change
    with pytest.raises(ValidationError) as refused:
        Cuboid3DGeometry(**raw)
    assert refused.value.errors()[0]["loc"][0] == field


def test_no_image_frame_bounds_apply() -> None:
    assert geometry_intersects_asset(BOX, width=64, height=48)


def test_it_needs_a_calibration() -> None:
    assert geometry_needs_calibration(BOX, modality="image")


# --- the write funnel -------------------------------------------------------


def _opened(fixture: Fixture) -> tuple[Any, list[Any]]:
    fixture.batches.approve(fixture.batch_id)
    (job,) = fixture.batches.jobs(fixture.batch_id)
    fixture.batches.start(fixture.batch_id)
    fixture.jobs.start(job.id)
    return job, fixture.batches.assets(fixture.batch_id)


def test_a_write_without_a_calibration_is_refused_and_one_with_it_is_stored(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, classes=CLASSES)
    try:
        job, assets = _opened(fixture)
        box = _box(x=1, y=1, width=4, height=4).model_copy(update={"asset_id": assets[0].id})
        car = _car().model_copy(update={"asset_id": assets[0].id})

        with pytest.raises(CalibrationMissing) as refused:
            fixture.annotations.add(job.id, [box, car])
        assert refused.value.index == 1
        assert fixture.annotations.for_asset(job.id, assets[0].id) == []

        CalibrationService(fixture.workspace).set_asset_calibration(
            fixture.project.id, assets[0].id, calibration(width=64, height=48)
        )
        (_, stored) = fixture.annotations.add(job.id, [box, car])
        assert stored.geometry == BOX
        turned = BOX.model_copy(update={"yaw": 0.1})
        (updated,) = fixture.annotations.update(
            job.id, [stored.model_copy(update={"geometry": turned})]
        )
        assert updated.geometry == turned
    finally:
        fixture.close()


def test_an_import_carrying_a_cuboid_refuses_before_writing_anything(tmp_path: Path) -> None:
    world = World(tmp_path)
    try:
        importer = FakeImporter(
            ImportedDataset(
                classes=(ImportedClass(name="car_3d", geometries=(GeometryType.CUBOID_3D,)),),
                images=(_image("a.png", ImportedLabel(class_name="car_3d", geometry=BOX)),),
            )
        )
        with pytest.raises(CalibrationMissing, match="a.png"):
            world.imports.commit(world.project.id, importer, world.src)
        assert world.nothing_written()
    finally:
        world.workspace.close()


# --- publish and the manifest -----------------------------------------------


def _labelled(tmp_path: Path, *, calibrate: bool = True) -> Fixture:
    """Asset 0 holds a 3D car, asset 1 a box; all from one source."""
    fixture = Fixture(tmp_path, classes=CLASSES)
    asset = fixture.ingest.assets(fixture.project.id)[0]
    assert asset.source_id is not None
    CalibrationService(fixture.workspace).set_source_calibration(
        asset.source_id, calibration(width=64, height=48)
    )
    fixture.label({0: [_car()], 1: [_box(x=1, y=1, width=4, height=4)]})
    if not calibrate:
        with fixture.workspace.unit_of_work() as uow:
            source = uow.sources.get(asset.source_id)
            uow.sources.update(source.model_copy(update={"calibration": None}))
    return fixture


def test_publish_refuses_a_cuboid_with_no_calibration(tmp_path: Path) -> None:
    fixture = _labelled(tmp_path, calibrate=False)
    try:
        with pytest.raises(CalibrationMissing):
            fixture.publish()
    finally:
        fixture.close()


def test_publish_embeds_the_calibration_beside_the_cuboid_at_version_4(tmp_path: Path) -> None:
    fixture = _labelled(tmp_path)
    try:
        manifest = fixture.releases.manifest(fixture.publish())

        assert manifest.manifest_version == 4
        (with_car,) = [a for a in manifest.assets if a.calibration is not None]
        assert [a.geometry for a in with_car.annotations] == [BOX]
        document = json.loads(canonical_bytes(manifest))
        assert sum("calibration" in asset for asset in document["assets"]) == 1
        assert fixture.releases.verify(
            fixture.releases.list(fixture.projects.get_dataset(fixture.project.id).id)[0].id
        ).ok
    finally:
        fixture.close()


def _manifest_annotation(geometry: Geometry) -> ManifestAnnotation:
    return ManifestAnnotation(
        id=uuid4(), label_class="car_3d", schema_version=1, geometry=geometry, provenance="human"
    )


def test_a_manifest_refuses_a_cuboid_without_its_calibration() -> None:
    with pytest.raises(ValidationError, match="no calibration to read it against"):
        ManifestAsset(
            asset_id=uuid4(),
            content_hash="a" * 64,
            uri="/a.png",
            annotations=(_manifest_annotation(BOX),),
        )


def test_a_cuboid_cannot_ride_in_a_version_3_manifest() -> None:
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="a" * 64,
        uri="/a.png",
        width=64,
        height=48,
        annotations=(_manifest_annotation(BOX),),
        calibration=calibration(width=64, height=48),
    )
    with pytest.raises(ValidationError, match="version-3 manifest cannot carry"):
        Manifest(manifest_version=3, schema_version=1, classes=CLASSES, assets=(asset,))


# --- pre-processing ---------------------------------------------------------


def _three_d_manifest() -> Manifest:
    asset = ManifestAsset(
        asset_id=uuid4(),
        content_hash="a" * 64,
        uri="/a.png",
        width=64,
        height=48,
        annotations=(_manifest_annotation(BOX),),
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
def test_a_pixel_moving_step_refuses_a_cuboid(spec: RecipeSpec) -> None:
    manifest = _three_d_manifest()
    with pytest.raises(PreprocessingStepUnsupportedGeometry) as refused:
        transform_manifest(manifest, spec, SplitAssignment(train=(manifest.assets[0].asset_id,)))
    assert refused.value.geometry == "cuboid_3d"


def test_brightness_keeps_the_cuboid_and_its_calibration() -> None:
    manifest = _three_d_manifest()
    spec = RecipeSpec(
        target=None,
        steps=(AugmentStep(op=AugmentOp.BRIGHTNESS_CONTRAST, amount=0.2),),
        variants_per_asset=1,
    )
    view = transform_manifest(manifest, spec, SplitAssignment(train=(manifest.assets[0].asset_id,)))
    for asset in plugin_manifest(manifest, view).assets:
        assert [a.geometry for a in asset.annotations] == [BOX]
        assert asset.calibration == calibration(width=64, height=48)


# --- export -----------------------------------------------------------------


@pytest.mark.parametrize(
    "format_name",
    sorted(
        name
        for name, one in exporters().items()
        if GeometryType.CUBOID_3D not in one.supported_geometries
    ),
)
def test_every_format_drops_a_cuboid_class_by_count_and_needs_lossy_consent(
    tmp_path: Path, format_name: str
) -> None:
    fixture = _labelled(tmp_path)
    try:
        release_id = fixture.publish()
        exporter = exporters()[format_name]

        report = fixture.releases.check_export(release_id, exporter)
        (row,) = [one for one in report.classes if one.geometry is GeometryType.CUBOID_3D]
        assert (row.status, row.annotations, row.assets) == (ClassExportStatus.DROPPED, 1, 1)
        with pytest.raises(LossyExportNotConsented):
            fixture.releases.export(release_id, exporter, tmp_path / "refused")
    finally:
        fixture.close()


def test_an_export_with_consent_writes_everything_but_the_cuboid(tmp_path: Path) -> None:
    fixture = _labelled(tmp_path)
    try:
        release_id = fixture.publish()
        fixture.releases.export(release_id, exporters()["coco"], tmp_path / "out", allow_lossy=True)
        written = "".join(p.read_text(encoding="utf-8") for p in (tmp_path / "out").rglob("*.json"))
        assert "car_3d" in written
        assert "-40.0" not in written and "-2.75" not in written
    finally:
        fixture.close()
