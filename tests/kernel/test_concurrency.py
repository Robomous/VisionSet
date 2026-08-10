"""The store's connection posture, and what two connections do to each other.

The suite's only threaded tests. Everything here sequences on `threading.Event`
rather than on sleeps, and every thread is joined with a timeout and then
asserted dead — a concurrency test that hangs is a concurrency test nobody runs.

Two `SqliteMetadataStore` instances over one file is the shape under test: that
is two engines with no shared cache and no in-process lock, which is what two
*processes* look like from SQLite's side. `WorkspaceService` composes exactly one
store per open workspace, so this is the only place that arrangement is built on
purpose.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from visionset.kernel import ConstraintViolated, StaleWrite, WorkspaceBusy, WorkspaceCorrupt
from visionset.kernel.adapters import SqliteMetadataStore
from visionset.kernel.adapters.sqlite_metadata_store import DEFAULT_BUSY_TIMEOUT_MS
from visionset.kernel.domain import (
    AnnotationJob,
    Asset,
    AssetProgress,
    Batch,
    GeometryType,
    LabelClass,
    Project,
    Workspace,
)
from visionset.kernel.ports import UNINITIALIZED, UnitOfWork
from visionset.kernel.services import (
    BatchService,
    JobService,
    ProjectService,
    SchemaService,
    WorkspaceService,
)

#: Every wait in this file. Long enough that a loaded CI runner does not trip it,
#: short enough that a genuine deadlock fails the suite instead of stalling it.
TIMEOUT_SECONDS = 30.0


def _store(tmp_path: Path, **kwargs: int) -> SqliteMetadataStore:
    store = SqliteMetadataStore(tmp_path / "visionset.db", **kwargs)
    store.initialize()
    return store


def _pragma(store: SqliteMetadataStore, name: str) -> object:
    with store.engine.connect() as connection:
        return connection.execute(text(f"pragma {name}")).scalar()


def _seed(store: SqliteMetadataStore) -> None:
    with store.unit_of_work() as uow:
        uow.workspaces.add(Workspace(name="w", root_dir="/tmp/w"))


@contextmanager
def _write_held_open(store: SqliteMetadataStore) -> Iterator[None]:
    """Hold an open write transaction on another thread for the body's duration.

    Enters only once the write has actually landed — so the SQLite write lock is
    genuinely held, not merely about to be — and joins the thread on the way out.
    A failure inside the thread is re-raised here rather than printed and lost.
    """
    writing = threading.Event()
    release = threading.Event()
    failure: list[BaseException] = []

    def hold() -> None:
        try:
            with store.unit_of_work() as uow:
                uow.workspaces.add(Workspace(name="held", root_dir="/tmp/held"))
                writing.set()
                release.wait(TIMEOUT_SECONDS)
        except BaseException as exc:  # noqa: BLE001 - re-raised on the main thread
            failure.append(exc)
        finally:
            writing.set()

    thread = threading.Thread(target=hold, name="held-write")
    thread.start()
    try:
        assert writing.wait(TIMEOUT_SECONDS), "the holding thread never took the write lock"
        if failure:
            raise failure[0]
        yield
    finally:
        release.set()
        thread.join(TIMEOUT_SECONDS)
        assert not thread.is_alive(), "the holding thread never finished"


def test_a_fresh_store_is_in_wal_mode(tmp_path: Path) -> None:
    store = _store(tmp_path)
    assert _pragma(store, "journal_mode") == "wal"
    store.close()


def test_wal_persists_in_the_file_rather_than_in_the_process(tmp_path: Path) -> None:
    """Journal mode lives in the header, which is what converts an old workspace."""
    store = _store(tmp_path)
    store.close()

    reopened = SqliteMetadataStore(tmp_path / "visionset.db")
    assert _pragma(reopened, "journal_mode") == "wal"
    reopened.close()


def test_reading_the_format_version_does_not_switch_a_stray_file_to_wal(tmp_path: Path) -> None:
    """WAL is set by `initialize()`, because turning it on writes the header.

    `WorkspaceService.open` creates nothing when it refuses, and it asks for
    `format_version` before it has decided the file is ours. A connect-time
    journal-mode pragma would leave a 4 KB page on every file it merely looked
    at — which is what this asserts did not happen.
    """
    stray = tmp_path / "visionset.db"
    stray.touch()

    store = SqliteMetadataStore(stray)
    assert store.format_version == UNINITIALIZED
    store.close()

    assert stray.stat().st_size == 0


def test_a_clean_close_leaves_no_sidecars_behind(tmp_path: Path) -> None:
    """`close()` disposes the engine, which checkpoints the WAL and removes it."""
    store = _store(tmp_path)
    _seed(store)
    store.close()

    assert sorted(p.name for p in tmp_path.iterdir()) == ["visionset.db"]


def test_every_connection_carries_the_busy_timeout(tmp_path: Path) -> None:
    store = _store(tmp_path)
    # Read twice, on two separate connections: the pragma is per connection, so a
    # listener that fired only for the first one would show up right here.
    assert _pragma(store, "busy_timeout") == DEFAULT_BUSY_TIMEOUT_MS
    assert _pragma(store, "busy_timeout") == DEFAULT_BUSY_TIMEOUT_MS
    store.close()


def test_the_busy_timeout_is_configurable(tmp_path: Path) -> None:
    store = _store(tmp_path, busy_timeout_ms=250)
    assert _pragma(store, "busy_timeout") == 250
    store.close()


def test_foreign_keys_survive_the_wal_posture(tmp_path: Path) -> None:
    """The pragma migration 007 depends on, guarded against a listener rewrite."""
    store = _store(tmp_path)
    assert _pragma(store, "foreign_keys") == 1
    with pytest.raises(ConstraintViolated, match="FOREIGN KEY"), store.unit_of_work() as uow:
        uow.projects.add(Project(workspace_id=uuid4(), name="orphan"))
    store.close()


def test_a_reader_proceeds_while_a_write_transaction_is_open(tmp_path: Path) -> None:
    """The whole point of WAL: a reader is not blocked by the writer.

    Under the rollback journal this store used before, the read below waits out
    the busy timeout and then fails.
    """
    writer = _store(tmp_path)
    _seed(writer)
    reader = SqliteMetadataStore(tmp_path / "visionset.db", busy_timeout_ms=250)

    with _write_held_open(writer), reader.unit_of_work() as uow:
        names = [row.name for row in uow.workspaces.list()]

    # The pre-write state, read without waiting: the held row is still
    # uncommitted, so this is isolation working rather than staleness.
    assert names == ["w"]
    reader.close()
    writer.close()


def test_a_write_that_outlives_the_busy_timeout_is_reported_busy(tmp_path: Path) -> None:
    """Contention becomes `WorkspaceBusy` — never a SQLAlchemy exception."""
    holder = _store(tmp_path)
    _seed(holder)
    contender = SqliteMetadataStore(tmp_path / "visionset.db", busy_timeout_ms=0)

    # `pytest.raises` is listed before the unit of work so that it is still open
    # when the transaction exits: with `busy_timeout_ms=0` the lock can be
    # reported either at the write or at the commit, and both have to be caught.
    with (
        _write_held_open(holder),
        pytest.raises(WorkspaceBusy) as caught,
        contender.unit_of_work() as uow,
    ):
        uow.workspaces.add(Workspace(name="third", root_dir="/tmp/third"))

    assert "sqlalchemy" not in type(caught.value).__module__
    assert "held by another writer" in str(caught.value)
    contender.close()
    holder.close()


def test_contention_and_damage_are_different_errors() -> None:
    """`WorkspaceBusy` is not a `WorkspaceCorrupt`, in either direction.

    They arrive at the same `except` clause in the adapter and are told apart
    only by the SQLite result code, so nothing but this keeps them from
    collapsing into one during a later edit.
    """
    assert not issubclass(WorkspaceBusy, WorkspaceCorrupt)
    assert not issubclass(WorkspaceCorrupt, WorkspaceBusy)


# --- two writers on one job ---------------------------------------------------
#
# The defect this closes is a lost update, and a lost update lives in the gap
# between a read and the write it justifies. In `JobService.mark` that gap is a
# few microseconds wide — far too narrow to hit by starting threads at the same
# moment and then asserting on what happened. So these tests do not race: they
# hold every writer at a gate that opens only once all of them have read, which
# reproduces the interleaving every single run instead of on a bad day.


class _GatedJobService(JobService):
    """A `JobService` that stops between reading a job and writing to it.

    `require_open_batch` is the last read `mark` performs before it decides, and
    `mark` calls it exactly once — which makes overriding it the one seam that
    puts a gate in the right place without touching the service under test.
    """

    def __init__(
        self,
        workspace: WorkspaceService,
        *,
        arrived: threading.Event,
        go: threading.Event,
    ) -> None:
        super().__init__(workspace)
        self._arrived = arrived
        self._go = go

    def require_open_batch(self, uow: UnitOfWork, job: AnnotationJob) -> Batch:
        batch = super().require_open_batch(uow, job)
        self._arrived.set()
        assert self._go.wait(TIMEOUT_SECONDS), "the gate was never opened"
        return batch


def _open_job(root: Path) -> tuple[UUID, list[UUID]]:
    """A workspace whose one job is open. Returns the job id and its assets."""
    workspace = WorkspaceService.init(root)
    try:
        project = ProjectService(workspace).create("p")
        SchemaService(workspace).create_version(
            project.id, [LabelClass(name="sign", geometry=GeometryType.BBOX)]
        )
        assets = []
        for seed in ("a", "b", "c"):
            content_hash = workspace.blob_store.put(BytesIO(seed.encode()))
            with workspace.unit_of_work() as uow:
                assets.append(
                    uow.assets.add(
                        Asset(
                            project_id=project.id,
                            content_hash=content_hash,
                            uri=f"/tmp/{seed}.png",
                        )
                    ).id
                )
        batches = BatchService(workspace)
        batch = batches.create(project.id, "first", assets)
        batches.approve(batch.id)
        batches.start(batch.id)
        job = batches.jobs(batch.id)[0]
        JobService(workspace).start(job.id)
        return job.id, assets
    finally:
        workspace.close()


def _raced(root: Path, moves: list[tuple[UUID, UUID, AssetProgress]]) -> list[object]:
    """Run every move from its own workspace, each having read before any writes.

    Each writer opens the workspace itself — two `WorkspaceService` objects over
    one file is two engines and no shared lock, which is what two *processes*
    look like to SQLite and what two HTTP requests look like once the app has a
    connection pool. Returns the outcome per move: the job it wrote, or the
    exception it was refused with.
    """
    gates = [(threading.Event(), threading.Event()) for _ in moves]
    outcomes: list[object] = [None] * len(moves)

    def run(index: int) -> None:
        arrived, go = gates[index]
        job_id, asset_id, progress = moves[index]
        workspace = WorkspaceService.open(root)
        try:
            service = _GatedJobService(workspace, arrived=arrived, go=go)
            outcomes[index] = service.mark(job_id, asset_id, progress)
        except BaseException as exc:  # noqa: BLE001 - reported on the main thread
            outcomes[index] = exc
        finally:
            # Set unconditionally: a writer refused *before* the gate would
            # otherwise leave the main thread waiting out the whole timeout.
            arrived.set()
            workspace.close()

    threads = [
        threading.Thread(target=run, args=(index,), name=f"writer-{index}")
        for index in range(len(moves))
    ]
    for thread in threads:
        thread.start()
    try:
        for arrived, _ in gates:
            assert arrived.wait(TIMEOUT_SECONDS), "a writer never reached the gate"
    finally:
        for _, go in gates:
            go.set()
    for thread in threads:
        thread.join(TIMEOUT_SECONDS)
        assert not thread.is_alive(), f"{thread.name} never finished"
    return outcomes


def _stored(root: Path, job_id: UUID) -> dict[UUID, AssetProgress]:
    workspace = WorkspaceService.open(root)
    try:
        return JobService(workspace).get(job_id).progress
    finally:
        workspace.close()


def test_two_writers_moving_different_assets_of_one_job_both_land(tmp_path: Path) -> None:
    """The lost update, in the smallest arrangement that produces it.

    Three concurrent moves over one job answered `200`, `200`, `200` and moved
    one asset. Two of them are enough to show it: both read the same progress
    map, and before this both wrote the whole map back.
    """
    root = tmp_path / "ws"
    job_id, assets = _open_job(root)

    outcomes = _raced(
        root,
        [
            (job_id, assets[0], AssetProgress.SKIPPED),
            (job_id, assets[1], AssetProgress.SKIPPED),
        ],
    )

    assert not [outcome for outcome in outcomes if isinstance(outcome, BaseException)]
    progress = _stored(root, job_id)
    assert progress[assets[0]] is AssetProgress.SKIPPED
    assert progress[assets[1]] is AssetProgress.SKIPPED
    assert progress[assets[2]] is AssetProgress.UNANNOTATED


def test_the_loser_of_a_race_for_one_asset_is_refused_rather_than_dropped(
    tmp_path: Path,
) -> None:
    """One asset, two writers, two different destinations — one of them refused.

    Both moves are legal from `unannotated`, so nothing here is a transition
    error: the second writer's move was legal *when it read* and is not any more.
    Whichever wins, exactly one write is stored and the other writer is told so
    rather than being answered success for a write that is not there.
    """
    root = tmp_path / "ws"
    job_id, assets = _open_job(root)

    outcomes = _raced(
        root,
        [
            (job_id, assets[0], AssetProgress.SKIPPED),
            (job_id, assets[0], AssetProgress.ANNOTATED),
        ],
    )

    refused = [outcome for outcome in outcomes if isinstance(outcome, StaleWrite)]
    assert len(refused) == 1, outcomes
    assert "read it again and decide again" in str(refused[0])

    lost_second = isinstance(outcomes[1], StaleWrite)
    winner = AssetProgress.SKIPPED if lost_second else AssetProgress.ANNOTATED
    assert _stored(root, job_id)[assets[0]] is winner


def test_two_writers_making_the_same_move_are_both_answered_yes(tmp_path: Path) -> None:
    """Losing a race to somebody who did what you asked for is not a refusal.

    `mark` treats re-stating a state an asset is already in as a no-op, and
    concurrency does not change what that means: the caller's intent holds, so
    a `StaleWrite` here would be an error about nothing.
    """
    root = tmp_path / "ws"
    job_id, assets = _open_job(root)

    outcomes = _raced(
        root,
        [
            (job_id, assets[0], AssetProgress.SKIPPED),
            (job_id, assets[0], AssetProgress.SKIPPED),
        ],
    )

    assert not [outcome for outcome in outcomes if isinstance(outcome, BaseException)]
    assert _stored(root, job_id)[assets[0]] is AssetProgress.SKIPPED
