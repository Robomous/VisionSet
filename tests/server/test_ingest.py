"""Launching a run and polling it — the contract every long operation reuses.

The acceptance walk of #28 is one test here: upload a clip, register it at 5 fps,
launch, wait, read the assets. It is deliberately the shape a real client has —
nothing reaches past the API for an answer the API is supposed to give.

**Nothing in this module sleeps.** Waiting is `RecordingRunner.wait()`, which
joins the worker's future, and sequencing is `GatedRunner`'s events — the
discipline `tests/kernel/test_concurrency.py` set. A test that polls with sleeps
is slow when it passes and flaky when it does not.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.media import write_image, write_video
from tests.server._api import api_client
from tests.server._runner import JOIN_TIMEOUT, GatedRunner, RecordingRunner

from visionset.kernel.services import WorkspaceService

# Above `testsrc`'s resolution floor — see `test_sources.py`.
CLIP_SIZE = (160, 120)

#: 2 seconds at 10 fps cut at 5 fps. The generator's defaults make this exact,
#: which is what lets the walk assert a count rather than a range.
EXTRACTION_FPS = 5
EXPECTED_FRAMES = 10


@pytest.fixture()
def runner() -> RecordingRunner:
    return RecordingRunner()


@pytest.fixture()
def client(tmp_path: Path, runner: RecordingRunner) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", runner=runner) as made:
        yield made


@pytest.fixture()
def project(client: TestClient) -> str:
    response = client.post("/projects", json={"name": "road-signs"})
    assert response.status_code == 201, response.text
    project_id: str = response.json()["id"]
    return project_id


def registered_clip(client: TestClient, project: str, tmp_path: Path) -> str:
    clip = write_video(tmp_path / "made" / "drive.mp4", size=CLIP_SIZE).path
    response = client.post(
        f"/projects/{project}/sources/video",
        files={"file": (clip.name, clip.read_bytes(), "video/mp4")},
        data={"extraction_fps": EXTRACTION_FPS},
    )
    assert response.status_code == 201, response.text
    source_id: str = response.json()["id"]
    return source_id


def png_part(
    tmp_path: Path, name: str = "a.png", seed: int = 0
) -> tuple[str, tuple[str, bytes, str]]:
    """One multipart part carrying a generated image."""
    return ("files", (name, write_image(tmp_path / name, seed=seed).read_bytes(), "image/png"))


def registered_images(client: TestClient, project: str, *parts: Any) -> str:
    response = client.post(f"/projects/{project}/sources/images", files=list(parts))
    assert response.status_code == 201, response.text
    source_id: str = response.json()["id"]
    return source_id


def launch(client: TestClient, source: str, **body: Any) -> Any:
    return client.post(f"/sources/{source}/ingest-jobs", json=body or None)


# --- the acceptance walk -----------------------------------------------------


def test_a_clip_uploaded_and_ingested_at_five_fps_lists_its_assets(
    client: TestClient, project: str, tmp_path: Path, runner: RecordingRunner
) -> None:
    source = registered_clip(client, project, tmp_path)

    started = launch(client, source)
    assert started.status_code == 202, started.text
    job = started.json()
    assert job["state"] == "pending"
    assert started.headers["Location"] == f"/ingest-jobs/{job['id']}"

    runner.wait()

    polled = client.get(f"/ingest-jobs/{job['id']}").json()
    assert polled["state"] == "completed"
    assert polled["processed"] == EXPECTED_FRAMES
    # NULL for a clip: `VideoMetadata` carries no frame count by design.
    assert polled["total"] is None
    assert polled["failures"] == []
    assert polled["batch_id"] is not None

    assets = client.get(f"/batches/{polled['batch_id']}/assets")
    assert assets.status_code == 200
    body = assets.json()
    assert body["total"] == EXPECTED_FRAMES
    assert [asset["frame_index"] for asset in body["items"]] == list(range(EXPECTED_FRAMES))
    assert all(asset["source_id"] == source for asset in body["items"])


# --- launching ---------------------------------------------------------------


def test_a_launch_answers_before_the_worker_has_picked_the_job_up(
    tmp_path: Path, project: str
) -> None:
    """The whole promise of the 202: the row is pollable while the work has not begun."""
    gated = GatedRunner()
    with api_client(tmp_path / "gated", runner=gated) as client:
        made = client.post("/projects", json={"name": "gated"}).json()["id"]
        source = registered_images(client, made, png_part(tmp_path))

        job = launch(client, source).json()
        assert gated.entered.wait(timeout=JOIN_TIMEOUT)

        parked = client.get(f"/ingest-jobs/{job['id']}")
        assert parked.status_code == 200
        assert parked.json()["state"] == "pending"

        gated.release.set()
        gated.wait()

        assert client.get(f"/ingest-jobs/{job['id']}").json()["state"] == "completed"


def test_a_launch_names_the_batch_it_was_asked_to(
    client: TestClient, project: str, tmp_path: Path, runner: RecordingRunner
) -> None:
    source = registered_images(client, project, png_part(tmp_path))

    job = launch(client, source, batch_name="monday").json()
    runner.wait()

    assert client.get(f"/ingest-jobs/{job['id']}").json()["batch_name"] == "monday"


def test_a_blank_batch_name_is_the_domains_own_422_not_a_500(
    client: TestClient, project: str, tmp_path: Path, runner: RecordingRunner
) -> None:
    """`InvalidName` is a mapped domain error, so no wire-model validator restates it.

    The contrast with `LabelClassBody` is the point: *that* one needs a parsing-time
    validator because the domain refuses with a pydantic `ValidationError`, which
    reaches the catch-all handler as a 500. This one refuses with a `VisionSetError`
    that `ERROR_RULES` already places, and it arrives before the job row is written.
    """
    source = registered_images(client, project, png_part(tmp_path))

    response = launch(client, source, batch_name="   ")

    assert response.status_code == 422
    assert response.json()["code"] == "INVALID_NAME"
    assert runner.futures == []


def test_launching_over_an_unknown_source_is_404_and_starts_nothing(
    client: TestClient, runner: RecordingRunner
) -> None:
    """Refused on the calling thread, so a 202 never points at a job row nobody wrote."""
    response = launch(client, str(uuid4()))

    assert response.status_code == 404
    assert response.json()["code"] == "SOURCE_NOT_FOUND"
    assert runner.futures == []


# --- what a run reports ------------------------------------------------------


def test_an_unreadable_item_is_reported_and_does_not_fail_the_run(
    client: TestClient, project: str, tmp_path: Path, runner: RecordingRunner
) -> None:
    """Failure splits by remedy: operator noise is a line in the report, not a dead run."""
    source = registered_images(
        client,
        project,
        png_part(tmp_path, seed=1),
        ("files", ("notes.txt", b"not an image", "text/plain")),
    )

    job = launch(client, source).json()
    runner.wait()

    polled = client.get(f"/ingest-jobs/{job['id']}").json()
    assert polled["state"] == "completed"
    assert polled["processed"] == 2
    assert polled["total"] == 2
    assert [(Path(f["name"]).name, f["kind"]) for f in polled["failures"]] == [
        ("notes.txt", "unsupported")
    ]
    # A different field from `failures`, and empty here: one broken machine is
    # not five thousand broken files, and neither is one unreadable file a run.
    assert polled["error"] is None

    assets = client.get(f"/batches/{polled['batch_id']}/assets").json()
    assert assets["total"] == 1


def test_listing_the_runs_of_a_source(
    client: TestClient, project: str, tmp_path: Path, runner: RecordingRunner
) -> None:
    source = registered_images(client, project, png_part(tmp_path))
    first = launch(client, source).json()
    runner.wait()
    second = launch(client, source).json()
    runner.wait()

    body = client.get(f"/sources/{source}/ingest-jobs").json()

    assert body["total"] == 2
    assert {job["id"] for job in body["items"]} == {first["id"], second["id"]}


def test_re_ingesting_a_source_creates_nothing(
    client: TestClient, project: str, tmp_path: Path, runner: RecordingRunner
) -> None:
    """Content is addressed by hash, so a second run reports the same items as already held."""
    source = registered_images(client, project, png_part(tmp_path))
    first = launch(client, source).json()
    runner.wait()
    second = launch(client, source).json()
    runner.wait()

    first_batch = client.get(f"/ingest-jobs/{first['id']}").json()["batch_id"]
    second_batch = client.get(f"/ingest-jobs/{second['id']}").json()["batch_id"]

    assert first_batch != second_batch
    left = client.get(f"/batches/{first_batch}/assets").json()["items"]
    right = client.get(f"/batches/{second_batch}/assets").json()["items"]
    assert [a["id"] for a in left] == [a["id"] for a in right]


# --- polling and resuming ----------------------------------------------------


def test_reading_an_unknown_job_is_404(client: TestClient) -> None:
    response = client.get(f"/ingest-jobs/{uuid4()}")

    assert response.status_code == 404
    assert response.json()["code"] == "INGEST_JOB_NOT_FOUND"


def test_resuming_a_completed_run_is_409_rather_than_a_silent_no_op(
    client: TestClient, project: str, tmp_path: Path, runner: RecordingRunner
) -> None:
    """Refused on the calling thread: a 202 here would leave a client unable to tell
    a redo from a job that did nothing."""
    source = registered_images(client, project, png_part(tmp_path))
    job = launch(client, source).json()
    runner.wait()
    before = len(runner.futures)

    response = client.post(f"/ingest-jobs/{job['id']}/resume")

    assert response.status_code == 409
    assert response.json()["code"] == "INVALID_TRANSITION"
    assert len(runner.futures) == before


def test_resuming_an_unknown_job_is_404(client: TestClient) -> None:
    response = client.post(f"/ingest-jobs/{uuid4()}/resume")

    assert response.status_code == 404
    assert response.json()["code"] == "INGEST_JOB_NOT_FOUND"


def test_a_resume_that_is_allowed_answers_202_and_says_where_to_poll(
    tmp_path: Path, project: str
) -> None:
    """The accepting half of this route, which only its two refusals had reached.

    `test_resuming_a_completed_run_is_409` and its 404 sibling both leave inside
    `resumable`, so everything after it — the submission, the `Location` header
    and the body — was never run by anything. That is the whole of what a 202
    promises, and the header is the half a client cannot work around: without it
    there is no documented address to poll, and the id in the body is a
    convention rather than a contract.

    A **pending** job is the resumable state that needs no damage to arrange: the
    row is born pending and `INGEST_TRANSITIONS` lets it reach `running`, which is
    exactly what `resume`'s own docstring calls "what a queued run would leave
    behind". The gate is what holds it there long enough to be observed, the same
    instrument `test_a_launch_answers_before_the_worker_has_picked_the_job_up`
    uses — nothing here sleeps.
    """
    gated = GatedRunner()
    with api_client(tmp_path / "resumable", runner=gated) as client:
        made = client.post("/projects", json={"name": "resumable"}).json()["id"]
        source = registered_images(client, made, png_part(tmp_path))

        job = launch(client, source).json()
        assert gated.entered.wait(timeout=JOIN_TIMEOUT)
        assert client.get(f"/ingest-jobs/{job['id']}").json()["state"] == "pending"
        submitted = len(gated.futures)

        response = client.post(f"/ingest-jobs/{job['id']}/resume")

        assert response.status_code == 202, response.text
        # The row is the client's answer, so the id must be the one it already
        # holds — a resume runs the same job and never forks a second row.
        assert response.json()["id"] == job["id"]
        assert response.headers["Location"] == f"/ingest-jobs/{job['id']}"
        # Accepted means handed to the worker, not merely "not refused".
        assert len(gated.futures) == submitted + 1

        gated.release.set()
        gated.wait()

        # Two attempts are now in flight for one row, which is what resuming a job
        # whose first run is still queued *means*. One worker runs them in order,
        # the loser finds the job settled and `IngestRunner.submit` swallows and
        # logs its `InvalidTransition` — so an ERROR line here is the design
        # working, not a failure. What matters is that the loser left no mark:
        # `resumable` refuses before the run touches the row, so `error` stays
        # null and the row is not the place a second caller's refusal shows up.
        settled = client.get(f"/ingest-jobs/{job['id']}").json()
        assert settled["state"] == "completed"
        assert settled["error"] is None

        # Still one row, and the source's assets arrived exactly once — the
        # redo-not-skip claim, which content addressing is what makes free.
        assert client.get(f"/sources/{source}/ingest-jobs").json()["total"] == 1
        assert client.get(f"/batches/{settled['batch_id']}/assets").json()["total"] == 1


def test_polling_is_answered_while_another_writer_holds_the_workspace(
    client: TestClient, project: str, tmp_path: Path, runner: RecordingRunner
) -> None:
    """#80's payoff, at the surface it was landed for.

    A second `WorkspaceService` over one file is two engines with no shared cache
    — what two *processes* look like to SQLite. It writes and parks; the request
    thread must still be answered, and with the last committed state rather than
    the writer's uncommitted one.
    """
    source = registered_images(client, project, png_part(tmp_path))
    job = launch(client, source).json()
    runner.wait()

    writing = threading.Event()
    release = threading.Event()
    other = WorkspaceService.open(tmp_path / "ws")

    def hold_the_write_lock() -> None:
        with other.unit_of_work() as uow:
            held = uow.ingest_jobs.get(UUID(job["id"]))
            assert held is not None
            uow.ingest_jobs.update(held.model_copy(update={"total": 99}))
            writing.set()
            assert release.wait(timeout=JOIN_TIMEOUT)

    writer = threading.Thread(target=hold_the_write_lock, name="lock-holder")
    writer.start()
    try:
        assert writing.wait(timeout=JOIN_TIMEOUT)
        during = client.get(f"/ingest-jobs/{job['id']}")
        assert during.status_code == 200
        assert during.json()["total"] != 99
    finally:
        release.set()
        writer.join(timeout=JOIN_TIMEOUT)
        other.close()

    assert not writer.is_alive()
    assert client.get(f"/ingest-jobs/{job['id']}").json()["total"] == 99


# --- the guard ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/ingest-jobs/00000000-0000-0000-0000-000000000000"),
        ("POST", "/ingest-jobs/00000000-0000-0000-0000-000000000000/resume"),
    ],
)
def test_every_ingest_route_refuses_a_request_with_no_token(
    client: TestClient, method: str, path: str
) -> None:
    response = client.request(method, path, headers={"Authorization": ""})

    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHORIZED"
