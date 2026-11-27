"""`mask` through MCP: the same canonical form REST stores, and the same refusals."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Final

import pytest
from tests.mcp._flow import SCHEMA_CLASSES, call, open_batch, payload

from visionset.kernel.domain import encode_counts

ROAD: Final[dict[str, Any]] = {"name": "road", "geometries": ["mask"]}


def _label(asset: dict[str, Any], size: list[int], counts: str) -> dict[str, Any]:
    return {
        "asset_id": asset["id"],
        "label_class": "road",
        "geometry": {"type": "mask", "size": size, "counts": counts},
        "provenance": "human",
    }


def test_a_mask_is_written_and_read_back_canonical(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1, classes=[*SCHEMA_CLASSES, ROAD])
    (asset,) = payload(call("next_pending_assets", job_id=job_id, count=1))["items"]
    height, width = asset["height"], asset["width"]
    total = height * width

    written = payload(
        call(
            "add_annotations",
            job_id=job_id,
            annotations=[_label(asset, [height, width], encode_counts([1, 0, total - 2, 1]))],
        )
    )

    assert written["items"][0]["geometry"] == {
        "type": "mask",
        "size": [height, width],
        "counts": encode_counts([total - 1, 1]),
    }


def test_a_mask_of_another_size_is_refused(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1, classes=[*SCHEMA_CLASSES, ROAD])
    (asset,) = payload(call("next_pending_assets", job_id=job_id, count=1))["items"]
    height, width = asset["height"], asset["width"]

    refused = call(
        "add_annotations",
        job_id=job_id,
        annotations=[_label(asset, [height + 1, width], encode_counts([(height + 1) * width]))],
    )

    assert "ANNOTATION_GEOMETRY_OUT_OF_BOUNDS" in str(refused)


def test_the_geometry_topic_describes_the_mask() -> None:
    from visionset.mcp._topics import ANNOTATION_GEOMETRY

    assert "`mask`" in ANNOTATION_GEOMETRY
    assert "column-major" in ANNOTATION_GEOMETRY
