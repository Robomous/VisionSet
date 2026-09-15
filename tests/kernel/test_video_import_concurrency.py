"""What two overlapping appends to one import session do to its progress count.

The sibling of `test_concurrent_membership.py`, on the same mechanism and with
the same invariant: **a call that returned is a call whose effect is in the
stored state.** Not "was attempted", not "was legal when it was sent".

`received_frame_count` used to be read and then written back with the arrivals
added. Under pysqlite the read runs before `BEGIN`, so there is no snapshot to
protect it: two writers staging *different* frames both read the same number,
both add their own, and the session ends holding sixteen rows while claiming
four. That is unrecoverable rather than merely wrong — re-sending a staged frame
is idempotent and writes nothing, so nothing can ever move the count again, and
the session refuses to commit forever.

Two workspace handles over one file, never one shared: two engines with no
shared cache is what two *processes* look like to SQLite. Sequenced on
`threading.Barrier`, never on sleeps; every thread joined with a timeout and
then asserted dead.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from io import BytesIO
from pathlib import Path
from uuid import UUID

import pytest
from PIL import Image

from visionset.kernel.adapters import _mappers as m
from visionset.kernel.adapters.sqlite_metadata_store import SqlRepository
from visionset.kernel.domain import IncomingFrame, VideoImportState, VideoMetadata
from visionset.kernel.errors import ConstraintViolated, FrameContentConflict
from visionset.kernel.services import ProjectService, VideoImportService, WorkspaceService

#: `test_concurrent_membership.py`'s number, for its reason: long enough that a
#: loaded runner does not trip it, short enough that a genuine deadlock fails.
TIMEOUT_SECONDS = 30.0

FRAME_SIZE = (16, 12)
WRITERS = 2
PER_WRITER = 2


def _frame(ordinal: int, *, seed: int | None = None) -> IncomingFrame:
    """One frame. Equal `(ordinal, seed)` pairs give equal bytes, which is what
    lets a test say "the same frame again" and "a different frame here"."""
    width, height = FRAME_SIZE
    tint = ordinal if seed is None else seed
    pixels = bytes(
        channel
        for y in range(height)
        for x in range(width)
        for channel in ((x * 7 + tint * 13) % 256, (y * 5) % 256, (tint * 47) % 256)
    )
    buffer = BytesIO()
    Image.frombytes("RGB", FRAME_SIZE, pixels).save(buffer, format="JPEG", quality=95)
    return IncomingFrame(
        ordinal=ordinal,
        requested_timestamp=float(ordinal),
        width=FRAME_SIZE[0],
        height=FRAME_SIZE[1],
        content=buffer,
    )


class Fixture:
    """One workspace opened twice, and an open session expecting every frame."""

    def __init__(self, tmp_path: Path) -> None:
        self.root = tmp_path / "ws"
        self.workspace = WorkspaceService.init(self.root)
        project = ProjectService(self.workspace).create("imports")
        self.import_id: UUID = (
            VideoImportService(self.workspace)
            .start(
                project.id,
                display_name="clip.webm",
                metadata=VideoMetadata(
                    width=FRAME_SIZE[0],
                    height=FRAME_SIZE[1],
                    fps=30.0,
                    duration_seconds=float(WRITERS * PER_WRITER),
                    codec="vp9",
                ),
                extraction_fps=1.0,
                batch_name="night drive",
            )
            .id
        )
        #: The second connection, so the two writers share nothing but the file.
        self.other = WorkspaceService.open(self.root)

    def writers(self) -> list[VideoImportService]:
        return [VideoImportService(self.workspace), VideoImportService(self.other)]

    def close(self) -> None:
        self.other.close()
        self.workspace.close()


@pytest.fixture()
def fixture(tmp_path: Path) -> Iterator[Fixture]:
    made = Fixture(tmp_path)
    yield made
    made.close()


def _append(
    service: VideoImportService, import_id: UUID, frames: list[IncomingFrame]
) -> Callable[[], None]:
    def work() -> None:
        service.append_frames(import_id, frames)

    return work


def _collecting(
    service: VideoImportService,
    import_id: UUID,
    frames: list[IncomingFrame],
    raised: list[BaseException],
) -> Callable[[], None]:
    """`_append`, with whatever it raised kept for the assertions.

    A thread that dies on an exception still joins, so a test that only joins
    cannot tell a refusal from a success — which is precisely the difference
    these two cases are about.
    """

    def work() -> None:
        try:
            service.append_frames(import_id, frames)
        except BaseException as exc:  # noqa: BLE001 - the assertion is what it was
            raised.append(exc)

    return work


def _run(*work: Callable[[], None]) -> None:
    threads = [threading.Thread(target=one) for one in work]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(TIMEOUT_SECONDS)
        assert not thread.is_alive(), "an append never returned"


def _gate_on_the_staged_frames(monkeypatch: pytest.MonkeyPatch, barrier: threading.Barrier) -> None:
    """Hold every appender just after it has read what the session already holds.

    That read is the one the old count was derived from, and it is still made —
    it is what adjudicates a retry against a conflict — so the gate pins the
    exact interleaving in both versions rather than describing only the broken
    one: each writer decides while holding a frame list that predates the other's
    insert, every run.
    """
    original = SqlRepository.list

    def gated(self: SqlRepository[object], parent_id: UUID | None = None) -> list[object]:
        rows = original(self, parent_id)
        if self._mapping is m.VIDEO_IMPORT_FRAMES:  # noqa: SLF001
            barrier.wait()
        return rows

    monkeypatch.setattr(SqlRepository, "list", gated)


def test_two_concurrent_appends_both_reach_the_progress_count(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The defect, held still: four frames staged must be four frames counted."""
    _gate_on_the_staged_frames(monkeypatch, threading.Barrier(WRITERS, timeout=TIMEOUT_SECONDS))
    here, there = fixture.writers()

    _run(
        _append(here, fixture.import_id, [_frame(0), _frame(1)]),
        _append(there, fixture.import_id, [_frame(2), _frame(3)]),
    )

    monkeypatch.undo()
    session = VideoImportService(fixture.workspace).get(fixture.import_id)
    with fixture.workspace.unit_of_work() as uow:
        staged = uow.video_import_frames.list(fixture.import_id)
    assert session.received_frame_count == len(staged) == WRITERS * PER_WRITER


def test_a_session_filled_by_two_writers_still_commits(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The consequence, which is why the lost update is unrecoverable rather than untidy.

    A count short of what is staged refuses the commit forever: every frame is
    already there, so re-sending one is a no-op that cannot move it.
    """
    _gate_on_the_staged_frames(monkeypatch, threading.Barrier(WRITERS, timeout=TIMEOUT_SECONDS))
    here, there = fixture.writers()

    _run(
        _append(here, fixture.import_id, [_frame(0), _frame(1)]),
        _append(there, fixture.import_id, [_frame(2), _frame(3)]),
    )

    monkeypatch.undo()
    imports = VideoImportService(fixture.workspace)
    batch = imports.commit(fixture.import_id)
    assert len(batch.asset_ids) == WRITERS * PER_WRITER
    assert imports.get(fixture.import_id).state is VideoImportState.COMMITTED


def _gate_once_on_the_staged_frames(
    monkeypatch: pytest.MonkeyPatch, barrier: threading.Barrier
) -> None:
    """Hold each appender's **first** read of the staged rows, and only that one.

    The gate above reuses a cyclic barrier, which is right while every append
    reads exactly once. An append whose insert collides reads a second time —
    the re-read *is* the adjudication — and a second wait on a two-party barrier
    nobody else is coming to is a thirty-second timeout dressed up as a
    deadlock. So this one releases each writer once and then stands aside.
    """
    original = SqlRepository.list
    lock = threading.Lock()
    waited = 0

    def gated(self: SqlRepository[object], parent_id: UUID | None = None) -> list[object]:
        nonlocal waited
        rows = original(self, parent_id)
        if self._mapping is m.VIDEO_IMPORT_FRAMES:  # noqa: SLF001
            with lock:
                first = waited < WRITERS
                waited += 1
            if first:
                barrier.wait()
        return rows

    monkeypatch.setattr(SqlRepository, "list", gated)


def test_two_concurrent_appends_at_one_ordinal_with_one_content_are_a_retry(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The documented answer, held to under a real race.

    Both writers find the ordinal free, and the unique index refuses the
    loser's insert. Unadjudicated that is a `ConstraintViolated` — a 500 — for
    what the contract calls the ordinary case: a chunked upload that lost its
    connection and sent the same bytes again.
    """
    _gate_once_on_the_staged_frames(
        monkeypatch, threading.Barrier(WRITERS, timeout=TIMEOUT_SECONDS)
    )
    here, there = fixture.writers()
    raised: list[BaseException] = []

    _run(
        _collecting(here, fixture.import_id, [_frame(0)], raised),
        _collecting(there, fixture.import_id, [_frame(0)], raised),
    )

    monkeypatch.undo()
    assert raised == []
    session = VideoImportService(fixture.workspace).get(fixture.import_id)
    with fixture.workspace.unit_of_work() as uow:
        staged = uow.video_import_frames.list(fixture.import_id)
    assert session.received_frame_count == len(staged) == 1


def test_two_concurrent_appends_at_one_ordinal_with_different_content_conflict(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other half: the loser is refused by the session's own rule, not by the index.

    `FrameContentConflict` is a 409 a client can act on — abort and start again
    — where `ConstraintViolated` is a 500 that names a table.
    """
    _gate_once_on_the_staged_frames(
        monkeypatch, threading.Barrier(WRITERS, timeout=TIMEOUT_SECONDS)
    )
    here, there = fixture.writers()
    raised: list[BaseException] = []

    _run(
        _collecting(here, fixture.import_id, [_frame(0, seed=1)], raised),
        _collecting(there, fixture.import_id, [_frame(0, seed=2)], raised),
    )

    monkeypatch.undo()
    assert [type(exc) for exc in raised] == [FrameContentConflict]
    assert not any(isinstance(exc, ConstraintViolated) for exc in raised)
    with fixture.workspace.unit_of_work() as uow:
        assert len(uow.video_import_frames.list(fixture.import_id)) == 1
