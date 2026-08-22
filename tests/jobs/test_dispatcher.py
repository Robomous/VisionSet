"""The dispatcher: what it claims, how it settles, and what it announces.

Driven with an **inline executor** rather than the real pool, which is the seam
`JobRunner` takes an `executor_factory` for. The pool itself has one test —
`test_process_pool.py` — because a seam that is never exercised is a seam that
has drifted; everything else is about the dispatcher's own logic, and paying
`spawn`'s interpreter startup per assertion would buy nothing.

No threads either: `drain()` is the synchronous face of the claim loop, so the
line after it can assert on the row.
"""

from __future__ import annotations

from collections.abc import Iterator
from concurrent.futures import Executor, Future
from pathlib import Path
from typing import Any

import pytest

from visionset.jobs import HandlerRef, JobRunner, register
from visionset.jobs.runner import ORPHAN_REASON
from visionset.kernel.domain import (
    BackgroundJobFailed,
    BackgroundJobSpec,
    BackgroundJobState,
    BackgroundJobSucceeded,
    DomainEvent,
)
from visionset.kernel.errors import BatchNotFound
from visionset.kernel.services import WorkspaceService

#: What the handler below was asked to do, per job id. A module global because a
#: handler is resolved by import string and cannot be a closure — which is the
#: same constraint production is under, so the test double shares it.
CALLS: list[dict[str, Any]] = []


def spy(workspace_root: Path, payload: dict[str, Any], reporter: Any) -> dict[str, Any]:
    """A handler with the real signature, recording what it was handed."""
    CALLS.append({"root": workspace_root, "payload": payload})
    if payload.get("explode"):
        raise RuntimeError("the handler said no")
    if payload.get("refuse"):
        raise BatchNotFound("no batch called that")
    if payload.get("check_cancel") and reporter.is_cancelled():
        return {}
    reporter.report(processed=2, total=2)
    return {"echo": payload.get("echo", "")}


SPY_TYPE = "test.spy"
register(HandlerRef(type=SPY_TYPE, func=f"{__name__}:spy", idempotent=True))


class InlineExecutor(Executor):
    """Runs now, on this thread, capturing an exception on the future like a pool does."""

    def submit(  # type: ignore[override]
        self, fn: Any, /, *args: Any, **kwargs: Any
    ) -> Future[Any]:
        future: Future[Any] = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:  # noqa: BLE001 — mirrors a real pool
            future.set_exception(exc)
        return future


@pytest.fixture(autouse=True)
def _no_leftover_calls() -> Iterator[None]:
    CALLS.clear()
    yield
    CALLS.clear()


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws")
    yield made
    made.close()


@pytest.fixture()
def events(workspace: WorkspaceService) -> list[DomainEvent]:
    seen: list[DomainEvent] = []
    workspace.event_bus.subscribe(DomainEvent, seen.append)
    return seen


@pytest.fixture()
def runner(workspace: WorkspaceService) -> JobRunner:
    return JobRunner(
        workspace.job_queue,
        workspace.root,
        event_bus=workspace.event_bus,
        workers=1,
        progress_min_interval_s=0,
        executor_factory=lambda _: InlineExecutor(),
    )


def queued(workspace: WorkspaceService, **payload: Any) -> Any:
    return workspace.job_queue.enqueue(
        BackgroundJobSpec(type=SPY_TYPE, payload=payload, idempotent=True)
    )


# --- what a run does ---------------------------------------------------------


def test_a_drained_job_reaches_its_handler_with_the_root_and_the_payload(
    workspace: WorkspaceService, runner: JobRunner
) -> None:
    """The handler contract, end to end: a path and plain data, never a service."""
    queued(workspace, echo="hello")

    assert runner.drain() == 1

    assert [{"root": workspace.root, "payload": {"echo": "hello"}}] == CALLS


def test_a_successful_run_settles_with_the_handlers_result(
    workspace: WorkspaceService, runner: JobRunner
) -> None:
    job = queued(workspace, echo="hello")

    runner.drain()

    stored = workspace.job_queue.get(job.id)
    assert stored is not None
    assert stored.state is BackgroundJobState.SUCCEEDED
    assert stored.result == {"echo": "hello"}
    assert stored.processed == 2
    assert stored.finished_at is not None


def test_a_handler_that_raises_fails_the_job_and_carries_its_words(
    workspace: WorkspaceService, runner: JobRunner
) -> None:
    """The exception travels back on the future — the same path a dead worker takes."""
    job = queued(workspace, explode=True)

    runner.drain()

    stored = workspace.job_queue.get(job.id)
    assert stored is not None
    assert stored.state is BackgroundJobState.FAILED
    assert stored.error == "the handler said no"


def test_a_declared_error_settles_under_the_code_the_runner_was_handed(
    workspace: WorkspaceService,
) -> None:
    runner = JobRunner(
        workspace.job_queue,
        workspace.root,
        workers=1,
        progress_min_interval_s=0,
        executor_factory=lambda _: InlineExecutor(),
        error_code=lambda exc: "BATCH_NOT_FOUND" if isinstance(exc, BatchNotFound) else None,
    )
    refused = queued(workspace, refuse=True)
    exploded = queued(workspace, explode=True)

    runner.drain()

    for job_id, expected in ((refused.id, "BATCH_NOT_FOUND"), (exploded.id, None)):
        stored = workspace.job_queue.get(job_id)
        assert stored is not None
        assert (stored.state, stored.error_code) == (BackgroundJobState.FAILED, expected)


def test_a_runner_handed_no_namer_settles_a_failure_with_no_code(
    workspace: WorkspaceService, runner: JobRunner
) -> None:
    job = queued(workspace, refuse=True)

    runner.drain()

    stored = workspace.job_queue.get(job.id)
    assert stored is not None
    assert (stored.state, stored.error, stored.error_code) == (
        BackgroundJobState.FAILED,
        "no batch called that",
        None,
    )


def test_a_job_nothing_can_run_is_failed_without_reaching_a_worker(
    workspace: WorkspaceService, runner: JobRunner
) -> None:
    """Settled by the dispatcher, because an interpreter startup would reach the same answer."""
    job = workspace.job_queue.enqueue(BackgroundJobSpec(type="nothing.runs.this"))

    runner.drain()

    stored = workspace.job_queue.get(job.id)
    assert stored is not None
    assert stored.state is BackgroundJobState.FAILED
    assert "no handler is registered" in (stored.error or "")
    assert CALLS == []


def test_a_run_that_observes_a_cancel_settles_cancelled_rather_than_succeeded(
    workspace: WorkspaceService, runner: JobRunner
) -> None:
    """Returning normally after `is_cancelled()` is what marks a run cancelled.

    Raising would be a failure like any other; this is the distinction that lets a
    list tell "somebody stopped it" from "it broke".
    """
    job = queued(workspace, check_cancel=True)
    workspace.job_queue.request_cancel(job.id)

    runner.drain()

    stored = workspace.job_queue.get(job.id)
    assert stored is not None
    assert stored.state is BackgroundJobState.CANCELLED


def test_draining_takes_everything_queued(workspace: WorkspaceService, runner: JobRunner) -> None:
    for n in range(3):
        queued(workspace, echo=str(n))

    assert runner.drain() == 3
    assert len(CALLS) == 3
    assert workspace.job_queue.list(states=[BackgroundJobState.QUEUED]) == []


def test_draining_an_empty_queue_takes_nothing_and_returns(runner: JobRunner) -> None:
    assert runner.drain() == 0


# --- what it announces -------------------------------------------------------


def test_a_success_is_announced_on_the_api_processs_bus(
    workspace: WorkspaceService, runner: JobRunner, events: list[DomainEvent]
) -> None:
    """The dispatcher announces, not the handler — a worker's bus has no subscribers."""
    job = queued(workspace, echo="hi")

    runner.drain()

    (announced,) = [one for one in events if isinstance(one, BackgroundJobSucceeded)]
    assert announced.job_id == job.id
    assert announced.job_type == SPY_TYPE
    assert announced.result == {"echo": "hi"}


def test_a_failure_is_announced_with_its_reason(
    workspace: WorkspaceService, runner: JobRunner, events: list[DomainEvent]
) -> None:
    job = queued(workspace, explode=True)

    runner.drain()

    (announced,) = [one for one in events if isinstance(one, BackgroundJobFailed)]
    assert announced.job_id == job.id
    assert announced.error == "the handler said no"
    assert announced.attempt == 1


def test_a_cancellation_announces_nothing(
    workspace: WorkspaceService, runner: JobRunner, events: list[DomainEvent]
) -> None:
    """A cancellation is something a person just did through an API that answered them."""
    job = queued(workspace, check_cancel=True)
    workspace.job_queue.request_cancel(job.id)

    runner.drain()

    assert [one for one in events if one.name.startswith("background_job")] == []


# --- starting and stopping ---------------------------------------------------


def test_starting_sweeps_a_row_left_running_by_a_previous_process(
    workspace: WorkspaceService, runner: JobRunner
) -> None:
    """Exact, because this process has started nothing — see `sweep_orphans`."""
    orphan = queued(workspace)
    workspace.job_queue.claim("a-process-that-is-gone")

    runner.start()
    try:
        stored = workspace.job_queue.get(orphan.id)
        assert stored is not None
        assert stored.state is BackgroundJobState.FAILED
        assert stored.error == ORPHAN_REASON
    finally:
        runner.stop(timeout=10)


def test_the_sweep_re_queues_the_orphan_as_a_new_job(
    workspace: WorkspaceService, runner: JobRunner
) -> None:
    """A retry is a new row — see `BACKGROUND_JOB_TRANSITIONS` for why never the same one.

    **`start()` is deliberately not called here.** It sweeps *and* starts a
    dispatcher thread, which would claim the replacement within one poll interval
    — so an assertion on "there is a queued replacement" would be racing the very
    thing it arranged, and would pass or fail on how loaded the machine is. The
    sweep is the subject, so the sweep is what this calls.
    """
    orphan = queued(workspace, echo="again")
    workspace.job_queue.claim("gone")

    workspace.job_queue.sweep_orphans(reason=ORPHAN_REASON)

    replacement = workspace.job_queue.list(states=[BackgroundJobState.QUEUED])
    assert len(replacement) == 1
    assert replacement[0].id != orphan.id

    # And it is genuinely runnable rather than merely present.
    assert runner.drain() == 1
    settled = workspace.job_queue.get(replacement[0].id)
    assert settled is not None
    assert settled.state is BackgroundJobState.SUCCEEDED


def test_stopping_a_runner_that_never_started_is_safe(runner: JobRunner) -> None:
    runner.stop(timeout=10)

    assert not runner.running
