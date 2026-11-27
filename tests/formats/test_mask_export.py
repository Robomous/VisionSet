"""A raster mask through every exporter: the mask writers write it, every other report drops it.

The mask is written through the annotation service, promoted, frozen into a release and
read back before any export, so this is also the store and release round trip.
"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from tests.formats.test_report_agreement import COUNTERS
from tests.formats.test_ultralytics import CLASSES, IMAGE_SIZE, Fixture, _box

from visionset.formats.registry import exporters
from visionset.kernel.domain import (
    MASK_MANIFEST_VERSION,
    Annotation,
    ClassExportStatus,
    GeometryType,
    LabelClass,
    MaskGeometry,
    rasterize_rings,
)
from visionset.kernel.errors import AnnotationGeometryOutOfBounds

ROAD = LabelClass(name="road", geometries=(GeometryType.MASK,))
WIDTH, HEIGHT = IMAGE_SIZE
# A ring with a hole beside a second region, at the fixture's image size.
MASK = rasterize_rings(
    [
        [(4.0, 4.0), (24.0, 4.0), (24.0, 24.0), (4.0, 24.0)],
        [(10.0, 10.0), (18.0, 10.0), (18.0, 18.0), (10.0, 18.0)],
        [(40.0, 30.0), (60.0, 30.0), (60.0, 44.0), (40.0, 44.0)],
    ],
    height=HEIGHT,
    width=WIDTH,
)


#: Every exporter this distribution ships; a test plugin installed beside it is not one.
SHIPPED = sorted(
    name
    for name, plugin in exporters().items()
    if type(plugin).__module__.startswith("visionset.formats.")
)


#: The exporters that write a mask; every other one drops it.
MASK_WRITERS = frozenset({"coco"})


def _road(geometry: MaskGeometry = MASK) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="road",
        schema_version=1,
        geometry=geometry,
        provenance="human",
    )


@pytest.fixture
def labelled(tmp_path: Path) -> Fixture:
    fixture = Fixture(tmp_path, classes=(*CLASSES, ROAD))
    fixture.label({0: [_box(x=8, y=6, width=20, height=22), _road()], 1: [_road()]})
    return fixture


def test_the_mask_survives_the_store_and_the_release_unchanged(labelled: Fixture) -> None:
    release_id = labelled.publish()
    manifest = labelled.releases.manifest(release_id)
    labelled.close()

    assert manifest.manifest_version == MASK_MANIFEST_VERSION
    held = [one.geometry for asset in manifest.assets for one in asset.annotations]
    assert held.count(MASK) == 2


def test_a_mask_of_another_size_than_its_asset_is_refused(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, images=1, classes=(*CLASSES, ROAD))
    fixture.batches.approve(fixture.batch_id)
    (job,) = fixture.batches.jobs(fixture.batch_id)
    fixture.batches.start(fixture.batch_id)
    fixture.jobs.start(job.id)
    (asset,) = fixture.batches.assets(fixture.batch_id)
    transposed = MaskGeometry(size=(WIDTH, HEIGHT), counts=MASK.counts)

    with pytest.raises(AnnotationGeometryOutOfBounds, match=r"\[height, width\]"):
        fixture.annotations.add(
            job.id, [_road(transposed).model_copy(update={"asset_id": asset.id})]
        )
    assert fixture.annotations.for_asset(job.id, asset.id) == []
    fixture.close()


@pytest.mark.parametrize("format_name", sorted(set(SHIPPED) - MASK_WRITERS))
def test_no_other_exporter_declares_a_mask(format_name: str) -> None:
    assert set(COUNTERS) <= set(SHIPPED)
    plugin = exporters()[format_name]
    assert GeometryType.MASK not in plugin.supported_geometries | plugin.degraded_geometries


@pytest.mark.parametrize("format_name", sorted(MASK_WRITERS))
def test_a_mask_writer_writes_every_mask_and_reports_it_supported(
    tmp_path: Path, labelled: Fixture, format_name: str
) -> None:
    plugin = exporters()[format_name]
    assert GeometryType.MASK in plugin.supported_geometries
    release_id = labelled.publish()
    dest = tmp_path / f"out-{format_name}"
    report = labelled.releases.export(release_id, plugin, dest, allow_lossy=True).compatibility
    written = COUNTERS[format_name](dest)
    labelled.close()

    (road,) = [one for one in report.classes if one.label_class == "road"]
    assert road.status is ClassExportStatus.SUPPORTED
    assert written["road"] == road.annotations == 2


@pytest.mark.parametrize("format_name", sorted(set(COUNTERS) - MASK_WRITERS))
def test_every_writing_exporter_drops_the_mask_and_says_so(
    tmp_path: Path, labelled: Fixture, format_name: str
) -> None:
    release_id = labelled.publish()
    dest = tmp_path / f"out-{format_name}"
    report = labelled.releases.export(
        release_id, exporters()[format_name], dest, allow_lossy=True
    ).compatibility
    written = COUNTERS[format_name](dest)
    labelled.close()

    (road,) = [one for one in report.classes if one.label_class == "road"]
    assert road.annotations == 2
    assert road.status is ClassExportStatus.DROPPED
    assert road.reason is not None and "mask" in road.reason
    assert written["road"] == 0
    assert report.excluded_annotations >= 2


@pytest.mark.parametrize("format_name", sorted(set(SHIPPED) - set(COUNTERS)))
def test_every_other_exporter_reports_the_mask_dropped(labelled: Fixture, format_name: str) -> None:
    release_id = labelled.publish()
    report = labelled.releases.check_export(release_id, exporters()[format_name])
    labelled.close()

    (road,) = [one for one in report.classes if one.label_class == "road"]
    assert road.status is ClassExportStatus.DROPPED
