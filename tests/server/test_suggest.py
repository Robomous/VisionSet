"""The suggest route: what it refuses, in what order, and what a suggestion looks like.

The model is a stand-in — running a real segmenter is neither a unit test nor a
thing CI should do — but everything else on the path is shipped code: the route,
the orchestration, the narrowing to what the class admits, and the error
translation.

The refusal tests deliberately send no asset at all. That is not a shortcut: the
orchestration resolves the connection *before* it looks the asset up, precisely
so somebody part-way through setting a connection up is told about the
connection rather than about an asset that was never the problem. These tests are
what holds that order in place.
"""

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

from visionset.inference import suggestions as suggestions_module
from visionset.inference import weights as weights_module
from visionset.kernel.domain import AssetPrediction, PolygonGeometry, PredictedRegion
from visionset.server.routes import inference as inference_routes


@pytest.fixture(autouse=True)
def downloadable(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Let a connection genuinely reach ``ready`` without a network or the extra.

    The two seams ``test_inference`` already uses: the route's install check, and
    the one function that would touch the network. Everything between them —
    the gate, the ordering, the write that records the connection ready — is the
    shipped code, so a connection that says it is ready here got there the way a
    real one does. Without this the helper below would quietly leave every
    connection ``not_set_up`` and the happy-path tests would be passing on a
    stub that hid a 409.
    """
    monkeypatch.setattr(inference_routes, "require_local_inference", lambda: None)
    monkeypatch.setattr(weights_module, "download", lambda connection, *, into: into)


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture()
def project(client: TestClient) -> str:
    made = client.post("/projects", json={"name": "suggesting"})
    return str(made.json()["id"])


def a_connection(client: TestClient, *, kind: str = "local", ready: bool = True) -> str:
    body: dict[str, Any] = (
        {
            "name": f"c-{uuid4().hex[:6]}",
            "connection_type": "local",
            "model_id": "some/segmenter",
            "model_revision": "abc123",
            "device": "cpu",
            "precision": "fp32",
        }
        if kind == "local"
        else {
            "name": f"c-{uuid4().hex[:6]}",
            "connection_type": "http",
            "model_id": "some/model",
            "model_revision": "v1",
            "endpoint_url": "https://example.invalid/predict",
        }
    )
    made = client.post("/inference/connections", json=body).json()
    if kind == "local" and ready:
        queued = client.post(f"/inference/connections/{made['id']}/download")
        assert queued.status_code == 202, queued.text
        assert (
            client.get(f"/inference/connections/{made['id']}").json()["setup_state"] == "ready"
        ), "the helper must leave a connection genuinely ready, not merely asked"
    return str(made["id"])


def an_asset(client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path) -> str:
    write_image(tmp_path / "one.png")
    with (tmp_path / "one.png").open("rb") as handle:
        source = client.post(
            f"/projects/{project}/sources/images",
            files=[("files", ("one.png", handle, "image/png"))],
        ).json()
    client.post(f"/sources/{source['id']}/ingest-jobs", json={})
    runner.wait()
    return str(client.get(f"/projects/{project}/assets").json()["items"][0]["id"])


def ask(
    client: TestClient,
    *,
    project: str,
    asset: str,
    connection: str,
    allowed: list[str] | None = None,
    positive: list[dict[str, float]] | None = None,
    negative: list[dict[str, float]] | None = None,
) -> Any:
    return client.post(
        "/inference/suggest",
        json={
            "project_id": project,
            "asset_id": asset,
            "connection_id": connection,
            "positive": [{"x": 32.0, "y": 32.0}] if positive is None else positive,
            "negative": negative or [],
            "allowed_geometries": ["polygon"] if allowed is None else allowed,
        },
    )


@pytest.fixture()
def answering(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """A provider that answers from a script, installed where the route resolves one."""
    asked: list[Any] = []

    class Provider:
        model_ref = "some/segmenter@abc123"

        def predict(self, request: Any) -> Any:
            asked.append(request)
            polygon = PolygonGeometry(points=[(2.0, 3.0), (12.0, 3.0), (12.0, 9.0), (2.0, 9.0)])
            yield AssetPrediction(
                asset_id=request.targets[0].asset_id,
                model_ref=self.model_ref,
                regions=(PredictedRegion(label="", confidence=0.82, geometry=polygon),),
            )

    class Pool:
        def get(self, connection: Any, *, workspace_root: Path) -> Any:
            return Provider()

    monkeypatch.setattr(suggestions_module, "resident", Pool)
    return asked


# --- refusals, and their order ------------------------------------------------


def test_an_unknown_connection_is_not_found(client: TestClient, project: str) -> None:
    answer = ask(client, project=project, asset=str(uuid4()), connection=str(uuid4()))
    assert answer.status_code == 404
    assert answer.json()["code"] == "INFERENCE_CONNECTION_NOT_FOUND"


def test_a_connection_without_weights_is_refused_with_what_to_do(
    client: TestClient, project: str
) -> None:
    """409 rather than 500: the caller changes something and resubmits."""
    connection = a_connection(client, ready=False)
    answer = ask(client, project=project, asset=str(uuid4()), connection=connection)
    assert answer.status_code == 409
    assert answer.json()["code"] == "INFERENCE_CONNECTION_NOT_SET_UP"
    assert "download_weights" in answer.json()["message"]


def test_an_http_connection_says_this_build_cannot_run_it(client: TestClient, project: str) -> None:
    connection = a_connection(client, kind="http")
    answer = ask(client, project=project, asset=str(uuid4()), connection=connection)
    assert answer.json()["code"] == "INFERENCE_CONNECTION_NOT_RUNNABLE"


def test_the_connection_is_resolved_before_the_asset(client: TestClient, project: str) -> None:
    """A connection problem and a nonexistent asset together answer about the connection.

    The order the orchestration documents, pinned: somebody part-way through
    setting a connection up should not be told their asset is missing instead.
    """
    connection = a_connection(client, ready=False)
    answer = ask(client, project=project, asset=str(uuid4()), connection=connection)
    assert answer.json()["code"] == "INFERENCE_CONNECTION_NOT_SET_UP"


def test_an_unknown_asset_is_not_found_once_the_connection_is_fine(
    client: TestClient, project: str, answering: list[Any]
) -> None:
    connection = a_connection(client)
    answer = ask(client, project=project, asset=str(uuid4()), connection=connection)
    assert answer.status_code == 404
    assert answer.json()["code"] == "ASSET_NOT_FOUND"


def test_a_gesture_with_no_positive_point_is_unprocessable(
    client: TestClient, project: str
) -> None:
    """Negatives refine an answer; they cannot be the whole of a question."""
    answer = ask(client, project=project, asset=str(uuid4()), connection=str(uuid4()), positive=[])
    assert answer.status_code == 422


def test_a_request_naming_no_geometry_kinds_is_unprocessable(
    client: TestClient, project: str
) -> None:
    answer = ask(client, project=project, asset=str(uuid4()), connection=str(uuid4()), allowed=[])
    assert answer.status_code == 422


# --- the answer ---------------------------------------------------------------


def test_a_click_comes_back_as_a_polygon_with_its_confidence_and_model(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    body = ask(client, project=project, asset=asset, connection=connection).json()

    assert body["model_ref"] == "some/segmenter@abc123"
    assert body["region"]["confidence"] == pytest.approx(0.82)
    assert body["region"]["geometry"]["type"] == "polygon"
    assert len(body["region"]["geometry"]["points"]) == 4


def test_a_box_only_class_is_offered_the_outlines_extent(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """D3's fallback over HTTP, and the test the PR body names for the geometry mutation.

    Stop respecting ``allowed_geometries`` — return the polygon regardless — and
    this goes red while every other assertion in the file stays green, because a
    polygon is a perfectly valid answer to every *other* question asked here.
    """
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    body = ask(client, project=project, asset=asset, connection=connection, allowed=["bbox"]).json()

    assert body["region"]["geometry"] == {
        "type": "bbox",
        "x": 2.0,
        "y": 3.0,
        "width": 10.0,
        "height": 6.0,
    }


def test_a_tag_only_class_is_offered_nothing_rather_than_a_shape_it_cannot_hold(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """D3's third case. Not an error — the gesture simply has nothing to propose."""
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    body = ask(
        client,
        project=project,
        asset=asset,
        connection=connection,
        allowed=["classification_tag"],
    ).json()

    assert body["region"] is None
    assert body["model_ref"] == "some/segmenter@abc123", "still says who was asked"


def test_negative_points_travel_to_the_provider(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    ask(
        client,
        project=project,
        asset=asset,
        connection=connection,
        positive=[{"x": 1.0, "y": 2.0}],
        negative=[{"x": 3.0, "y": 4.0}],
    )

    prompt = answering[0].prompt
    assert prompt.positive == ((1.0, 2.0),)
    assert prompt.negative == ((3.0, 4.0),)


def test_the_provider_is_handed_bytes_rather_than_a_path(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """The port's dual test, observed end to end: a hosted provider shares no filesystem."""
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    ask(client, project=project, asset=asset, connection=connection)

    (target,) = answering[0].targets
    assert isinstance(target.content, bytes) and target.content[:4] == b"\x89PNG"
    assert target.media_type == "image/png"


def test_nothing_is_written_by_asking(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """A suggestion is a proposal. Accepting it is a separate, ordinary annotation write."""
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)
    before = client.get(f"/projects/{project}/assets/{asset}").json()

    ask(client, project=project, asset=asset, connection=connection)

    assert client.get(f"/projects/{project}/assets/{asset}").json() == before
