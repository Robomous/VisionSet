"""Tracked jobs in real ``spawn`` workers, against the real MLflow client and a recording server.

Needs the ``mlflow`` extra, so it runs in the ``tracking-smoke`` CI job and skips
elsewhere. What only this can show: concurrent workers each address their own run
by id, with no process-global active run to collide on, and a worker that dies
mid-run leaves a run the dispatcher can find and fail.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from tests.fixtures.mlflow_server import MlflowServer, require_mlflow, serving_mlflow

from visionset.jobs import HandlerRef, JobRunner, _tracking, register
from visionset.kernel.domain import BackgroundJobSpec, BackgroundJobState
from visionset.kernel.errors import BatchNotFound
from visionset.kernel.services import WorkspaceService
from visionset.tracking import tracking_settings

SETTLE_TIMEOUT_S = 120.0
SECRET = "/home/someone/secret-dir"


def overlapping(workspace_root: Path, payload: dict[str, Any], reporter: Any) -> dict[str, Any]:
    """Waits until another worker is inside a job too, so the runs are open together."""
    marks = Path(str(payload["marks"]))
    (marks / f"{os.getpid()}-{time.monotonic_ns()}").write_text("")
    deadline = time.monotonic() + SETTLE_TIMEOUT_S / 4
    while len({mark.name.split("-")[0] for mark in marks.iterdir()}) < 2:
        assert time.monotonic() < deadline, "no second worker arrived"
        time.sleep(0.01)
    time.sleep(0.2)
    if payload.get("refuse"):
        raise BatchNotFound(SECRET)
    reporter.report(processed=1, total=1)
    return {}


def dies(workspace_root: Path, payload: dict[str, Any], reporter: Any) -> dict[str, Any]:
    assert _tracking.flush(30)
    os._exit(1)


OVERLAPPING = "test.tracked_overlapping"
DIES = "test.tracked_dies"
register(HandlerRef(type=OVERLAPPING, func=f"{__name__}:overlapping"))
register(HandlerRef(type=DIES, func=f"{__name__}:dies"))


@pytest.fixture()
def server(monkeypatch: pytest.MonkeyPatch) -> Iterator[MlflowServer]:
    require_mlflow()
    with serving_mlflow() as running:
        monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
        monkeypatch.setenv("MLFLOW_TRACKING_URI", running.url)
        monkeypatch.setenv("MLFLOW_HTTP_REQUEST_MAX_RETRIES", "0")
        tracking_settings.cache_clear()
        _tracking._TRACKERS.clear()
        yield running
        assert _tracking.flush(30)
        _tracking._TRACKERS.clear()
        tracking_settings.cache_clear()


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws")
    yield made
    made.close()


def _run_until_settled(
    workspace: WorkspaceService, job_ids: list[UUID], workers: int
) -> dict[UUID, Any]:
    runner = JobRunner(
        workspace.job_queue,
        workspace.root,
        workers=workers,
        poll_interval_s=0.05,
        tracking=tracking_settings(),
    )
    runner.start()
    try:
        runner.wake()
        deadline = time.monotonic() + SETTLE_TIMEOUT_S
        while time.monotonic() < deadline:
            rows = {job_id: workspace.job_queue.get(job_id) for job_id in job_ids}
            if all(row is not None and row.settled for row in rows.values()):
                break
            time.sleep(0.05)
    finally:
        # Stopping the pool is what lets each worker flush its deliveries on exit.
        runner.stop(timeout=SETTLE_TIMEOUT_S)
    return {job_id: workspace.job_queue.get(job_id) for job_id in job_ids}


def test_concurrent_spawned_workers_each_record_their_own_run(
    server: MlflowServer, workspace: WorkspaceService, tmp_path: Path
) -> None:
    marks = tmp_path / "marks"
    marks.mkdir()
    jobs = [
        workspace.job_queue.enqueue(
            BackgroundJobSpec(
                type=OVERLAPPING, payload={"marks": str(marks), "refuse": index % 3 == 0}
            )
        )
        for index in range(6)
    ]

    rows = _run_until_settled(workspace, [job.id for job in jobs], workers=3)

    assert len({mark.name.split("-")[0] for mark in marks.iterdir()}) > 1

    runs = list(server.runs.values())
    assert len(runs) == len(jobs)
    by_job = {run.tags["visionset.job_id"]: run for run in runs}
    assert set(by_job) == {str(job.id) for job in jobs}
    assert len({run.tags["visionset.execution_id"] for run in runs}) == len(jobs)
    for job in jobs:
        row, run = rows[job.id], by_job[str(job.id)]
        assert run.updates == 1
        if job.payload["refuse"]:
            assert row.state is BackgroundJobState.FAILED
            assert (run.status, run.tags["visionset.error_code"]) == ("FAILED", "BATCH_NOT_FOUND")
        else:
            assert row.state is BackgroundJobState.SUCCEEDED
            assert run.status == "FINISHED"
            assert run.metrics["processed_count"] == 1.0
        assert run.tags["visionset.job_type"] == OVERLAPPING
        assert run.metrics["duration_seconds"] >= 0.2

    sent = repr([(seen.path, seen.body) for seen in server.requests])
    assert SECRET not in sent
    assert str(marks) not in sent


def test_a_worker_that_dies_mid_run_has_its_run_failed_by_the_dispatcher(
    server: MlflowServer, workspace: WorkspaceService
) -> None:
    job = workspace.job_queue.enqueue(BackgroundJobSpec(type=DIES, payload={}))

    rows = _run_until_settled(workspace, [job.id], workers=1)

    assert rows[job.id].state is BackgroundJobState.FAILED
    assert _tracking.flush(30)
    [run] = server.runs.values()
    assert run.tags["visionset.job_id"] == str(job.id)
    assert run.status == "FAILED"
    assert run.tags["visionset.reconciled"] == "worker_lost"
