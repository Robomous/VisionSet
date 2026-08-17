"""The draft over HTTP: four routes, and the 409 that is not a version conflict."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws") as made:
        yield made


@pytest.fixture()
def project(client: TestClient) -> str:
    """A project id to hang schema drafts off."""
    response = client.post("/projects", json={"name": "road-signs"})
    assert response.status_code == 201, response.text
    project_id: str = response.json()["id"]
    return project_id


def test_a_project_with_no_draft_answers_404(client, project) -> None:
    response = client.get(f"/projects/{project}/schema/drafts/curated")
    assert response.status_code == 404
    assert response.json()["code"] == "SCHEMA_DRAFT_NOT_FOUND"


def test_a_put_with_no_revision_creates_it(client, project) -> None:
    response = client.put(
        f"/projects/{project}/schema/drafts/curated",
        json={"classes": [{"name": "car", "geometries": ["bbox"]}], "note": "wip"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["revision"] == 1
    assert body["kind"] == "curated"
    assert body["note"] == "wip"
    assert body["classes"][0]["name"] == "car"


def test_a_half_typed_class_survives_the_round_trip(client, project) -> None:
    client.put(
        f"/projects/{project}/schema/drafts/curated",
        json={"classes": [{"name": "", "geometries": [], "attributes": [{"name": "occlusion"}]}]},
    )
    body = client.get(f"/projects/{project}/schema/drafts/curated").json()
    assert body["classes"][0]["name"] == ""
    assert body["classes"][0]["geometries"] == []
    assert body["classes"][0]["attributes"][0]["kind"] is None


def test_a_put_naming_an_expired_revision_answers_409_stale_write(client, project) -> None:
    client.put(f"/projects/{project}/schema/drafts/curated", json={"classes": []})
    response = client.put(
        f"/projects/{project}/schema/drafts/curated",
        json={"classes": [], "revision": 99},
    )
    assert response.status_code == 409
    assert response.json()["code"] == "STALE_WRITE"


def test_delete_removes_it(client, project) -> None:
    client.put(f"/projects/{project}/schema/drafts/curated", json={"classes": []})
    assert client.delete(f"/projects/{project}/schema/drafts/curated").status_code == 204
    assert client.get(f"/projects/{project}/schema/drafts/curated").status_code == 404


def test_publish_creates_the_version_and_clears_the_draft(client, project) -> None:
    saved = client.put(
        f"/projects/{project}/schema/drafts/curated",
        json={"classes": [{"name": "car", "geometries": ["bbox"]}], "note": "first"},
    ).json()
    response = client.post(
        f"/projects/{project}/schema/drafts/curated/publish",
        json={"revision": saved["revision"]},
    )
    assert response.status_code == 201
    published = response.json()["published"]
    assert published["version"] == 1
    assert published["provenance"] == "curated"
    assert published["description"] == "first"
    assert client.get(f"/projects/{project}/schema/drafts/curated").status_code == 404


def test_publishing_an_unfinished_class_answers_422(client, project) -> None:
    saved = client.put(
        f"/projects/{project}/schema/drafts/curated",
        json={"classes": [{"name": "", "geometries": ["bbox"]}]},
    ).json()
    response = client.post(
        f"/projects/{project}/schema/drafts/curated/publish",
        json={"revision": saved["revision"]},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "INVALID_SCHEMA"


def test_an_unknown_kind_is_a_422_about_the_request(client, project) -> None:
    assert client.get(f"/projects/{project}/schema/drafts/nonsense").status_code == 422
