"""What overlapping membership edits to one draft batch do to each other.

The sibling of `tests/server/test_concurrent_progress.py`, on the same mechanism
and with the same invariant: **a call that returned is a call whose effect is in
the stored state.** Not "was attempted", not "was legal when it was sent".

`Repository.update` replaces a whole entity and a `Batch` carries every member,
so without a narrow write two callers adding *different* assets to one draft both write the
same row set — and the second deleted the first one's row before re-inserting the
membership it had read. Neither was refused. The defect was unreachable only
because `add_assets` and `remove_assets` had no route in front of them; putting
one there is what makes it live, which is why the fix landed first.

Two workspace handles over one file, never one shared: two engines with no shared
cache is what two *processes* look like to SQLite, and an in-process lock would
prove something about this test rather than about the code. Sequenced on
`threading.Barrier` and `threading.Event`, never on sleeps; every thread joined
with a timeout and then asserted dead.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from io import BytesIO
from pathlib import Path
from uuid import UUID

import pytest

from visionset.kernel.domain import Asset, Batch, GeometryType, LabelClass
from visionset.kernel.services import (
    BatchService,
    ProjectService,
    SchemaService,
    WorkspaceService,
)

#: Long enough that a loaded runner does not trip it, short enough that a genuine
#: deadlock fails the suite instead of stalling it. The kernel's other threaded
#: file uses the same number for the same reason.
TIMEOUT_SECONDS = 30.0


class Fixture:
    """One workspace, opened twice: four assets and a draft holding the first two."""

    def __init__(self, tmp_path: Path) -> None:
        self.root = tmp_path / "ws"
        self.workspace = WorkspaceService.init(self.root)
        self.project = ProjectService(self.workspace).create("membership")
        SchemaService(self.workspace).create_version(
            self.project.id, [LabelClass(name="sign", geometries=(GeometryType.BBOX,))]
        )
        self.assets = [self._asset(index) for index in range(4)]
        self.batch = BatchService(self.workspace).create(self.project.id, "draft", self.assets[:2])
        #: The second connection. A separate `WorkspaceService.open`, so the two
        #: writers share nothing but the file on disk.
        self.other = WorkspaceService.open(self.root)

    def _asset(self, index: int) -> UUID:
        content_hash = self.workspace.blob_store.put(BytesIO(f"a{index}".encode()))
        with self.workspace.unit_of_work() as uow:
            return uow.assets.add(
                Asset(
                    project_id=self.project.id,
                    content_hash=content_hash,
                    uri=f"/a{index}.png",
                )
            ).id

    def here(self) -> BatchService:
        return BatchService(self.workspace)

    def there(self) -> BatchService:
        return BatchService(self.other)

    def membership(self) -> list[UUID]:
        return self.here().get(self.batch.id).asset_ids

    def close(self) -> None:
        self.other.close()
        self.workspace.close()


@pytest.fixture()
def fixture(tmp_path: Path) -> Iterator[Fixture]:
    made = Fixture(tmp_path)
    yield made
    made.close()


def _run(*work: Callable[[], None]) -> None:
    """Run every callable in its own thread and insist all of them finish."""
    threads = [threading.Thread(target=one) for one in work]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(TIMEOUT_SECONDS)
        assert not thread.is_alive(), "a membership write never returned"


def _gate_on(monkeypatch: pytest.MonkeyPatch, method: str, barrier: threading.Barrier) -> None:
    """Hold every caller of `method` until as many have read as the barrier wants.

    The gate sits on the *last read either writer makes before it decides*, which
    is what turns "two threads, hopefully overlapping" into one exact
    interleaving: each writer is holding a membership that predates the other's
    write, every run.
    """
    original = getattr(BatchService, method)

    def gated(self: BatchService, uow: object, batch_id: UUID) -> Batch:
        read: Batch = original(self, uow, batch_id)
        barrier.wait()
        return read

    monkeypatch.setattr(BatchService, method, gated)


def test_two_concurrent_adds_to_one_draft_both_land(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The defect, held still: two writers, two different assets, both must survive."""
    _gate_on(monkeypatch, "require_draft", threading.Barrier(2, timeout=TIMEOUT_SECONDS))
    third, fourth = fixture.assets[2], fixture.assets[3]

    _run(
        lambda: fixture.here().add_assets(fixture.batch.id, [third]),
        lambda: fixture.there().add_assets(fixture.batch.id, [fourth]),
    )

    stored = fixture.membership()
    assert third in stored, "the first writer's asset was clobbered by the second"
    assert fourth in stored, "the second writer's asset was clobbered by the first"
    assert len(stored) == 4


def test_two_concurrent_removals_from_one_draft_both_land(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same clobber in the other direction, which insert-if-absent would miss.

    A half-fix that stopped deleting and only inserted would let a stale writer
    *resurrect* the member the other one just removed. Same gate, opposite
    operation — so this fails against that half-fix as well as against the
    original, which is why both directions are worth a test rather than one.
    """
    _gate_on(monkeypatch, "require_draft", threading.Barrier(2, timeout=TIMEOUT_SECONDS))
    first, second = fixture.assets[0], fixture.assets[1]

    _run(
        lambda: fixture.here().remove_assets(fixture.batch.id, [first]),
        lambda: fixture.there().remove_assets(fixture.batch.id, [second]),
    )

    assert fixture.membership() == []


def test_a_state_transition_does_not_put_back_a_concurrent_membership_edit(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The case with no race between two membership writers at all.

    `approve` reads a whole batch, sets `state`, and saves it. While membership
    rode along on that write, an add landing between the read and the save was
    silently undone — one writer, one editor, nothing contending for the same
    field. The batch's version of the `JobService.complete` finding, and the
    reason the fix is "updates stop touching membership" rather than "membership
    writes take a lock".

    Ordered rather than raced: the add is allowed to finish before the approval
    saves, which is exactly the interleaving that used to lose it.
    """
    approval_has_read = threading.Event()
    add_has_landed = threading.Event()
    original = BatchService.require_batch

    def gated(self: BatchService, uow: object, batch_id: UUID) -> Batch:
        read: Batch = original(self, uow, batch_id)
        # Only the approval waits. The add reaches this too — `require_draft`
        # calls it — and by then the event is set, so it passes straight through.
        if not approval_has_read.is_set():
            approval_has_read.set()
            assert add_has_landed.wait(TIMEOUT_SECONDS), "the add never finished"
        return read

    monkeypatch.setattr(BatchService, "require_batch", gated)
    third = fixture.assets[2]

    def add() -> None:
        assert approval_has_read.wait(TIMEOUT_SECONDS), "the approval never read"
        fixture.there().add_assets(fixture.batch.id, [third])
        add_has_landed.set()

    _run(lambda: fixture.here().approve(fixture.batch.id), add)

    assert third in fixture.membership()
