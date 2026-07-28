"""Batches over HTTP: the envelope, the lifecycle, the partition, and paging.

The paging assertions are the ones to keep honest. `limit` and `offset` bound
the *response*, so `total` is the size of the whole batch and never of the page —
a client paging until `total` shrank would loop forever.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.media import write_image
from tests.server._api import api_client
from tests.server._flow import batch_from_ingest, project_with_schema
from tests.server._runner import RecordingRunner


@pytest.fixture()
def runner() -> RecordingRunner:
    return RecordingRunner()


@pytest.fixture()
def client(tmp_path: Path, runner: RecordingRunner) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", runner=runner) as made:
        yield made


def png_part(tmp_path: Path, name: str, seed: int = 0) -> tuple[str, tuple[str, bytes, str]]:
    """One multipart part carrying a generated image."""
    return ("files", (name, write_image(tmp_path / name, seed=seed).read_bytes(), "image/png"))


@pytest.fixture()
def project(client: TestClient) -> str:
    return project_with_schema(client)


@pytest.fixture()
def ingested(client: TestClient, tmp_path: Path, runner: RecordingRunner, project: str) -> str:
    """A batch id, reached the way a client reaches one: by ingesting into it."""
    return batch_from_ingest(client, runner, tmp_path, project, images=3)


# --- the listing, and the envelope #28 pinned ---------------------------------


def test_a_batchs_assets_answer_with_the_envelope(client: TestClient, ingested: str) -> None:
    response = client.get(f"/batches/{ingested}/assets")

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 3
    assert len(body["items"]) == 3


def test_membership_order_is_stable(client: TestClient, ingested: str) -> None:
    """Stored order, so reading twice gives the same sequence — what paging pages."""
    first = client.get(f"/batches/{ingested}/assets").json()["items"]
    second = client.get(f"/batches/{ingested}/assets").json()["items"]

    assert [asset["id"] for asset in first] == [asset["id"] for asset in second]


def test_an_asset_carries_its_hashes_but_not_its_path(client: TestClient, ingested: str) -> None:
    """`uri` is a server-side path; reaching the bytes is #30's download by hash."""
    asset = client.get(f"/batches/{ingested}/assets").json()["items"][0]

    assert "uri" not in asset
    assert len(asset["content_hash"]) == 64
    assert len(asset["thumbnail_hash"]) == 64
    assert asset["format"] == "png"


def test_a_batch_an_ingest_could_not_fill_is_an_empty_page_not_a_404(
    client: TestClient, runner: RecordingRunner, project: str
) -> None:
    """A run whose every item was unreadable still makes a batch. It is just empty."""
    source = client.post(
        f"/projects/{project}/sources/images",
        files=[("files", ("notes.txt", b"not an image", "text/plain"))],
    ).json()["id"]
    job = client.post(f"/sources/{source}/ingest-jobs").json()
    runner.wait()
    batch_id = client.get(f"/ingest-jobs/{job['id']}").json()["batch_id"]

    response = client.get(f"/batches/{batch_id}/assets")

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0}


def test_an_unknown_batch_is_404(client: TestClient) -> None:
    response = client.get(f"/batches/{uuid4()}/assets")

    assert response.status_code == 404
    assert response.json()["code"] == "BATCH_NOT_FOUND"


def test_a_malformed_batch_id_is_422_not_404(client: TestClient) -> None:
    response = client.get("/batches/not-a-uuid/assets")

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_the_batch_route_refuses_a_request_with_no_token(client: TestClient) -> None:
    response = client.get(f"/batches/{uuid4()}/assets", headers={"Authorization": ""})

    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHORIZED"


# --- paging: it bounds the response, not the read -----------------------------


def test_a_limit_bounds_the_page_and_never_the_total(client: TestClient, ingested: str) -> None:
    body = client.get(f"/batches/{ingested}/assets", params={"limit": 2}).json()

    assert len(body["items"]) == 2
    assert body["total"] == 3


def test_limit_and_offset_walk_the_batch_in_membership_order(
    client: TestClient, ingested: str
) -> None:
    everything = [a["id"] for a in client.get(f"/batches/{ingested}/assets").json()["items"]]

    walked = []
    for offset in (0, 2):
        page = client.get(f"/batches/{ingested}/assets", params={"limit": 2, "offset": offset})
        walked.extend(a["id"] for a in page.json()["items"])

    assert walked == everything


def test_an_offset_past_the_end_is_an_empty_page_not_an_error(
    client: TestClient, ingested: str
) -> None:
    response = client.get(f"/batches/{ingested}/assets", params={"offset": 99})

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 3}


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": -1}, {"offset": -1}])
def test_a_nonsense_window_is_refused_by_the_signature(
    client: TestClient, ingested: str, params: dict[str, int]
) -> None:
    response = client.get(f"/batches/{ingested}/assets", params=params)

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


# --- detail, listing, and the counts ------------------------------------------


def test_a_draft_batch_reports_its_assets_and_no_progress(
    client: TestClient, ingested: str
) -> None:
    """A draft has no jobs, so every count is zero while asset_count is not."""
    body = client.get(f"/batches/{ingested}").json()

    assert body["state"] == "draft"
    assert body["schema_version"] is None
    assert body["asset_count"] == 3
    assert body["progress"] == {
        "unannotated": 0,
        "annotated": 0,
        "skipped": 0,
        "review_pending": 0,
        "accepted": 0,
        "total": 0,
    }


def test_an_asset_of_a_draft_batch_belongs_to_no_job_yet(client: TestClient, ingested: str) -> None:
    asset = client.get(f"/batches/{ingested}/assets").json()["items"][0]

    assert asset["job_id"] is None
    assert asset["progress"] is None


def test_approval_pins_the_version_and_gives_every_asset_a_job(
    client: TestClient, ingested: str
) -> None:
    approved = client.post(f"/batches/{ingested}/approve")

    assert approved.status_code == 200
    assert approved.json()["state"] == "approved"
    assert approved.json()["schema_version"] == 1
    assert approved.json()["progress"]["unannotated"] == 3

    assets = client.get(f"/batches/{ingested}/assets").json()["items"]
    assert all(asset["progress"] == "unannotated" for asset in assets)
    assert len({asset["job_id"] for asset in assets}) == 1


def test_the_project_listing_carries_every_batch(
    client: TestClient, project: str, ingested: str
) -> None:
    body = client.get(f"/projects/{project}/batches").json()

    assert body["total"] == 1
    assert [batch["id"] for batch in body["items"]] == [ingested]


def test_a_project_with_no_batches_is_an_empty_page(client: TestClient, project: str) -> None:
    assert client.get(f"/projects/{project}/batches").json() == {"items": [], "total": 0}


def test_listing_the_batches_of_an_unknown_project_is_404(client: TestClient) -> None:
    response = client.get(f"/projects/{uuid4()}/batches")

    assert response.status_code == 404
    assert response.json()["code"] == "PROJECT_NOT_FOUND"


# --- the partition ------------------------------------------------------------


def test_a_draft_has_no_jobs_and_that_is_a_200(client: TestClient, ingested: str) -> None:
    assert client.get(f"/batches/{ingested}/jobs").json() == {"items": [], "total": 0}


def test_by_size_cuts_the_batch_into_jobs_of_that_length(client: TestClient, ingested: str) -> None:
    client.post(f"/batches/{ingested}/approve", json={"partition": {"kind": "by_size", "size": 2}})

    jobs = client.get(f"/batches/{ingested}/jobs").json()
    assert jobs["total"] == 2
    assert [job["asset_count"] for job in jobs["items"]] == [2, 1]
    assert {job["batch_id"] for job in jobs["items"]} == {ingested}


def test_by_segments_says_exactly_which_assets_go_together(
    client: TestClient, ingested: str
) -> None:
    ids = [a["id"] for a in client.get(f"/batches/{ingested}/assets").json()["items"]]

    client.post(
        f"/batches/{ingested}/approve",
        json={"partition": {"kind": "by_segments", "segments": [[ids[0]], ids[1:]]}},
    )

    jobs = client.get(f"/batches/{ingested}/jobs").json()["items"]
    assert [job["asset_count"] for job in jobs] == [1, 2]


def test_segments_that_do_not_reproduce_the_batch_are_refused(
    client: TestClient, ingested: str
) -> None:
    ids = [a["id"] for a in client.get(f"/batches/{ingested}/assets").json()["items"]]

    response = client.post(
        f"/batches/{ingested}/approve",
        json={"partition": {"kind": "by_segments", "segments": [[ids[0]]]}},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "INVALID_PARTITION"
    assert client.get(f"/batches/{ingested}").json()["state"] == "draft"


def test_a_partition_the_domain_refuses_is_422_not_500(client: TestClient, ingested: str) -> None:
    """`BySize` carries `gt=0`, and a pydantic error from a body would be a 500."""
    response = client.post(
        f"/batches/{ingested}/approve", json={"partition": {"kind": "by_size", "size": 0}}
    )

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_a_partition_with_no_kind_cannot_pick_a_variant(client: TestClient, ingested: str) -> None:
    """The discriminator carries no default, so the contract and the parser agree."""
    response = client.post(f"/batches/{ingested}/approve", json={"partition": {"size": 2}})

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_an_unknown_partition_kind_is_refused(client: TestClient, ingested: str) -> None:
    response = client.post(f"/batches/{ingested}/approve", json={"partition": {"kind": "by_vibes"}})

    assert response.status_code == 422


# --- the lifecycle ------------------------------------------------------------


def test_the_walk_from_draft_to_completed(client: TestClient, ingested: str) -> None:
    client.post(f"/batches/{ingested}/approve")
    assert client.post(f"/batches/{ingested}/start").json()["state"] == "in_annotation"

    job = client.get(f"/batches/{ingested}/jobs").json()["items"][0]["id"]
    client.post(f"/jobs/{job}/start")
    for asset in client.get(f"/jobs/{job}/next", params={"n": 99}).json()["items"]:
        client.put(f"/jobs/{job}/assets/{asset['id']}/progress", json={"progress": "skipped"})
    client.post(f"/jobs/{job}/complete")

    completed = client.post(f"/batches/{ingested}/complete")
    assert completed.status_code == 200
    assert completed.json()["state"] == "completed"
    assert completed.json()["progress"]["skipped"] == 3


def test_approving_twice_is_refused_rather_than_re_partitioned(
    client: TestClient, ingested: str
) -> None:
    client.post(f"/batches/{ingested}/approve")

    response = client.post(f"/batches/{ingested}/approve")

    assert response.status_code == 409
    assert response.json()["code"] == "INVALID_TRANSITION"
    assert client.get(f"/batches/{ingested}/jobs").json()["total"] == 1


def test_a_batch_cannot_be_started_before_it_is_approved(client: TestClient, ingested: str) -> None:
    response = client.post(f"/batches/{ingested}/start")

    assert response.status_code == 409
    assert response.json()["code"] == "INVALID_TRANSITION"


def test_a_batch_with_an_unfinished_job_will_not_complete(
    client: TestClient, ingested: str
) -> None:
    client.post(f"/batches/{ingested}/approve")
    client.post(f"/batches/{ingested}/start")

    response = client.post(f"/batches/{ingested}/complete")

    assert response.status_code == 409
    assert response.json()["code"] == "BATCH_NOT_COMPLETE"


def test_an_empty_batch_cannot_be_approved(
    client: TestClient, runner: RecordingRunner, project: str
) -> None:
    """It would have no jobs, so it could never complete."""
    source = client.post(
        f"/projects/{project}/sources/images",
        files=[("files", ("notes.txt", b"not an image", "text/plain"))],
    ).json()["id"]
    job = client.post(f"/sources/{source}/ingest-jobs").json()
    runner.wait()
    batch_id = client.get(f"/ingest-jobs/{job['id']}").json()["batch_id"]

    response = client.post(f"/batches/{batch_id}/approve")

    assert response.status_code == 409
    assert response.json()["code"] == "EMPTY_BATCH"


def test_a_project_with_no_schema_has_nothing_to_pin(
    client: TestClient, tmp_path: Path, runner: RecordingRunner
) -> None:
    project = client.post("/projects", json={"name": "schemaless"}).json()["id"]
    batch_id = batch_from_ingest(client, runner, tmp_path, project, images=1)

    response = client.post(f"/batches/{batch_id}/approve")

    assert response.status_code == 404
    assert response.json()["code"] == "SCHEMA_NOT_FOUND"


@pytest.mark.parametrize("action", ["approve", "start", "complete"])
def test_a_lifecycle_move_on_an_unknown_batch_is_404(client: TestClient, action: str) -> None:
    response = client.post(f"/batches/{uuid4()}/{action}")

    assert response.status_code == 404
    assert response.json()["code"] == "BATCH_NOT_FOUND"


# --- targeting an existing batch from an ingest, the debt #28 deferred --------


def test_a_second_ingest_can_be_pointed_at_the_first_ones_batch(
    client: TestClient, tmp_path: Path, runner: RecordingRunner, project: str, ingested: str
) -> None:
    second = tmp_path / "second"
    second.mkdir()
    source = client.post(
        f"/projects/{project}/sources/images",
        files=[
            (
                "files",
                ("late.png", write_image(second / "late.png", seed=99).read_bytes(), "image/png"),
            )
        ],
    ).json()["id"]

    launched = client.post(f"/sources/{source}/ingest-jobs", json={"batch_id": ingested})
    assert launched.status_code == 202
    runner.wait()

    assert client.get(f"/batches/{ingested}").json()["asset_count"] == 4


def test_ingesting_into_an_unknown_batch_is_refused_before_any_job_row(
    client: TestClient, tmp_path: Path, project: str
) -> None:
    source = client.post(
        f"/projects/{project}/sources/images", files=[png_part(tmp_path, "a.png")]
    ).json()["id"]

    response = client.post(f"/sources/{source}/ingest-jobs", json={"batch_id": str(uuid4())})

    assert response.status_code == 404
    assert response.json()["code"] == "BATCH_NOT_FOUND"
    assert client.get(f"/sources/{source}/ingest-jobs").json() == {"items": [], "total": 0}


def test_ingesting_into_an_approved_batch_is_refused_before_any_job_row(
    client: TestClient, tmp_path: Path, project: str, ingested: str
) -> None:
    client.post(f"/batches/{ingested}/approve")
    source = client.post(
        f"/projects/{project}/sources/images", files=[png_part(tmp_path, "b.png", seed=7)]
    ).json()["id"]

    response = client.post(f"/sources/{source}/ingest-jobs", json={"batch_id": ingested})

    assert response.status_code == 409
    assert response.json()["code"] == "BATCH_NOT_EDITABLE"
    assert client.get(f"/sources/{source}/ingest-jobs").json() == {"items": [], "total": 0}
