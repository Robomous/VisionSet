"""The queue itself: enqueue, claim, settle, cancel, sweep.

Drives `SqliteJobQueue` through a real workspace rather than a fake store,
because the interesting half of this adapter *is* the SQL — the claim is a
guarded `UPDATE` whose `rowcount` is the answer, and a double would assert the
Python around a statement it had replaced.

Contention has its own module, `test_job_concurrency.py`, on the same terms
`test_concurrency.py` set: threads there, none here.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest

from visionset.kernel.domain import (
    BackgroundJobOutcome,
    BackgroundJobSpec,
    BackgroundJobState,
    ItemFailure,
)
from visionset.kernel.errors import BackgroundJobNotFound, InvalidTransition
from visionset.kernel.ports import JobQueue
from visionset.kernel.services import WorkspaceService

TYPE = "test.work"


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws")
    yield made
    made.close()


@pytest.fixture()
def queue(workspace: WorkspaceService) -> JobQueue:
    return workspace.job_queue


def spec(**payload: object) -> BackgroundJobSpec:
    return BackgroundJobSpec(type=TYPE, payload=dict(payload))  # type: ignore[arg-type]


def succeeded(**result: object) -> BackgroundJobOutcome:
    return BackgroundJobOutcome(
        state=BackgroundJobState.SUCCEEDED,
        result=dict(result),  # type: ignore[arg-type]
    )


# --- enqueue -----------------------------------------------------------------


def test_an_enqueued_job_is_queued_and_readable_at_once(queue: JobQueue) -> None:
    """The whole point of writing the row before the work: a 202 has an id to hand back."""
    job = queue.enqueue(spec(release_id="abc"))

    assert job.state is BackgroundJobState.QUEUED
    stored = queue.get(job.id)
    assert stored is not None
    assert stored.payload == {"release_id": "abc"}
    assert (stored.started_at, stored.finished_at, stored.worker) == (None, None, None)


def test_the_queue_does_not_check_whether_anything_can_run_the_type(queue: JobQueue) -> None:
    """The port says so, and it is not an oversight — the kernel cannot read a registry.

    Resolving a type to code means `visionset.jobs`, which import-linter forbids
    the kernel from importing. `UnknownJobType` is raised by the registry instead:
    at the surface that built the spec, and again by the dispatcher.
    """
    job = queue.enqueue(BackgroundJobSpec(type="nothing.runs.this"))

    assert job.state is BackgroundJobState.QUEUED


def test_a_job_is_not_scoped_to_a_project_and_survives_one(queue: JobQueue) -> None:
    """`JobRow` carries no foreign key, so nothing cascades a job away.

    The record of work that already happened outlives its subject on purpose —
    "this export ran and here is the archive" stays true after the release is
    gone.
    """
    job = queue.enqueue(spec(release_id=str(uuid4())))
    queue.claim("w")
    queue.finish(job.id, succeeded(archive="exports/a.zip"))

    stored = queue.get(job.id)
    assert stored is not None
    assert stored.result == {"archive": "exports/a.zip"}


# --- claiming ----------------------------------------------------------------


def test_claiming_takes_the_oldest_and_stamps_who_took_it(queue: JobQueue) -> None:
    first = queue.enqueue(spec(n=1))
    queue.enqueue(spec(n=2))

    claimed = queue.claim("worker-1")

    assert claimed is not None
    assert claimed.id == first.id
    assert claimed.state is BackgroundJobState.RUNNING
    assert claimed.worker == "worker-1"
    assert claimed.attempt == 1
    assert claimed.started_at is not None


def test_a_second_claim_never_returns_the_same_job(queue: JobQueue) -> None:
    """The guarantee the guarded `UPDATE` exists for, in the single-threaded case.

    `test_job_concurrency.py` races two stores over one file for the case that
    actually needs the guard; this pins the ordinary reading of it, which is
    where a regression would show up first.
    """
    queue.enqueue(spec(n=1))

    first = queue.claim("a")
    second = queue.claim("b")

    assert first is not None
    assert second is None


def test_claiming_an_empty_queue_answers_none_rather_than_waiting(queue: JobQueue) -> None:
    assert queue.claim("a") is None


def test_claiming_walks_the_queue_in_order(queue: JobQueue) -> None:
    ids = [queue.enqueue(spec(n=n)).id for n in range(3)]

    taken = []
    for _ in range(3):
        job = queue.claim("a")
        assert job is not None
        taken.append(job.id)
        queue.finish(job.id, succeeded())

    assert taken == ids


# --- finishing ---------------------------------------------------------------


def test_finishing_stamps_the_outcome_and_the_moment(queue: JobQueue) -> None:
    job = queue.enqueue(spec())
    queue.claim("a")

    settled = queue.finish(
        job.id,
        BackgroundJobOutcome(
            state=BackgroundJobState.SUCCEEDED,
            result={"archive": "exports/x.zip"},
            processed=7,
            total=7,
            failures=(ItemFailure(name="b.png", reason="will not decode"),),
        ),
    )

    assert settled.state is BackgroundJobState.SUCCEEDED
    assert settled.processed == 7
    assert settled.total == 7
    assert [failure.name for failure in settled.failures] == ["b.png"]
    assert settled.finished_at is not None
    assert settled.settled


def test_the_final_numbers_come_off_the_outcome_and_not_off_the_row(queue: JobQueue) -> None:
    """Why `finish` takes counters at all, rather than leaving what the reporter wrote.

    The reporter throttles, so the last item's write is the one most likely to be
    swallowed — and it is the one a finished job is read for.
    """
    job = queue.enqueue(spec())
    queue.claim("a")
    # What a throttled reporter left behind: nothing.
    assert queue.get(job.id) is not None

    settled = queue.finish(
        job.id, BackgroundJobOutcome(state=BackgroundJobState.SUCCEEDED, processed=900, total=900)
    )

    assert (settled.processed, settled.total) == (900, 900)


def test_finishing_a_job_that_is_not_running_is_refused_by_the_table(queue: JobQueue) -> None:
    job = queue.enqueue(spec())

    with pytest.raises(InvalidTransition):
        queue.finish(job.id, succeeded())


def test_a_settled_job_never_moves_again(queue: JobQueue) -> None:
    """The port's second obligation: a second answer means two runners had it."""
    job = queue.enqueue(spec())
    queue.claim("a")
    queue.finish(job.id, succeeded())

    with pytest.raises(InvalidTransition):
        queue.finish(job.id, succeeded())


def test_finishing_an_unknown_job_names_it(queue: JobQueue) -> None:
    missing = uuid4()

    with pytest.raises(BackgroundJobNotFound, match=str(missing)):
        queue.finish(missing, succeeded())


def test_a_failed_outcome_must_say_why(queue: JobQueue) -> None:
    """The model refuses it, so no adapter has to remember to."""
    with pytest.raises(ValueError, match="must say why"):
        BackgroundJobOutcome(state=BackgroundJobState.FAILED)


def test_an_outcome_must_be_terminal(queue: JobQueue) -> None:
    with pytest.raises(ValueError, match="terminal"):
        BackgroundJobOutcome(state=BackgroundJobState.RUNNING)


# --- cancelling --------------------------------------------------------------


def test_cancelling_a_queued_job_settles_it_outright(queue: JobQueue) -> None:
    """Nothing has started, so there is nobody to ask."""
    job = queue.enqueue(spec())

    cancelled = queue.request_cancel(job.id)

    assert cancelled.state is BackgroundJobState.CANCELLED
    assert cancelled.finished_at is not None
    assert queue.claim("a") is None


def test_cancelling_a_running_job_only_asks(queue: JobQueue) -> None:
    """The handler owns the safe places to stop, so all this can do is say so."""
    job = queue.enqueue(spec())
    queue.claim("a")

    asked = queue.request_cancel(job.id)

    assert asked.state is BackgroundJobState.RUNNING
    assert asked.cancel_requested is True


def test_cancelling_a_settled_job_is_a_no_op_rather_than_a_refusal(queue: JobQueue) -> None:
    """Otherwise every cancel button needs a race-condition branch."""
    job = queue.enqueue(spec())
    queue.claim("a")
    queue.finish(job.id, succeeded())

    same = queue.request_cancel(job.id)

    assert same.state is BackgroundJobState.SUCCEEDED
    assert same.cancel_requested is False


def test_cancelling_an_unknown_job_names_it(queue: JobQueue) -> None:
    with pytest.raises(BackgroundJobNotFound):
        queue.request_cancel(uuid4())


# --- the orphan sweep --------------------------------------------------------


def test_the_sweep_fails_every_row_left_running(queue: JobQueue) -> None:
    """Exact rather than heuristic: one server owns every worker, so nobody holds these."""
    job = queue.enqueue(spec())
    queue.claim("a")

    settled = queue.sweep_orphans(reason="the server stopped")

    assert [one.id for one in settled] == [job.id]
    stored = queue.get(job.id)
    assert stored is not None
    assert stored.state is BackgroundJobState.FAILED
    assert stored.error == "the server stopped"


def test_the_sweep_re_queues_an_idempotent_orphan_as_a_new_job(queue: JobQueue) -> None:
    """A retry is never the same row — see `BACKGROUND_JOB_TRANSITIONS`.

    So a list shows the crash *and* the recovery, rather than one line that
    quietly changed its mind.
    """
    job = queue.enqueue(BackgroundJobSpec(type=TYPE, payload={"n": 1}, idempotent=True))
    queue.claim("a")

    queue.sweep_orphans(reason="crash")

    live = queue.list(states=[BackgroundJobState.QUEUED])
    assert len(live) == 1
    assert live[0].id != job.id
    assert live[0].payload == {"n": 1}
    assert live[0].idempotent is True


def test_the_sweep_does_not_re_queue_work_that_is_not_idempotent(queue: JobQueue) -> None:
    queue.enqueue(spec())
    queue.claim("a")

    queue.sweep_orphans(reason="crash")

    assert queue.list(states=[BackgroundJobState.QUEUED]) == []


def test_the_sweep_leaves_queued_and_settled_rows_alone(queue: JobQueue) -> None:
    # Claimed first, so the one that gets settled is the oldest — `claim` takes
    # them in order and this test is about the two states it must *not* touch.
    done = queue.enqueue(spec(n=1))
    waiting = queue.enqueue(spec(n=2))
    queue.claim("a")
    queue.finish(done.id, succeeded())

    assert queue.sweep_orphans(reason="crash") == []

    still = queue.get(waiting.id)
    assert still is not None
    assert still.state is BackgroundJobState.QUEUED


# --- listing -----------------------------------------------------------------


def test_listing_answers_newest_first(queue: JobQueue) -> None:
    """The opposite order to `claim`, because the caller is a person looking at now."""
    ids = [queue.enqueue(spec(n=n)).id for n in range(3)]

    assert [job.id for job in queue.list()] == list(reversed(ids))


def test_listing_narrows_to_the_states_asked_for(queue: JobQueue) -> None:
    running = queue.enqueue(spec(n=1))
    queue.enqueue(spec(n=2))
    # Takes the oldest, which is the first one enqueued.
    queue.claim("a")

    only = queue.list(states=[BackgroundJobState.RUNNING])

    assert [job.id for job in only] == [running.id]


def test_listing_with_no_filter_returns_every_state(queue: JobQueue) -> None:
    queue.enqueue(spec(n=1))
    queue.enqueue(spec(n=2))
    queue.claim("a")

    assert len(queue.list()) == 2
