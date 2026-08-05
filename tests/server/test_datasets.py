"""Datasets over HTTP: the one gate in, the counts, the paging, and the log.

Everything here goes through the real walk — ingest, approve, annotate, complete,
promote — because the trunk is defined by what came through that gate, and a
hand-planted membership row would prove nothing about it.

The removal assertions are the ones to keep honest. `DELETE` is a 204 whether or
not the asset was a member, and it destroys nothing: the asset, its labels and its
bytes all survive, which is why this is the one delete in the API with no gate.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

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


@pytest.fixture()
def finished(client: TestClient, tmp_path: Path, runner: InlineDispatcher) -> tuple[str, str]:
    """``(project_id, batch_id)`` for a completed batch whose assets are labeled."""
    return annotated_batch(client, runner, tmp_path)


# --- finding the dataset ------------------------------------------------------


def test_a_project_has_exactly_one_dataset_and_it_is_reachable_from_the_project(
    client: TestClient,
) -> None:
    project_id = project_with_schema(client)

    response = client.get(f"/projects/{project_id}/dataset")

    assert response.status_code == 200
    body = response.json()
    assert body["project_id"] == project_id
    assert body["name"]


def test_the_dataset_is_also_addressable_on_its_own(client: TestClient) -> None:
    project_id = project_with_schema(client)
    dataset_id = dataset_of(client, project_id)

    assert client.get(f"/datasets/{dataset_id}").json()["id"] == dataset_id


def test_an_unknown_project_has_no_dataset(client: TestClient) -> None:
    response = client.get(f"/projects/{uuid4()}/dataset")

    assert response.status_code == 404
    assert response.json()["code"] == "PROJECT_NOT_FOUND"


def test_an_unknown_dataset_is_404_with_its_own_code(client: TestClient) -> None:
    response = client.get(f"/datasets/{uuid4()}")

    assert response.status_code == 404
    assert response.json()["code"] == "DATASET_NOT_FOUND"


def test_a_malformed_dataset_id_is_422_rather_than_404(client: TestClient) -> None:
    """The convention #27 fixed: a path that is not a UUID never reached a service."""
    response = client.get("/datasets/not-a-uuid")

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


# --- the one gate in ----------------------------------------------------------


def test_a_completed_batch_promotes_its_labeled_assets(
    client: TestClient, finished: tuple[str, str]
) -> None:
    project_id, batch_id = finished

    response = client.post(f"/batches/{batch_id}/promote")

    assert response.status_code == 200
    assert response.json()["total"] == 3
    dataset_id = dataset_of(client, project_id)
    assert client.get(f"/datasets/{dataset_id}/assets").json()["total"] == 3


def test_promoting_a_batch_that_is_not_complete_is_refused(
    client: TestClient, tmp_path: Path, runner: InlineDispatcher
) -> None:
    batch_id, _ = open_job(client, runner, tmp_path)

    response = client.post(f"/batches/{batch_id}/promote")

    assert response.status_code == 409
    assert response.json()["code"] == "BATCH_NOT_COMPLETE"


def test_promoting_twice_adds_nothing_the_second_time(
    client: TestClient, finished: tuple[str, str]
) -> None:
    """Idempotent, and the empty answer is how a caller sees that nothing happened."""
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")

    again = client.post(f"/batches/{batch_id}/promote")

    assert again.status_code == 200
    assert again.json() == {"items": [], "total": 0}
    dataset_id = dataset_of(client, project_id)
    assert client.get(f"/datasets/{dataset_id}/assets").json()["total"] == 3


def test_promoting_an_unknown_batch_is_404(client: TestClient) -> None:
    response = client.post(f"/batches/{uuid4()}/promote")

    assert response.status_code == 404
    assert response.json()["code"] == "BATCH_NOT_FOUND"


def test_a_skipped_asset_stays_out_of_the_trunk(
    client: TestClient, tmp_path: Path, runner: InlineDispatcher
) -> None:
    """Skipping is a decision on the record, not a membership edit."""
    batch_id, job_id = open_job(client, runner, tmp_path)
    ids = asset_ids(client, batch_id)
    client.post(f"/jobs/{job_id}/annotations", json=[a_box(ids[0]), a_box(ids[1])])
    client.put(f"/jobs/{job_id}/assets/{ids[2]}/progress", json={"progress": "skipped"})
    client.post(f"/jobs/{job_id}/complete")
    client.post(f"/batches/{batch_id}/complete")

    promoted = client.post(f"/batches/{batch_id}/promote").json()

    assert promoted["total"] == 2
    assert ids[2] not in {asset["id"] for asset in promoted["items"]}


# --- what the trunk holds -----------------------------------------------------


def test_an_empty_trunk_answers_with_an_envelope_and_not_a_404(client: TestClient) -> None:
    dataset_id = dataset_of(client, project_with_schema(client))

    response = client.get(f"/datasets/{dataset_id}/assets")

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0}


def test_the_trunk_lists_its_assets_with_their_hashes(
    client: TestClient, finished: tuple[str, str]
) -> None:
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)

    items = client.get(f"/datasets/{dataset_id}/assets").json()["items"]

    assert len(items) == 3
    assert all(len(asset["content_hash"]) == 64 for asset in items)
    assert all(asset["thumbnail_hash"] is not None for asset in items)


def test_the_trunk_listing_pages_and_total_stays_the_whole_collection(
    client: TestClient, finished: tuple[str, str]
) -> None:
    """`total` is the size of the trunk, never of the page — a client pages until
    it has seen `total` items, not until `total` moves."""
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)

    page = client.get(f"/datasets/{dataset_id}/assets", params={"limit": 2}).json()

    assert page["total"] == 3
    assert len(page["items"]) == 2


def test_an_offset_past_the_end_of_the_trunk_is_an_empty_200(
    client: TestClient, finished: tuple[str, str]
) -> None:
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)

    response = client.get(f"/datasets/{dataset_id}/assets", params={"offset": 99})

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 3}


def test_paging_the_trunk_walks_it_without_repeating_or_dropping(
    client: TestClient, finished: tuple[str, str]
) -> None:
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)

    walked = []
    for offset in (0, 1, 2):
        page = client.get(
            f"/datasets/{dataset_id}/assets", params={"limit": 1, "offset": offset}
        ).json()
        walked += [asset["id"] for asset in page["items"]]

    everything = client.get(f"/datasets/{dataset_id}/assets").json()["items"]
    assert walked == [asset["id"] for asset in everything]


def test_a_zero_limit_is_refused_by_the_bound_rather_than_returning_nothing(
    client: TestClient, finished: tuple[str, str]
) -> None:
    project_id, _ = finished
    dataset_id = dataset_of(client, project_id)

    response = client.get(f"/datasets/{dataset_id}/assets", params={"limit": 0})

    assert response.status_code == 422


# --- the counts ---------------------------------------------------------------


def test_stats_of_an_empty_trunk_are_zeros_rather_than_a_404(client: TestClient) -> None:
    dataset_id = dataset_of(client, project_with_schema(client))

    body = client.get(f"/datasets/{dataset_id}/stats").json()

    assert body["asset_count"] == 0
    assert body["annotation_count"] == 0
    assert body["classes"] == []


def test_stats_count_assets_labels_and_classes(
    client: TestClient, finished: tuple[str, str]
) -> None:
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)

    body = client.get(f"/datasets/{dataset_id}/stats").json()

    assert body["dataset_id"] == dataset_id
    assert body["asset_count"] == 3
    assert body["annotated_asset_count"] == 3
    assert body["annotation_count"] == 3
    assert body["classes"] == [{"label_class": "sign", "annotations": 3, "assets": 3}]


def test_the_class_counts_are_a_list_of_rows_rather_than_an_open_object(
    client: TestClient, finished: tuple[str, str]
) -> None:
    """A `Record<string, number>` would tell a generated client nothing about its keys."""
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)

    classes = client.get(f"/datasets/{dataset_id}/stats").json()["classes"]

    assert isinstance(classes, list)
    assert set(classes[0]) == {"label_class", "annotations", "assets"}


def test_a_class_the_schema_declares_but_nobody_used_is_absent(
    client: TestClient, finished: tuple[str, str]
) -> None:
    """`lane` exists in the schema throughout; which classes exist is the schema's answer."""
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)

    classes = client.get(f"/datasets/{dataset_id}/stats").json()["classes"]

    assert [row["label_class"] for row in classes] == ["sign"]


def test_stats_of_an_unknown_dataset_are_404(client: TestClient) -> None:
    response = client.get(f"/datasets/{uuid4()}/stats")

    assert response.status_code == 404
    assert response.json()["code"] == "DATASET_NOT_FOUND"


# --- curating -----------------------------------------------------------------


def test_removing_an_asset_takes_it_out_of_the_trunk(
    client: TestClient, finished: tuple[str, str]
) -> None:
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)
    removed = client.get(f"/datasets/{dataset_id}/assets").json()["items"][0]["id"]

    response = client.delete(f"/datasets/{dataset_id}/assets/{removed}")

    assert response.status_code == 204
    assert response.content == b""
    remaining = client.get(f"/datasets/{dataset_id}/assets").json()
    assert remaining["total"] == 2
    assert removed not in {asset["id"] for asset in remaining["items"]}


def test_removing_an_asset_that_was_never_a_member_is_still_a_204(
    client: TestClient, finished: tuple[str, str]
) -> None:
    """The caller asked for it to be out, and it is. A 404 would make a retry look failed."""
    project_id, _ = finished
    dataset_id = dataset_of(client, project_id)

    assert client.delete(f"/datasets/{dataset_id}/assets/{uuid4()}").status_code == 204


def test_removing_from_an_unknown_dataset_is_404(client: TestClient) -> None:
    response = client.delete(f"/datasets/{uuid4()}/assets/{uuid4()}")

    assert response.status_code == 404
    assert response.json()["code"] == "DATASET_NOT_FOUND"


def test_removal_destroys_nothing_but_the_membership(
    client: TestClient, finished: tuple[str, str]
) -> None:
    """Curation, which is why there is no `confirm` gate: the bytes and labels stay."""
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)
    removed = client.get(f"/datasets/{dataset_id}/assets").json()["items"][0]["id"]

    client.delete(f"/datasets/{dataset_id}/assets/{removed}")

    still_there = client.get(f"/projects/{project_id}/assets/{removed}")
    assert still_there.status_code == 200
    assert client.get(f"/projects/{project_id}/assets/{removed}/content").status_code == 200


def test_re_promoting_puts_a_removed_asset_back(
    client: TestClient, finished: tuple[str, str]
) -> None:
    """The trunk keeps no memory of removals, so the batch is still the source of truth."""
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)
    removed = client.get(f"/datasets/{dataset_id}/assets").json()["items"][0]["id"]
    client.delete(f"/datasets/{dataset_id}/assets/{removed}")

    client.post(f"/batches/{batch_id}/promote")

    assert removed in {
        asset["id"] for asset in client.get(f"/datasets/{dataset_id}/assets").json()["items"]
    }


# --- the log ------------------------------------------------------------------


def test_a_fresh_dataset_has_an_empty_log(client: TestClient) -> None:
    dataset_id = dataset_of(client, project_with_schema(client))

    assert client.get(f"/datasets/{dataset_id}/changes").json() == {"items": [], "total": 0}


def test_promoting_writes_one_entry_naming_the_batch_and_the_assets(
    client: TestClient, finished: tuple[str, str]
) -> None:
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)

    (entry,) = client.get(f"/datasets/{dataset_id}/changes").json()["items"]

    assert entry["operation"] == "promote"
    assert entry["subject_ids"][0] == batch_id
    assert len(entry["subject_ids"]) == 4
    assert entry["occurred_at"]


def test_a_promote_that_changed_nothing_writes_no_entry(
    client: TestClient, finished: tuple[str, str]
) -> None:
    """Every line in the log is a change somebody can point at."""
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)

    assert client.get(f"/datasets/{dataset_id}/changes").json()["total"] == 1


def test_removing_an_asset_appends_its_own_entry(
    client: TestClient, finished: tuple[str, str]
) -> None:
    project_id, batch_id = finished
    client.post(f"/batches/{batch_id}/promote")
    dataset_id = dataset_of(client, project_id)
    removed = client.get(f"/datasets/{dataset_id}/assets").json()["items"][0]["id"]
    client.delete(f"/datasets/{dataset_id}/assets/{removed}")

    entries = client.get(f"/datasets/{dataset_id}/changes").json()["items"]

    assert [entry["operation"] for entry in entries] == ["promote", "remove_asset"]
    assert entries[1]["subject_ids"] == [removed]


def test_a_removal_that_changed_nothing_writes_no_entry(
    client: TestClient, finished: tuple[str, str]
) -> None:
    project_id, _ = finished
    dataset_id = dataset_of(client, project_id)

    client.delete(f"/datasets/{dataset_id}/assets/{uuid4()}")

    assert client.get(f"/datasets/{dataset_id}/changes").json()["total"] == 0


def test_the_log_of_an_unknown_dataset_is_404(client: TestClient) -> None:
    response = client.get(f"/datasets/{uuid4()}/changes")

    assert response.status_code == 404
    assert response.json()["code"] == "DATASET_NOT_FOUND"
