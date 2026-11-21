"""Point-cloud scans over HTTP: read, served, labelled in 3D, released, judged for export."""

from __future__ import annotations

import io
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Final
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from tests.fixtures.calibration import calibration_document
from tests.fixtures.point_clouds import pcd_ascii, write_scans
from tests.server._api import api_client
from tests.server._flow import SIGN, a_box, dataset_of, project_with_schema
from tests.server._jobs import InlineDispatcher

from visionset.kernel.domain import ScanFrame
from visionset.kernel.services import SourceService

CAR_3D: Final[dict[str, Any]] = {"name": "car_3d", "geometries": ["cuboid_3d"]}
CAR: Final[dict[str, Any]] = {
    "type": "cuboid_3d",
    "center": [10.0, 0.0, 0.8],
    "size": [4.2, 1.8, 1.5],
    "yaw": 0.25,
}


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture()
def scans(client: TestClient, runner: InlineDispatcher, tmp_path: Path) -> dict[str, Any]:
    """A project whose point-cloud directory has been ingested over HTTP."""
    project_id = project_with_schema(client, classes=[SIGN, CAR_3D])
    workspace = client.app.state.workspace_handle.get()  # type: ignore[attr-defined]
    source = SourceService(workspace).register_point_clouds(
        UUID(project_id), write_scans(tmp_path / "scans"), frame=ScanFrame.LIDAR_FLU
    )
    job = client.post(f"/sources/{source.id}/ingest-jobs")
    assert job.status_code == 202, job.text
    runner.wait()
    batch_id = client.get(f"/ingest-jobs/{job.json()['id']}").json()["batch_id"]
    items = client.get(f"/batches/{batch_id}/assets").json()["items"]
    return {
        "project": project_id,
        "source": str(source.id),
        "batch": batch_id,
        "assets": [item["id"] for item in items],
    }


def test_a_scan_asset_publishes_its_modality_and_metadata(
    client: TestClient, scans: dict[str, Any]
) -> None:
    asset = client.get(f"/projects/{scans['project']}/assets/{scans['assets'][0]}").json()

    assert asset["modality"] == "point_cloud"
    assert (asset["width"], asset["height"], asset["format"]) == (None, None, None)
    metadata = asset["point_cloud"]
    assert metadata["format"] in {"pcd", "ply"}
    assert metadata["point_count"] == 3
    assert set(metadata["bounds"]) == {"minimum", "maximum"}
    assert metadata["fields"][:3] == ["x", "y", "z"]


def test_the_source_publishes_its_frame(client: TestClient, scans: dict[str, Any]) -> None:
    source = client.get(f"/sources/{scans['source']}").json()
    assert (source["kind"], source["frame"]) == ("point_cloud_directory", "lidar_flu")


def test_the_content_route_serves_the_scan_as_ingested(
    client: TestClient, scans: dict[str, Any]
) -> None:
    project = scans["project"]
    for asset_id in scans["assets"]:
        asset = client.get(f"/projects/{project}/assets/{asset_id}").json()
        response = client.get(f"/projects/{project}/assets/{asset_id}/content")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/octet-stream"
        if asset["point_cloud"]["format"] == "pcd":
            assert response.content == pcd_ascii()


def test_the_thumbnail_route_serves_a_top_down_jpeg(
    client: TestClient, scans: dict[str, Any]
) -> None:
    response = client.get(f"/projects/{scans['project']}/assets/{scans['assets'][0]}/thumbnail")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(response.content)).format == "JPEG"


def test_a_camera_calibration_for_a_scan_is_409(client: TestClient, scans: dict[str, Any]) -> None:
    asset = client.put(
        f"/projects/{scans['project']}/assets/{scans['assets'][0]}/calibration",
        json=calibration_document(),
    )
    source = client.put(f"/sources/{scans['source']}/calibration", json=calibration_document())

    for response in (asset, source):
        assert response.status_code == 409, response.text
        assert response.json()["code"] == "CALIBRATION_NOT_APPLICABLE"


def _open(client: TestClient, batch_id: str) -> str:
    client.post(f"/batches/{batch_id}/approve")
    client.post(f"/batches/{batch_id}/start")
    job_id: str = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]
    client.post(f"/jobs/{job_id}/start")
    return job_id


def test_a_cuboid_lands_on_a_scan_and_a_box_does_not(
    client: TestClient, scans: dict[str, Any]
) -> None:
    job_id = _open(client, scans["batch"])
    labelled, other = scans["assets"]
    car = {
        "asset_id": labelled,
        "label_class": "car_3d",
        "geometry": CAR,
        "attributes": {},
        "provenance": "human",
    }

    refused = client.post(f"/jobs/{job_id}/annotations", json=[a_box(other)])
    written = client.post(f"/jobs/{job_id}/annotations", json=[car])

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "INVALID_ANNOTATION"
    assert written.status_code == 201, written.text

    marked = client.put(f"/jobs/{job_id}/assets/{other}/progress", json={"progress": "annotated"})
    assert marked.status_code == 200, marked.text
    client.post(f"/jobs/{job_id}/complete")
    client.post(f"/batches/{scans['batch']}/complete")
    client.post(f"/batches/{scans['batch']}/promote")
    published = client.post(
        f"/datasets/{dataset_of(client, scans['project'])}/releases", json={"tag": "v1"}
    )
    assert published.status_code == 201, published.text
    release_id = published.json()["id"]

    manifest = client.get(f"/releases/{release_id}/manifest").json()
    assert manifest["manifest_version"] == 5
    by_asset = {one["asset_id"]: one for one in manifest["assets"]}
    assert by_asset[labelled]["modality"] == "point_cloud"
    assert by_asset[labelled]["frame"] == "lidar_flu"
    assert by_asset[labelled]["annotations"][0]["geometry"] == CAR

    report = client.get(f"/releases/{release_id}/export-compatibility", params={"format": "coco"})
    assert report.status_code == 200, report.text
    body = report.json()
    assert body["compatible"] is False
    assert body["dropped_modalities"] == [
        {
            "modality": "point_cloud",
            "assets": 2,
            "annotations": 1,
            "reason": "coco does not write point_cloud assets, so 2 of them are left out "
            "with every label on them",
        }
    ]
