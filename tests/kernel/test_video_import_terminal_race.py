"""What two terminal calls arriving together on one import session answer.

The sibling of `test_video_import_concurrency.py`, which covers the appends.
The same invariant holds: **the answer a caller receives is the one the contract
promises**, not a database error that names a table.

`commit` is idempotent by state (`COMMITTED` answers the batch it already made)
and `abort` refuses a committed session with `VideoImportNotOpen`. Both rules are
read from the session row, so the interesting interleaving is the one where both
callers read it while it is still open and then both write.

Two workspace handles over one file, never one shared. Sequenced on
`threading.Barrier`, never on sleeps; every thread joined with a timeout.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from tests.kernel.test_video_import_concurrency import (
    PER_WRITER,
    TIMEOUT_SECONDS,
    WRITERS,
    Fixture,
    _frame,
)

from visionset.kernel.adapters import _mappers as m
from visionset.kernel.adapters.sqlite_metadata_store import SqlRepository
from visionset.kernel.domain import VideoImportState
from visionset.kernel.errors import ConstraintViolated, VideoImportNotOpen
from visionset.kernel.services import VideoImportService


@pytest.fixture()
def full(tmp_path: Path) -> Iterator[Fixture]:
    """A session that holds every frame it declared, so a commit is legal."""
    made = Fixture(tmp_path)
    VideoImportService(made.workspace).append_frames(
        made.import_id, [_frame(ordinal) for ordinal in range(WRITERS * PER_WRITER)]
    )
    yield made
    made.close()


def _gate_on_the_session_row(monkeypatch: pytest.MonkeyPatch, barrier: threading.Barrier) -> None:
    """Hold each caller just after it has read the session as still open.

    Both then decide from a row that predates the other's write, every run —
    the one interleaving whose answer the contract has to survive. Only each
    caller's **first** read is held: a loser re-reads the row on its retry, and
    a second wait on a two-party barrier nobody else is coming to is a timeout.
    """
    original = SqlRepository.get
    lock = threading.Lock()
    waited = 0

    def gated(self: SqlRepository[Any], entity_id: UUID) -> Any:
        nonlocal waited
        row = original(self, entity_id)
        if self._mapping is m.VIDEO_IMPORTS:  # noqa: SLF001
            with lock:
                first = waited < WRITERS
                waited += 1
            if first:
                barrier.wait()
        return row

    monkeypatch.setattr(SqlRepository, "get", gated)


Outcome = tuple[str, object]


def _call(name: str, work: Callable[[], object], outcomes: list[Outcome]) -> Callable[[], None]:
    """`work`, with what it returned or raised kept for the assertions.

    A thread that dies on an exception still joins, so a test that only joins
    cannot tell a refusal from a success.
    """

    def run() -> None:
        try:
            outcomes.append((name, work()))
        except BaseException as exc:  # noqa: BLE001 - the assertion is what it was
            outcomes.append((name, exc))

    return run


def _run(*work: Callable[[], None]) -> None:
    threads = [threading.Thread(target=one) for one in work]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(TIMEOUT_SECONDS)
        assert not thread.is_alive(), "a terminal call never returned"


def test_two_concurrent_commits_answer_one_batch(
    full: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A retried commit that overlaps its original must not be a 500."""
    _gate_on_the_session_row(monkeypatch, threading.Barrier(WRITERS, timeout=TIMEOUT_SECONDS))
    here, there = full.writers()
    outcomes: list[Outcome] = []

    _run(
        _call("here", lambda: here.commit(full.import_id), outcomes),
        _call("there", lambda: there.commit(full.import_id), outcomes),
    )

    monkeypatch.undo()
    failures = [value for _, value in outcomes if isinstance(value, BaseException)]
    assert failures == []
    batch_ids = {value.id for _, value in outcomes}  # type: ignore[attr-defined]
    assert len(batch_ids) == 1
    session = VideoImportService(full.workspace).get(full.import_id)
    assert session.state is VideoImportState.COMMITTED
    assert session.batch_id in batch_ids


def test_a_commit_racing_an_abort_gets_a_typed_answer(
    full: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One of the two wins; the loser is refused by the session's own rule."""
    _gate_on_the_session_row(monkeypatch, threading.Barrier(WRITERS, timeout=TIMEOUT_SECONDS))
    here, there = full.writers()
    outcomes: list[Outcome] = []

    _run(
        _call("commit", lambda: here.commit(full.import_id), outcomes),
        _call("abort", lambda: there.abort(full.import_id), outcomes),
    )

    monkeypatch.undo()
    by_name = dict(outcomes)
    failures = [value for value in by_name.values() if isinstance(value, BaseException)]
    assert not any(isinstance(exc, ConstraintViolated) for exc in failures)
    assert all(isinstance(exc, VideoImportNotOpen) for exc in failures), failures
    # Exactly one terminal transition took effect, and the stored state says which.
    assert len(failures) <= 1
    session = VideoImportService(full.workspace).get(full.import_id)
    if session.state is VideoImportState.COMMITTED:
        assert not isinstance(by_name["commit"], BaseException)
    else:
        assert session.state is VideoImportState.ABORTED
        assert not isinstance(by_name["abort"], BaseException)
