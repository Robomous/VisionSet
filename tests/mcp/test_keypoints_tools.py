"""`keypoints` and the class keypoint spec through MCP, with the refusals REST gives."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Final

import pytest
from tests.mcp._flow import SCHEMA_CLASSES, call, error, open_batch, payload, project

SPEC: Final[dict[str, Any]] = {"names": ["left_eye", "right_eye", "nose"], "skeleton": [[2, 0]]}
FACE: Final[dict[str, Any]] = {"name": "face", "geometries": ["keypoints"], "keypoints": SPEC}
POINTS: Final = [[1.5, 2.25], [1.5, 2.25], [20.0, 10.5]]


def _face(asset: dict[str, Any], points: Any, **geometry: Any) -> dict[str, Any]:
    return {
        "asset_id": asset["id"],
        "label_class": "face",
        "geometry": {"type": "keypoints", "points": points, **geometry},
        "provenance": "human",
    }


def _working(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[str, dict[str, Any]]:
    _, _, job_id = open_batch(monkeypatch, tmp_path, count=1, classes=[*SCHEMA_CLASSES, FACE])
    (asset,) = payload(call("next_pending_assets", job_id=job_id, count=1))["items"]
    return job_id, asset


def test_the_schema_carries_the_spec_and_null_without_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    payload(call("create_schema_version", project=named, classes=[*SCHEMA_CLASSES, FACE]))

    classes = {
        one["name"]: one for one in payload(call("get_schema", project=named))["schema"]["classes"]
    }

    assert classes["face"]["keypoints"] == SPEC
    assert all(classes[one["name"]]["keypoints"] is None for one in SCHEMA_CLASSES)


def test_an_invalid_spec_is_refused_naming_the_field(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    named = project(monkeypatch, tmp_path)
    looped = {**FACE, "keypoints": {"names": ["a", "b"], "skeleton": [[1, 1]]}}

    result = call("create_schema_version", project=named, classes=[looped])

    assert result.is_error
    assert "to itself" in result.content[0].text


def test_keypoints_are_written_and_read_back_unchanged(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    job_id, asset = _working(monkeypatch, tmp_path)

    payload(
        call(
            "add_annotations",
            job_id=job_id,
            annotations=[_face(asset, POINTS, visibility=[2, 1, 0])],
        )
    )

    (stored,) = payload(call("list_asset_annotations", job_id=job_id, asset_id=asset["id"]))[
        "items"
    ]
    assert stored["geometry"] == {"type": "keypoints", "points": POINTS, "visibility": [2, 1, 0]}


def test_a_count_other_than_the_specs_is_refused_with_its_code(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    job_id, asset = _working(monkeypatch, tmp_path)

    refusal = error(call("add_annotations", job_id=job_id, annotations=[_face(asset, POINTS[:2])]))

    assert refusal["code"] == "KEYPOINT_COUNT_MISMATCH"
    assert (
        payload(call("list_asset_annotations", job_id=job_id, asset_id=asset["id"]))["items"] == []
    )


def test_a_draft_holds_an_unfinished_spec(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    named = project(monkeypatch, tmp_path)
    unfinished = {"names": ["left_eye", ""], "skeleton": [[0, 4]]}

    payload(call("set_schema_draft", project=named, classes=[{**FACE, "keypoints": unfinished}]))

    draft = payload(call("get_schema_draft", project=named))["draft"]
    assert draft["classes"][0]["keypoints"] == unfinished


def test_the_guide_and_the_geometry_topic_describe_keypoints() -> None:
    from visionset.mcp._guide import WORKFLOW
    from visionset.mcp._topics import ANNOTATION_GEOMETRY, SCHEMA_CHANGES

    assert "keypoints" in WORKFLOW
    assert "`keypoints`" in ANNOTATION_GEOMETRY
    assert "KEYPOINT_COUNT_MISMATCH" in ANNOTATION_GEOMETRY
    assert "keypoint spec" in SCHEMA_CHANGES
