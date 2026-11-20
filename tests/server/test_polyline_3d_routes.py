"""`polyline_3d` over HTTP: refused without a calibration, written with one, released."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any, Final

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.calibration import calibration_document
from tests.server._api import api_client
from tests.server._flow import SIGN, a_box, asset_ids, dataset_of, open_job
from tests.server._jobs import InlineDispatcher

LANE_3D: Final[dict[str, Any]] = {"name": "lane_3d", "geometries": ["polyline_3d"]}
PATH: Final[dict[str, Any]] = {
    "type": "polyline_3d",
    "points": [[-1.75, 1.5, 6.0], [-1.7, 1.5, 18.25], [-1.6, 1.4, -2.0]],
    "visibility": [2, 2, 1],
}


def _lane(asset_id: str, geometry: dict[str, Any] = PATH) -> dict[str, Any]:
    return {
        "asset_id": asset_id,
        "label_class": "lane_3d",
        "geometry": geometry,
        "attributes": {},
        "provenance": "human",
    }


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture()
def working(client: TestClient, tmp_path: Path, runner: InlineDispatcher) -> tuple[str, str]:
    return open_job(client, runner, tmp_path, images=2, classes=[SIGN, LANE_3D])


def _source_of(client: TestClient, asset_id: str) -> str:
    project = client.get("/projects").json()["items"][0]["id"]
    items = client.get(f"/projects/{project}/assets").json()["items"]
    source: str = next(one["source_id"] for one in items if one["id"] == asset_id)
    return source


def test_a_3d_label_on_an_uncalibrated_asset_is_409_calibration_missing(
    client: TestClient, working: tuple[str, str]
) -> None:
    batch_id, job_id = working
    asset = asset_ids(client, batch_id)[0]

    response = client.post(f"/jobs/{job_id}/annotations", json=[a_box(asset), _lane(asset)])

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "CALIBRATION_MISSING"
    assert response.json()["detail"]["index"] == 1
    assert client.get(f"/jobs/{job_id}/assets/{asset}/annotations").json()["total"] == 0


def test_against_a_calibrated_source_it_is_written_read_back_and_released(
    client: TestClient, working: tuple[str, str]
) -> None:
    batch_id, job_id = working
    labelled, plain = asset_ids(client, batch_id)
    source = _source_of(client, labelled)
    assert (
        client.put(f"/sources/{source}/calibration", json=calibration_document()).status_code == 200
    )

    written = client.post(f"/jobs/{job_id}/annotations", json=[_lane(labelled)])
    assert written.status_code == 201, written.text
    stored = client.get(f"/jobs/{job_id}/assets/{labelled}/annotations").json()["items"]
    assert [one["geometry"] for one in stored] == [PATH]

    client.post(f"/jobs/{job_id}/annotations", json=[a_box(plain)])
    client.post(f"/jobs/{job_id}/complete")
    client.post(f"/batches/{batch_id}/complete")
    client.post(f"/batches/{batch_id}/promote")
    project = client.get("/projects").json()["items"][0]["id"]
    published = client.post(f"/datasets/{dataset_of(client, project)}/releases", json={"tag": "v1"})
    assert published.status_code == 201, published.text

    manifest = client.get(f"/releases/{published.json()['id']}/manifest").json()
    assert manifest["manifest_version"] == 4
    by_asset = {one["asset_id"]: one for one in manifest["assets"]}
    assert by_asset[labelled]["calibration"] == calibration_document()
    assert "calibration" not in by_asset[plain]
    assert by_asset[labelled]["annotations"][0]["geometry"] == PATH


@pytest.mark.parametrize(
    ("geometry", "fragment"),
    [
        ({**PATH, "visibility": [True, 2, 1]}, "integer 0, 1 or 2"),
        ({**PATH, "visibility": [2, 2]}, "one state per point"),
        ({**PATH, "visibility": None}, "never null"),
        ({"type": "polyline_3d", "points": [[1.0, 2.0], [3.0, 4.0]]}, "points"),
    ],
    ids=["bool-visibility", "short-visibility", "null-visibility", "2d-points"],
)
def test_a_malformed_3d_body_is_422_before_any_calibration_is_consulted(
    client: TestClient, working: tuple[str, str], geometry: dict[str, Any], fragment: str
) -> None:
    batch_id, job_id = working
    asset = asset_ids(client, batch_id)[0]

    response = client.post(f"/jobs/{job_id}/annotations", json=[_lane(asset, geometry)])

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert fragment in response.text
