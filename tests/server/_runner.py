"""Ingest runners a test can control, instead of polling with sleeps.

`tests/kernel/test_concurrency.py` set the discipline these follow: sequence on
`threading.Event`, never on a sleep; join with a timeout and then assert the
thread is actually dead. A test that waits by sleeping is a test that is slow
when it passes and flaky when it does not.

Plain functions in a private module, the `_probe.py` / `_api.py` precedent —
there is still no `conftest.py` anywhere.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from concurrent.futures import Future

from visionset.server.runner import IngestRunner

#: Long enough that a loaded CI runner does not trip it, short enough that a
#: genuine deadlock fails the suite rather than hanging it.
JOIN_TIMEOUT = 30.0


class RecordingRunner(IngestRunner):
    """The real runner, keeping every future so a test can join on the work."""

    def __init__(self) -> None:
        super().__init__()
        self.futures: list[Future[object]] = []

    def submit(self, run: Callable[[], object]) -> Future[object]:
        future = super().submit(run)
        self.futures.append(future)
        return future

    def wait(self) -> None:
        """Block until every submitted run has finished."""
        for future in self.futures:
            future.result(timeout=JOIN_TIMEOUT)


class GatedRunner(RecordingRunner):
    """A runner that parks before the work, so "launched" can be observed.

    `entered` is set once the worker has picked the job up and `release` is what
    lets it proceed — which is how a test asserts the job row is already
    readable while the run has not started. Nothing here touches the kernel: the
    gate is around the submitted callable, not inside it.
    """

    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def submit(self, run: Callable[[], object]) -> Future[object]:
        def gated() -> object:
            self.entered.set()
            assert self.release.wait(timeout=JOIN_TIMEOUT), "the test never released the worker"
            return run()

        return super().submit(gated)
