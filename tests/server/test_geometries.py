"""`GET /geometries`: the kernel's implemented set, published so no client keeps a copy."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client

from visionset.kernel.domain import IMPLEMENTED_GEOMETRIES, GeometryType
from visionset.server.main import create_app
from visionset.server.routes import geometries


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws") as made:
        yield made


def test_the_listing_is_the_kernel_set_sorted_by_name(client: TestClient) -> None:
    body = client.get("/geometries").json()

    expected = sorted(geometry.value for geometry in IMPLEMENTED_GEOMETRIES)
    assert body == {"items": [{"name": name} for name in expected], "total": len(expected)}


def test_the_roadmap_members_are_not_offered(client: TestClient) -> None:
    names = {row["name"] for row in client.get("/geometries").json()["items"]}

    assert GeometryType.MASK.value not in names
    assert GeometryType.KEYPOINTS.value not in names


def test_a_member_implemented_server_side_is_listed_with_no_other_edit(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The route reads the constant on every call rather than holding a copy of it."""
    monkeypatch.setattr(
        geometries, "IMPLEMENTED_GEOMETRIES", IMPLEMENTED_GEOMETRIES | {GeometryType.MASK}
    )

    names = [row["name"] for row in client.get("/geometries").json()["items"]]

    assert "mask" in names
    assert names == sorted(names)


def test_the_listing_requires_a_token(client: TestClient) -> None:
    response = client.get("/geometries", headers={"Authorization": ""})

    assert response.status_code == 401


def test_the_listing_is_documented_in_the_contract() -> None:
    operation = create_app().openapi()["paths"]["/geometries"]["get"]

    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/GeometryPage"
    }
    assert "401" in operation["responses"]
