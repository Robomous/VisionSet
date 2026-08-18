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
from tests.server._flow import (
    LANE,
    SIGN,
    a_box,
    annotated_batch,
    asset_ids,
    batch_from_ingest,
    dataset_of,
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


def png_part(tmp_path: Path, name: str, seed: int = 0) -> tuple[str, tuple[str, bytes, str]]:
    """One multipart part carrying a generated image."""
    return ("files", (name, write_image(tmp_path / name, seed=seed).read_bytes(), "image/png"))


@pytest.fixture()
def project(client: TestClient) -> str:
    return project_with_schema(client)


@pytest.fixture()
def ingested(client: TestClient, tmp_path: Path, runner: InlineDispatcher, project: str) -> str:
    """A batch id, reached the way a client reaches one: by ingesting into it."""
    return batch_from_ingest(client, runner, tmp_path, project, images=3)


# --- the listing, and the collection envelope ---------------------------------


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
    """`uri` is a server-side path; reaching the bytes is the download by hash."""
    asset = client.get(f"/batches/{ingested}/assets").json()["items"][0]

    assert "uri" not in asset
    assert len(asset["content_hash"]) == 64
    assert len(asset["thumbnail_hash"]) == 64
    assert asset["format"] == "png"


def test_a_batch_an_ingest_could_not_fill_is_an_empty_page_not_a_404(
    client: TestClient, runner: InlineDispatcher, project: str
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
        "pre_labeled": 0,
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
    client: TestClient, runner: InlineDispatcher, project: str
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
    client: TestClient, tmp_path: Path, runner: InlineDispatcher
) -> None:
    project = client.post("/projects", json={"name": "schemaless"}).json()["id"]
    batch_id = batch_from_ingest(client, runner, tmp_path, project, images=1)

    response = client.post(f"/batches/{batch_id}/approve")

    assert response.status_code == 404
    assert response.json()["code"] == "SCHEMA_NOT_FOUND"


@pytest.mark.parametrize("action", ["approve", "start", "complete", "repin"])
def test_a_lifecycle_move_on_an_unknown_batch_is_404(client: TestClient, action: str) -> None:
    response = client.post(f"/batches/{uuid4()}/{action}")

    assert response.status_code == 404
    assert response.json()["code"] == "BATCH_NOT_FOUND"


# --- targeting an existing batch from an ingest --------------------------------


def test_a_second_ingest_can_be_pointed_at_the_first_ones_batch(
    client: TestClient, tmp_path: Path, runner: InlineDispatcher, project: str, ingested: str
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


# --- re-pinning the schema version --------------------------------------------


def new_version(client: TestClient, project: str, *classes: object, **query: object) -> object:
    return client.post(
        f"/projects/{project}/schema/versions", json={"classes": list(classes)}, params=query
    )


def approved(client: TestClient, batch_id: str) -> None:
    client.post(f"/batches/{batch_id}/approve")


def test_a_class_added_after_approval_reaches_the_batch_with_no_second_call(
    client: TestClient, project: str, ingested: str
) -> None:
    """#381 over the wire: the publish moves the pin and the response says so.

    This used to need a `POST /repin` afterwards, and a client that did not know
    to make it was left holding a class its own batch would refuse.
    """
    approved(client, ingested)

    response = new_version(
        client, project, SIGN, LANE, {"name": "crossing", "geometries": ["bbox"]}
    )

    assert response.status_code == 201
    body = response.json()
    assert body["published"]["version"] == 2
    assert body["advanced_batches"] == [ingested]
    assert client.get(f"/batches/{ingested}").json()["schema_version"] == 2


def test_a_narrowing_version_leaves_the_pin_and_repin_is_still_the_way_across(
    client: TestClient, project: str, ingested: str
) -> None:
    """The route keeps the escape the automatic advance deliberately does not take."""
    approved(client, ingested)

    published = new_version(client, project, SIGN, allow_destructive=True)

    assert published.status_code == 201
    assert published.json()["advanced_batches"] == []
    assert client.get(f"/batches/{ingested}").json()["schema_version"] == 1

    moved = client.post(f"/batches/{ingested}/repin", params={"allow_destructive": True})

    assert moved.status_code == 200
    assert moved.json()["schema_version"] == 2


def test_repinning_onto_the_pinned_version_is_a_no_op(
    client: TestClient, project: str, ingested: str
) -> None:
    approved(client, ingested)
    before = client.get(f"/batches/{ingested}").json()

    response = client.post(f"/batches/{ingested}/repin")

    assert response.status_code == 200
    assert response.json() == before


def test_a_narrowing_repin_is_409_and_the_flag_is_the_retry(
    client: TestClient, project: str, ingested: str
) -> None:
    """The same request plus one query parameter — the convention `docs/api.md` sets."""
    approved(client, ingested)
    new_version(client, project, SIGN, allow_destructive=True)

    refused = client.post(f"/batches/{ingested}/repin")

    assert refused.status_code == 409
    assert refused.json()["code"] == "DESTRUCTIVE_SCHEMA_CHANGE"
    assert client.get(f"/batches/{ingested}").json()["schema_version"] == 1

    retried = client.post(f"/batches/{ingested}/repin", params={"allow_destructive": True})

    assert retried.status_code == 200
    assert retried.json()["schema_version"] == 2


def test_a_repin_that_would_orphan_this_batchs_labels_has_no_flag(
    client: TestClient, tmp_path: Path, runner: InlineDispatcher
) -> None:
    """Two 409s, and only one of them is retryable — branch on `code`, not status."""
    project = project_with_schema(client)
    batch_id = batch_from_ingest(client, runner, tmp_path, project, images=2)
    client.post(f"/batches/{batch_id}/approve")
    client.post(f"/batches/{batch_id}/start")
    job_id = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]
    client.post(f"/jobs/{job_id}/start")
    # Version 2 drops `lane`; it is creatable because nothing is labeled `lane`
    # yet. The label arrives afterwards, judged against this batch's own pin of 1.
    new_version(client, project, SIGN, allow_destructive=True)
    written = client.post(
        f"/jobs/{job_id}/annotations",
        json=[
            {
                "asset_id": asset_ids(client, batch_id)[0],
                "label_class": "lane",
                "geometry": {"type": "polygon", "points": [[0, 0], [4, 0], [4, 4]]},
                "provenance": "human",
            }
        ],
    )
    assert written.status_code == 201

    response = client.post(f"/batches/{batch_id}/repin", params={"allow_destructive": True})

    assert response.status_code == 409
    assert response.json()["code"] == "SCHEMA_CHANGE_WOULD_ORPHAN"
    assert client.get(f"/batches/{batch_id}").json()["schema_version"] == 1


def test_a_draft_has_no_pin_to_move(client: TestClient, project: str, ingested: str) -> None:
    response = client.post(f"/batches/{ingested}/repin")

    assert response.status_code == 409
    assert response.json()["code"] == "INVALID_TRANSITION"


def test_a_completed_batchs_pin_is_history(
    client: TestClient, tmp_path: Path, runner: InlineDispatcher
) -> None:
    project, batch_id = annotated_batch(client, runner, tmp_path, images=2)
    new_version(client, project, SIGN, LANE, {"name": "crossing", "geometries": ["bbox"]})

    response = client.post(f"/batches/{batch_id}/repin")

    assert response.status_code == 409
    assert response.json()["code"] == "INVALID_TRANSITION"


# --- promotion, made observable (audit F5/F17) --------------------------------
#
# Promotion is not a transition: the batch stays `completed` and nothing else on
# its read model moved when its assets entered the trunk. So a client could not
# tell "promoted 3 of 48" from "promoted nothing because it was already done"
# from "the press did nothing", and a working call read as a broken button.


def test_a_batch_nobody_promoted_reports_nothing_in_the_dataset(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    _, batch_id = annotated_batch(client, runner, tmp_path)

    body = client.get(f"/batches/{batch_id}").json()

    assert body["promoted_asset_count"] == 0
    assert body["asset_count"] == 3


def test_promoting_moves_the_count_on_the_batch_itself(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    # The half that survives a reload. The response says what *this press* did and
    # cannot be recovered afterwards; this says what is in the trunk *now*, and is
    # still right in a session that did not do the promoting.
    _, batch_id = annotated_batch(client, runner, tmp_path)
    client.post(f"/batches/{batch_id}/promote")

    body = client.get(f"/batches/{batch_id}").json()

    assert body["promoted_asset_count"] == 3
    # And the batch has not moved, which is exactly why it needed a number.
    assert body["state"] == "completed"


def test_the_count_leaves_out_a_frame_that_was_skipped(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    # `PROMOTABLE_PROGRESS` excludes `skipped`, so a count below `asset_count` is
    # the ordinary shape rather than a shortfall — and it is the shape the founder
    # actually had, at 3 of 48.
    project_id = project_with_schema(client)
    batch_id = batch_from_ingest(client, runner, tmp_path, project_id, images=3)
    client.post(f"/batches/{batch_id}/approve")
    client.post(f"/batches/{batch_id}/start")
    job_id = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]
    client.post(f"/jobs/{job_id}/start")
    assets = asset_ids(client, batch_id)
    client.post(f"/jobs/{job_id}/annotations", json=[a_box(assets[0]), a_box(assets[1])])
    client.put(f"/jobs/{job_id}/assets/{assets[2]}/progress", json={"progress": "skipped"})
    client.post(f"/jobs/{job_id}/complete")
    client.post(f"/batches/{batch_id}/complete")
    client.post(f"/batches/{batch_id}/promote")

    body = client.get(f"/batches/{batch_id}").json()

    assert body["asset_count"] == 3
    assert body["promoted_asset_count"] == 2


def test_promoting_twice_leaves_the_count_where_it_was(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    # The idempotent no-op, which is the outcome that looked most like a failure.
    # The second press answers an empty page — and the count says the work is
    # there anyway, which is what turns "nothing happened" into "already done".
    _, batch_id = annotated_batch(client, runner, tmp_path)
    client.post(f"/batches/{batch_id}/promote")

    again = client.post(f"/batches/{batch_id}/promote").json()

    assert again["total"] == 0
    assert client.get(f"/batches/{batch_id}").json()["promoted_asset_count"] == 3


def test_the_listing_reports_it_too(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    # One read of the trunk covers every batch in the page — the reason `promoted`
    # is passed into `BatchOut.of` rather than read inside it.
    project_id, batch_id = annotated_batch(client, runner, tmp_path)
    client.post(f"/batches/{batch_id}/promote")

    items = client.get(f"/projects/{project_id}/batches").json()["items"]

    assert [one["promoted_asset_count"] for one in items] == [3]


def test_removing_an_asset_from_the_trunk_takes_it_off_the_count(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    # Current membership, never a promotion log.
    project_id, batch_id = annotated_batch(client, runner, tmp_path)
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)
    removed = asset_ids(client, batch_id)[0]
    client.delete(f"/datasets/{dataset_id}/assets/{removed}")

    assert client.get(f"/batches/{batch_id}").json()["promoted_asset_count"] == 2


# --- creating a batch from a chosen asset set (audit G1) ----------------------


def test_a_batch_can_be_created_from_a_chosen_asset_set(
    client: TestClient, ingested: str, project: str
) -> None:
    """A batch curated by hand, which nothing else offers.

    A batch is still born from an ingest in the ordinary case. What had no route
    at all was cutting one out of an arbitrary subset — which is the shape a
    correction batch is.
    """
    chosen = asset_ids(client, ingested)[:2]

    answer = client.post(
        f"/projects/{project}/batches", json={"name": "hand-cut", "asset_ids": chosen}
    )

    assert answer.status_code == 201
    body = answer.json()
    assert body["name"] == "hand-cut"
    assert body["state"] == "draft"
    assert body["asset_count"] == 2
    assert body["parent_batch_id"] is None
    # A draft, so its membership is still editable — which is what `draft` means.
    assert "edit_membership" in body["allowed_actions"]


def test_a_batch_may_start_empty(client: TestClient, project: str) -> None:
    # An intermediate state rather than an error: `EmptyBatch` is what refuses
    # *approving* one, which is a different moment.
    answer = client.post(f"/projects/{project}/batches", json={"name": "empty"})

    assert answer.status_code == 201
    assert answer.json()["asset_count"] == 0


def test_an_asset_outside_the_project_is_refused(client: TestClient, project: str) -> None:
    answer = client.post(
        f"/projects/{project}/batches", json={"name": "wrong", "asset_ids": [str(uuid4())]}
    )

    assert answer.status_code == 404
    assert answer.json()["code"] == "ASSET_NOT_FOUND"


def test_a_blank_name_is_refused_in_the_kernels_own_words(client: TestClient, project: str) -> None:
    answer = client.post(f"/projects/{project}/batches", json={"name": "   "})

    assert answer.status_code == 422
    assert answer.json()["code"] == "INVALID_NAME"


# --- corrections (audit G7) ---------------------------------------------------


def test_a_completed_batch_declares_it_can_be_corrected(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    _, batch_id = annotated_batch(client, runner, tmp_path)

    assert "create_correction" in client.get(f"/batches/{batch_id}").json()["allowed_actions"]


def test_correcting_a_completed_batch_cuts_a_draft_that_points_back_at_it(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    """The forward-only answer: a new batch, not a reopened one."""
    _, batch_id = annotated_batch(client, runner, tmp_path)

    answer = client.post(f"/batches/{batch_id}/corrections", json={"name": "round two"})

    assert answer.status_code == 201
    child = answer.json()
    assert child["id"] != batch_id
    assert child["parent_batch_id"] == batch_id
    assert child["state"] == "draft"
    # The parent's whole membership by default: "correct this batch" is the
    # ordinary ask, and re-listing every id to say so is a worse API.
    assert child["asset_count"] == 3
    # And the parent has not moved. That is the whole point.
    assert client.get(f"/batches/{batch_id}").json()["state"] == "completed"


def test_a_correction_may_name_a_subset(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    # The other ordinary ask: the three frames somebody found wrong.
    _, batch_id = annotated_batch(client, runner, tmp_path)
    one = asset_ids(client, batch_id)[:1]

    answer = client.post(
        f"/batches/{batch_id}/corrections", json={"name": "one frame", "asset_ids": one}
    )

    assert answer.status_code == 201
    assert answer.json()["asset_count"] == 1


def test_a_correction_cannot_admit_an_asset_the_parent_never_carried(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path
) -> None:
    """Lineage would otherwise be a claim about nothing."""
    _, batch_id = annotated_batch(client, runner, tmp_path)

    answer = client.post(
        f"/batches/{batch_id}/corrections", json={"name": "wrong", "asset_ids": [str(uuid4())]}
    )

    assert answer.status_code == 422
    assert answer.json()["code"] == "ASSET_NOT_IN_BATCH"


@pytest.mark.parametrize("stop_at", ["draft", "approved", "in_annotation"])
def test_an_open_batch_refuses_to_be_corrected(
    client: TestClient, runner: InlineDispatcher, tmp_path: Path, stop_at: str
) -> None:
    """Correcting an open batch is not a correction — it is the work.

    The declaration and the refusal agree, which is what the capability contract
    is for: `create_correction` is absent from every one of these states.
    """
    project_id = project_with_schema(client)
    batch_id = batch_from_ingest(client, runner, tmp_path, project_id, images=2)
    if stop_at != "draft":
        client.post(f"/batches/{batch_id}/approve")
    if stop_at == "in_annotation":
        client.post(f"/batches/{batch_id}/start")

    answer = client.post(f"/batches/{batch_id}/corrections", json={"name": "too soon"})

    assert answer.status_code == 409
    assert answer.json()["code"] == "INVALID_TRANSITION"
    assert "create_correction" not in client.get(f"/batches/{batch_id}").json()["allowed_actions"]


# --- membership editing -------------------------------------------------------


def _walk_to(client: TestClient, batch_id: str, state: str) -> None:
    """Take a batch to `state` through the routes a client would actually call.

    The progress write is a **PUT** rather than a POST, because batch deletion needed the
    `completed` leg to be real: the route is `@router.put`, so the POST answered
    405, nothing settled, `complete` refused, and every `completed` case in this
    module was quietly running against an `in_annotation` batch. It went
    unnoticed because the two assertions that used it — membership editing — are
    refused in both states, so the wrong state produced the right answer.
    """
    if state == "draft":
        return
    client.post(f"/batches/{batch_id}/approve")
    if state == "approved":
        return
    client.post(f"/batches/{batch_id}/start")
    if state == "in_annotation":
        return
    job_id = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]
    client.post(f"/jobs/{job_id}/start")
    for asset_id in asset_ids(client, batch_id):
        client.put(f"/jobs/{job_id}/assets/{asset_id}/progress", json={"progress": "skipped"})
    client.post(f"/jobs/{job_id}/complete")
    client.post(f"/batches/{batch_id}/complete")


@pytest.fixture()
def spare(client: TestClient, tmp_path: Path, runner: InlineDispatcher, project: str) -> str:
    """An asset of the same project that no batch under test holds."""
    source = client.post(
        f"/projects/{project}/sources/images", files=[png_part(tmp_path, "spare.png", seed=99)]
    ).json()["id"]
    job = client.post(f"/sources/{source}/ingest-jobs").json()
    runner.wait()
    other = client.get(f"/ingest-jobs/{job['id']}").json()["batch_id"]
    return asset_ids(client, other)[0]


def test_adding_an_asset_to_a_draft_reports_what_it_wrote(
    client: TestClient, ingested: str, spare: str
) -> None:
    answer = client.post(f"/batches/{ingested}/assets", json={"asset_ids": [spare]})

    assert answer.status_code == 200
    body = answer.json()
    assert body["changed"] == [spare]
    assert body["batch"]["asset_count"] == 4
    assert spare in asset_ids(client, ingested)


def test_removing_assets_from_a_draft_reports_what_it_removed(
    client: TestClient, ingested: str
) -> None:
    held = asset_ids(client, ingested)

    answer = client.request("DELETE", f"/batches/{ingested}/assets", params={"id": held[:2]})

    assert answer.status_code == 200
    body = answer.json()
    assert body["changed"] == held[:2]
    assert body["batch"]["asset_count"] == 1
    assert asset_ids(client, ingested) == held[2:]


def test_removing_membership_leaves_the_asset_in_its_project(
    client: TestClient, ingested: str, project: str
) -> None:
    """The naming question, settled by the behaviour: this is membership, not deletion."""
    gone = asset_ids(client, ingested)[0]

    client.request("DELETE", f"/batches/{ingested}/assets", params={"id": [gone]})

    listed = client.get(f"/projects/{project}/assets").json()["items"]
    assert gone in [asset["id"] for asset in listed]


def test_adding_an_asset_the_batch_already_holds_changes_nothing(
    client: TestClient, ingested: str
) -> None:
    """Idempotent, and it says so: a no-op is `changed: []`, not a refusal."""
    held = asset_ids(client, ingested)

    answer = client.post(f"/batches/{ingested}/assets", json={"asset_ids": [held[0]]})

    assert answer.status_code == 200
    assert answer.json()["changed"] == []
    assert answer.json()["batch"]["asset_count"] == 3


def test_removing_an_asset_the_batch_does_not_hold_changes_nothing(
    client: TestClient, ingested: str, spare: str
) -> None:
    answer = client.request("DELETE", f"/batches/{ingested}/assets", params={"id": [spare]})

    assert answer.status_code == 200
    assert answer.json()["changed"] == []
    assert answer.json()["batch"]["asset_count"] == 3


def test_an_asset_outside_the_project_cannot_join_the_batch(
    client: TestClient, ingested: str
) -> None:
    answer = client.post(f"/batches/{ingested}/assets", json={"asset_ids": [str(uuid4())]})

    assert answer.status_code == 404
    assert answer.json()["code"] == "ASSET_NOT_FOUND"
    # Refused whole: nothing was written before the stranger was found.
    assert len(asset_ids(client, ingested)) == 3


def test_editing_the_membership_of_an_unknown_batch_is_a_404(client: TestClient) -> None:
    missing = uuid4()
    assert (
        client.post(f"/batches/{missing}/assets", json={"asset_ids": [str(uuid4())]}).json()["code"]
        == "BATCH_NOT_FOUND"
    )
    assert (
        client.request(
            "DELETE", f"/batches/{missing}/assets", params={"id": [str(uuid4())]}
        ).json()["code"]
        == "BATCH_NOT_FOUND"
    )


def test_an_edit_naming_no_asset_is_refused_by_both_halves(
    client: TestClient, ingested: str
) -> None:
    """A membership edit about nothing would be a silent 200 that did nothing."""
    assert client.post(f"/batches/{ingested}/assets", json={"asset_ids": []}).status_code == 422
    assert client.request("DELETE", f"/batches/{ingested}/assets").status_code == 422


@pytest.mark.parametrize("state", ["draft", "approved", "in_annotation", "completed"])
def test_membership_routes_agree_with_what_the_batch_declares(
    client: TestClient, ingested: str, spare: str, state: str
) -> None:
    """The contract, closed at the wire rather than only at the service.

    `tests/kernel/test_capabilities.py` proves `edit_membership` declared ⇔
    `BatchService.add_assets` succeeds, over the whole state square. It drives
    services, so it cannot see whether a *route* exists in front of one — which
    is exactly the gap to avoid: a capability declared on every draft, with
    nothing on the wire to call.

    So this closes the other half, in the only way that is honest without a new
    framework: for every batch state, read what the batch declares and assert
    both routes agree with it. It is not derived from the declaration the way the
    kernel matrix is — a route cannot be enumerated from a `BatchAction` — but it
    does fail if either side moves alone.
    """
    _walk_to(client, ingested, state)
    declared = "edit_membership" in client.get(f"/batches/{ingested}").json()["allowed_actions"]
    assert declared is (state == "draft")

    added = client.post(f"/batches/{ingested}/assets", json={"asset_ids": [spare]})
    removed = client.request("DELETE", f"/batches/{ingested}/assets", params={"id": [spare]})

    if declared:
        assert added.status_code == 200
        assert removed.status_code == 200
    else:
        assert added.status_code == 409
        assert added.json()["code"] == "BATCH_NOT_EDITABLE"
        assert removed.status_code == 409
        assert removed.json()["code"] == "BATCH_NOT_EDITABLE"
        # The refusal names the remedy the kernel offers instead.
        assert "skipped" in added.json()["message"]


# --- delete -------------------------------------------------------------------


@pytest.mark.parametrize("state", ["draft", "approved", "in_annotation"])
def test_a_batch_that_has_not_finished_deletes_and_stops_answering(
    client: TestClient, ingested: str, state: str
) -> None:
    """`DELETABLE_STATES` over the wire: everything short of completed goes."""
    _walk_to(client, ingested, state)

    assert client.delete(f"/batches/{ingested}", params={"confirm": True}).status_code == 204
    assert client.get(f"/batches/{ingested}").status_code == 404


def test_a_completed_batch_is_refused_and_the_flag_does_not_lift_it(
    client: TestClient, ingested: str
) -> None:
    """The one state with no exit, and `confirm` is not a way round it.

    Both spellings are asserted because the state check runs *before* the
    confirmation one, deliberately: a refusal that named `confirm=true` as the
    remedy would be naming a flag that does not work.
    """
    _walk_to(client, ingested, "completed")

    for query in ({}, {"confirm": True}):
        refused = client.delete(f"/batches/{ingested}", params=query)
        assert refused.status_code == 409
        assert refused.json()["code"] == "BATCH_IMMUTABLE"

    assert client.get(f"/batches/{ingested}").json()["state"] == "completed"


def test_deleting_without_confirming_changes_nothing(client: TestClient, ingested: str) -> None:
    """The gate is a query parameter, so the retry is the identical request plus one."""
    refused = client.delete(f"/batches/{ingested}")

    assert refused.status_code == 409
    assert refused.json()["code"] == "CONFIRMATION_REQUIRED"
    assert client.get(f"/batches/{ingested}").status_code == 200


def test_deleting_a_batch_nobody_has_is_a_404(client: TestClient) -> None:
    missing = uuid4()

    assert client.delete(f"/batches/{missing}", params={"confirm": True}).status_code == 404


@pytest.mark.parametrize("state", ["draft", "approved", "in_annotation", "completed"])
def test_the_delete_route_agrees_with_what_the_batch_declares(
    client: TestClient, ingested: str, state: str
) -> None:
    """The contract closed at the wire, on `edit_membership`'s precedent.

    `tests/kernel/test_capabilities.py` proves `delete` declared ⇔
    `BatchService.delete` succeeds, over the whole state square, by driving the
    service. It cannot see whether a *route* stands in front of one — which is
    the orphan a withdrawn member avoids, in the opposite direction.
    """
    _walk_to(client, ingested, state)
    declared = "delete" in client.get(f"/batches/{ingested}").json()["allowed_actions"]
    assert declared is (state != "completed")

    removed = client.delete(f"/batches/{ingested}", params={"confirm": True})

    if declared:
        assert removed.status_code == 204
    else:
        assert removed.status_code == 409
        assert removed.json()["code"] == "BATCH_IMMUTABLE"


def test_deleting_a_batch_takes_nothing_out_of_the_trunk(
    client: TestClient, tmp_path: Path, runner: InlineDispatcher
) -> None:
    """The invariant, stated directly rather than argued from two other facts.

    Promotion happens only from `completed`, and `completed` cannot be deleted —
    so a delete can never reach assets that a promotion put in the dataset. The
    sharp case is the one asserted here: a *second* batch over assets already in
    the trunk, deleted while it is open, leaves the trunk exactly as it was. That
    is the shape a correction batch has, and it is the one where "deleting the
    unit of work never deletes the work" is doing real load-bearing.
    """
    project_id, promoted_batch = annotated_batch(client, runner, tmp_path)
    client.post(f"/batches/{promoted_batch}/promote")
    dataset_id = dataset_of(client, project_id)
    trunk = client.get(f"/datasets/{dataset_id}/assets").json()["total"]
    assert trunk == 3

    same_assets = asset_ids(client, promoted_batch)
    second: str = client.post(
        f"/projects/{project_id}/batches",
        json={"name": "over the same frames", "asset_ids": same_assets},
    ).json()["id"]
    client.post(f"/batches/{second}/approve")
    client.post(f"/batches/{second}/start")

    assert client.delete(f"/batches/{second}", params={"confirm": True}).status_code == 204

    assert client.get(f"/datasets/{dataset_id}/assets").json()["total"] == trunk
    # And the labels the first batch produced are still on the assets themselves.
    job_id = client.get(f"/batches/{promoted_batch}/jobs").json()["items"][0]["id"]
    kept = client.get(f"/jobs/{job_id}/assets/{same_assets[0]}/annotations")
    assert kept.json()["total"] == 1
