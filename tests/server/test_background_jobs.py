"""The generic polling surface: reading a job, listing, cancelling, downloading.

The routes here are the twin of `/ingest-jobs`, and the module they are tested
beside is `test_ingest.py`. What is specific to this one is the artifact route,
which is the only way bytes leave a job — and the only route in the server that
rejoins a path read out of a JSON column, so most of its tests are about that.

**The prefix is `/background-jobs` and not `/jobs`.** `routes/jobs.py` has served
annotation jobs at `/jobs` and that is a shipped contract; two
different things wanted the same word and the newer one gave way.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client, api_workspace, served_app
from tests.server._jobs import InlineDispatcher, ManualDispatcher

from visionset.kernel.domain import BackgroundJobOutcome, BackgroundJobSpec, BackgroundJobState
from visionset.kernel.services import WorkspaceService

TYPE = "export.release"


@pytest.fixture()
def dispatcher() -> ManualDispatcher:
    """Runs nothing, so a queued job stays observable."""
    return ManualDispatcher()


@pytest.fixture()
def client(tmp_path: Path, dispatcher: ManualDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=dispatcher) as made:
        yield made


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    """A second handle on the same workspace, for arranging rows a route cannot.

    Nothing on the wire creates a background job — see `routes/background_jobs.py`
    for why there is deliberately no launch route — so a test about *reading* one
    reaches the queue directly. Two handles over one file is also what the server
    and a worker are, which is the arrangement WAL exists for.
    """
    made = WorkspaceService.open(tmp_path / "ws")
    yield made
    made.close()


def enqueue(workspace: WorkspaceService, **payload: object) -> str:
    job = workspace.job_queue.enqueue(
        BackgroundJobSpec(type=TYPE, payload=dict(payload))  # type: ignore[arg-type]
    )
    return str(job.id)


# --- reading -----------------------------------------------------------------


def test_a_queued_job_is_readable_with_the_shape_a_progress_bar_wants(
    client: TestClient, workspace: WorkspaceService
) -> None:
    job_id = enqueue(workspace, release_id="abc")

    body = client.get(f"/background-jobs/{job_id}").json()

    assert body["id"] == job_id
    assert body["type"] == TYPE
    assert body["state"] == "queued"
    assert (body["processed"], body["total"], body["failures"]) == (0, None, [])
    assert (body["error"], body["result"]) == (None, {})
    assert body["created_at"] is not None
    assert body["started_at"] is None


def test_a_job_failed_by_a_declared_error_carries_its_code(tmp_path: Path) -> None:
    """The same refusal, the same code, whether answered to a request or settled on a job."""
    dispatcher = InlineDispatcher()
    with api_client(tmp_path / "ws", dispatcher=dispatcher) as client:
        workspace = WorkspaceService.open(tmp_path / "ws")
        try:
            job_id = enqueue(workspace, release_id=str(uuid4()), format="coco", allow_lossy=False)
        finally:
            workspace.close()
        dispatcher.run()

        body = client.get(f"/background-jobs/{job_id}").json()

    assert body["state"] == "failed"
    assert body["error_code"] == "RELEASE_NOT_FOUND"
    assert body["error"]


def test_a_job_failed_by_anything_else_has_no_code(
    client: TestClient, workspace: WorkspaceService
) -> None:
    job_id = enqueue(workspace)
    workspace.job_queue.claim("w")
    workspace.job_queue.finish(
        UUID(job_id), BackgroundJobOutcome(state=BackgroundJobState.FAILED, error="the disk filled")
    )

    body = client.get(f"/background-jobs/{job_id}").json()

    assert (body["state"], body["error"], body["error_code"]) == (
        "failed",
        "the disk filled",
        None,
    )


def test_the_payload_is_not_on_the_wire(client: TestClient, workspace: WorkspaceService) -> None:
    """It is an internal contract between a surface and a handler, and it can name a path.

    The rule that keeps `Source.path` and `Asset.uri` unpublished, applied to the
    one field that would otherwise carry either.
    """
    job_id = enqueue(workspace, release_id="abc")

    assert "payload" not in client.get(f"/background-jobs/{job_id}").json()


def test_an_unknown_job_is_404_naming_it(client: TestClient) -> None:
    missing = uuid4()

    response = client.get(f"/background-jobs/{missing}")

    assert response.status_code == 404
    assert response.json()["code"] == "BACKGROUND_JOB_NOT_FOUND"
    assert str(missing) in response.json()["message"]


def test_a_malformed_id_is_422_rather_than_404(client: TestClient) -> None:
    """`docs/content/api.md`'s rule for every id on this surface."""
    assert client.get("/background-jobs/not-a-uuid").status_code == 422


# --- listing -----------------------------------------------------------------


def test_listing_answers_the_envelope_newest_first(
    client: TestClient, workspace: WorkspaceService
) -> None:
    first = enqueue(workspace, n=1)
    second = enqueue(workspace, n=2)

    body = client.get("/background-jobs").json()

    assert body["total"] == 2
    assert [item["id"] for item in body["items"]] == [second, first]


def test_listing_narrows_to_the_states_asked_for(
    client: TestClient, workspace: WorkspaceService
) -> None:
    enqueue(workspace, n=1)  # claimed below, because `claim` takes the oldest
    still_queued = enqueue(workspace, n=2)
    workspace.job_queue.claim("a")

    body = client.get("/background-jobs", params={"state": "queued"}).json()

    assert [item["id"] for item in body["items"]] == [still_queued]


def test_an_empty_listing_is_200_with_an_empty_envelope(client: TestClient) -> None:
    """Never a 404 — `docs/content/api.md`'s rule for every collection."""
    assert client.get("/background-jobs").json() == {"items": [], "total": 0}


# --- cancelling ---------------------------------------------------------------


def test_cancelling_a_queued_job_settles_it_and_says_so(
    client: TestClient, workspace: WorkspaceService
) -> None:
    job_id = enqueue(workspace)

    body = client.post(f"/background-jobs/{job_id}/cancel").json()

    assert body["state"] == "cancelled"
    assert body["cancel_requested"] is True


def test_cancelling_a_running_job_only_flags_it(
    client: TestClient, workspace: WorkspaceService
) -> None:
    """The answer is how a caller tells which of the two things happened."""
    job_id = enqueue(workspace)
    workspace.job_queue.claim("a")

    body = client.post(f"/background-jobs/{job_id}/cancel").json()

    assert body["state"] == "running"
    assert body["cancel_requested"] is True


def test_cancelling_an_unknown_job_is_404(client: TestClient) -> None:
    assert client.post(f"/background-jobs/{uuid4()}/cancel").status_code == 404


# --- the artifact --------------------------------------------------------------


def settled_with_archive(workspace: WorkspaceService, relative: str) -> str:
    """A succeeded job whose result names a file, written where it says."""
    job_id = enqueue(workspace)
    workspace.job_queue.claim("a")
    workspace.job_queue.finish(
        UUID(job_id),
        BackgroundJobOutcome(state=BackgroundJobState.SUCCEEDED, result={"archive": relative}),
    )
    return job_id


def test_a_finished_job_hands_over_the_file_it_named(
    client: TestClient, workspace: WorkspaceService
) -> None:
    target = workspace.root / "exports" / "out.zip"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"PK\x05\x06" + b"\0" * 18)
    job_id = settled_with_archive(workspace, "exports/out.zip")

    response = client.get(f"/background-jobs/{job_id}/artifact")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert response.content.startswith(b"PK")


def test_asking_for_an_artifact_before_the_job_succeeded_is_409(
    client: TestClient, workspace: WorkspaceService
) -> None:
    """ "Not yet" and "never" are different answers, and only one is worth retrying."""
    job_id = enqueue(workspace)

    response = client.get(f"/background-jobs/{job_id}/artifact")

    assert response.status_code == 409
    assert "queued" in response.json()["message"]


def test_a_job_that_produced_nothing_downloadable_is_404(
    client: TestClient, workspace: WorkspaceService
) -> None:
    job_id = enqueue(workspace)
    workspace.job_queue.claim("a")
    workspace.job_queue.finish(
        UUID(job_id),
        BackgroundJobOutcome(state=BackgroundJobState.SUCCEEDED),
    )

    assert client.get(f"/background-jobs/{job_id}/artifact").status_code == 404


def test_an_artifact_that_is_gone_is_404_rather_than_a_500(
    client: TestClient, workspace: WorkspaceService
) -> None:
    """A workspace is a directory somebody can tidy."""
    job_id = settled_with_archive(workspace, "exports/vanished.zip")

    assert client.get(f"/background-jobs/{job_id}/artifact").status_code == 404


def test_a_stored_path_cannot_escape_the_workspace(
    client: TestClient, workspace: WorkspaceService, tmp_path: Path
) -> None:
    """The containment check, and the reason it is not decoration.

    The value has been through a JSON column: a route that trusted it to stay
    inside the directory it was written for is one bad row away from serving
    whatever the path names. This arranges exactly that row and expects a 404,
    never the file.
    """
    outside = tmp_path / "secret.zip"
    outside.write_bytes(b"not yours")
    job_id = settled_with_archive(workspace, "../secret.zip")

    response = client.get(f"/background-jobs/{job_id}/artifact")

    assert response.status_code == 404
    assert b"not yours" not in response.content


# --- the surface is protected ---------------------------------------------------


def test_every_route_here_needs_a_token(tmp_path: Path) -> None:
    secret = api_workspace(tmp_path / "guarded")
    with TestClient(served_app(tmp_path / "guarded")) as client:
        assert secret  # minted, and deliberately not sent below
        for method, path in (
            ("get", "/background-jobs"),
            ("get", f"/background-jobs/{uuid4()}"),
            ("post", f"/background-jobs/{uuid4()}/cancel"),
            ("get", f"/background-jobs/{uuid4()}/artifact"),
        ):
            response = client.request(method, path)
            assert response.status_code == 401, path
            assert response.json()["code"] == "UNAUTHORIZED"


# --- the launch that does exist -------------------------------------------------


def test_an_export_launch_is_the_only_thing_that_creates_one(
    tmp_path: Path,
) -> None:
    """There is no `POST /background-jobs`, deliberately.

    What work *means* belongs to the resource it is about. A generic launch route
    taking a type and a payload would be a remote-code surface with a token in
    front of it, and every payload shape would become public the day it shipped.
    """
    inline = InlineDispatcher()
    with api_client(tmp_path / "ws2", dispatcher=inline) as client:
        assert client.post("/background-jobs", json={"type": TYPE}).status_code == 405
