"""`obb` over HTTP: written, read back canonical, refused when degenerate."""

from __future__ import annotations

from collections.abc import Iterator
from math import pi
from pathlib import Path
from typing import Any, Final

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client
from tests.server._flow import SIGN, asset_ids, open_job
from tests.server._jobs import InlineDispatcher

SHIP: Final[dict[str, Any]] = {"name": "ship", "geometries": ["obb"]}


def _ship(asset_id: str, **geometry: float) -> dict[str, Any]:
    return {
        "asset_id": asset_id,
        "label_class": "ship",
        "geometry": {"type": "obb", **geometry},
        "attributes": {},
        "provenance": "human",
    }


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture()
def working(client: TestClient, tmp_path: Path, runner: InlineDispatcher) -> tuple[str, str]:
    return open_job(client, runner, tmp_path, images=1, classes=[SIGN, SHIP])


def test_a_tall_box_is_stored_and_read_back_in_canonical_form(
    client: TestClient, working: tuple[str, str]
) -> None:
    batch_id, job_id = working
    (asset,) = asset_ids(client, batch_id)

    written = client.post(
        f"/jobs/{job_id}/annotations",
        json=[_ship(asset, cx=10.0, cy=12.0, width=4.0, height=9.0, angle=pi)],
    )

    assert written.status_code == 201, written.text
    stored = client.get(f"/jobs/{job_id}/assets/{asset}/annotations").json()["items"]
    assert [one["geometry"] for one in stored] == [
        {"type": "obb", "cx": 10.0, "cy": 12.0, "width": 9.0, "height": 4.0, "angle": -pi / 2}
    ]


def test_a_box_without_area_is_422_with_the_kernels_wording(
    client: TestClient, working: tuple[str, str]
) -> None:
    batch_id, job_id = working
    (asset,) = asset_ids(client, batch_id)

    refused = client.post(
        f"/jobs/{job_id}/annotations",
        json=[_ship(asset, cx=10.0, cy=12.0, width=0.0, height=9.0, angle=0.0)],
    )

    assert refused.status_code == 422, refused.text
    assert "greater than 0" in refused.text
    assert client.get(f"/jobs/{job_id}/assets/{asset}/annotations").json()["total"] == 0
