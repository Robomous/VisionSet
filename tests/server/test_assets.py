"""Which batches an asset has been through — the membership edge, backwards.

Every other read of membership goes from a batch to its assets: that is the
direction ``Repository``'s one ``parent_id`` filter serves, and the direction the
gallery, the partition and promotion all walk. This is the same edge asked from
the other end, which has no parent to filter on and therefore no repository
shape — hence a named port method rather than a query written inside a service.

The question it answers is a correction batch's lineage seen from the asset:
which rounds of work this frame has been through, oldest first.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.media import write_image
from tests.server._api import api_client
from tests.server._flow import annotated_batch, asset_ids, project_with_schema
from tests.server._runner import RecordingRunner


@pytest.fixture()
def runner() -> RecordingRunner:
    return RecordingRunner()


@pytest.fixture()
def client(tmp_path: Path, runner: RecordingRunner) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", runner=runner) as made:
        yield made


@pytest.fixture()
def project(client: TestClient) -> str:
    return project_with_schema(client)


# --- the membership edge, walked backwards (audit G2) -------------------------


def test_an_asset_says_which_batches_carry_it(
    client: TestClient, runner: RecordingRunner, tmp_path: Path
) -> None:
    """Every other read goes from a batch to its assets. This is the other way.

    It has no repository shape — membership is a join table with a composite key
    and the `parent_id` filter runs the other direction — which is why it needed
    a port method rather than a query written in a service.
    """
    project_id, batch_id = annotated_batch(client, runner, tmp_path)
    asset_id = asset_ids(client, batch_id)[0]

    body = client.get(f"/projects/{project_id}/assets/{asset_id}/batches").json()

    assert body["total"] == 1
    assert [one["id"] for one in body["items"]] == [batch_id]


def test_it_shows_the_original_and_its_correction_together(
    client: TestClient, runner: RecordingRunner, tmp_path: Path
) -> None:
    """What lineage looks like from the asset's side: the rounds it has been through."""
    project_id, batch_id = annotated_batch(client, runner, tmp_path)
    child = client.post(f"/batches/{batch_id}/corrections", json={"name": "round two"}).json()
    asset_id = asset_ids(client, batch_id)[0]

    body = client.get(f"/projects/{project_id}/assets/{asset_id}/batches").json()

    assert [one["id"] for one in body["items"]] == [batch_id, child["id"]]
    # And the child says which one it corrects, so a reader can order them by
    # something other than the listing's own promise.
    assert body["items"][1]["parent_batch_id"] == batch_id


def test_an_ingested_asset_always_lands_in_exactly_one_batch(
    client: TestClient, project: str, tmp_path: Path, runner: RecordingRunner
) -> None:
    """**A batch is born from an ingest**, so over HTTP there is no orphan asset.

    Worth pinning rather than assuming: the empty page this route can return is
    unreachable through the API, because `IngestService.ingest` puts what it
    gathered into a batch whether or not the caller named one. The empty answer
    is still the right one for the *service*, and `test_batch_service.py` is
    where that case can actually be built.
    """
    write_image(tmp_path / "loose.png")
    with (tmp_path / "loose.png").open("rb") as handle:
        source = client.post(
            f"/projects/{project}/sources/images",
            files=[("files", ("loose.png", handle, "image/png"))],
        ).json()
    client.post(f"/sources/{source['id']}/ingest-jobs", json={})
    # The ingest runs on a background worker, so the assets exist only once it
    # has. Nothing sleeps — the recorder keeps its futures.
    runner.wait()
    asset_id = client.get(f"/projects/{project}/assets").json()["items"][0]["id"]

    body = client.get(f"/projects/{project}/assets/{asset_id}/batches").json()

    assert body["total"] == 1


def test_an_unknown_asset_is_a_404_rather_than_an_empty_page(
    client: TestClient, project: str
) -> None:
    # The asset is resolved first, so "no such asset" and "in no batch" stay
    # different answers.
    answer = client.get(f"/projects/{project}/assets/{uuid4()}/batches")

    assert answer.status_code == 404
    assert answer.json()["code"] == "ASSET_NOT_FOUND"
