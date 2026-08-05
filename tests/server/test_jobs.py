"""Jobs over HTTP: handing out work, recording decisions, closing the segment.

The one to read twice is `test_asking_for_no_assets_is_422_not_500`. The kernel
refuses a non-positive count with a bare `ValueError`, which is outside the
`VisionSetError` tree — so without `ge=1` in the signature it would answer 500 to
a request that is plainly the client's own mistake.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client
from tests.server._flow import batch_from_ingest, open_job, project_with_schema
from tests.server._jobs import InlineDispatcher


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture()
def working(client: TestClient, tmp_path: Path, runner: InlineDispatcher) -> tuple[str, str]:
    """A started job over a three-asset batch. Returns ``(batch_id, job_id)``."""
    return open_job(client, runner, tmp_path, images=3)


def waiting(client: TestClient, job_id: str, n: int = 99) -> list[str]:
    return [a["id"] for a in client.get(f"/jobs/{job_id}/next", params={"n": n}).json()["items"]]


# --- detail -------------------------------------------------------------------


def test_a_job_id_alone_leads_back_to_its_batch(
    client: TestClient, working: tuple[str, str]
) -> None:
    """An AnnotationJob records only its task group, so this is the useful field."""
    batch_id, job_id = working

    body = client.get(f"/jobs/{job_id}").json()

    assert body["batch_id"] == batch_id
    assert body["state"] == "in_progress"
    assert body["asset_count"] == 3


def test_a_job_does_not_publish_its_task_group(
    client: TestClient, working: tuple[str, str]
) -> None:
    """No route reaches one, so the id would be contract surface with no use."""
    _, job_id = working

    assert "task_group_id" not in client.get(f"/jobs/{job_id}").json()


def test_an_unknown_job_is_404(client: TestClient) -> None:
    response = client.get(f"/jobs/{uuid4()}")

    assert response.status_code == 404
    assert response.json()["code"] == "JOB_NOT_FOUND"


def test_a_job_route_refuses_a_request_with_no_token(client: TestClient) -> None:
    response = client.get(f"/jobs/{uuid4()}", headers={"Authorization": ""})

    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHORIZED"


# --- progress -----------------------------------------------------------------


def test_progress_carries_every_state_even_the_empty_ones(
    client: TestClient, working: tuple[str, str]
) -> None:
    _, job_id = working

    assert client.get(f"/jobs/{job_id}/progress").json() == {
        "unannotated": 3,
        "annotated": 0,
        "skipped": 0,
        "review_pending": 0,
        "accepted": 0,
        "total": 3,
    }


def test_marking_an_asset_moves_the_tally(client: TestClient, working: tuple[str, str]) -> None:
    _, job_id = working
    first = waiting(client, job_id)[0]

    response = client.put(f"/jobs/{job_id}/assets/{first}/progress", json={"progress": "skipped"})

    assert response.status_code == 200
    assert response.json() == {"asset_id": first, "progress": "skipped"}
    assert client.get(f"/jobs/{job_id}/progress").json()["skipped"] == 1


def test_marking_the_state_it_already_holds_is_a_no_op(
    client: TestClient, working: tuple[str, str]
) -> None:
    _, job_id = working
    first = waiting(client, job_id)[0]
    client.put(f"/jobs/{job_id}/assets/{first}/progress", json={"progress": "skipped"})

    again = client.put(f"/jobs/{job_id}/assets/{first}/progress", json={"progress": "skipped"})

    assert again.status_code == 200
    assert client.get(f"/jobs/{job_id}/progress").json()["skipped"] == 1


def test_a_move_the_table_forbids_is_409(client: TestClient, working: tuple[str, str]) -> None:
    """`unannotated` has two exits, and `accepted` is not one of them."""
    _, job_id = working
    first = waiting(client, job_id)[0]

    response = client.put(f"/jobs/{job_id}/assets/{first}/progress", json={"progress": "accepted"})

    assert response.status_code == 409
    assert response.json()["code"] == "INVALID_TRANSITION"


def test_an_unknown_state_never_reaches_the_kernel(
    client: TestClient, working: tuple[str, str]
) -> None:
    _, job_id = working
    first = waiting(client, job_id)[0]

    response = client.put(f"/jobs/{job_id}/assets/{first}/progress", json={"progress": "vibing"})

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_an_asset_in_a_path_the_job_does_not_carry_is_404(
    client: TestClient, working: tuple[str, str]
) -> None:
    """A path segment names a resource; the same id in a *body* is a 422."""
    _, job_id = working

    response = client.put(f"/jobs/{job_id}/assets/{uuid4()}/progress", json={"progress": "skipped"})

    assert response.status_code == 404
    assert response.json()["code"] == "ASSET_NOT_IN_JOB"


# --- next?n= ------------------------------------------------------------------


def test_next_hands_out_the_batchs_own_order_and_is_stable(
    client: TestClient, working: tuple[str, str]
) -> None:
    batch_id, job_id = working
    membership = [a["id"] for a in client.get(f"/batches/{batch_id}/assets").json()["items"]]

    assert waiting(client, job_id) == membership
    assert waiting(client, job_id) == membership


def test_next_honours_n_and_never_invents_assets(
    client: TestClient, working: tuple[str, str]
) -> None:
    _, job_id = working

    assert len(waiting(client, job_id, n=2)) == 2
    assert len(waiting(client, job_id, n=99)) == 3


def test_next_defaults_to_one(client: TestClient, working: tuple[str, str]) -> None:
    _, job_id = working

    body = client.get(f"/jobs/{job_id}/next").json()

    assert body["total"] == 1
    assert len(body["items"]) == 1


def test_a_marked_asset_stops_being_offered(client: TestClient, working: tuple[str, str]) -> None:
    """Only `unannotated` is waiting to be labeled — a skip is a decision, not work."""
    _, job_id = working
    first = waiting(client, job_id)[0]

    client.put(f"/jobs/{job_id}/assets/{first}/progress", json={"progress": "skipped"})

    assert first not in waiting(client, job_id)


def test_next_is_empty_once_the_job_is_done(client: TestClient, working: tuple[str, str]) -> None:
    _, job_id = working
    for asset_id in waiting(client, job_id):
        client.put(f"/jobs/{job_id}/assets/{asset_id}/progress", json={"progress": "skipped"})

    assert client.get(f"/jobs/{job_id}/next", params={"n": 99}).json() == {
        "items": [],
        "total": 0,
    }


@pytest.mark.parametrize("n", [0, -1])
def test_asking_for_no_assets_is_422_not_500(
    client: TestClient, working: tuple[str, str], n: int
) -> None:
    """`JobService.next_pending` raises a bare `ValueError`, which reaches the
    catch-all handler. `ge=1` in the signature is what keeps that unreachable."""
    _, job_id = working

    response = client.get(f"/jobs/{job_id}/next", params={"n": n})

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


# --- the job's own lifecycle --------------------------------------------------


def test_a_job_cannot_start_before_its_batch_is_open(
    client: TestClient, tmp_path: Path, runner: InlineDispatcher
) -> None:
    project = project_with_schema(client)
    batch_id = batch_from_ingest(client, runner, tmp_path, project, images=2)
    client.post(f"/batches/{batch_id}/approve")
    job_id = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]

    response = client.post(f"/jobs/{job_id}/start")

    assert response.status_code == 409
    assert response.json()["code"] == "BATCH_NOT_IN_ANNOTATION"


def test_starting_twice_is_refused(client: TestClient, working: tuple[str, str]) -> None:
    _, job_id = working

    response = client.post(f"/jobs/{job_id}/start")

    assert response.status_code == 409
    assert response.json()["code"] == "INVALID_TRANSITION"


def test_a_job_will_not_complete_while_an_asset_is_unsettled(
    client: TestClient, working: tuple[str, str]
) -> None:
    _, job_id = working
    client.put(
        f"/jobs/{job_id}/assets/{waiting(client, job_id)[0]}/progress",
        json={"progress": "skipped"},
    )

    response = client.post(f"/jobs/{job_id}/complete")

    assert response.status_code == 409
    assert response.json()["code"] == "JOB_NOT_COMPLETE"


def test_a_job_completes_once_every_asset_is_settled(
    client: TestClient, working: tuple[str, str]
) -> None:
    batch_id, job_id = working
    for asset_id in waiting(client, job_id):
        client.put(f"/jobs/{job_id}/assets/{asset_id}/progress", json={"progress": "skipped"})

    response = client.post(f"/jobs/{job_id}/complete")

    assert response.status_code == 200
    assert response.json() == {
        "id": job_id,
        "batch_id": batch_id,
        "state": "completed",
        "asset_count": 3,
        # `JOB_TRANSITIONS[completed]` is empty, so a finished job declares nothing.
        "allowed_actions": [],
    }


def test_completing_a_job_does_not_complete_its_batch(
    client: TestClient, working: tuple[str, str]
) -> None:
    """One machine in two places is one too many; the batch derives its own."""
    batch_id, job_id = working
    for asset_id in waiting(client, job_id):
        client.put(f"/jobs/{job_id}/assets/{asset_id}/progress", json={"progress": "skipped"})
    client.post(f"/jobs/{job_id}/complete")

    assert client.get(f"/batches/{batch_id}").json()["state"] == "in_annotation"


@pytest.mark.parametrize("action", ["start", "complete"])
def test_a_lifecycle_move_on_an_unknown_job_is_404(client: TestClient, action: str) -> None:
    response = client.post(f"/jobs/{uuid4()}/{action}")

    assert response.status_code == 404
    assert response.json()["code"] == "JOB_NOT_FOUND"
