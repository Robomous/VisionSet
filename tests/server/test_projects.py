"""The project endpoints, against a real workspace on disk.

Every assertion here is about the *wire*: the status, the body, the code a
client branches on. What the kernel does underneath is `tests/kernel/
test_project_service.py`'s subject, and restating it here would be two tests
that fail together and tell you nothing extra.
"""

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws") as made:
        yield made


def created(client: TestClient, name: str, description: str | None = None) -> dict[str, object]:
    """POST a project and return its body, failing loudly if it did not take."""
    body: dict[str, object] = {"name": name}
    if description is not None:
        body["description"] = description
    response = client.post("/projects", json=body)
    assert response.status_code == 201, response.text
    made: dict[str, object] = response.json()
    return made


# --- creating ----------------------------------------------------------------


def test_creating_a_project_answers_201_with_its_new_id(client: TestClient) -> None:
    response = client.post("/projects", json={"name": "road-signs"})

    assert response.status_code == 201
    assert response.json()["name"] == "road-signs"
    assert response.json()["id"]


def test_a_created_project_is_then_readable_by_id(client: TestClient) -> None:
    made = created(client, "road-signs")

    response = client.get(f"/projects/{made['id']}")

    assert response.status_code == 200
    assert response.json() == made


def test_the_description_is_optional_and_comes_back_as_null(client: TestClient) -> None:
    """Present rather than absent, because ``ProjectOut`` declares no default.

    A generated client types it ``description: string | null``, so a consumer
    never has to tell "not set" from "the server did not say".
    """
    assert created(client, "road-signs")["description"] is None
    assert created(client, "traffic-lights", "night shots")["description"] == "night shots"


def test_creating_a_project_with_a_taken_name_is_409_project_name_taken(
    client: TestClient,
) -> None:
    created(client, "road-signs")

    response = client.post("/projects", json={"name": "road-signs"})

    assert response.status_code == 409
    assert response.json()["code"] == "PROJECT_NAME_TAKEN"


def test_creating_a_project_with_a_blank_name_is_422_invalid_name(client: TestClient) -> None:
    """A domain refusal, so the code is the kernel's and ``detail`` is empty.

    The other shape of 422 is below: pydantic's, which carries ``detail.errors``.
    Both are 422 and only ``code`` tells them apart.
    """
    response = client.post("/projects", json={"name": "   "})

    assert response.status_code == 422
    assert response.json()["code"] == "INVALID_NAME"
    assert response.json()["detail"] is None


def test_an_unknown_field_in_the_body_is_422_validation_error(client: TestClient) -> None:
    """``extra="forbid"`` — a typo is refused, never silently dropped."""
    response = client.post("/projects", json={"name": "road-signs", "descriptoin": "typo"})

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert response.json()["detail"]["errors"]


# --- listing -----------------------------------------------------------------


def test_listing_projects_returns_an_envelope_with_items_and_total(client: TestClient) -> None:
    """Never a bare array: an array cannot grow a field without breaking clients."""
    created(client, "road-signs")

    body = client.get("/projects").json()

    assert set(body) == {"items", "total"}
    assert body["total"] == 1
    assert [item["name"] for item in body["items"]] == ["road-signs"]


def test_a_fresh_workspace_lists_an_empty_page_rather_than_a_404(client: TestClient) -> None:
    response = client.get("/projects")

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0}


def test_the_listing_keeps_creation_order(client: TestClient) -> None:
    for name in ("first", "second", "third"):
        created(client, name)

    body = client.get("/projects").json()

    assert [item["name"] for item in body["items"]] == ["first", "second", "third"]
    assert body["total"] == 3


# --- reading -----------------------------------------------------------------


def test_getting_an_unknown_project_is_404_project_not_found(client: TestClient) -> None:
    response = client.get(f"/projects/{uuid4()}")

    assert response.status_code == 404
    assert response.json()["code"] == "PROJECT_NOT_FOUND"


def test_a_malformed_uuid_in_the_path_is_422_not_404(client: TestClient) -> None:
    """The request never reaches the service, so it is about the request.

    Worth pinning: a client hand-building a URL hits this, and 404 would read as
    "no such project" for something that could never name one.
    """
    response = client.get("/projects/not-a-uuid")

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


# --- renaming ----------------------------------------------------------------


def test_renaming_a_project_returns_it_under_the_new_name(client: TestClient) -> None:
    made = created(client, "road-signs")

    response = client.patch(f"/projects/{made['id']}", json={"name": "street-signs"})

    assert response.status_code == 200
    assert response.json() == {**made, "name": "street-signs"}


def test_renaming_to_a_name_another_project_holds_is_409(client: TestClient) -> None:
    created(client, "road-signs")
    other = created(client, "traffic-lights")

    response = client.patch(f"/projects/{other['id']}", json={"name": "road-signs"})

    assert response.status_code == 409
    assert response.json()["code"] == "PROJECT_NAME_TAKEN"


def test_renaming_a_project_to_its_own_name_is_allowed(client: TestClient) -> None:
    """Fixing the case of your own name is not a collision with yourself."""
    made = created(client, "road-signs")

    response = client.patch(f"/projects/{made['id']}", json={"name": "Road-Signs"})

    assert response.status_code == 200
    assert response.json()["name"] == "Road-Signs"


def test_the_patch_body_cannot_carry_a_description(client: TestClient) -> None:
    """The one mutable field, because the SDK has no way to update the other.

    The API does not grow a field the kernel cannot honour; a request that tried
    is refused rather than half-applied.
    """
    made = created(client, "road-signs", "day shots")

    response = client.patch(
        f"/projects/{made['id']}", json={"name": "road-signs", "description": "night shots"}
    )

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert client.get(f"/projects/{made['id']}").json()["description"] == "day shots"


def test_renaming_an_unknown_project_is_404(client: TestClient) -> None:
    response = client.patch(f"/projects/{uuid4()}", json={"name": "whatever"})

    assert response.status_code == 404
    assert response.json()["code"] == "PROJECT_NOT_FOUND"


# --- deleting ----------------------------------------------------------------


def test_deleting_without_confirm_is_409_confirmation_required(client: TestClient) -> None:
    made = created(client, "road-signs")

    response = client.delete(f"/projects/{made['id']}")

    assert response.status_code == 409
    assert response.json()["code"] == "CONFIRMATION_REQUIRED"
    assert client.get(f"/projects/{made['id']}").status_code == 200


def test_deleting_with_confirm_answers_204_with_an_empty_body(client: TestClient) -> None:
    made = created(client, "road-signs")

    response = client.delete(f"/projects/{made['id']}?confirm=true")

    assert response.status_code == 204
    assert response.content == b""


def test_a_deleted_project_is_then_404(client: TestClient) -> None:
    made = created(client, "road-signs")

    client.delete(f"/projects/{made['id']}?confirm=true")

    assert client.get(f"/projects/{made['id']}").status_code == 404
    assert client.get("/projects").json() == {"items": [], "total": 0}


def test_deleting_an_unknown_project_is_404_before_the_confirmation_check(
    client: TestClient,
) -> None:
    """Existence first, so an unknown id reads the same with the flag and without."""
    unknown = uuid4()

    assert client.delete(f"/projects/{unknown}").status_code == 404
    assert client.delete(f"/projects/{unknown}?confirm=true").status_code == 404


# --- the guard ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/projects"),
        ("GET", "/projects"),
        ("GET", "/projects/{id}"),
        ("PATCH", "/projects/{id}"),
        ("DELETE", "/projects/{id}"),
    ],
)
def test_every_project_route_refuses_a_request_without_a_token(
    client: TestClient, method: str, path: str
) -> None:
    """`protected_router()` guards the router, so no route can be forgotten."""
    made = created(client, "road-signs")
    url = path.format(id=made["id"])

    response = client.request(method, url, json={"name": "x"}, headers={"Authorization": ""})

    assert response.status_code == 401, f"{method} {url}"
    assert response.json()["code"] == "UNAUTHORIZED"
