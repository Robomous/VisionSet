"""The annotation schema endpoints, against a real workspace on disk.

Versions are 1..N and none is ever edited, so the only write here is appending
the next one. The rest is reading, plus the two gates on narrowing the contract.
"""

from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws") as made:
        yield made


@pytest.fixture()
def project(client: TestClient) -> str:
    """A project id to hang schema versions off."""
    response = client.post("/projects", json={"name": "road-signs"})
    assert response.status_code == 201, response.text
    project_id: str = response.json()["id"]
    return project_id


def post_version(client: TestClient, project: str, *classes: dict[str, Any], **query: Any) -> Any:
    return client.post(
        f"/projects/{project}/schema/versions", json={"classes": list(classes)}, params=query
    )


def a_class(name: str = "sign", **overrides: Any) -> dict[str, Any]:
    return {"name": name, "geometry": "bbox", **overrides}


# --- the empty start ---------------------------------------------------------


def test_a_project_with_no_schema_has_no_active_version(client: TestClient, project: str) -> None:
    response = client.get(f"/projects/{project}/schema")

    assert response.status_code == 404
    assert response.json()["code"] == "SCHEMA_NOT_FOUND"


def test_listing_versions_of_a_project_with_no_schema_is_an_empty_page(
    client: TestClient, project: str
) -> None:
    """Schema-less is the ordinary starting state, so listing is not a refusal."""
    response = client.get(f"/projects/{project}/schema/versions")

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0}


# --- appending versions ------------------------------------------------------


def test_creating_the_first_version_answers_201_and_numbers_it_1(
    client: TestClient, project: str
) -> None:
    response = post_version(client, project, a_class())

    assert response.status_code == 201
    assert response.json()["version"] == 1
    assert response.json()["project_id"] == project


def test_the_next_version_is_numbered_one_higher(client: TestClient, project: str) -> None:
    post_version(client, project, a_class())

    response = post_version(client, project, a_class(), a_class("lane", geometry="polygon"))

    assert response.status_code == 201
    assert response.json()["version"] == 2


def test_the_active_version_is_the_highest_one(client: TestClient, project: str) -> None:
    post_version(client, project, a_class())
    post_version(client, project, a_class(), a_class("lane"))

    body = client.get(f"/projects/{project}/schema").json()

    assert body["version"] == 2
    assert [c["name"] for c in body["classes"]] == ["sign", "lane"]


def test_a_version_is_readable_by_its_number(client: TestClient, project: str) -> None:
    """The old version keeps its own classes; a new one never edits it."""
    post_version(client, project, a_class())
    post_version(client, project, a_class(), a_class("lane"))

    body = client.get(f"/projects/{project}/schema/versions/1").json()

    assert body["version"] == 1
    assert [c["name"] for c in body["classes"]] == ["sign"]


def test_an_unknown_version_number_is_404_schema_not_found(
    client: TestClient, project: str
) -> None:
    post_version(client, project, a_class())

    response = client.get(f"/projects/{project}/schema/versions/7")

    assert response.status_code == 404
    assert response.json()["code"] == "SCHEMA_NOT_FOUND"


def test_version_zero_is_422_because_no_version_could_ever_be_zero(
    client: TestClient, project: str
) -> None:
    """`ge=1` mirrors the domain's own bound, so this is about the request.

    Without it, `0` would reach the service and come back as a 404 about a
    version that could not have existed.
    """
    response = client.get(f"/projects/{project}/schema/versions/0")

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_versions_are_listed_oldest_first(client: TestClient, project: str) -> None:
    for extra in range(3):
        post_version(client, project, *(a_class(f"sign-{n}") for n in range(extra + 1)))

    body = client.get(f"/projects/{project}/schema/versions").json()

    assert [item["version"] for item in body["items"]] == [1, 2, 3]
    assert body["total"] == 3


# --- what a version may contain ----------------------------------------------


def test_a_class_with_an_unimplemented_geometry_is_422_unsupported_geometry(
    client: TestClient, project: str
) -> None:
    """`mask` is in the enum and has no implementation — a precise refusal.

    The wire model keeps all eight members deliberately, so naming one gets this
    rather than "not a valid enumeration member".
    """
    response = post_version(client, project, a_class(geometry="mask"))

    assert response.status_code == 422
    assert response.json()["code"] == "UNSUPPORTED_GEOMETRY"


def test_a_geometry_outside_the_enum_is_422_validation_error(
    client: TestClient, project: str
) -> None:
    response = post_version(client, project, a_class(geometry="hexagon"))

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_two_classes_with_one_name_are_422_invalid_schema(client: TestClient, project: str) -> None:
    """A cross-class rule, so it belongs to the service and not to `LabelClass`."""
    response = post_version(client, project, a_class("Sign"), a_class("sign"))

    assert response.status_code == 422
    assert response.json()["code"] == "INVALID_SCHEMA"


def test_a_blank_class_name_is_422_validation_error_not_500(
    client: TestClient, project: str
) -> None:
    """The trap this whole design turns on.

    `LabelClass` refuses a blank name with a `pydantic.ValidationError`. Built in
    the route body that is neither a domain error nor a request-validation
    failure, so it reaches the catch-all handler and answers 500 to a plainly
    malformed payload. `LabelClassBody` builds the domain object during parsing
    instead, which puts the domain's own message on the offending field.

    The `loc` reaches all the way to `name` rather than stopping at the class:
    pydantic merges a `ValidationError` raised *inside* a validator into the
    outer path, so the domain's field-level location survives the conversion.
    """
    response = post_version(client, project, a_class(" "))

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"
    error = response.json()["detail"]["errors"][0]
    assert error["loc"] == ["body", "classes", 0, "name"]
    assert "at least one non-blank character" in error["msg"]


def test_a_select_attribute_with_no_options_is_422_validation_error(
    client: TestClient, project: str
) -> None:
    attribute = {"name": "weather", "kind": "select"}
    response = post_version(client, project, a_class(attributes=[attribute]))

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert "needs at least one option" in response.text


def test_an_attribute_default_of_the_wrong_kind_is_422_validation_error(
    client: TestClient, project: str
) -> None:
    attribute = {"name": "occluded", "kind": "boolean", "default": "yes"}
    response = post_version(client, project, a_class(attributes=[attribute]))

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_attributes_and_colors_survive_the_round_trip(client: TestClient, project: str) -> None:
    attribute = {
        "name": "weather",
        "kind": "select",
        "required": True,
        "options": ["sun", "rain"],
        "default": "sun",
    }
    label_class = a_class(color="#ff0000", attributes=[attribute])

    post_version(client, project, label_class)
    body = client.get(f"/projects/{project}/schema").json()

    assert body["classes"] == [
        {"name": "sign", "geometry": "bbox", "color": "#ff0000", "attributes": [attribute]}
    ]


# --- the gate on narrowing ---------------------------------------------------


def test_removing_a_class_is_409_destructive_schema_change(
    client: TestClient, project: str
) -> None:
    post_version(client, project, a_class("sign"), a_class("lane"))

    response = post_version(client, project, a_class("sign"))

    assert response.status_code == 409
    assert response.json()["code"] == "DESTRUCTIVE_SCHEMA_CHANGE"


def test_the_same_change_with_allow_destructive_succeeds(client: TestClient, project: str) -> None:
    """Retrying is the identical body plus one query parameter."""
    post_version(client, project, a_class("sign"), a_class("lane"))

    response = post_version(client, project, a_class("sign"), allow_destructive=True)

    assert response.status_code == 201
    assert [c["name"] for c in response.json()["classes"]] == ["sign"]


# --- an unknown project ------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "suffix"),
    [("POST", "/versions"), ("GET", "/versions"), ("GET", "/versions/1"), ("GET", "")],
)
def test_every_schema_route_of_an_unknown_project_is_404_project_not_found(
    client: TestClient, method: str, suffix: str
) -> None:
    """A different code from `SCHEMA_NOT_FOUND`, at the same status."""
    response = client.request(method, f"/projects/{uuid4()}/schema{suffix}", json={"classes": []})

    assert response.status_code == 404, f"{method} {suffix}"
    assert response.json()["code"] == "PROJECT_NOT_FOUND"


# --- the guard ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "suffix"),
    [("POST", "/versions"), ("GET", "/versions"), ("GET", "/versions/1"), ("GET", "")],
)
def test_every_schema_route_refuses_a_request_without_a_token(
    client: TestClient, project: str, method: str, suffix: str
) -> None:
    response = client.request(
        method,
        f"/projects/{project}/schema{suffix}",
        json={"classes": []},
        headers={"Authorization": ""},
    )

    assert response.status_code == 401, f"{method} {suffix}"
    assert response.json()["code"] == "UNAUTHORIZED"


# --- the commit message, and when it was written (#230) -----------------------


def test_a_version_carries_its_description_and_a_server_stamped_moment(
    client: TestClient, project: str
) -> None:
    response = client.post(
        f"/projects/{project}/schema/versions",
        json={"classes": [a_class("sign")], "description": "the first contract"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["description"] == "the first contract"
    assert body["created_at"] is not None
    # Parsed rather than pattern-matched: the claim is that it is a real UTC
    # instant, not that it looks like one.
    assert datetime.fromisoformat(body["created_at"]).tzinfo is not None


def test_a_version_published_without_a_description_answers_null(
    client: TestClient, project: str
) -> None:
    body = post_version(client, project, a_class("sign")).json()

    assert body["description"] is None


def test_a_blank_description_is_null_rather_than_422(client: TestClient, project: str) -> None:
    """An empty commit message is legal. This is not a name."""
    response = client.post(
        f"/projects/{project}/schema/versions",
        json={"classes": [a_class("sign")], "description": "   "},
    )

    assert response.status_code == 201
    assert response.json()["description"] is None


def test_the_listing_carries_each_versions_own_description(
    client: TestClient, project: str
) -> None:
    client.post(
        f"/projects/{project}/schema/versions",
        json={"classes": [a_class("sign")], "description": "first"},
    )
    client.post(
        f"/projects/{project}/schema/versions",
        json={"classes": [a_class("sign"), a_class("lane")], "description": "lanes too"},
    )

    items = client.get(f"/projects/{project}/schema/versions").json()["items"]

    assert [item["description"] for item in items] == ["first", "lanes too"]
    assert all(item["created_at"] for item in items)


def test_there_is_no_route_that_edits_a_published_description(
    client: TestClient, project: str
) -> None:
    """A version is immutable, so its commit message is too — by having no door."""
    post_version(client, project, a_class("sign"))

    for method in (client.patch, client.put):
        response = method(
            f"/projects/{project}/schema/versions/1", json={"description": "second thoughts"}
        )
        assert response.status_code in (404, 405), response.status_code
