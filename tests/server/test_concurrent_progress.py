"""What overlapping progress writes to one job do to each other, over HTTP.

**The invariant, and it is the whole reason #302 was a defect rather than a
tuning matter: a `200` means the write is in the stored state.** Not "was
attempted", not "was legal when it was sent". So most of what follows never
asserts a particular winner or a particular count of refusals — it asserts that
every request answered `200` is visible afterwards, and that anything not
visible was answered something else. That holds whatever order the runner
happens to give the threads, which is the point of stating it that way.

The tests that *do* need a particular interleaving gate on
`JobService.require_open_batch`, which is the last read `mark` performs before
it decides. `TestClient` runs the application in this process, so patching the
class reaches the real request handler — a gate there is not a stand-in for the
race, it is the race, held still.

Which of them need it is not a matter of taste: **any assertion about the
*final* state that names a count of winners needs the gate**, because without
it the writers may serialize, and a sequence of legal moves each answered `200`
truthfully leaves a final state matching only the last. Only assertions that
hold under any interleaving — every write lands, or nothing is refused — can be
left to `_at_once`'s barrier alone.

Threads rather than a task group: `TestClient` is a synchronous client, and the
route it calls is a `def` handler that FastAPI runs in a worker thread against a
real connection pool. Two threads here are two pooled connections, which is what
two requests to a running server are.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client
from tests.server._flow import asset_ids, open_job
from tests.server._runner import RecordingRunner

from visionset.kernel.services import JobService

#: Long enough that a loaded runner does not trip it, short enough that a
#: genuine deadlock fails the suite instead of stalling it. The kernel's
#: threaded file uses the same number for the same reason.
TIMEOUT_SECONDS = 30.0

#: The number in the report: three concurrent moves, three `200`s, one asset
#: moved.
WRITERS = 3


@pytest.fixture()
def runner() -> RecordingRunner:
    return RecordingRunner()


@pytest.fixture()
def client(tmp_path: Path, runner: RecordingRunner) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", runner=runner) as made:
        yield made


@pytest.fixture()
def working(client: TestClient, tmp_path: Path, runner: RecordingRunner) -> tuple[str, str]:
    """A started job over a three-asset batch. Returns ``(batch_id, job_id)``."""
    return open_job(client, runner, tmp_path, images=WRITERS)


def _progress(client: TestClient, batch_id: str) -> dict[str, str]:
    """What the batch says each of its assets is, after the dust settles."""
    items = client.get(f"/batches/{batch_id}/assets").json()["items"]
    return {asset["id"]: asset["progress"] for asset in items}


def _at_once(client: TestClient, job_id: str, moves: list[tuple[str, str]]) -> list[httpx.Response]:
    """Send every move from its own thread, released together.

    A `threading.Barrier` rather than a sleep: every thread has its request built
    and is inside `barrier.wait` before any of them is inside `client.put`, so
    the overlap is as tight as this harness can make it without reaching into
    the service.
    """
    barrier = threading.Barrier(len(moves), timeout=TIMEOUT_SECONDS)
    answers: list[Any] = [None] * len(moves)

    def send(index: int) -> None:
        asset_id, progress = moves[index]
        barrier.wait()
        answers[index] = client.put(
            f"/jobs/{job_id}/assets/{asset_id}/progress", json={"progress": progress}
        )

    threads = [
        threading.Thread(target=send, args=(index,), name=f"writer-{index}")
        for index in range(len(moves))
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(TIMEOUT_SECONDS)
        assert not thread.is_alive(), f"{thread.name} never finished"
    assert all(answer is not None for answer in answers), "a writer returned nothing"
    return answers


def _all_read_before_any_decides(monkeypatch: pytest.MonkeyPatch, writers: int) -> None:
    """Hold every writer inside `mark` until all of them have read the asset.

    `JobService.require_open_batch` is the last read `mark` performs before it
    decides, and `current` is taken just above it — so a barrier here is the
    point where every writer has its "what this move was judged against" in
    hand and none has written. `TestClient` runs the application in this
    process, so patching the class reaches the real request handler.

    This is what a `threading.Barrier` in `_at_once` alone cannot do. That one
    aligns the moment each thread *enters* `client.put`; it leaves the
    read-decide-write window free to serialize, and on a loaded machine it
    does. Overlap then stops being a property of the harness and becomes a
    property of how busy the runner is, which is how #332 blocked unrelated
    PRs while passing every local run.
    """
    everyone_has_read = threading.Barrier(writers, timeout=TIMEOUT_SECONDS)
    read_the_job = JobService.require_open_batch

    def gated(self: JobService, uow: Any, job: Any) -> Any:
        batch = read_the_job(self, uow, job)
        everyone_has_read.wait()
        return batch

    monkeypatch.setattr(JobService, "require_open_batch", gated)


def test_three_concurrent_moves_over_one_job_move_three_assets(
    client: TestClient, working: tuple[str, str]
) -> None:
    """The reported defect, at the surface it was reported at.

    Different assets of one job are different rows and cannot conflict, so there
    is nothing here for the kernel to refuse — every one of the three lands.
    Before this they were one `UPDATE` of one entity, and the last writer put
    back the other two as it had read them.
    """
    batch_id, job_id = working
    assets = asset_ids(client, batch_id)

    answers = _at_once(client, job_id, [(asset, "skipped") for asset in assets])

    assert [answer.status_code for answer in answers] == [200] * WRITERS
    assert set(_progress(client, batch_id).values()) == {"skipped"}


def test_a_move_answered_200_is_in_the_stored_state_whoever_else_was_writing(
    client: TestClient, working: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """One asset, three writers, two destinations — the invariant, stated directly.

    Every move is legal from `unannotated`, so nothing here is refused by the
    transition table; what refuses is a state that moved. Whichever writer wins,
    a `200` has to mean that writer's value is what is stored — including the
    second writer asking for the same thing, where losing the race to somebody
    who did what you asked is not a refusal.

    Asserted without naming a winner on purpose: the two moves are both legal
    from where they were read, so which one lands is the scheduler's business
    and neither answer is a defect. What would be a defect is a `200` for a
    value that is not there.

    Gated, because that claim is only true while the three writers genuinely
    overlap. Let them serialize and all three answer `200` truthfully —
    `unannotated -> annotated`, the same move again as a no-op, then
    `annotated -> skipped`, each legal and each stored when it was reported —
    and the final state matches only the last of them. That is not a lost
    write, so weakening the assertion to admit it would stop pinning what #302
    was about; holding the interleaving still is what keeps it pinned.
    """
    batch_id, job_id = working
    asset = asset_ids(client, batch_id)[0]
    moves = [(asset, "skipped"), (asset, "annotated"), (asset, "annotated")]
    _all_read_before_any_decides(monkeypatch, WRITERS)

    answers = _at_once(client, job_id, moves)

    stored = _progress(client, batch_id)[asset]
    reported = [
        (progress, answer.status_code) for (_, progress), answer in zip(moves, answers, strict=True)
    ]
    assert {progress for progress, status in reported if status == 200} == {stored}, reported
    assert all(status == 409 for progress, status in reported if progress != stored), reported


def test_the_writer_that_lost_the_race_is_refused_with_stale_write(
    client: TestClient, working: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The refusal, pinned: `409 STALE_WRITE`, deterministically.

    Both writers are held until both have read, so both decide against
    `unannotated` and both moves are legal from there — which is what separates
    this from `INVALID_TRANSITION`. One write lands; the other is refused rather
    than applied on top, and told where the asset actually is so that a re-read
    and a resubmit is the entire remedy.
    """
    batch_id, job_id = working
    asset = asset_ids(client, batch_id)[0]
    _all_read_before_any_decides(monkeypatch, 2)

    answers = _at_once(client, job_id, [(asset, "skipped"), (asset, "annotated")])

    statuses = sorted(answer.status_code for answer in answers)
    assert statuses == [200, 409], [answer.json() for answer in answers]
    refused = next(answer for answer in answers if answer.status_code == 409)
    assert refused.json()["code"] == "STALE_WRITE"
    assert _progress(client, batch_id)[asset] in {"skipped", "annotated"}


def test_a_move_out_of_a_state_the_table_forbids_is_still_a_transition_error(
    client: TestClient, working: tuple[str, str]
) -> None:
    """`STALE_WRITE` did not swallow `INVALID_TRANSITION`, and they are different.

    Sequentially there is no race at all: the second call reads `skipped` and is
    refused by `ASSET_PROGRESS_TRANSITIONS` before any write is attempted. The
    two refusals mean different things — "that move is not in the table" against
    "that move was in the table when you read, and the state has moved" — and a
    client that offered a re-read as the remedy for the first would be wrong.
    """
    batch_id, job_id = working
    asset = asset_ids(client, batch_id)[0]

    assert (
        client.put(
            f"/jobs/{job_id}/assets/{asset}/progress", json={"progress": "skipped"}
        ).status_code
        == 200
    )
    refused = client.put(f"/jobs/{job_id}/assets/{asset}/progress", json={"progress": "annotated"})

    assert refused.status_code == 409
    assert refused.json()["code"] == "INVALID_TRANSITION"
