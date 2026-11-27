"""A rotated box through every writing exporter: native, reduced where declared, else dropped.

The report is read against the bytes, as in ``test_report_agreement``: a format
writing ``obb`` natively writes every rotated box as itself, one calling it
degraded writes every rotated box as its enclosing axis-aligned box, and one
calling it dropped writes none of them.
"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from tests.formats.test_report_agreement import COUNTERS
from tests.formats.test_ultralytics import CLASSES, IMAGE_SIZE, Fixture, _box

from visionset.formats.registry import exporters
from visionset.kernel.domain import (
    OBB_MANIFEST_VERSION,
    Annotation,
    ClassExportStatus,
    GeometryType,
    LabelClass,
    ObbGeometry,
    obb_enclosing_box,
)

SHIP = LabelClass(name="ship", geometries=(GeometryType.OBB,))
ROTATED = ObbGeometry(cx=32.0, cy=24.0, width=20.0, height=8.0, angle=0.5)

#: The formats that write a rotated box as the axis-aligned box around it.
REDUCING = frozenset({"voc", "darknet", "yolov5-yaml"})

#: The formats that write a rotated box as itself, and nothing else.
NATIVE = frozenset({"yolo-obb", "dota"})

#: The formats that write a rotated box as itself beside other geometries.
CARRYING = frozenset({"cvat-images", "cvat-video"})


def _ship(geometry: ObbGeometry = ROTATED) -> Annotation:
    return Annotation(
        asset_id=uuid4(),
        label_class="ship",
        schema_version=1,
        geometry=geometry,
        provenance="human",
    )


@pytest.fixture
def labelled(tmp_path: Path) -> Fixture:
    fixture = Fixture(tmp_path, classes=(*CLASSES, SHIP))
    fixture.label({0: [_box(x=8, y=6, width=20, height=22), _ship()], 1: [_ship()]})
    return fixture


def test_the_release_holding_a_rotated_box_is_a_version_8_manifest(labelled: Fixture) -> None:
    release_id = labelled.publish()
    manifest = labelled.releases.manifest(release_id)
    labelled.close()

    assert manifest.manifest_version == OBB_MANIFEST_VERSION
    held = [one.geometry for asset in manifest.assets for one in asset.annotations]
    assert held.count(ROTATED) == 2


def test_every_writing_exporter_is_covered() -> None:
    assert set(COUNTERS) >= REDUCING | NATIVE
    for name in REDUCING:
        assert GeometryType.OBB in exporters()[name].degraded_geometries
    for name in NATIVE:
        assert exporters()[name].supported_geometries == {GeometryType.OBB}
        assert exporters()[name].degraded_geometries == frozenset()
    for name in CARRYING:
        assert GeometryType.OBB in exporters()[name].supported_geometries
        assert GeometryType.BBOX in exporters()[name].supported_geometries
    for name in set(COUNTERS) - REDUCING - NATIVE - CARRYING:
        plugin = exporters()[name]
        assert GeometryType.OBB not in plugin.supported_geometries | plugin.degraded_geometries


@pytest.mark.parametrize("format_name", sorted(COUNTERS))
def test_the_report_agrees_with_what_was_written(
    tmp_path: Path, labelled: Fixture, format_name: str
) -> None:
    release_id = labelled.publish()
    dest = tmp_path / f"out-{format_name}"
    report = labelled.releases.export(
        release_id, exporters()[format_name], dest, allow_lossy=True
    ).compatibility
    written = COUNTERS[format_name](dest)
    labelled.close()

    (ship,) = [one for one in report.classes if one.label_class == "ship"]
    assert ship.annotations == 2
    if format_name in NATIVE:
        assert ship.status is ClassExportStatus.SUPPORTED
        assert written["ship"] == 2
        # The one box beside the ships is the one thing a rotated-box format drops.
        assert (report.excluded_annotations, report.degraded_annotations) == (1, 0)
        return
    if format_name in CARRYING and not getattr(exporters()[format_name], "tracked_only", False):
        assert ship.status is ClassExportStatus.SUPPORTED
        assert written["ship"] == 2
        assert (report.excluded_annotations, report.degraded_annotations) == (0, 0)
        return
    if format_name in REDUCING:
        assert ship.status is ClassExportStatus.DEGRADED
        assert ship.reason is not None and "bounding box" in ship.reason
        assert written["ship"] == 2
    else:
        assert ship.status is ClassExportStatus.DROPPED
        assert written["ship"] == 0
    assert report.excluded_annotations + report.degraded_annotations >= 2


def test_darknet_writes_the_enclosing_box(tmp_path: Path, labelled: Fixture) -> None:
    release_id = labelled.publish()
    dest = tmp_path / "out"
    labelled.releases.export(release_id, exporters()["darknet"], dest, allow_lossy=True)
    labelled.close()

    names = (dest / "obj.names").read_text(encoding="utf-8").splitlines()
    ship_index = names.index("ship")
    rows = [
        line.split()
        for path in sorted((dest / "labels").rglob("*.txt"))
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.split()[0] == str(ship_index)
    ]
    box = obb_enclosing_box(ROTATED)
    width, height = IMAGE_SIZE
    expected = [
        (box.x + box.width / 2) / width,
        (box.y + box.height / 2) / height,
        box.width / width,
        box.height / height,
    ]

    assert len(rows) == 2
    for row in rows:
        assert [float(value) for value in row[1:]] == pytest.approx(expected, abs=1e-6)
