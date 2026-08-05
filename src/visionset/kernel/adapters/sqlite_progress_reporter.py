# usage: from visionset.kernel.adapters import SqliteProgressReporter
"""Default ProgressReporter adapter: one job row, written from inside the worker.

**Throttled, and the throttle is the point rather than an optimisation.** The
precedent it departs from is deliberate: ``IngestService._record_progress`` writes
after *every* item and argues, correctly for its own case, that a cadence constant
suiting five files and one suiting fifty thousand are not the same number. That
argument held while exactly one thread ever wrote. This reporter runs in a worker
process beside a pool that may hold others, against a store with one writer — so
an unthrottled write per item multiplies the contention window by the pool size,
and the thing it contends with is the work itself.

So the trade is stated rather than hidden: a poller may be up to one interval
behind, and in exchange the writes a run makes are bounded by its *duration*
instead of by its item count. The final numbers never depend on the throttle —
``JobQueue.finish`` takes them off the outcome, precisely because the last item's
write is the one most likely to be swallowed.

**A cancellation is read on the same clock**, for the same reason and one more: a
handler asks between every pair of items, and a database read per item would be
the read-side twin of the write this module exists to avoid.

**Nothing here raises for a job that has vanished.** A row deleted underneath a
run leaves the work still worth doing — the rule ``_record_progress`` states, kept.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Sequence
from typing import Final
from uuid import UUID

from visionset.kernel.domain import ItemFailure
from visionset.kernel.errors import VisionSetError
from visionset.kernel.ports.metadata_store import MetadataStore

_logger: Final = logging.getLogger(__name__)

#: How often a run may touch its row, in seconds.
#:
#: Half a second, matched to the frontend's own ``DEFAULT_POLL_MS`` of two
#: seconds: four writes per poll is already more resolution than a progress bar
#: can show, and going finer buys pixels nobody sees at the cost of commits that
#: compete with the work.
DEFAULT_MIN_INTERVAL_S: Final = 0.5


class SqliteProgressReporter:
    """Writes progress for one job, no more often than its interval allows.

    ``clock`` is injected so a test can drive the throttle without sleeping —
    the discipline ``tests/kernel/test_concurrency.py`` set for waiting on
    anything. It defaults to :func:`time.monotonic` rather than wall time,
    because a clock that can step backwards would silently disable the throttle.
    """

    def __init__(
        self,
        store: MetadataStore,
        job_id: UUID,
        *,
        min_interval_s: float = DEFAULT_MIN_INTERVAL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._store = store
        self._job_id = job_id
        self._min_interval_s = min_interval_s
        self._clock = clock
        #: ``None``, not ``0``, so the *first* report always lands. A run whose
        #: first item takes a minute should say "0 of 900" immediately rather
        #: than look queued for a minute.
        self._last_write: float | None = None
        self._last_cancel_read: float | None = None
        self._cancelled = False

    def report(
        self,
        *,
        processed: int,
        total: int | None = None,
        failures: Sequence[ItemFailure] = (),
    ) -> None:
        if not self._due(self._last_write):
            return
        self._last_write = self._clock()
        self._write(processed=processed, total=total, failures=tuple(failures))

    def is_cancelled(self) -> bool:
        """Whether a cancel has been requested, re-read at most once per interval.

        Sticky: once this has answered ``True`` it never goes back, because a
        handler may ask again while unwinding and a cancel that could be revoked
        mid-unwind is a state nobody can reason about. The wire has no
        un-cancel either.
        """
        if self._cancelled:
            return True
        if not self._due(self._last_cancel_read):
            return False
        self._last_cancel_read = self._clock()
        try:
            with self._store.unit_of_work() as uow:
                job = uow.jobs.get(self._job_id)
        except VisionSetError:
            # Contention or a damaged store. "Not cancelled" is the answer that
            # lets the work carry on, and the work is what matters here — the
            # write path below makes the same call for the same reason.
            _logger.debug("could not read the cancel flag for job %s", self._job_id)
            return False
        if job is None:
            return False
        self._cancelled = job.cancel_requested
        return self._cancelled

    def _due(self, last: float | None) -> bool:
        return last is None or (self._clock() - last) >= self._min_interval_s

    def _write(
        self, *, processed: int, total: int | None, failures: tuple[ItemFailure, ...]
    ) -> None:
        try:
            with self._store.unit_of_work() as uow:
                job = uow.jobs.get(self._job_id)
                if job is None:
                    return
                uow.jobs.update(
                    job.model_copy(
                        update={
                            "processed": processed,
                            # ``None`` says nothing about a total an earlier call
                            # established, rather than clearing it — the port's
                            # rule, and the reason this is not a plain assignment.
                            "total": job.total if total is None else total,
                            "failures": failures,
                        }
                    )
                )
        except VisionSetError:
            # A progress write is a courtesy to a poller. Losing one to a busy
            # store must never lose the run, so this is logged and swallowed —
            # and the final numbers come off the outcome regardless.
            _logger.debug("could not write progress for job %s", self._job_id)
