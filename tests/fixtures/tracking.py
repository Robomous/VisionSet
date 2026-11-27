"""Shared doubles for tracking tests: an in-memory tracker and inline executors."""

from __future__ import annotations

import threading
from collections.abc import Iterator, Mapping, Sequence
from concurrent.futures import Executor, Future
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import pytest

from visionset.jobs import JobRunner, _tracking
from visionset.kernel.errors import BatchNotFound
from visionset.kernel.services import WorkspaceService
from visionset.tracking import DatasetInput, ParamValue, RunStatus, TrackingSettings

SECRET = "/home/someone/secret-dir https://user:hunter2@mlflow.example:5000"
ENABLED = TrackingSettings(mlflow_enabled=True, mlflow_experiment="visionset")


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
    datasets: list[DatasetInput] = field(default_factory=list)
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

    def log_inputs(self, run_id: str | None, datasets: Sequence[DatasetInput]) -> None:
        self._maybe_fail("inputs")
        if run_id is not None:
            self.runs[run_id].datasets.extend(datasets)

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


class CancellingExecutor(InlineExecutor):
    """Asks the job to stop before its handler runs, as a person pressing cancel would."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self.workspace = workspace

    def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:  # type: ignore[override]
        self.workspace.job_queue.request_cancel(args[2])
        return super().submit(fn, *args, **kwargs)


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


def settled(workspace: WorkspaceService, job_id: UUID) -> Any:
    assert _tracking.flush(10)
    stored = workspace.job_queue.get(job_id)
    assert stored is not None
    return stored
