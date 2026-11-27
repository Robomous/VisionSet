"""Background job runs on a tracker: one per attempt, from an allowlist, never in the job's way.

Driven with an in-memory tracker and the inline executor, so every assertion
reads what the tracker was handed. The real client in spawned workers is
``test_job_tracking_spawn.py``.
"""

from __future__ import annotations

import contextlib
import threading
from collections.abc import Iterator, Mapping
from concurrent.futures import Executor, Future
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest

from visionset.jobs import HandlerRef, JobRunner, _tracking, register
from visionset.jobs._tracking import (
    AttemptTracking,
    attempt_params,
    attempt_tags,
    failure_tags,
    open_attempt,
    outcome_metrics,
    result_params,
)
from visionset.jobs._worker import execute
from visionset.kernel.domain import PRE_LABEL_JOB_TYPE, BackgroundJobSpec, BackgroundJobState
from visionset.kernel.errors import BatchNotFound, TrackingUnavailable
from visionset.kernel.services import WorkspaceService
from visionset.tracking import ParamValue, RunStatus, TrackingSettings

SECRET = "/home/someone/secret-dir https://user:hunter2@mlflow.example:5000"
ENABLED = TrackingSettings(mlflow_enabled=True, mlflow_experiment="visionset")

ALLOWED_TAGS = {
    "visionset.job_id",
    "visionset.job_type",
    "visionset.execution_id",
    "visionset.attempt",
    "visionset.execution_source",
    "visionset.version",
    "visionset.batch_id",
    "visionset.connection_id",
    "visionset.annotation_job_id",
    "visionset.job_state",
    "visionset.error_class",
    "visionset.error_code",
    "visionset.reconciled",
}
ALLOWED_PARAMS = {
    "minimum_confidence",
    "requested_geometries",
    "replace_model_labels",
    "model_id",
    "model_revision",
}
ALLOWED_METRICS = {
    "duration_seconds",
    "processed_count",
    "total_count",
    "failures_count",
    "assets_skipped_count",
    "regions_discarded_count",
    "regions_out_of_bounds_count",
    "annotations_written_count",
    "annotations_replaced_count",
}


def handler(workspace_root: Path, payload: dict[str, Any], reporter: Any) -> dict[str, Any]:
    if payload.get("explode"):
        raise RuntimeError(SECRET)
    if payload.get("refuse"):
        raise BatchNotFound(SECRET)
    if reporter.is_cancelled():
        return {}
    if payload.get("silent"):
        return {}
    reporter.report(processed=3, total=4)
    result = payload.get("result")
    return result if isinstance(result, dict) else {"ok": True}


TYPE = "test.tracked"
register(HandlerRef(type=TYPE, func=f"{__name__}:handler", idempotent=True))
PRE_LABEL_REF = HandlerRef(type=PRE_LABEL_JOB_TYPE, func=f"{__name__}:handler")


class InlineExecutor(Executor):
    """Runs now, on this thread, capturing an exception on the future like a pool does."""

    def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:  # type: ignore[override]
        future: Future[Any] = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:  # noqa: BLE001 — mirrors a real pool
            future.set_exception(exc)
        return future


@dataclass
class Recorded:
    name: str
    tags: dict[str, str]
    params: dict[str, ParamValue] = field(default_factory=dict)
    metrics: dict[str, float] = field(default_factory=dict)
    status: RunStatus | None = None
    ends: int = 0


class FakeTracker:
    """Records runs by id; raises where told to, and can be held at ``start_run``."""

    def __init__(self) -> None:
        self.runs: dict[str, Recorded] = {}
        self.fail: set[str] = set()
        self.hold: threading.Event | None = None
        self.lock = threading.Lock()

    def _maybe_fail(self, name: str) -> None:
        if name in self.fail:
            raise RuntimeError(f"{name} failed: {SECRET}")

    def start_run(self, name: str, *, tags: Mapping[str, str] | None = None) -> str | None:
        if self.hold is not None:
            self.hold.wait(timeout=10)
        self._maybe_fail("start")
        with self.lock:
            run_id = f"run-{len(self.runs) + 1}"
            self.runs[run_id] = Recorded(name, dict(tags or {}))
        return run_id

    def log_params(self, run_id: str | None, params: Mapping[str, ParamValue]) -> None:
        self._maybe_fail("params")
        if run_id is not None:
            self.runs[run_id].params.update(params)

    def log_metrics(
        self, run_id: str | None, metrics: Mapping[str, float], *, step: int | None = None
    ) -> None:
        self._maybe_fail("metrics")
        if run_id is not None:
            self.runs[run_id].metrics.update(metrics)

    def set_tags(self, run_id: str | None, tags: Mapping[str, str]) -> None:
        self._maybe_fail("tags")
        if run_id is not None:
            self.runs[run_id].tags.update(tags)

    def end_run(self, run_id: str | None, status: RunStatus = RunStatus.FINISHED) -> None:
        self._maybe_fail("end")
        if run_id is not None:
            self.runs[run_id].status = status
            self.runs[run_id].ends += 1

    def running_runs(self, tags: Mapping[str, str]) -> list[str]:
        self._maybe_fail("search")
        return [
            run_id
            for run_id, run in self.runs.items()
            if run.status is None and all(run.tags.get(k) == v for k, v in tags.items())
        ]


@pytest.fixture()
def tracker(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeTracker]:
    fake = FakeTracker()
    built: list[TrackingSettings] = []

    def build(settings: TrackingSettings) -> FakeTracker:
        built.append(settings)
        return fake

    monkeypatch.setattr(_tracking, "build_tracker", build)
    _tracking._TRACKERS.clear()
    fake.built = built  # type: ignore[attr-defined]
    yield fake
    if fake.hold is not None:
        fake.hold.set()
    assert _tracking.flush(10)
    _tracking._TRACKERS.clear()


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws")
    yield made
    made.close()


def runner_for(
    workspace: WorkspaceService,
    tracking: TrackingSettings | None = ENABLED,
    executor: Executor | None = None,
) -> JobRunner:
    return JobRunner(
        workspace.job_queue,
        workspace.root,
        workers=1,
        progress_min_interval_s=0,
        executor_factory=lambda _: executor or InlineExecutor(),
        error_code=lambda exc: "BATCH_NOT_FOUND" if isinstance(exc, BatchNotFound) else None,
        tracking=tracking,
    )


def queued(workspace: WorkspaceService, **payload: Any) -> Any:
    return workspace.job_queue.enqueue(
        BackgroundJobSpec(type=TYPE, payload=payload, idempotent=True)
    )


def settled(workspace: WorkspaceService, job_id: UUID) -> Any:
    assert _tracking.flush(10)
    stored = workspace.job_queue.get(job_id)
    assert stored is not None
    return stored


def everything_sent(fake: FakeTracker) -> str:
    return repr(
        [(run.name, run.tags, run.params, run.metrics, run.status) for run in fake.runs.values()]
    )


# --- one run per attempt -------------------------------------------------------


def test_a_succeeded_job_is_one_finished_run_carrying_its_identity(
    workspace: WorkspaceService, tracker: FakeTracker
) -> None:
    job = queued(workspace)

    runner_for(workspace).drain()

    stored = settled(workspace, job.id)
    assert stored.state is BackgroundJobState.SUCCEEDED
    [run] = tracker.runs.values()
    assert run.name == TYPE
    assert run.status is RunStatus.FINISHED
    assert run.ends == 1
    assert run.tags["visionset.job_id"] == str(job.id)
    assert run.tags["visionset.job_type"] == TYPE
    assert run.tags["visionset.attempt"] == "1"
    assert run.tags["visionset.execution_source"] == "background_job"
    assert run.tags["visionset.job_state"] == "succeeded"
    assert UUID(run.tags["visionset.execution_id"])
    assert set(run.metrics) == {
        "duration_seconds",
        "processed_count",
        "total_count",
        "failures_count",
    }
    assert (run.metrics["processed_count"], run.metrics["total_count"]) == (3.0, 4.0)
    assert run.metrics["failures_count"] == 0.0
    assert run.metrics["duration_seconds"] >= 0.0
    assert tracker.built == [ENABLED]  # type: ignore[attr-defined]


def test_a_failed_job_keeps_its_error_and_its_run_records_only_class_and_code(
    workspace: WorkspaceService, tracker: FakeTracker
) -> None:
    refused = queued(workspace, refuse=True)
    exploded = queued(workspace, explode=True)

    runner_for(workspace).drain()

    for job, code in ((refused, "BATCH_NOT_FOUND"), (exploded, None)):
        stored = settled(workspace, job.id)
        assert stored.state is BackgroundJobState.FAILED
        assert stored.error == SECRET
        assert stored.error_code == code
    by_job = {run.tags["visionset.job_id"]: run for run in tracker.runs.values()}
    refused_run, exploded_run = by_job[str(refused.id)], by_job[str(exploded.id)]
    assert refused_run.status is exploded_run.status is RunStatus.FAILED
    assert refused_run.tags["visionset.error_class"] == "BatchNotFound"
    assert refused_run.tags["visionset.error_code"] == "BATCH_NOT_FOUND"
    assert exploded_run.tags["visionset.error_class"] == "RuntimeError"
    assert "visionset.error_code" not in exploded_run.tags
    assert set(exploded_run.metrics) == {"duration_seconds"}
    assert "secret" not in everything_sent(tracker)
    assert "hunter2" not in everything_sent(tracker)


def test_the_handlers_exception_reaches_the_caller_unchanged(tracker: FakeTracker) -> None:
    class Peculiar(Exception):
        pass

    def raise_peculiar(*_: Any) -> dict[str, Any]:
        raise Peculiar("as raised")

    attempt = AttemptTracking(
        settings=ENABLED, execution_id=uuid4(), job_id=uuid4(), job_type=TYPE, attempt=1
    )
    ref = HandlerRef(type=TYPE, func=f"{__name__}:handler")
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr("visionset.jobs._worker.load", lambda _ref: raise_peculiar)
        patch.setattr("visionset.jobs._worker.workspace_for", lambda _root: _NoStore())
        patch.setattr("visionset.jobs._worker.SqliteProgressReporter", _NoReporter)
        with pytest.raises(Peculiar, match="as raised") as raised:
            execute(ref, Path("/nowhere"), uuid4(), {}, 0, attempt)

    assert type(raised.value) is Peculiar
    assert _tracking.flush(10)
    [run] = tracker.runs.values()
    assert run.tags["visionset.error_class"] == "Peculiar"


class _NoStore:
    metadata_store = None


class _NoReporter:
    def __init__(self, *_: Any, **__: Any) -> None:
        pass


class CancellingExecutor(InlineExecutor):
    """Asks the job to stop before its handler runs, as a person pressing cancel would."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self.workspace = workspace

    def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:  # type: ignore[override]
        self.workspace.job_queue.request_cancel(args[2])
        return super().submit(fn, *args, **kwargs)


def test_a_cooperatively_cancelled_job_is_a_killed_run(
    workspace: WorkspaceService, tracker: FakeTracker
) -> None:
    job = queued(workspace)

    runner_for(workspace, executor=CancellingExecutor(workspace)).drain()

    assert settled(workspace, job.id).state is BackgroundJobState.CANCELLED
    [run] = tracker.runs.values()
    assert run.status is RunStatus.KILLED
    assert run.tags["visionset.job_state"] == "cancelled"
    # The handler stopped before it reported anything, so no count is invented.
    assert set(run.metrics) == {"duration_seconds"}


def test_a_retry_is_an_independent_run_and_correlates_by_identity(
    workspace: WorkspaceService, tracker: FakeTracker
) -> None:
    first = queued(workspace, explode=True)
    runner = runner_for(workspace)
    runner.drain()
    retry = queued(workspace)
    runner.drain()

    assert settled(workspace, first.id).state is BackgroundJobState.FAILED
    assert settled(workspace, retry.id).state is BackgroundJobState.SUCCEEDED
    failed, succeeded = tracker.runs.values()
    assert (failed.status, succeeded.status) == (RunStatus.FAILED, RunStatus.FINISHED)
    assert failed.tags["visionset.job_id"] == str(first.id)
    assert succeeded.tags["visionset.job_id"] == str(retry.id)
    assert failed.tags["visionset.execution_id"] != succeeded.tags["visionset.execution_id"]
    assert failed.ends == succeeded.ends == 1


def test_an_orphan_from_a_dead_server_is_failed_late_and_its_reenqueue_tracked_apart(
    workspace: WorkspaceService, tracker: FakeTracker
) -> None:
    orphan = queued(workspace)
    claimed = workspace.job_queue.claim("a server that then died")
    assert claimed is not None and claimed.id == orphan.id
    dangling = tracker.start_run(
        TYPE,
        tags={
            "visionset.job_id": str(orphan.id),
            "visionset.execution_source": "background_job",
        },
    )
    assert dangling is not None

    runner = runner_for(workspace)
    runner.start()
    try:
        replacement = _wait_for_settled_replacement(workspace, orphan.id)
    finally:
        runner.stop(timeout=10)

    assert _tracking.flush(10)
    assert tracker.runs[dangling].status is RunStatus.FAILED
    assert tracker.runs[dangling].tags["visionset.reconciled"] == "server_restart"
    [rerun] = [
        run
        for run in tracker.runs.values()
        if run.name == TYPE and run is not tracker.runs[dangling]
    ]
    assert rerun.tags["visionset.job_id"] == str(replacement.id)
    assert rerun.status is RunStatus.FINISHED


def _wait_for_settled_replacement(workspace: WorkspaceService, orphan_id: UUID) -> Any:
    import time

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        others = [job for job in workspace.job_queue.list() if job.id != orphan_id]
        if others and others[0].settled:
            return others[0]
        time.sleep(0.02)
    raise AssertionError("the re-enqueued orphan never settled")


class CrashingExecutor(Executor):
    """A worker that opens its run and then dies, as a killed process does."""

    def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:  # type: ignore[override]
        open_attempt(args[5], args[3])
        future: Future[Any] = Future()
        future.set_exception(BrokenProcessPool("a worker died"))
        return future


def test_a_run_left_open_by_a_dead_worker_is_failed_by_the_dispatcher(
    workspace: WorkspaceService, tracker: FakeTracker
) -> None:
    job = queued(workspace)

    runner_for(workspace, executor=CrashingExecutor()).drain()

    assert settled(workspace, job.id).state is BackgroundJobState.FAILED
    [run] = tracker.runs.values()
    assert run.status is RunStatus.FAILED
    assert run.tags["visionset.reconciled"] == "worker_lost"
    assert run.tags["visionset.job_id"] == str(job.id)


def test_a_handler_failure_is_not_reconciled_twice(
    workspace: WorkspaceService, tracker: FakeTracker
) -> None:
    queued(workspace, explode=True)

    runner_for(workspace).drain()

    assert _tracking.flush(10)
    [run] = tracker.runs.values()
    assert run.ends == 1
    assert "visionset.reconciled" not in run.tags


# --- tracking never changes a job -----------------------------------------------


@pytest.mark.parametrize("fail_at", ["start", "params", "metrics", "tags", "end", "search"])
def test_a_tracker_failing_anywhere_leaves_every_outcome_as_it_was(
    workspace: WorkspaceService, tracker: FakeTracker, fail_at: str, tmp_path: Path
) -> None:
    tracker.fail = {fail_at}
    jobs = [queued(workspace), queued(workspace, refuse=True)]
    runner_for(workspace).drain()
    crashed = queued(workspace)
    runner_for(workspace, executor=CrashingExecutor()).drain()

    outcomes = [
        (settled(workspace, job.id).state, settled(workspace, job.id).error) for job in jobs
    ]
    assert outcomes == [
        (BackgroundJobState.SUCCEEDED, None),
        (BackgroundJobState.FAILED, SECRET),
    ]
    assert settled(workspace, crashed.id).state is BackgroundJobState.FAILED
    if fail_at in {"params", "metrics", "tags"}:
        assert all(run.ends == 1 for run in tracker.runs.values())


def test_a_tracker_that_cannot_be_built_leaves_jobs_running_untracked(
    workspace: WorkspaceService, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(_: TrackingSettings) -> Any:
        raise TrackingUnavailable("no client here")

    monkeypatch.setattr(_tracking, "build_tracker", refuse)
    _tracking._TRACKERS.clear()
    job = queued(workspace)

    runner_for(workspace).drain()

    assert settled(workspace, job.id).state is BackgroundJobState.SUCCEEDED
    _tracking._TRACKERS.clear()


def test_a_tracker_that_hangs_does_not_hold_the_job(
    workspace: WorkspaceService, tracker: FakeTracker
) -> None:
    tracker.hold = threading.Event()
    job = queued(workspace)

    runner_for(workspace).drain()

    stored = workspace.job_queue.get(job.id)
    assert stored is not None and stored.state is BackgroundJobState.SUCCEEDED
    assert not _tracking.flush(0.05)
    assert tracker.runs == {}

    tracker.hold.set()
    assert _tracking.flush(10)
    [run] = tracker.runs.values()
    assert run.status is RunStatus.FINISHED


def test_a_backlog_past_its_bound_stops_tracking_new_attempts(
    workspace: WorkspaceService, tracker: FakeTracker, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(_tracking, "MAX_BACKLOG", 2)
    tracker.hold = threading.Event()
    jobs = [queued(workspace) for _ in range(3)]

    runner_for(workspace).drain()
    tracker.hold.set()

    assert all(settled(workspace, job.id).state is BackgroundJobState.SUCCEEDED for job in jobs)
    assert len(tracker.runs) == 1
    assert _tracking.MAX_BACKLOG == 2


def test_disabled_tracking_builds_nothing_and_hands_workers_nothing(
    workspace: WorkspaceService, tracker: FakeTracker
) -> None:
    seen: list[Any] = []

    class Recording(InlineExecutor):
        def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:  # type: ignore[override]
            seen.append(args[5])
            return super().submit(fn, *args, **kwargs)

    for settings in (None, TrackingSettings(mlflow_enabled=False)):
        queued(workspace)
        runner_for(workspace, tracking=settings, executor=Recording()).drain()

    assert seen == [None, None]
    assert tracker.runs == {}
    assert tracker.built == []  # type: ignore[attr-defined]


# --- the allowlist ---------------------------------------------------------------


def _attempt(job_type: str = PRE_LABEL_JOB_TYPE) -> AttemptTracking:
    return AttemptTracking(
        settings=ENABLED, execution_id=uuid4(), job_id=uuid4(), job_type=job_type, attempt=2
    )


def test_pre_labeling_sends_its_request_its_model_and_its_counts(
    workspace: WorkspaceService, tracker: FakeTracker
) -> None:
    batch, connection, annotation_job = uuid4(), uuid4(), uuid4()
    payload: dict[str, Any] = {
        "annotation_job_id": str(annotation_job),
        "batch_id": str(batch),
        "connection_id": str(connection),
        "minimum_confidence": 0.35,
        "replace_model_labels": True,
        "geometries": ["polygon", "bbox"],
        "result": {
            "annotation_job_id": str(annotation_job),
            "batch_id": str(batch),
            "assets_considered": 9,
            "assets_labeled": 7,
            "annotations_written": 21,
            "model_ref": "IDEA-Research/grounding-dino-tiny@" + "a" * 40,
            "stopped_early": False,
            "assets_skipped": 1,
            "regions_discarded": 0,
            "regions_out_of_bounds": 2,
            "annotations_replaced": 5,
        },
    }
    job = workspace.job_queue.enqueue(BackgroundJobSpec(type=TYPE, payload=payload))
    workspace.job_queue.claim("test")

    execute(PRE_LABEL_REF, workspace.root, job.id, payload, 0, _attempt())

    assert _tracking.flush(10)
    [run] = tracker.runs.values()
    assert run.name == PRE_LABEL_JOB_TYPE
    assert run.tags["visionset.batch_id"] == str(batch)
    assert run.tags["visionset.connection_id"] == str(connection)
    assert run.tags["visionset.annotation_job_id"] == str(annotation_job)
    assert run.tags["visionset.attempt"] == "2"
    assert run.params == {
        "minimum_confidence": 0.35,
        "replace_model_labels": True,
        "requested_geometries": "bbox,polygon",
        "model_id": "IDEA-Research/grounding-dino-tiny",
        "model_revision": "a" * 40,
    }
    assert {k: v for k, v in run.metrics.items() if k != "duration_seconds"} == {
        "processed_count": 3.0,
        "total_count": 4.0,
        "failures_count": 0.0,
        "assets_skipped_count": 1.0,
        "regions_discarded_count": 0.0,
        "regions_out_of_bounds_count": 2.0,
        "annotations_written_count": 21.0,
        "annotations_replaced_count": 5.0,
    }


ADVERSARIAL: dict[str, Any] = {
    "annotation_job_id": "../../etc/passwd",
    "batch_id": SECRET,
    "connection_id": {"url": SECRET},
    "minimum_confidence": "0.5; DROP TABLE",
    "replace_model_labels": "true",
    "geometries": ["bbox", SECRET],
    "image": "data:image/png;base64,AAAA",
    "labels": ["cat", "dog"],
    "endpoint": SECRET,
    "token": "hunter2",
}


@pytest.mark.parametrize(
    "model_ref",
    [
        SECRET,
        "/models/local/weights@" + "a" * 40,
        "https://mlflow.example/model@" + "a" * 40,
        "org/name@main",
        "org/name/extra@" + "a" * 40,
        "../org@" + "a" * 40,
        None,
        7,
    ],
)
def test_adversarial_payloads_and_results_send_nothing_outside_the_allowlist(
    workspace: WorkspaceService, tracker: FakeTracker, model_ref: Any
) -> None:
    payload = {
        **ADVERSARIAL,
        "result": {
            "model_ref": model_ref,
            "assets_skipped": True,
            "regions_discarded": -1,
            "regions_out_of_bounds": "3",
            "annotations_written": 2.5,
            "annotations_replaced": None,
            "masks": [[0, 1], [1, 0]],
            "export_path": SECRET,
        },
    }
    job = workspace.job_queue.enqueue(BackgroundJobSpec(type=TYPE, payload=payload))
    workspace.job_queue.claim("test")

    execute(PRE_LABEL_REF, workspace.root, job.id, payload, 0, _attempt())

    assert _tracking.flush(10)
    [run] = tracker.runs.values()
    assert set(run.tags) <= ALLOWED_TAGS
    assert set(run.params) <= ALLOWED_PARAMS
    assert set(run.metrics) <= ALLOWED_METRICS
    assert run.params == {}
    assert not {
        "visionset.batch_id",
        "visionset.connection_id",
        "visionset.annotation_job_id",
    } & set(run.tags)
    assert set(run.metrics) == {
        "duration_seconds",
        "processed_count",
        "total_count",
        "failures_count",
    }
    sent = everything_sent(tracker)
    for leaked in ("secret", "hunter2", "passwd", "base64", "mlflow.example", "cat", "DROP"):
        assert leaked not in sent


def test_a_non_pre_label_job_sends_no_pre_label_parameters_or_counts() -> None:
    payload: dict[str, Any] = {"minimum_confidence": 0.5, "replace_model_labels": True}
    result: dict[str, Any] = {"annotations_written": 4, "model_ref": "org/m@" + "a" * 40}

    assert attempt_params(TYPE, payload) == {}
    assert result_params(TYPE, result) == {}
    assert outcome_metrics(TYPE, result, processed=0, total=None, failures=0) == {}


@pytest.mark.parametrize("confidence", [-0.1, 1.5, float("nan"), float("inf"), True, None])
def test_an_out_of_range_confidence_is_omitted(confidence: Any) -> None:
    assert "minimum_confidence" not in attempt_params(
        PRE_LABEL_JOB_TYPE, {"minimum_confidence": confidence}
    )


def test_an_unknown_total_and_an_impossible_total_are_omitted() -> None:
    assert outcome_metrics(TYPE, {}, processed=5, total=None, failures=1) == {
        "processed_count": 5.0,
        "failures_count": 1.0,
    }
    assert "total_count" not in outcome_metrics(TYPE, {}, processed=5, total=4, failures=0)


def test_the_tags_never_carry_a_job_type_or_version_of_unexpected_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(_tracking, "__version__", SECRET)

    tags = attempt_tags(_attempt(job_type=SECRET), {})

    assert "visionset.job_type" not in tags
    assert "visionset.version" not in tags


def test_a_job_type_of_unexpected_shape_does_not_name_the_run(
    workspace: WorkspaceService, tracker: FakeTracker
) -> None:
    job = queued(workspace)
    workspace.job_queue.claim("test")
    ref = HandlerRef(type=SECRET, func=f"{__name__}:handler")

    execute(ref, workspace.root, job.id, {}, 0, _attempt(job_type=SECRET))

    assert _tracking.flush(10)
    [run] = tracker.runs.values()
    assert run.name == "background_job"
    assert "secret" not in everything_sent(tracker)


def test_concurrent_attempts_in_one_process_never_write_into_each_others_runs(
    workspace: WorkspaceService, tracker: FakeTracker
) -> None:
    """Threads stand in for anything sharing one process and one tracker: every
    call names its run, so there is no active run for two attempts to share."""
    jobs = [queued(workspace, silent=True, refuse=index % 2 == 1) for index in range(8)]
    attempts = {
        job.id: _attempt(job_type=TYPE).model_copy(update={"job_id": job.id}) for job in jobs
    }
    ref = HandlerRef(type=TYPE, func=f"{__name__}:handler")
    start = threading.Barrier(len(jobs))

    def one(job: Any) -> None:
        start.wait(timeout=10)
        with contextlib.suppress(BatchNotFound):
            execute(ref, workspace.root, job.id, dict(job.payload), 0, attempts[job.id])

    threads = [threading.Thread(target=one, args=(job,)) for job in jobs]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert _tracking.flush(10)
    assert len(tracker.runs) == len(jobs)
    for job in jobs:
        [run] = [r for r in tracker.runs.values() if r.tags["visionset.job_id"] == str(job.id)]
        assert run.tags["visionset.execution_id"] == str(attempts[job.id].execution_id)
        assert run.ends == 1
        expected = RunStatus.FAILED if job.payload["refuse"] else RunStatus.FINISHED
        assert run.status is expected
        assert ("visionset.error_class" in run.tags) is bool(job.payload["refuse"])


def test_failure_tags_name_the_class_and_code_and_never_the_message() -> None:
    assert failure_tags(BatchNotFound(SECRET)) == {
        "visionset.error_class": "BatchNotFound",
        "visionset.error_code": "BATCH_NOT_FOUND",
    }
    weird = type("Not a class name; " + SECRET, (Exception,), {})
    assert failure_tags(weird(SECRET)) == {}
