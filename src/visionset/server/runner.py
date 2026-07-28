# usage: from visionset.server.runner import IngestRunner
"""Where a launched ingest actually runs.

Ingest is the first operation this API exposes that outlives its request, and
the pattern set here is the one #29's jobs, #33's UI and #35's tools all reuse:
**the launch returns an id, the client polls that id.** For the id to be worth
handing back, the row has to exist before the work starts — which is what
`IngestService.enqueue` is for — and the work has to happen somewhere other than
the request that asked for it. This is that somewhere.

**One worker, deliberately.** A `ThreadPoolExecutor` of size one serializes
every run against a single-writer SQLite store instead of racing them. What #80
bought — WAL, a `busy_timeout`, `OperationalError` translated to `WorkspaceBusy`
— is then the safety net for the *reader*: a client polling `GET /ingest-jobs/…`
while the worker holds a write transaction reads through WAL rather than
blocking on it. Widening this pool is a decision about the store, not a tuning
knob, so it is a constructor argument with no route able to reach it.

**A run that raises is logged here and reported on its row.** `IngestService`
has already marked the job ``failed`` and written its ``error`` by the time the
exception gets this far, so the client's answer is complete without this module;
the log is for whoever runs the server. Swallowing it here is what keeps it from
becoming an unretrieved-future warning at interpreter shutdown.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Final

_logger: Final = logging.getLogger(__name__)


class IngestRunner:
    """A single background worker, owned by one application."""

    def __init__(self, workers: int = 1) -> None:
        # Constructing an executor starts no threads — the first ``submit`` does
        # — so building one in ``create_app()`` costs an import of the module
        # nothing, which ``scripts/export_openapi.py`` depends on.
        self._executor = ThreadPoolExecutor(
            max_workers=workers, thread_name_prefix="visionset-ingest"
        )

    def submit(self, run: Callable[[], object]) -> Future[object]:
        """Hand ``run`` to the worker and return immediately.

        The future is returned rather than discarded so a test can join on it
        instead of polling with sleeps — the discipline
        ``tests/kernel/test_concurrency.py`` set. Routes ignore it: what a client
        waits on is the job row.
        """
        return self._executor.submit(self._guarded, run)

    def shutdown(self) -> None:
        """Wait for the running job and drop whatever was still queued.

        ``cancel_futures`` rather than draining: a queued run has not started,
        so cancelling it leaves its job exactly where `enqueue` put it —
        ``pending``, and resumable — while draining an arbitrary backlog would
        hold shutdown open for as long as somebody kept uploading.
        """
        self._executor.shutdown(wait=True, cancel_futures=True)

    @staticmethod
    def _guarded(run: Callable[[], object]) -> object:
        try:
            return run()
        except Exception:
            # ``BaseException`` is deliberately not caught, the rule
            # ``InProcessEventBus`` already follows.
            _logger.exception("ingest run failed; see the job's error field")
            return None
