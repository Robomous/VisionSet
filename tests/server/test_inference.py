"""The inference-connection endpoints, against a real workspace on disk.

Every assertion here is about the *wire*: the status, the body, the code a client
branches on, and what `allowed_actions` declares. What the kernel does underneath
is `tests/kernel/test_inference_connections.py`'s subject.
"""

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client

LOCAL: dict[str, Any] = {
    "name": "local-gd",
    "connection_type": "local",
    "model_id": "some/model",
    "model_revision": "abc123",
    "device": "cpu",
    "precision": "fp16",
}

HTTP: dict[str, Any] = {
    "name": "remote",
    "connection_type": "http",
    "model_id": "some/model",
    "model_revision": "abc123",
    "endpoint_url": "https://example.invalid/predict",
}


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws") as made:
        yield made


def created(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    response = client.post("/inference/connections", json=body)
    assert response.status_code == 201, response.text
    made: dict[str, Any] = response.json()
    return made


# --- creating -----------------------------------------------------------------


def test_creating_a_connection_answers_with_it(client: TestClient) -> None:
    made = created(client, LOCAL)
    assert made["name"] == "local-gd"
    assert made["connection_type"] == "local"
    assert made["setup_state"] == "not_set_up"


def test_an_http_connection_is_ready_on_arrival(client: TestClient) -> None:
    assert created(client, HTTP)["setup_state"] == "ready"


def test_parameters_that_do_not_match_the_kind_are_refused(client: TestClient) -> None:
    """A 422: the payload itself is wrong, rather than the resource's state."""
    response = client.post("/inference/connections", json=LOCAL | {"endpoint_url": "https://x"})
    assert response.status_code == 422, response.text


def test_a_taken_name_is_a_conflict(client: TestClient) -> None:
    created(client, LOCAL)
    response = client.post("/inference/connections", json=HTTP | {"name": "LOCAL-GD"})
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "INFERENCE_CONNECTION_NAME_TAKEN"


def test_a_caller_cannot_declare_a_connection_already_set_up(client: TestClient) -> None:
    """`setup_state` is not an input, so supplying it changes nothing.

    Weights being present is a fact about the disk, and a client saying otherwise
    must not be able to make the workspace believe it.
    """
    assert created(client, LOCAL | {"setup_state": "ready"})["setup_state"] == "not_set_up"


# --- reading ------------------------------------------------------------------


def test_listing_is_the_envelope(client: TestClient) -> None:
    created(client, LOCAL)
    created(client, HTTP)
    body = client.get("/inference/connections").json()
    assert set(body) == {"items", "total"}
    assert body["total"] == 2
    assert [one["name"] for one in body["items"]] == ["local-gd", "remote"]


def test_an_empty_listing_is_an_envelope_not_an_array(client: TestClient) -> None:
    assert client.get("/inference/connections").json() == {"items": [], "total": 0}


def test_an_unknown_connection_is_not_found(client: TestClient) -> None:
    response = client.get(f"/inference/connections/{uuid4()}")
    assert response.status_code == 404, response.text
    assert response.json()["code"] == "INFERENCE_CONNECTION_NOT_FOUND"


# --- what it declares ---------------------------------------------------------


def test_a_connection_declares_what_this_slice_can_perform(client: TestClient) -> None:
    """The declared set is exactly the routes that exist.

    `download_weights` and `test` are the actions this resource will grow, and
    neither is declared while nothing performs it — a declaration obliges every
    conforming client to render a control.
    """
    for body in (LOCAL, HTTP):
        assert created(client, body)["allowed_actions"] == ["update", "delete"]


@pytest.mark.parametrize("body", [LOCAL, HTTP], ids=["local", "http"])
def test_every_declared_action_is_one_the_api_performs(
    client: TestClient, body: dict[str, Any]
) -> None:
    """Declared ⇔ reachable, walked over HTTP rather than asserted about a table.

    `tests/architecture/test_capability_reachability.py` is deliberately
    batches-only — it requires an MCP tool as well as a route, and MCP is a later
    slice for this resource — so the reachability half is proved here instead.
    """
    made = created(client, body)
    routes = {
        "update": lambda: client.patch(
            f"/inference/connections/{made['id']}", json={"model_revision": "deadbeef"}
        ),
        "delete": lambda: client.delete(f"/inference/connections/{made['id']}"),
    }
    assert set(made["allowed_actions"]) == set(routes)
    for action in made["allowed_actions"]:
        response = routes[action]()
        assert response.status_code in (200, 204), (action, response.text)


# --- updating -----------------------------------------------------------------


def test_an_omitted_field_is_left_alone(client: TestClient) -> None:
    made = created(client, LOCAL)
    edited = client.patch(
        f"/inference/connections/{made['id']}", json={"model_revision": "deadbeef"}
    ).json()
    assert edited["model_revision"] == "deadbeef"
    assert edited["device"] == "cpu"
    assert edited["name"] == "local-gd"


def test_an_edit_moves_the_updated_stamp(client: TestClient) -> None:
    made = created(client, LOCAL)
    edited = client.patch(
        f"/inference/connections/{made['id']}", json={"model_revision": "deadbeef"}
    ).json()
    assert edited["updated_at"] > made["updated_at"]
    assert edited["created_at"] == made["created_at"]


def test_the_kind_is_not_editable(client: TestClient) -> None:
    """`ConnectionUpdate` has no `connection_type`, so supplying one changes nothing."""
    made = created(client, LOCAL)
    edited = client.patch(
        f"/inference/connections/{made['id']}", json={"connection_type": "http"}
    ).json()
    assert edited["connection_type"] == "local"


def test_an_edit_into_a_shape_the_kind_refuses_is_a_422(client: TestClient) -> None:
    made = created(client, LOCAL)
    response = client.patch(
        f"/inference/connections/{made['id']}", json={"endpoint_url": "https://x"}
    )
    assert response.status_code == 422, response.text


# --- deleting -----------------------------------------------------------------


def test_deleting_answers_no_content_and_removes_it(client: TestClient) -> None:
    made = created(client, LOCAL)
    assert client.delete(f"/inference/connections/{made['id']}").status_code == 204
    assert client.get(f"/inference/connections/{made['id']}").status_code == 404


def test_deleting_needs_no_confirmation(client: TestClient) -> None:
    """Unlike a project: what is destroyed is a configuration, not work.

    Provenance is denormalised onto the annotation at write time, so nothing
    holds a key to this row (`cf. #417`).
    """
    made = created(client, LOCAL)
    assert client.delete(f"/inference/connections/{made['id']}").status_code == 204


def test_deleting_an_unknown_connection_is_not_found(client: TestClient) -> None:
    assert client.delete(f"/inference/connections/{uuid4()}").status_code == 404
