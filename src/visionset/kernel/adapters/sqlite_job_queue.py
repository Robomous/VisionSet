# usage: from visionset.kernel.adapters import SqliteJobQueue
"""Default JobQueue adapter: a table in the workspace's own SQLite file.

**Same database as everything else, and that is the decision worth defending.** A
second file would mean a second family of WAL sidecars to enumerate in
``DB_SIDECAR_FILENAMES``, a second thing to copy when somebody backs a workspace
up, and a second place for ``format_version`` to be wrong. What it would buy is
relief from write contention between the dispatcher's poll and the work — and the
poll is a *read*, which WAL already makes free of the writer. So the cost is real
and the benefit is not.

**It holds a ``MetadataStore``, never an engine.** Every write here goes through
``unit_of_work()``, which is what makes ``WorkspaceBusy`` and ``ConstraintViolated``
arrive already translated: a queue that reached for the engine would have to catch
SQLAlchemy's exceptions itself, which is exactly the leak
``sqlite_metadata_store`` exists to prevent.

**Transitions go through the table, never through an ``if``.**
``BACKGROUND_JOB_TRANSITIONS`` in ``domain/job.py`` is the whole of what is legal
and ``require_move`` is how it is consulted, so this module restates none of it —
the rule ``IngestService`` follows for ingest runs and ``BatchService`` for
batches.
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import UTC, datetime
from uuid import UUID

from visionset.kernel.domain import (
    BACKGROUND_JOB_TRANSITIONS,
    BackgroundJob,
    BackgroundJobOutcome,
    BackgroundJobSpec,
    BackgroundJobState,
    require_move,
)
from visionset.kernel.errors import BackgroundJobNotFound
from visionset.kernel.ports.metadata_store import MetadataStore


def _subject(job_id: UUID) -> str:
    """How a refused move names the job. One spelling, so refusals read alike."""
    return f"job {job_id}"


class SqliteJobQueue:
    """The ``JobQueue`` port over the workspace's metadata store.

    One constructor argument, so the bare class reference satisfies
    ``JobQueueFactory`` and ``WorkspaceService`` can default to it the way it
    defaults to every other adapter.

    **It knows nothing about handlers, and cannot.** Resolving a job type to code
    means reading ``visionset.jobs``, which import-linter forbids the kernel from
    importing — the same wall that keeps ``ReleaseService.export`` taking an
    ``Exporter`` instance rather than a format name. So ``UnknownJobType`` is
    raised by the registry, at the two places that hold one: the surface that
    builds a spec, and the dispatcher that picks a row up. See
    ``visionset/jobs/registry.py``.
    """

    def __init__(self, store: MetadataStore) -> None:
        self._store = store

    def enqueue(self, spec: BackgroundJobSpec) -> BackgroundJob:
        """Write the row, ``queued``, and hand it back."""
        with self._store.unit_of_work() as uow:
            return uow.jobs.add(
                BackgroundJob(
                    type=spec.type,
                    payload=dict(spec.payload),
                    idempotent=spec.idempotent,
                )
            )

    def get(self, job_id: UUID) -> BackgroundJob | None:
        with self._store.unit_of_work() as uow:
            return uow.jobs.get(job_id)

    def claim(self, worker: str) -> BackgroundJob | None:
        """Delegate to the store's guarded ``UPDATE``. See ``claim_job``."""
        with self._store.unit_of_work() as uow:
            return uow.claim_job(worker=worker, now=datetime.now(UTC))

    def finish(self, job_id: UUID, outcome: BackgroundJobOutcome) -> BackgroundJob:
        """Settle a running job, refusing anything the table does not allow.

        ``processed`` and ``failures`` come off the outcome rather than being left
        as the reporter last wrote them, because a throttled reporter may never
        have published the final numbers — the last item's progress write is the
        one most likely to be swallowed by the interval, and it is the one a
        finished job is read for.
        """
        with self._store.unit_of_work() as uow:
            job = self._require(uow.jobs.get(job_id), job_id)
            require_move(BACKGROUND_JOB_TRANSITIONS, job.state, outcome.state, _subject(job_id))
            return uow.jobs.update(
                job.model_copy(
                    update={
                        "state": outcome.state,
                        "error": outcome.error,
                        "result": dict(outcome.result),
                        "processed": outcome.processed,
                        "total": outcome.total if outcome.total is not None else job.total,
                        "failures": outcome.failures,
                        "finished_at": datetime.now(UTC),
                    }
                )
            )

    def request_cancel(self, job_id: UUID) -> BackgroundJob:
        """Settle a queued job; flag a running one; leave a settled one alone.

        The three branches are the port's contract rather than a convenience, and
        the middle one is why this cannot be a plain state change: a running
        handler owns the only safe places to stop, so all this can do is say so.
        """
        with self._store.unit_of_work() as uow:
            job = self._require(uow.jobs.get(job_id), job_id)
            if job.settled:
                return job
            if job.state is BackgroundJobState.QUEUED:
                return uow.jobs.update(
                    job.model_copy(
                        update={
                            "state": BackgroundJobState.CANCELLED,
                            "cancel_requested": True,
                            "finished_at": datetime.now(UTC),
                        }
                    )
                )
            return uow.jobs.update(job.model_copy(update={"cancel_requested": True}))

    def sweep_orphans(self, *, reason: str) -> list[BackgroundJob]:
        """Fail every ``running`` row, and re-queue the idempotent ones as new jobs.

        Exact rather than heuristic — see the port for the deployment fact that
        licenses it. The re-enqueue is a fresh row on purpose: a retry is never
        the same row, so a list of jobs shows the crash *and* the recovery instead
        of one line that quietly changed its mind.

        Everything happens in one transaction. A sweep that failed halfway would
        leave a workspace where some orphans had been retried and others were
        still claiming to run, which is worse than not having swept at all.
        """
        settled: list[BackgroundJob] = []
        with self._store.unit_of_work() as uow:
            for job in uow.jobs.list():
                if job.state is not BackgroundJobState.RUNNING:
                    continue
                settled.append(
                    uow.jobs.update(
                        job.model_copy(
                            update={
                                "state": BackgroundJobState.FAILED,
                                "error": reason,
                                "finished_at": datetime.now(UTC),
                            }
                        )
                    )
                )
                if job.idempotent:
                    uow.jobs.add(BackgroundJob(type=job.type, payload=job.payload, idempotent=True))
        return settled

    @staticmethod
    def _require(job: BackgroundJob | None, job_id: UUID) -> BackgroundJob:
        if job is None:
            raise BackgroundJobNotFound(f"no background job {job_id} in this workspace")
        return job

    # ``list`` shadows the builtin for every annotation after it in a class body,
    # so it is declared last. See ``BatchService`` for the precedent.

    def list(self, *, states: Collection[BackgroundJobState] | None = None) -> list[BackgroundJob]:
        """Newest first, optionally narrowed — the opposite order to ``claim``.

        Sorted here rather than in SQL because ``Repository.list`` returns
        insertion order and widening the port for one caller's ordering would put
        a query language in it. The row count is bounded by how much work a
        workspace has ever queued, which is the same order of magnitude as its
        ingest runs.

        **The key is ``created_at`` alone, and that is load-bearing.** Python's
        sort is stable and the input is in insertion order, so two jobs sharing a
        microsecond — which two enqueued by one request handler will — come back
        in reverse insertion order rather than in whatever order their ids happen
        to compare. Adding the id as a tie-break would *remove* that property.
        """
        wanted = None if states is None else frozenset(states)
        with self._store.unit_of_work() as uow:
            found = uow.jobs.list()
        if wanted is not None:
            found = [job for job in found if job.state in wanted]
        return sorted(found, key=lambda job: job.created_at, reverse=True)
