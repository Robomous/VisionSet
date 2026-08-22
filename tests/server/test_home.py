"""The workspace's front page, composed into one response.

The derivation itself belongs to `tests/kernel/test_summary_service.py`; what is
asserted here is the wire — that one request answers the whole page, that the
shape is the one `openapi.json` describes, and that the projection declares no
capabilities of its own.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client
from tests.server._flow import (
    a_box,
    annotated_batch,
    asset_ids,
    dataset_of,
    open_job,
    project_with_schema,
)
from tests.server._jobs import InlineDispatcher


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


def test_an_untouched_workspace_answers_the_first_run_shape(client: TestClient) -> None:
    """Zeros, nulls and empty lists — not a 404, and not a flag of its own."""
    response = client.get("/home")

    assert response.status_code == 200
    body = response.json()
    assert body["totals"] == {"projects": 0, "assets": 0, "annotations": 0, "releases": 0}
    assert body["resume"] is None
    assert body["attention"] == []
    assert body["projects"] == []
    assert body["activity"] == []


def test_the_page_needs_a_credential(tmp_path: Path) -> None:
    """It reads every project in the workspace, so it is behind the same gate."""
    with api_client(tmp_path / "ws") as authenticated:
        unauthenticated = TestClient(authenticated.app)

        assert unauthenticated.get("/home").status_code == 401


def test_one_request_answers_the_whole_page(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    """The composition is the route's whole reason to exist."""
    batch_id, job_id = open_job(client, runner, tmp_path, images=3)
    assets = asset_ids(client, batch_id)
    client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0])])

    body = client.get("/home").json()

    assert body["totals"]["projects"] == 1
    assert body["totals"]["assets"] == 3
    assert body["totals"]["annotations"] == 1
    assert body["resume"]["batch_id"] == batch_id
    assert body["resume"]["job_id"] == job_id
    assert body["resume"]["next_asset_id"] == assets[1]
    assert body["resume"]["annotated"] == 1
    assert body["resume"]["total"] == 3
    assert len(body["projects"]) == 1
    assert body["projects"][0]["asset_count"] == 3
    assert [entry["kind"] for entry in body["activity"]]


def test_a_finished_batch_answers_a_resume_with_no_frame_to_open(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    """`next_asset_id` null is what flips a client from the editor to the gallery."""
    project_id, batch_id = annotated_batch(client, runner, tmp_path, images=2)
    assert project_id

    body = client.get("/home").json()

    # The batch reached `completed`, so nothing is open for annotation at all.
    assert body["resume"] is None


def test_a_partly_labeled_batch_reports_where_to_land(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    batch_id, job_id = open_job(client, runner, tmp_path, images=4)
    assets = asset_ids(client, batch_id)
    client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0]), a_box(assets[1])])

    resume = client.get("/home").json()["resume"]

    assert resume["next_asset_id"] == assets[2]
    assert resume["thumbnail_asset_id"] == assets[2]
    # Ingest cached a preview for every frame, and the card's picture carries
    # its hash — a client with the id alone cannot tell "fetch and see" from
    # "known absent" (the placeholder Home shipped with).
    asset = client.get(f"/projects/{resume['project_id']}/assets/{assets[2]}").json()
    assert resume["thumbnail_hash"] == asset["thumbnail_hash"] is not None
    assert resume["batch_name"]
    assert resume["project_name"]


def test_a_frame_sent_back_for_review_shows_up_as_attention(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    batch_id, job_id = open_job(client, runner, tmp_path, images=3)
    assets = asset_ids(client, batch_id)
    client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0])])
    # Asserted, because a setup call that silently did nothing is how a test
    # comes to agree with its fixture instead of with the code: this was a POST
    # in its first draft, which answered 405 and left the assertion below
    # measuring a frame nobody had sent back.
    sent = client.put(
        f"/jobs/{job_id}/assets/{assets[0]}/progress", json={"progress": "review_pending"}
    )
    assert sent.status_code == 200

    rows = [
        row for row in client.get("/home").json()["attention"] if row["kind"] == "review_pending"
    ]

    assert len(rows) == 1
    assert rows[0]["subject_id"] == batch_id
    assert rows[0]["count"] == 1
    assert rows[0]["project_id"] is not None


def test_a_published_release_is_counted_and_reported(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    project_id, batch_id = annotated_batch(client, runner, tmp_path, images=2)
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)
    client.post(f"/datasets/{dataset_id}/releases", json={"tag": "v1"})

    body = client.get("/home").json()

    assert body["totals"]["releases"] == 1
    kinds = {entry["kind"] for entry in body["activity"]}
    assert "release_published" in kinds
    assert "batch_promoted" in kinds


def test_the_projection_declares_no_actions_of_its_own(client: TestClient) -> None:
    """Every row points at a resource whose own shape declares its capabilities.

    A second copy here would be the hand-mirrored table the capabilities contract
    forbids, one layer up — so the absence is asserted rather than assumed.
    """
    project_with_schema(client)

    body = client.get("/home").json()

    assert "allowed_actions" not in body
    for group in ("attention", "projects", "activity"):
        for row in body[group]:
            assert "allowed_actions" not in row


def test_the_page_is_read_only(client: TestClient) -> None:
    """No verb but GET, so a summary cannot be mistaken for a resource."""
    assert client.post("/home", json={}).status_code == 405
    assert client.delete("/home").status_code == 405
