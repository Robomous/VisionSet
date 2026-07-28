"""What this deployment can export to.

Two audiences in one listing: a human choosing a format, and a client that must
know before it POSTs whether the export will need `allow_lossy`. The second is
why `lossy` is on the row rather than discovered by getting a 409.

The un-overridden test is deliberate — it is the one place in the server suite
that asserts the real entry-point group reaches a route.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client
from tests.server._exports import LossyExporter, WritingExporter, with_exporters


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws") as made:
        yield made


def test_the_shipped_format_is_listed_without_any_override(client: TestClient) -> None:
    """The real registry, reached through the real dependency, over the real group."""
    body = client.get("/formats").json()

    assert body["total"] >= 1
    assert "dummy" in {row["name"] for row in body["items"]}


def test_a_format_says_whether_it_loses_information(client: TestClient) -> None:
    with_exporters(client.app, WritingExporter(), LossyExporter())

    rows = client.get("/formats").json()["items"]

    assert {row["name"]: row["lossy"] for row in rows} == {"writing": False, "lossy": True}


def test_formats_come_back_in_name_order(client: TestClient) -> None:
    """A listing whose order depended on entry-point scan order would not be stable."""
    with_exporters(client.app, WritingExporter(), LossyExporter())

    names = [row["name"] for row in client.get("/formats").json()["items"]]

    assert names == sorted(names)


def test_the_listing_uses_the_envelope_like_every_other_collection(
    client: TestClient,
) -> None:
    with_exporters(client.app, WritingExporter())

    assert client.get("/formats").json() == {
        "items": [{"name": "writing", "lossy": False}],
        "total": 1,
    }


def test_the_listing_is_protected(client: TestClient) -> None:
    with TestClient(client.app) as anonymous:
        assert anonymous.get("/formats").status_code == 401
