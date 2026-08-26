"""Pre-processing recipes over HTTP: a named resource with no state, and a preview."""

from __future__ import annotations

import base64
import io
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from tests.server._api import api_client
from tests.server._flow import asset_ids, batch_from_ingest, project_with_schema
from tests.server._jobs import InlineDispatcher


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture()
def project(client: TestClient) -> str:
    response = client.post("/projects", json={"name": "road-signs"})
    assert response.status_code == 201, response.text
    project_id: str = response.json()["id"]
    return project_id


LETTERBOX: dict[str, Any] = {
    "target": "yolo11",
    "steps": [{"kind": "resize", "strategy": "letterbox", "width": 640, "height": 640}],
    "variants_per_asset": 0,
}
AUGMENTED: dict[str, Any] = {
    "target": None,
    "steps": [
        {"kind": "resize", "strategy": "stretch", "width": 64, "height": 64},
        {"kind": "augment", "op": "hflip"},
        {"kind": "augment", "op": "brightness_contrast", "amount": 0.3},
    ],
    "variants_per_asset": 2,
}


def _base(client: TestClient, project: str) -> str:
    return f"/projects/{project}/preprocessing-recipes"


# --- the resource ---------------------------------------------------------------


def test_a_recipe_is_created_listed_and_read_back_whole(client: TestClient, project: str) -> None:
    created = client.post(_base(client, project), json={"name": "lb", "spec": LETTERBOX})
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["name"] == "lb"
    assert body["project_id"] == project
    assert body["spec"] == {
        "target": "yolo11",
        "steps": [
            {
                "kind": "resize",
                "strategy": "letterbox",
                "width": 640,
                "height": 640,
                "pad_value": 114,
            }
        ],
        "variants_per_asset": 0,
    }
    assert body["created_at"] == body["updated_at"]

    listed = client.get(_base(client, project)).json()
    assert listed == {"items": [body], "total": 1}
    assert client.get(f"{_base(client, project)}/lb").json() == body


def test_a_taken_name_is_409_and_a_bad_name_or_spec_is_422(
    client: TestClient, project: str
) -> None:
    assert (
        client.post(_base(client, project), json={"name": "lb", "spec": LETTERBOX}).status_code
        == 201
    )

    taken = client.post(_base(client, project), json={"name": "lb", "spec": AUGMENTED})
    assert taken.status_code == 409, taken.text
    assert taken.json()["code"] == "PREPROCESSING_RECIPE_NAME_TAKEN"

    bad_name = client.post(_base(client, project), json={"name": "Not A Slug", "spec": LETTERBOX})
    assert bad_name.status_code == 422, bad_name.text
    assert bad_name.json()["code"] == "INVALID_NAME"

    two_resizes = client.post(
        _base(client, project),
        json={
            "name": "two",
            "spec": {"target": None, "steps": [LETTERBOX["steps"][0]] * 2, "variants_per_asset": 0},
        },
    )
    assert two_resizes.status_code == 422, two_resizes.text
    assert two_resizes.json()["code"] == "VALIDATION_ERROR"
    assert "at most one resize" in two_resizes.text

    variants_without_augment = client.post(
        _base(client, project),
        json={"name": "v", "spec": {**LETTERBOX, "variants_per_asset": 2}},
    )
    assert variants_without_augment.status_code == 422, variants_without_augment.text


def test_put_replaces_the_spec_and_can_rename(client: TestClient, project: str) -> None:
    client.post(_base(client, project), json={"name": "lb", "spec": LETTERBOX})
    client.post(_base(client, project), json={"name": "other", "spec": LETTERBOX})

    updated = client.put(f"{_base(client, project)}/lb", json={"name": "aug", "spec": AUGMENTED})
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "aug"
    assert updated.json()["spec"]["variants_per_asset"] == 2
    assert client.get(f"{_base(client, project)}/lb").status_code == 404
    assert client.get(f"{_base(client, project)}/aug").json() == updated.json()

    collision = client.put(
        f"{_base(client, project)}/aug", json={"name": "other", "spec": AUGMENTED}
    )
    assert collision.status_code == 409, collision.text
    assert collision.json()["code"] == "PREPROCESSING_RECIPE_NAME_TAKEN"


def test_delete_removes_it_and_an_unknown_name_is_404(client: TestClient, project: str) -> None:
    client.post(_base(client, project), json={"name": "lb", "spec": LETTERBOX})

    assert client.delete(f"{_base(client, project)}/lb").status_code == 204
    assert client.get(_base(client, project)).json()["total"] == 0
    for response in (
        client.get(f"{_base(client, project)}/lb"),
        client.delete(f"{_base(client, project)}/lb"),
        client.put(f"{_base(client, project)}/lb", json={"name": "lb", "spec": LETTERBOX}),
    ):
        assert response.status_code == 404, response.text
        assert response.json()["code"] == "PREPROCESSING_RECIPE_NOT_FOUND"


def test_an_unknown_project_is_404_on_every_route(client: TestClient) -> None:
    base = f"/projects/{uuid4()}/preprocessing-recipes"
    for response in (
        client.get(base),
        client.post(base, json={"name": "lb", "spec": LETTERBOX}),
        client.get(f"{base}/lb"),
        client.put(f"{base}/lb", json={"name": "lb", "spec": LETTERBOX}),
        client.delete(f"{base}/lb"),
    ):
        assert response.status_code == 404, response.text
        assert response.json()["code"] == "PROJECT_NOT_FOUND"


# --- the preview -------------------------------------------------------------------


@pytest.fixture()
def asset(client: TestClient, tmp_path: Path, runner: InlineDispatcher) -> tuple[str, str]:
    """A project with one ingested asset, and that asset's id."""
    project_id = project_with_schema(client)
    batch_id = batch_from_ingest(client, runner, tmp_path, project_id, images=1)
    (asset_id,) = asset_ids(client, batch_id)
    return project_id, asset_id


def _preview(client: TestClient, project_id: str, body: dict[str, Any]) -> Any:
    return client.post(f"/projects/{project_id}/preprocessing-preview", json=body)


def test_the_preview_renders_the_asset_through_the_spec(
    client: TestClient, asset: tuple[str, str]
) -> None:
    project_id, asset_id = asset

    response = _preview(client, project_id, {"spec": AUGMENTED, "asset_id": asset_id, "variant": 1})

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert (body["asset_id"], body["variant"]) == (asset_id, 1)
    assert (body["width"], body["height"]) == (64, 64)
    assert body["media_type"] in {"image/png", "image/jpeg"}
    with Image.open(io.BytesIO(base64.b64decode(body["image_base64"]))) as image:
        assert image.size == (64, 64)
    assert body["annotations"] == []


def test_the_preview_is_capped_to_512_on_its_longer_side(
    client: TestClient, asset: tuple[str, str]
) -> None:
    project_id, asset_id = asset
    wide = {
        "target": None,
        "steps": [{"kind": "resize", "strategy": "stretch", "width": 2048, "height": 1024}],
        "variants_per_asset": 0,
    }

    body = _preview(client, project_id, {"spec": wide, "asset_id": asset_id}).json()

    assert (body["width"], body["height"]) == (512, 256)
    with Image.open(io.BytesIO(base64.b64decode(body["image_base64"]))) as image:
        assert image.size == (512, 256)


def test_a_variant_the_spec_does_not_make_is_422(
    client: TestClient, asset: tuple[str, str]
) -> None:
    project_id, asset_id = asset

    response = _preview(client, project_id, {"spec": LETTERBOX, "asset_id": asset_id, "variant": 1})

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_an_asset_outside_the_project_is_404(client: TestClient, asset: tuple[str, str]) -> None:
    project_id, asset_id = asset
    other = client.post("/projects", json={"name": "other"}).json()["id"]

    response = _preview(client, other, {"spec": LETTERBOX, "asset_id": asset_id})

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "ASSET_NOT_FOUND"
    missing = _preview(client, project_id, {"spec": LETTERBOX, "asset_id": str(uuid4())})
    assert missing.json()["code"] == "ASSET_NOT_FOUND"
