"""Launching a run and polling it — the contract every long operation reuses.

The acceptance walk is one test here: upload a clip, register it at 5 fps,
launch, wait, read the assets. It is deliberately the shape a real client has —
nothing reaches past the API for an answer the API is supposed to give.

**Nothing in this module sleeps, and nothing needs to.** Work is
claimed off a durable queue, so "launched but not yet run" is a row rather than a
thread parked on an `Event`: `ManualDispatcher` simply does not run it, and
`InlineDispatcher` runs it before the launch responds. The discipline
`tests/kernel/test_concurrency.py` set is unchanged; there is just less to
sequence.
"""

from __future__ import annotations

import io
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from tests.fixtures.media import write_corrupt_video, write_image, write_video
from tests.server._api import api_client
from tests.server._jobs import JOIN_TIMEOUT, InlineDispatcher, ManualDispatcher

from visionset.kernel.services import WorkspaceService

# Above `testsrc`'s resolution floor — see `test_sources.py`.
CLIP_SIZE = (160, 120)

#: 2 seconds at 10 fps cut at 5 fps. The generator's defaults make this exact,
#: which is what lets the walk assert a count rather than a range.
EXTRACTION_FPS = 5
EXPECTED_FRAMES = 10


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture()
def project(client: TestClient) -> str:
    response = client.post("/projects", json={"name": "road-signs"})
    assert response.status_code == 201, response.text
    project_id: str = response.json()["id"]
    return project_id


def queued_jobs(client: TestClient) -> int:
    """How much background work is waiting, read off the wire.

    Replaces the old `len(runner.futures)`, and it is a better assertion than the
    one it replaces: a future was an in-memory artefact of the test's own double,
    while this is the durable row a restarted server would find. It also means the
    "nothing was started" tests are checking the thing that would actually start.
    """
    response = client.get("/background-jobs", params={"state": "queued"})
    assert response.status_code == 200, response.text
    total: int = response.json()["total"]
    return total


def registered_clip(client: TestClient, project: str, tmp_path: Path) -> str:
    clip = write_video(tmp_path / "made" / "drive.mp4", size=CLIP_SIZE).path
    return _uploaded_clip(client, project, clip)


def registered_broken_clip(client: TestClient, project: str, tmp_path: Path) -> str:
    """The same upload, of a clip whose tail is gone.

    Truncated *before* it is posted, so the server registers and probes exactly what a
    half-finished copy would have left on somebody's disk. The faststart index at the front
    is what keeps that file describable — see `write_corrupt_video`.
    """
    clip = write_corrupt_video(tmp_path / "made" / "broken.mp4", size=CLIP_SIZE).path
    return _uploaded_clip(client, project, clip)


def _uploaded_clip(client: TestClient, project: str, clip: Path) -> str:
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


def _part(name: str, payload: bytes, media_type: str) -> tuple[str, tuple[str, bytes, str]]:
    return ("files", (name, payload, media_type))


def test_uploaded_wide_formats_ingest_through_the_same_door(
    client: TestClient, project: str, runner: InlineDispatcher
) -> None:
    """An upload is staged to disk and read by the ordinary ingest, so an HEIC
    arrives as a JPEG asset and an animated GIF as PNG frames without any route
    or client knowing a format was involved."""
    heic = io.BytesIO()
    Image.new("RGB", (32, 24), (120, 60, 30)).save(heic, format="HEIF")
    shades = [Image.new("L", (16, 12), 30 + i * 40) for i in range(3)]
    gif = io.BytesIO()
    shades[0].save(gif, format="GIF", save_all=True, append_images=shades[1:], duration=100)

    source = registered_images(
        client,
        project,
        _part("photo.heic", heic.getvalue(), "image/heic"),
        _part("anim.gif", gif.getvalue(), "image/gif"),
    )
    started = launch(client, source)
    assert started.status_code == 202, started.text
    runner.wait()

    polled = client.get(f"/ingest-jobs/{started.json()['id']}").json()
    assert polled["state"] == "completed"
    assert polled["failures"] == []
    assert (polled["processed"], polled["total"]) == (2, 2)

    # The wire deliberately publishes no path, so the claim is read off what it
    # does publish: the decomposed frames in order as PNG, the converted still
    # beside them as JPEG.
    body = client.get(f"/batches/{polled['batch_id']}/assets").json()
    seen = sorted(
        ((asset["format"], asset["frame_index"]) for asset in body["items"]),
        key=lambda pair: (pair[0], -1 if pair[1] is None else pair[1]),
    )
    assert seen == [("jpeg", None), ("png", 0), ("png", 1), ("png", 2)]


# --- the acceptance walk -----------------------------------------------------


def test_a_clip_uploaded_and_ingested_at_five_fps_lists_its_assets(
    client: TestClient, project: str, tmp_path: Path, runner: InlineDispatcher
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
    """The whole promise of the 202: the row is pollable while the work has not begun.

    `ManualDispatcher` runs nothing until `run()`, so the observable state is
    simply the one the launch left behind. The old shape of this test parked a
    worker thread on an `Event` to reach the same instant; the queue makes the
    instant durable instead, which is what the job queue buys rather than
    an easier way to write the assertion.
    """
    gated = ManualDispatcher()
    with api_client(tmp_path / "gated", dispatcher=gated) as client:
        made = client.post("/projects", json={"name": "gated"}).json()["id"]
        source = registered_images(client, made, png_part(tmp_path))

        job = launch(client, source).json()
        # The launch nudged the dispatcher rather than trusting the poll interval.
        assert gated.wakes == 1

        parked = client.get(f"/ingest-jobs/{job['id']}")
        assert parked.status_code == 200
        assert parked.json()["state"] == "pending"

        assert gated.run() == 1

        assert client.get(f"/ingest-jobs/{job['id']}").json()["state"] == "completed"


def test_a_launch_names_the_batch_it_was_asked_to(
    client: TestClient, project: str, tmp_path: Path, runner: InlineDispatcher
) -> None:
    source = registered_images(client, project, png_part(tmp_path))

    job = launch(client, source, batch_name="monday").json()
    runner.wait()

    assert client.get(f"/ingest-jobs/{job['id']}").json()["batch_name"] == "monday"


def test_a_blank_batch_name_is_the_domains_own_422_not_a_500(
    client: TestClient, project: str, tmp_path: Path, runner: InlineDispatcher
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
    assert queued_jobs(client) == 0


def test_launching_over_an_unknown_source_is_404_and_starts_nothing(
    client: TestClient, runner: InlineDispatcher
) -> None:
    """Refused on the calling thread, so a 202 never points at a job row nobody wrote."""
    response = launch(client, str(uuid4()))

    assert response.status_code == 404
    assert response.json()["code"] == "SOURCE_NOT_FOUND"
    assert queued_jobs(client) == 0


# --- what a run reports ------------------------------------------------------


def test_an_unreadable_item_is_reported_and_does_not_fail_the_run(
    client: TestClient, project: str, tmp_path: Path, runner: InlineDispatcher
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


def test_a_partial_extraction_is_reported_with_both_numbers(
    client: TestClient, project: str, tmp_path: Path, runner: InlineDispatcher
) -> None:
    """The partial report, on the wire the ingest screen actually polls."""
    source = registered_broken_clip(client, project, tmp_path)

    job = launch(client, source).json()
    runner.wait()

    polled = client.get(f"/ingest-jobs/{job['id']}").json()
    assert polled["state"] == "completed"
    reported = polled["failures"]
    assert [f["kind"] for f in reported] == ["partial"]
    assert reported[0]["name"] == "broken.mp4"
    # What arrived is what is in the batch, and it is short of the estimate.
    assets = client.get(f"/batches/{polled['batch_id']}/assets").json()
    assert reported[0]["frames_produced"] == assets["total"] > 0
    assert reported[0]["frames_expected_estimate"] == EXPECTED_FRAMES
    assert reported[0]["frames_produced"] < EXPECTED_FRAMES


def test_a_partial_extraction_changes_nothing_about_the_assets_it_produced(
    client: TestClient, project: str, tmp_path: Path, runner: InlineDispatcher
) -> None:
    """The boundary the partial report draws, asserted rather than intended.

    The report is the ingest job's and it stops there. An asset lifted out of a damaged
    clip is an ordinary asset — same fields, same batch — so nothing downstream can learn
    where it came from, and nothing downstream has to.
    """
    clean = registered_clip(client, project, tmp_path)
    broken = registered_broken_clip(client, project, tmp_path)

    good = launch(client, clean).json()
    runner.wait()
    damaged = launch(client, broken).json()
    runner.wait()

    good_batch = client.get(f"/ingest-jobs/{good['id']}").json()["batch_id"]
    damaged_batch = client.get(f"/ingest-jobs/{damaged['id']}").json()["batch_id"]

    def shape(payload: dict[str, Any]) -> set[str]:
        return set(payload.keys())

    good_assets = client.get(f"/batches/{good_batch}/assets").json()["items"]
    damaged_assets = client.get(f"/batches/{damaged_batch}/assets").json()["items"]
    assert damaged_assets
    assert shape(damaged_assets[0]) == shape(good_assets[0])
    assert shape(client.get(f"/batches/{damaged_batch}").json()) == shape(
        client.get(f"/batches/{good_batch}").json()
    )


def test_listing_the_runs_of_a_source(
    client: TestClient, project: str, tmp_path: Path, runner: InlineDispatcher
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
    client: TestClient, project: str, tmp_path: Path, runner: InlineDispatcher
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
    client: TestClient, project: str, tmp_path: Path, runner: InlineDispatcher
) -> None:
    """Refused on the calling thread: a 202 here would leave a client unable to tell
    a redo from a job that did nothing."""
    source = registered_images(client, project, png_part(tmp_path))
    job = launch(client, source).json()
    runner.wait()
    before = queued_jobs(client)

    response = client.post(f"/ingest-jobs/{job['id']}/resume")

    assert response.status_code == 409
    assert response.json()["code"] == "INVALID_TRANSITION"
    assert queued_jobs(client) == before


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
    gated = ManualDispatcher()
    with api_client(tmp_path / "resumable", dispatcher=gated) as client:
        made = client.post("/projects", json={"name": "resumable"}).json()["id"]
        source = registered_images(client, made, png_part(tmp_path))

        job = launch(client, source).json()
        assert client.get(f"/ingest-jobs/{job['id']}").json()["state"] == "pending"
        submitted = queued_jobs(client)

        response = client.post(f"/ingest-jobs/{job['id']}/resume")

        assert response.status_code == 202, response.text
        # The row is the client's answer, so the id must be the one it already
        # holds — a resume runs the same job and never forks a second row.
        assert response.json()["id"] == job["id"]
        assert response.headers["Location"] == f"/ingest-jobs/{job['id']}"
        # Accepted means queued, not merely "not refused". The *ingest* job is the
        # same row; the work queued against it is a second background job, which is
        # exactly what "two attempts for one row" now looks like on disk.
        assert queued_jobs(client) == submitted + 1

        gated.run()

        # Two background jobs now point at one ingest row, which is what resuming
        # a job whose first run is still queued *means*. The dispatcher runs them
        # in order; the loser finds the ingest job settled, and its
        # `InvalidTransition` fails that background job rather than escaping — so
        # a failed second job here is the design working, not a defect. What
        # matters is that the loser left no mark on the *ingest* row:
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
    client: TestClient, project: str, tmp_path: Path, runner: InlineDispatcher
) -> None:
    """The WAL payoff, at the surface it was landed for.

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
