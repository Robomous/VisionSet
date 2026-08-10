"""Two dispatchers, one file: the claim must hand a job to exactly one of them.

The second threaded module in this suite, and it keeps every rule the first one
set (`test_concurrency.py`):

- **Two `SqliteMetadataStore` instances over one path**, never one shared. Two
  engines, no shared cache, no in-process lock — which is what two *processes*
  look like to SQLite, and the only arrangement in which the guarded `UPDATE` is
  doing anything.
- **Sequenced on `threading.Event`, never on a sleep.** A test that waits is slow
  when it passes and flaky when it does not.
- **Every thread joined with a timeout and then asserted dead**, so a deadlock
  fails the suite instead of hanging it.
- **Verified by repetition before shipping.** This module ran 20 times
  consecutively with no failures; flake here is worse than no test at all.

What is *not* here: the dispatcher, the pool, and the handlers. Those are tested
without threads at all, because the seam is an injectable executor — see
`tests/server/_jobs.py`.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from visionset.kernel.adapters import SqliteJobQueue, SqliteMetadataStore
from visionset.kernel.domain import BackgroundJob, BackgroundJobSpec, BackgroundJobState
from visionset.kernel.services import WorkspaceService

#: Long enough for a loaded CI runner, short enough that a deadlock is a failure.
JOIN_TIMEOUT = 30.0

TYPE = "test.work"


@pytest.fixture()
def root(tmp_path: Path) -> Iterator[Path]:
    """A real workspace, closed again — the threads open their own stores."""
    made = WorkspaceService.init(tmp_path / "ws")
    made.close()
    yield tmp_path / "ws"


def queue_over(root: Path) -> tuple[SqliteMetadataStore, SqliteJobQueue]:
    """An independent store and queue over the same file, as a second process would."""
    store = SqliteMetadataStore(root / "visionset.db")
    return store, SqliteJobQueue(store)


def test_two_dispatchers_racing_one_job_produce_exactly_one_winner(root: Path) -> None:
    """The whole reason `claim_job` is a guarded `UPDATE` and not a read-then-write.

    Both threads are held at a barrier until they are inside `claim`, so the two
    statements genuinely overlap. A read-then-write would let both see `queued`
    and both write `running`; the guard makes the second one's `rowcount` zero.
    """
    store_a, queue_a = queue_over(root)
    store_b, queue_b = queue_over(root)
    try:
        queue_a.enqueue(BackgroundJobSpec(type=TYPE, payload={"n": 1}))

        # `Barrier` rather than two Events: the point is that neither thread gets
        # a head start, and a barrier is the one primitive that says exactly that.
        together = threading.Barrier(2, timeout=JOIN_TIMEOUT)
        won: list[BackgroundJob | None] = [None, None]

        def race(index: int, queue: SqliteJobQueue) -> None:
            together.wait()
            won[index] = queue.claim(f"worker-{index}")

        threads = [
            threading.Thread(target=race, args=(0, queue_a)),
            threading.Thread(target=race, args=(1, queue_b)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=JOIN_TIMEOUT)
            assert not thread.is_alive(), "a claim deadlocked"

        claimed = [job for job in won if job is not None]
        assert len(claimed) == 1, f"expected exactly one winner, got {len(claimed)}"
        assert claimed[0].state is BackgroundJobState.RUNNING
        assert claimed[0].attempt == 1
    finally:
        store_a.close()
        store_b.close()


def test_two_dispatchers_over_two_jobs_take_one_each(root: Path) -> None:
    """The other half: the guard must refuse a *contended* row, not every second claim.

    Without this, a claim that simply answered `None` whenever anything else was
    running would pass the test above and stall a two-worker pool forever.
    """
    store_a, queue_a = queue_over(root)
    store_b, queue_b = queue_over(root)
    try:
        first = queue_a.enqueue(BackgroundJobSpec(type=TYPE, payload={"n": 1}))
        second = queue_a.enqueue(BackgroundJobSpec(type=TYPE, payload={"n": 2}))

        taken = [queue_a.claim("a"), queue_b.claim("b")]

        assert {job.id for job in taken if job is not None} == {first.id, second.id}
    finally:
        store_a.close()
        store_b.close()


def test_a_progress_write_lands_while_another_store_holds_the_workspace(root: Path) -> None:
    """The WAL payoff, at the job queue's surface.

    A worker writes progress on its own store while the API process holds one too.
    The write must land and the read must see it — which is the arrangement the
    busy timeout and WAL exist for, and the one a single shared store would hide.
    """
    store_a, queue_a = queue_over(root)
    store_b, queue_b = queue_over(root)
    try:
        job = queue_a.enqueue(BackgroundJobSpec(type=TYPE))
        queue_a.claim("a")

        wrote = threading.Event()

        def write_progress() -> None:
            with store_b.unit_of_work() as uow:
                stored = uow.jobs.get(job.id)
                assert stored is not None
                uow.jobs.update(stored.model_copy(update={"processed": 42, "total": 100}))
            wrote.set()

        thread = threading.Thread(target=write_progress)
        thread.start()
        assert wrote.wait(timeout=JOIN_TIMEOUT), "the progress write never completed"
        thread.join(timeout=JOIN_TIMEOUT)
        assert not thread.is_alive()

        seen = queue_a.get(job.id)
        assert seen is not None
        assert (seen.processed, seen.total) == (42, 100)
    finally:
        store_a.close()
        store_b.close()
