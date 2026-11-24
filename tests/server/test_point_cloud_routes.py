"""Point-cloud scans over HTTP: uploaded, read, served, labelled in 3D, released, exported."""

from __future__ import annotations

import io
import struct
from collections.abc import Iterator
from math import pi
from pathlib import Path
from typing import Any, Final
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from tests.fixtures.calibration import calibration_document
from tests.fixtures.point_clouds import SCAN, pcd_ascii, ply_binary
from tests.server._api import api_client
from tests.server._flow import (
    SIGN,
    a_box,
    asset_ids,
    batch_from_ingest,
    dataset_of,
    project_with_schema,
)
from tests.server._jobs import InlineDispatcher

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


def scan_parts() -> list[tuple[str, tuple[str, bytes, str]]]:
    """One PCD and one PLY, under names whose suffixes lie, as multipart parts."""
    rear = ply_binary(tuple((x, y + 1, z) for x, y, z in SCAN))
    return [
        ("files", ("front.bin", pcd_ascii(), "application/octet-stream")),
        ("files", ("rear.dat", rear, "application/octet-stream")),
    ]


def upload_scans(client: TestClient, project_id: str, **form: str) -> Any:
    return client.post(
        f"/projects/{project_id}/sources/point-clouds", files=scan_parts(), data=form
    )


@pytest.fixture()
def scans(client: TestClient, runner: InlineDispatcher) -> dict[str, Any]:
    """A project whose point-cloud scans have been uploaded and ingested over HTTP."""
    project_id = project_with_schema(client, classes=[SIGN, CAR_3D])
    registered = upload_scans(client, project_id, frame="lidar_flu")
    assert registered.status_code == 201, registered.text
    source = registered.json()
    job = client.post(f"/sources/{source['id']}/ingest-jobs")
    assert job.status_code == 202, job.text
    runner.wait()
    batch_id = client.get(f"/ingest-jobs/{job.json()['id']}").json()["batch_id"]
    items = client.get(f"/batches/{batch_id}/assets").json()["items"]
    return {
        "project": project_id,
        "source": source["id"],
        "batch": batch_id,
        "assets": [item["id"] for item in items],
    }


def test_uploading_scans_registers_a_point_cloud_source(client: TestClient) -> None:
    project_id = project_with_schema(client, classes=[CAR_3D])

    response = upload_scans(client, project_id, frame="camera_rdf", name="drive 1")

    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["kind"], body["frame"], body["name"]) == (
        "point_cloud_directory",
        "camera_rdf",
        "drive 1",
    )
    listed = client.get(f"/projects/{project_id}/sources").json()["items"]
    assert [one["id"] for one in listed] == [body["id"]]


def test_the_same_scans_uploaded_twice_are_one_source(client: TestClient) -> None:
    project_id = project_with_schema(client, classes=[CAR_3D])

    first = upload_scans(client, project_id, frame="lidar_flu")
    second = upload_scans(client, project_id, frame="lidar_flu")

    assert second.status_code == 201, second.text
    assert second.json() == first.json()
    assert client.get(f"/projects/{project_id}/sources").json()["total"] == 1


def test_another_frame_replaces_the_declaration_while_nothing_depends_on_it(
    client: TestClient,
) -> None:
    project_id = project_with_schema(client, classes=[CAR_3D])
    first = upload_scans(client, project_id, frame="lidar_flu").json()

    moved = upload_scans(client, project_id, frame="camera_rdf")

    assert moved.status_code == 201, moved.text
    assert (moved.json()["id"], moved.json()["frame"]) == (first["id"], "camera_rdf")


@pytest.mark.parametrize("form", [{}, {"frame": "radar"}, {"frame": "LIDAR_FLU"}])
def test_a_missing_or_unknown_frame_is_422(client: TestClient, form: dict[str, str]) -> None:
    project_id = project_with_schema(client, classes=[CAR_3D])

    response = upload_scans(client, project_id, **form)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert client.get(f"/projects/{project_id}/sources").json()["total"] == 0


def test_a_blank_name_is_422_invalid_name(client: TestClient) -> None:
    project_id = project_with_schema(client, classes=[CAR_3D])

    response = upload_scans(client, project_id, frame="lidar_flu", name="   ")

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "INVALID_NAME"


def test_an_unknown_project_is_404(client: TestClient) -> None:
    response = upload_scans(client, str(UUID(int=0)), frame="lidar_flu")

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "PROJECT_NOT_FOUND"


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


def test_an_imported_cuboid_on_a_scan_is_edited_in_place_and_stays_an_import(
    client: TestClient, scans: dict[str, Any]
) -> None:
    job_id = _open(client, scans["batch"])
    scan = scans["assets"][0]
    written = client.post(
        f"/jobs/{job_id}/annotations",
        json=[
            {
                "asset_id": scan,
                "label_class": "car_3d",
                "geometry": CAR,
                "attributes": {},
                "provenance": "import",
            }
        ],
    )
    assert written.status_code == 201, written.text
    stored_id = written.json()["items"][0]["id"]
    moved = {**CAR, "center": [12.5, -1.0, 0.8], "size": [4.4, 1.9, 1.6], "yaw": -pi}

    def update(geometry: dict[str, Any], provenance: str = "import") -> Any:
        return client.patch(
            f"/jobs/{job_id}/annotations",
            json=[
                {
                    "id": stored_id,
                    "label_class": "car_3d",
                    "geometry": geometry,
                    "attributes": {},
                    "provenance": provenance,
                }
            ],
        )

    edited = update(moved)
    over_a_turn = update({**moved, "yaw": pi + 0.25})
    relabelled_human = update(moved, provenance="human")

    assert edited.status_code == 200, edited.text
    assert over_a_turn.status_code == 422, over_a_turn.text
    assert relabelled_human.status_code == 422, relabelled_human.text
    assert relabelled_human.json()["code"] == "INVALID_ANNOTATION"
    (read_back,) = client.get(f"/jobs/{job_id}/assets/{scan}/annotations").json()["items"]
    assert read_back["id"] == stored_id
    assert read_back["geometry"] == moved
    assert read_back["provenance"] == "import"


def test_another_frame_is_409_once_a_scan_holds_a_3d_label(
    client: TestClient, scans: dict[str, Any]
) -> None:
    job_id = _open(client, scans["batch"])
    written = client.post(
        f"/jobs/{job_id}/annotations",
        json=[
            {
                "asset_id": scans["assets"][0],
                "label_class": "car_3d",
                "geometry": CAR,
                "attributes": {},
                "provenance": "human",
            }
        ],
    )
    assert written.status_code == 201, written.text

    moved = upload_scans(client, scans["project"], frame="camera_rdf")
    again = upload_scans(client, scans["project"], frame="lidar_flu")

    assert moved.status_code == 409, moved.text
    assert moved.json()["code"] == "CALIBRATION_IN_USE"
    assert client.get(f"/sources/{scans['source']}").json()["frame"] == "lidar_flu"
    assert (again.status_code, again.json()["id"]) == (201, scans["source"])


def _points(client: TestClient, project: str, asset: str, **params: Any) -> Any:
    return client.get(f"/projects/{project}/assets/{asset}/points", params=params)


def _decoded(buffer: bytes) -> tuple[int, list[tuple[float, ...]], tuple[float, ...] | None]:
    magic, version, count, flags = struct.unpack_from("<4sIII", buffer)
    assert (magic, version) == (b"VSPC", 1)
    assert flags & 2 == 0
    xyz = struct.unpack_from(f"<{3 * count}f", buffer, 16)
    intensity = struct.unpack_from(f"<{count}f", buffer, 16 + 12 * count) if flags & 1 else None
    assert len(buffer) == 16 + 12 * count + (4 * count if flags & 1 else 0)
    return flags, [tuple(xyz[i : i + 3]) for i in range(0, 3 * count, 3)], intensity


def test_the_points_route_serves_each_scan_as_a_vspc_buffer(
    client: TestClient, scans: dict[str, Any]
) -> None:
    project = scans["project"]
    seen = set()
    for asset_id in scans["assets"]:
        fmt = client.get(f"/projects/{project}/assets/{asset_id}").json()["point_cloud"]["format"]
        response = _points(client, project, asset_id)
        assert response.status_code == 200, response.text
        assert response.headers["content-type"] == "application/octet-stream"
        flags, points, intensity = _decoded(response.content)
        if fmt == "pcd":
            assert (flags, points, intensity) == (0, list(SCAN), None)
        else:
            assert flags == 1
            assert points == [(x, y + 1, z) for x, y, z in SCAN]
            assert intensity == (0.5, 0.5, 0.5)
        assert _points(client, project, asset_id).content == response.content
        seen.add(fmt)
    assert seen == {"pcd", "ply"}


@pytest.mark.parametrize(
    ("max_points", "status"),
    [
        (999, 422),
        (1_000, 200),
        (2_000_000, 200),
        (2_000_001, 422),
        (-1, 422),
        (10**30, 422),
        ("many", 422),
    ],
)
def test_max_points_outside_its_range_is_422_never_clamped(
    client: TestClient, scans: dict[str, Any], max_points: object, status: int
) -> None:
    response = _points(client, scans["project"], scans["assets"][0], max_points=max_points)
    assert response.status_code == status, response.text
    if status == 422:
        assert response.json()["code"] == "VALIDATION_ERROR"


def test_an_image_asset_has_no_points(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, scans: dict[str, Any]
) -> None:
    batch = batch_from_ingest(client, runner, tmp_path / "images", scans["project"], images=1)
    image = asset_ids(client, batch)[0]

    response = _points(client, scans["project"], image)

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "ASSET_NOT_FOUND"


def test_the_points_route_is_scoped_and_guarded_like_content(
    client: TestClient, scans: dict[str, Any]
) -> None:
    other = client.post("/projects", json={"name": "elsewhere"}).json()["id"]
    asset = scans["assets"][0]

    foreign = _points(client, other, asset)
    unknown = _points(client, str(UUID(int=0)), asset)
    anonymous = client.get(
        f"/projects/{scans['project']}/assets/{asset}/points", headers={"Authorization": ""}
    )

    assert (foreign.status_code, foreign.json()["code"]) == (404, "ASSET_NOT_FOUND")
    assert (unknown.status_code, unknown.json()["code"]) == (404, "PROJECT_NOT_FOUND")
    assert anonymous.status_code == 401


GEOREFERENCED: Final = tuple(
    (512_345.678 + 0.731 * i, 4_123_456.789 - 0.417 * i, 12.345 + 0.0123 * i) for i in range(20)
)


def _double_ply(points: tuple[tuple[float, float, float], ...]) -> bytes:
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {len(points)}\n"
        "property double x\nproperty double y\nproperty double z\nend_header\n"
    ).encode()
    return header + b"".join(struct.pack("<3d", *point) for point in points)


def test_a_georeferenced_scan_is_served_relative_to_an_origin_without_losing_precision(
    client: TestClient, runner: InlineDispatcher
) -> None:
    project = project_with_schema(client, classes=[CAR_3D])
    registered = client.post(
        f"/projects/{project}/sources/point-clouds",
        files=[("files", ("survey.ply", _double_ply(GEOREFERENCED), "application/octet-stream"))],
        data={"frame": "lidar_flu"},
    )
    assert registered.status_code == 201, registered.text
    job = client.post(f"/sources/{registered.json()['id']}/ingest-jobs")
    runner.wait()
    batch = client.get(f"/ingest-jobs/{job.json()['id']}").json()["batch_id"]
    (asset,) = [item["id"] for item in client.get(f"/batches/{batch}/assets").json()["items"]]

    buffer = _points(client, project, asset).content
    magic, version, count, flags = struct.unpack_from("<4sIII", buffer)
    assert (magic, version, count, flags) == (b"VSPC", 1, len(GEOREFERENCED), 4)
    origin = struct.unpack_from("<3d", buffer, 16)
    xyz = struct.unpack_from(f"<{3 * count}f", buffer, 40)
    assert len(buffer) == 40 + 12 * count
    assert origin[2] == 0.0
    error = max(
        abs(origin[axis] + xyz[3 * i + axis] - point[axis])
        for i, point in enumerate(GEOREFERENCED)
        for axis in range(3)
    )
    assert error < 1e-5
    assert _points(client, project, asset).content == buffer


def test_the_published_contract_describes_labels_on_a_scan() -> None:
    from visionset.server.main import app

    spec = app.openapi()
    schemas = spec["components"]["schemas"]
    cuboid = schemas["Cuboid3DBody"]["description"]
    assert "(cos yaw, sin yaw, 0)` on `lidar_flu`" in cuboid
    assert "up axis" in cuboid
    assert "point-cloud scan" in schemas["Polyline3DBody"]["description"]
    refusals = {
        "post": "a `bbox`, `polygon` or `polyline` on one is 422 `INVALID_ANNOTATION`",
        "patch": "422 `INVALID_ANNOTATION` for a `bbox`, `polygon` or `polyline`",
    }
    for method, refusal in refusals.items():
        operation = spec["paths"]["/jobs/{job_id}/annotations"][method]
        description = " ".join(operation["description"].split())
        assert "declaring no frame" in description
        assert refusal in description


def test_a_batch_publishes_the_modalities_it_holds(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, scans: dict[str, Any]
) -> None:
    project = scans["project"]
    images = batch_from_ingest(client, runner, tmp_path / "images", project, images=1)
    image = asset_ids(client, images)[0]
    mixed = client.post(
        f"/projects/{project}/batches",
        json={"name": "mixed", "asset_ids": [scans["assets"][0], image]},
    ).json()["id"]
    empty = client.post(f"/projects/{project}/batches", json={"name": "empty"}).json()["id"]

    listed = {
        one["id"]: one["modalities"]
        for one in client.get(f"/projects/{project}/batches").json()["items"]
    }

    assert listed == {
        scans["batch"]: ["point_cloud"],
        images: ["image"],
        mixed: ["image", "point_cloud"],
        empty: [],
    }
    assert client.get(f"/batches/{mixed}").json()["modalities"] == ["image", "point_cloud"]
    held = client.get(f"/projects/{project}/assets/{image}/batches").json()["items"]
    assert {one["id"]: one["modalities"] for one in held} == {
        images: ["image"],
        mixed: ["image", "point_cloud"],
    }
