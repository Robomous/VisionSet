"""Calibration over HTTP: a source's camera and an asset's override, set, read, cleared."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.calibration import calibration_document
from tests.fixtures.media import write_image
from tests.server._api import api_client

from visionset.kernel.domain import Annotation, Polyline3DGeometry
from visionset.kernel.services import IngestService, WorkspaceService


class Rig:
    def __init__(self, client: TestClient, root: Path, project: str, source: str, asset: str):
        self.client, self.root = client, root
        self.project, self.source, self.asset = project, source, asset

    @property
    def source_path(self) -> str:
        return f"/sources/{self.source}/calibration"

    @property
    def asset_path(self) -> str:
        return f"/projects/{self.project}/assets/{self.asset}/calibration"


@pytest.fixture()
def rig(tmp_path: Path) -> Iterator[Rig]:
    root = tmp_path / "ws"
    with api_client(root) as client:
        project = client.post("/projects", json={"name": "rig"}).json()["id"]
        image = write_image(tmp_path / "made" / "a.png").read_bytes()
        source = client.post(
            f"/projects/{project}/sources/images", files=[("files", ("a.png", image, "image/png"))]
        ).json()["id"]
        opened = WorkspaceService.open(root)
        IngestService(opened).ingest(UUID(source))
        opened.close()
        asset = client.get(f"/projects/{project}/assets").json()["items"][0]["id"]
        yield Rig(client, root, project, source, asset)


def test_a_source_calibration_round_trips(rig: Rig) -> None:
    assert rig.client.get(rig.source_path).json() == {"source_id": rig.source, "calibration": None}

    stated = rig.client.put(rig.source_path, json=calibration_document())
    assert stated.status_code == 200, stated.text
    read = rig.client.get(rig.source_path)

    assert (
        stated.json()
        == read.json()
        == {
            "source_id": rig.source,
            "calibration": calibration_document(),
        }
    )
    assert rig.client.delete(rig.source_path).status_code == 204
    assert rig.client.get(rig.source_path).json()["calibration"] is None
    assert rig.client.delete(rig.source_path).status_code == 204


def test_omitted_defaults_are_filled_and_published(rig: Rig) -> None:
    document = calibration_document(distortion=False)
    del document["intrinsics"]["skew"]
    del document["distortion"]

    stated = rig.client.put(rig.source_path, json=document).json()["calibration"]

    assert stated == calibration_document(distortion=False)


def test_a_distortion_without_a_model_is_plumb_bob_as_on_every_surface(rig: Rig) -> None:
    document = calibration_document()
    del document["distortion"]["model"]

    stated = rig.client.put(rig.source_path, json=document)

    assert stated.status_code == 200, stated.text
    assert stated.json()["calibration"] == calibration_document()


def test_clearing_onto_a_source_calibration_of_another_size_is_422_by_code(rig: Rig) -> None:
    opened = WorkspaceService.open(rig.root)
    with opened.unit_of_work() as uow:
        asset = uow.assets.get(UUID(rig.asset))
        assert asset is not None
        uow.assets.update(asset.model_copy(update={"width": 64, "height": 48}))
    opened.close()
    rig.client.put(rig.asset_path, json=calibration_document(width=64, height=48))
    rig.client.put(rig.source_path, json=calibration_document())

    response = rig.client.delete(rig.asset_path)

    assert response.status_code == 422
    assert response.json()["code"] == "CALIBRATION_RESOLUTION_MISMATCH"


def test_an_asset_override_round_trips_and_falls_back_to_the_source(rig: Rig) -> None:
    inherited, own = calibration_document(fx=10.0), calibration_document(fx=20.0)
    rig.client.put(rig.source_path, json=inherited)

    stated = rig.client.put(rig.asset_path, json=own)
    assert stated.status_code == 200, stated.text
    assert stated.json() == {"asset_id": rig.asset, "override": own, "effective": own}
    assert rig.client.get(rig.asset_path).json() == stated.json()

    assert rig.client.delete(rig.asset_path).status_code == 204
    assert rig.client.get(rig.asset_path).json() == {
        "asset_id": rig.asset,
        "override": None,
        "effective": inherited,
    }


def test_a_calibration_measured_at_another_size_is_422_by_code(rig: Rig) -> None:
    wrong = calibration_document(width=64, height=48)
    for path in (rig.source_path, rig.asset_path):
        response = rig.client.put(path, json=wrong)
        assert response.status_code == 422
        assert response.json()["code"] == "CALIBRATION_RESOLUTION_MISMATCH"


@pytest.mark.parametrize(
    "spoil",
    [
        lambda d: d["extrinsics"].update(rotation=[[1, 0, 0], [0, 1, 0], [0, 0, -1]]),
        lambda d: d["intrinsics"].update(fx=0),
        lambda d: d.pop("extrinsics"),
        lambda d: d["distortion"].update(model="fisheye"),
        lambda d: d.update(sensor="lidar"),
    ],
    ids=["reflection", "zero-focal", "no-extrinsics", "unknown-model", "extra-key"],
)
def test_a_malformed_calibration_is_a_validation_error(rig: Rig, spoil: Any) -> None:
    document = calibration_document()
    spoil(document)
    response = rig.client.put(rig.source_path, json=document)
    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_clearing_a_calibration_3d_labels_need_is_409_by_code(rig: Rig) -> None:
    rig.client.put(rig.source_path, json=calibration_document())
    opened = WorkspaceService.open(rig.root)
    with opened.unit_of_work() as uow:
        uow.annotations.add(
            Annotation(
                asset_id=UUID(rig.asset),
                label_class="lane",
                schema_version=1,
                geometry=Polyline3DGeometry(points=[(0.0, 1.0, 5.0), (0.0, 1.0, 9.0)]),
                provenance="human",
            )
        )
    opened.close()

    response = rig.client.delete(rig.source_path)

    assert response.status_code == 409
    assert response.json()["code"] == "CALIBRATION_IN_USE"
    assert rig.client.put(rig.asset_path, json=calibration_document()).status_code == 200
    assert rig.client.delete(rig.source_path).status_code == 204
    refused = rig.client.delete(rig.asset_path)
    assert refused.json()["code"] == "CALIBRATION_IN_USE"


def test_replacing_a_calibration_3d_labels_were_drawn_against_is_409_by_code(rig: Rig) -> None:
    rig.client.put(rig.source_path, json=calibration_document())
    opened = WorkspaceService.open(rig.root)
    with opened.unit_of_work() as uow:
        uow.annotations.add(
            Annotation(
                asset_id=UUID(rig.asset),
                label_class="lane",
                schema_version=1,
                geometry=Polyline3DGeometry(points=[(0.0, 1.0, 5.0), (0.0, 1.0, 9.0)]),
                provenance="human",
            )
        )
    opened.close()

    refused = rig.client.put(rig.source_path, json=calibration_document(fx=40.0))

    assert refused.status_code == 409
    assert refused.json()["code"] == "CALIBRATION_IN_USE"
    assert rig.client.get(rig.source_path).json()["calibration"] == calibration_document()
    assert rig.client.put(rig.source_path, json=calibration_document()).status_code == 200
    first = rig.client.put(rig.asset_path, json=calibration_document(fx=11.0))
    assert first.status_code == 409
    assert first.json()["code"] == "CALIBRATION_IN_USE"
    assert rig.client.put(rig.asset_path, json=calibration_document()).status_code == 200
    assert rig.client.put(rig.source_path, json=calibration_document(fx=40.0)).status_code == 200
    cleared = rig.client.delete(rig.asset_path)
    assert cleared.status_code == 409
    assert cleared.json()["code"] == "CALIBRATION_IN_USE"
    assert rig.client.get(rig.asset_path).json()["override"] == calibration_document()


def test_unknown_targets_are_404_by_code(rig: Rig) -> None:
    body = calibration_document()
    assert rig.client.get(f"/sources/{uuid4()}/calibration").json()["code"] == "SOURCE_NOT_FOUND"
    unknown_asset = f"/projects/{rig.project}/assets/{uuid4()}/calibration"
    assert rig.client.put(unknown_asset, json=body).json()["code"] == "ASSET_NOT_FOUND"
    unknown_project = f"/projects/{uuid4()}/assets/{rig.asset}/calibration"
    assert rig.client.delete(unknown_project).json()["code"] == "PROJECT_NOT_FOUND"


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE"])
def test_every_calibration_route_refuses_a_request_with_no_token(rig: Rig, method: str) -> None:
    for path in (rig.source_path, rig.asset_path):
        response = rig.client.request(method, path, headers={"Authorization": ""})
        assert response.status_code == 401
