"""Point-cloud scans through the kernel: register, ingest, label, publish, export."""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from PIL import Image
from tests.fixtures.calibration import calibration
from tests.fixtures.point_clouds import SCAN, pcd_ascii, write_scans
from tests.formats.test_ultralytics import CLASSES as IMAGE_CLASSES
from tests.formats.test_ultralytics import Fixture, _box
from tests.kernel.test_export_seam import AUGMENTED, MarkingDriver, drivers_of

from visionset.formats.registry import exporters
from visionset.kernel import (
    CalibrationInUse,
    CalibrationMissing,
    CalibrationNotApplicable,
    InvalidAnnotation,
    LossyExportNotConsented,
    UnsupportedMedia,
)
from visionset.kernel.adapters.sqlite_metadata_store import SqlUnitOfWork
from visionset.kernel.domain import (
    Annotation,
    ClassificationGeometry,
    Cuboid3DGeometry,
    GeometryType,
    IngestFailureKind,
    LabelClass,
    PointCloudFormat,
    RecipeSpec,
    ScanFrame,
    SourceKind,
    SplitAssignment,
    SplitRecipe,
    assign_split,
    sha256_hex,
)
from visionset.kernel.ports import Exporter, supported_modalities_of
from visionset.kernel.services import (
    CalibrationService,
    PreprocessingRecipeService,
    annotation_service,
    source_service,
)

CAR = Cuboid3DGeometry(center=(10.0, 0.0, 0.8), size=(4.2, 1.8, 1.5), yaw=0.25)
CLASSES = (
    *IMAGE_CLASSES,
    LabelClass(name="car_3d", geometries=(GeometryType.CUBOID_3D,)),
    LabelClass(name="night", geometries=(GeometryType.CLASSIFICATION_TAG,)),
)
NAN_ONLY = pcd_ascii(((float("nan"), 0.0, 0.0), (0.0, float("nan"), 1.0)))


def _car(**change: Any) -> Annotation:
    return Annotation(
        asset_id=uuid4(), label_class="car_3d", schema_version=1, geometry=CAR, provenance="human"
    ).model_copy(update=change)


class Scans(Fixture):
    """A project with a batch of images and, once :meth:`read` runs, a batch of scans."""

    def __init__(self, tmp_path: Path) -> None:
        super().__init__(tmp_path, images=2, classes=CLASSES)
        self.image_batch_id = self.batch_id
        self.directory = write_scans(tmp_path / "scans")

    def read(self, frame: ScanFrame = ScanFrame.LIDAR_FLU) -> Any:
        self.source = self.sources.register_point_clouds(
            self.project.id, self.directory, frame=frame
        )
        run = self.ingest.ingest(self.source.id, batch_name="scans")
        self.scan_batch_id = run.batch_id
        return run

    def label_both(self, scans: dict[int, list[Annotation]]) -> None:
        self.label({0: [_box(x=1, y=1, width=4, height=4)]})
        self.batch_id = self.scan_batch_id
        self.label(scans)


@pytest.fixture
def scans(tmp_path: Path) -> Any:
    fixture = Scans(tmp_path)
    yield fixture
    fixture.close()


# --- registering --------------------------------------------------------------


def test_registering_a_scan_directory_is_idempotent_and_apart_from_images(scans: Scans) -> None:
    first = scans.sources.register_point_clouds(
        scans.project.id, scans.directory, frame=ScanFrame.LIDAR_FLU
    )
    again = scans.sources.register_point_clouds(
        scans.project.id, scans.directory, frame=ScanFrame.LIDAR_FLU
    )
    images = scans.sources.register_images(scans.project.id, scans.directory)

    assert again.id == first.id
    assert (first.kind, first.frame) == (SourceKind.POINT_CLOUD_DIRECTORY, ScanFrame.LIDAR_FLU)
    assert images.id != first.id and images.frame is None
    assert scans.sources.get(first.id) == first


def test_another_frame_replaces_the_declaration_while_nothing_is_labelled(scans: Scans) -> None:
    scans.read()
    moved = scans.sources.register_point_clouds(
        scans.project.id, scans.directory, frame=ScanFrame.CAMERA_RDF
    )
    assert moved.id == scans.source.id
    assert scans.sources.get(moved.id).frame is ScanFrame.CAMERA_RDF


def test_another_frame_is_refused_under_a_stored_3d_label(scans: Scans) -> None:
    scans.read()
    scans.label_both({0: [_car()]})

    with pytest.raises(CalibrationInUse, match="lidar_flu"):
        scans.sources.register_point_clouds(
            scans.project.id, scans.directory, frame=ScanFrame.CAMERA_RDF
        )
    assert scans.sources.get(scans.source.id).frame is ScanFrame.LIDAR_FLU


# --- ingesting ---------------------------------------------------------------


def test_ingest_reads_each_scan_by_its_bytes_into_a_point_cloud_asset(scans: Scans) -> None:
    run = scans.read()

    assert run.failed == 0 and run.created == 2
    by_uri = {Path(asset.uri).name: asset for asset in run.assets}
    front, rear = by_uri["front.bin"], by_uri["rear.dat"]
    for asset in (front, rear):
        assert asset.modality == "point_cloud"
        assert (asset.width, asset.height, asset.format, asset.calibration) == (None,) * 4
        assert asset.source_id == scans.source.id
    assert front.point_cloud is not None and rear.point_cloud is not None
    assert front.point_cloud.format is PointCloudFormat.PCD
    assert rear.point_cloud.format is PointCloudFormat.PLY
    assert front.point_cloud.point_count == len(SCAN)
    assert front.point_cloud.bounds.maximum == (10.0, 4.0, 3.0)
    assert rear.point_cloud.fields == ("x", "y", "z", "intensity")
    assert scans.ingest.asset(scans.project.id, front.id) == front


def test_a_scan_gets_a_top_down_jpeg_thumbnail(scans: Scans) -> None:
    run = scans.read()
    asset = run.assets[0]
    with scans.ingest.open_thumbnail(asset) as handle:
        preview = Image.open(io.BytesIO(handle.read()))
    assert preview.format == "JPEG"
    assert max(preview.size) == 256


def test_the_wrong_files_are_reported_and_leave_no_blob(scans: Scans) -> None:
    (scans.directory / "notes.txt").write_text("not a scan")
    (scans.directory / "empty.pcd").write_bytes(NAN_ONLY)
    (scans.directory / "cut.pcd").write_bytes(pcd_ascii()[:-12])
    run = scans.read()

    kinds = {failure.name: failure.kind for failure in run.failures}
    assert kinds == {
        "notes.txt": IngestFailureKind.UNSUPPORTED,
        "empty.pcd": IngestFailureKind.CORRUPT,
        "cut.pcd": IngestFailureKind.CORRUPT,
    }
    assert run.created == 2
    assert not scans.workspace.blob_store.exists(sha256_hex(NAN_ONLY))


def test_an_image_in_a_scan_directory_is_not_a_scan(scans: Scans, tmp_path: Path) -> None:
    still = next((tmp_path / "incoming").iterdir())
    (scans.directory / "photo.png").write_bytes(still.read_bytes())
    run = scans.read()
    (failure,) = run.failures
    assert (failure.name, failure.kind) == ("photo.png", IngestFailureKind.UNSUPPORTED)


def test_the_thumbnail_backfill_renders_a_scan_in_its_frame(scans: Scans) -> None:
    run = scans.read(ScanFrame.CAMERA_RDF)
    asset = run.assets[0]
    with scans.workspace.unit_of_work() as uow:
        uow.assets.update(asset.model_copy(update={"thumbnail_hash": None}))

    backfill = scans.ingest.backfill_thumbnails(scans.project.id)

    assert asset.id in backfill.filled and not backfill.unreadable
    with scans.workspace.blob_store.get(asset.content_hash) as content:
        expected = scans.workspace.point_cloud_processor.thumbnail(
            content, frame=ScanFrame.CAMERA_RDF
        )
    refreshed = scans.ingest.asset(scans.project.id, asset.id)
    assert refreshed.thumbnail_hash == sha256_hex(expected)


# --- labelling ---------------------------------------------------------------


def _open_scan_job(scans: Scans) -> tuple[Any, list[Any]]:
    scans.batches.approve(scans.scan_batch_id)
    (job,) = scans.batches.jobs(scans.scan_batch_id)
    scans.batches.start(scans.scan_batch_id)
    scans.jobs.start(job.id)
    return job, scans.batches.assets(scans.scan_batch_id)


def test_a_cuboid_on_a_scan_needs_no_calibration(scans: Scans) -> None:
    scans.read()
    job, assets = _open_scan_job(scans)
    tag = Annotation(
        asset_id=assets[0].id,
        label_class="night",
        schema_version=1,
        geometry=ClassificationGeometry(),
        provenance="human",
    )

    stored = scans.annotations.add(job.id, [_car(asset_id=assets[0].id), tag])
    assert [one.geometry for one in stored] == [CAR, ClassificationGeometry()]


def test_a_pixel_shape_on_a_scan_is_refused(scans: Scans) -> None:
    scans.read()
    job, assets = _open_scan_job(scans)
    box = _box(x=1, y=1, width=4, height=4).model_copy(update={"asset_id": assets[0].id})

    with pytest.raises(InvalidAnnotation, match="no pixels"):
        scans.annotations.add(job.id, [box])
    assert scans.annotations.for_asset(job.id, assets[0].id) == []


def test_a_scan_and_its_source_refuse_a_camera_calibration(scans: Scans) -> None:
    run = scans.read()
    calibrations = CalibrationService(scans.workspace)
    with pytest.raises(CalibrationNotApplicable):
        calibrations.set_asset_calibration(
            scans.project.id, run.assets[0].id, calibration(width=4, height=3)
        )
    with pytest.raises(CalibrationNotApplicable, match="lidar_flu"):
        calibrations.set_source_calibration(scans.source.id, calibration(width=4, height=3))


def test_no_recipe_previews_a_scan(scans: Scans) -> None:
    run = scans.read()
    with pytest.raises(UnsupportedMedia):
        PreprocessingRecipeService(scans.workspace).preview(
            scans.project.id,
            RecipeSpec(target=None, steps=()),
            run.assets[0].id,
            variant=0,
            drivers={},
        )


# --- publishing and exporting ---------------------------------------------------


def test_a_release_holding_a_scan_is_a_version_5_manifest(scans: Scans) -> None:
    scans.read()
    scans.label_both({0: [_car()]})
    release_id = scans.publish()
    manifest = scans.releases.manifest(release_id)

    assert manifest.manifest_version == 5
    scan_assets = [asset for asset in manifest.assets if asset.modality == "point_cloud"]
    assert len(scan_assets) == 2
    assert {asset.frame for asset in scan_assets} == {ScanFrame.LIDAR_FLU}
    assert all(asset.point_cloud is not None for asset in scan_assets)
    labelled = [asset for asset in scan_assets if asset.annotations]
    assert [one.geometry for one in labelled[0].annotations] == [CAR]
    assert labelled[0].calibration is None
    assert scans.releases.verify(release_id).ok


def test_an_image_only_release_keeps_version_3(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, classes=CLASSES)
    try:
        fixture.label({0: [_box(x=1, y=1, width=4, height=4)]})
        assert fixture.releases.manifest(fixture.publish()).manifest_version == 3
    finally:
        fixture.close()


@pytest.mark.parametrize(
    "format_name",
    sorted(
        name for name, one in exporters().items() if "point_cloud" not in one.supported_modalities
    ),
)
def test_every_installed_format_drops_the_scans_by_count(scans: Scans, format_name: str) -> None:
    scans.read()
    scans.label_both({0: [_car()]})
    release_id = scans.publish()
    exporter = exporters()[format_name]

    report = scans.releases.check_export(release_id, exporter)

    (row,) = report.dropped_modalities
    assert (row.modality, row.assets, row.annotations) == ("point_cloud", 2, 1)
    assert format_name in row.reason
    assert not report.compatible
    assert report.excluded_assets >= 2 and report.excluded_annotations >= 1
    assert all(one.label_class != "car_3d" or one.annotations == 0 for one in report.classes)
    (car,) = [one for one in report.classes if one.label_class == "car_3d"]
    assert car.reason is not None and "1 label(s)" in car.reason
    assert "dropped_modalities" in car.reason


def test_an_export_refuses_without_consent_and_writes_only_images_with_it(
    scans: Scans, tmp_path: Path
) -> None:
    scans.read()
    scans.label_both({})
    release_id = scans.publish()
    coco = exporters()["coco"]

    with pytest.raises(LossyExportNotConsented):
        scans.releases.export(release_id, coco, tmp_path / "refused")
    result = scans.releases.export(release_id, coco, tmp_path / "out", allow_lossy=True)

    assert result.source_file_count == 2
    report = json.loads((tmp_path / "out" / "visionset-export-report.json").read_text())
    assert report["dropped_modalities"][0]["assets"] == 2
    scan_bytes = (scans.directory / "front.bin").read_bytes()
    assert not any(
        path.is_file() and path.read_bytes() == scan_bytes for path in (tmp_path / "out").rglob("*")
    )


def test_no_shipped_format_writes_a_scan() -> None:
    shipped = {
        name: one
        for name, one in exporters().items()
        if type(one).__module__.startswith("visionset.formats")
    }
    assert shipped
    assert all("point_cloud" not in one.supported_modalities for one in shipped.values())


def test_a_format_declaring_point_clouds_is_handed_them(scans: Scans) -> None:
    scans.read()
    scans.label_both({0: [_car()]})
    release_id = scans.publish()
    (exporter,) = [one for one in exporters().values() if "point_cloud" in one.supported_modalities]

    report = scans.releases.check_export(release_id, exporter)

    assert report.dropped_modalities == ()
    assert sum(one.annotations for one in report.classes if one.label_class == "car_3d") == 1


def test_a_frame_change_checks_for_labels_under_the_write_lock(
    scans: Scans, monkeypatch: pytest.MonkeyPatch
) -> None:
    scans.read()
    order: list[str] = []
    real_hold = SqlUnitOfWork.hold_writes
    real_check = source_service._require_no_scan_labels

    def hold(uow: Any) -> None:
        order.append("lock")
        real_hold(uow)

    def check(uow: Any, source: Any) -> None:
        order.append("check")
        real_check(uow, source)

    monkeypatch.setattr(SqlUnitOfWork, "hold_writes", hold)
    monkeypatch.setattr(source_service, "_require_no_scan_labels", check)
    scans.sources.register_point_clouds(
        scans.project.id, scans.directory, frame=ScanFrame.CAMERA_RDF
    )

    assert order[:2] == ["lock", "check"]


def test_the_preview_refusal_names_the_scan(scans: Scans) -> None:
    run = scans.read()
    with pytest.raises(UnsupportedMedia, match="is a point_cloud, and this reads images only"):
        PreprocessingRecipeService(scans.workspace).preview(
            scans.project.id,
            RecipeSpec(target=None, steps=()),
            run.assets[0].id,
            variant=0,
            drivers={},
        )


def test_a_3d_label_on_a_scan_with_no_frame_is_refused_by_the_write_funnel(
    scans: Scans,
) -> None:
    run = scans.read()
    orphan = run.assets[0].model_copy(update={"source_id": None})
    with scans.workspace.unit_of_work() as uow:
        uow.assets.update(orphan)
        with pytest.raises(CalibrationMissing, match="no source"):
            annotation_service._require_geometry_on_asset(uow, _car(asset_id=orphan.id))


def test_a_hostile_scan_is_one_corrupt_file_and_leaves_no_blob(scans: Scans) -> None:
    hostile = {
        "padding.pcd": (
            b"VERSION .7\nFIELDS x y z _\nSIZE 4 4 4 -8\nTYPE F F F U\nCOUNT 1 1 1 1\n"
            b"WIDTH 5\nHEIGHT 1\nPOINTS 5\nDATA binary\n" + b"\0" * 100
        ),
        "faces.ply": (
            b"ply\nformat binary_little_endian 1.0\nelement junk 99999999999999999999\n"
            b"property float a\nelement vertex 1\nproperty float x\nproperty float y\n"
            b"property float z\nend_header\n" + b"\0" * 12
        ),
    }
    for name, data in hostile.items():
        (scans.directory / name).write_bytes(data)
    run = scans.read()

    assert {f.name: f.kind for f in run.failures} == dict.fromkeys(
        hostile, IngestFailureKind.CORRUPT
    )
    assert run.created == 2
    for data in hostile.values():
        assert not scans.workspace.blob_store.exists(sha256_hex(data))


def test_a_scan_too_small_to_spread_still_gets_a_preview(scans: Scans) -> None:
    (scans.directory / "speck.pcd").write_bytes(pcd_ascii(((0.0, 0.0, 0.0), (1e-310, 0.0, 0.0))))
    run = scans.read()
    speck = next(asset for asset in run.assets if asset.uri.endswith("speck.pcd"))
    assert speck.thumbnail_hash is not None


# --- folds when a release mixes modalities ------------------------------------


def _mixed_release(tmp_path: Path, *, images: int, scans: int) -> tuple[Fixture, Any]:
    fixture = Fixture(tmp_path, images=images, classes=CLASSES)
    directory = tmp_path / "many-scans"
    directory.mkdir()
    for index in range(scans):
        (directory / f"scan-{index}.pcd").write_bytes(
            pcd_ascii(tuple((x + index, y, z) for x, y, z in SCAN))
        )
    image_batch = fixture.batch_id
    source = fixture.sources.register_point_clouds(
        fixture.project.id, directory, frame=ScanFrame.LIDAR_FLU
    )
    scan_batch = fixture.ingest.ingest(source.id, batch_name="scans").batch_id
    fixture.label({})
    fixture.batch_id = scan_batch
    fixture.label({})
    fixture.batch_id = image_batch
    unsplit = fixture.releases.manifest(fixture.publish("unsplit"))
    images_only = [one for one in unsplit.assets if one.modality == "image"]
    seed = next(
        seed
        for seed in range(50)
        if assign_split(SplitRecipe(train=0.8, val=0.1, test=0.1, seed=seed), images_only)
        != _restricted(
            assign_split(SplitRecipe(train=0.8, val=0.1, test=0.1, seed=seed), unsplit.assets),
            {one.asset_id for one in images_only},
        )
    )
    return fixture, fixture.publish(
        "split", split=SplitRecipe(train=0.8, val=0.1, test=0.1, seed=seed)
    )


def _restricted(assignment: SplitAssignment, kept: set[Any]) -> SplitAssignment:
    return SplitAssignment(
        train=tuple(one for one in assignment.train if one in kept),
        val=tuple(one for one in assignment.val if one in kept),
        test=tuple(one for one in assignment.test if one in kept),
    )


def test_an_image_export_of_a_mixed_release_writes_the_reported_folds(tmp_path: Path) -> None:
    fixture, release_id = _mixed_release(tmp_path, images=10, scans=10)
    manifest = fixture.releases.manifest(release_id)
    reported = fixture.releases.assignment(release_id)
    out = tmp_path / "out"
    driver = MarkingDriver()

    fixture.releases.export(
        release_id,
        exporters()["ultralytics"],
        out,
        allow_lossy=True,
        recipe=AUGMENTED,
        drivers=drivers_of(driver),
    )
    fixture.close()

    fold_of = {
        asset_id: fold
        for fold, members in (
            ("train", reported.train),
            ("val", reported.val),
            ("test", reported.test),
        )
        for asset_id in members
    }
    written = {path.stem: path.parent.name for path in (out / "images").rglob("*.png")}
    for asset in manifest.assets:
        if asset.modality == "image":
            assert written[asset.content_hash] == fold_of[asset.asset_id], asset.asset_id
    variants = {stem: fold for stem, fold in written.items() if "-aug" in stem}
    assert variants
    assert set(variants.values()) == {"train"}


def test_an_image_export_does_not_read_a_scan_blob(scans: Scans, tmp_path: Path) -> None:
    run = scans.read()
    scans.label_both({})
    release_id = scans.publish()
    scans.workspace.blob_store._path_for(run.assets[0].content_hash).unlink()  # type: ignore[attr-defined]

    result = scans.releases.export(
        release_id, exporters()["coco"], tmp_path / "out", allow_lossy=True
    )

    assert result.source_file_count == 2


class _PluginBeforeScans:
    """An exporter written before modalities and the handed split existed."""

    format_name = "before-scans"
    lossy = True
    supported_geometries = frozenset({GeometryType.BBOX})
    degraded_geometries: frozenset[GeometryType] = frozenset()

    def __init__(self) -> None:
        self.handed: list[str] = []
        self.targets = exporters()["coco"].targets

    def export(self, release: Any, manifest: Any, dest: Path, *, content: Any) -> None:
        self.handed = [asset.modality for asset in manifest.assets]


def test_a_plugin_declaring_no_modalities_writes_images_and_reports_scans_dropped(
    scans: Scans, tmp_path: Path
) -> None:
    scans.read()
    scans.label_both({})
    release_id = scans.publish(split=SplitRecipe(train=0.5, val=0.5, test=0.0, seed=1))
    plugin = _PluginBeforeScans()
    assert isinstance(plugin, Exporter)

    report = scans.releases.check_export(release_id, plugin)
    scans.releases.export(release_id, plugin, tmp_path / "out", allow_lossy=True)

    (row,) = report.dropped_modalities
    assert (row.modality, row.assets) == ("point_cloud", 2)
    assert plugin.handed == ["image", "image"]
    assert supported_modalities_of(plugin) == frozenset({"image"})
