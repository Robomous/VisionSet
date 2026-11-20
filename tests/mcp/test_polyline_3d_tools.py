"""`polyline_3d` through MCP: the same refusal code as REST, and written once calibrated."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Final

import pytest
from tests.fixtures.calibration import calibration_document
from tests.mcp._flow import SCHEMA_CLASSES, call, error, open_batch, payload

LANE_3D: Final[dict[str, Any]] = {"name": "lane_3d", "geometries": ["polyline_3d"]}
PATH: Final[dict[str, Any]] = {
    "type": "polyline_3d",
    "points": [[-1.75, 1.5, 6.0], [-1.7, 1.5, 18.25]],
    "visibility": [2, 1],
}


def test_a_3d_label_is_refused_by_code_until_its_asset_is_calibrated(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named, _, job_id = open_batch(
        monkeypatch, tmp_path, count=1, classes=[*SCHEMA_CLASSES, LANE_3D]
    )
    (asset,) = payload(call("next_pending_assets", job_id=job_id, count=1))["items"]
    label = {
        "asset_id": asset["id"],
        "label_class": "lane_3d",
        "geometry": PATH,
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
    assert written["items"][0]["geometry"] == PATH


def test_the_geometry_topic_says_a_3d_label_needs_a_calibration() -> None:
    from visionset.mcp._topics import ANNOTATION_GEOMETRY

    assert "polyline_3d" in ANNOTATION_GEOMETRY
    assert "CALIBRATION_MISSING" in ANNOTATION_GEOMETRY
