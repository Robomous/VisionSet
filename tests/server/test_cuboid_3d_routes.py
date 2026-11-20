"""`cuboid_3d` over HTTP: refused without a calibration, written with one, released."""

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

CAR_3D: Final[dict[str, Any]] = {"name": "car_3d", "geometries": ["cuboid_3d"]}
BOX: Final[dict[str, Any]] = {
    "type": "cuboid_3d",
    "center": [-2.5, 0.75, 12.0],
    "size": [4.5, 1.9, 1.6],
    "yaw": 1.2,
}


def _car(asset_id: str, geometry: dict[str, Any] = BOX) -> dict[str, Any]:
    return {
        "asset_id": asset_id,
        "label_class": "car_3d",
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
    return open_job(client, runner, tmp_path, images=2, classes=[SIGN, CAR_3D])


def test_a_cuboid_on_an_uncalibrated_asset_is_409_calibration_missing(
    client: TestClient, working: tuple[str, str]
) -> None:
    batch_id, job_id = working
    asset = asset_ids(client, batch_id)[0]

    response = client.post(f"/jobs/{job_id}/annotations", json=[a_box(asset), _car(asset)])

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "CALIBRATION_MISSING"
    assert response.json()["detail"]["index"] == 1
    assert client.get(f"/jobs/{job_id}/assets/{asset}/annotations").json()["total"] == 0


def test_against_a_calibrated_asset_it_is_written_read_back_and_released(
    client: TestClient, working: tuple[str, str]
) -> None:
    batch_id, job_id = working
    labelled, plain = asset_ids(client, batch_id)
    project = client.get("/projects").json()["items"][0]["id"]
    calibrated = client.put(
        f"/projects/{project}/assets/{labelled}/calibration", json=calibration_document()
    )
    assert calibrated.status_code == 200, calibrated.text

    written = client.post(f"/jobs/{job_id}/annotations", json=[_car(labelled)])
    assert written.status_code == 201, written.text
    stored = client.get(f"/jobs/{job_id}/assets/{labelled}/annotations").json()["items"]
    assert [one["geometry"] for one in stored] == [BOX]

    client.post(f"/jobs/{job_id}/annotations", json=[a_box(plain)])
    client.post(f"/jobs/{job_id}/complete")
    client.post(f"/batches/{batch_id}/complete")
    client.post(f"/batches/{batch_id}/promote")
    published = client.post(f"/datasets/{dataset_of(client, project)}/releases", json={"tag": "v1"})
    assert published.status_code == 201, published.text

    manifest = client.get(f"/releases/{published.json()['id']}/manifest").json()
    assert manifest["manifest_version"] == 4
    by_asset = {one["asset_id"]: one for one in manifest["assets"]}
    assert by_asset[labelled]["calibration"] == calibration_document()
    assert by_asset[labelled]["annotations"][0]["geometry"] == BOX
    assert "calibration" not in by_asset[plain]


@pytest.mark.parametrize(
    ("geometry", "fragment"),
    [
        ({**BOX, "size": [4.5, 0.0, 1.6]}, "size"),
        ({**BOX, "yaw": 3.2}, "yaw"),
        ({**BOX, "center": [1.0, 2.0]}, "center"),
        ({**BOX, "visibility": [2]}, "visibility"),
        ({k: v for k, v in BOX.items() if k != "yaw"}, "yaw"),
    ],
    ids=["zero-width", "yaw-past-pi", "2d-center", "visibility", "no-yaw"],
)
def test_a_malformed_cuboid_is_422_before_any_calibration_is_consulted(
    client: TestClient, working: tuple[str, str], geometry: dict[str, Any], fragment: str
) -> None:
    batch_id, job_id = working
    asset = asset_ids(client, batch_id)[0]

    response = client.post(f"/jobs/{job_id}/annotations", json=[_car(asset, geometry)])

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert fragment in response.text
