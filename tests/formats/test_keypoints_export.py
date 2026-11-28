"""Keypoints through every exporter: COCO and Ultralytics write them, every other report drops them.

The keypoints are written through the annotation service, promoted and frozen into a
release before any export, so this is also the store and release round trip. What the
two pose writers put on disk is ``test_coco_keypoints.py``'s and ``test_yolo_pose.py``'s.
"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from tests.formats.test_report_agreement import COUNTERS
from tests.formats.test_ultralytics import CLASSES, Fixture, _box

from visionset.formats.registry import exporters
from visionset.kernel.domain import (
    KEYPOINTS_MANIFEST_VERSION,
    Annotation,
    ClassExportStatus,
    ExportCompatibility,
    GeometryType,
    KeypointsGeometry,
    KeypointSpec,
    LabelClass,
    VertexVisibility,
)
from visionset.kernel.errors import LossyExportNotConsented

FACE = LabelClass(
    name="face",
    geometries=(GeometryType.KEYPOINTS,),
    keypoints=KeypointSpec(names=("left_eye", "right_eye", "nose"), skeleton=((0, 1), (2, 0))),
)
KEYPOINTS = KeypointsGeometry(
    points=[(10.0, 8.0), (10.0, 8.0), (30.5, 20.25)],
    visibility=(VertexVisibility.VISIBLE, VertexVisibility.UNLABELED, VertexVisibility.OCCLUDED),
)

#: Every exporter this distribution ships; a test plugin installed beside it is not one.
SHIPPED = sorted(
    name
    for name, plugin in exporters().items()
    if type(plugin).__module__.startswith("visionset.formats.")
)

#: The exporters that write keypoints whole: COCO keypoints and Ultralytics pose.
WRITING_KEYPOINTS = frozenset({"coco", "ultralytics"})


def _face() -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="face",
        schema_version=1,
        geometry=KEYPOINTS,
        provenance="human",
    )


@pytest.fixture
def labelled(tmp_path: Path) -> Fixture:
    fixture = Fixture(tmp_path, classes=(*CLASSES, FACE))
    fixture.label({0: [_box(x=8, y=6, width=20, height=22), _face()], 1: [_face()]})
    return fixture


def test_keypoints_and_the_spec_survive_the_store_and_the_release_unchanged(
    labelled: Fixture,
) -> None:
    release_id = labelled.publish()
    manifest = labelled.releases.manifest(release_id)
    labelled.close()

    assert manifest.manifest_version == KEYPOINTS_MANIFEST_VERSION
    assert FACE in manifest.classes
    held = [one.geometry for asset in manifest.assets for one in asset.annotations]
    assert held.count(KEYPOINTS) == 2


@pytest.mark.parametrize("format_name", sorted(WRITING_KEYPOINTS))
def test_the_keypoint_writers_declare_keypoints_written_whole(format_name: str) -> None:
    plugin = exporters()[format_name]
    assert GeometryType.KEYPOINTS in plugin.supported_geometries
    assert GeometryType.KEYPOINTS not in plugin.degraded_geometries


@pytest.mark.parametrize("format_name", sorted(set(SHIPPED) - WRITING_KEYPOINTS))
def test_no_other_exporter_declares_keypoints(format_name: str) -> None:
    plugin = exporters()[format_name]
    assert GeometryType.KEYPOINTS not in plugin.supported_geometries | plugin.degraded_geometries


def test_coco_writes_every_keypoints_label_and_reports_the_class_supported(
    tmp_path: Path, labelled: Fixture
) -> None:
    release_id = labelled.publish()
    dest = tmp_path / "out"
    report = labelled.releases.export(release_id, exporters()["coco"], dest).compatibility
    written = COUNTERS["coco"](dest)
    labelled.close()

    (face,) = [one for one in report.classes if one.label_class == "face"]
    assert face.status is ClassExportStatus.SUPPORTED
    assert written["face"] == 2
    assert report.compatible


@pytest.mark.parametrize("format_name", sorted(set(COUNTERS) - WRITING_KEYPOINTS))
def test_every_writing_exporter_drops_the_keypoints_and_says_so(
    tmp_path: Path, labelled: Fixture, format_name: str
) -> None:
    release_id = labelled.publish()
    dest = tmp_path / f"out-{format_name}"
    report = labelled.releases.export(
        release_id, exporters()[format_name], dest, allow_lossy=True
    ).compatibility
    written = COUNTERS[format_name](dest)
    labelled.close()

    (face,) = [one for one in report.classes if one.label_class == "face"]
    assert face.annotations == 2
    assert face.status is ClassExportStatus.DROPPED
    assert face.reason is not None and "keypoints" in face.reason
    assert written["face"] == 0
    assert report.excluded_annotations >= 2


@pytest.mark.parametrize("format_name", sorted(set(SHIPPED) - set(COUNTERS) - WRITING_KEYPOINTS))
def test_every_other_exporter_reports_the_keypoints_dropped(
    labelled: Fixture, format_name: str
) -> None:
    release_id = labelled.publish()
    report = labelled.releases.check_export(release_id, exporters()[format_name])
    labelled.close()

    (face,) = [one for one in report.classes if one.label_class == "face"]
    assert face.status is ClassExportStatus.DROPPED


def test_an_export_dropping_keypoints_is_refused_without_consent(
    tmp_path: Path, labelled: Fixture
) -> None:
    release_id = labelled.publish()
    dest = tmp_path / "out"

    with pytest.raises(LossyExportNotConsented) as refused:
        labelled.releases.export(release_id, exporters()["voc"], dest)
    labelled.close()

    assert not dest.exists()
    compatibility = refused.value.compatibility
    assert isinstance(compatibility, ExportCompatibility)
    (face,) = [one for one in compatibility.classes if one.label_class == "face"]
    assert face.status is ClassExportStatus.DROPPED
