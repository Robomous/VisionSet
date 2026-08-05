# usage: from visionset.jobs import JobRunner
"""The embedded dispatcher: one thread that claims, one pool that runs.

```
FastAPI process
 ├─ dispatcher thread ── claim() ── submit ── watch the future ── finish()
 └─ ProcessPoolExecutor(spawn, initializer=initialize_worker)
      each worker: logging to stderr + one open workspace per root
```

**A thread claims and a process runs, and the split is the whole design.**
Claiming is a SQLite statement measured in microseconds; running is a decode pass
over five thousand files or an exporter walking a manifest. Putting the second in
a thread is what `server/runner.py` did, and it is why this exists: CPU-bound work
in the API process competes with request handling for one GIL.

**``spawn``, pinned.** ``fork`` is disqualified rather than merely discouraged: the
metadata store keeps a live ``QueuePool`` connection, and a forked child that
inherits an open SQLite handle can corrupt the file. Pinning the context also makes
Linux behave like macOS and Windows — and like Python 3.14, where ``spawn`` becomes
the default — so the thing CI exercises is the thing a laptop runs.

**One worker by default, and that is a property of the store rather than a knob.**
`server/runner.py` argued this and was right: SQLite has one writer, and a run
writes progress as it goes. `VISIONSET_JOB_WORKERS` will take a larger number and
the contention then degrades to ``WorkspaceBusy`` — a 503 with ``Retry-After``,
which is defined behaviour — but the shipped default is one.

**Nothing is started at import, and nothing is started by construction.**
:meth:`start` is called from the application's lifespan, which is also the first
place a ``ProcessPoolExecutor`` may safely exist: building one at import time under
``spawn`` is how a child re-executes its parent's module and forks a second
application. :meth:`stop` runs in the lifespan's closing half, **before** the
workspace handle closes — the order `main.py` already documents, for the reason it
documents: a run in flight holds the workspace.
"""

from __future__ import annotations

import logging
import multiprocessing
import threading
from collections.abc import Callable
from concurrent.futures import BrokenExecutor, Executor, Future, ProcessPoolExecutor
from pathlib import Path
from typing import Final

from visionset.jobs._worker import WorkerResult, execute
from visionset.jobs.context import initialize_worker
from visionset.jobs.registry import resolve
from visionset.kernel.domain import (
    BackgroundJob,
    BackgroundJobFailed,
    BackgroundJobOutcome,
    BackgroundJobState,
    BackgroundJobSucceeded,
)
from visionset.kernel.errors import UnknownJobType, VisionSetError
from visionset.kernel.ports import EventBus, JobQueue

_logger: Final = logging.getLogger(__name__)

#: How long the dispatcher sleeps when it finds nothing to claim.
#:
#: Half a second. An enqueue nudges the thread awake, so this interval only
#: governs the case nobody is watching — a job re-queued by the orphan sweep, or a
#: wake-up that raced a claim. Long enough to be free, short enough that the
#: fallback is never the thing a person waits on.
DEFAULT_POLL_INTERVAL_S: Final = 0.5

#: The default pool size. See the module docstring: a property of the store.
DEFAULT_WORKERS: Final = 1

#: What a job's ``error`` says when the server died holding it.
ORPHAN_REASON: Final = "the server stopped while this job was running"


def _spawn_pool(workers: int) -> Executor:
    """The real executor. Its own function so a test can pass a different one."""
    return ProcessPoolExecutor(
        max_workers=workers,
        mp_context=multiprocessing.get_context("spawn"),
        initializer=initialize_worker,
    )


class JobRunner:
    """Claims queued work and runs it in a pool, for the life of one application.

    ``executor_factory`` is the seam. The default builds the ``spawn`` pool above;
    a test passes something that runs inline, which is what keeps the dispatcher's
    own logic — claiming, settling, cancelling, announcing — testable without
    paying interpreter startup for every assertion. One integration test uses the
    real pool, because a seam that is never exercised is a seam that has drifted.
    """

    def __init__(
        self,
        queue: JobQueue,
        workspace_root: Path,
        *,
        event_bus: EventBus | None = None,
        workers: int = DEFAULT_WORKERS,
        poll_interval_s: float = DEFAULT_POLL_INTERVAL_S,
        progress_min_interval_s: float = 0.5,
        executor_factory: Callable[[int], Executor] | None = None,
    ) -> None:
        self._queue = queue
        self._root = workspace_root
        self._events = event_bus
        self._workers = max(1, workers)
        self._poll_interval_s = poll_interval_s
        self._progress_min_interval_s = progress_min_interval_s
        self._executor_factory = executor_factory or _spawn_pool

        self._executor: Executor | None = None
        self._thread: threading.Thread | None = None
        self._stopping = threading.Event()
        #: Set by :meth:`wake` and by a finishing job, so the loop reacts at once
        #: instead of after an interval. Cleared at the top of every pass.
        self._nudge = threading.Event()
        #: How many jobs are in flight. A semaphore rather than a counter because
        #: the dispatcher must *block* on a full pool rather than spin: without it
        #: the loop would claim faster than the pool drains, and every claimed job
        #: would sit ``running`` in the database while queued in memory — which is
        #: precisely the state ``sweep_orphans`` cannot tell from a crash.
        self._slots = threading.Semaphore(self._workers)

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        """Sweep orphans, build the pool, and begin claiming. Idempotent.

        **The sweep happens before the first claim and before the pool exists**,
        which is what makes it exact: any row still ``running`` at this instant
        belongs to a process that is gone, because this process has not started
        one. See ``JobQueue.sweep_orphans`` for why that licenses shipping no
        lease column.
        """
        if self.running:
            return
        orphans = self._queue.sweep_orphans(reason=ORPHAN_REASON)
        if orphans:
            _logger.warning(
                "settled %d job(s) left running by a previous process", len(orphans)
            )
        self._stopping.clear()
        self._executor = self._executor_factory(self._workers)
        self._thread = threading.Thread(
            target=self._loop, name="visionset-dispatcher", daemon=True
        )
        self._thread.start()

    def wake(self) -> None:
        """Tell the dispatcher there may be work. Cheap, and safe to over-call.

        Called by whoever enqueues, so a launched job starts now rather than at
        the next poll. It is a hint and never a requirement: a runner that missed
        every nudge still drains the queue on its interval, which is what keeps
        the orphan sweep's re-enqueues from needing a caller.
        """
        self._nudge.set()

    def stop(self, *, timeout: float | None = None) -> None:
        """Stop claiming, drain what is in flight, and release the pool.

        ``wait=True``: a job already running holds the workspace, and pulling the
        store out from under it is what the lifespan's documented ordering exists
        to prevent. ``cancel_futures=True``: anything merely *queued* in the pool
        has not started, so dropping it is free — but note that it was already
        claimed, so it is ``running`` in the database and the next start's sweep
        is what settles it.
        """
        self._stopping.set()
        self._nudge.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout)
        executor, self._executor = self._executor, None
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=True)

    # --- the loop ----------------------------------------------------------

    def _loop(self) -> None:
        while not self._stopping.is_set():
            # Acquired *before* claiming, so a full pool never turns into rows
            # marked running with nothing running them.
            if not self._slots.acquire(timeout=self._poll_interval_s):
                continue
            job = None
            try:
                job = self._claim()
            finally:
                if job is None:
                    self._slots.release()
            if job is None:
                self._wait()
                continue
            self._dispatch(job)

    def _claim(self) -> BackgroundJob | None:
        if self._stopping.is_set():
            return None
        try:
            return self._queue.claim("dispatcher")
        except VisionSetError:
            # A busy or damaged store. Logged at debug because contention is
            # ordinary here — the poll runs forever — and the remedy is the next
            # pass, which is already scheduled.
            _logger.debug("could not claim a job", exc_info=True)
            return None

    def _wait(self) -> None:
        self._nudge.wait(timeout=self._poll_interval_s)
        self._nudge.clear()

    def _dispatch(self, job: BackgroundJob) -> None:
        """Submit a claimed job, or settle it here if it can never run.

        An unknown type is settled **now** rather than submitted: sending it to a
        worker would spend an interpreter startup to reach the same conclusion,
        and the traceback would come back through a future instead of as the
        sentence ``UnknownJobType`` already writes.
        """
        try:
            ref = resolve(job.type)
        except UnknownJobType as exc:
            self._settle_failure(job, str(exc))
            self._slots.release()
            return

        executor = self._executor
        if executor is None:  # stopped between the claim and here
            self._slots.release()
            return
        try:
            future = executor.submit(
                execute,
                ref,
                self._root,
                job.id,
                dict(job.payload),
                self._progress_min_interval_s,
            )
        except (BrokenExecutor, RuntimeError) as exc:
            # RuntimeError is what an already-shut-down executor raises.
            self._settle_failure(job, f"the worker pool would not accept the job: {exc}")
            self._slots.release()
            return
        future.add_done_callback(lambda done: self._settle(job, done))

    # --- settling ----------------------------------------------------------

    def _settle(self, job: BackgroundJob, future: Future[WorkerResult]) -> None:
        """Turn a resolved future into a terminal row, then free the slot.

        Runs on whichever thread the executor completes on, so it must not raise:
        an exception escaping a done-callback is swallowed by
        ``concurrent.futures`` and logged nowhere useful, and the slot would leak
        with it. Hence the outer guard and the ``finally``.
        """
        try:
            self._record(job, future)
        except Exception:  # noqa: BLE001 — see the docstring
            _logger.exception("could not settle job %s", job.id)
        finally:
            self._slots.release()
            self._nudge.set()

    def _record(self, job: BackgroundJob, future: Future[WorkerResult]) -> None:
        try:
            outcome = future.result()
        except Exception as exc:  # noqa: BLE001 — every failure is the job's
            # ``BrokenProcessPool`` lands here too, which is the whole crash story
            # for a worker killed mid-flight: the future raises, and the job is
            # failed on its own row rather than left claiming to run.
            self._settle_failure(job, str(exc) or exc.__class__.__name__)
            return

        state = (
            BackgroundJobState.CANCELLED
            if outcome.cancelled
            else BackgroundJobState.SUCCEEDED
        )
        self._finish(
            job,
            BackgroundJobOutcome(
                state=state,
                result=outcome.result,
                processed=outcome.processed,
                total=outcome.total,
                failures=outcome.failures,
            ),
        )
        if state is BackgroundJobState.SUCCEEDED:
            self._announce(
                BackgroundJobSucceeded(
                    job_id=job.id,
                    job_type=job.type,
                    processed=outcome.processed,
                    result=outcome.result,
                )
            )

    def _settle_failure(self, job: BackgroundJob, error: str) -> None:
        self._finish(
            job, BackgroundJobOutcome(state=BackgroundJobState.FAILED, error=error)
        )
        self._announce(
            BackgroundJobFailed(
                job_id=job.id, job_type=job.type, error=error, attempt=job.attempt
            )
        )

    def _finish(self, job: BackgroundJob, outcome: BackgroundJobOutcome) -> None:
        try:
            self._queue.finish(job.id, outcome)
        except VisionSetError:
            # The row was deleted, or is no longer running because a cancel
            # settled it first. Either way the work is over and there is nothing
            # left to write — losing the run over a missing receipt would be the
            # worse answer, which is the rule ``_record_progress`` already states.
            _logger.warning(
                "job %s finished as %s but its row would not take it",
                job.id,
                outcome.state,
                exc_info=True,
            )

    def _announce(self, event: BackgroundJobSucceeded | BackgroundJobFailed) -> None:
        """Publish on the API process's bus. See the events' own docstrings.

        A handler runs in a worker, where the bus is a different object with no
        subscribers — so this is the one announcement about background work that
        an API-side subscriber can actually receive. ``occurred_at`` is stamped by
        the model, and this is a moment after the row committed, which is the
        after-the-commit rule every emitter in the kernel follows.
        """
        if self._events is None:
            return
        try:
            self._events.publish(event)
        except Exception:  # noqa: BLE001
            # The bus already guarantees a subscriber cannot break an emitter, so
            # reaching here means the bus itself failed. A settled job must not be
            # unsettled by an announcement about it.
            _logger.exception("could not announce %s for job %s", event.name, event.job_id)
