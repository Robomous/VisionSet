"""Public HTTP routes reject requests with no bearer credential."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws") as made:
        yield made


def test_the_whole_walk_is_refused_without_a_token(client: TestClient) -> None:
    """The contract is bearer-authenticated end to end, not only at the edges."""
    for method, path in (
        ("get", "/projects/00000000-0000-0000-0000-000000000000/batches"),
        ("get", "/batches/00000000-0000-0000-0000-000000000000"),
        ("post", "/batches/00000000-0000-0000-0000-000000000000/approve"),
        ("get", "/jobs/00000000-0000-0000-0000-000000000000"),
        ("get", "/jobs/00000000-0000-0000-0000-000000000000/next"),
        ("post", "/jobs/00000000-0000-0000-0000-000000000000/annotations"),
        ("get", "/datasets/00000000-0000-0000-0000-000000000000/stats"),
        ("post", "/datasets/00000000-0000-0000-0000-000000000000/releases"),
        ("get", "/releases/00000000-0000-0000-0000-000000000000/manifest"),
        ("post", "/releases/00000000-0000-0000-0000-000000000000/export"),
        ("get", "/formats"),
        (
            "get",
            "/projects/00000000-0000-0000-0000-000000000000/assets/"
            "00000000-0000-0000-0000-000000000000/content",
        ),
    ):
        response = client.request(method, path, headers={"Authorization": ""})
        assert response.status_code == 401, path
        assert response.json()["code"] == "UNAUTHORIZED"
