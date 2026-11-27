"""`obb` through MCP: the same canonical form REST stores."""

from __future__ import annotations

from math import pi
from pathlib import Path
from typing import Any, Final

import pytest
from tests.mcp._flow import SCHEMA_CLASSES, call, open_batch, payload

SHIP: Final[dict[str, Any]] = {"name": "ship", "geometries": ["obb"]}


def test_a_rotated_box_is_written_and_read_back_canonical(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1, classes=[*SCHEMA_CLASSES, SHIP])
    (asset,) = payload(call("next_pending_assets", job_id=job_id, count=1))["items"]
    label = {
        "asset_id": asset["id"],
        "label_class": "ship",
        "geometry": {
            "type": "obb",
            "cx": 5.0,
            "cy": 6.0,
            "width": 2.0,
            "height": 8.0,
            "angle": 0.0,
        },
        "provenance": "human",
    }

    written = payload(call("add_annotations", job_id=job_id, annotations=[label]))

    assert written["items"][0]["geometry"] == {
        "type": "obb",
        "cx": 5.0,
        "cy": 6.0,
        "width": 8.0,
        "height": 2.0,
        "angle": -pi / 2,
    }


def test_the_geometry_topic_describes_the_rotated_box() -> None:
    from visionset.mcp._topics import ANNOTATION_GEOMETRY

    assert "`obb`" in ANNOTATION_GEOMETRY
    assert "[-pi/2, pi/2)" in ANNOTATION_GEOMETRY
