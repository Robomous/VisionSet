"""A release holding only point-cloud scans exports through every installed format (#1232)."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from tests.fixtures.nuscenes_source import build
from tests.formats.test_kitti_samples import Published, publish
from tests.formats.test_nuscenes_tracks import _scene

from visionset.formats.darknet import DarknetExporter
from visionset.formats.nuscenes import NuScenesImporter
from visionset.formats.registry import exporters
from visionset.formats.ultralytics import UltralyticsExporter
from visionset.formats.yolo_obb import YoloObbExporter
from visionset.formats.yolov5_yaml import Yolov5YamlExporter
from visionset.kernel.ports import Exporter, supported_modalities_of
from visionset.kernel.services import EXPORT_REPORT_FILENAME, WorkspaceService


@pytest.fixture
def scans_only(tmp_path: Path) -> Iterator[Published]:
    with WorkspaceService.init(tmp_path / "ws") as workspace:
        src = build(tmp_path / "src", _scene("k0", "k1")).write(tmp_path / "src")
        yield publish(workspace, NuScenesImporter(), src)


@pytest.mark.parametrize(
    "exporter",
    [DarknetExporter(), UltralyticsExporter(), YoloObbExporter(), Yolov5YamlExporter()],
    ids=lambda exporter: exporter.format_name,
)
def test_a_yolo_dialect_writes_nothing_and_reports_the_scans_dropped(
    scans_only: Published, tmp_path: Path, exporter: Exporter
) -> None:
    dest = tmp_path / "out"

    result = scans_only.releases.export(scans_only.release_id, exporter, dest, allow_lossy=True)

    (dropped,) = result.compatibility.dropped_modalities
    assert (dropped.modality, dropped.assets, dropped.annotations) == ("point_cloud", 2, 3)
    assert result.file_count == 0
    assert [path.name for path in dest.iterdir()] == [EXPORT_REPORT_FILENAME]


@pytest.mark.parametrize("format_name", sorted(exporters()))
def test_every_installed_exporter_exports_a_scans_only_release(
    scans_only: Published, tmp_path: Path, format_name: str
) -> None:
    exporter = exporters()[format_name]

    result = scans_only.releases.export(
        scans_only.release_id, exporter, tmp_path / "out", allow_lossy=True
    )

    dropped = [row.modality for row in result.compatibility.dropped_modalities]
    expected = [] if "point_cloud" in supported_modalities_of(exporter) else ["point_cloud"]
    assert dropped == expected
