"""The detect route: its gate, its wire, and that /suggest is untouched by it."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.media import write_image
from tests.server._api import api_client
from tests.server._jobs import InlineDispatcher

from visionset.inference import detections as detections_module
from visionset.inference import weights as weights_module
from visionset.inference.registry import capabilities, registered
from visionset.kernel.domain import (
    AssetPrediction,
    BboxGeometry,
    DownloadSize,
    GeometryType,
    InferenceConnection,
    ModelCapability,
    PredictedRegion,
    PredictionRequest,
    ServedFamily,
)
from visionset.kernel.errors import LocalInferenceUnavailable
from visionset.server.routes import _prelabel as prelabel_routes
from visionset.server.routes import inference as inference_routes

TEXT_DETECT_FAMILY = next(
    family
    for family, capability in sorted(capabilities(registered().providers).items())
    if capability is ModelCapability.TEXT_DETECT
)
POINT_SUGGEST_FAMILY = next(
    family
    for family, capability in sorted(capabilities(registered().providers).items())
    if capability is ModelCapability.POINT_SUGGEST
)


class Provider:
    def __init__(self, regions: tuple[PredictedRegion, ...]) -> None:
        self.regions = regions
        self.requests: list[PredictionRequest] = []

    @property
    def model_ref(self) -> str:
        return "acme/detector@abc"

    def predict(self, request: PredictionRequest) -> Iterator[AssetPrediction]:
        self.requests.append(request)
        for target in request.targets:
            yield AssetPrediction(
                asset_id=target.asset_id, model_ref=self.model_ref, regions=self.regions
            )


class Pool:
    def __init__(self, provider: Provider) -> None:
        self.provider = provider

    def get(self, connection: InferenceConnection, *, workspace_root: Path) -> object:
        return self.provider

    def served(self, connection: InferenceConnection, *, workspace_root: Path) -> ServedFamily:
        return ServedFamily(
            capability=ModelCapability.TEXT_DETECT, produces=frozenset({GeometryType.BBOX})
        )


@pytest.fixture(autouse=True)
def _setup_is_faked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(inference_routes, "require_local_inference", lambda: None)
    monkeypatch.setattr(prelabel_routes, "require_local_inference", lambda: None)
    monkeypatch.setattr(weights_module, "download", lambda connection, *, into, on_bytes=None: into)
    monkeypatch.setattr(
        weights_module,
        "download_size",
        lambda model_id, model_revision: DownloadSize(
            model_id=model_id, model_revision=model_revision, total_bytes=1, file_count=1
        ),
    )


@pytest.fixture()
def provider(monkeypatch: pytest.MonkeyPatch) -> Provider:
    made = Provider(
        (
            PredictedRegion(
                label="car", confidence=0.61, geometry=BboxGeometry(x=1, y=1, width=4, height=4)
            ),
            PredictedRegion(
                label="car", confidence=0.83, geometry=BboxGeometry(x=10, y=2, width=6, height=5)
            ),
            PredictedRegion(
                label="truck", confidence=0.9, geometry=BboxGeometry(x=2, y=2, width=3, height=3)
            ),
        )
    )
    monkeypatch.setattr(detections_module, "resident", lambda: Pool(made))
    return made


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture()
def project(client: TestClient) -> str:
    return str(client.post("/projects", json={"name": "detecting"}).json()["id"])


def a_connection(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    *,
    family: str = TEXT_DETECT_FAMILY,
    ready: bool = True,
) -> str:
    monkeypatch.setattr(weights_module, "family_of", lambda *_, **__: family)
    made = client.post(
        "/inference/connections",
        json={
            "name": f"c-{uuid4().hex[:6]}",
            "connection_type": "local",
            "model_id": f"some/{family}",
            "model_revision": "v1",
            "device": "cpu",
            "precision": "fp32",
        },
    ).json()
    if ready:
        assert client.post(f"/inference/connections/{made['id']}/download").status_code == 202
    return str(made["id"])


def an_asset(client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path) -> str:
    write_image(tmp_path / "one.png", size=(32, 24))
    with (tmp_path / "one.png").open("rb") as handle:
        source = client.post(
            f"/projects/{project}/sources/images",
            files=[("files", ("one.png", handle, "image/png"))],
        ).json()
    client.post(f"/sources/{source['id']}/ingest-jobs", json={})
    runner.wait()
    return str(client.get(f"/projects/{project}/assets").json()["items"][0]["id"])


def ask(client: TestClient, **body: Any) -> Any:
    return client.post(
        "/inference/detect",
        json={"label_class": "car", "allowed_geometries": ["bbox", "polygon"], **body},
    )


def test_candidates_carry_their_own_scores_in_order(
    client: TestClient,
    runner: InlineDispatcher,
    project: str,
    tmp_path: Path,
    provider: Provider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = a_connection(client, monkeypatch)
    asset = an_asset(client, runner, project, tmp_path)

    response = ask(client, project_id=project, asset_id=asset, connection_id=connection)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["model_ref"] == "acme/detector@abc"
    assert body["phrase"] == "car"
    assert body["limit"] == 100
    assert [(c["id"], c["confidence"], c["label_class"]) for c in body["candidates"]] == [
        ("c0", 0.83, "car"),
        ("c1", 0.61, "car"),
    ]
    assert all("contour" not in candidate for candidate in body["candidates"])
    assert body["discarded"] == {
        "unmapped_label": 1,
        "incompatible_geometry": 0,
        "out_of_bounds": 0,
        "below_minimum_confidence": 0,
        "over_limit": 0,
    }
    assert provider.requests[0].minimum_confidence == 0.35


def test_nothing_is_written(
    client: TestClient,
    runner: InlineDispatcher,
    project: str,
    tmp_path: Path,
    provider: Provider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = a_connection(client, monkeypatch)
    asset = an_asset(client, runner, project, tmp_path)
    before = client.get(f"/projects/{project}/assets/{asset}").json()

    ask(client, project_id=project, asset_id=asset, connection_id=connection)

    assert client.get(f"/projects/{project}/assets/{asset}").json() == before


def test_a_connection_not_set_up_is_refused_before_the_model(
    client: TestClient, project: str, provider: Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = a_connection(client, monkeypatch, ready=False)

    response = ask(client, project_id=project, asset_id=str(uuid4()), connection_id=connection)

    assert response.status_code == 409
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_SET_UP"
    assert provider.requests == []


def test_a_point_segmenter_is_refused(
    client: TestClient, project: str, provider: Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = a_connection(client, monkeypatch, family=POINT_SUGGEST_FAMILY)

    response = ask(client, project_id=project, asset_id=str(uuid4()), connection_id=connection)

    assert response.status_code == 422
    assert response.json()["code"] == "UNSUPPORTED_PROMPT"
    assert provider.requests == []


def test_a_local_model_without_the_runtime_is_refused(
    client: TestClient, project: str, provider: Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = a_connection(client, monkeypatch)

    def missing() -> None:
        raise LocalInferenceUnavailable("install the extra")

    monkeypatch.setattr(prelabel_routes, "require_local_inference", missing)

    response = ask(client, project_id=project, asset_id=str(uuid4()), connection_id=connection)

    assert response.json()["code"] == "LOCAL_INFERENCE_UNAVAILABLE"
    assert provider.requests == []


@pytest.mark.parametrize(
    "body",
    [
        {"label_class": ""},
        {"allowed_geometries": []},
        {"phrase": ""},
        {"minimum_confidence": 1.5},
        {"positive": [{"x": 1, "y": 1}]},
    ],
)
def test_a_malformed_request_is_refused(client: TestClient, project: str, body: Any) -> None:
    response = ask(
        client, project_id=project, asset_id=str(uuid4()), connection_id=str(uuid4()), **body
    )

    assert response.status_code == 422


def test_suggest_takes_none_of_the_detect_fields(client: TestClient, project: str) -> None:
    response = client.post(
        "/inference/suggest",
        json={
            "project_id": project,
            "asset_id": str(uuid4()),
            "connection_id": str(uuid4()),
            "positive": [{"x": 1, "y": 1}],
            "allowed_geometries": ["bbox"],
            "label_class": "car",
        },
    )

    assert response.status_code == 422
