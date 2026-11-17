# usage: from visionset.mcp._progress import Progress, PreLabelProgress
"""Progress notifications for a tool call that blocks for minutes.

Every tool body is a sync function MCPServer runs on a worker thread, and the
kernel reports progress through a plain callback - from that thread, or from
one of its own (the weights sampler). ``Context.report_progress`` is a
coroutine on the event loop, so :class:`Progress` is the one bridge between the
two: ``anyio.from_thread.run`` onto the loop, with the loop's token read on the
tool's worker thread so that any thread can send.

**A notification never fails the call.** The run commits asset by asset, so a
client that went away mid-run must not turn work already written into an error
envelope. The first failed send is logged with its traceback and the rest are
dropped, rather than raising into the kernel's loop or retrying a dead stream.

A client that sent no ``progressToken`` gets nothing: the SDK's own
``report_progress`` is a no-op then, and with no ``Context`` at all (a body
called directly from Python) this is too.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any, Final

import anyio.from_thread
import anyio.lowlevel
from mcp.server.mcpserver import Context

from visionset.inference import PreLabelPlan

_logger = logging.getLogger(__name__)

INTERVAL: Final = 1.0
"""Seconds between two notifications; the last one is always sent."""


class Progress:
    """Throttled, monotonic progress for one request, callable from any thread.

    Built on the tool's worker thread, the only place the loop's token can be read.
    """

    def __init__(self, ctx: Context[Any, Any] | None) -> None:
        self._ctx = ctx
        self._token = (
            None if ctx is None else anyio.from_thread.run_sync(anyio.lowlevel.current_token)
        )
        # Held across the send too, so two threads cannot reorder notifications.
        self._lock = threading.Lock()
        self._sent: float | None = None
        self._sent_at = float("-inf")
        self._pending: tuple[float, float | None, str] | None = None

    def __call__(self, progress: float, total: float | None, message: str) -> None:
        with self._lock:
            # The protocol requires every notification's progress to exceed the last.
            if self._ctx is None or (self._sent is not None and progress <= self._sent):
                return
            if self._pending is not None and progress < self._pending[0]:
                return
            self._pending = (progress, total, message)
            if progress == total or time.monotonic() - self._sent_at >= INTERVAL:
                self._send()

    def flush(self) -> None:
        with self._lock:
            self._send()

    def _send(self) -> None:
        if self._ctx is None or self._pending is None:
            return
        progress, total, message = self._pending
        self._pending = None
        self._sent = progress
        self._sent_at = time.monotonic()
        try:
            anyio.from_thread.run(
                self._ctx.report_progress, progress, total, message, token=self._token
            )
        except Exception:
            _logger.warning("progress notification failed; sending no more", exc_info=True)
            self._ctx = None


@contextmanager
def reporting(ctx: Context[Any, Any] | None) -> Iterator[Progress]:
    """A :class:`Progress` whose last throttled value is sent when the run succeeds."""
    progress = Progress(ctx)
    yield progress
    progress.flush()


class PreLabelProgress:
    """Assets considered across every job of a run, as one rising count.

    The kernel counts per job and only learns a job's total once its run has
    planned, so a total is published only once it is exact: on the last job,
    where ``jobs`` says which one that is, and by :meth:`finish` in every case.
    ``jobs`` is ``None`` where the kernel decides which jobs run as it reaches
    them. A job's own last count is held back unless it is the known last job,
    so :meth:`finish` always has a higher count to carry the total, even after
    a job with nothing to consider. ``plans`` keeps every job's plan in run
    order, for the caller's result.
    """

    def __init__(
        self, report: Callable[[float, float | None, str], None], jobs: int | None
    ) -> None:
        self._report = report
        self._jobs = jobs
        self._job = 0
        self._base = 0
        self._job_total = 0
        self.plans: list[PreLabelPlan] = []

    def planned(self, plan: PreLabelPlan) -> None:
        self.plans.append(plan)
        self._base += self._job_total
        self._job_total = 0
        self._job += 1

    def asset_done(self, done: int, total: int) -> None:
        self._job_total = total
        last = self._jobs is not None and self._job >= self._jobs
        if done == total and not last:
            return
        message = f"pre-labeled {done} of {total} assets"
        if self._jobs is None:
            message = f"job {self._job}: {message}"
        elif self._jobs > 1:
            message = f"job {self._job} of {self._jobs}: {message}"
        self._report(self._base + done, self._base + total if last else None, message)

    def finish(self) -> None:
        """The run succeeded, so the count it reached is the exact total."""
        reached = self._base + self._job_total
        self._report(reached, reached, f"pre-labeled {reached} of {reached} assets")
