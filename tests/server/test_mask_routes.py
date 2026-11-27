"""`mask` over HTTP: written, read back canonical, refused when malformed or mis-sized."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any, Final

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client
from tests.server._flow import SIGN, open_job
from tests.server._jobs import InlineDispatcher

from visionset.kernel.domain import encode_counts

ROAD: Final[dict[str, Any]] = {"name": "road", "geometries": ["mask"]}


def _road(asset_id: str, size: list[int], counts: str) -> dict[str, Any]:
    return {
        "asset_id": asset_id,
        "label_class": "road",
        "geometry": {"type": "mask", "size": size, "counts": counts},
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
    return open_job(client, runner, tmp_path, images=1, classes=[SIGN, ROAD])


def _asset(client: TestClient, batch_id: str) -> tuple[str, int, int]:
    (asset,) = client.get(f"/batches/{batch_id}/assets").json()["items"]
    return asset["id"], asset["height"], asset["width"]


def test_a_mask_is_stored_and_read_back_canonical(
    client: TestClient, working: tuple[str, str]
) -> None:
    batch_id, job_id = working
    asset, height, width = _asset(client, batch_id)
    total = height * width
    # A lit first column then the rest dark, spelled with a zero-length run inside.
    spelled = encode_counts([0, height, 0, 0, total - height])

    written = client.post(
        f"/jobs/{job_id}/annotations", json=[_road(asset, [height, width], spelled)]
    )

    assert written.status_code == 201, written.text
    stored = client.get(f"/jobs/{job_id}/assets/{asset}/annotations").json()["items"]
    assert [one["geometry"] for one in stored] == [
        {
            "type": "mask",
            "size": [height, width],
            "counts": encode_counts([0, height, total - height]),
        }
    ]


def test_an_empty_mask_is_a_valid_label(client: TestClient, working: tuple[str, str]) -> None:
    batch_id, job_id = working
    asset, height, width = _asset(client, batch_id)
    empty = encode_counts([height * width])

    written = client.post(
        f"/jobs/{job_id}/annotations", json=[_road(asset, [height, width], empty)]
    )

    assert written.status_code == 201, written.text
    assert written.json()["items"][0]["geometry"]["counts"] == empty


def test_a_mask_of_another_size_is_out_of_bounds(
    client: TestClient, working: tuple[str, str]
) -> None:
    batch_id, job_id = working
    asset, height, width = _asset(client, batch_id)

    refused = client.post(
        f"/jobs/{job_id}/annotations",
        json=[_road(asset, [width, height], encode_counts([height * width]))],
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "ANNOTATION_GEOMETRY_OUT_OF_BOUNDS"
    assert client.get(f"/jobs/{job_id}/assets/{asset}/annotations").json()["total"] == 0


@pytest.mark.parametrize("counts", ["", "4 ", "Q", "N", "o" * 64])
def test_malformed_counts_are_a_validation_error(
    client: TestClient, working: tuple[str, str], counts: str
) -> None:
    batch_id, job_id = working
    asset, height, width = _asset(client, batch_id)

    refused = client.post(
        f"/jobs/{job_id}/annotations", json=[_road(asset, [height, width], counts)]
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "VALIDATION_ERROR"


def test_an_uncompressed_run_list_is_refused(client: TestClient, working: tuple[str, str]) -> None:
    batch_id, job_id = working
    asset, height, width = _asset(client, batch_id)
    body = _road(asset, [height, width], "")
    body["geometry"]["counts"] = [height * width]

    refused = client.post(f"/jobs/{job_id}/annotations", json=[body])

    assert refused.status_code == 422, refused.text


def test_the_geometry_listing_offers_mask(client: TestClient) -> None:
    names = {row["name"] for row in client.get("/geometries").json()["items"]}
    assert "mask" in names
