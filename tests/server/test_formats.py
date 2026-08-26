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
from tests.server._exports import (
    LossyExporter,
    WritingExporter,
    reset_exporters,
    with_exporters,
)

from visionset.kernel.domain import GeometryType


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws") as made:
        yield made
    reset_exporters()


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
        "items": [
            {
                "name": "writing",
                "lossy": False,
                # The capability declaration, sorted because a set has no
                # order and a wire shape must.
                "geometries": sorted(one.value for one in GeometryType),
                # The second declaration, published beside the first because
                # `geometries` alone reads as the whole answer — and for `yolo` it
                # left out that a polygon is written at all.
                "degraded_geometries": [],
                "modalities": ["image"],
                # A format that is its own target: `GET /export-targets`
                # carries the row in full.
                "targets": ["writing"],
            }
        ],
        "total": 1,
    }


def test_the_listing_is_protected(client: TestClient) -> None:
    with TestClient(client.app) as anonymous:
        assert anonymous.get("/formats").status_code == 401


# --- the target catalog --------------------------------------------------------


def test_the_catalog_flattens_every_target_with_the_format_that_writes_for_it(
    client: TestClient,
) -> None:
    with_exporters(client.app, WritingExporter(), LossyExporter())

    body = client.get("/export-targets").json()

    assert [row["name"] for row in body["items"]] == ["lossy", "writing"]
    assert body["total"] == 2
    lossy, writing = body["items"]
    assert lossy == {
        "name": "lossy",
        "label": "lossy",
        "family": "other",
        "format": "lossy",
        "tasks": [],
        "geometries": sorted(one.value for one in GeometryType),
        "hints": {
            "recommended_size": None,
            "recommended_strategy": None,
            "trainer_resizes": True,
            "augmentation_common": False,
        },
    }
    assert writing["format"] == "writing"


def test_the_shipped_catalog_names_every_yolo_target_and_the_dialect_each_resolves_to(
    client: TestClient,
) -> None:
    """No override: the real entry-point scan, so the catalog is the one a deployment serves."""
    rows = {row["name"]: row for row in client.get("/export-targets").json()["items"]}

    assert rows["yolo11"]["format"] == "ultralytics"
    assert rows["yolo11"]["family"] == "ultralytics-yolo"
    assert rows["yolo11"]["tasks"] == ["classify", "detect", "obb", "pose", "segment"]
    assert rows["yolo11"]["geometries"] == ["bbox", "classification_tag", "polygon"]
    assert rows["yolo11"]["hints"] == {
        "recommended_size": [640, 640],
        "recommended_strategy": "letterbox",
        "trainer_resizes": True,
        "augmentation_common": True,
    }
    assert rows["yolov7"]["format"] == "yolov5-yaml"
    # Every installed format is reachable through the catalog.
    formats = {row["name"] for row in client.get("/formats").json()["items"]}
    assert {row["format"] for row in rows.values()} == formats


def test_the_catalog_is_protected(client: TestClient) -> None:
    with TestClient(client.app) as anonymous:
        assert anonymous.get("/export-targets").status_code == 401
