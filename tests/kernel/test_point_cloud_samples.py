"""Opt-in: every real PCD and PLY under ``VISIONSET_POINTCLOUD_SAMPLES``, read and ingested.

Skipped unless the variable names a directory. The samples stay outside the
repository; CI runs the synthetic scans in ``test_point_cloud_processor.py``.
"""

from __future__ import annotations

import io
import math
import os
from pathlib import Path

import pytest
from PIL import Image

from visionset.kernel.adapters import StdlibPointCloudProcessor
from visionset.kernel.domain import MIN_POINT_BUDGET, ScanFrame
from visionset.kernel.services import (
    IngestService,
    ProjectService,
    SourceService,
    WorkspaceService,
)

SAMPLES = os.environ.get("VISIONSET_POINTCLOUD_SAMPLES")

pytestmark = pytest.mark.skipif(not SAMPLES, reason="VISIONSET_POINTCLOUD_SAMPLES is not set")


def _files() -> list[Path]:
    if not SAMPLES:
        return []
    root = Path(SAMPLES)
    return sorted([*root.rglob("*.pcd"), *root.rglob("*.ply")])


def test_the_directory_holds_samples() -> None:
    assert _files()


@pytest.mark.parametrize("path", _files(), ids=lambda p: p.name)
@pytest.mark.parametrize("frame", list(ScanFrame))
def test_each_sample_probes_and_draws(path: Path, frame: ScanFrame) -> None:
    processor = StdlibPointCloudProcessor()
    with path.open("rb") as handle:
        metadata = processor.probe(handle)
        jpeg = processor.thumbnail(handle, frame=frame, max_edge=128)

    assert metadata.point_count >= 1
    assert all(math.isfinite(v) for v in (*metadata.bounds.minimum, *metadata.bounds.maximum))
    with Image.open(io.BytesIO(jpeg)) as preview:
        assert preview.format == "JPEG"
        assert max(preview.size) == 128


def test_every_sample_directory_ingests_without_a_failure(tmp_path: Path) -> None:
    directories = sorted({path.parent for path in _files()})
    with WorkspaceService.init(tmp_path / "ws") as workspace:
        project = ProjectService(workspace).create("samples")
        for directory in directories:
            source = SourceService(workspace).register_point_clouds(
                project.id, directory, frame=ScanFrame.LIDAR_FLU
            )
            run = IngestService(workspace).ingest(source.id)
            scans = [path for path in directory.iterdir() if path.suffix in {".pcd", ".ply"}]
            assert run.failures == ()
            assert run.created == len(scans)
            assert all(asset.thumbnail_hash is not None for asset in run.assets)


@pytest.mark.parametrize("path", _files(), ids=lambda p: p.name)
def test_each_sample_thins_to_the_minimum_budget(path: Path) -> None:
    processor = StdlibPointCloudProcessor()
    with path.open("rb") as handle:
        metadata = processor.probe(handle)
        sample = processor.sample(handle, budget=MIN_POINT_BUDGET)

    assert sample.total == metadata.point_count
    assert 1 <= sample.count <= MIN_POINT_BUDGET
    assert ("intensity" in metadata.fields) == (sample.intensity is not None)
    origin = 24 if any(sample.origin) else 0
    assert len(sample.encode()) == 16 + origin + 12 * sample.count + len(
        sample.intensity or b""
    ) + len(sample.rgb or b"")
