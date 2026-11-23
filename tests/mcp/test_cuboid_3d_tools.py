"""`cuboid_3d` through MCP: the same refusal code as REST, and written once calibrated."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Final

import pytest
from tests.fixtures.calibration import calibration_document
from tests.mcp._flow import SCHEMA_CLASSES, call, error, open_batch, payload

CAR_3D: Final[dict[str, Any]] = {"name": "car_3d", "geometries": ["cuboid_3d"]}
BOX: Final[dict[str, Any]] = {
    "type": "cuboid_3d",
    "center": [-2.5, 0.75, 12.0],
    "size": [4.5, 1.9, 1.6],
    "yaw": -0.4,
}


def test_a_cuboid_is_refused_by_code_until_its_asset_is_calibrated(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named, _, job_id = open_batch(monkeypatch, tmp_path, count=1, classes=[*SCHEMA_CLASSES, CAR_3D])
    (asset,) = payload(call("next_pending_assets", job_id=job_id, count=1))["items"]
    label = {
        "asset_id": asset["id"],
        "label_class": "car_3d",
        "geometry": BOX,
        "provenance": "human",
    }

    refused = error(call("add_annotations", job_id=job_id, annotations=[label]))
    assert refused["code"] == "CALIBRATION_MISSING"

    payload(
        call(
            "set_calibration",
            project=named,
            asset_id=asset["id"],
            calibration=calibration_document(),
        )
    )
    written = payload(call("add_annotations", job_id=job_id, annotations=[label]))
    assert written["items"][0]["geometry"] == BOX


def test_the_geometry_topic_describes_the_cuboid() -> None:
    from visionset.mcp._topics import ANNOTATION_GEOMETRY

    assert "cuboid_3d" in ANNOTATION_GEOMETRY
    assert "[-pi, pi]" in ANNOTATION_GEOMETRY


def test_the_geometry_topic_describes_labels_on_a_scan() -> None:
    from visionset.mcp._topics import ANNOTATION_GEOMETRY

    assert "`(cos yaw, sin yaw, 0)`" in ANNOTATION_GEOMETRY
    assert "`lidar_flu`" in ANNOTATION_GEOMETRY
    assert "`CALIBRATION_NOT_APPLICABLE`" in ANNOTATION_GEOMETRY
    assert "are refused with `INVALID_ANNOTATION`" in ANNOTATION_GEOMETRY
