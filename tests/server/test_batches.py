"""The one batch route #28 ships: what an ingest put in a batch.

#29 owns the rest of this surface. What is pinned here is the envelope and the
404, because those are what its additions have to stay compatible with.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.media import write_image
from tests.server._api import api_client
from tests.server._runner import RecordingRunner


@pytest.fixture()
def runner() -> RecordingRunner:
    return RecordingRunner()


@pytest.fixture()
def client(tmp_path: Path, runner: RecordingRunner) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", runner=runner) as made:
        yield made


def png_part(tmp_path: Path, name: str, seed: int = 0) -> tuple[str, tuple[str, bytes, str]]:
    """One multipart part carrying a generated image."""
    return ("files", (name, write_image(tmp_path / name, seed=seed).read_bytes(), "image/png"))


@pytest.fixture()
def ingested(client: TestClient, tmp_path: Path, runner: RecordingRunner) -> str:
    """A batch id, reached the way a client reaches one: by ingesting into it."""
    project = client.post("/projects", json={"name": "road-signs"}).json()["id"]
    parts = [png_part(tmp_path, f"{index}.png", seed=index) for index in range(3)]
    source = client.post(f"/projects/{project}/sources/images", files=parts).json()["id"]
    job = client.post(f"/sources/{source}/ingest-jobs").json()
    runner.wait()
    batch_id: str = client.get(f"/ingest-jobs/{job['id']}").json()["batch_id"]
    return batch_id


def test_a_batchs_assets_answer_with_the_envelope(client: TestClient, ingested: str) -> None:
    response = client.get(f"/batches/{ingested}/assets")

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 3
    assert len(body["items"]) == 3


def test_membership_order_is_stable(client: TestClient, ingested: str) -> None:
    """Stored order, so reading twice gives the same sequence — what paging will page."""
    first = client.get(f"/batches/{ingested}/assets").json()["items"]
    second = client.get(f"/batches/{ingested}/assets").json()["items"]

    assert [asset["id"] for asset in first] == [asset["id"] for asset in second]


def test_an_asset_carries_its_hashes_but_not_its_path(client: TestClient, ingested: str) -> None:
    """`uri` is a server-side path; reaching the bytes is #30's download by hash."""
    asset = client.get(f"/batches/{ingested}/assets").json()["items"][0]

    assert "uri" not in asset
    assert len(asset["content_hash"]) == 64
    assert len(asset["thumbnail_hash"]) == 64
    assert asset["format"] == "png"


def test_a_batch_an_ingest_could_not_fill_is_an_empty_page_not_a_404(
    client: TestClient, runner: RecordingRunner
) -> None:
    """A run whose every item was unreadable still makes a batch. It is just empty."""
    project = client.post("/projects", json={"name": "empty"}).json()["id"]
    source = client.post(
        f"/projects/{project}/sources/images",
        files=[("files", ("notes.txt", b"not an image", "text/plain"))],
    ).json()["id"]
    job = client.post(f"/sources/{source}/ingest-jobs").json()
    runner.wait()
    batch_id = client.get(f"/ingest-jobs/{job['id']}").json()["batch_id"]

    response = client.get(f"/batches/{batch_id}/assets")

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0}


def test_an_unknown_batch_is_404(client: TestClient) -> None:
    response = client.get(f"/batches/{uuid4()}/assets")

    assert response.status_code == 404
    assert response.json()["code"] == "BATCH_NOT_FOUND"


def test_a_malformed_batch_id_is_422_not_404(client: TestClient) -> None:
    response = client.get("/batches/not-a-uuid/assets")

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_the_batch_route_refuses_a_request_with_no_token(client: TestClient) -> None:
    response = client.get(f"/batches/{uuid4()}/assets", headers={"Authorization": ""})

    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHORIZED"
