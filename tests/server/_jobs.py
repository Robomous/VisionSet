"""Dispatchers a test can control, instead of polling a real pool with sleeps.

Replaces `_runner.py`, which held the same two shapes over the old
`IngestRunner`. What changed is where the seam is: work is now claimed off a
durable queue and run in a process, so a test double replaces the *dispatcher*
rather than a thread pool — and the useful thing it does is run everything on the
calling thread.

`tests/kernel/test_concurrency.py` set the discipline these keep: never a sleep,
join with a timeout, then assert the thread is dead. Neither class here starts a
thread at all, which is the point. A test that waits is slow when it passes and
flaky when it does not.

**They are duck-typed, not subclasses of `DispatcherHandle`.** That class's whole
job is to resolve a workspace and build a real `JobRunner` in `start()`, which is
exactly the behaviour being replaced. What matters is the three methods the
lifespan and the routes call: `start`, `wake`, `stop`.

**They bind to the application's workspace handle rather than taking a
workspace**, for the reason `DispatcherHandle` does: a test constructs one before
`served_app` has decided which workspace the application serves, and a dispatcher
holding the wrong one would claim from a database nothing writes to.

Plain classes in a private module, the `_probe.py` / `_api.py` precedent — there
is still no `conftest.py` anywhere.
"""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import Executor, Future
from typing import Any

from visionset.jobs import JobRunner
from visionset.server.dependencies import WorkspaceHandle

#: Long enough that a loaded CI runner does not trip it, short enough that a
#: genuine deadlock fails the suite rather than hanging it.
JOIN_TIMEOUT = 30.0


class InlineExecutor(Executor):
    """Runs the callable now, on this thread, and returns a finished future.

    The `Executor` contract with the concurrency taken out. It is what keeps the
    dispatcher's own logic — claiming, settling, cancelling, announcing —
    testable without paying `spawn`'s interpreter startup per assertion, and
    without every test handler having to be importable in a child.

    An exception is captured **on the future** rather than raised here, because
    that is what a real pool does and it is the path `JobRunner._record` turns
    into a failed job. A double that raised instead would leave that branch
    untested while looking like it covered it.
    """

    def submit(  # type: ignore[override]
        self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any
    ) -> Future[Any]:
        future: Future[Any] = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:  # noqa: BLE001 — mirrors a real pool
            future.set_exception(exc)
        return future


class ManualDispatcher:
    """A dispatcher that runs nothing until a test says so.

    The double for asserting *launched, but not yet run* — the state the old
    `GatedRunner` parked a thread to observe, available here by simply not
    calling `run()`.
    """

    def __init__(self) -> None:
        self._handle: WorkspaceHandle | None = None
        self._runner: JobRunner | None = None
        #: Every `wake()` a route made, so a test can assert that a launch nudged
        #: the dispatcher rather than relying on a poll no test ever waits for.
        self.wakes = 0
        self.started = False
        self.stopped = False

    def bind(self, handle: WorkspaceHandle) -> None:
        """Point this at the application's workspace. Called by `served_app`."""
        self._handle = handle

    # --- the three methods the application calls ---------------------------

    def start(self) -> None:
        self.started = True

    def wake(self) -> None:
        self.wakes += 1

    def stop(self) -> None:
        self.stopped = True

    # --- what a test calls -------------------------------------------------

    def run(self) -> int:
        """Claim and run everything queued. Returns how many jobs it took.

        Synchronous to its last write: `JobRunner.drain` only returns once every
        job it dispatched has settled, so the line after this can assert on the
        row.
        """
        return self._make().drain()

    def wait(self) -> None:
        """Kept for the readers of tests that used to join a thread pool.

        A `run()` here and a no-op on `InlineDispatcher`, where the work has
        already happened by the time a launch responds. Both spellings say "the
        work is done now", which is what those call sites meant.
        """
        self.run()

    def _make(self) -> JobRunner:
        if self._runner is None:
            assert self._handle is not None, "the dispatcher was never bound to a workspace"
            workspace = self._handle.get()
            self._runner = JobRunner(
                workspace.job_queue,
                workspace.root,
                event_bus=workspace.event_bus,
                workers=1,
                # Zero, so every `report` writes: a throttle would make an
                # assertion about progress depend on how fast the test ran.
                progress_min_interval_s=0,
                executor_factory=lambda _: InlineExecutor(),
            )
        return self._runner


class InlineDispatcher(ManualDispatcher):
    """The same, but a launch runs its job before the request returns.

    The default for a test that cares about the *outcome* rather than about the
    202. It makes a launch synchronous from the client's point of view, which is
    a lie about production and the right one to tell here — the alternative is
    polling a real pool, and every such test would become the slowest in the
    suite.
    """

    def wake(self) -> None:
        self.wakes += 1
        self.run()

    def wait(self) -> None:
        """Already done. See the base class for why the name survives."""
